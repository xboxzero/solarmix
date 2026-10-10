// morlam rack — hand controls for the two FX rigs (fx.js) and the drum machine.
//
// Pages:
//   KEYS FX       effects for the keyboard / globe voices
//   DRUM FX       effects for the drum machine (same layout, its own settings)
//   DRUM MACHINE  6 tracks × 16 steps, presets, length, swing, per-track sound
//
// Each FX page: 1 Pre-amp EQ · 2 Amp simulator · 3 Modulation
//               4 Mixer (wet · dry · wet, six parallel channels)
//               5 Signal network (sources → channels, FX → FX) · 6 IR + output
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
  q: v => 'Q ' + v.toFixed(2),
  mic: v => v < -0.05 ? 'off-axis ' + Math.round(-v * 100) : v > 0.05 ? 'on-axis ' + Math.round(v * 100) : 'edge',
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
const opts = table => Object.entries(table).map(([k, v]) => [k, v.name]);

const PRE_EQ = [
  { title: 'Input', ctrls: [K('pre.input', 'GAIN', -12, 24, 'dB'), K('pre.hpf', 'HPF', 20, 1000, 'Hz', { log: true }), K('pre.lpf', 'LPF', 1000, 20000, 'Hz', { log: true })] },
  { title: 'Low shelf', ctrls: [K('pre.lowF', 'FREQ', 40, 500, 'Hz', { log: true }), K('pre.low', 'GAIN', -15, 15, 'dB')] },
  { title: 'Low-mid', ctrls: [K('pre.lmF', 'FREQ', 150, 2000, 'Hz', { log: true }), K('pre.lm', 'GAIN', -15, 15, 'dB'), K('pre.lmQ', 'Q', 0.3, 8, 'q', { log: true })] },
  { title: 'High-mid', ctrls: [K('pre.hmF', 'FREQ', 800, 8000, 'Hz', { log: true }), K('pre.hm', 'GAIN', -15, 15, 'dB'), K('pre.hmQ', 'Q', 0.3, 8, 'q', { log: true })] },
  { title: 'High shelf', ctrls: [K('pre.highF', 'FREQ', 2000, 16000, 'Hz', { log: true }), K('pre.high', 'GAIN', -15, 15, 'dB')] },
];
const AMP = [
  { title: 'Amp', ctrls: [SEL('amp.model', 'MODEL', opts(AMP_MODELS)), K('amp.drive', 'DRIVE', 0, 1, 'pct'), K('amp.master', 'MASTER', 0, 1.5, 'pct')] },
  { title: 'Tone stack', ctrls: [K('amp.bass', 'BASS', -15, 15, 'dB'), K('amp.mid', 'MID', -15, 15, 'dB'), K('amp.treble', 'TREBLE', -15, 15, 'dB'), K('amp.presence', 'PRESENCE', -10, 10, 'dB')] },
  { title: 'Cabinet', ctrls: [SEL('cab.type', 'CAB', opts(CAB_TYPES)), K('cab.mic', 'MIC', -1, 1, 'mic')] },
];
const MOD = [
  SEL('mod.type', 'TYPE', [['chorus', 'Chorus'], ['flanger', 'Flanger'], ['phaser', 'Phaser']]),
  K('mod.rate', 'RATE', 0.05, 8, 'rate', { log: true }),
  K('mod.depth', 'DEPTH', 0, 1, 'pct'),
  K('mod.feedback', 'FDBK', 0, 0.9, 'pct'),
];

