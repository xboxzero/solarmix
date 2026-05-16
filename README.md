# tezeta · ኢትዮጵያ kiñit synth

> A web-controlled Ethiopian-mode synth that lives on a Raspberry Pi 5.
> Pure Data is the engine. Safari is the controller. Sound is Pi-only.
> The UI is a 3D Lissajous curve you touch to play, with a node-graph
> patchbay whose 16 sends are entangled by a multiplied 4-qubit router.

```
Safari (touch, no audio)              Raspberry Pi 5
┌────────────────────────────┐  ws    ┌─────────────────────────────────────┐
│ Lissajous 3D curve         │ ◄────► │ Rust (axum + libpd embedded)        │
│ Node-graph patchbay        │        │   • 16-ch tensor-product qubit      │
│ Master vol · mode · sliders│        │     router → patchbay sends         │
└────────────────────────────┘        │   • cpal ALSA → speakers            │
                                       │ Pure Data: tezeta.pd                │
                                       │   krar · masinko · washint · kebero│
                                       │   qenet mode select (1..4)         │
                                       │   FX bus + master volume           │
                                       └─────────────────────────────────────┘
```

## Why Ethiopian music

The patch is built around the **qenet** pentatonic system — four kiñit (modes)
each carrying its own emotional register:

| Mode | Notes (from C) | Character |
| --- | --- | --- |
| Tezeta | C · D · E · G · A | nostalgic, longing — Mulatu's Ethio-jazz tonality |
| Bati | C · E · F · G · B | lively, dance — northern highland feel |
| Ambassel | C · D♭ · F · G · A♭ | heroic, ancient — Gonder / Wollo song |
| Anchihoye | C · D♭ · F · G♭ · A | dramatic, liturgical |

Touch on the Lissajous curve maps to the nearest of the 5 mode-notes. The
voice you're currently controlling determines the timbre:

- **krar** — 6-string lyre, plucked bandpass-filtered saw
- **masinko** — single-string bowed lute, sustained osc + body filter
- **washint** — bamboo flute, breathy filtered noise
- **kebero** — hand drum, envelope-shaped noise + sub thump

## Multiplied qubit patchbay

There are 4 voices and 4 buses (DRY · REV · DLY · DARK). The 16 send levels
between them are not user-set individually — they're driven by the tensor
product `|ψ⟩ = q₀ ⊗ q₁ ⊗ q₂ ⊗ q₃` of four slowly-drifting single-qubit states.
Each of the 16 basis-state probabilities is one send coefficient, so the
patchbay is entangled: turning chaos up doesn't randomize the matrix, it
*weaves* the routings.

```
chaos = 0 ─► routing follows the base matrix exactly
chaos = 1 ─► routing follows the qubit-entangled coefficients
```

## Hardware

- Raspberry Pi 5
- USB audio device (output)
- Any device with Safari 16.4+ for control

The browser **never plays sound** — `<canvas>` only. All audio is on the Pi.

## Build & run

The Rust binary embeds Pure Data via the `libpd-rs` crate. On a fresh Pi:

```bash
# system deps: libpd-sys builds libpd from C, bindgen needs libclang
sudo apt install libasound2-dev cmake build-essential pkg-config libclang-dev
cd ~/solarmix          # directory name stays "solarmix" on disk; the crate
                       # is now `tezeta`
cargo build --release
./target/release/tezeta
```

Then open Safari → `http://<pi-ip>:8844/` (override with `TEZETA_PORT=8855`).
Pick a non-default audio device with `TEZETA_OUTPUT_DEVICE=...`.

> The first build downloads + compiles `libpd` from source via `libpd-sys`,
> which takes ~5 min on a Pi 5. Subsequent builds are cached.
>
> `libpd-rs` 0.2.0 has seven aarch64-specific cast errors in `functions/receive.rs`
> (signed-vs-unsigned `c_char`). A patched copy is vendored at
> `vendor-libpd-rs/` and the crate is path-pinned to it from `Cargo.toml`. If
> upstream publishes a fix you can drop the vendor dir and switch back.

### Systemd

```ini
# /etc/systemd/system/tezeta.service
[Unit]
Description=tezeta synth engine
After=sound.target network.target

[Service]
ExecStart=/home/xero/solarmix/target/release/tezeta
WorkingDirectory=/home/xero/solarmix
Restart=on-failure
User=xero
Environment=RUST_LOG=tezeta=info

[Install]
WantedBy=multi-user.target
```

Then: `sudo systemctl enable --now tezeta`.

## UI

| Surface | Gesture |
| --- | --- |
| 3D Lissajous curve | Touch on the curve to strike the active voice at that point |
| Voice buttons | Pick which voice (krar/masinko/washint/kebero) responds to touches |
| Mode buttons | Switch qenet mode (TEZETA / BATI / AMBASSEL / ANCHIHOYE) |
| CHAOS slider | Blend base routing matrix ↔ qubit-entangled routing |
| MASTER slider (top) | Master output volume |
| Patchbay (right) | 16 wires showing live qubit-driven send levels |
| ▶ KEBERO | Toggle the drum voice |
| ● REC | Capture stereo WAV in `recordings/` |

Drag outside the curve to orbit the camera.

## Architecture

```
tezeta/
├── Cargo.toml                     # crate name: tezeta
├── src/
│   ├── main.rs                    # bootstrap
│   ├── qubit.rs                   # 4-qubit tensor product → 16 coefficients
│   ├── state.rs                   # atomic shared state
│   ├── web.rs                     # axum + WS protocol
│   └── audio/
│       ├── mod.rs                 # constants
│       ├── engine.rs              # cpal + libpd glue
│       └── recorder.rs            # WAV writer thread
├── static/                        # Safari UI: Lissajous + patchbay
│   ├── index.html
│   ├── app.js                     # Three.js + SVG patchbay
│   ├── style.css                  # Ethiopian flag palette
│   └── vendor/three.module.js
└── puredata/tezeta.pd             # Pd patch — the actual DSP
```

## Pd receive names

The Rust side drives the patch via `libpd_send_float` to these receivers:

| Receiver | Meaning |
| --- | --- |
| `master_vol` | master output gain (0..1) |
| `mode` | qenet mode index (1=tezeta, 2=bati, 3=ambassel, 4=anchihoye) |
| `root` | root frequency Hz |
| `gate_<v>` | strike a voice (v ∈ 0..3) |
| `pitch_<v>` | voice pitch Hz |
| `send_<v>_<b>` | routing coefficient voice v → bus b, 16 total |
| `rev_mix`, `rev_size`, `del_time`, `del_fb`, `bpm`, `drum_on` | FX + groove |

The `.pd` patch in this repo is a structural seed — open it in Pure Data to
tune oscillator topologies and filter responses. The receive names are the
stable contract.

## License

MIT.
