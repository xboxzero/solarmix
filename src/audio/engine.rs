//! Realtime audio engine.
//!
//! Captures from the default input (USB mic on the Pi), runs the signal chain,
//! and writes to the default output (USB or HDMI). Two cpal streams; the input
//! callback pushes into a lock-free ring buffer that the output callback drains.
//! All DSP runs in the output callback so latency = one block.

use crate::audio::{
    delay::Delay, drums::DrumMachine, eq::Eq3, experiment::Experiment, looper::Looper,
    quantum::QuantumMod, recorder::Recorder, reverb::Reverb, simd, BUFFER_SIZE, SAMPLE_RATE,
};
use crate::state::SharedState;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::SystemTime;

/// Handle owned by `main()` that holds the cpal streams alive.
/// cpal::Stream is `!Send`, so this must NOT cross threads.
pub struct EngineStreams {
    _in_stream: cpal::Stream,
    _out_stream: cpal::Stream,
}

/// Shareable handle the web server uses. All `Send + Sync`.
#[derive(Clone)]
pub struct EngineHandle {
    pub state: Arc<SharedState>,
    pub recorder: Arc<Recorder>,
    pub recordings_dir: Arc<PathBuf>,
}

impl EngineHandle {
    pub fn start_recording(&self) {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
        let p = self.recordings_dir.join(format!("solarmix-{ts}.wav"));
        self.recorder.start(p);
        self.state.recording.store(true, Ordering::Relaxed);
    }

    pub fn stop_recording(&self) {
        self.state.recording.store(false, Ordering::Relaxed);
        self.recorder.stop();
    }
}

pub struct Engine;

impl Engine {
    pub fn start(state: Arc<SharedState>, recordings_dir: PathBuf)
        -> anyhow::Result<(EngineStreams, EngineHandle)>
    {
        let host = cpal::default_host();

        // Pick devices: env var override > device whose name contains "USB" >
        // device whose name contains "default" > first usable device. The Pi's
        // ALSA "default" PCM is "asym" with no capture slave, so we deliberately
        // avoid it for input.
        let want_in = std::env::var("SOLARMIX_INPUT_DEVICE").ok();
        let want_out = std::env::var("SOLARMIX_OUTPUT_DEVICE").ok();

        // Enumerate once: cpal-alsa returns empty on a second iteration in the same process.
        let all_devices: Vec<cpal::Device> = host.devices()?.collect();
        tracing::info!("device candidates: {}",
            all_devices.iter().filter_map(|d| d.name().ok()).collect::<Vec<_>>().join(" | "));

        let input = pick_input(&all_devices, want_in.as_deref())
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow::anyhow!("no usable input device"))?;
        let output = pick_output(&all_devices, want_out.as_deref())
            .or_else(|| host.default_output_device())
            .ok_or_else(|| anyhow::anyhow!("no usable output device"))?;
        tracing::info!("input  : {}", input.name().unwrap_or_default());
        tracing::info!("output : {}", output.name().unwrap_or_default());

        let in_cfg_supported = input.default_input_config()?;
        let out_cfg_supported = output.default_output_config()?;
        let in_channels = in_cfg_supported.channels() as usize;
        let out_channels = out_cfg_supported.channels() as usize;

        let in_cfg = StreamConfig {
            channels: in_cfg_supported.channels(),
            sample_rate: in_cfg_supported.sample_rate(),
            buffer_size: BufferSize::Fixed(BUFFER_SIZE),
        };
        let out_cfg = StreamConfig {
            channels: out_cfg_supported.channels(),
            sample_rate: cpal::SampleRate(SAMPLE_RATE),
            buffer_size: BufferSize::Fixed(BUFFER_SIZE),
        };
        let in_sr = in_cfg.sample_rate.0;
        let out_sr = out_cfg.sample_rate.0;
        tracing::info!("in cfg: {} ch @ {} Hz | out cfg: {} ch @ {} Hz",
            in_channels, in_sr, out_channels, out_sr);

        // mono ring buffer: input thread writes resampled mono frames
        let rb = HeapRb::<f32>::new((BUFFER_SIZE as usize) * 16);
        let (mut prod, mut cons) = rb.split();

        // resampling ratio if input sample rate != output sample rate
        let resample_ratio = out_sr as f32 / in_sr as f32;

