// morlam FX rigs — two independent, hand-controlled effect rigs:
//   KEYS   the four keyboard/globe voices (khaen, phin, so, klong)
//   DRUMS  the six drum-machine tracks
//
// One rig:
//
//   source ─► PRE-AMP EQ ─► AMP SIM ─► CAB SIM        (one chain per source)
//          ─► signal network: every source → every channel (send matrix)
//          ─► six parallel channels (wet · dry · wet):
//               REV A · DLY A │ DRY │ DLY B · REV B │ MOD
//               reverbs & delays each have a type, a phase shifter insert,
//               DRY has drive + compressor, MOD is chorus / flanger / phaser
//             plus FX → FX feeds (mod → delays/reverbs, delays → reverbs)
//          ─► each channel: fader → pan → mute/solo → mix
//          ─► IR SIM ─► rig level ─► master
//
// Parameters are addressed by path ("pre.lm", "da.type", "ch.2.pan", …)
// through FxRig.set(path, value); FX_DEFAULTS[kind] holds the starting rig.

const CHANNELS = ['dry', 'ra', 'da', 'rb', 'db', 'mod'];
const CHANNEL_NAMES = ['DRY', 'REV A', 'DLY A', 'REV B', 'DLY B', 'MOD'];
// FX → FX feeds allowed (acyclic): mod → delays/reverbs, delays → reverbs
const NET_FEEDS = [['mod', 'da'], ['mod', 'db'], ['mod', 'ra'], ['mod', 'rb'], ['da', 'ra'], ['da', 'rb'], ['db', 'ra'], ['db', 'rb']];

const AMP_MODELS = {
  clean:  { name: 'Clean',       hp: 40,  g1: [1, 4],    c1: 'soft', d1: 0.25, inter: 12000, g2: [1, 1], c2: null,   d2: 0,    mid: 500, bright: 3, low: 0, post: 12000, makeup: 0.85 },
  tube:   { name: 'Tube warm',   hp: 60,  g1: [1.5, 15], c1: 'tube', d1: 0.45, inter: 9000,  g2: [1, 1], c2: null,   d2: 0,    mid: 600, bright: 0, low: 1, post: 7000,  makeup: 0.45 },
  crunch: { name: 'Crunch',      hp: 90,  g1: [2, 25],   c1: 'soft', d1: 0.5,  inter: 7000,  g2: [1, 3], c2: 'hard', d2: 0.3,  mid: 800, bright: 2, low: 0, post: 7500,  makeup: 0.21 },
  lead:   { name: 'Lead (hi gain)', hp: 200, g1: [8, 80], c1: 'fuzz', d1: 0.8, inter: 6000,  g2: [2, 8], c2: 'soft', d2: 0.55, mid: 650, bright: 0, low: 0, post: 6500,  makeup: 0.2 },
  bass:   { name: 'Bass',        hp: 25,  g1: [1, 8],    c1: 'soft', d1: 0.3,  inter: 5000,  g2: [1, 1], c2: null,   d2: 0,    mid: 400, bright: 0, low: 4, post: 5000,  makeup: 0.55 },
  fuzz:   { name: 'Fuzz',        hp: 120, g1: [20, 200], c1: 'hard', d1: 1,    inter: 5000,  g2: [1, 2], c2: 'soft', d2: 0.6,  mid: 900, bright: 0, low: 0, post: 5000,  makeup: 0.2 },
};

const CAB_TYPES = {
  off:    { name: 'Off' },
  open:   { name: '1×12 open back', hp: 110, low: [160, 1], notch: [1200, -2], pres: [3000, 5], lp: 7000 },
  c112:   { name: '1×12 closed',    hp: 90,  low: [130, 3], notch: [1000, -3], pres: [2500, 4], lp: 5500 },
  c212:   { name: '2×12',           hp: 80,  low: [110, 4], notch: [800, -4],  pres: [2000, 3], lp: 5000 },
  c412:   { name: '4×12',           hp: 70,  low: [100, 6], notch: [650, -5],  pres: [1800, 3], lp: 4200 },
  bass15: { name: 'Bass 1×15',      hp: 40,  low: [70, 5],  notch: [500, -3],  pres: [1500, 2], lp: 3500 },
};