const phaserBlock = x => ({ title: 'Phase shifter', power: `ph${x}.on`, ctrls: [
  K(`ph${x}.rate`, 'RATE', 0.05, 6, 'rate', { log: true }),
  K(`ph${x}.depth`, 'DEPTH', 0, 1, 'pct'),
  K(`ph${x}.fdbk`, 'FDBK', 0, 0.95, 'pct'),
  K(`ph${x}.mix`, 'MIX', 0, 1, 'pct'),
] });
const reverbStrip = (x, name) => ({ ch: CHANNELS.indexOf(x), name, sub: 'reverb → phaser', blocks: [
  { title: 'Reverb', ctrls: [
    SEL(`${x}.type`, 'TYPE', opts(REVERB_TYPES)),
    K(`${x}.size`, 'SIZE', 0.25, 2, 'x', { log: true }),
    K(`${x}.decay`, 'DECAY', 0.25, 3, 'x', { log: true }),
    K(`${x}.pre`, 'PRE', 0, 200, 'ms'),
    K(`${x}.tone`, 'TONE', 500, 16000, 'Hz', { log: true }),
    K(`${x}.lowcut`, 'LOW CUT', 20, 1000, 'Hz', { log: true }),
  ] },
  phaserBlock(x),
] });
const delayStrip = (x, name) => ({ ch: CHANNELS.indexOf(x), name, sub: 'delay → phaser', blocks: [
  { title: 'Delay', ctrls: [
    SEL(`${x}.type`, 'TYPE', opts(DELAY_TYPES)),
    SW(`${x}.sync`, 'SYNC'),
    SEL(`${x}.div`, 'NOTE', Object.keys(DELAY_DIVS).map(k => [k, k])),
    K(`${x}.time`, 'TIME', 20, 2000, 'ms', { log: true }),
    K(`${x}.fdbk`, 'FDBK', 0, 0.92, 'pct'),
    K(`${x}.tone`, 'TONE', 500, 12000, 'Hz', { log: true }),
    K(`${x}.mod`, 'WOW', 0, 1, 'pct'),
  ] },
  phaserBlock(x),
] });
// W-D-W order: reverb/delay A on the left, dry centre, B on the right, then mod
const STRIPS = [
  reverbStrip('ra', 'REV A'),
  delayStrip('da', 'DLY A'),
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
  delayStrip('db', 'DLY B'),
  reverbStrip('rb', 'REV B'),
  { ch: CHANNELS.indexOf('mod'), name: 'MOD', sub: 'from 3 Modulation', blocks: [] },
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
  const h2 = (num, text, note) => el('h2', '', `<span class="num">${num}</span>${text}${note ? `<span class="note">${note}</span>` : ''}`);
  root.textContent = '';

  // ---- header + tabs ----
  const head = el('div', 'rack-head');
  head.append(el('h1', '', 'Rack'));
  const tabs = el('nav', 'tabs');
  const pages = {}, tabBtns = {};
  const show = name => {
    for (const k in pages) { pages[k].hidden = k !== name; tabBtns[k].classList.toggle('on', k === name); }
    current = name;
    if (redraws[name]) redraws[name]();
    meterRigs();
  };
  let current = 'keys';
  // only the rig on screen runs its level meters
  const meterRigs = () => {
    synth.setMetering('keys', !root.hidden && current === 'keys');
    synth.setMetering('drums', !root.hidden && current === 'drumfx');
  };
  new MutationObserver(meterRigs).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  const redraws = {};
  for (const [key, label] of [['keys', 'Keys FX'], ['drumfx', 'Drum FX'], ['drums', 'Drum machine']]) {
    const b = el('button', 'tab', label); b.type = 'button'; b.dataset.page = key;
    b.addEventListener('click', () => show(key));
    tabBtns[key] = b; tabs.append(b);
  }
  head.append(tabs);
  const close = el('button', 'sw close', 'Close ✕'); close.type = 'button';
  close.addEventListener('click', () => root.hidden = true);
  head.append(close);
  root.append(head);

  // =================== FX PAGES (one per rig) ===================
  const meters = {};
  function fxPage(rig, title, sources, lede) {
    const fx = engine.fx[rig];
    let eqTimer = 0;
    const setFx = (path, value) => {
      send({ type: 'fx', rig, path, value });
      // redraw once the parameter ramps have settled
      if (path.startsWith('pre.')) { clearTimeout(eqTimer); eqTimer = setTimeout(drawEq, 150); }
    };
    const ctrl = (c, small = false) => {
      if (c.kind === 'knob') return knob({ ...c, def: FX_DEFAULTS[rig][c.path] }, fx[c.path], v => setFx(c.path, v), small);
      if (c.kind === 'select') return select(c, fx[c.path], v => setFx(c.path, v));
      return toggle(c.label, fx[c.path], v => setFx(c.path, v));
    };
    const card = (title, sub, power, cls = '') => {
      const u = el('section', 'unit ' + cls);
      const hd = el('header', '', `<h3>${title}</h3>${sub ? `<span class="us">${sub}</span>` : ''}`);
      if (power) hd.append(toggle('ON', fx[power], v => setFx(power, v), 'power'));
      u.append(hd);
      const body = el('div', 'ubody');
      u.append(body);
      return { u, body };
    };
    const blocks = (body, list, small = false) => {
      for (const b of list) {
        const blk = el('div', 'block');
        const bh = el('div', 'bhead', `<span>${b.title}</span>`);
        if (b.power) bh.append(toggle('ON', fx[b.power], v => setFx(b.power, v), 'power'));
        blk.append(bh);
        const bb = el('div', 'bbody');
        for (const c of b.ctrls) bb.append(ctrl(c, small));
        blk.append(bb);
        body.append(blk);
      }
    };

    const page = el('div', 'page');
    page.append(el('p', 'lede', lede));

    // 1 Pre-amp EQ
    page.append(h2('1', 'Pre-amp EQ', 'per source, before the amp'));
    const { u: eqU, body: eqB } = card('Equaliser', 'input · filters · 4 bands', 'pre.on', 'eq');
    const eqBands = el('div', 'blocks-row');
    blocks(eqBands, PRE_EQ);
    const canvas = el('canvas', 'eqcurve'); canvas.width = 720; canvas.height = 200;
    eqB.append(eqBands, canvas);
    page.append(eqU);
    function drawEq() {
      const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue('--ink').trim() || '#1d1d1b', line = css.getPropertyValue('--line').trim() || '#d3d0c9';
      const accent = css.getPropertyValue('--accent').trim() || '#ff5a00', mute = css.getPropertyValue('--mute').trim() || '#7a7770';
      g.clearRect(0, 0, W, H);
      const fx2x = f => Math.log(f / 20) / Math.log(1000) * W, db2y = d => H / 2 - d / 24 * (H / 2 - 12);
      g.lineWidth = 1; g.strokeStyle = line; g.fillStyle = mute; g.font = '18px "IBM Plex Mono", monospace';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx2x(f); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (const d of [-18, -12, -6, 6, 12, 18]) { const y = db2y(d); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.strokeStyle = mute; g.beginPath(); g.moveTo(0, db2y(0)); g.lineTo(W, db2y(0)); g.stroke();
      for (const [f, t] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(t, fx2x(f) + 4, H - 6);
      const n = 240, freqs = Array.from({ length: n }, (_, i) => 20 * Math.pow(1000, i / (n - 1)));
      const resp = synth.isInitialized ? synth.eqResponse(rig, freqs) : null;
      if (!resp) { g.fillStyle = mute; g.fillText('start audio to see the curve', 12, 26); return; }
      g.strokeStyle = fx['pre.on'] ? accent : mute; g.lineWidth = 3; g.beginPath();
      resp.forEach((d, i) => { const x = fx2x(freqs[i]), y = db2y(Math.max(-24, Math.min(24, d))); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    redraws[rig === 'drums' ? 'drumfx' : rig] = () => setTimeout(drawEq, 60); // after the ramps settle

    // 2 Amp simulator
    page.append(h2('2', 'Amp simulator', 'amp model · tone stack · cabinet'));
    const { u: ampU, body: ampB } = card('Amp', '', 'amp.on', 'amp');
    const ampRow = el('div', 'blocks-row');
    blocks(ampRow, AMP);
    ampB.append(ampRow);
    page.append(ampU);

    // 3 Modulation
    page.append(h2('3', 'Modulation', 'feeds the MOD channel'));
    const { u: modU, body: modB } = card('Modulation', 'chorus · flanger · phaser', 'mod.on');
    for (const c of MOD) modB.append(ctrl(c));
    page.append(modU);

    // 4 Mixer
    page.append(h2('4', 'Mixer', 'wet · dry · wet — six parallel channels'));
    const mixer = el('div', 'mixer');
    meters[rig] = [];
    for (const st of STRIPS) {
      const strip = el('section', 'strip ch-' + CHANNELS[st.ch]);
      strip.append(el('header', 'sname', `<h3>${st.name}</h3><span class="us">${st.sub}</span>`));
      const sb = el('div', 'sblocks');
      blocks(sb, st.blocks, true);
      if (!st.blocks.length) sb.append(el('p', 'empty', 'Set the effect in <b>3 Modulation</b>.'));
      strip.append(sb);
      const out = el('div', 'sout');
      const pp = `ch.${st.ch}.pan`, lp = `ch.${st.ch}.level`;
      out.append(knob({ label: 'PAN', min: -1, max: 1, unit: 'pan', def: FX_DEFAULTS[rig][pp] }, fx[pp], v => setFx(pp, v), true));
      const fz = el('div', 'fzone');
      fz.append(fader({ min: 0, max: 1.2, unit: 'pct', def: FX_DEFAULTS[rig][lp] }, fx[lp], v => setFx(lp, v)));
      const vu = el('div', 'vu', '<span></span>');
      fz.append(vu);
      meters[rig][st.ch] = vu.firstChild;
      out.append(fz);
      const ms = el('div', 'ms');
      ms.append(toggle('M', fx[`ch.${st.ch}.mute`], v => setFx(`ch.${st.ch}.mute`, v), 'mute'));
      ms.append(toggle('S', fx[`ch.${st.ch}.solo`], v => setFx(`ch.${st.ch}.solo`, v), 'solo'));
      out.append(ms);
      strip.append(out);
      mixer.append(strip);
    }
    page.append(mixer);

    // 5 Signal network
    page.append(h2('5', 'Signal network', 'every path set by hand'));
    const netRow = el('div', 'rack-row');
    const { u: srcU, body: srcB } = card('Sources → amp / channels', rig === 'keys' ? 'AMP = through the shared pre-amp EQ, amp and cab; the other columns bypass it. CHAOS (bottom bar) blends the qubit router into DRY…DLY B' : 'AMP = through the shared pre-amp EQ, amp and cab; the other columns bypass it', null, 'sends');
    const grid = el('div', 'grid');
    grid.style.gridTemplateColumns = `64px repeat(${MATRIX_COLS.length}, 1fr)`;
    grid.append(el('div', 'gh', ''));
    for (const n of MATRIX_COLS) grid.append(el('div', 'gh' + (n === 'AMP' ? ' amp' : ''), n));
    sources.forEach((sname, si) => {
      grid.append(el('div', 'gv', sname));
      MATRIX_COLS.forEach((_, col) => {
        const r = engine.route[rig], i = si * MATRIX_COLS.length + col;
        grid.append(knob({ min: 0, max: 1, unit: 'pct', def: r[i] }, r[i], v => send({ type: 'route', rig, src: si, col, value: v }), true));
      });
    });
    // the amp's own output into each channel
    grid.append(el('div', 'gv amp', 'AMP OUT'), el('div', 'gx', '—'));
    CHANNELS.forEach((_, c) => grid.append(ctrl(K(`aout.${c}`, '', 0, 1, 'pct'), true)));
    srcB.append(grid);
    netRow.append(srcU);
    const { u: fxU, body: fxB } = card('FX → FX feeds', 'chain effects in parallel: e.g. delay into reverb', null, 'sends feeds');
    const tos = ['da', 'db', 'ra', 'rb'], froms = ['mod', 'da', 'db'];
    const fg = el('div', 'grid');
    fg.style.gridTemplateColumns = `64px repeat(${tos.length}, 1fr)`;
    fg.append(el('div', 'gh', 'from ↓ to →'));
    for (const t of tos) fg.append(el('div', 'gh', CHANNEL_NAMES[CHANNELS.indexOf(t)]));
    for (const f of froms) {
      fg.append(el('div', 'gv', CHANNEL_NAMES[CHANNELS.indexOf(f)]));
      for (const t of tos) {
        const path = `net.${f}.${t}`;
        fg.append(path in fx ? knob({ min: 0, max: 1, unit: 'pct', def: FX_DEFAULTS[rig][path] }, fx[path], v => setFx(path, v), true) : el('div', 'gx', '—'));
      }
    }
    fxB.append(fg);
    netRow.append(fxU);
    page.append(netRow);

    // 6 IR simulation + output
    page.append(h2('6', 'IR simulation & output', 'last stage before the master'));
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
        await synth.loadIRFile(rig, f);
        fx['ir.type'] = 'file';
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
    irB.append(ctrl(K('rig.level', title.toUpperCase() + ' OUT', 0, 1.5, 'pct')));
    page.append(irU);
    return page;
  }

  pages.keys = fxPage('keys', 'Keys', VOICES,
    'Effects for the <b>keyboard and globe voices</b>. Signal flow: source → <b>pre-amp EQ</b> → <b>amp</b> → cabinet → <b>signal network</b> → six parallel channels → <b>IR simulation</b> → master. Every knob: drag, scroll, double-click to reset, or click its value to type.');
  root.append(pages.keys);
  pages.drumfx = fxPage('drums', 'Drums', DRUM_TRACKS.map(t => t.name),
    'Effects for the <b>drum machine</b>, independent of the keys. Same signal flow; each of the six drum tracks is its own source in the signal network.');
  root.append(pages.drumfx);

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

  show('keys');
  let lastStep = -1, eqDrawn = false;
  return {
    show,
    update(m) {
      if (root.hidden) return;
      if (!eqDrawn && synth.isInitialized) { eqDrawn = true; redraws.keys(); redraws.drumfx(); meterRigs(); }
      const rig = current === 'drumfx' ? 'drums' : current === 'keys' ? 'keys' : null;
      if (rig && m.ch_levels && m.ch_levels[rig]) m.ch_levels[rig].forEach((l, i) => { const e = meters[rig][i]; if (e) e.style.height = Math.min(100, Math.sqrt(l) * 160) + '%'; });
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
