// morlam engine — all synth state, in the browser.
//
// Holds the parameters, runs the 4-qubit tensor-product router, maps
// Lissajous touches and keyboard keys to well-tempered lai pitches
// (tuning.js), sequences the klong + ching groove, records the output and
// hands the UI a snapshot of everything to draw.

// Drum machine: six tracks × up to 16 sixteenth-note steps.
// Pattern strings: '.' off · '-' soft · 'o' medium · 'x' accent.
const DRUM_TRACKS = [
  { id: 'klong', name: 'KLONG' },
  { id: 'slap',  name: 'SLAP' },
  { id: 'kick',  name: 'KICK' },
  { id: 'snare', name: 'SNARE' },
  { id: 'ching', name: 'CHING' },
  { id: 'chap',  name: 'CHAP' },
];
const DRUM_PRESETS = {
  'lam sing': { klong: 'o..-..o.o..-..o.', slap: '......-.......x.', kick: 'x...x...x...x...', snare: '....o.......o...', ching: '..x...x...x...x.', chap: '.-.-.-.-.-.-.-.-' },
  'lam toei': { klong: 'x..o..x...o..o..', slap: '....-.......o...', kick: 'x.......x.......', snare: '................', ching: '....x.......x...', chap: '..o...o...o...o.' },
  'lam phloen': { klong: '..o..o..o.o..o..', slap: '.......-.......o', kick: 'x..x..x...x..x..', snare: '....x.......x..-', ching: '..x...x...x...x.', chap: 'o...o...o...o...' },
  'classic': { klong: 'x...-.o.o...-.-.', slap: '................', kick: '................', snare: '................', ching: '......x.......x.', chap: '..o.......o.....' },
  'empty': {},
};
const VEL = { '.': 0, '-': 0.4, 'o': 0.7, 'x': 1 };

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
    this.fx = { keys: Object.assign({}, FX_DEFAULTS.keys), drums: Object.assign({}, FX_DEFAULTS.drums) };
    this.drums = {
      steps: 16, swing: 0, preset: 'lam sing',
      tracks: DRUM_TRACKS.map(() => ({ level: 0.8, tune: 0, decay: 1, mute: false, pattern: new Float32Array(16) })),
    };
    this.loadPreset('lam sing');
    this._playhead = []; // [audio time, step] pairs for the UI
    this.drumOn = true;
    this.recording = false;

    // Manual send matrices (the signal network), row-major [source*6 + channel];
    // channels: DRY · REV A · DLY A · REV B · DLY B · MOD
    this.route = {
      keys: new Float32Array([
        0.9, 0.3, 0.2, 0.1, 0.1, 0.4, // khaen
        0.7, 0.5, 0.3, 0.2, 0.2, 0.0, // phin
        0.5, 0.4, 0.6, 0.2, 0.3, 0.2, // so
        0.9, 0.2, 0.0, 0.1, 0.0, 0.0, // klong
      ]),
      drums: new Float32Array([
        0.9, 0.3, 0.0, 0.0, 0.0, 0.0, // klong
        0.9, 0.4, 0.2, 0.0, 0.0, 0.0, // slap
        1.0, 0.1, 0.0, 0.0, 0.0, 0.0, // kick
        0.9, 0.3, 0.0, 0.5, 0.0, 0.0, // snare
        0.8, 0.4, 0.3, 0.0, 0.0, 0.0, // ching
        0.8, 0.2, 0.0, 0.0, 0.0, 0.0, // chap
      ]),
    };
    // effective sends (keys blend in the qubit router with CHAOS)
    this.sends = { keys: new Float32Array(24), drums: new Float32Array(36) };
    this._sent = { keys: new Float32Array(24).fill(-1), drums: new Float32Array(36).fill(-1) };

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

  loadPreset(name) {
    const p = DRUM_PRESETS[name];
    if (!p) return;
    this.drums.preset = name;
    DRUM_TRACKS.forEach((t, i) => {
      const str = p[t.id] || '';
      for (let k = 0; k < 16; k++) this.drums.tracks[i].pattern[k] = VEL[str[k]] || 0;
    });
  }

  // Push the whole state into a freshly started synth.
  attach() {
    const s = this.synth;
    s.setMaster(this.master);
    for (const rig in this.fx) {
      for (const k in this.fx[rig]) s.setFx(rig, k, this.fx[rig][k]);
      s.setFx(rig, 'bpm', this.bpm);
      this._sent[rig].fill(-1);
    }
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
          case 'bpm': this.bpm = clamp(v, 30, 240); s.setFx('keys', 'bpm', this.bpm); s.setFx('drums', 'bpm', this.bpm); break;
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
      case 'fx': {
        const fx = this.fx[msg.rig];
        if (!fx || !(msg.path in fx)) return;
        fx[msg.path] = msg.value;
        s.setFx(msg.rig, msg.path, msg.value);
        break;
      }
      case 'drum': {
        const d = this.drums, t = d.tracks[msg.track];
        if (msg.op === 'cell' && t && msg.step >= 0 && msg.step < 16) t.pattern[msg.step] = clamp(msg.value, 0, 1);
        else if (msg.op === 'track' && t && msg.key in t && msg.key !== 'pattern') t[msg.key] = msg.value;
        else if (msg.op === 'steps') d.steps = clamp(msg.value | 0, 1, 16);
        else if (msg.op === 'swing') d.swing = clamp(msg.value, 0, 0.6);
        else if (msg.op === 'preset') this.loadPreset(msg.name);
        else if (msg.op === 'clear') d.tracks.forEach(tr => tr.pattern.fill(0));
        break;
      }
      case 'route': {
        const r = this.route[msg.rig], i = msg.src * CHANNELS.length + msg.ch;
        if (r && msg.ch >= 0 && msg.ch < CHANNELS.length && i >= 0 && i < r.length) r[i] = clamp(msg.value, 0, 1);
        break;
      }
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
    const nCh = CHANNELS.length;
    for (let i = 0; i < 24; i++) {
      const v = i / nCh | 0, c = i % nCh;
      // the qubit router drives the first four channels of the keys rig
      const q = c < 4 ? this.router.coeffs[v * 4 + c] * 4 : this.route.keys[i];
      this.sends.keys[i] = clamp(this.route.keys[i] * (1 - this.chaos) + q * this.chaos, 0, 1);
    }
    this.sends.drums.set(this.route.drums);
    const s = this.synth;
    if (!s.isInitialized) return;
    for (const rig of ['keys', 'drums']) {
      const cur = this.sends[rig], last = this._sent[rig];
      for (let i = 0; i < cur.length; i++) {
        if (Math.abs(cur[i] - last[i]) > 1e-4) { s.setSendLevel(rig, i / nCh | 0, i % nCh, cur[i]); last[i] = cur[i]; }
      }
    }
    this.chLevels = { keys: s.channelLevels('keys'), drums: s.channelLevels('drums') };
    this._scheduleDrums();
    const lvl = s.outputLevel();
    this.outLevel = Math.max(lvl, this.outLevel * 0.85);
  }

  _scheduleDrums() {
    const ctx = this.synth.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const d = this.drums;
    const stepDur = 60 / this.bpm / 4; // sixteenth notes
    const now = ctx.currentTime;
    if (this._nextDrumTime < now) this._nextDrumTime = now + 0.05;
    while (this._nextDrumTime < now + 0.12) {
      const i = this._drumStep % d.steps;
      const t = this._nextDrumTime + (i % 2 ? d.swing * stepDur : 0); // swing delays the off-16ths
      if (this.drumOn) {
        d.tracks.forEach((tr, k) => {
          const v = tr.pattern[i];
          if (v > 0 && !tr.mute) this.synth.drum(DRUM_TRACKS[k].id, v * tr.level, t, { tune: tr.tune, decay: tr.decay, root: this.root });
        });
        this._playhead.push([t, i]);
      }
      this._drumStep = (this._drumStep + 1) % d.steps;
      this._nextDrumTime += stepDur;
    }
  }

  // Step currently sounding (for the sequencer's playhead), or -1.
  drumStepNow() {
    const ctx = this.synth.ctx;
    if (!ctx || !this.drumOn) { this._playhead.length = 0; return -1; }
    const now = ctx.currentTime;
    while (this._playhead.length > 1 && this._playhead[1][0] <= now) this._playhead.shift();
    return this._playhead.length && this._playhead[0][0] <= now ? this._playhead[0][1] : -1;
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
      sends: Array.from(this.sends.keys),
      ch_levels: this.chLevels || null,
      drum_step: this.drumStepNow(),
      liss_a: 1 + 4 * (q[0] + q[5] + q[10] + q[15]),
      liss_b: 1 + 4 * (q[1] + q[4] + q[11] + q[14]),
      liss_c: 1 + 4 * (q[2] + q[7] + q[8] + q[13]),
    };
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

window.LocalEngine = LocalEngine;
window.DRUM_TRACKS = DRUM_TRACKS;
window.DRUM_PRESETS = DRUM_PRESETS;
