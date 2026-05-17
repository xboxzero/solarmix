//! Audio engine — thin wrapper around libpd-rs 0.2.
//!
//! - cpal opens the default output device (USB or HDMI on the Pi) at 48 kHz.
//! - libpd loads `puredata/tezeta.pd` and owns ALL DSP.
//! - In the cpal output callback we (1) push parameter atoms toward Pd via
//!   `send_float_to` (only when they change), (2) drive the 16-coefficient
//!   patchbay route from the multiplied qubit state, (3) call
//!   `ctx.process_float(ticks, &[], out)` to fill the buffer.
//! - All audio output is on the Pi; the web client only sends control messages.

use crate::audio::recorder::Recorder;
use crate::qubit::QubitRouter;
use crate::state::SharedState;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use libpd_rs::functions::send::send_float_to;
use libpd_rs::functions::util::calculate_ticks;
use libpd_rs::Pd;
use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer, Split};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::SystemTime;

/// Holds the cpal streams + the live Pd instance. cpal::Stream is !Send so this
/// stays on the main thread for its entire lifetime — same as the original.
pub struct EngineStreams {
    _out_stream: cpal::Stream,
    _in_stream: Option<cpal::Stream>,
    _pd: Pd,
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
    pub fn start(state: Arc<SharedState>, recordings_dir: PathBuf, patch_path: PathBuf)
        -> anyhow::Result<(EngineStreams, EngineHandle)>
    {
        // ---------- cpal output device ----------
        let host = cpal::default_host();
        let want_out = std::env::var("TEZETA_OUTPUT_DEVICE").ok();
        let all_devices: Vec<cpal::Device> = host.devices()?.collect();
        let output = pick_output(&all_devices, want_out.as_deref())
            .or_else(|| host.default_output_device())
            .ok_or_else(|| anyhow::anyhow!("no usable output device"))?;
        let out_cfg_supported = output.default_output_config()?;
        let out_channels = out_cfg_supported.channels() as i32;
        let out_cfg: StreamConfig = out_cfg_supported.clone().into();
        let out_sr = out_cfg.sample_rate.0 as i32;
        tracing::info!("output device: {}", output.name().unwrap_or_default());
        tracing::info!("output cfg: {} ch @ {} Hz", out_channels, out_sr);

        // ---------- libpd ----------
        let in_channels = 1_i32;
        let mut pd = Pd::init_and_configure(in_channels, out_channels, out_sr)
            .map_err(|e| anyhow::anyhow!("libpd init: {e}"))?;
        // Add the patch directory to Pd's search path so [abs~] / [r~] / externals resolve.
        if let Some(dir) = patch_path.parent() {
            let _ = pd.add_path_to_search_paths(dir);
        }
        pd.open_patch(&patch_path)
            .map_err(|e| anyhow::anyhow!("open_patch {}: {e}", patch_path.display()))?;
        pd.activate_audio(true)
            .map_err(|e| anyhow::anyhow!("activate_audio: {e}"))?;
        let ctx = pd.audio_context();
        tracing::info!("libpd loaded patch {}", patch_path.display());

        // ---------- recorder ----------
        let recorder = Arc::new(Recorder::spawn(out_sr as u32));
        let recorder_cb = recorder.clone();

        // ---------- microphone ring buffer ----------
        let (mic_prod, mic_cons) = HeapRb::<f32>::new(8192).split();
        let mic_prod = Arc::new(parking_lot::Mutex::new(mic_prod));
        let mic_cons = Arc::new(parking_lot::Mutex::new(mic_cons));

        // ---------- audio callback state ----------
        let state_out = state.clone();
        let mut router = QubitRouter::new();
        let mut last_sent = LastSent::default();
        let mut block_seconds = 256.0 / out_sr as f32;
        let out_ch_us = out_channels as usize;
        let mic_cons_cb = mic_cons.clone();

        let mut output_callback = move |data: &mut [f32]| {
            // Bind this Pd instance to the audio thread before any free libpd
            // calls (send_float_to etc). Without this libpd's sys_lock derefs
            // a NULL INTER pointer and segfaults the cpal callback thread.
            ctx.set_as_current();
            let frames = data.len() / out_ch_us.max(1);

            // ---- step qubit router once per audio block ----
            router.step(state_out.chaos.get(), block_seconds);

            // ---- routing matrix: mix base * qubit by chaos ----
            let chaos = state_out.chaos.get();
            let mut qsnap = [0.0_f32; 16];
            for v in 0..4 {
                for b in 0..4 {
                    let idx = v * 4 + b;
                    let base = state_out.route[idx].get();
                    let qc = router.coeff(v, b);
                    let val = (1.0 - chaos) * base + chaos * qc;
                    qsnap[idx] = qc;
                    let _ = send_float_to(SEND_NAMES[idx], val);
                }
            }
            // ---- voices ----
            for v in 0..4 {
                let gate = state_out.voice_gate[v].get();
                let pitch = state_out.voice_pitch[v].get();
                if (gate - last_sent.gate[v]).abs() > 1e-3 {
                    let _ = send_float_to(VOICE_GATE_NAMES[v], gate);
                    last_sent.gate[v] = gate;
                }
                if (pitch - last_sent.pitch[v]).abs() > 0.05 {
                    let _ = send_float_to(VOICE_PITCH_NAMES[v], pitch);
                    last_sent.pitch[v] = pitch;
                }
            }
            // ---- master + FX scalars ----
            send_changed(&mut last_sent.master_vol, state_out.master_vol.get(), "master_vol");
            send_changed(&mut last_sent.reverb_mix, state_out.reverb_mix.get(), "rev_mix");
            send_changed(&mut last_sent.reverb_size, state_out.reverb_size.get(), "rev_size");
            send_changed(&mut last_sent.delay_time, state_out.delay_time_ms.get(), "del_time");
            send_changed(&mut last_sent.delay_fb, state_out.delay_fb.get(), "del_fb");
            send_changed(&mut last_sent.root_hz, state_out.root_hz.get(), "root");
            send_changed(&mut last_sent.bpm, state_out.drum_bpm.get(), "bpm");
            send_changed(&mut last_sent.mode, state_out.mode.load(Ordering::Relaxed) as f32, "mode");
            send_changed(&mut last_sent.drum_on,
                if state_out.drum_enabled.load(Ordering::Relaxed) { 1.0 } else { 0.0 }, "drum_on");

            // ---- publish qubit snapshot for the UI ----
            for (i, v) in qsnap.iter().enumerate() {
                state_out.qcoef[i].set(*v);
            }

            // ---- microphone input + modulation ----
            let mut in_buf = vec![0.0_f32; frames];
            if let Some(mut cons) = mic_cons_cb.try_lock() {
                for f in 0..frames {
                    if let Some(s) = cons.try_pop() {
                        in_buf[f] = s;
                    }
                }
            }
            // Apply mic modulation: blend mic RMS into a target parameter
            let mic_rms = state_out.input_level.get();
            let mod_target = state_out.mic_mod.get() as u8;
            match mod_target {
                1 => {
                    // chaos modulation: add mic_rms to chaos (clamped to [0,1])
                    let c = (state_out.chaos.get() + mic_rms * 0.5).min(1.0);
                    send_changed(&mut last_sent.chaos_mod, c, "chaos");
                }
                2 => {
                    // reverb modulation: boost reverb with mic level
                    let r = (state_out.reverb_mix.get() + mic_rms * 2.0).min(1.0);
                    send_changed(&mut last_sent.reverb_mix, r, "rev_mix");
                }
                3 => {
                    // delay feedback modulation: modulate feedback with mic
                    let d = (state_out.delay_fb.get() + mic_rms * 0.5).min(0.92);
                    send_changed(&mut last_sent.delay_fb, d, "del_fb");
                }
                _ => {}
            }

            // ---- run Pd ----
            let ticks = calculate_ticks(out_channels, data.len() as i32);
            ctx.process_float(ticks, &in_buf, data);

            // ---- monitor + record ----
            let mut out_sum_sq = 0.0_f32;
            for f in 0..frames {
                let l = data[f * out_ch_us];
                let r = if out_ch_us >= 2 { data[f * out_ch_us + 1] } else { l };
                out_sum_sq += l * l + r * r;
                if state_out.recording.load(Ordering::Relaxed) {
                    recorder_cb.push(l, r);
                }
            }
            let rms = (out_sum_sq / (frames.max(1) as f32 * 2.0)).sqrt();
            let cur = state_out.output_level.get();
            state_out.output_level.set(cur * 0.85 + rms * 0.15);

            block_seconds = frames as f32 / out_sr as f32;
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

        // ---------- cpal input stream ----------
        let want_in = std::env::var("TEZETA_INPUT_DEVICE").ok();
        let input = pick_input(&all_devices, want_in.as_deref()).or_else(|| host.default_input_device());

        let in_stream = if let Some(input_dev) = input {
            let in_cfg_supported = input_dev.default_input_config().ok();
            if let Some(in_cfg_sup) = in_cfg_supported {
                let in_cfg: StreamConfig = in_cfg_sup.clone().into();
                let _in_ch = in_cfg.channels as usize;
                if let Ok(name) = input_dev.name() {
                    tracing::info!("input device: {}", name);
                }

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

        let streams = EngineStreams { _out_stream: out_stream, _in_stream: in_stream, _pd: pd };
        let handle = EngineHandle {
            state,
            recorder,
            recordings_dir: Arc::new(recordings_dir),
        };
        Ok((streams, handle))
    }
}

fn send_changed(cur: &mut f32, new: f32, name: &'static str) {
    if (new - *cur).abs() > 1e-4 {
        let _ = send_float_to(name, new);
        *cur = new;
    }
}

// Receiver name tables (matches puredata/tezeta.pd).
const SEND_NAMES: [&str; 16] = [
    "send_0_0", "send_0_1", "send_0_2", "send_0_3",
    "send_1_0", "send_1_1", "send_1_2", "send_1_3",
    "send_2_0", "send_2_1", "send_2_2", "send_2_3",
    "send_3_0", "send_3_1", "send_3_2", "send_3_3",
];
const VOICE_GATE_NAMES:  [&str; 4] = ["gate_0", "gate_1", "gate_2", "gate_3"];
const VOICE_PITCH_NAMES: [&str; 4] = ["pitch_0", "pitch_1", "pitch_2", "pitch_3"];

#[derive(Default)]
struct LastSent {
    gate: [f32; 4],
    pitch: [f32; 4],
    master_vol: f32,
    reverb_mix: f32,
    reverb_size: f32,
    delay_time: f32,
    delay_fb: f32,
    root_hz: f32,
    bpm: f32,
    mode: f32,
    drum_on: f32,
    chaos_mod: f32,
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
