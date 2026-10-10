# morlam · หมอลำ khaen machine

> A mor lam synth that runs entirely in your browser — no server, no install.
> Play it from a built-in well-tempered pentatonic keyboard or by touching
> the world's submarine fibre-optic cables on a 3D globe, through a
> hand-controlled FX rack (gain, amp, modulation, a parallel wet-dry-wet
> mixer with phase shifters and drive, IR simulation) and a step-sequenced
> drum machine. Minimal industrial look: flat warm grey, hairlines, one
> orange accent.
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

## The globe

The 3D view is the Earth with every submarine fibre-optic cable on
TeleGeography's Submarine Cable Map (about 700 systems) and their landing
stations. **Each cable is a string you can play:** touch it and the voice
sounds; the position along the cable, from one end to the other, picks one of
the five notes of the current lai. The struck cable lights up in the voice's
colour and its name appears in the side panel. Drag anywhere off the cables to
turn the globe; left alone it drifts slowly.

## FX rack

Press **Effects** to open the effects rack. Everything in it is manual:

- **Knobs:** drag up/down *or* left/right (hold Shift for fine moves), scroll
  to nudge, double-click to reset, or click the value to type an exact number.
  Arrow keys work when a knob has focus.
- **Faders:** click anywhere on the track to jump there, or drag.

```
voice ─► GAIN ─► AMP ─► SEND MATRIX ─┬─► WET L  reverb → phase shifter ──┐
         (insert chain per voice)     ├─► DRY    drive → compressor ───────┤
                                      ├─► WET R  delay → phase shifter ───┼─► IR SIM ─► master
                                      └─► MOD    chorus/flanger/phaser ───┘
```

| Unit | Controls |
| --- | --- |
| **GAIN** | INPUT (0…+30 dB), DRIVE, CLIP (soft / hard / fuzz), ON |
| **AMP** | BASS, MID, TREBLE, PRESENCE (±dB), LEVEL, ON |
| **MOD** | TYPE (chorus / flanger / phaser), RATE, DEPTH, FEEDBACK, ON |
| **MIXER** | Four parallel channels, each with its own fader, pan, mute, solo and meter. **WET L**: 100% wet reverb (SIZE, DECAY, PRE-delay, TONE) into a **phase shifter** (ON, RATE, DEPTH, FEEDBACK, MIX). **DRY**: a drive stage — CLEAN, LOW GAIN (soft overdrive) or HI GAIN (tightened, two-stage, mid-scooped) with GAIN, TONE, LEVEL — then a COMPRESSOR (ON, THRESHOLD, RATIO). **WET R**: 100% wet delay (TIME, FEEDBACK, TONE, SYNC to a dotted 8th at the tempo) into its own **phase shifter**, sweeping opposite to WET L's. **MOD**: the 100% wet output of the Modulation unit. |
| **SEND MATRIX** | How much of each voice goes into each channel (16 knobs) |
| **IR SIM** | The last stage: a convolution impulse response, either built in (CAB 1×12 / 2×12 / 4×12, small room, hall, plate, spring) or your own file (**LOAD IR…**, any WAV/AIFF the browser can decode), with MIX (dry ⇄ IR) and LEVEL |

Wet and dry are separate channels, not one mix knob. Default pans spread
them wet-left / dry-center / wet-right.

**CHAOS** starts at 0, so the sends follow the matrix exactly. Raising it
blends in the drifting 4-qubit router. The patchbay wires on screen always
show the sends actually in use.

## Drum machine

Press **Drums** (or the *Drum machine* tab in the rack). **Groove** starts and
stops it.

- Six tracks: KLONG (barrel drum, tuned to the lai), SLAP, KICK, SNARE, CHING
  (open cymbal) and CHAP (closed cymbal).
- 16 sixteenth-note steps. Click or drag across steps to paint them, scroll on
  a step to set its velocity, right-click to cycle soft → medium → accent.
- Per track: mute, LEVEL, TUNE (±12 semitones), DECAY.
- Pattern: PRESET (Lam sing, Lam toei, Lam phloen, Classic, Empty), LENGTH
  (4/8/12/16 steps), SWING, CLEAR. The playhead shows the step that is sounding.

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
| Globe | Touch a submarine cable to play the active voice; position along the cable picks the note; drag off the cables to turn the globe |
| Voice buttons | Pick which voice (khaen/phin/so/klong) the keyboard and globe play |
| Lai buttons | Switch lai (YAI / NOI / SUTSANAEN / PO SAI / SOI) |
| TEMPERAMENT · KEY | Pick the well temperament and transpose the lai |
| Effects · Drums | Open the rack on the effects or drum machine page |
| CHAOS | Blend the manual send matrix ↔ qubit-entangled routing |
| BPM | Groove tempo (and synced delay time) |
| MASTER | Master output volume |
| Patchbay (right) | 16 wires showing the live voice → channel send levels |
| Groove | Start / stop the drum machine |
| REC | Record the output; stopping downloads the take as an audio file |

## Files

```
static/
├── index.html          # page + HUD markup
├── style.css           # steel machine-panel theme
├── tuning.js           # lai + well-temperament tables
├── synth.js            # Web Audio voices, ching, send matrix
├── fx.js               # FX rig: gain/amp inserts, W-D-W mixer, phasers, drive, IR sim
├── fxrack.js           # rack UI: effects page + drum machine page
├── engine.js           # state, qubit router, pitch mapping, drum sequencer, recorder
├── app.js              # scene, keyboard, patchbay overlay, HUD
├── globe.js            # 3D Earth + submarine cables, cable picking
├── data/               # cables.json, landing.json, land.json (see Credits)
└── vendor/three.module.js
```

The earlier Raspberry Pi / Rust / Pure Data engine has been removed from the
tree; it's still in the git history if it's ever needed again.

## Credits

- **Submarine cables and landing stations:** [TeleGeography Submarine Cable
  Map](https://www.submarinecablemap.com/), licensed CC BY-NC-SA 3.0
  (non-commercial, attribution, share-alike). The files in `static/data/`
  derived from it (`cables.json`, `landing.json`) stay under that licence.
- **Coastlines:** [Natural Earth](https://www.naturalearthdata.com/) 1:110m
  land, public domain, via the `world-atlas` package.
- `tools/build_map_data.py` rebuilds `static/data/` from the source files.

## License

MIT.
