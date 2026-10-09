// tezeta Web Audio synth engine
// Browser port of the four DSP voices (krar, masinko, washint, kebero) with
// the same 4×4 voice → bus patchbay as the Rust engine: DRY · REV · DLY · DARK.

class TezetaSynth {
  constructor() {
    this.ctx = null;
    this.audioContext = null;
    this.masterGain = null;
    this.analyser = null;
    this.recordDest = null;
    this.voices = [null, null, null, null];
    this.sendGains = [];            // 16 GainNodes, row-major [v*4 + b]
    this.revReturn = null;
    this.delay = null;
    this.delayFeedback = null;
    this.isInitialized = false;
    this._levelBuf = null;
  }

  async init() {
    if (this.isInitialized) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio not supported');
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = this.audioContext = ctx;

    // master → compressor → analyser → speakers (+ recorder tap)
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 4;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this._levelBuf = new Float32Array(this.analyser.fftSize);
    this.masterGain.connect(comp);
    comp.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) {
      this.recordDest = ctx.createMediaStreamDestination();
      comp.connect(this.recordDest);
    }

    // ---- buses ----
    const dry = ctx.createGain();
    dry.connect(this.masterGain);

    const rev = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(2.6, 2.2);
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 0.25 * 3;
    rev.connect(conv); conv.connect(this.revReturn); this.revReturn.connect(this.masterGain);

    const dly = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.36;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.4;
    const dlyTone = ctx.createBiquadFilter();
    dlyTone.type = 'lowpass'; dlyTone.frequency.value = 3200;
    dly.connect(this.delay);
    this.delay.connect(dlyTone);
    dlyTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    dlyTone.connect(this.masterGain);

    const dark = ctx.createGain();
    const darkLp = ctx.createBiquadFilter();
    darkLp.type = 'lowpass'; darkLp.frequency.value = 700; darkLp.Q.value = 2;
    const darkDrive = ctx.createWaveShaper();
    darkDrive.curve = this._softClip(2.5);
    dark.connect(darkDrive); darkDrive.connect(darkLp); darkLp.connect(this.masterGain);

    const buses = [dry, rev, dly, dark];

    // ---- voices, each fanned out to the 4 buses ----
    const voiceClasses = [KrarVoice, MasinkoVoice, WashintVoice, KeberoVoice];
    for (let v = 0; v < 4; v++) {
      const out = ctx.createGain();
      out.gain.value = 0.6;
      for (let b = 0; b < 4; b++) {
        const s = ctx.createGain();
        s.gain.value = 0;
        out.connect(s); s.connect(buses[b]);
        this.sendGains[v * 4 + b] = s;
      }
      this.voices[v] = new voiceClasses[v](ctx, out);
    }

    this.isInitialized = true;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _softClip(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  _ramp(param, value, tc = 0.03) {
    if (!this.isInitialized) return;
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  noteOn(voice, hz, velocity = 1) { if (this.isInitialized) this.voices[voice]?.noteOn(hz, velocity); }
  noteOff(voice) { if (this.isInitialized) this.voices[voice]?.noteOff(); }
  setPitch(voice, hz) { if (this.isInitialized) this.voices[voice]?.setPitch(hz); }
  setMaster(level) { if (this.masterGain) this._ramp(this.masterGain.gain, level, 0.05); }
  setSendLevel(voice, bus, level) { const g = this.sendGains[voice * 4 + bus]; if (g) this._ramp(g.gain, level, 0.05); }
  setReverbMix(mix) { if (this.revReturn) this._ramp(this.revReturn.gain, mix * 3, 0.05); }
  setDelayFeedback(fb) { if (this.delayFeedback) this._ramp(this.delayFeedback.gain, Math.min(0.92, fb), 0.05); }
  setDelayTime(sec) { if (this.delay) this._ramp(this.delay.delayTime, sec, 0.1); }

  // RMS of the master output, 0..1
  outputLevel() {
    if (!this.analyser) return 0;
    const b = this._levelBuf;
    if (this.analyser.getFloatTimeDomainData) this.analyser.getFloatTimeDomainData(b);
    let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  }

  // Resume audio on user interaction (required by browser autoplay policy)
  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }
}

// ============================================================================
// Voice generators
// ============================================================================

function noiseBuffer(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// krar — plucked lyre: bright saw + square through a decaying lowpass.
class KrarVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square'; this.osc2.detune.value = 7;
    const mix2 = ctx.createGain(); mix2.gain.value = 0.3;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 400; this.lp.Q.value = 4;
    this.env = ctx.createGain(); this.env.gain.value = 0;
    this.osc.connect(this.lp); this.osc2.connect(mix2); mix2.connect(this.lp);
    this.lp.connect(this.env); this.env.connect(output);
    this.osc.start(); this.osc2.start();
  }
  setPitch(hz) {
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(hz, t, 0.005);
    this.osc2.frequency.setTargetAtTime(hz, t, 0.005);
  }
  noteOn(hz, vel) {
    const t = this.ctx.currentTime;
    if (hz) { this.osc.frequency.setValueAtTime(hz, t); this.osc2.frequency.setValueAtTime(hz, t); }
    const g = this.env.gain, f = this.lp.frequency;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.5 * vel, t + 0.004);
    g.setTargetAtTime(0, t + 0.004, 0.45);
    f.cancelScheduledValues(t); f.setValueAtTime(5500, t);
    f.setTargetAtTime(500, t, 0.18);
  }
  noteOff() { this.env.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); }
}

