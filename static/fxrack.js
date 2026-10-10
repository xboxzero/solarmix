// morlam rack — hand controls for the FX rig (fx.js) and the drum machine.
//
// Two pages:
//   EFFECTS       1 Input (gain · amp · mod) · 2 Mixer (wet · dry · wet + mod)
//                 3 Sends · 4 IR simulation
//   DRUM MACHINE  6 tracks × 16 steps, presets, length, swing, per-track sound
//
// Mouse: drag a knob up/down or left/right (Shift = fine), scroll to nudge,
// double-click to reset, click its value to type a number. Faders jump to
// where you click. In the step grid, click or drag to paint steps, scroll
// on a step to change its velocity, right-click to cycle soft/medium/accent.

const VOICES = ['KHAEN', 'PHIN', 'SO', 'KLONG'];

const fmt = {
  dB: v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' dB',
  Hz: v => v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz',
  rate: v => v.toFixed(2) + ' Hz',
  ms: v => Math.round(v) + ' ms',
  s: v => v.toFixed(1) + ' s',
  x: v => v.toFixed(2) + '×',
  st: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)) + ' st',
  pct: v => Math.round(v * 100) + '%',
  pan: v => v < -0.02 ? 'L ' + Math.round(-v * 100) : v > 0.02 ? 'R ' + Math.round(v * 100) : 'C',
  ratio: v => v.toFixed(1) + ':1',
};

