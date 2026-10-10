// morlam Web Audio synth engine
// Four mor lam voices (khaen, phin, so, klong) and a six-track drum kit, each
// with its own FX rig (fx.js): the voices feed the KEYS rig, the drum tracks
// feed the DRUMS rig. Both rigs end in the shared master bus.

class MorlamSynth {
  constructor() {
    this.ctx = null;
    this.audioContext = null;
    this.masterGain = null;
    this.analyser = null;
    this.recordDest = null;
    this.voices = [null, null, null, null];
    this.rigs = null;               // { keys: FxRig, drums: FxRig }
    this.isInitialized = false;
    this._levelBuf = null;
  }

  async init() {
    if (this.isInitialized) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio not supported');
    // iOS 17+: play through the ringer/silent switch like a media app
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    this.ctx = this.audioContext = ctx;

    // Unlock while still inside the user's tap, before the (heavier) graph
    // build: resume, and start a one-sample silent buffer (old iOS needs it).
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    blip.connect(ctx.destination); blip.start(0);

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

    this.rigs = {
      keys: new FxRig(ctx, this.masterGain, 'keys', 4),
      drums: new FxRig(ctx, this.masterGain, 'drums', DRUM_KINDS.length),
    };

    const voiceClasses = [KhaenVoice, PhinVoice, SoVoice, KlongVoice];
    for (let v = 0; v < 4; v++) {
      const out = ctx.createGain();
      out.gain.value = 0.6;
      out.connect(this.rigs.keys.inputs[v]);
      this.voices[v] = new voiceClasses[v](ctx, out);
    }
    this.drums = new DrumKit(ctx, this.rigs.drums.inputs.map(inp => {
      const g = ctx.createGain(); g.gain.value = 0.6; g.connect(inp); return g;
    }));

    this.isInitialized = true;
  }

  _ramp(param, value, tc = 0.03) {
    if (!this.isInitialized) return;
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  noteOn(voice, hz, velocity = 1) { if (this.isInitialized) this.voices[voice]?.noteOn(hz, velocity); }
  noteOff(voice) { if (this.isInitialized) this.voices[voice]?.noteOff(); }
  setPitch(voice, hz) { if (this.isInitialized) this.voices[voice]?.setPitch(hz); }
  setDrone(hz) { if (this.isInitialized) this.voices[0]?.setDrone(hz); }

  // Drum machine hit: kind ∈ DrumKit sounds, `opt` = { tune (semitones), decay (×), root (Hz) }.
  drum(kind, vel, when, opt) { if (this.isInitialized) this.drums.hit(kind, vel, when, opt); }
  setMaster(level) { if (this.masterGain) this._ramp(this.masterGain.gain, level, 0.05); }
  setSendLevel(rig, src, ch, level) { if (this.rigs) this.rigs[rig].setSend(src, ch, level); }
  setFx(rig, path, value) { if (this.rigs) this.rigs[rig].set(path, value); }
  loadIRFile(rig, file) { return this.rigs ? this.rigs[rig].loadIRFile(file) : Promise.reject(new Error('audio not started')); }
  channelLevels(rig) { return this.rigs ? this.rigs[rig].channelLevels() : CHANNELS.map(() => 0); }
  eqResponse(rig, freqs) { return this.rigs ? this.rigs[rig].eqResponse(freqs) : null; }

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

// khaen — bamboo free-reed mouth organ. Reeds are rich in odd harmonics
// (square + saw through a resonant lowpass); the player's breath pulses the
// tone. Two drone pipes hold the lai's tonic and fifth under the melody.
class KhaenVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'square';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.detune.value = 6;
    const m1 = ctx.createGain(); m1.gain.value = 0.55;
    const m2 = ctx.createGain(); m2.gain.value = 0.35;
    this.drone = ctx.createOscillator(); this.drone.type = 'square';
    this.drone5 = ctx.createOscillator(); this.drone5.type = 'sawtooth';
    const dg = ctx.createGain(); dg.gain.value = 0.22;
    const dg5 = ctx.createGain(); dg5.gain.value = 0.12;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 2200; this.lp.Q.value = 2.5;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 1500; body.Q.value = 2; body.gain.value = 5;
    // breath pulse: ~6 Hz tremolo
    const trem = ctx.createOscillator(); trem.frequency.value = 6.2;
    const tremDepth = ctx.createGain(); tremDepth.gain.value = 0.18;
    const tremGain = ctx.createGain(); tremGain.gain.value = 0.82;
    trem.connect(tremDepth); tremDepth.connect(tremGain.gain);
    this.env = ctx.createGain(); this.env.gain.value = 0;
    const lvl = ctx.createGain(); lvl.gain.value = 0.32;
    this.osc.connect(m1); this.osc2.connect(m2);
    this.drone.connect(dg); this.drone5.connect(dg5);
    for (const n of [m1, m2, dg, dg5]) n.connect(this.lp);
    this.lp.connect(body); body.connect(tremGain); tremGain.connect(this.env);
    this.env.connect(lvl); lvl.connect(output);
    this.setDrone(110);
    for (const o of [this.osc, this.osc2, this.drone, this.drone5, trem]) o.start();
  }
  setDrone(hz) {
    const t = this.ctx.currentTime;
    this.drone.frequency.setTargetAtTime(hz, t, 0.05);
    this.drone5.frequency.setTargetAtTime(hz * 1.5, t, 0.05);
  }
  setPitch(hz) {
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(hz, t, 0.012);
    this.osc2.frequency.setTargetAtTime(hz, t, 0.012);
  }
  noteOn(hz, vel) {
    if (hz) this.setPitch(hz);
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(vel, t, 0.025);
  }
  noteOff() {
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.12);
  }
}

