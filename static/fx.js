// morlam FX rig — everything after the voices, all hand-controlled.
//
//   voice ─► GAIN (input · drive · clip) ─► AMP (tone stack · level)   ×4, one per voice
//         ─► send matrix (4 voices × 4 channels)
//         ─► parallel W-D-W mixer:  WET L (reverb) · DRY · WET R (delay) · MOD
//              each channel: 100% wet/dry processing → fader → pan → mute/solo
//         ─► IR SIM (cabinet / room impulse response, dry ⇄ wet) ─► master
//
// Parameters are addressed by path ("amp.bass", "ch.2.pan", …) through
// FxRig.set(path, value); FX_DEFAULTS holds the starting rig.

const FX_DEFAULTS = {
  'gain.on': true, 'gain.input': 0, 'gain.drive': 0.2, 'gain.clip': 'soft',
  'amp.on': true, 'amp.bass': 0, 'amp.mid': 0, 'amp.treble': 0, 'amp.presence': 0, 'amp.level': 0.8,
  'mod.on': true, 'mod.type': 'chorus', 'mod.rate': 0.8, 'mod.depth': 0.5, 'mod.feedback': 0.3,
  'rev.size': 2.6, 'rev.decay': 2.2, 'rev.predelay': 20, 'rev.tone': 6000,
  'dly.time': 360, 'dly.sync': true, 'dly.feedback': 0.4, 'dly.tone': 3200,
  // channels: 0 DRY · 1 WET L · 2 WET R · 3 MOD
  'ch.0.level': 0.9, 'ch.0.pan': 0, 'ch.0.mute': false, 'ch.0.solo': false,
  'ch.1.level': 0.7, 'ch.1.pan': -0.6, 'ch.1.mute': false, 'ch.1.solo': false,
  'ch.2.level': 0.6, 'ch.2.pan': 0.6, 'ch.2.mute': false, 'ch.2.solo': false,
  'ch.3.level': 0.5, 'ch.3.pan': 0, 'ch.3.mute': false, 'ch.3.solo': false,
  'ir.type': 'room', 'ir.mix': 0.3, 'ir.level': 1,
  'bpm': 126,
};
const CHANNEL_NAMES = ['DRY', 'WET L', 'WET R', 'MOD'];

const db2g = db => Math.pow(10, db / 20);

// ---------------------------------------------------------------------------
// Offline DSP helpers for building impulse responses
// ---------------------------------------------------------------------------

// RBJ biquad, run over a Float32Array in place.
function biquad(data, sr, type, f0, q = 0.707, gainDb = 0) {
  const w = 2 * Math.PI * Math.min(f0, sr * 0.45) / sr, cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else { // peaking
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; data[i] = y;
  }
}

function noiseTail(len, sr, decaySec, delaySamples = 0) {
  const d = new Float32Array(len);
  for (let i = delaySamples; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.exp(-(i - delaySamples) / (sr * decaySec));
  }
  return d;
}

// Speaker-cabinet IR: a few ms of shaped burst, voiced by filters.
function cabIR(sr, voicing) {
  const len = Math.floor(sr * 0.05);
  const d = noiseTail(len, sr, voicing.tau);
  d[0] += 1;
  if (voicing.pair) { // second speaker slightly behind the first → gentle comb
    const off = Math.floor(sr * 0.00025);
    for (let i = len - 1; i >= off; i--) d[i] += 0.7 * d[i - off];
  }
  biquad(d, sr, 'highpass', voicing.hp, 0.9);
  biquad(d, sr, 'peaking', voicing.low, 1.2, voicing.lowGain);
  biquad(d, sr, 'peaking', voicing.scoop, 0.9, voicing.scoopGain);
  biquad(d, sr, 'peaking', voicing.bite, 1.4, voicing.biteGain);
  biquad(d, sr, 'lowpass', voicing.lp, 0.8);
  biquad(d, sr, 'lowpass', voicing.lp * 1.1, 0.7);
  return [d, d.slice()];
}

// Room-style IR: early reflections + decaying diffuse tail, per channel.
function spaceIR(sr, o) {
  const len = Math.floor(sr * o.length);
  const pre = Math.floor(sr * (o.predelay || 0));
  return [0, 1].map(() => {
    const d = noiseTail(len, sr, o.decay, pre);
    for (let k = 0; k < (o.early || 0); k++) {
      const at = pre + Math.floor(sr * (0.004 + Math.random() * o.earlySpread));
      if (at < len) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.9 - k * 0.07);
    }
    if (o.comb) { // spring "drip": recirculating echoes
      const D = Math.floor(sr * o.comb);
      for (let i = D; i < len; i++) d[i] += 0.55 * d[i - D];
      biquad(d, sr, 'bandpass', 1600, 0.5);
    }
    if (o.hp) biquad(d, sr, 'highpass', o.hp, 0.7);
    biquad(d, sr, 'lowpass', o.lp, 0.7);
    return d;
  });
}

