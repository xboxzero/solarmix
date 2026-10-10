# morlam · หมอลำ khaen machine

> A mor lam synth that runs entirely in your browser — no server, no install.
> Play it from a built-in well-tempered pentatonic keyboard or by touching
> the world's submarine fibre-optic cables on a 3D globe, plus a
> step-sequenced drum machine, each with its own hand-controlled FX rig
> (pre-amp EQ, amp + cabinet simulator, a six-channel parallel wet-dry-wet
> mixer with eight reverbs and six delays, a manual signal network, IR
> simulation). Dark-fantasy look: soot-black stone, tarnished gold, ember
> glow, inscriptional capitals.
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

A dark 3D Earth with three layers, toggled in the **Realm** panel:

- **Cables** — every submarine fibre-optic cable on TeleGeography's Submarine
  Cable Map (about 700 systems) and their landing stations, glowing like
  embers. **Each cable is a string you can play:** touch it and the voice
  sounds; the position along the cable, from one end to the other, picks one
  of the five notes of the current lai. The struck cable lights up in the
  voice's colour and its name appears in the side panel.
- **Satellites** — about 12,400 communication and navigation satellites from a
  CelesTrak orbital-element snapshot: Starlink, OneWeb, Iridium, GPS and the
  geostationary belt, each constellation in its own colour. Positions are
  computed on the GPU from simplified circular orbits; altitude is
  compressed (not to scale) so the GPS and geostationary rings stay in view.
  **Orbit speed** runs them in real time or up to 3600× faster.
- **5G** — countries with commercial 5G service glow on the surface, and major
  5G hubs pulse. This is an approximate, illustrative layer (compiled from
  public operator announcements, 2025), not a coverage map.

Drag anywhere off the cables to turn the globe; left alone it drifts slowly.
Embers drift up around it.

## FX rigs

The keys (keyboard + globe voices) and the drum machine each have their **own
complete effects rig** with independent settings. Open them with **Keys FX**
and **Drum FX** in the bottom bar (or the tabs in the rack). Each rig:

```
sources ─┬─► AMP BUS ─► PRE-AMP EQ ─► AMP ─► CAB ─► amp sends ─┐   one amp per rig
         └─► direct sends (bypass the amp) ────────────────────┤
       ─► SIGNAL NETWORK: every source → amp bus / every channel, amp → every channel
       ─► six parallel channels, wet · dry · wet:
            REV A · DLY A │ DRY │ DLY B · REV B │ MOD
            + FX → FX feeds (mod → delays/reverbs, delays → reverbs)
       ─► each channel: fader · pan · mute · solo · meter
       ─► IR SIM ─► rig output ─► master
```

| Section | Controls |
| --- | --- |
| **1 Pre-amp EQ** | Input gain, high-pass, low-pass, low shelf (freq/gain), low-mid and high-mid bands (freq/gain/Q), high shelf (freq/gain), on/off, with a live response curve |
| **2 Amp simulator** | Model (Clean, Tube warm, Crunch, Lead hi-gain, Bass, Fuzz), drive, master; tone stack (bass, mid, treble, presence); cabinet (1×12 open, 1×12 closed, 2×12, 4×12, bass 1×15, off) with mic position (off-axis ↔ on-axis). Models are roughly level-matched |
| **3 Modulation** | Chorus / flanger / phaser for the MOD channel: rate, depth, feedback |
| **4 Mixer** | **REV A / REV B**: Room, Chamber, Hall, Cathedral, Plate, Spring, Gated or Reverse, with size, decay, pre-delay, tone, low cut. **DLY A / DLY B**: Digital, Tape echo, Analog (BBD), Ping-pong, Multi-tap or Slapback, with sync + note value (1/2 … 1/16, dotted, triplet) or free time, feedback, tone, wow. Each reverb and delay has a **phase shifter** insert (rate, depth, feedback, mix). **DRY**: Clean / Low gain / Hi gain drive and a compressor. **MOD**: output of section 3. Every channel has its own fader, pan, mute, solo and meter |
| **5 Signal network** | *Sources → amp / channels*: each source's level into the shared amp (AMP column) and its direct sends into each channel, bypassing the amp; the AMP OUT row sends the amp into each channel. *FX → FX feeds*: send a channel's processed signal into another (e.g. a delay into a reverb) |
| **6 IR simulation & output** | Cabinet/room impulse (built-in or your own WAV/AIFF), dry ⇄ IR mix, IR level, rig output level |

**Performance:** each rig has one shared amp (not one per source), swept
filters update once per audio block, and only what you can hear is computed. A neutral EQ band, a
bypassed amp, a cabinet set to Off, a channel with nothing sent to it or its
fader down, a phase shifter or IR stage that is off — all of these are
unplugged from the audio graph and cost no CPU. Phase shifters start off, and
the drum rig starts with its IR stage off and REV B down; switch them on as
you need them.

**Buffer** (top bar): *Low latency*, *Balanced* (desktop default) or *Stable*
(phone default: a bigger audio buffer that rides out CPU spikes under heavy
effects, at the cost of a little delay). The 3D globe pauses while the rack
covers it and runs at 30 fps on touch devices, leaving CPU for audio.

All controls are manual:

- **Knobs:** drag up/down *or* left/right (hold Shift for fine moves), scroll
  to nudge, double-click to reset, or click the value to type an exact number.
  Arrow keys work when a knob has focus.
- **Faders:** click anywhere on the track to jump there, or drag.

**CHAOS** (bottom bar) starts at 0, so the keys sends follow the matrix
exactly; raising it blends the drifting 4-qubit router into the first four
channels. The patchbay wires on screen show the keys sends in use.

## Drum machine

Press **Drums** (or the *Drum machine* tab in the rack). **Groove** starts and
stops it. Its sound goes through the **Drum FX** rig.

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
| Keys FX · Drum FX · Drums | Open the rack on that page |
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
├── style.css           # dark-fantasy theme
├── tuning.js           # lai + well-temperament tables
├── synth.js            # Web Audio voices, ching, send matrix
├── fx.js               # FX rigs: pre-amp EQ, amp + cab sim, reverbs, delays, mixer, network, IR
├── fxrack.js           # rack UI: Keys FX, Drum FX and drum machine pages
├── engine.js           # state, qubit router, pitch mapping, drum sequencer, recorder
├── app.js              # scene, keyboard, patchbay overlay, HUD
├── globe.js            # 3D Earth: cables (playable), satellites, 5G, embers
├── data/               # cables, landing, land, sats, fiveg (see Credits)
└── vendor/three.module.js
```

The earlier Raspberry Pi / Rust / Pure Data engine has been removed from the
tree; it's still in the git history if it's ever needed again.

## Credits

- **Submarine cables and landing stations:** [TeleGeography Submarine Cable
  Map](https://www.submarinecablemap.com/), licensed CC BY-NC-SA 3.0
  (non-commercial, attribution, share-alike). The files in `static/data/`
  derived from it (`cables.json`, `landing.json`) stay under that licence.
- **Coastlines and country shapes:** [Natural Earth](https://www.naturalearthdata.com/)
  1:110m, public domain, via the `world-atlas` package.
- **Satellites:** orbital elements from [CelesTrak](https://celestrak.org/)
  (GP data, originally from the US Space Force), snapshot in `static/data/sats.json`.
- **5G layer:** countries with commercial 5G service and major hub cities,
  approximate and illustrative.
- `tools/build_map_data.py` (cables, coastlines) and `tools/build_sky_data.py`
  (satellites, 5G) rebuild `static/data/` from the source files.

## License

MIT.