const REVERB_TYPES = {
  room:      { name: 'Room',      length: 0.8, decay: 0.18, early: 8, earlySpread: 0.03, lp: 7000 },
  chamber:   { name: 'Chamber',   length: 1.5, decay: 0.35, early: 10, earlySpread: 0.04, lp: 6500 },
  hall:      { name: 'Hall',      length: 3.0, decay: 0.9, predelay: 0.02, early: 6, earlySpread: 0.06, lp: 5000 },
  cathedral: { name: 'Cathedral', length: 6.0, decay: 2.2, predelay: 0.03, early: 4, earlySpread: 0.1, lp: 4000 },
  plate:     { name: 'Plate',     length: 2.0, decay: 0.55, hp: 220, lp: 9000 },
  spring:    { name: 'Spring',    length: 2.0, decay: 0.45, comb: 0.031, hp: 250, lp: 4500 },
  gated:     { name: 'Gated',     length: 0.45, decay: 5, gate: true, lp: 8000 },
  reverse:   { name: 'Reverse',   length: 1.6, decay: 0.5, reverse: true, lp: 7000 },
};

const DELAY_TYPES = {
  digital:  { name: 'Digital' },
  tape:     { name: 'Tape echo' },
  analog:   { name: 'Analog (BBD)' },
  pingpong: { name: 'Ping-pong' },
  multitap: { name: 'Multi-tap' },
  slapback: { name: 'Slapback' },
};
const DELAY_DIVS = { '1/2': 2, '1/4': 1, '3/16': 0.75, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25 };

function rigDefaults(kind) {
  const keys = kind === 'keys';
  const P = {
    'rig.level': 1,
    'pre.on': true, 'pre.input': 0, 'pre.hpf': 20, 'pre.lpf': 20000,
    'pre.lowF': 120, 'pre.low': 0, 'pre.lmF': 500, 'pre.lm': 0, 'pre.lmQ': 1,
    'pre.hmF': 2500, 'pre.hm': 0, 'pre.hmQ': 1, 'pre.highF': 6000, 'pre.high': 0,
    'amp.on': keys, 'amp.model': 'clean', 'amp.drive': 0.2,
    'amp.bass': 0, 'amp.mid': 0, 'amp.treble': 0, 'amp.presence': 0, 'amp.master': 0.8,
    'cab.type': 'off', 'cab.mic': 0,
    'mod.on': true, 'mod.type': 'chorus', 'mod.rate': 0.8, 'mod.depth': 0.5, 'mod.feedback': 0.3,
    'ra.type': keys ? 'room' : 'room', 'ra.size': 1, 'ra.decay': 1, 'ra.pre': 20, 'ra.tone': 6000, 'ra.lowcut': 80,
    'rb.type': keys ? 'plate' : 'gated', 'rb.size': 1, 'rb.decay': 1, 'rb.pre': 10, 'rb.tone': 8000, 'rb.lowcut': 150,
    'da.type': 'digital', 'da.time': 360, 'da.sync': true, 'da.div': '3/16', 'da.fdbk': 0.4, 'da.tone': 3200, 'da.mod': 0.2,
    'db.type': 'pingpong', 'db.time': 250, 'db.sync': true, 'db.div': '1/4', 'db.fdbk': 0.35, 'db.tone': 4000, 'db.mod': 0.2,
    'dry.mode': 'clean', 'dry.gain': 0.5, 'dry.tone': keys ? 6000 : 12000, 'dry.level': 1,
    'dry.comp': !keys, 'dry.thresh': -18, 'dry.ratio': 4,
    'ir.type': 'room', 'ir.mix': keys ? 0.3 : 0.2, 'ir.level': 1,
    'bpm': 126,
  };
  for (const ph of ['phra', 'phda', 'phrb', 'phdb']) {
    P[ph + '.on'] = keys && (ph === 'phra' || ph === 'phda');
    P[ph + '.rate'] = { phra: 0.3, phda: 0.37, phrb: 0.23, phdb: 0.31 }[ph];
    P[ph + '.depth'] = 0.6; P[ph + '.fdbk'] = 0.4; P[ph + '.mix'] = 0.5;
  }
  // channels: dry · rev A · dly A · rev B · dly B · mod
  const lv = keys ? [0.9, 0.6, 0.5, 0.3, 0.3, 0.5] : [0.9, 0.4, 0.2, 0.3, 0, 0];
  const pan = [0, -0.7, -0.4, 0.7, 0.4, 0];
  CHANNELS.forEach((_, i) => {
    P[`ch.${i}.level`] = lv[i]; P[`ch.${i}.pan`] = pan[i]; P[`ch.${i}.mute`] = false; P[`ch.${i}.solo`] = false;
  });
  for (const [a, b] of NET_FEEDS) P[`net.${a}.${b}`] = keys && a === 'da' && b === 'ra' ? 0.15 : 0;
  return P;
}
const FX_DEFAULTS = { keys: rigDefaults('keys'), drums: rigDefaults('drums') };

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
    if (o.gate) { // gated: hold, then slam shut over the last 8%
      const cut = Math.floor(len * 0.92);
      for (let i = cut; i < len; i++) d[i] *= 1 - (i - cut) / (len - cut);
    }
    if (o.reverse) d.reverse();
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
    } else if (type === 'tube') {
      // asymmetric soft clip: the negative half compresses earlier
      y = x >= 0 ? Math.tanh(k * x) / Math.tanh(k) : 0.85 * Math.tanh(1.6 * k * x) / Math.tanh(1.6 * k);
    } else y = Math.tanh(k * x) / Math.tanh(k);
    c[i] = y;
  }
  return c;
}


