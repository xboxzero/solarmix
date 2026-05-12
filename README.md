# solarmix

Leap-driven feedback rhythm machine. A self-contained web page that turns the
Pi camera, browser mic, colored noise, and a feedback delay network into a
4-channel sound system, routed by a small 4-qubit quantum circuit. Master
volume and master controls are driven by Leap Motion hand position, with mouse
fallback when no Leap data arrives.

## Run

```bash
cargo run --release            # listens on :8855
cargo run --release -- --port 8800
```

Open `http://<host>:8855/`. Mouse fallback is automatic; for Leap hand
control, also run the sidecar (see `tools/README.md`).

## Endpoints

- `GET  /`              the page (`static/solarmix.html`)
- `GET  /camera.mjpeg`  shared `rpicam-vid` stream (multipart/x-mixed-replace)
- `WS   /leap`          broadcasts JSON hand frames to connected pages
- `POST /leap-ingest`   external sidecar pushes hand frames here
- `GET  /health`        status JSON

## Architecture

Backend is decoupled from the Ultraleap SDK on purpose — the Rust build links
no `libLeapC`. A separate C sidecar (`tools/leap_bridge.c`) polls
`libtrack_server` and POSTs JSON to `/leap-ingest`; the page consumes those
frames over the `/leap` WebSocket. Without the bridge, the page falls back to
mouse for the master controls.

The page itself owns all DSP and visuals — a single HTML file, no build step.

## Page contents

- Three.js wireframe torus knot + buffer-line "oscillator lightning" deformed
  by the master analyser; impulse bolts on each rhythm hit.
- 4 channels:
  - **ch0 cam-osc** — sawtooth + bandpass; pitch from camera centroid, snapped
    to the current musical scale.
  - **ch1 mic / autotune** — pitch detection (autocorrelation) → sine at
    scale-snapped pitch, dry mic mixed low.
  - **ch2 noise** — white/pink/brown/blue/violet buffers, color re-picked on
    each quantum measurement.
  - **ch3 feedback rhythm** — 4-line Hadamard-cross-feedback FDN, excited by
    impulses fired on folk-meter grids (6/8 jig, 12/8 swing, son 3-2, rumba,
    samba, kpanlogo, tarantella, bourrée, breton an dro, odd 7/8) — no drum
    samples; rhythm is purely the FDN's tonal response.
- 4-qubit unitary simulator: H / Ry / CNOT applied each step; measurements
  collapse to a basis state that selects channel routing permutation and
  noise color. Visible bottom-right as marginal-probability bars, last gate,
  entropy, and current permutation.
- Scales: chromatic, major, minor, dorian, phrygian, lydian, mixolydian,
  pent major, pent minor, blues, raga Yaman, raga Bhairavi.

## Camera

The backend spawns `rpicam-vid` once per first subscriber and re-broadcasts
MJPEG frames to all clients. On a non-Pi host without `rpicam-vid`, the
endpoint returns an empty stream and the page background stays black — the
audio still works.
