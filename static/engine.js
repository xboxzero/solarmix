// morlam engine — all synth state, in the browser.
//
// Holds the parameters, runs the 4-qubit tensor-product router, maps
// Lissajous touches and keyboard keys to well-tempered lai pitches
// (tuning.js), sequences the klong + ching groove, records the output and
// hands the UI a snapshot of everything to draw.

// Mor lam groove, eighth notes over two bars of 4/4: klong (drum) on the
// beats with pushes, ching (small cymbals) answering on every off-beat —
// open "ching" on 2 & 4, closed "chap" elsewhere.
const KLONG_PATTERN = [1.0, 0, 0.35, 0.6, 0.85, 0, 0.45, 0.3, 1.0, 0, 0.35, 0.6, 0.85, 0.25, 0.5, 0.4];
const CHING_PATTERN = [0, 0.5, 0, 0.9, 0, 0.5, 0, 0.9, 0, 0.5, 0, 0.9, 0, 0.5, 0.3, 0.9];

const TAU = Math.PI * 2;

class QubitRouter {
  constructor() {
    // Different drift rates per qubit keep the entanglement non-periodic.
    this.qubits = [
      { theta: 0.4, phi: 0.0, driftT: 0.013, driftP: 0.027 },
      { theta: 0.9, phi: 1.0, driftT: 0.021, driftP: 0.041 },
      { theta: 1.2, phi: 2.0, driftT: 0.034, driftP: 0.019 },
      { theta: 0.7, phi: 3.0, driftT: 0.011, driftP: 0.053 },
    ];
    this.coeffs = new Float32Array(16).fill(0.0625);
  }

  step(chaos, dt) {
    for (const q of this.qubits) {
      q.theta = (q.theta + q.driftT * chaos * dt * TAU) % TAU;
      q.phi = (q.phi + q.driftP * chaos * dt * TAU) % TAU;
    }
    let sum = 0;
    for (let k = 0; k < 16; k++) {
      let a = 1;
      for (let i = 0; i < 4; i++) {
        const c = Math.cos(this.qubits[i].theta), s = Math.sin(this.qubits[i].theta);
        a *= ((k >> i) & 1) ? s * s : c * c;
      }
      this.coeffs[k] = a; sum += a;
    }
    if (sum > 1e-9) for (let k = 0; k < 16; k++) this.coeffs[k] /= sum;
  }
}

class LocalEngine {
  constructor(synth) {
    this.synth = synth;
    this.master = 0.7;
    this.mode = 1;
    this.chaos = 0;          // 0 = sends follow the manual matrix exactly
    this.bpm = 126;
    this.fx = Object.assign({}, FX_DEFAULTS);
    this.drumOn = true;
    this.recording = false;

    // Manual send matrix, row-major [voice*4 + channel];
    // channels: 0 DRY · 1 WET L (reverb) · 2 WET R (delay) · 3 MOD
    this.route = new Float32Array([
      0.9, 0.3, 0.2, 0.4, // khaen
      0.7, 0.5, 0.3, 0.0, // phin
      0.5, 0.4, 0.6, 0.2, // so
      0.9, 0.2, 0.0, 0.0, // klong
    ]);
    this.sends = new Float32Array(16); // effective sends after chaos blend

    this.router = new QubitRouter();
    this.router.step(0, 0);
    this.gate = [false, false, false, false];
    this.note = [-1, -1, -1, -1];
    this.outLevel = 0;

    this._drumStep = 0;
    this._nextDrumTime = 0;
    this._recorder = null;
    this._chunks = [];
  }

  // Tonic of the current lai, octave 3 — the khaen's drone and the klong's pitch.
  get root() { return Tuning.hz(Tuning.tonicMidi(this.mode)); }

  pitchFor(t, intensity) {
    const n = Tuning.lai(this.mode).steps.length;
    const step = Math.min(n - 1, Math.floor(Math.min(Math.max(t, 0), 0.999) * n));
    const octave = Math.floor(Math.min(Math.max(intensity, 0), 1) * 2) - 1; // -1..+1
    const midi = Tuning.degreeMidi(this.mode, step) + 12 * octave;
    return { step: midi, midi, hz: Tuning.hz(midi) };
  }

  // Push the whole state into a freshly started synth.
  attach() {
    const s = this.synth;
    s.setMaster(this.master);
    for (const k in this.fx) s.setFx(k, this.fx[k]);
    s.setFx('bpm', this.bpm);
    this.retune();
  }

  // Called whenever lai, key or temperament changes.
  retune() {
    this.synth.setDrone(this.root);
  }

  // Strike/glide a voice to an absolute pitch. Plucked voices (phin, klong)
  // re-strike on every new note; sustained ones (khaen, so) glide legato.
  _play(v, midi, hz, vel) {
    const s = this.synth;
    const plucked = v === 1 || v === 3;
    if (!this.gate[v] || (plucked && midi !== this.note[v])) s.noteOn(v, hz, clamp(vel, 0.2, 1));
    else if (midi !== this.note[v]) s.setPitch(v, hz);
    this.gate[v] = true;
    this.note[v] = midi;
  }