// ---------------------------------------------------------------------------
// Phase shifter insert: 6 allpass stages swept by an LFO, feedback, dry/wet.
// `invert` starts the LFO half a cycle later so two phasers sweep opposite.
// ---------------------------------------------------------------------------
class Phaser {
  constructor(ctx, invert = false) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    const lfoSign = ctx.createGain(); lfoSign.gain.value = invert ? -1 : 1;
    this.lfo.connect(lfoSign); lfoSign.connect(this.lfoGain);
    this.stages = [0, 1, 2, 3, 4, 5].map(() => {
      const a = ctx.createBiquadFilter(); a.type = 'allpass'; a.frequency.value = 900; a.Q.value = 0.5;
      this.lfoGain.connect(a.frequency);
      return a;
    });
    this.fb = ctx.createGain();
    const loop = ctx.createDelay(0.01);
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.stages[0]);
    for (let i = 0; i < 5; i++) this.stages[i].connect(this.stages[i + 1]);
    this.stages[5].connect(this.wet); this.wet.connect(this.output);
    this.stages[5].connect(this.fb); this.fb.connect(loop); loop.connect(this.stages[0]);
    this.lfo.start();
  }
  apply(on, rate, depth, fdbk, mix, ramp) {
    ramp(this.lfo.frequency, rate, 0.05);
    ramp(this.lfoGain.gain, 150 + 1300 * depth, 0.05);
    ramp(this.fb.gain, on ? fdbk * 0.75 : 0);
    const m = on ? mix : 0;
    ramp(this.dry.gain, 1 - m * 0.5);
    ramp(this.wet.gain, m);
  }
}

// ---------------------------------------------------------------------------
// DRY channel drive: CLEAN / LOW GAIN / HI GAIN, then a compressor.
//   in → tighten HP → stage 1 (gain → clip) → interstage LP
//      → stage 2 (gain → clip) → mid scoop → tone LP → makeup → comp
// ---------------------------------------------------------------------------
class DryDrive {
  constructor(ctx) {
    const f = (type, freq, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; if (q) b.Q.value = q; return b; };
    this.input = ctx.createGain();
    this.hp = f('highpass', 20, 0.7);
    this.pre1 = ctx.createGain();
    this.sh1 = ctx.createWaveShaper(); this.sh1.oversample = '4x';
    this.inter = f('lowpass', 20000, 0.7);
    this.pre2 = ctx.createGain();
    this.sh2 = ctx.createWaveShaper(); this.sh2.oversample = '4x';
    this.scoop = f('peaking', 650, 0.9);
    this.tone = f('lowpass', 6000, 0.7);
    this.makeup = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.attack.value = 0.005; this.comp.release.value = 0.15; this.comp.knee.value = 6;
    this.output = ctx.createGain();
    const chain = [this.input, this.hp, this.pre1, this.sh1, this.inter, this.pre2, this.sh2, this.scoop, this.tone, this.makeup, this.comp, this.output];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }
  apply(P, ramp) {
    const mode = P['dry.mode'], g = P['dry.gain'];
    if (mode === 'high') {
      ramp(this.hp.frequency, 260);
      ramp(this.pre1.gain, 4 + 50 * g);
      this.sh1.curve = clipCurve('fuzz', 0.8);
      ramp(this.inter.frequency, 6500);
      ramp(this.pre2.gain, 2 + 6 * g);
      this.sh2.curve = clipCurve('soft', 0.55);
      ramp(this.scoop.gain, -8);
      ramp(this.makeup.gain, 0.13);
    } else if (mode === 'low') {
      ramp(this.hp.frequency, 70);
      ramp(this.pre1.gain, 1 + 9 * g);
      this.sh1.curve = clipCurve('soft', 0.3);
      ramp(this.inter.frequency, 12000);
      ramp(this.pre2.gain, 1);
      this.sh2.curve = null;
      ramp(this.scoop.gain, 0);
      ramp(this.makeup.gain, 0.3 / Math.sqrt(1 + 9 * g));
    } else { // clean
      ramp(this.hp.frequency, 20);
      ramp(this.pre1.gain, 1); this.sh1.curve = null;
      ramp(this.inter.frequency, 20000);
      ramp(this.pre2.gain, 1); this.sh2.curve = null;
      ramp(this.scoop.gain, 0);
      ramp(this.makeup.gain, 1);
    }
    ramp(this.tone.frequency, P['dry.tone']);
    ramp(this.output.gain, P['dry.level']);
    const on = P['dry.comp'];
    ramp(this.comp.threshold, on ? P['dry.thresh'] : 0);
    ramp(this.comp.ratio, on ? P['dry.ratio'] : 1);
  }
}