// Typed value → number in the control's own units.
function parseValue(unit, text) {
  const t = String(text).trim().toLowerCase();
  if (unit === 'pan') {
    if (t === 'c') return 0;
    const n = parseFloat(t.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? NaN : (t.startsWith('l') ? -n : n) / 100;
  }
  let n = parseFloat(t.replace(/[^0-9.\-]/g, ''));
  if (isNaN(n)) return NaN;
  if (unit === 'pct') n /= 100;
  if (unit === 'Hz' && /k/.test(t)) n *= 1000;
  return n;
}

const K = (path, label, min, max, unit, opts = {}) => ({ kind: 'knob', path, label, min, max, unit, ...opts });
const SEL = (path, label, options) => ({ kind: 'select', path, label, options });
const SW = (path, label) => ({ kind: 'switch', path, label });

const UNITS = [
  { title: 'Gain', sub: 'input · drive · clip', power: 'gain.on', ctrls: [
    K('gain.input', 'INPUT', 0, 30, 'dB'),
    K('gain.drive', 'DRIVE', 0, 1, 'pct'),
    SEL('gain.clip', 'CLIP', [['soft', 'Soft'], ['hard', 'Hard'], ['fuzz', 'Fuzz']]),
  ] },
  { title: 'Amp', sub: 'tone stack · level', power: 'amp.on', ctrls: [
    K('amp.bass', 'BASS', -15, 15, 'dB'),
    K('amp.mid', 'MID', -15, 15, 'dB'),
    K('amp.treble', 'TREBLE', -15, 15, 'dB'),
    K('amp.presence', 'PRESENCE', -10, 10, 'dB'),
    K('amp.level', 'LEVEL', 0, 1.5, 'pct'),
  ] },
  { title: 'Modulation', sub: 'feeds the MOD channel', power: 'mod.on', ctrls: [
    SEL('mod.type', 'TYPE', [['chorus', 'Chorus'], ['flanger', 'Flanger'], ['phaser', 'Phaser']]),
    K('mod.rate', 'RATE', 0.05, 8, 'rate', { log: true }),
    K('mod.depth', 'DEPTH', 0, 1, 'pct'),
    K('mod.feedback', 'FDBK', 0, 0.9, 'pct'),
  ] },
];

const phaserBlock = n => ({ title: 'Phase shifter', power: `ph${n}.on`, ctrls: [
  K(`ph${n}.rate`, 'RATE', 0.05, 6, 'rate', { log: true }),
  K(`ph${n}.depth`, 'DEPTH', 0, 1, 'pct'),
  K(`ph${n}.fdbk`, 'FDBK', 0, 0.95, 'pct'),
  K(`ph${n}.mix`, 'MIX', 0, 1, 'pct'),
] });

// Strips in W-D-W order; `ch` is the channel index in the rig.
const STRIPS = [
  { ch: 1, name: 'WET L', sub: 'reverb → phaser', blocks: [
    { title: 'Reverb', ctrls: [
      K('rev.size', 'SIZE', 0.3, 6, 's'),
      K('rev.decay', 'DECAY', 0.5, 6, 'x'),
      K('rev.predelay', 'PRE', 0, 200, 'ms'),
      K('rev.tone', 'TONE', 500, 12000, 'Hz', { log: true }),
    ] },
    phaserBlock(1),
  ] },
  { ch: 0, name: 'DRY', sub: 'drive → compressor', blocks: [
    { title: 'Drive', ctrls: [
      SEL('dry.mode', 'MODE', [['clean', 'Clean'], ['low', 'Low gain'], ['high', 'Hi gain']]),
      K('dry.gain', 'GAIN', 0, 1, 'pct'),
      K('dry.tone', 'TONE', 500, 12000, 'Hz', { log: true }),
      K('dry.level', 'LEVEL', 0, 1.5, 'pct'),
    ] },
    { title: 'Compressor', power: 'dry.comp', ctrls: [
      K('dry.thresh', 'THRESH', -50, 0, 'dB'),
      K('dry.ratio', 'RATIO', 1, 20, 'ratio', { log: true }),
    ] },
  ] },
  { ch: 2, name: 'WET R', sub: 'delay → phaser', blocks: [
    { title: 'Delay', ctrls: [
      K('dly.time', 'TIME', 20, 1500, 'ms', { log: true }),
      K('dly.feedback', 'FDBK', 0, 0.92, 'pct'),
      K('dly.tone', 'TONE', 500, 12000, 'Hz', { log: true }),
      SW('dly.sync', 'SYNC'),
    ] },
    phaserBlock(2),
  ] },
  { ch: 3, name: 'MOD', sub: 'from Modulation', blocks: [] },
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

// Click the readout to type an exact value.
function editable(lcd, spec, get, set) {
  lcd.title = 'Click to type a value';
  lcd.addEventListener('click', e => {
    e.stopPropagation();
    const input = el('input', 'kedit');
    input.value = fmt[spec.unit](get()).replace(/\s/g, ' ');
    lcd.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = commit => {
      if (done) return; done = true;
      if (commit) {
        const n = parseValue(spec.unit, input.value);
        if (!isNaN(n)) set(Math.min(spec.max, Math.max(spec.min, n)));
      }
      input.replaceWith(lcd);
    };
    input.addEventListener('keydown', k => {
      k.stopPropagation(); // don't play notes while typing
      if (k.key === 'Enter') finish(true);
      if (k.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}

// Wheel, double-click and arrow keys shared by knobs and faders.
function nudgeable(target, spec, get, set) {
  target.tabIndex = 0;
  const nudge = d => set(fromNorm(spec, clamp01(toNorm(spec, get()) + d)));
  target.addEventListener('wheel', e => {
    e.preventDefault();
    nudge((e.deltaY < 0 || e.deltaX > 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02));
  }, { passive: false });
  target.addEventListener('dblclick', () => set(spec.def));
  target.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    nudge(d * (e.shiftKey ? 0.005 : 0.02));
  });
}

function knob(spec, value, onChange, small = false) {
  const root = el('div', 'knob' + (small ? ' small' : ''));
  const dial = el('div', 'dial', '<div class="cap"><i></i></div>');
  const val = el('div', 'kval');
  dial.title = `${spec.label || ''}  ·  drag ↕/↔ · scroll · double-click resets`;
  root.append(dial);
  if (spec.label) root.append(el('div', 'klbl', spec.label));
  root.append(val);
  let v = value;
  const render = () => {
    const n = toNorm(spec, v);
    dial.style.setProperty('--n', n);
    dial.firstChild.style.transform = `rotate(${-135 + 270 * n}deg)`;
    val.textContent = fmt[spec.unit](v);
  };
  const set = nv => { v = nv; render(); onChange(v); };

  // drag up or right to increase; Shift for fine control
  let start = null;
  dial.addEventListener('pointerdown', e => {
    dial.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, n: toNorm(spec, v) };
    root.classList.add('active');
    e.preventDefault(); e.stopPropagation();
  });
  dial.addEventListener('pointermove', e => {
    if (!start) return;
    const range = (small ? 150 : 200) * (e.shiftKey ? 5 : 1);
    const d = (e.clientX - start.x) - (e.clientY - start.y);
    set(fromNorm(spec, clamp01(start.n + d / range)));
  });
  const end = () => { start = null; root.classList.remove('active'); };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  nudgeable(dial, spec, () => v, set);
  editable(val, spec, () => v, set);
  render();
  return root;
}

function fader(spec, value, onChange) {
  const root = el('div', 'fader');
  const track = el('div', 'track', '<div class="slot"><div class="fill"></div></div><div class="fcap"></div>');
  const val = el('div', 'kval');
  track.title = 'click or drag to set · scroll · double-click resets';
  root.append(track, val);
  const cap = track.querySelector('.fcap'), fill = track.querySelector('.fill');
  let v = value;
  const render = () => {
    const n = toNorm(spec, v);
    cap.style.bottom = `calc(${n * 100}% - ${n * 16}px)`;
    fill.style.height = n * 100 + '%';
    val.textContent = fmt[spec.unit](v);
  };
  const set = nv => { v = nv; render(); onChange(v); };
  // absolute: the cap jumps to the pointer
  const at = e => {
    const r = track.getBoundingClientRect();
    set(fromNorm(spec, clamp01(1 - (e.clientY - r.top - 8) / (r.height - 16))));
  };
  let dragging = false;
  track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); dragging = true; at(e); e.preventDefault(); e.stopPropagation(); });
  track.addEventListener('pointermove', e => { if (dragging) at(e); });
  track.addEventListener('pointerup', () => { dragging = false; });
  track.addEventListener('pointercancel', () => { dragging = false; });
  nudgeable(track, spec, () => v, set);
  editable(val, spec, () => v, set);
  render();
  return root;
}

function toggle(label, on, onChange, cls = '') {
  const b = el('button', 'sw ' + cls + (on ? ' on' : ''), label);
  b.type = 'button';
  b.addEventListener('click', () => { on = !on; b.classList.toggle('on', on); onChange(on); });
  b.setOn = v => { on = v; b.classList.toggle('on', v); };
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
  const ctrl = (c, small = false) => {
    if (c.kind === 'knob') return knob({ ...c, def: FX_DEFAULTS[c.path] }, fx[c.path], v => setFx(c.path, v), small);
    if (c.kind === 'select') return select(c, fx[c.path], v => setFx(c.path, v));
    return toggle(c.label, fx[c.path], v => setFx(c.path, v));
  };
  const card = (title, sub, power, cls = '') => {
    const u = el('section', 'unit ' + cls);
    const head = el('header', '', `<h3>${title}</h3>${sub ? `<span class="us">${sub}</span>` : ''}`);
    if (power) head.append(toggle('ON', fx[power], v => setFx(power, v), 'power'));
    u.append(head);
    const body = el('div', 'ubody');
    u.append(body);
    return { u, body };
  };
  const h2 = (num, text, note) => el('h2', '', `<span class="num">${num}</span>${text}${note ? `<span class="note">${note}</span>` : ''}`);

  root.textContent = '';

  // ---- header + tabs ----
  const head = el('div', 'rack-head');
  head.append(el('h1', '', 'Rack'));
  const tabs = el('nav', 'tabs');
  const pages = {};
  const tabBtns = {};
  const show = name => {
    for (const k in pages) { pages[k].hidden = k !== name; tabBtns[k].classList.toggle('on', k === name); }
  };
  for (const [key, label] of [['fx', 'Effects'], ['drums', 'Drum machine']]) {
    const b = el('button', 'tab', label); b.type = 'button';
    b.addEventListener('click', () => show(key));
    tabBtns[key] = b; tabs.append(b);
  }
  head.append(tabs);
  const close = el('button', 'sw close', 'Close ✕'); close.type = 'button';
  close.addEventListener('click', () => root.hidden = true);
  head.append(close);
  root.append(head);

  // =================== EFFECTS PAGE ===================
  const fxPage = el('div', 'page');
  pages.fx = fxPage;
  fxPage.append(el('p', 'lede', 'Signal flow: <b>voice</b> → gain → amp → <b>send matrix</b> → four parallel channels (wet L · dry · wet R · mod) → <b>IR simulation</b> → master. Every knob: drag, scroll, double-click to reset, or click its value to type.'));

  // 1 Input
  fxPage.append(h2('1', 'Input', 'per voice, before the mixer'));
  const row1 = el('div', 'rack-row');
  for (const spec of UNITS) {
    const { u, body } = card(spec.title, spec.sub, spec.power);
    for (const c of spec.ctrls) body.append(ctrl(c));
    row1.append(u);
  }
  fxPage.append(row1);

  // 2 Mixer
  fxPage.append(h2('2', 'Mixer', 'wet · dry · wet, in parallel'));
  const mixer = el('div', 'mixer');
  const meters = [];
  for (const st of STRIPS) {
    const strip = el('section', 'strip ch' + st.ch);
    strip.append(el('header', 'sname', `<h3>${st.name}</h3><span class="us">${st.sub}</span>`));
    const blocks = el('div', 'sblocks');
    for (const b of st.blocks) {
      const blk = el('div', 'block');
      const bh = el('div', 'bhead', `<span>${b.title}</span>`);
      if (b.power) bh.append(toggle('ON', fx[b.power], v => setFx(b.power, v), 'power'));
      blk.append(bh);
      const bb = el('div', 'bbody');
      for (const c of b.ctrls) bb.append(ctrl(c, true));
      blk.append(bb);
      blocks.append(blk);
    }
    if (!st.blocks.length) blocks.append(el('p', 'empty', 'Set the effect in <b>1 Input → Modulation</b>.'));
    strip.append(blocks);
    const out = el('div', 'sout');
    const pp = `ch.${st.ch}.pan`, lp = `ch.${st.ch}.level`;
    out.append(knob({ path: pp, label: 'PAN', min: -1, max: 1, unit: 'pan', def: FX_DEFAULTS[pp] }, fx[pp], v => setFx(pp, v), true));
    const fz = el('div', 'fzone');
    fz.append(fader({ min: 0, max: 1.2, unit: 'pct', def: FX_DEFAULTS[lp] }, fx[lp], v => setFx(lp, v)));
    const vu = el('div', 'vu', '<span></span>');
    fz.append(vu);
    meters[st.ch] = vu.firstChild;
    out.append(fz);
    const ms = el('div', 'ms');
    ms.append(toggle('M', fx[`ch.${st.ch}.mute`], v => setFx(`ch.${st.ch}.mute`, v), 'mute'));
    ms.append(toggle('S', fx[`ch.${st.ch}.solo`], v => setFx(`ch.${st.ch}.solo`, v), 'solo'));
    out.append(ms);
    strip.append(out);
    mixer.append(strip);
  }
  fxPage.append(mixer);

  // 3 Sends · 4 IR
  const row3 = el('div', 'rack-row');
  const sendsCol = el('div', 'col');
  sendsCol.append(h2('3', 'Sends', 'voice → channel'));
  const { u: sendU, body: sendB } = card('Send matrix', 'CHAOS (bottom bar) blends in the qubit router', null, 'sends');
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
  sendsCol.append(sendU);
  row3.append(sendsCol);

  const irCol = el('div', 'col');
  irCol.append(h2('4', 'IR simulation', 'last stage before master'));
  const { u: irU, body: irB } = card('Impulse response', 'cabinet · room · your own file', null, 'ir');
  const irSel = select({ label: 'IMPULSE', options: Object.entries(IR_TYPES).map(([k, t]) => [k, t.name]) }, fx['ir.type'], v => setFx('ir.type', v));
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'audio/*,.wav,.aif,.aiff'; fileIn.hidden = true;
  const loadBtn = el('button', 'sw', 'Load IR file…'); loadBtn.type = 'button';
  const fileLcd = el('div', 'irfile', 'synthetic IR');
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
  const irc = el('div', 'ircol');
  irc.append(irSel, loadBtn, fileLcd, fileIn);
  irB.append(irc);
  irB.append(ctrl(K('ir.mix', 'MIX', 0, 1, 'pct')));
  irB.append(ctrl(K('ir.level', 'LEVEL', 0, 2, 'pct')));
  irCol.append(irU);
  row3.append(irCol);
  fxPage.append(row3);
  root.append(fxPage);

  // =================== DRUM MACHINE PAGE ===================
  const dPage = el('div', 'page');
  pages.drums = dPage;
  const d = engine.drums;
  dPage.append(el('p', 'lede', 'Six tracks × 16 sixteenth-note steps. <b>Click or drag</b> across steps to paint them, <b>scroll</b> on a step to change its velocity, <b>right-click</b> to cycle soft · medium · accent.'));

  dPage.append(h2('1', 'Transport'));
  const bar = el('div', 'dbar');
  const play = toggle('▶ Play', engine.drumOn, () => send({ type: 'toggle', id: 'drum' }), 'play');
  const presetSel = select({ label: 'PRESET', options: Object.keys(DRUM_PRESETS).map(k => [k, k.replace(/\b\w/g, c => c.toUpperCase())]) }, d.preset, v => { send({ type: 'drum', op: 'preset', name: v }); renderCells(); });
  const stepsSel = select({ label: 'LENGTH', options: [[4, '4 steps'], [8, '8 steps'], [12, '12 steps'], [16, '16 steps']].map(([v, t]) => [String(v), t]) }, String(d.steps), v => { send({ type: 'drum', op: 'steps', value: +v }); renderCells(); });
  const swing = knob({ label: 'SWING', min: 0, max: 0.6, unit: 'pct', def: 0 }, d.swing, v => send({ type: 'drum', op: 'swing', value: v }), true);
  const clear = el('button', 'sw', 'Clear'); clear.type = 'button';
  clear.addEventListener('click', () => { send({ type: 'drum', op: 'clear' }); renderCells(); });
  bar.append(play, presetSel, stepsSel, swing, clear);
  dPage.append(bar);

  dPage.append(h2('2', 'Pattern'));
  const seq = el('div', 'seq');
  const cells = [];
  let paint = null; // velocity being painted while the button is held
  const setCell = (t, s, v) => { send({ type: 'drum', op: 'cell', track: t, step: s, value: v }); drawCell(t, s); };
  const drawCell = (t, s) => {
    const c = cells[t][s], v = d.tracks[t].pattern[s];
    c.classList.toggle('on', v > 0);
    c.style.setProperty('--v', v);
    c.classList.toggle('off-len', s >= d.steps);
  };
  function renderCells() {
    presetSel.querySelector('select').value = d.preset;
    stepsSel.querySelector('select').value = String(d.steps);
    cells.forEach((row, t) => row.forEach((_, s) => drawCell(t, s)));
  }
  // header: step numbers
  seq.append(el('div', 'shd', 'TRACK'), el('div', 'shd', ''));
  const nums = el('div', 'steps nums');
  for (let s = 0; s < 16; s++) nums.append(el('div', 'num' + (s % 4 === 0 ? ' beat' : ''), String(s + 1)));
  seq.append(nums, el('div', 'shd', 'LEVEL'), el('div', 'shd', 'TUNE'), el('div', 'shd', 'DECAY'));
  DRUM_TRACKS.forEach((tr, t) => {
    const st = d.tracks[t];
    seq.append(el('div', 'tname', tr.name));
    seq.append(toggle('M', st.mute, v => send({ type: 'drum', op: 'track', track: t, key: 'mute', value: v }), 'mute'));
    const row = el('div', 'steps');
    cells[t] = [];
    for (let s = 0; s < 16; s++) {
      const c = el('div', 'cell' + (s % 4 === 0 ? ' beat' : ''), '<span></span>');
      c.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        paint = st.pattern[s] > 0 ? 0 : 0.7;
        setCell(t, s, paint);
      });
      c.addEventListener('pointerenter', () => { if (paint !== null) setCell(t, s, paint); });
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const v = Math.round((st.pattern[s] + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10;
        setCell(t, s, Math.max(0, Math.min(1, v)));
      }, { passive: false });
      c.addEventListener('contextmenu', e => {
        e.preventDefault();
        const v = st.pattern[s];
        setCell(t, s, v <= 0 ? 0.4 : v < 0.6 ? 0.7 : v < 0.95 ? 1 : 0);
      });
      row.append(c);
      cells[t][s] = c;
    }
    seq.append(row);
    seq.append(knob({ label: '', min: 0, max: 1.2, unit: 'pct', def: 0.8 }, st.level, v => send({ type: 'drum', op: 'track', track: t, key: 'level', value: v }), true));
    seq.append(knob({ label: '', min: -12, max: 12, unit: 'st', def: 0 }, st.tune, v => send({ type: 'drum', op: 'track', track: t, key: 'tune', value: Math.round(v) }), true));
    seq.append(knob({ label: '', min: 0.3, max: 3, unit: 'x', def: 1, log: true }, st.decay, v => send({ type: 'drum', op: 'track', track: t, key: 'decay', value: v }), true));
  });
  window.addEventListener('pointerup', () => { paint = null; });
  window.addEventListener('pointercancel', () => { paint = null; });
  dPage.append(seq);
  renderCells();
  root.append(dPage);

  show('fx');
  let lastStep = -1;
  return {
    show,
    update(m) {
      if (root.hidden) return;
      if (m.ch_levels) m.ch_levels.forEach((l, i) => { if (meters[i]) meters[i].style.height = Math.min(100, Math.sqrt(l) * 160) + '%'; });
      if (m.drum_on !== undefined) play.setOn(m.drum_on);
      if (m.drum_step !== lastStep) {
        cells.forEach(row => {
          if (lastStep >= 0 && row[lastStep]) row[lastStep].classList.remove('ph');
          if (m.drum_step >= 0 && row[m.drum_step]) row[m.drum_step].classList.add('ph');
        });
        lastStep = m.drum_step;
      }
    },
  };
}
