# SolarMix

> A continuous, web-controlled audio mixer / synth that lives on a Raspberry Pi 5.
> The UI is a 3D water surface with a glowing orb you touch to bend the sound.

```
mic ─► [auto-mix] ─► [orb tone] ─► [drum + bass] ─► EQ ─► Delay ─► Reverb ─► Master ─► speakers
                                                                       │
                                  quantum 4-qubit ─────────────────────┘
                                  modulates: reverb mix/size, delay feedback,
                                             drum swing, bass detune, exp freq
```

## What it does

- **Always-on mic capture** — the engine runs forever; only Click-Stop stops it.
- **3D water UI** (Three.js, served straight from the Pi over HTTP) — drag the orb
  to control:
  - X axis → experimental tone frequency (40 Hz – 2 kHz, log)
  - Y axis (pinch / wheel) → tone amplitude
  - Z axis (push / pull) → quantum chaos
- **One-touch record** — single REC button writes a 16-bit stereo WAV to
  `recordings/`. Stays armed until you click it again.
- **Organic drum + bass machine** with 5 voices (kick, snare, hat, clap, bass)
  and African-folk / blues presets:
  - **Afrobeat** — Fela-style syncopation, 16-th hat, walking bass on Am
  - **Highlife** — 12/8 Ghanaian feel over 16 steps, light swing
  - **Blues** — shuffle with triplet hats and a walking E blues bass line
  - **Bembe** — Yoruba 6/8 standard-bell cross-rhythm
  - **DnB** — slow dubby drum-and-bass focused on sub
  - **Free** — start from a neutral grid
- **Deeper quantum**: the 4-qubit modulator now reaches into drum swing, bass
  chorus depth, reverb mix/size, delay feedback, and tone frequency. At low
  Chaos the mix breathes; at high Chaos it entangles those parameters together.
- **Auto-mixer** that targets a steady RMS so quiet voices come up and loud
  bursts back off.

## Why "Pi 5 + Rust + NEON SIMD"

- The Rust binary is the realtime engine — Axum web server + cpal capture /
  playback + the full DSP chain.
- Hot DSP loops use `std::arch::aarch64` NEON intrinsics that the compiler emits
  as ARMv8 NEON assembly (FMLA, FMUL on 128-bit float vectors, 4 floats per
  instruction). See `src/audio/simd.rs`. Scalar fallbacks let it still build on
  dev machines.
- A companion `puredata/solarmix.pd` patch shows the same signal chain in
  patcher form for visual extension.

## Hardware

- Raspberry Pi 5
- USB audio device (mic in + speaker out)

## Build & run

```bash
cd ~/solarmix
cargo build --release
./target/release/solarmix
```

Then open Safari → `http://<pi-ip>:8844/` (override with `SOLARMIX_PORT=8855`).
Pick a non-default audio device with `SOLARMIX_INPUT_DEVICE=...` /
`SOLARMIX_OUTPUT_DEVICE=...`.

### Systemd

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

## UI

| Surface | Gesture |
| --- | --- |
| 3D orb | Drag = move on water (X = freq, Z = chaos) |
| 3D orb | Mouse wheel / pinch = Y = amp |
| Presets | Tap a preset name to swap drum + bass pattern |
| ▶ DRUMS | Toggle drum machine on/off |
| ● REC | Toggle WAV recording on/off |

The 16-step bar at the bottom shows the current step. The water surface
itself reflects the quantum signals + the output RMS.

## Latency

- 512-frame block @ 48 kHz → ~10.6 ms per direction. Lower `BUFFER_SIZE` in
  `src/audio/mod.rs` for tighter latency on a happy USB device.
- The audio thread takes no locks — all params are atomic floats; recording
  goes through a bounded channel that drops on overrun rather than blocking.

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
│       ├── drums.rs            # 5-voice drum/bass + Afrobeat/Highlife/Blues/Bembe/DnB presets
│       ├── recorder.rs         # WAV writer thread
│       ├── experiment.rs       # orb-driven tone generator
│       ├── quantum.rs          # 4-qubit modulator
│       └── simd.rs             # NEON intrinsic kernels
├── static/                     # 3D water UI (Three.js, served from Pi)
└── puredata/solarmix.pd        # optional Pure Data engine
```

## License

MIT.
