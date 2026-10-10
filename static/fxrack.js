// morlam FX rack — hand controls for the FX rig (fx.js).
//
// Rack units, top to bottom:
//   GAIN · AMP · MOD                  — per-voice insert + modulation
//   W-D-W MIXER                       — WET L · DRY · WET R · MOD channel strips
//   SEND MATRIX · IR SIM              — voice → channel sends, final impulse response
//
// Knobs and faders: drag up/down (hold Shift for fine), mouse wheel to nudge,
// double-click to reset.

const VOICES = ['KHAEN', 'PHIN', 'SO', 'KLONG'];

const fmt = {
  dB: v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + 'dB',
  Hz: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + 'Hz',
  rate: v => v.toFixed(2) + 'Hz',
  ms: v => Math.round(v) + 'ms',
  s: v => v.toFixed(1) + 's',
  x: v => v.toFixed(1),
  pct: v => Math.round(v * 100) + '%',
  pan: v => v < -0.02 ? 'L' + Math.round(-v * 100) : v > 0.02 ? 'R' + Math.round(v * 100) : 'C',
};

const K = (path, label, min, max, unit, opts = {}) => ({ kind: 'knob', path, label, min, max, unit, ...opts });
const SEL = (path, label, options) => ({ kind: 'select', path, label, options });
const SW = (path, label) => ({ kind: 'switch', path, label });

const UNITS = [
  { title: 'GAIN', sub: 'input · drive', power: 'gain.on', ctrls: [
    K('gain.input', 'INPUT', 0, 30, 'dB'),
    K('gain.drive', 'DRIVE', 0, 1, 'pct'),
    SEL('gain.clip', 'CLIP', [['soft', 'SOFT'], ['hard', 'HARD'], ['fuzz', 'FUZZ']]),
  ] },
  { title: 'AMP', sub: 'tone stack', power: 'amp.on', ctrls: [
    K('amp.bass', 'BASS', -15, 15, 'dB'),
    K('amp.mid', 'MID', -15, 15, 'dB'),
    K('amp.treble', 'TREBLE', -15, 15, 'dB'),
    K('amp.presence', 'PRESENCE', -10, 10, 'dB'),
    K('amp.level', 'LEVEL', 0, 1.5, 'pct'),
  ] },
  { title: 'MOD', sub: 'modulation', power: 'mod.on', ctrls: [
    SEL('mod.type', 'TYPE', [['chorus', 'CHORUS'], ['flanger', 'FLANGER'], ['phaser', 'PHASER']]),
    K('mod.rate', 'RATE', 0.05, 8, 'rate', { log: true }),
    K('mod.depth', 'DEPTH', 0, 1, 'pct'),
    K('mod.feedback', 'FDBK', 0, 0.9, 'pct'),
  ] },
];

// Strips in W-D-W order; `ch` is the channel index in the rig.
const STRIPS = [
  { ch: 1, name: 'WET L', sub: 'REVERB', ctrls: [
    K('rev.size', 'SIZE', 0.3, 6, 's'),
    K('rev.decay', 'DECAY', 0.5, 6, 'x'),
    K('rev.predelay', 'PRE', 0, 200, 'ms'),
    K('rev.tone', 'TONE', 500, 12000, 'Hz', { log: true }),
  ] },
  { ch: 0, name: 'DRY', sub: 'DIRECT', ctrls: [] },
  { ch: 2, name: 'WET R', sub: 'DELAY', ctrls: [
    K('dly.time', 'TIME', 20, 1500, 'ms', { log: true }),
    K('dly.feedback', 'FDBK', 0, 0.92, 'pct'),
    K('dly.tone', 'TONE', 500, 12000, 'Hz', { log: true }),
    SW('dly.sync', 'SYNC'),
  ] },
  { ch: 3, name: 'MOD', sub: 'FROM MOD UNIT', ctrls: [] },
];