// phin — fretted lute, played amplified in modern mor lam: a bright pluck
// with a fast filter decay, pushed into a little overdrive.
class PhinVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'triangle'; this.osc2.detune.value = 1200; // octave course
    const mix2 = ctx.createGain(); mix2.gain.value = 0.25;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 600; this.lp.Q.value = 6;
    const drive = ctx.createWaveShaper(); drive.curve = softClip(3);
    this.env = ctx.createGain(); this.env.gain.value = 0;
    const lvl = ctx.createGain(); lvl.gain.value = 0.4;
    this.osc.connect(this.lp); this.osc2.connect(mix2); mix2.connect(this.lp);
    this.lp.connect(this.env); this.env.connect(drive); drive.connect(lvl); lvl.connect(output);
    this.osc.start(); this.osc2.start();
  }
  setPitch(hz) {
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(hz, t, 0.004);
    this.osc2.frequency.setTargetAtTime(hz, t, 0.004);
  }
  noteOn(hz, vel) {
    const t = this.ctx.currentTime;
    if (hz) { this.osc.frequency.setValueAtTime(hz, t); this.osc2.frequency.setValueAtTime(hz, t); }
    const g = this.env.gain, f = this.lp.frequency;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.9 * vel, t + 0.003);
    g.setTargetAtTime(0, t + 0.003, 0.32);
    f.cancelScheduledValues(t); f.setValueAtTime(7000, t);
    f.setTargetAtTime(700, t, 0.09);
  }
  noteOff() { this.env.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15); }
}

// so — two-string coconut-shell fiddle: detuned saws, wide vibrato,
// a nasal shell resonance.
class SoVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.detune.value = 11;
    const vib = ctx.createOscillator(); vib.frequency.value = 6.0;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 18; // cents
    vib.connect(vibDepth); vibDepth.connect(this.osc.detune); vibDepth.connect(this.osc2.detune);
    const shell = ctx.createBiquadFilter(); shell.type = 'peaking'; shell.frequency.value = 1300; shell.Q.value = 4; shell.gain.value = 10;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 1;
    this.env = ctx.createGain(); this.env.gain.value = 0;
    const lvl = ctx.createGain(); lvl.gain.value = 0.3;
    this.osc.connect(shell); this.osc2.connect(shell); shell.connect(lp); lp.connect(this.env);
    this.env.connect(lvl); lvl.connect(output);
    this.osc.start(); this.osc2.start(); vib.start();
  }
  setPitch(hz) {
    const t = this.ctx.currentTime, f = hz * 2; // fiddle sits an octave up
    this.osc.frequency.setTargetAtTime(f, t, 0.04);
    this.osc2.frequency.setTargetAtTime(f, t, 0.04);
  }
  noteOn(hz, vel) {
    if (hz) this.setPitch(hz);
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(vel, t, 0.05);
  }
  noteOff() {
    const t = this.ctx.currentTime, g = this.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.3);
  }
}