        // ----- input stream -----
        let state_in = state.clone();
        let in_sample_format = in_cfg_supported.sample_format();
        let mut resamp_phase: f32 = 0.0;
        let mut last_samp: f32 = 0.0;
        let mut input_callback = move |data: &[f32]| {
            // collapse to mono
            let mut rms_sq = 0.0;
            let frames = data.len() / in_channels.max(1);
            for f in 0..frames {
                let base = f * in_channels;
                let mut s = 0.0;
                for c in 0..in_channels { s += data[base + c]; }
                s /= in_channels as f32;
                s *= state_in.input_gain.get();
                rms_sq += s * s;

                // simple linear resampler: emit while phase < ratio
                resamp_phase += resample_ratio;
                while resamp_phase >= 1.0 {
                    let out = last_samp + (s - last_samp) * (1.0 - (resamp_phase - 1.0)).clamp(0.0, 1.0);
                    let _ = prod.try_push(out);
                    resamp_phase -= 1.0;
                }
                last_samp = s;
            }
            let rms = (rms_sq / frames.max(1) as f32).sqrt();
            // smooth meter
            let cur = state_in.input_level.get();
            state_in.input_level.set(cur * 0.85 + rms * 0.15);
        };

        let in_stream = match in_sample_format {
            SampleFormat::F32 => input.build_input_stream(
                &in_cfg,
                move |data: &[f32], _| input_callback(data),
                |e| tracing::error!("input err: {e}"),
                None,
            )?,
            SampleFormat::I16 => {
                let mut cb = input_callback;
                input.build_input_stream(
                    &in_cfg,
                    move |data: &[i16], _| {
                        let f: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        cb(&f);
                    },
                    |e| tracing::error!("input err: {e}"),
                    None,
                )?
            }
            SampleFormat::U16 => {
                let mut cb = input_callback;
                input.build_input_stream(
                    &in_cfg,
                    move |data: &[u16], _| {
                        let f: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                        cb(&f);
                    },
                    |e| tracing::error!("input err: {e}"),
                    None,
                )?
            }
            _ => anyhow::bail!("unsupported input sample format"),
        };

        // ----- output stream -----
        let recorder = Arc::new(Recorder::spawn(out_sr));
        let recorder_cb = recorder.clone();
        let state_out = state.clone();

        let mut reverb = Reverb::new();
        let mut delay = Delay::new(out_sr, 2.0);
        let mut eq = Eq3::new(out_sr);
        let mut drums = DrumMachine::new(out_sr);
        let mut experiment = Experiment::new(out_sr);
        let mut looper = Looper::new(out_sr, 30.0);
        let mut qmod = QuantumMod::new();

        // smoothed params (1-pole) so UI sliders don't zipper-noise the audio
        let mut sm_master = state.master_gain.get();
        let mut sm_rev_mix = state.reverb_mix.get();
        let mut sm_rev_size = state.reverb_size.get();
        let mut sm_rev_damp = state.reverb_damp.get();
        let mut sm_del_time = state.delay_time_ms.get();
        let mut sm_del_fb = state.delay_feedback.get();
        let mut sm_del_mix = state.delay_mix.get();
        let mut sm_eq_lo = state.eq_low_db.get();
        let mut sm_eq_mi = state.eq_mid_db.get();
        let mut sm_eq_hi = state.eq_high_db.get();
        let mut sm_drum_g = state.drum_gain.get();
        let mut sm_loop_g = state.looper_gain.get();
        let mut sm_exp_f = state.exp_freq.get();
        let mut sm_exp_a = state.exp_amp.get();
        let mut sm_auto_gain = 1.0_f32;
        let mut auto_phase = 0.0_f32; // automation LFO phase

        let mut quantum_tick = 0u32;
        let mut prev_eq_lo = f32::NAN;
        let mut prev_eq_mi = f32::NAN;
        let mut prev_eq_hi = f32::NAN;
        let mut prev_rev = (f32::NAN, f32::NAN);
        let mut prev_del = f32::NAN;
        let mut prev_bpm = f32::NAN;

