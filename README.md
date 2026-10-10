# morlam · หมอลำ khaen machine

> A mor lam synth that runs entirely in your browser — no server, no install.
> Play it from a built-in well-tempered pentatonic keyboard or by touching a
> 3D Lissajous curve, through a hand-controlled FX rack (gain, amp, modulation,
> parallel wet-dry-wet mixer, IR cabinet/room simulation). The interface is a riveted steel machine panel:
> brushed plates, hazard stripes, amber LCDs, LED toggles.
>
> **Play:** https://xboxzero.github.io/solarmix/

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

## FX rack

Press **FX RACK** to open the effects rack. Everything in it is manual: drag
a knob or fader up/down (hold Shift for fine moves), use the mouse wheel to
nudge it, and double-click to reset.

```
voice ─► GAIN ─► AMP ─►  SEND MATRIX  ─►  WET L · DRY · WET R · MOD  ─► IR SIM ─► master
         (one insert chain per voice)      (parallel mixer channels)
```

| Unit | Controls |
| --- | --- |
| **GAIN** | INPUT (0…+30 dB), DRIVE, CLIP (soft / hard / fuzz), ON |
| **AMP** | BASS, MID, TREBLE, PRESENCE (±dB), LEVEL, ON |
| **MOD** | TYPE (chorus / flanger / phaser), RATE, DEPTH, FEEDBACK, ON |
| **W·D·W MIXER** | Four parallel channels, each with its own fader, pan, mute, solo and meter. **WET L** is a 100% wet reverb (SIZE, DECAY, PRE-delay, TONE). **DRY** is the direct sound. **WET R** is a 100% wet delay (TIME, FEEDBACK, TONE, SYNC to a dotted 8th at the current BPM). **MOD** is the 100% wet output of the MOD unit. |
| **SEND MATRIX** | How much of each voice goes into each channel (16 knobs) |
| **IR SIM** | The last stage: a convolution impulse response, either built in (CAB 1×12 / 2×12 / 4×12, small room, hall, plate, spring) or your own file (**LOAD IR…**, any WAV/AIFF the browser can decode), with MIX (dry ⇄ IR) and LEVEL |

Wet and dry are separate channels, not one mix knob. Default pans spread
them wet-left / dry-center / wet-right.

**CHAOS** starts at 0, so the sends follow the matrix exactly. Raising it
blends in the drifting 4-qubit router. The patchbay wires on screen always
show the sends actually in use.

## Run it

It's a static site: plain HTML, CSS and JavaScript, with Three.js vendored in
`static/vendor/`. No build step.

- **Online:** GitHub Pages serves `static/`. To publish: **Settings → Pages →
  Source: GitHub Actions**, then push to `master` (or run the *Deploy to
  GitHub Pages* workflow by hand).
- **Locally:** `cd static && python3 -m http.server` → `http://localhost:8000/`.

Tap **ENGAGE** to start audio (browsers only allow sound after a gesture).
Works in current Chrome, Firefox, Edge and Safari 16.4+, desktop or mobile.

## Controls

| Surface | Gesture |
| --- | --- |
| Keyboard | Play the active voice in the current lai (touch, mouse, or Z…/ and Q…Y) |
| 3D Lissajous curve | Touch on the curve to strike the active voice at that point; drag off it to orbit |
| Voice buttons | Pick which voice (khaen/phin/so/klong) the keyboard and curve play |
| Lai buttons | Switch lai (YAI / NOI / SUTSANAEN / PO SAI / SOI) |
| TEMPERAMENT · KEY | Pick the well temperament and transpose the lai |
| FX RACK | Open the effects rack (see above) |
| CHAOS | Blend the manual send matrix ↔ qubit-entangled routing |
| BPM | Groove tempo (and synced delay time) |
| MASTER | Master output volume |
| Patchbay (right) | 16 wires showing the live voice → channel send levels |
| KLONG + CHING | Toggle the groove |
| REC | Record the output; stopping downloads the take as an audio file |

## Files

```
static/
├── index.html          # page + HUD markup
├── style.css           # steel machine-panel theme
├── tuning.js           # lai + well-temperament tables
├── synth.js            # Web Audio voices, ching, send matrix
├── fx.js               # FX rig: gain/amp inserts, W-D-W mixer, mod, IR sim
├── fxrack.js           # FX rack UI: knobs, faders, switches, meters
├── engine.js           # state, qubit router, pitch mapping, groove, recorder
├── app.js              # Three.js scene, keyboard, patchbay overlay, HUD
└── vendor/three.module.js
```

The earlier Raspberry Pi / Rust / Pure Data engine has been removed from the
tree; it's still in the git history if it's ever needed again.

## License

MIT.