const IR_TYPES = {
  off:    { name: 'OFF' },
  cab112: { name: 'CAB 1×12', make: sr => cabIR(sr, { tau: 0.0025, hp: 90, low: 140, lowGain: 3, scoop: 900, scoopGain: -2, bite: 2400, biteGain: 5, lp: 5200 }) },
  cab212: { name: 'CAB 2×12', make: sr => cabIR(sr, { tau: 0.003, pair: true, hp: 80, low: 120, lowGain: 4, scoop: 750, scoopGain: -3, bite: 2000, biteGain: 4, lp: 4800 }) },
  cab412: { name: 'CAB 4×12', make: sr => cabIR(sr, { tau: 0.005, pair: true, hp: 70, low: 100, lowGain: 6, scoop: 600, scoopGain: -4, bite: 1800, biteGain: 3, lp: 4000 }) },
  room:   { name: 'SMALL ROOM', make: sr => spaceIR(sr, { length: 0.7, decay: 0.16, early: 8, earlySpread: 0.03, lp: 7000 }) },
  hall:   { name: 'HALL', make: sr => spaceIR(sr, { length: 3.2, decay: 0.9, predelay: 0.025, early: 6, earlySpread: 0.06, lp: 5000 }) },
  plate:  { name: 'PLATE', make: sr => spaceIR(sr, { length: 2.0, decay: 0.55, hp: 220, lp: 9000 }) },
  spring: { name: 'SPRING', make: sr => spaceIR(sr, { length: 2.0, decay: 0.45, comb: 0.031, hp: 250, lp: 4500 }) },
  file:   { name: 'LOADED FILE' },
};

function toBuffer(ctx, chans) {
  const buf = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((d, i) => buf.getChannelData(i).set(d));
  return buf;
}

