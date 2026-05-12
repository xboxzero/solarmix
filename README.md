# SolarMix

> A real-time web-controlled audio mixer / synth that lives on a Raspberry Pi 5 and is operated through a Warcraft-style RPG interface in your Safari browser.

```
mic ─► [auto-mix] ─► [exp tone +] ─► [drum +] ─► EQ ─► Delay ─► Reverb ─► Looper ─► Master ─► speakers
                                                                           │
                                                       quantum 4-qubit ────┘  modulates: rev mix/size, delay fb, exp freq, smoothing
```

## What it does

- **Real-time mic capture** on the Pi (USB audio device by default) with cpal
- **Auto-mixer** that targets a steady RMS so quiet voices come up and loud bursts back off
- **Built-in effects**: Schroeder/Freeverb reverb, ping-pong tape delay, 3-band biquad EQ
- **Drum machine**: 4 synthesised voices (kick / snare / hat / clap), 16-step grid, 60-180 BPM
- **Experimental tone generator**: sine / triangle / saw / square / white noise, 20 Hz – 4 kHz
- **Quantum-inspired modulator**: a tiny classical simulator of a 4-qubit entangling circuit (Hadamards → CNOTs → phase rotation → measurement). Its four correlated output signals modulate parameters — at low `Chaos` they slowly smooth the controls, at high `Chaos` they entangle reverb, delay and frequency together so the mix breathes/swirls without being noisy random.
- **Looper** (30 s max): record → play → overdub → stop / clear
- **Recorder**: capture the master out to a 16-bit stereo WAV in `recordings/`
- **Automation LFO** applied across selected parameters (delay time mostly)
- **WebSocket UI** with smooth meters and per-step drum indicator

## Why "Pure Data and assembly with Rust"

- The **Rust** binary is the primary realtime engine — Axum web server, cpal capture/playback, and the entire DSP chain.
- The **hot DSP loops** (gain, mix-add, RMS) are written using `std::arch::aarch64` NEON intrinsics that the compiler emits as ARMv8 NEON assembly (FMLA, FMUL on 128-bit float vectors, 4 floats per instruction). See `src/audio/simd.rs`. On non-aarch64 targets there are scalar fallbacks so it still builds on dev machines.
- A **Pure Data** companion patch (`puredata/solarmix.pd`) shows the same signal chain in patcher form. It can run alongside or instead of the Rust engine if you prefer to extend it visually. Install with `sudo apt install puredata` then `pd -nogui puredata/solarmix.pd`.

## Hardware

- Raspberry Pi 5
- USB audio device (mic in + speaker out — both ends of one device work, that's how the Pi defaults are wired). The HDMI outs also work as playback.

## Build & run

```bash
cd ~/solarmix
cargo build --release
./target/release/solarmix
```

Then open Safari → `http://<pi-ip>:8844/` (default port 8844; override with `SOLARMIX_PORT=8855`).

To bind to a different audio device, set the default in `pavucontrol` or `alsamixer`, or export `ALSA_PCM_NAME=hw:2,0` before launching — cpal honors the ALSA default.

### As a systemd service

```ini
# /etc/systemd/system/solarmix.service
[Unit]
Description=SolarMix audio engine
After=sound.target network.target

[Service]
ExecStart=/home/xero/solarmix/target/release/solarmix
WorkingDirectory=/home/xero/solarmix
Restart=on-failure
User=xero
Environment=RUST_LOG=solarmix=info

[Install]
WantedBy=multi-user.target
```

Then: `sudo systemctl enable --now solarmix`.

## UI controls

| Section | Controls |
| --- | --- |
| Channel | Mic gain, master, auto-target, auto-mix toggle |
| Reverb | Mix, size, damp |
| Delay | Time (20–1500 ms), feedback, mix |
| EQ | Low / Mid / High shelf+peak gains |
| Experimental Tones | Frequency (log), amp, waveform picker |
| Quantum Circuit | Chaos (0=smooth, 1=entangled chaos), smoothing, LFO Hz, Automation toggle |
| Drum Machine | BPM, gain, on/off, 16-step grid |
| Looper & Scribe | LOOP REC → toggles Idle → Rec → Play → Overdub; STOP / CLEAR. RECORD captures master to WAV. |

Drag a knob with mouse or finger; double-tap to reset.

## Latency

- Block size 512 frames @ 48 kHz → ~10.6 ms per direction. With USB audio you can usually push down to 256 or 128; lower `BUFFER_SIZE` in `src/audio/mod.rs` if your device is happy.
- The audio thread takes **no locks** — all params are atomic floats, recording goes through a bounded channel that drops on overrun rather than blocking.

## Project layout

```
solarmix/
├── Cargo.toml
├── src/
│   ├── main.rs                 # entry, tokio runtime, server bootstrap
│   ├── state.rs                # SharedState (atomics)
│   ├── web.rs                  # axum routes + WebSocket protocol
│   └── audio/
│       ├── mod.rs              # constants
│       ├── engine.rs           # cpal streams + signal chain
│       ├── reverb.rs           # Freeverb-style
│       ├── delay.rs            # ping-pong delay
│       ├── eq.rs               # RBJ biquad 3-band
│       ├── drums.rs            # 4-voice synth drum machine
│       ├── looper.rs           # overdub looper
│       ├── recorder.rs         # WAV writer thread
│       ├── experiment.rs       # tone generator
│       ├── quantum.rs          # 4-qubit modulator
│       └── simd.rs             # NEON intrinsic kernels
├── static/                     # Warcraft-style web UI (HTML/CSS/JS)
└── puredata/solarmix.pd        # optional Pure Data engine
```

## License

MIT.