  handle(msg) {
    const s = this.synth;
    switch (msg.type) {
      case 'set': {
        const v = msg.value;
        switch (msg.id) {
          case 'master': this.master = clamp(v, 0, 1); s.setMaster(this.master); break;
          case 'chaos': this.chaos = clamp(v, 0, 1); break;
          case 'bpm': this.bpm = clamp(v, 30, 240); s.setFx('bpm', this.bpm); break;
        }
        break;
      }
      case 'toggle':
        if (msg.id === 'drum') this.drumOn = !this.drumOn;
        break;
      case 'mode':
        this.mode = clamp(msg.value | 0, 1, LAI_COUNT);
        this.retune();
        break;
      case 'tuning':
        if (msg.temperament && TEMPERAMENTS[msg.temperament]) Tuning.temperament = msg.temperament;
        if (typeof msg.transpose === 'number') Tuning.transpose = clamp(msg.transpose | 0, -6, 6);
        this.retune();
        break;
      case 'fx':
        if (!(msg.path in this.fx)) return;
        this.fx[msg.path] = msg.value;
        s.setFx(msg.path, msg.value);
        break;
      case 'route':
        if (msg.voice < 4 && msg.bus < 4) this.route[msg.voice * 4 + msg.bus] = clamp(msg.value, 0, 1);
        break;
      case 'lissajous': {
        const v = msg.voice;
        if (!(v >= 0 && v < 4)) return;
        const { midi, hz } = this.pitchFor(msg.t, msg.intensity);
        this._play(v, midi, hz, msg.intensity);
        break;
      }
      case 'note': {
        const v = msg.voice;
        if (!(v >= 0 && v < 4)) return;
        if (msg.gate === false) {
          if (this.note[v] === msg.midi) this.handle({ type: 'voice', voice: v, gate: false });
          return;
        }
        this._play(v, msg.midi, msg.hz || Tuning.hz(msg.midi), msg.velocity ?? 0.8);
        break;
      }
      case 'voice':
        if (msg.voice >= 0 && msg.voice < 4 && !msg.gate) {
          this.gate[msg.voice] = false;
          this.note[msg.voice] = -1;
          s.noteOff(msg.voice);
        }
        break;
      case 'record':
        if (msg.on) this.startRecording(); else this.stopRecording();
        break;
    }
  }

  // Advance qubits, apply routing, schedule drums. Call ~30×/s.
  step(dt) {
    this.router.step(this.chaos, dt);
    for (let i = 0; i < 16; i++) {
      this.sends[i] = clamp(this.route[i] * (1 - this.chaos) + this.router.coeffs[i] * 4 * this.chaos, 0, 1);
    }
    const s = this.synth;
    if (!s.isInitialized) return;
    for (let i = 0; i < 16; i++) s.setSendLevel(i >> 2, i & 3, this.sends[i]);
    this.chLevels = s.channelLevels();
    this._scheduleDrums();
    const lvl = s.outputLevel();
    this.outLevel = Math.max(lvl, this.outLevel * 0.85);
  }

  _scheduleDrums() {
    const ctx = this.synth.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const stepDur = 60 / this.bpm / 2; // eighth notes
    const now = ctx.currentTime;
    if (this._nextDrumTime < now) this._nextDrumTime = now + 0.05;
    while (this._nextDrumTime < now + 0.12) {
      const i = this._drumStep % KLONG_PATTERN.length;
      if (this.drumOn) {
        const kv = KLONG_PATTERN[i], cv = CHING_PATTERN[i];
        const pitch = this.root * (i % 8 === 0 ? 1 : 1.5);
        if (kv > 0) this.synth.voices[3].noteOn(pitch, kv * 0.8, this._nextDrumTime);
        // open ching rings on the strong off-beats, closed chap on the rest
        if (cv > 0) this.synth.ching(cv, cv > 0.8, this._nextDrumTime);
      }
      this._drumStep++;
      this._nextDrumTime += stepDur;
    }
  }

  startRecording() {
    const dest = this.synth.recordDest;
    if (this.recording || !dest || typeof MediaRecorder === 'undefined') return;
    this._chunks = [];
    const rec = new MediaRecorder(dest.stream);
    rec.ondataavailable = e => { if (e.data && e.data.size) this._chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || 'audio/webm';
      const blob = new Blob(this._chunks, { type });
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `morlam-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    rec.start();
    this._recorder = rec;
    this.recording = true;
  }

  stopRecording() {
    if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop();
    this._recorder = null;
    this.recording = false;
  }

  // Everything the HUD needs to draw, ~30×/s.
  snapshot() {
    const q = Array.from(this.router.coeffs);
    return {
      out_level: this.outLevel,
      recording: this.recording,
      drum_on: this.drumOn,
      mode: this.mode,
      bpm: this.bpm,
      master: this.master,
      chaos: this.chaos,
      qcoef: q,
      sends: Array.from(this.sends),
      ch_levels: this.chLevels || [0, 0, 0, 0],
      liss_a: 1 + 4 * (q[0] + q[5] + q[10] + q[15]),
      liss_b: 1 + 4 * (q[1] + q[4] + q[11] + q[14]),
      liss_c: 1 + 4 * (q[2] + q[7] + q[8] + q[13]),
    };
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

window.LocalEngine = LocalEngine;