// ---------------------------------------------------------------------------
// value <-> 0..1 position
// ---------------------------------------------------------------------------
const toNorm = (s, v) => s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min);
const fromNorm = (s, n) => s.log ? s.min * Math.pow(s.max / s.min, n) : s.min + n * (s.max - s.min);
const clamp01 = n => Math.max(0, Math.min(1, n));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// Shared drag behaviour for knobs and faders.
function draggable(target, spec, get, set, pixels) {
  let start = null;
  target.addEventListener('pointerdown', e => {
    target.setPointerCapture(e.pointerId);
    start = { y: e.clientY, n: toNorm(spec, get()) };
    e.preventDefault(); e.stopPropagation();
  });
  target.addEventListener('pointermove', e => {
    if (!start) return;
    const range = (typeof pixels === 'function' ? pixels() : pixels) * (e.shiftKey ? 5 : 1);
    set(fromNorm(spec, clamp01(start.n + (start.y - e.clientY) / range)));
  });
  const end = () => { start = null; };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.addEventListener('dblclick', () => set(spec.def));
  target.addEventListener('wheel', e => {
    e.preventDefault();
    set(fromNorm(spec, clamp01(toNorm(spec, get()) + (e.deltaY < 0 ? 0.02 : -0.02))));
  }, { passive: false });
}

function knob(spec, value, onChange, small = false) {
  const root = el('div', 'knob' + (small ? ' small' : ''));
  const dial = el('div', 'dial', '<div class="cap"><i></i></div>');
  const val = el('div', 'kval lcd');
  root.append(dial);
  if (spec.label) root.append(el('div', 'klbl', spec.label));
  root.append(val);
  let v = value;
  const render = () => {
    dial.firstChild.style.transform = `rotate(${-135 + 270 * toNorm(spec, v)}deg)`;
    val.textContent = fmt[spec.unit](v);
  };
  const set = nv => { v = nv; render(); onChange(v); };
  draggable(dial, spec, () => v, set, small ? 120 : 160);
  render();
  return root;
}

function fader(spec, value, onChange) {
  const root = el('div', 'fader');
  const track = el('div', 'track', '<div class="slot"></div><div class="ticks"></div><div class="fcap"></div>');
  const val = el('div', 'kval lcd');
  root.append(track, val);
  const cap = track.querySelector('.fcap');
  let v = value;
  const render = () => {
    cap.style.bottom = `calc(${toNorm(spec, v) * 100}% - ${toNorm(spec, v) * 22}px)`;
    val.textContent = fmt[spec.unit](v);
  };
  const set = nv => { v = nv; render(); onChange(v); };
  draggable(track, spec, () => v, set, () => track.clientHeight || 120);
  render();
  return root;
}

function toggle(label, on, onChange, cls = '') {
  const b = el('button', 'sw ' + cls + (on ? ' on' : ''), label);
  b.type = 'button';
  b.addEventListener('click', () => { on = !on; b.classList.toggle('on', on); onChange(on); });
  return b;
}

