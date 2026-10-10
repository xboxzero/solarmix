# morlam · หมอลำ khaen machine

> A web-controlled mor lam synth that lives on a Raspberry Pi 5 — or runs
> entirely in the browser. Pure Data is the Pi engine. Safari is the controller.
> Play it from a built-in well-tempered pentatonic keyboard or by touching a
> 3D Lissajous curve, through a node-graph patchbay whose 16 sends are
> entangled by a multiplied 4-qubit router. The interface is a riveted
> steel machine panel: brushed plates, hazard stripes, amber LCDs, LED toggles.
>
> (https://xboxzero.github.io/solarmix/)

```
Safari (touch / keys)                 Raspberry Pi 5
┌────────────────────────────┐  ws    ┌─────────────────────────────────────┐
│ Pentatonic lai keyboard    │ ◄────► │ Rust (axum + libpd embedded)        │
│ Lissajous 3D curve         │        │   • 16-ch tensor-product qubit      │
│ Node-graph patchbay        │        │     router → patchbay sends         │
│ Lai · temperament · key    │        │   • cpal ALSA → speakers            │
└────────────────────────────┘        │ Pure Data: tezeta.pd                │
                                       │   khaen · phin · so · klong        │
                                       │   lai select (1..5)                │
                                       │   FX bus + master volume           │
                                       └─────────────────────────────────────┘
```

## Why mor lam

Mor lam (หมอลำ) is the sung poetry of Laos and Isan, carried by the **khaen**
— a bamboo free-reed mouth organ with drone pipes. Khaen music is organised
into **lai**: pentatonic modes in two families (*thang*). Each lai sits on its
own tonic on a standard khaen in A:

| Lai | Thang | Notes | Character |
| --- | --- | --- | --- |
| Lai yai | yao (minor) | A · C · D · E · G | deep, lamenting |
| Lai noi | yao (minor) | D · F · G · A · C | bright, tender |
| Lai sutsanaen | san (major) | G · A · C · D · E | stately, the "oldest" lai |
| Lai po sai | san (major) | C · D · F · G · A | lively, dance |
| Lai soi | san (major) | D · E · G · A · B | flowing, teasing |

The **KEY** stepper transposes every lai by ±6 semitones.

### Well temperament

Pitches are not equal-tempered. Every note is tuned with a 12-note **well
temperament** (default **Werckmeister III**; also Kirnberger III, Vallotti,
Young II, or plain 12-TET for comparison) with A4 = 440 Hz. In a well
temperament each key has its own colour: lai on near keys (C, G, D, F) get
purer fifths and thirds, remote transpositions sound tenser. Each keyboard key
shows its deviation from equal temperament in cents. The tuning tables live
in `static/tuning.js`.

### Voices

- **khaen** — free-reed mouth organ: square + saw reeds, breath tremolo, and
  two drone pipes holding the lai's tonic and fifth
- **phin** — amplified plucked lute: bright filtered pluck into overdrive
- **so** — two-string fiddle: detuned saws, wide vibrato, shell resonance
- **klong** — barrel drum, plus **ching** finger cymbals answering on the
  off-beats (open "ching" / damped "chap") in a driving 4/4 lam groove

### Keyboard

The built-in keyboard lays the current lai out over three octaves (two on
phones), with the lai's tonic keys in brass. Play it with mouse or multi-touch
(slide across keys for a glissando) or with the computer keyboard:
`Z X C V B N M , . /` then `Q W E R T Y`. Each voice is monophonic with
last-note priority: khaen and so glide legato, phin and klong re-strike.

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

## Run in the browser (GitHub Pages)

`static/` also works as a plain static site with no Pi: when it's opened from
`*.github.io`, from `file://`, with `?standalone`, or when no `/ws` server
answers, `static/engine.js` stands in for the Rust server (qubit router, lai
pitch mapping, klong + ching groove, recording) and `static/synth.js` plays the
four voices through Web Audio. REC downloads the take as an audio file.

To publish: **Settings → Pages → Source: GitHub Actions**, then push to
`master` (or run the *Deploy to GitHub Pages* workflow by hand). The workflow
in `.github/workflows/pages.yml` uploads `static/` as the site.

Try it locally: `cd static && python3 -m http.server` → `http://localhost:8000/?standalone`.

## Hardware

- Raspberry Pi 5
- USB audio device (output)
- Any device with Safari 16.4+ for control

When linked to the Pi, all audio comes from the Pi; standalone, the browser plays it.

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
| Keyboard | Play the active voice in the current lai (touch, mouse, or Z…/ and Q…Y) |
| 3D Lissajous curve | Touch on the curve to strike the active voice at that point |
| Voice buttons | Pick which voice (khaen/phin/so/klong) the keyboard and curve play |
| Lai buttons | Switch lai (YAI / NOI / SUTSANAEN / PO SAI / SOI) |
| TEMPERAMENT · KEY | Pick the well temperament and transpose the lai |
| CHAOS slider | Blend base routing matrix ↔ qubit-entangled routing |
| MASTER slider (top) | Master output volume |
| Patchbay (right) | 16 wires showing live qubit-driven send levels |
| KLONG + CHING | Toggle the groove |
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
│   ├── style.css                  # steel machine-panel theme
│   ├── tuning.js                  # lai + well-temperament tables
│   └── vendor/three.module.js
└── puredata/tezeta.pd             # Pd patch — the actual DSP
```

## Pd receive names

The Rust side drives the patch via `libpd_send_float` to these receivers:

| Receiver | Meaning |
| --- | --- |
| `master_vol` | master output gain (0..1) |
| `mode` | lai index (1=yai, 2=noi, 3=sutsanaen, 4=po sai, 5=soi) |
| `root` | tonic of the current lai, Hz (well-tempered, sent by the browser) |
| `gate_<v>` | strike a voice (v ∈ 0..3) |
| `pitch_<v>` | voice pitch Hz (well-tempered, from `note` messages) |
| `send_<v>_<b>` | routing coefficient voice v → bus b, 16 total |
| `rev_mix`, `rev_size`, `del_time`, `del_fb`, `bpm`, `drum_on` | FX + groove |

The browser computes every pitch (lai × well temperament) and sends it as
`{ type: "note", voice, hz, velocity, gate }`, so the Pi plays the same
tuning as the web synth. The Pi's native DSP voice slots (`src/audio/dsp.rs`)
still use their original oscillator topologies for slots 0–3.

The `.pd` patch in this repo is a structural seed — open it in Pure Data to
tune oscillator topologies and filter responses. The receive names are the
stable contract.

## License

MIT.
