//! Audio engine — pure Rust DSP synthesis.
//!
//! - cpal opens the default output device (USB or HDMI on the Pi) at 48 kHz.
//! - TazetaSynth (in dsp.rs) owns ALL DSP synthesis.
//! - In the cpal output callback we (1) update voice gates/pitches from state,
//!   (2) drive the qubit router, (3) call synth.process() to fill the buffer.
//! - All audio output is on the Pi; the web client sends control messages.

use crate::audio::dsp::TazetaSynth;
use crate::audio::recorder::Recorder;
use crate::qubit::QubitRouter;
use crate::state::SharedState;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer, Split};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::SystemTime;

pub struct EngineStreams {
    _out_stream: cpal::Stream,
    _in_stream: Option<cpal::Stream>,
}

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
        let p = self.recordings_dir.join(format!("tezeta-{ts}.wav"));
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
    pub fn start(state: Arc<SharedState>, recordings_dir: PathBuf, _patch_path: PathBuf)
        -> anyhow::Result<(EngineStreams, EngineHandle)>
    {
        let host = cpal::default_host();
        let want_out = std::env::var("TEZETA_OUTPUT_DEVICE").ok();
        let all_devices: Vec<cpal::Device> = host.devices()?.collect();
        let output = pick_output(&all_devices, want_out.as_deref())
            .or_else(|| host.default_output_device())
            .ok_or_else(|| anyhow::anyhow!("no usable output device"))?;
        let out_cfg_supported = output.default_output_config()?;
        let out_channels = out_cfg_supported.channels() as usize;
        let out_cfg: StreamConfig = out_cfg_supported.clone().into();
        let out_sr = out_cfg.sample_rate.0 as f32;
        tracing::info!("output device: {}", output.name().unwrap_or_default());
        tracing::info!("output cfg: {} ch @ {} Hz", out_channels, out_sr as u32);

        let recorder = Arc::new(Recorder::spawn(out_sr as u32));
        let recorder_cb = recorder.clone();

        // Microphone ring buffer
        let (mic_prod, mic_cons) = HeapRb::<f32>::new(8192).split();
        let mic_prod = Arc::new(parking_lot::Mutex::new(mic_prod));
        let mic_cons = Arc::new(parking_lot::Mutex::new(mic_cons));

        // Audio callback state
        let state_out = state.clone();
        let mut synth = TazetaSynth::new(out_sr);
        let mut router = QubitRouter::new();
        let mut last_gate = [false; 4];
        let mut last_sent_gates = [0.0_f32; 4];
        let mut block_seconds = 256.0 / out_sr;
        let out_ch_us = out_channels.max(1);
        let mic_cons_cb = mic_cons.clone();

        let mut output_callback = move |data: &mut [f32]| {
            let frames = data.len() / out_ch_us;

            // Step qubit router
            router.step(state_out.chaos.get(), block_seconds);

            // Update gate/pitch signals (from web UI or Lissajous control)
            for v in 0..4 {
                let gate = state_out.voice_gate[v].get() > 0.5;
                let pitch = state_out.voice_pitch[v].get();

                if gate != last_gate[v] {
                    if gate {
                        tracing::debug!("Voice {} triggered at {} Hz", v, pitch);
                        synth.trigger_voice(v);
                    } else {
                        tracing::debug!("Voice {} released", v);
                        synth.release_voice(v);
                    }
                    last_gate[v] = gate;
                }
                // (pitch is read per-sample during synth.process)
            }

            // Update FX parameters
            synth.set_reverb(
                state_out.reverb_mix.get(),
                state_out.reverb_size.get()
            );
            synth.set_delay(
                state_out.delay_time_ms.get(),
                state_out.delay_fb.get()
            );

            // Microphone input
            let mut in_buf = vec![0.0_f32; frames];
            if let Some(mut cons) = mic_cons_cb.try_lock() {
                for f in 0..frames {
                    if let Some(s) = cons.try_pop() {
                        in_buf[f] = s;
                    }
                }
            }

            // Microphone modulation
            let mic_rms = state_out.input_level.get();
            let mod_target = state_out.mic_mod.get() as u8;
            match mod_target {
                1 => {
                    let c = (state_out.chaos.get() + mic_rms * 0.5).min(1.0);
                    // Apply chaos modulation to routing matrix (similar to Pd version)
                }
                2 => {
                    let r = (state_out.reverb_mix.get() + mic_rms * 2.0).min(1.0);
                    synth.set_reverb(r, state_out.reverb_size.get());
                }
                3 => {
                    let d = (state_out.delay_fb.get() + mic_rms * 0.5).min(0.92);
                    synth.set_delay(state_out.delay_time_ms.get(), d);
                }
                _ => {}
            }

            // Get current pitch for each voice
            let pitches = [
                state_out.voice_pitch[0].get(),
                state_out.voice_pitch[1].get(),
                state_out.voice_pitch[2].get(),
                state_out.voice_pitch[3].get(),
            ];

            // Process synthesizer and fill output buffer
            let master_vol = state_out.master_vol.get();
            for frame in 0..frames {
                let sample = synth.process(&pitches);
                let out_sample = sample * master_vol;

                // Stereo output
                data[frame * out_ch_us] = out_sample;
                if out_ch_us >= 2 {
                    data[frame * out_ch_us + 1] = out_sample;
                }

                // Recording
                if state_out.recording.load(Ordering::Relaxed) {
                    recorder_cb.push(out_sample, out_sample);
                }
            }

            // Monitor output level
            let mut out_sum_sq = 0.0_f32;
            for frame in 0..frames {
                let s = data[frame * out_ch_us];
                out_sum_sq += s * s;
            }
            let rms = (out_sum_sq / frames as f32).sqrt();
            let cur = state_out.output_level.get();
            let new_level = cur * 0.85 + rms * 0.15;
            state_out.output_level.set(new_level);

            if new_level > 0.01 {
                tracing::debug!("Output level: {:.4}", new_level);
            }

            block_seconds = frames as f32 / out_sr;
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
        out_stream.play()?;

        // Input stream for microphone
        let want_in = std::env::var("TEZETA_INPUT_DEVICE").ok();
        let input = pick_input(&all_devices, want_in.as_deref()).or_else(|| host.default_input_device());

        let in_stream = if let Some(input_dev) = input {
            let in_cfg_supported = input_dev.default_input_config().ok();
            if let Some(in_cfg_sup) = in_cfg_supported {
                let in_cfg: StreamConfig = in_cfg_sup.clone().into();
                let state_in = state.clone();
                let mic_prod_cb = mic_prod.clone();

                let input_callback = move |data: &[f32]| {
                    let gain = state_in.mic_gain.get();
                    let enabled = state_in.mic_enabled.load(Ordering::Relaxed);
                    let mut rms = 0.0_f32;

                    for &s in data.iter() {
                        let g = if enabled { s * gain } else { 0.0 };
                        if let Some(mut prod) = mic_prod_cb.try_lock() {
                            let _ = prod.try_push(g);
                        }
                        rms += g * g;
                    }

                    let level = (rms / data.len().max(1) as f32).sqrt();
                    let cur = state_in.input_level.get();
                    state_in.input_level.set(cur * 0.85 + level * 0.15);
                };

                match in_cfg_sup.sample_format() {
                    SampleFormat::F32 => {
                        let in_stream = input_dev.build_input_stream(
                            &in_cfg,
                            move |data: &[f32], _| input_callback(data),
                            |e| tracing::error!("input err: {e}"),
                            None,
                        )?;
                        in_stream.play()?;
                        Some(in_stream)
                    }
                    SampleFormat::I16 => {
                        let cb = input_callback;
                        let in_stream = input_dev.build_input_stream(
                            &in_cfg,
                            move |data: &[i16], _| {
                                let f: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                                cb(&f);
                            },
                            |e| tracing::error!("input err: {e}"),
                            None,
                        )?;
                        in_stream.play()?;
                        Some(in_stream)
                    }
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };

        let streams = EngineStreams { _out_stream: out_stream, _in_stream: in_stream };
        let handle = EngineHandle {
            state,
            recorder,
            recordings_dir: Arc::new(recordings_dir),
        };
        Ok((streams, handle))
    }
}

const OUTPUT_PRIORITY: &[&str] = &[
    "plughw:CARD=Device", "hw:CARD=Device", "default:CARD=Device", "plughw", "hw:CARD",
];

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

fn pick_input(devs: &[cpal::Device], want: Option<&str>) -> Option<cpal::Device> {
    let ok = |d: &cpal::Device| d.default_input_config().is_ok();
    if let Some(w) = want {
        for d in devs {
            if d.name().map(|n| n.contains(w)).unwrap_or(false) && ok(d) { return Some(d.clone()); }
        }
    }
    devs.iter().find(|d| ok(d)).cloned()
}