        let mut output_callback = move |data: &mut [f32]| {
            let frames = data.len() / out_channels.max(1);

            // step quantum once per block; smooth follows its coef
            quantum_tick = quantum_tick.wrapping_add(1);
            qmod.step(state_out.quantum_amount.get());
            let qout = qmod.out();
            let smooth_a = qmod.smoothing_coef(state_out.quantum_smooth.get());

            // automation LFO
            let auto_on = state_out.automation_enabled.load(Ordering::Relaxed);
            let auto_rate = state_out.automation_rate.get();
            let auto_inc = std::f32::consts::TAU * auto_rate * frames as f32 / out_sr as f32;
            auto_phase += auto_inc;
            if auto_phase > std::f32::consts::TAU { auto_phase -= std::f32::consts::TAU; }
            let auto_lfo = if auto_on { auto_phase.sin() * 0.5 + 0.5 } else { 0.5 };

            // target params (with optional automation + quantum chaos)
            let chaos = state_out.quantum_amount.get();
            let mix_q = |base: f32, q: f32, amt: f32| -> f32 { base + q * amt * chaos };
            let auto_blend = |base: f32, lfo: f32, amt: f32| -> f32 {
                if auto_on { base * (1.0 - amt) + lfo * amt } else { base }
            };

            let t_master = state_out.master_gain.get();
            let t_rev_mix = mix_q(state_out.reverb_mix.get(), qout[1], 0.1)
                .clamp(0.0, 1.0);
            let t_rev_size = mix_q(state_out.reverb_size.get(), qout[2], 0.1).clamp(0.0, 1.0);
            let t_rev_damp = state_out.reverb_damp.get();
            let t_del_time = auto_blend(state_out.delay_time_ms.get(), 50.0 + auto_lfo * 700.0, 0.3);
            let t_del_fb = mix_q(state_out.delay_feedback.get(), qout[3], 0.08).clamp(0.0, 0.9);
            let t_del_mix = state_out.delay_mix.get();
            let t_eq_lo = state_out.eq_low_db.get();
            let t_eq_mi = state_out.eq_mid_db.get();
            let t_eq_hi = state_out.eq_high_db.get();
            let t_drum_g = state_out.drum_gain.get();
            let t_loop_g = state_out.looper_gain.get();
            let t_exp_f = mix_q(state_out.exp_freq.get(), qout[0], 30.0).max(20.0);
            let t_exp_a = state_out.exp_amp.get();

            // smooth toward targets
            sm_master += (t_master - sm_master) * smooth_a;
            sm_rev_mix += (t_rev_mix - sm_rev_mix) * smooth_a;
            sm_rev_size += (t_rev_size - sm_rev_size) * smooth_a;
            sm_rev_damp += (t_rev_damp - sm_rev_damp) * smooth_a;
            sm_del_time += (t_del_time - sm_del_time) * smooth_a;
            sm_del_fb += (t_del_fb - sm_del_fb) * smooth_a;
            sm_del_mix += (t_del_mix - sm_del_mix) * smooth_a;
            sm_eq_lo += (t_eq_lo - sm_eq_lo) * smooth_a;
            sm_eq_mi += (t_eq_mi - sm_eq_mi) * smooth_a;
            sm_eq_hi += (t_eq_hi - sm_eq_hi) * smooth_a;
            sm_drum_g += (t_drum_g - sm_drum_g) * smooth_a;
            sm_loop_g += (t_loop_g - sm_loop_g) * smooth_a;
            sm_exp_f += (t_exp_f - sm_exp_f) * 0.05;
            sm_exp_a += (t_exp_a - sm_exp_a) * smooth_a;

            // apply (only when changed meaningfully)
            if (sm_eq_lo - prev_eq_lo).abs() > 0.01
                || (sm_eq_mi - prev_eq_mi).abs() > 0.01
                || (sm_eq_hi - prev_eq_hi).abs() > 0.01 {
                eq.set_gains(sm_eq_lo, sm_eq_mi, sm_eq_hi);
                prev_eq_lo = sm_eq_lo; prev_eq_mi = sm_eq_mi; prev_eq_hi = sm_eq_hi;
            }
            if (sm_rev_size - prev_rev.0).abs() > 0.005 || (sm_rev_damp - prev_rev.1).abs() > 0.005 {
                reverb.set_params(sm_rev_size, sm_rev_damp);
                prev_rev = (sm_rev_size, sm_rev_damp);
            }
            if (sm_del_time - prev_del).abs() > 0.5 {
                delay.set_time_ms(sm_del_time);
                prev_del = sm_del_time;
            }
            let bpm = state_out.drum_bpm.get();
            if (bpm - prev_bpm).abs() > 0.1 { drums.set_bpm(bpm); prev_bpm = bpm; }

            // auto-mix: target an RMS
            let auto_on_mix = state_out.auto_mix.load(Ordering::Relaxed);
            let target_rms = state_out.auto_mix_target.get();
            let in_rms = state_out.input_level.get().max(1e-5);
            if auto_on_mix {
                let desired = (target_rms / in_rms).clamp(0.1, 8.0);
                sm_auto_gain += (desired - sm_auto_gain) * 0.001;
            } else {
                sm_auto_gain += (1.0 - sm_auto_gain) * 0.002;
            }

            let drum_pattern = [
                state_out.drum_pattern[0].load(Ordering::Relaxed),
                state_out.drum_pattern[1].load(Ordering::Relaxed),
                state_out.drum_pattern[2].load(Ordering::Relaxed),
                state_out.drum_pattern[3].load(Ordering::Relaxed),
            ];
            let drum_on = state_out.drum_enabled.load(Ordering::Relaxed);
            let looper_st = state_out.looper_state();
            let recording = state_out.recording.load(Ordering::Relaxed);

            // process samples
            let mut out_sum_sq = 0.0_f32;
            for f in 0..frames {
                let mic = cons.try_pop().unwrap_or(0.0) * sm_auto_gain;
                let exp = experiment.process(sm_exp_f, sm_exp_a, state_out.exp_waveform.load(Ordering::Relaxed));
                let drum = if drum_on { drums.process(&drum_pattern) * sm_drum_g } else { 0.0 };

                let pre = mic + exp + drum;
                let eqd = eq.process(pre);
                let (dl_l, dl_r) = delay.process(eqd, sm_del_fb, sm_del_mix);
                let (rv_l, rv_r) = reverb.process((dl_l + dl_r) * 0.5, sm_rev_mix);

                // mix delay (stereo) and reverb (stereo)
                let mut yl = dl_l * (1.0 - sm_rev_mix) + rv_l;
                let mut yr = dl_r * (1.0 - sm_rev_mix) + rv_r;

                // looper
                let (lp_l, lp_r) = looper.process(looper_st, yl, yr);
                yl += lp_l * sm_loop_g;
                yr += lp_r * sm_loop_g;

                yl *= sm_master;
                yr *= sm_master;
                yl = soft_clip(yl);
                yr = soft_clip(yr);

                if recording { recorder_cb.push(yl, yr); }
                out_sum_sq += yl * yl + yr * yr;

                let base = f * out_channels;
                if out_channels >= 2 {
                    data[base] = yl;
                    data[base + 1] = yr;
                    for c in 2..out_channels { data[base + c] = 0.0; }
                } else {
                    data[base] = (yl + yr) * 0.5;
                }
            }

            let rms = (out_sum_sq / (frames.max(1) as f32 * 2.0)).sqrt();
            let cur = state_out.output_level.get();
            state_out.output_level.set(cur * 0.85 + rms * 0.15);
            state_out.loop_position.set(looper.position_norm());
        };