// masinko — bowed single-string fiddle: detuned saws, vibrato, nasal body.
class MasinkoVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.detune.value = 9;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 14; // cents
    vib.connect(vibDepth); vibDepth.connect(this.osc.detune); vibDepth.connect(this.osc2.detune);
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 1100; body.Q.value = 3; body.gain.value = 9;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 1;
    this.env = ctx.createGain(); this.env.gain.value = 0;
    const lvl = ctx.createGain(); lvl.gain.value = 0.22;
    this.osc.connect(body); this.osc2.connect(body); body.connect(lp); lp.connect(this.env);
    this.env.connect(lvl); lvl.connect(output);
    this.osc.start(); this.osc2.start(); vib.start();
  }
  setPitch(hz) {
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(hz, t, 0.04);
    this.osc2.frequency.setTargetAtTime(hz, t, 0.04);
  }
  noteOn(hz, vel) {
    if (hz) this.setPitch(hz);
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(vel, t, 0.06);
  }
  noteOff() {
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.35);
  }
}

// washint — bamboo flute: soft triangle tone plus breath noise at the pitch.
class WashintVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'triangle';
    const vib = ctx.createOscillator(); vib.frequency.value = 4.8;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 10;
    vib.connect(vibDepth); vibDepth.connect(this.osc.detune);
    const noise = ctx.createBufferSource(); noise.buffer = noiseBuffer(ctx, 2); noise.loop = true;
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 880; this.bp.Q.value = 12;
    const breath = ctx.createGain(); breath.gain.value = 0.9;
    const tone = ctx.createGain(); tone.gain.value = 0.45;
    this.env = ctx.createGain(); this.env.gain.value = 0;
    this.osc.connect(tone); tone.connect(this.env);
    noise.connect(this.bp); this.bp.connect(breath); breath.connect(this.env);
    this.env.connect(output);
    this.osc.start(); vib.start(); noise.start();
  }
  setPitch(hz) {
    const t = this.ctx.currentTime, f = hz * 2; // flute sits an octave up
    this.osc.frequency.setTargetAtTime(f, t, 0.03);
    this.bp.frequency.setTargetAtTime(f, t, 0.03);
  }
  noteOn(hz, vel) {
    if (hz) this.setPitch(hz);
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0.6 * vel, t, 0.07);
  }
  noteOff() {
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.25);
  }
}

// kebero — hand drum: pitch-dropping sub thump + filtered noise slap.
// Each hit spawns short-lived nodes so overlapping hits ring out naturally.
class KeberoVoice {
  constructor(ctx, output) {
    this.ctx = ctx; this.output = output;
    this.noise = noiseBuffer(ctx, 0.5);
    this.pitch = 110;
  }
  setPitch(hz) { this.pitch = hz; }
  noteOn(hz, vel = 1, when) {
    const ctx = this.ctx, t = when ?? ctx.currentTime;
    const base = Math.max(45, Math.min(160, (hz || this.pitch) / 2));
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(base * 2.2, t);
    o.frequency.exponentialRampToValueAtTime(base, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.9 * vel, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(og); og.connect(this.output);
    o.start(t); o.stop(t + 0.5);

    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.5 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(bp); bp.connect(ng); ng.connect(this.output);
    n.start(t); n.stop(t + 0.15);
  }
  noteOff() {}
}

window.TezetaSynth = TezetaSynth;