const biq = (ctx, type, f, q, gain) => {
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
  if (q !== undefined) b.Q.value = q; if (gain !== undefined) b.gain.value = gain;
  return b;
};
function chain(nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); }

// ---------------------------------------------------------------------------
// Per-source chain: PRE-AMP EQ → AMP SIM → CAB SIM
// ---------------------------------------------------------------------------
class SourceChain {
  constructor(ctx) {
    this.input = ctx.createGain();
    // pre-amp EQ
    this.inGain = ctx.createGain();
    this.hpf = biq(ctx, 'highpass', 20, 0.707);
    this.low = biq(ctx, 'lowshelf', 120, undefined, 0);
    this.lm = biq(ctx, 'peaking', 500, 1, 0);
    this.hm = biq(ctx, 'peaking', 2500, 1, 0);
    this.high = biq(ctx, 'highshelf', 6000, undefined, 0);
    this.lpf = biq(ctx, 'lowpass', 20000, 0.707);
    // amp
    this.aHp = biq(ctx, 'highpass', 10, 0.7);
    this.aPre1 = ctx.createGain();
    this.sh1 = ctx.createWaveShaper(); this.sh1.oversample = '4x';
    this.aInter = biq(ctx, 'lowpass', 20000, 0.7);
    this.aPre2 = ctx.createGain();
    this.sh2 = ctx.createWaveShaper(); this.sh2.oversample = '4x';
    this.tBass = biq(ctx, 'lowshelf', 100, undefined, 0);
    this.tMid = biq(ctx, 'peaking', 600, 0.8, 0);
    this.tTreble = biq(ctx, 'highshelf', 2500, undefined, 0);
    this.tPres = biq(ctx, 'peaking', 4500, 1.2, 0);
    this.aPost = biq(ctx, 'lowpass', 20000, 0.7);
    this.aMakeup = ctx.createGain();
    this.aMaster = ctx.createGain();
    // cab
    this.cHp = biq(ctx, 'highpass', 10, 0.8);
    this.cLow = biq(ctx, 'peaking', 120, 1.2, 0);
    this.cNotch = biq(ctx, 'peaking', 800, 1, 0);
    this.cPres = biq(ctx, 'peaking', 2500, 1.4, 0);
    this.cLp1 = biq(ctx, 'lowpass', 20000, 0.8);
    this.cLp2 = biq(ctx, 'lowpass', 20000, 0.7);
    this.output = ctx.createGain();
    chain([this.input, this.inGain, this.hpf, this.low, this.lm, this.hm, this.high, this.lpf,
      this.aHp, this.aPre1, this.sh1, this.aInter, this.aPre2, this.sh2,
      this.tBass, this.tMid, this.tTreble, this.tPres, this.aPost, this.aMakeup, this.aMaster,
      this.cHp, this.cLow, this.cNotch, this.cPres, this.cLp1, this.cLp2, this.output]);
  }
  applyPre(P, ramp) {
    const on = P['pre.on'];
    ramp(this.inGain.gain, on ? db2g(P['pre.input']) : 1);
    ramp(this.hpf.frequency, on ? P['pre.hpf'] : 10);
    ramp(this.lpf.frequency, on ? P['pre.lpf'] : 22000);
    ramp(this.low.frequency, P['pre.lowF']); ramp(this.low.gain, on ? P['pre.low'] : 0);
    ramp(this.lm.frequency, P['pre.lmF']); ramp(this.lm.gain, on ? P['pre.lm'] : 0); ramp(this.lm.Q, P['pre.lmQ']);
    ramp(this.hm.frequency, P['pre.hmF']); ramp(this.hm.gain, on ? P['pre.hm'] : 0); ramp(this.hm.Q, P['pre.hmQ']);
    ramp(this.high.frequency, P['pre.highF']); ramp(this.high.gain, on ? P['pre.high'] : 0);
  }
  applyAmp(P, ramp) {
    const on = P['amp.on'], m = AMP_MODELS[P['amp.model']] || AMP_MODELS.clean, d = P['amp.drive'];
    if (!on) {
      ramp(this.aHp.frequency, 10); ramp(this.aPre1.gain, 1); this.sh1.curve = null;
      ramp(this.aInter.frequency, 20000); ramp(this.aPre2.gain, 1); this.sh2.curve = null;
      for (const f of [this.tBass, this.tMid, this.tTreble, this.tPres]) ramp(f.gain, 0);
      ramp(this.aPost.frequency, 20000); ramp(this.aMakeup.gain, 1); ramp(this.aMaster.gain, 1);
      return;
    }
    const g1 = m.g1[0] + (m.g1[1] - m.g1[0]) * d * d, g2 = m.g2[0] + (m.g2[1] - m.g2[0]) * d;
    ramp(this.aHp.frequency, m.hp);
    ramp(this.aPre1.gain, g1); this.sh1.curve = clipCurve(m.c1, m.d1);
    ramp(this.aInter.frequency, m.inter);
    ramp(this.aPre2.gain, g2); this.sh2.curve = m.c2 ? clipCurve(m.c2, m.d2) : null;
    ramp(this.tBass.gain, P['amp.bass'] + m.low);
    ramp(this.tMid.frequency, m.mid); ramp(this.tMid.gain, P['amp.mid']);
    ramp(this.tTreble.gain, P['amp.treble'] + m.bright);
    ramp(this.tPres.gain, P['amp.presence']);
    ramp(this.aPost.frequency, m.post);
    // clean-ish models stay linear-ish, so scale the makeup with their gain
    ramp(this.aMakeup.gain, m.c2 || m.g1[1] > 20 ? m.makeup : m.makeup / Math.sqrt(g1));
    ramp(this.aMaster.gain, P['amp.master']);
  }
  applyCab(P, ramp) {
    const c = CAB_TYPES[P['cab.type']], mic = P['cab.mic'];
    if (!c || !c.lp) {
      ramp(this.cHp.frequency, 10); for (const f of [this.cLow, this.cNotch, this.cPres]) ramp(f.gain, 0);
      ramp(this.cLp1.frequency, 20000); ramp(this.cLp2.frequency, 20000);
      return;
    }
    // mic: −1 = off-axis (dark) … +1 = on-axis, close to the cone (bright)
    const lp = c.lp * Math.pow(2, mic * 0.6);
    ramp(this.cHp.frequency, c.hp);
    ramp(this.cLow.frequency, c.low[0]); ramp(this.cLow.gain, c.low[1]);
    ramp(this.cNotch.frequency, c.notch[0]); ramp(this.cNotch.gain, c.notch[1]);
    ramp(this.cPres.frequency, c.pres[0]); ramp(this.cPres.gain, c.pres[1] + mic * 3);
    ramp(this.cLp1.frequency, lp); ramp(this.cLp2.frequency, lp * 1.15);
  }
}