function select(spec, value, onChange) {
  const wrap = el('label', 'sel', `<span>${spec.label}</span>`);
  const s = el('select');
  for (const [v, t] of spec.options) {
    const o = el('option', '', t); o.value = v; if (v === value) o.selected = true; s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  wrap.append(s);
  return wrap;
}

// ---------------------------------------------------------------------------
export function buildRack(root, { engine, synth, send }) {
  const fx = engine.fx;
  const setFx = (path, value) => send({ type: 'fx', path, value });
  const ctrl = c => {
    if (c.kind === 'knob') return knob({ ...c, def: FX_DEFAULTS[c.path] }, fx[c.path], v => setFx(c.path, v));
    if (c.kind === 'select') return select(c, fx[c.path], v => setFx(c.path, v));
    return toggle(c.label, fx[c.path], v => setFx(c.path, v));
  };
  const unit = (title, sub, power, cls = '') => {
    const u = el('section', 'unit ' + cls);
    const head = el('header', '', `<span class="ut">${title}</span><span class="us">${sub}</span>`);
    if (power) head.append(toggle('ON', fx[power], v => setFx(power, v), 'power'));
    u.append(head);
    const body = el('div', 'ubody');
    u.append(body);
    return { u, body };
  };

  root.textContent = '';
  const bar = el('div', 'rack-bar', '<span class="rt">FX RACK</span><span class="rs">gain · amp · mod → W-D-W mix → IR sim</span>');
  const close = el('button', 'sw', 'CLOSE ✕'); close.type = 'button';
  close.addEventListener('click', () => root.hidden = true);
  bar.append(close);
  root.append(bar);

  // ---- row 1: GAIN · AMP · MOD ----
  const row1 = el('div', 'rack-row');
  for (const spec of UNITS) {
    const { u, body } = unit(spec.title, spec.sub, spec.power);
    for (const c of spec.ctrls) body.append(ctrl(c));
    row1.append(u);
  }
  root.append(row1);

  // ---- row 2: parallel W-D-W mixer ----
  const { u: mixU, body: mixB } = unit('W · D · W MIXER', 'parallel wet · dry · wet + mod', null, 'mixer');
  const meters = [];
  for (const st of STRIPS) {
    const strip = el('div', 'strip ch' + st.ch);
    strip.append(el('div', 'sname', `${st.name}<small>${st.sub}</small>`));
    const params = el('div', 'sparams');
    for (const c of st.ctrls) params.append(c.kind === 'knob'
      ? knob({ ...c, def: FX_DEFAULTS[c.path] }, fx[c.path], v => setFx(c.path, v), true)
      : ctrl(c));
    strip.append(params);
    const pp = `ch.${st.ch}.pan`, lp = `ch.${st.ch}.level`;
    strip.append(knob({ path: pp, label: 'PAN', min: -1, max: 1, unit: 'pan', def: FX_DEFAULTS[pp] }, fx[pp], v => setFx(pp, v), true));
    const fz = el('div', 'fzone');
    fz.append(fader({ min: 0, max: 1.2, unit: 'pct', def: FX_DEFAULTS[lp] }, fx[lp], v => setFx(lp, v)));
    const vu = el('div', 'vu', '<span></span>');
    fz.append(vu);
    meters[st.ch] = vu.firstChild;
    strip.append(fz);
    const ms = el('div', 'ms');
    ms.append(toggle('M', fx[`ch.${st.ch}.mute`], v => setFx(`ch.${st.ch}.mute`, v), 'mute'));
    ms.append(toggle('S', fx[`ch.${st.ch}.solo`], v => setFx(`ch.${st.ch}.solo`, v), 'solo'));
    strip.append(ms);
    mixB.append(strip);
  }
  root.append(mixU);

  // ---- row 3: send matrix · IR SIM ----
  const row3 = el('div', 'rack-row');
  const { u: sendU, body: sendB } = unit('SEND MATRIX', 'voice → channel · CHAOS blends in the qubit router', null, 'sends');
  const grid = el('div', 'grid');
  grid.append(el('div', 'gh', ''));
  for (const name of CHANNEL_NAMES) grid.append(el('div', 'gh', name));
  VOICES.forEach((vname, v) => {
    grid.append(el('div', 'gv', vname));
    for (let b = 0; b < 4; b++) {
      grid.append(knob({ min: 0, max: 1, unit: 'pct', def: engine.route[v * 4 + b] }, engine.route[v * 4 + b],
        val => send({ type: 'route', voice: v, bus: b, value: val }), true));
    }
  });
  sendB.append(grid);
  row3.append(sendU);

  const { u: irU, body: irB } = unit('IR SIM', 'impulse response · last stage', null, 'ir');
  const irSel = select({ label: 'IMPULSE', options: Object.entries(IR_TYPES).map(([k, t]) => [k, t.name]) }, fx['ir.type'], v => setFx('ir.type', v));
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'audio/*,.wav,.aif,.aiff'; fileIn.hidden = true;
  const loadBtn = el('button', 'sw', 'LOAD IR…'); loadBtn.type = 'button';
  const fileLcd = el('div', 'lcd irfile', 'synthetic IR');
  loadBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    fileLcd.textContent = 'loading…';
    try {
      await synth.loadIRFile(f);
      engine.fx['ir.type'] = 'file';
      irSel.querySelector('select').value = 'file';
      fileLcd.textContent = f.name;
    } catch (e) {
      fileLcd.textContent = synth.isInitialized ? 'could not decode file' : 'start audio first';
    }
    fileIn.value = '';
  });
  const irCol = el('div', 'ircol');
  irCol.append(irSel, loadBtn, fileLcd, fileIn);
  irB.append(irCol);
  irB.append(ctrl(K('ir.mix', 'MIX', 0, 1, 'pct')));
  irB.append(ctrl(K('ir.level', 'LEVEL', 0, 2, 'pct')));
  row3.append(irU);
  root.append(row3);

  return {
    update(m) {
      if (root.hidden || !m.ch_levels) return;
      m.ch_levels.forEach((l, i) => { if (meters[i]) meters[i].style.height = Math.min(100, Math.sqrt(l) * 160) + '%'; });
    },
  };
}
