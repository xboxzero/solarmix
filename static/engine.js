// tezeta local engine — the browser-side twin of the Rust server.
//
// Holds the same parameter state, runs the 4-qubit tensor-product router,
// maps Lissajous touches to qenet-mode pitches, sequences the kebero groove
// and records the output. When no Pi is reachable (e.g. on GitHub Pages) it
// also produces the `tick` messages the UI would otherwise get over the WS.

const MODE_SCALES = {
  1: [0, 2, 4, 7, 9], // Tezeta:    C D E G A
  2: [0, 4, 5, 7, 11], // Bati:     C E F G B
  3: [0, 1, 5, 7, 8], // Ambassel:  C Db F G Ab
  4: [0, 1, 5, 6, 9], // Anchihoye: C Db F Gb A
};

// 6/8 kebero pattern (velocity per eighth note)
const KEBERO_PATTERN = [1.0, 0, 0.45, 0.8, 0, 0.5];

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
    this.root = 220;
    this.chaos = 0.25;
    this.reverbMix = 0.25;
    this.delayFb = 0.4;
    this.bpm = 88;
    this.drumOn = true;
    this.recording = false;

    // Default routing: krar → dry, masinko → reverb, washint → delay, kebero → dry
    this.route = new Float32Array(16);
    this.route[0] = 0.9; this.route[1] = 0.2;
    this.route[5] = 0.8; this.route[4] = 0.3;
    this.route[10] = 0.7; this.route[9] = 0.3;
    this.route[12] = 0.9; this.route[15] = 0.2;

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

  pitchFor(t, intensity) {
    const scale = MODE_SCALES[this.mode] || MODE_SCALES[1];
    const step = Math.min(scale.length - 1, Math.floor(Math.min(Math.max(t, 0), 0.999) * scale.length));
    const octave = Math.floor(Math.min(Math.max(intensity, 0), 1) * 2) - 1; // -1..+1
    return { step, hz: this.root * Math.pow(2, scale[step] / 12 + octave) };
  }

  handle(msg) {
    const s = this.synth;
    switch (msg.type) {
      case 'set': {
        const v = msg.value;
        switch (msg.id) {
          case 'master': this.master = clamp(v, 0, 1); s.setMaster(this.master); break;
          case 'chaos': this.chaos = clamp(v, 0, 1); break;
          case 'root': this.root = Math.max(20, v); break;
          case 'reverb_mix': this.reverbMix = clamp(v, 0, 1); s.setReverbMix(this.reverbMix); break;
          case 'delay_fb': this.delayFb = clamp(v, 0, 0.92); s.setDelayFeedback(this.delayFb); break;
          case 'bpm': this.bpm = clamp(v, 30, 240); s.setDelayTime(Math.min(1.5, 60 / this.bpm)); break;
        }
        break;
      }
      case 'toggle':
        if (msg.id === 'drum') this.drumOn = !this.drumOn;
        break;
      case 'mode':
        this.mode = clamp(msg.value | 0, 1, 4);
        break;
      case 'route':
        if (msg.voice < 4 && msg.bus < 4) this.route[msg.voice * 4 + msg.bus] = clamp(msg.value, 0, 1);
        break;
      case 'lissajous': {
        const v = msg.voice;
        if (!(v >= 0 && v < 4)) return;
        const { step, hz } = this.pitchFor(msg.t, msg.intensity);
        const plucked = v === 0 || v === 3;
        if (!this.gate[v] || (plucked && step !== this.note[v])) s.noteOn(v, hz, clamp(msg.intensity, 0.2, 1));
        else if (step !== this.note[v]) s.setPitch(v, hz);
        this.gate[v] = true;
        this.note[v] = step;
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
    const s = this.synth;
    if (!s.isInitialized) return;
    for (let i = 0; i < 16; i++) {
      const r = this.route[i] * (1 - this.chaos) + this.router.coeffs[i] * 4 * this.chaos;
      s.setSendLevel(i >> 2, i & 3, r);
    }
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
      const vel = KEBERO_PATTERN[this._drumStep % KEBERO_PATTERN.length];
      if (this.drumOn && vel > 0) {
        const pitch = this.root * (this._drumStep % 6 === 0 ? 1 : 1.5);
        this.synth.voices[3].noteOn(pitch, vel * 0.8, this._nextDrumTime);
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
      a.download = `tezeta-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
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

  // Same shape as the server's WS `tick` message.
  tick() {
    const q = Array.from(this.router.coeffs);
    return {
      type: 'tick',
      in_level: 0,
      out_level: this.outLevel,
      recording: this.recording,
      drum_on: this.drumOn,
      mode: this.mode,
      bpm: this.bpm,
      master: this.master,
      chaos: this.chaos,
      qcoef: q,
      liss_a: 1 + 4 * (q[0] + q[5] + q[10] + q[15]),
      liss_b: 1 + 4 * (q[1] + q[4] + q[11] + q[14]),
      liss_c: 1 + 4 * (q[2] + q[7] + q[8] + q[13]),
    };
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

window.LocalEngine = LocalEngine;