        let out_stream = match out_cfg_supported.sample_format() {
            SampleFormat::F32 => output.build_output_stream(
                &out_cfg,
                move |data: &mut [f32], _| output_callback(data),
                |e| tracing::error!("output err: {e}"),
                None,
            )?,
            SampleFormat::I16 => {
                let mut cb = output_callback;
                output.build_output_stream(
                    &out_cfg,
                    move |data: &mut [i16], _| {
                        let mut f = vec![0.0_f32; data.len()];
                        cb(&mut f);
                        for (d, s) in data.iter_mut().zip(f.iter()) {
                            *d = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    |e| tracing::error!("output err: {e}"),
                    None,
                )?
            }
            _ => anyhow::bail!("unsupported output sample format"),
        };

        in_stream.play()?;
        out_stream.play()?;

        let streams = EngineStreams { _in_stream: in_stream, _out_stream: out_stream };
        let handle = EngineHandle {
            state,
            recorder,
            recordings_dir: Arc::new(recordings_dir),
        };
        Ok((streams, handle))
    }
}

/// Priority list of substrings — first match in iteration order wins.
/// `plughw` auto-converts formats/rates which is what we want on the Pi.
const INPUT_PRIORITY:  &[&str] = &["plughw:CARD=Device", "hw:CARD=Device", "default:CARD=Device", "plughw", "hw:CARD"];
const OUTPUT_PRIORITY: &[&str] = &["plughw:CARD=Device", "hw:CARD=Device", "default:CARD=Device", "plughw", "hw:CARD"];

fn pick_input(devs: &[cpal::Device], want: Option<&str>) -> Option<cpal::Device> {
    let ok = |d: &cpal::Device| d.default_input_config().is_ok();
    if let Some(w) = want {
        for d in devs {
            if d.name().map(|n| n.contains(w)).unwrap_or(false) && ok(d) { return Some(d.clone()); }
        }
    }
    for pat in INPUT_PRIORITY {
        for d in devs {
            if d.name().map(|n| n.contains(pat)).unwrap_or(false) && ok(d) { return Some(d.clone()); }
        }
    }
    devs.iter().find(|d| ok(d)).cloned()
}

fn pick_output(devs: &[cpal::Device], want: Option<&str>) -> Option<cpal::Device> {
    let ok = |d: &cpal::Device| d.default_output_config().is_ok();
    if let Some(w) = want {
        for d in devs {
            if d.name().map(|n| n.contains(w)).unwrap_or(false) && ok(d) { return Some(d.clone()); }
        }
    }
    for pat in OUTPUT_PRIORITY {
        for d in devs {
            if d.name().map(|n| n.contains(pat)).unwrap_or(false) && ok(d) { return Some(d.clone()); }
        }
    }
    devs.iter().find(|d| ok(d)).cloned()
}

#[inline]
fn soft_clip(x: f32) -> f32 {
    // gentle tanh-ish — keeps headroom under 1.0
    let x = x.clamp(-3.0, 3.0);
    x - x.powi(3) / 3.0_f32.max(1.0)
}

// Allow `simd` to be referenced so unused warnings don't fail nightly; it is
// also used by tests if added.
#[allow(dead_code)]
fn _force_link_simd() { let mut b = [0.0_f32; 4]; simd::gain_in_place(&mut b, 1.0); }