// klong — barrel drum: pitch-dropping body thump + a skin slap.
// Each hit spawns short-lived nodes so overlapping hits ring out naturally.
class KlongVoice {
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
    o.frequency.setValueAtTime(base * 2.6, t);
    o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.95 * vel, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(og); og.connect(this.output);
    o.start(t); o.stop(t + 0.42);

    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.45 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    n.connect(bp); bp.connect(ng); ng.connect(this.output);
    n.start(t); n.stop(t + 0.1);
  }
  noteOff() {}
}

// Drum machine sounds. Every hit builds short-lived nodes, so hits overlap
// and ring out naturally. Each sound has its own output (a source of the
// DRUMS rig), in DRUM_KINDS order.
const DRUM_KINDS = ['klong', 'slap', 'kick', 'snare', 'ching', 'chap'];
class DrumKit {
  constructor(ctx, outputs) {
    this.ctx = ctx; this.outs = outputs; this.output = outputs[0];
    this.noise = noiseBuffer(ctx, 1);
  }
  _env(t, peak, len) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    g.connect(this.output);
    return g;
  }
  _tone(t, type, f0, f1, sweep, peak, len) {
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    o.connect(this._env(t, peak, len)); o.start(t); o.stop(t + len + 0.02);
  }
  _noise(t, type, f, q, peak, len) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q;
    n.connect(b); b.connect(this._env(t, peak, len));
    n.start(t, Math.random() * 0.5); n.stop(t + len + 0.02);
  }
  hit(kind, vel, when, opt = {}) {
    const t = when ?? this.ctx.currentTime;
    this.output = this.outs[Math.max(0, DRUM_KINDS.indexOf(kind))];
    const tune = Math.pow(2, (opt.tune || 0) / 12), dec = opt.decay || 1;
    const root = Math.max(45, Math.min(160, (opt.root || 110) / 2)) * tune;
    switch (kind) {
      case 'klong': // barrel drum: pitch-dropping body + skin
        this._tone(t, 'sine', root * 2.6, root, 0.06, 0.95 * vel, 0.38 * dec);
        this._noise(t, 'bandpass', 2200, 1.1, 0.45 * vel, 0.08 * dec);
        break;
      case 'slap': // open-hand slap on the klong head
        this._tone(t, 'sine', root * 4, root * 1.5, 0.03, 0.5 * vel, 0.14 * dec);
        this._noise(t, 'bandpass', 3200 * tune, 1.4, 0.7 * vel, 0.1 * dec);
        break;
      case 'kick':
        this._tone(t, 'sine', 150 * tune, 46 * tune, 0.09, 1.0 * vel, 0.45 * dec);
        this._tone(t, 'triangle', 400 * tune, 120 * tune, 0.01, 0.3 * vel, 0.02);
        break;
      case 'snare':
        this._tone(t, 'triangle', 240 * tune, 180 * tune, 0.04, 0.5 * vel, 0.12 * dec);
        this._noise(t, 'highpass', 1500, 0.7, 0.6 * vel, 0.2 * dec);
        break;
      case 'ching': case 'chap': { // finger cymbals: inharmonic squares, open rings / closed is damped
        const open = kind === 'ching', len = (open ? 0.35 : 0.06) * dec;
        const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
        const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 9000; bp.Q.value = 0.7;
        hp.connect(bp); bp.connect(this._env(t, 0.18 * vel, len));
        for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
          const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = 410 * r * tune;
          o.connect(hp); o.start(t); o.stop(t + len + 0.02);
        }
        break;
      }
    }
  }
}

function softClip(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}

window.MorlamSynth = MorlamSynth;