// ---------------------------------------------------------------------------
// Reverb channel: pre-delay → low cut → convolution (type IR) → tone
// ---------------------------------------------------------------------------
class ReverbUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.pre = ctx.createDelay(0.5);
    this.lowcut = biq(ctx, 'highpass', 80, 0.7);
    this.conv = ctx.createConvolver();
    this.tone = biq(ctx, 'lowpass', 6000, 0.7);
    this.output = ctx.createGain();
    chain([this.input, this.pre, this.lowcut, this.conv, this.tone, this.output]);
    this._key = '';
  }
  apply(P, x, ramp, initial) {
    ramp(this.pre.delayTime, P[x + '.pre'] / 1000, 0.05);
    ramp(this.tone.frequency, P[x + '.tone'], 0.05);
    ramp(this.lowcut.frequency, P[x + '.lowcut'], 0.05);
    const key = [P[x + '.type'], P[x + '.size'], P[x + '.decay']].join('|');
    if (key === this._key) return;
    this._key = key;
    clearTimeout(this._t);
    const build = () => {
      const t = REVERB_TYPES[P[x + '.type']] || REVERB_TYPES.room, size = P[x + '.size'], dec = P[x + '.decay'];
      const o = Object.assign({}, t, { length: Math.min(10, t.length * size), decay: t.decay * size * dec });
      this.conv.buffer = toBuffer(this.ctx, spaceIR(this.ctx.sampleRate, o));
    };
    if (initial) build(); else this._t = setTimeout(build, 120); // debounce knob drags
  }
}