function clipCurve(type, drive) {
  const n = 2048, c = new Float32Array(n);
  const k = 0.05 + 30 * drive * drive;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    let y;
    if (type === 'hard') y = Math.max(-1, Math.min(1, k * x)) / Math.min(1, k);
    else if (type === 'fuzz') {
      // asymmetric: positive half saturates hard, negative half softer
      y = x >= 0 ? (1 - Math.exp(-k * x)) / (1 - Math.exp(-k)) : -0.8 * (1 - Math.exp(k * x)) / (1 - Math.exp(-k));
    } else y = Math.tanh(k * x) / Math.tanh(k);
    c[i] = y;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Per-voice insert: GAIN → AMP
// ---------------------------------------------------------------------------
class AmpChain {
  constructor(ctx) {
    this.input = ctx.createGain();
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = '4x';
    this.makeup = ctx.createGain();
    const eq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    this.bass = eq('lowshelf', 120);
    this.mid = eq('peaking', 750, 0.8);
    this.treble = eq('highshelf', 3200);
    this.presence = eq('peaking', 5200, 1.2);
    this.output = ctx.createGain();
    this.input.connect(this.shaper); this.shaper.connect(this.makeup);
    this.makeup.connect(this.bass); this.bass.connect(this.mid); this.mid.connect(this.treble);
    this.treble.connect(this.presence); this.presence.connect(this.output);
  }
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------
class FxRig {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.p = Object.assign({}, FX_DEFAULTS);
    this.amps = [0, 1, 2, 3].map(() => new AmpChain(ctx));
    this._levelBuf = new Float32Array(512);

    // ---- channel inputs (targets of the send matrix) ----
    this.inputs = [0, 1, 2, 3].map(() => ctx.createGain());
    const mix = ctx.createGain();

    // ---- channel processing (100% wet; the DRY channel is untouched) ----
    const proc = [];
    proc[0] = this.inputs[0];

    // WET L — reverb: pre-delay → convolver → tone
    this.revPre = ctx.createDelay(0.5);
    this.revConv = ctx.createConvolver();
    this.revTone = ctx.createBiquadFilter(); this.revTone.type = 'lowpass';
    this.inputs[1].connect(this.revPre); this.revPre.connect(this.revConv); this.revConv.connect(this.revTone);
    proc[1] = this.revTone;

    // WET R — delay with tone filter in the feedback loop
    this.dly = ctx.createDelay(2.0);
    this.dlyFb = ctx.createGain();
    this.dlyTone = ctx.createBiquadFilter(); this.dlyTone.type = 'lowpass';
    this.inputs[2].connect(this.dly); this.dly.connect(this.dlyTone);
    this.dlyTone.connect(this.dlyFb); this.dlyFb.connect(this.dly);
    proc[2] = this.dlyTone;

    // MOD — chorus / flanger (modulated delay) or phaser (allpass sweep)
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.8; this.lfo.start();
    this.modDelay = ctx.createDelay(0.1);
    this.modDelayLfo = ctx.createGain();
    this.modDelayFb = ctx.createGain();
    this.modDelayOut = ctx.createGain();
    this.lfo.connect(this.modDelayLfo); this.modDelayLfo.connect(this.modDelay.delayTime);
    this.inputs[3].connect(this.modDelay); this.modDelay.connect(this.modDelayFb); this.modDelayFb.connect(this.modDelay);
    this.modDelay.connect(this.modDelayOut);

    this.phaseLfo = ctx.createGain();
    this.lfo.connect(this.phaseLfo);
    this.allpass = [0, 1, 2, 3].map(() => {
      const a = ctx.createBiquadFilter(); a.type = 'allpass'; a.frequency.value = 800; a.Q.value = 0.6;
      this.phaseLfo.connect(a.frequency);
      return a;
    });
    this.phaseFb = ctx.createGain();
    const phaseLoop = ctx.createDelay(0.01); // a loop needs a delay node
    this.phaseOut = ctx.createGain();
    this.inputs[3].connect(this.allpass[0]);
    for (let i = 0; i < 3; i++) this.allpass[i].connect(this.allpass[i + 1]);
    this.allpass[3].connect(this.phaseOut);
    this.allpass[3].connect(this.phaseFb); this.phaseFb.connect(phaseLoop); phaseLoop.connect(this.allpass[0]);

    this.modOn = ctx.createGain();
    this.modDelayOut.connect(this.modOn); this.phaseOut.connect(this.modOn);
    proc[3] = this.modOn;

    // ---- channel strips: fader → pan → mute → (meter) → mix ----
    this.strips = proc.map(src => {
      const fader = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const mute = ctx.createGain();
      const meter = ctx.createAnalyser(); meter.fftSize = 512;
      src.connect(fader);
      if (pan) { fader.connect(pan); pan.connect(mute); } else fader.connect(mute);
      mute.connect(mix); mute.connect(meter);
      return { fader, pan, mute, meter };
    });

    // ---- IR SIM: mix → (dry | convolver) → level → destination ----
    this.irDry = ctx.createGain();
    this.irConv = ctx.createConvolver();
    this.irWet = ctx.createGain();
    this.irOut = ctx.createGain();
    mix.connect(this.irDry); mix.connect(this.irConv); this.irConv.connect(this.irWet);
    this.irDry.connect(this.irOut); this.irWet.connect(this.irOut);
    this.irOut.connect(destination);
    this.irFileBuffer = null;
    this.irFileName = '';

    // one call per section applies the whole default rig
    for (const k of ['gain.on', 'amp.on', 'mod.on', 'rev.size', 'dly.time', 'ch.0.level', 'ir.type']) this.set(k, this.p[k], true);
  }

  // Patchbay send v → channel b is wired by the synth: amps[v].output → send → inputs[b]

  set(path, value, initial = false) {
    this.p[path] = value;
    const P = this.p, t = this.ctx.currentTime;
    const ramp = (param, v, tc = 0.03) => initial ? (param.value = v) : param.setTargetAtTime(v, t, tc);
    const [group, a] = path.split('.');

    if (group === 'gain') {
      const on = P['gain.on'];
      const pre = on ? db2g(P['gain.input']) : 1;
      for (const amp of this.amps) {
        ramp(amp.input.gain, pre);
        amp.shaper.curve = on ? clipCurve(P['gain.clip'], P['gain.drive']) : null;
        ramp(amp.makeup.gain, 1 / Math.sqrt(pre)); // keep loudness roughly steady as input rises
      }
    } else if (group === 'amp') {
      const on = P['amp.on'];
      for (const amp of this.amps) {
        ramp(amp.bass.gain, on ? P['amp.bass'] : 0);
        ramp(amp.mid.gain, on ? P['amp.mid'] : 0);
        ramp(amp.treble.gain, on ? P['amp.treble'] : 0);
        ramp(amp.presence.gain, on ? P['amp.presence'] : 0);
        ramp(amp.output.gain, on ? P['amp.level'] : 1);
      }
    } else if (group === 'mod') {
      const type = P['mod.type'], depth = P['mod.depth'], fb = P['mod.feedback'];
      ramp(this.lfo.frequency, P['mod.rate'], 0.05);
      const isPhaser = type === 'phaser', isFlanger = type === 'flanger';
      const base = isFlanger ? 0.003 : 0.018, swing = isFlanger ? 0.0025 * depth : 0.008 * depth;
      ramp(this.modDelay.delayTime, base, 0.05);
      ramp(this.modDelayLfo.gain, swing, 0.05);
      ramp(this.modDelayFb.gain, isFlanger ? fb * 0.95 : fb * 0.35);
      ramp(this.phaseLfo.gain, 200 + 1200 * depth, 0.05);
      ramp(this.phaseFb.gain, fb * 0.7);
      ramp(this.modDelayOut.gain, isPhaser ? 0 : 1);
      ramp(this.phaseOut.gain, isPhaser ? 1 : 0);
      ramp(this.modOn.gain, P['mod.on'] ? 1 : 0);
    } else if (group === 'rev') {
      ramp(this.revPre.delayTime, P['rev.predelay'] / 1000, 0.05);
      ramp(this.revTone.frequency, P['rev.tone'], 0.05);
      if (a === 'size' || a === 'decay' || initial) this._rebuildReverb(initial);
    } else if (group === 'dly' || group === 'bpm') {
      const time = P['dly.sync'] ? Math.min(1.5, 0.75 * 60 / P['bpm']) : P['dly.time'] / 1000; // sync = dotted 8th
      ramp(this.dly.delayTime, time, 0.08);
      ramp(this.dlyFb.gain, Math.min(0.92, P['dly.feedback']));
      ramp(this.dlyTone.frequency, P['dly.tone'], 0.05);
    } else if (group === 'ch') {
      const anySolo = [0, 1, 2, 3].some(i => P[`ch.${i}.solo`]);
      this.strips.forEach((s, i) => {
        ramp(s.fader.gain, P[`ch.${i}.level`]);
        if (s.pan) ramp(s.pan.pan, P[`ch.${i}.pan`]);
        const audible = !P[`ch.${i}.mute`] && (!anySolo || P[`ch.${i}.solo`]);
        ramp(s.mute.gain, audible ? 1 : 0, 0.01);
      });
    } else if (group === 'ir') {
      if (a === 'type' || initial) this._loadIR(P['ir.type']);
      const on = P['ir.type'] !== 'off' && (P['ir.type'] !== 'file' || this.irFileBuffer);
      const m = on ? P['ir.mix'] : 0;
      ramp(this.irDry.gain, Math.cos(m * Math.PI / 2));
      ramp(this.irWet.gain, Math.sin(m * Math.PI / 2));
      ramp(this.irOut.gain, P['ir.level']);
    }
  }

  _rebuildReverb(now) {
    clearTimeout(this._revTimer);
    const build = () => {
      const sr = this.ctx.sampleRate, size = this.p['rev.size'], decay = this.p['rev.decay'];
      const len = Math.floor(sr * size);
      const chans = [0, 1].map(() => {
        const d = new Float32Array(len);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        return d;
      });
      this.revConv.buffer = toBuffer(this.ctx, chans);
    };
    if (now) build(); else this._revTimer = setTimeout(build, 120); // debounce knob drags
  }

  _loadIR(type) {
    if (type === 'file') { if (this.irFileBuffer) this.irConv.buffer = this.irFileBuffer; return; }
    const spec = IR_TYPES[type];
    if (spec && spec.make) this.irConv.buffer = toBuffer(this.ctx, spec.make(this.ctx.sampleRate));
  }

  // Load a user impulse response (WAV/AIFF/…) and switch the IR stage to it.
  async loadIRFile(file) {
    const data = await file.arrayBuffer();
    const buf = await new Promise((res, rej) => {
      const p = this.ctx.decodeAudioData(data, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    this.irFileBuffer = buf;
    this.irFileName = file.name;
    this.set('ir.type', 'file');
  }

  // RMS per channel strip, 0..1
  channelLevels() {
    const b = this._levelBuf;
    return this.strips.map(s => {
      s.meter.getFloatTimeDomainData(b);
      let sum = 0; for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
      return Math.sqrt(sum / b.length);
    });
  }
}

window.FxRig = FxRig;
window.FX_DEFAULTS = FX_DEFAULTS;
window.IR_TYPES = IR_TYPES;
window.CHANNEL_NAMES = CHANNEL_NAMES;