// ---------------------------------------------------------------------------
// Delay channel: the graph is rebuilt when the type changes.
// ---------------------------------------------------------------------------
class DelayUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.nodes = []; this.oscs = [];
    this.type = null;
  }
  _n(node, props = {}) { Object.assign(node, props); this.nodes.push(node); return node; }
  _delay(mult) { return this._n(this.ctx.createDelay(2.5), { _mult: mult }); }
  _gain(v = 1, props) { const g = this._n(this.ctx.createGain(), props); g.gain.value = v; return g; }
  _lfo(freq, scale, targets) {
    const o = this.ctx.createOscillator(); o.frequency.value = freq; o.start(); this.oscs.push(o);
    const g = this._gain(0, { _modScale: scale }); o.connect(g);
    for (const d of targets) g.connect(d.delayTime);
    this.mods.push(g);
  }
  build(type) {
    const ctx = this.ctx;
    this.input.disconnect();
    for (const n of this.nodes) n.disconnect();
    for (const o of this.oscs) { o.stop(); o.disconnect(); }
    this.nodes = []; this.oscs = [];
    this.delays = []; this.fbs = []; this.tones = []; this.mods = [];
    this.type = type;
    const tone = (scale = 1) => { const t = this._n(biq(ctx, 'lowpass', 3200, 0.7), { _scale: scale }); this.tones.push(t); return t; };
    const fb = (scale = 1) => { const g = this._gain(0.4, { _scale: scale }); this.fbs.push(g); return g; };
    const out = this.output;
    if (type === 'pingpong') {
      const dL = this._delay(1), dR = this._delay(1), tL = tone(), tR = tone(), fL = fb(), fR = fb();
      const merge = this._n(ctx.createChannelMerger(2));
      this.input.connect(dL);
      dL.connect(tL); tL.connect(fL); fL.connect(dR); tL.connect(merge, 0, 0);
      dR.connect(tR); tR.connect(fR); fR.connect(dL); tR.connect(merge, 0, 1);
      merge.connect(out);
      this.delays.push(dL, dR);
    } else if (type === 'multitap') {
      const mix = this._gain(1), t = tone(), f = fb(0.7);
      this.input.connect(mix);
      [[0.25, 0.8], [0.5, 0.6], [0.75, 0.45], [1, 0.35]].forEach(([m, lvl], i) => {
        const d = this._delay(m), g = this._gain(lvl);
        mix.connect(d); d.connect(g); g.connect(t);
        this.delays.push(d);
        if (i === 3) { d.connect(f); f.connect(mix); }
      });
      t.connect(out);
    } else if (type === 'tape') {
      const sat = this._n(ctx.createWaveShaper()); sat.curve = clipCurve('soft', 0.12); // gentle: only loud repeats saturate
      const d = this._delay(1), t = tone(0.8), hp = this._n(biq(ctx, 'highpass', 120, 0.7)), f = fb();
      this.input.connect(sat); sat.connect(d); d.connect(t); t.connect(hp); hp.connect(out); hp.connect(f); f.connect(d);
      this.delays.push(d);
      this._lfo(0.5, 0.004, [d]);   // wow
      this._lfo(6.5, 0.0007, [d]);  // flutter
    } else if (type === 'analog') {
      const d = this._delay(1), t = tone(0.45), clip = this._n(ctx.createWaveShaper()), f = fb();
      clip.curve = clipCurve('soft', 0.12);
      this.input.connect(d); d.connect(t); t.connect(clip); clip.connect(out); clip.connect(f); f.connect(d);
      this.delays.push(d);
      this._lfo(0.3, 0.0015, [d]);
    } else if (type === 'slapback') {
      const d = this._delay(1), t = tone(), f = fb(0.15);
      d._slap = true;
      this.input.connect(d); d.connect(t); t.connect(out); t.connect(f); f.connect(d);
      this.delays.push(d);
    } else { // digital
      const d = this._delay(1), t = tone(), f = fb();
      this.input.connect(d); d.connect(out); d.connect(t); t.connect(f); f.connect(d);
      this.delays.push(d);
    }
  }
  apply(P, x, ramp) {
    if (P[x + '.type'] !== this.type) this.build(P[x + '.type']);
    const beats = DELAY_DIVS[P[x + '.div']] || 0.75;
    const time = P[x + '.sync'] ? Math.min(2, beats * 60 / P['bpm']) : P[x + '.time'] / 1000;
    for (const d of this.delays) ramp(d.delayTime, d._slap ? Math.min(0.16, time) : Math.min(2.4, time * d._mult), 0.08);
    for (const f of this.fbs) ramp(f.gain, Math.min(0.92, P[x + '.fdbk']) * f._scale);
    for (const t of this.tones) ramp(t.frequency, P[x + '.tone'] * t._scale, 0.05);
    for (const m of this.mods) ramp(m.gain, P[x + '.mod'] * m._modScale, 0.05);
  }
}

// ---------------------------------------------------------------------------
// MOD channel: chorus / flanger (modulated delay) or phaser (allpass sweep)
// ---------------------------------------------------------------------------
class ModUnit {
  constructor(ctx) {
    this.input = ctx.createGain();
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.8; this.lfo.start();
    this.delay = ctx.createDelay(0.1);
    this.delayLfo = ctx.createGain();
    this.delayFb = ctx.createGain();
    this.delayOut = ctx.createGain();
    this.lfo.connect(this.delayLfo); this.delayLfo.connect(this.delay.delayTime);
    this.input.connect(this.delay); this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delay.connect(this.delayOut);
    this.phaseLfo = ctx.createGain();
    this.lfo.connect(this.phaseLfo);
    this.allpass = [0, 1, 2, 3].map(() => { const a = biq(ctx, 'allpass', 800, 0.6); this.phaseLfo.connect(a.frequency); return a; });
    this.phaseFb = ctx.createGain();
    const loop = ctx.createDelay(0.01);
    this.phaseOut = ctx.createGain();
    this.input.connect(this.allpass[0]);
    chain(this.allpass);
    this.allpass[3].connect(this.phaseOut);
    this.allpass[3].connect(this.phaseFb); this.phaseFb.connect(loop); loop.connect(this.allpass[0]);
    this.output = ctx.createGain();
    this.delayOut.connect(this.output); this.phaseOut.connect(this.output);
  }
  apply(P, ramp) {
    const type = P['mod.type'], depth = P['mod.depth'], fb = P['mod.feedback'];
    const isPhaser = type === 'phaser', isFlanger = type === 'flanger';
    ramp(this.lfo.frequency, P['mod.rate'], 0.05);
    ramp(this.delay.delayTime, isFlanger ? 0.003 : 0.018, 0.05);
    ramp(this.delayLfo.gain, isFlanger ? 0.0025 * depth : 0.008 * depth, 0.05);
    ramp(this.delayFb.gain, isFlanger ? fb * 0.95 : fb * 0.35);
    ramp(this.phaseLfo.gain, 200 + 1200 * depth, 0.05);
    ramp(this.phaseFb.gain, fb * 0.7);
    ramp(this.delayOut.gain, isPhaser ? 0 : 1);
    ramp(this.phaseOut.gain, isPhaser ? 1 : 0);
    ramp(this.output.gain, P['mod.on'] ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------
class FxRig {
  constructor(ctx, destination, kind, nSources) {
    this.ctx = ctx;
    this.kind = kind;
    this.p = Object.assign({}, FX_DEFAULTS[kind]);
    this.sources = Array.from({ length: nSources }, () => new SourceChain(ctx));
    this.inputs = this.sources.map(s => s.input);
    this._levelBuf = new Float32Array(512);
    const nCh = CHANNELS.length;

    // channel inputs + send matrix (source s → channel c)
    this.chIn = CHANNELS.map(() => ctx.createGain());
    this.sends = [];
    this.sources.forEach((src, s) => CHANNELS.forEach((_, c) => {
      const g = ctx.createGain(); g.gain.value = 0;
      src.output.connect(g); g.connect(this.chIn[c]);
      this.sends[s * nCh + c] = g;
    }));

    // channel processing
    this.dry = new DryDrive(ctx);
    this.rev = { ra: new ReverbUnit(ctx), rb: new ReverbUnit(ctx) };
    this.dly = { da: new DelayUnit(ctx), db: new DelayUnit(ctx) };
    this.mod = new ModUnit(ctx);
    this.ph = { phra: new Phaser(ctx, false), phda: new Phaser(ctx, false), phrb: new Phaser(ctx, true), phdb: new Phaser(ctx, true) };
    const outs = {};
    this.chIn[0].connect(this.dry.input); outs.dry = this.dry.output;
    for (const x of ['ra', 'rb']) { this.chIn[CHANNELS.indexOf(x)].connect(this.rev[x].input); this.rev[x].output.connect(this.ph['ph' + x].input); outs[x] = this.ph['ph' + x].output; }
    for (const x of ['da', 'db']) { this.chIn[CHANNELS.indexOf(x)].connect(this.dly[x].input); this.dly[x].output.connect(this.ph['ph' + x].input); outs[x] = this.ph['ph' + x].output; }
    this.chIn[5].connect(this.mod.input); outs.mod = this.mod.output;

    // FX → FX feeds (taken after the channel's processing, before its fader)
    this.net = {};
    for (const [a, b] of NET_FEEDS) {
      const g = ctx.createGain(); g.gain.value = 0;
      outs[a].connect(g); g.connect(this.chIn[CHANNELS.indexOf(b)]);
      this.net[`${a}.${b}`] = g;
    }

    // channel strips: fader → pan → mute → (meter) → mix
    const mix = ctx.createGain();
    this.strips = CHANNELS.map(id => {
      const fader = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const mute = ctx.createGain();
      const meter = ctx.createAnalyser(); meter.fftSize = 512;
      outs[id].connect(fader);
      if (pan) { fader.connect(pan); pan.connect(mute); } else fader.connect(mute);
      mute.connect(mix); mute.connect(meter);
      return { fader, pan, mute, meter };
    });

    // IR SIM → rig level → destination
    this.irDry = ctx.createGain();
    this.irConv = ctx.createConvolver();
    this.irWet = ctx.createGain();
    this.out = ctx.createGain();
    mix.connect(this.irDry); mix.connect(this.irConv); this.irConv.connect(this.irWet);
    this.irDry.connect(this.out); this.irWet.connect(this.out);
    this.out.connect(destination);
    this.irFileBuffer = null;

    for (const g of ['rig', 'pre', 'amp', 'cab', 'mod', 'ra', 'rb', 'da', 'db', 'phra', 'phda', 'phrb', 'phdb', 'dry', 'ch', 'net', 'ir']) this._apply(g, null, true);
  }

  setSend(s, c, v) {
    const g = this.sends[s * CHANNELS.length + c];
    if (g) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  set(path, value) {
    this.p[path] = value;
    const [group, a] = path.split('.');
    this._apply(group === 'bpm' ? 'bpm' : group, a, false);
  }

  _apply(group, a, initial) {
    const P = this.p, t = this.ctx.currentTime;
    const ramp = (param, v, tc = 0.03) => initial ? (param.value = v) : param.setTargetAtTime(v, t, tc);
    switch (group) {
      case 'rig': ramp(this.out.gain, P['rig.level']); break;
      case 'pre': for (const s of this.sources) s.applyPre(P, ramp); break;
      case 'amp': for (const s of this.sources) s.applyAmp(P, ramp); break;
      case 'cab': for (const s of this.sources) s.applyCab(P, ramp); break;
      case 'mod': this.mod.apply(P, ramp); break;
      case 'ra': case 'rb': this.rev[group].apply(P, group, ramp, initial); break;
      case 'da': case 'db': this.dly[group].apply(P, group, ramp); break;
      case 'bpm': this.dly.da.apply(P, 'da', ramp); this.dly.db.apply(P, 'db', ramp); break;
      case 'phra': case 'phda': case 'phrb': case 'phdb':
        this.ph[group].apply(P[group + '.on'], P[group + '.rate'], P[group + '.depth'], P[group + '.fdbk'], P[group + '.mix'], ramp); break;
      case 'dry': this.dry.apply(P, ramp); break;
      case 'ch': {
        const anySolo = CHANNELS.some((_, i) => P[`ch.${i}.solo`]);
        this.strips.forEach((s, i) => {
          ramp(s.fader.gain, P[`ch.${i}.level`]);
          if (s.pan) ramp(s.pan.pan, P[`ch.${i}.pan`]);
          ramp(s.mute.gain, !P[`ch.${i}.mute`] && (!anySolo || P[`ch.${i}.solo`]) ? 1 : 0, 0.01);
        });
        break;
      }
      case 'net': for (const k in this.net) ramp(this.net[k].gain, P['net.' + k]); break;
      case 'ir': {
        if (a === 'type' || initial) this._loadIR(P['ir.type']);
        const on = P['ir.type'] !== 'off' && (P['ir.type'] !== 'file' || this.irFileBuffer);
        const m = on ? P['ir.mix'] : 0;
        ramp(this.irDry.gain, Math.cos(m * Math.PI / 2));
        ramp(this.irWet.gain, Math.sin(m * Math.PI / 2));
        break;
      }
    }
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
    this.set('ir.type', 'file');
  }

  // Magnitude response (dB) of the pre-amp EQ at the given frequencies.
  eqResponse(freqs) {
    const s = this.sources[0], f = new Float32Array(freqs), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const out = new Float32Array(freqs.length);
    for (const b of [s.hpf, s.low, s.lm, s.hm, s.high, s.lpf]) {
      b.getFrequencyResponse(f, mag, ph);
      for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
    }
    return out;
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
window.CHANNELS = CHANNELS;
window.CHANNEL_NAMES = CHANNEL_NAMES;
window.NET_FEEDS = NET_FEEDS;
window.AMP_MODELS = AMP_MODELS;
window.CAB_TYPES = CAB_TYPES;
window.REVERB_TYPES = REVERB_TYPES;
window.DELAY_TYPES = DELAY_TYPES;
window.DELAY_DIVS = DELAY_DIVS;
