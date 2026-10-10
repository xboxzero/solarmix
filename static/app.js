// morlam — 3D globe of submarine fibre-optic cables you play by touch, a
// well-tempered pentatonic keyboard, an FX rack and a drum machine.
//
// • The globe (globe.js) carries every submarine cable on the
//   TeleGeography map. Touch a cable to play the active voice: the position
//   along the cable (0 → 1) picks one of the five notes of the current lai.
//   Drag off the cables to turn the globe.
// • The keyboard lays the current lai out over three octaves; every pitch is
//   tuned to the selected well temperament (tuning.js).
// • The SVG patchbay overlay shows the 16 voice → channel send levels.
//
// Everything runs in the browser: LocalEngine (engine.js) holds the state and
// the MorlamSynth (synth.js) plays through Web Audio. No server needed.

import * as THREE from './vendor/three.module.js';
import { buildRack } from './fxrack.js';
import { Globe } from './globe.js';

// =====================================================================
// Web Audio Synth
// =====================================================================
const synth = new MorlamSynth();
const engine = new LocalEngine(synth);
let audioReady = false;
let audioError = null;

// Older iOS mutes Web Audio when the ringer switch is on silent. A looping
// silent <audio> element moves the page into the "playback" audio session,
// which ignores the switch. Started once, inside the first tap.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let silentLoop = null;
function startSilentLoop() {
  if (!IOS || silentLoop) return;
  const sr = 8000, n = sr / 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  silentLoop = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  silentLoop.loop = true;
  silentLoop.setAttribute('playsinline', '');
  silentLoop.play().catch(() => { silentLoop = null; }); // retry on the next tap
}

// Audio starts on the first tap/click/key (browser autoplay policy). Both the
// AudioContext creation and its resume happen synchronously inside that
// gesture, which Safari requires.
async function resumeAudio() {
  startSilentLoop();
  if (!audioReady) {
    try {
      await synth.init();
      audioReady = true;
      audioError = null;
      engine.attach();
    } catch (e) {
      audioError = e;
      console.error('Audio init failed:', e);
      showError('Audio could not start: ' + (e && e.message ? e.message : String(e)));
      return;
    }
  }
  try { await synth.resume(); } catch (e) { console.error('Audio resume failed:', e); }
}

// ----- error surface (Safari hides JS errors otherwise) -----
function showError(msg) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:60px;left:20px;right:20px;background:#3a0808;color:#ffeaea;padding:14px;border:1px solid #ff5050;border-radius:6px;font-family:monospace;font-size:12px;z-index:100;white-space:pre-wrap';
  d.textContent = 'JS error: ' + String(msg);
  document.body.appendChild(d);
}

window.addEventListener('error', e => {
  let msg = 'Unknown error';
  if (e && e.error && typeof e.error === 'object') {
    msg = e.error.stack ? String(e.error.stack) : (e.error.message ? String(e.error.message) : String(e.error));
  } else if (e && e.message) {
    msg = String(e.message);
  } else if (e) {
    msg = String(e);
  }
  showError(msg);
});

const startBtn = document.getElementById('start');
if (startBtn) startBtn.addEventListener('click', () => startBtn.classList.add('hidden'));

// Resume audio on user interaction (every gesture until the context runs —
// iOS sometimes needs more than one).
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(ev, () => {
    if (!audioReady || !synth.ctx || synth.ctx.state !== 'running') resumeAudio();
  }, true);
}

window.addEventListener('unhandledrejection', e => {
  let msg = 'Unhandled Promise rejection';
  if (e && e.reason) {
    msg = e.reason && e.reason.message ? String(e.reason.message) : String(e.reason);
  }
  showError(msg);
});

// =====================================================================
// Control: every UI action is a message to the local engine
// =====================================================================
const audioStatus = document.getElementById('status');
function send(obj) {
  try { engine.handle(obj); } catch (e) { console.error('Engine error:', e); }
}

// =====================================================================
// Three.js scene
// =====================================================================
const canvas = document.getElementById('stage');
if (!canvas) throw new Error('Canvas element not found');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch (e) {
  throw new Error('WebGL not supported: ' + (e && e.message ? e.message : String(e)));
}

if (!renderer) throw new Error('WebGL renderer initialization failed');

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xe4e2dd, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 9);
camera.lookAt(0, 0, 0);

// lights
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d6cf, 1.2));
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(5, 6, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xfff1e0, 0.6); fill.position.set(-6, 2, 3); scene.add(fill);
const rim = new THREE.PointLight(0xff5a00, 0.6, 30); rim.position.set(-5, -3, -2); scene.add(rim);

// =====================================================================
// Globe
// =====================================================================
const globe = new Globe(scene);
globe.load().catch(e => showError('Map data failed to load: ' + e.message));

// Touch handles — one per voice (khaen, phin, so, klong)
const voiceColors = [0xff5a00, 0x1d1d1b, 0x7a7770, 0xc4320a];
const voiceLabels = ['khaen', 'phin', 'so', 'klong'];
const handles = voiceColors.map((c, i) => {
  const g = new THREE.SphereGeometry(0.07, 18, 18);
  const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.25 });
  const mesh = new THREE.Mesh(g, m);
  mesh.userData = { voice: i, intensity: 0.0 };
  mesh.visible = false; // shown once the voice strikes a cable
  scene.add(mesh);
  return mesh;
});

function positionHandle(h) {
  const s = 1 + h.userData.intensity * 1.5;
  h.scale.setScalar(s);
}

// =====================================================================
// Resize
// =====================================================================
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// =====================================================================
// Pointer / touch — pick the nearest cable
// =====================================================================
const activePointers = new Map(); // pointerId -> voice index
const cableVal = document.getElementById('cable-val');

function activeVoiceIndex() {
  // The voice currently "highlighted" in the UI; first .on voice button wins.
  const on = document.querySelector('.voices .v.on');
  return on ? parseInt(on.dataset.voice, 10) : 0;
}

function strikeAt(pointerId, clientX, clientY, intensity) {
  const hit = globe.pick(clientX, clientY, camera, window.innerWidth, window.innerHeight);
  if (!hit) return; // not on a cable
  const t = hit.t;
  let voice = activePointers.get(pointerId);
  if (voice === undefined) {
    voice = activeVoiceIndex();
    activePointers.set(pointerId, voice);
  }
  const h = handles[voice];
  h.position.copy(hit.point);
  h.visible = true;
  h.userData.intensity = intensity;
  positionHandle(h);
  globe.highlight(voice, hit.cable, voiceColors[voice]);
  if (cableVal) cableVal.textContent = hit.name;

  // Lai × temperament pitch mapping lives in LocalEngine + tuning.js.
  const { midi, hz } = engine.pitchFor(t, intensity);
  send({ type: 'note', voice, midi, hz, velocity: intensity });
}

function release(pointerId) {
  const voice = activePointers.get(pointerId);
  if (voice === undefined) return;
  activePointers.delete(pointerId);
  handles[voice].userData.intensity = 0.0;
  send({ type: 'voice', voice, gate: false });
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  strikeAt(e.pointerId, e.clientX, e.clientY, 0.85);
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  if (!activePointers.has(e.pointerId)) return;
  strikeAt(e.pointerId, e.clientX, e.clientY, 0.85);
});
canvas.addEventListener('pointerup',     e => release(e.pointerId));
canvas.addEventListener('pointercancel', e => release(e.pointerId));
canvas.addEventListener('pointerleave',  e => release(e.pointerId));

// Turn the globe when dragging off the cables
let camYaw = 2.2, camPitch = 0.35, lastSpin = 0;
let lastCam = null;
canvas.addEventListener('pointerdown', e => {
  if (activePointers.has(e.pointerId)) return;
  // we still get here only if the strike missed every cable; treat as orbit
  lastCam = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', e => {
  if (!lastCam || activePointers.has(e.pointerId)) return;
  const dx = e.clientX - lastCam.x; const dy = e.clientY - lastCam.y;
  camYaw   -= dx * 0.005;
  lastSpin = performance.now();
  camPitch = Math.max(-1.1, Math.min(1.1, camPitch + dy * 0.005));
  lastCam = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { lastCam = null; });

// =====================================================================
// SVG patchbay overlay
// =====================================================================
const svg = document.getElementById('patchbay');
const SVG_NS = 'http://www.w3.org/2000/svg';
const voicePts = [];
const busPts = [];
const wireEls = []; // 16 wires

function buildPatchbay() {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const w = window.innerWidth, h = window.innerHeight;
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  // place voice nodes on right edge, bus nodes on left of the right rail
  const xR = w - 110, xL = w - 230;
  // fit between the top bar (or the stacked lai panel on phones) and the console
  const rectOf = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
  const narrow = w <= 760;
  const above = rectOf(narrow ? '.hud-side' : '.hud-top');
  const below = rectOf('.hud-bot');
  const top = (above ? above.bottom : 80) + 30;
  const bot = Math.max(top + 90, (below ? below.top : h - 260) - 46);
  const nB = CHANNELS.length;
  voicePts.length = 0; busPts.length = 0; wireEls.length = 0;
  for (let i = 0; i < 4; i++) voicePts[i] = { x: xR, y: top + (bot - top) * i / 3 };
  for (let i = 0; i < nB; i++) busPts[i] = { x: xL, y: top + (bot - top) * i / (nB - 1) };
  // wires first so nodes draw on top
  for (let v = 0; v < 4; v++) {
    for (let b = 0; b < nB; b++) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#ff5a00');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('opacity', '0.2');
      svg.appendChild(path);
      wireEls.push(path);
    }
  }
  const drawNode = (p, label, color) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 9);
    c.setAttribute('fill', '#f6f5f2'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', '1.5');
    svg.appendChild(c);
    // jack socket
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.setAttribute('r', 3);
    dot.setAttribute('fill', color);
    svg.appendChild(dot);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', p.x); t.setAttribute('y', p.y + 22);
    t.setAttribute('fill', color);
    t.setAttribute('font-family', '"IBM Plex Mono", ui-monospace, monospace');
    t.setAttribute('font-size', '9');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('letter-spacing', '1.5');
    t.textContent = label;
    svg.appendChild(t);
  };
  for (let i = 0; i < 4; i++) drawNode(voicePts[i], voiceLabels[i].toUpperCase(), '#1d1d1b');
  const busLabels = CHANNEL_NAMES;
  for (let i = 0; i < nB; i++) drawNode(busPts[i], busLabels[i], '#7a7770');
}
window.addEventListener('resize', buildPatchbay);
buildPatchbay();

// sends: keys rig, row-major [voice * CHANNELS.length + channel]
function updateWires(sends) {
  let idx = 0;
  const nB = CHANNELS.length;
  for (let v = 0; v < 4; v++) {
    for (let b = 0; b < nB; b++) {
      const a = voicePts[v], c = busPts[b];
      const mid = (a.x + c.x) * 0.5;
      const d = `M${a.x},${a.y} C${mid},${a.y} ${mid},${c.y} ${c.x},${c.y}`;
      const w = wireEls[idx++];
      w.setAttribute('d', d);
      const k = sends[v * nB + b] || 0;
      w.setAttribute('opacity', String(0.1 + k * 0.85));
      w.setAttribute('stroke-width', String(0.5 + k * 2.2));
    }
  }
}

// =====================================================================
// HUD wiring
// =====================================================================
const $ = id => document.getElementById(id);

function bindSlider(id, label) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const val = parseFloat(el.value);
    if (!isNaN(val)) send({ type: 'set', id, value: val });
    if (label) label.textContent = el.value;
  });
}
bindSlider('chaos');
bindSlider('bpm');

const masterEl = $('master');
const masterVal = $('master-val');
if (masterEl) {
  masterEl.addEventListener('input', () => {
    const v = parseFloat(masterEl.value);
    if (!isNaN(v)) {
      send({ type: 'set', id: 'master', value: v });
      if (masterVal) masterVal.textContent = Math.round(v * 100) + '%';
    }
  });
}

const modeButtons = document.querySelectorAll('#modes button');
if (modeButtons && modeButtons.length > 0) {
  modeButtons.forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#modes button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      const mode = parseInt(b.dataset.mode, 10);
      if (!isNaN(mode)) {
        send({ type: 'mode', value: mode });
        afterRetune();
      }
    });
  });
}

const voiceButtons = document.querySelectorAll('.voices .v');
if (voiceButtons && voiceButtons.length > 0) {
  voiceButtons.forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.voices .v').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
}

const drumBtn = $('drum-btn');
if (drumBtn) drumBtn.addEventListener('click', () => send({ type: 'toggle', id: 'drum' }));

const recBtn = $('rec-btn');
let recording = false;
if (recBtn) {
  recBtn.addEventListener('click', () => {
    recording = !recording;
    recBtn.classList.toggle('on', recording);
    send({ type: 'record', on: recording });
  });
}

// =====================================================================
// FX rack
// =====================================================================
const rackEl = $('rack');
const rack = rackEl ? buildRack(rackEl, { engine, synth, send }) : null;
const pageBtns = document.querySelectorAll('.ctrls [data-page]');
function placeRack() {
  // the rack fills the space between the top bar and the bottom console
  const top = document.querySelector('.hud-top'), bot = document.querySelector('.hud-bot');
  if (!rackEl) return;
  rackEl.style.top = (top ? top.getBoundingClientRect().bottom + 6 : 70) + 'px';
  rackEl.style.bottom = (bot ? window.innerHeight - bot.getBoundingClientRect().top + 6 : 220) + 'px';
}
if (rackEl && rack) {
  let page = 'keys';
  const sync = () => pageBtns.forEach(b => b.classList.toggle('on', !rackEl.hidden && b.dataset.page === page));
  // each button opens the rack on its page, or closes it if already there
  const open = p => {
    rackEl.hidden = !rackEl.hidden && page === p;
    page = p; rack.show(p); placeRack(); sync();
  };
  pageBtns.forEach(b => b.addEventListener('click', () => open(b.dataset.page)));
  rackEl.addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) { page = t.dataset.page; sync(); } });
  new MutationObserver(sync).observe(rackEl, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', placeRack);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') rackEl.hidden = true; });
}

// =====================================================================
// Tuning: temperament + key
// =====================================================================
const keyVal = $('key-val');
function afterRetune() {
  if (keyVal) keyVal.textContent = (Tuning.transpose > 0 ? '+' : Tuning.transpose < 0 ? '−' : '±') + Math.abs(Tuning.transpose);
  const scaleVal = $('scale-val');
  if (scaleVal) {
    const lai = Tuning.lai(engine.mode);
    scaleVal.textContent = lai.steps.map((_, i) => Tuning.name(Tuning.degreeMidi(engine.mode, i)).replace(/-?\d+$/, '')).join(' ');
  }
  buildKeyboard();
}
const temperamentEl = $('temperament');
if (temperamentEl) temperamentEl.addEventListener('change', () => {
  send({ type: 'tuning', temperament: temperamentEl.value });
  afterRetune();
});
const shiftKey = d => {
  send({ type: 'tuning', transpose: Math.max(-6, Math.min(6, Tuning.transpose + d)) });
  afterRetune();
};
if ($('key-down')) $('key-down').addEventListener('click', () => shiftKey(-1));
if ($('key-up')) $('key-up').addEventListener('click', () => shiftKey(+1));

// =====================================================================
// Pentatonic keyboard — three octaves of the current lai plus the top tonic.
// Each voice is monophonic, so held keys form a last-note-priority stack.
// =====================================================================
const kbEl = $('keyboard');
let KB_KEYS = 16;
const KB_COMPUTER = 'zxcvbnm,./qwerty'; // one computer key per on-screen key
const keyEls = [];
const held = new Map(); // source id (pointer / keyboard code) -> key index
let heldOrder = [];     // key indices, most recent last

function keyMidi(i) { return Tuning.degreeMidi(engine.mode, i); }

function buildKeyboard() {
  if (!kbEl) return;
  kbEl.textContent = '';
  keyEls.length = 0;
  KB_KEYS = window.innerWidth <= 600 ? 11 : 16; // two octaves on phones
  for (const [src, i] of [...held]) if (i >= KB_KEYS) keyRelease(src);
  const n = Tuning.lai(engine.mode).steps.length;
  for (let i = 0; i < KB_KEYS; i++) {
    const midi = keyMidi(i);
    const el = document.createElement('div');
    el.className = 'key' + (i % n === 0 ? ' tonic' : '') + (heldOrder.includes(i) ? ' down' : '');
    el.dataset.idx = i;
    const c = Tuning.centsOf(midi);
    el.innerHTML = `<span class="kb">${KB_COMPUTER[i] || ''}</span><span class="nm">${Tuning.name(midi)}</span>` +
      `<span class="ct">${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(1)}¢</span>`;
    el.title = `${Tuning.name(midi)} · ${Tuning.hz(midi).toFixed(2)} Hz`;
    kbEl.appendChild(el);
    keyEls.push(el);
  }
}

function playTop(voice) {
  const i = heldOrder[heldOrder.length - 1];
  const midi = keyMidi(i);
  send({ type: 'note', voice, midi, hz: Tuning.hz(midi), velocity: 0.85 });
}

function keyPress(src, i) {
  if (held.get(src) === i) return;
  if (held.has(src)) keyRelease(src, true);
  held.set(src, i);
  heldOrder = heldOrder.filter(k => k !== i).concat(i);
  if (keyEls[i]) keyEls[i].classList.add('down');
  playTop(activeVoiceIndex());
}

function keyRelease(src, gliding = false) {
  if (!held.has(src)) return;
  const i = held.get(src);
  held.delete(src);
  if ([...held.values()].includes(i)) return; // still held by another finger
  heldOrder = heldOrder.filter(k => k !== i);
  if (keyEls[i]) keyEls[i].classList.remove('down');
  if (gliding) return; // keyPress follows immediately
  const voice = activeVoiceIndex();
  if (heldOrder.length) playTop(voice);
  else send({ type: 'note', voice, midi: keyMidi(i), gate: false });
}

function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const k = el && el.closest ? el.closest('.key') : null;
  return k && kbEl.contains(k) ? parseInt(k.dataset.idx, 10) : -1;
}

if (kbEl) {
  kbEl.addEventListener('pointerdown', e => {
    const i = keyAt(e.clientX, e.clientY);
    if (i < 0) return;
    kbEl.setPointerCapture(e.pointerId);
    keyPress('p' + e.pointerId, i);
    e.preventDefault();
  });
  // slide across keys for a glissando
  kbEl.addEventListener('pointermove', e => {
    const src = 'p' + e.pointerId;
    if (!held.has(src)) return;
    const i = keyAt(e.clientX, e.clientY);
    if (i >= 0) keyPress(src, i);
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    kbEl.addEventListener(ev, e => keyRelease('p' + e.pointerId));
  }
}

window.addEventListener('keydown', e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  const i = KB_COMPUTER.indexOf(e.key.toLowerCase());
  if (i < 0 || i >= KB_KEYS) return;
  keyPress('k' + e.code, i);
  e.preventDefault();
});
window.addEventListener('keyup', e => keyRelease('k' + e.code));
window.addEventListener('blur', () => { for (const src of [...held.keys()]) keyRelease(src); });

window.addEventListener('resize', buildKeyboard);
afterRetune();
buildPatchbay();

// =====================================================================
// Animate
// =====================================================================
const clock = new THREE.Clock();
let outLevelSmoothed = 0;

let animationRunning = false;
function animate() {
  try {
    if (!renderer || !scene || !camera || !clock || !handles) {
      console.warn('animate: missing scene objects, skipping frame');
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(animate);
      return;
    }

    const dt = clock.getDelta();
    // orbit camera — back off on narrow (portrait) screens so the globe fits
    const r = Math.max(9, 1.3 * 2.6 / (Math.tan(22.5 * Math.PI / 180) * Math.min(1, camera.aspect)));
    camera.position.x = Math.sin(camYaw) * Math.cos(camPitch) * r;
    camera.position.z = Math.cos(camYaw) * Math.cos(camPitch) * r;
    camera.position.y = Math.sin(camPitch) * r;
    camera.lookAt(0, 0, 0);

    // slow drift once the globe has been left alone for a few seconds
    if (!lastCam && performance.now() - lastSpin > 4000) camYaw += dt * 0.04;

    // voice markers pulse when struck
    if (handles && handles.length > 0) {
      handles.forEach(h => {
        if (h && h.userData) {
          h.userData.intensity *= 0.96;
          positionHandle(h);
        }
      });
    }
    globe.update(outLevelSmoothed);

    renderer.render(scene, camera);

    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(animate);
    }
  } catch (e) {
    console.error('animate error:', e);
    showError('Animation error: ' + (e && e.message ? e.message : String(e)));
  }
}

try {
  if (typeof requestAnimationFrame !== 'undefined') {
    animationRunning = true;
    animate();
  } else {
    console.error('requestAnimationFrame not supported');
  }
} catch (e) {
  console.error('Failed to start animation:', e);
  showError('Failed to start animation: ' + (e && e.message ? e.message : String(e)));
}

// =====================================================================
// HUD refresh from the engine snapshot
// =====================================================================
function updateHud(m) {
  if (!m) return;

  const outBar = $('out-bar');
  if (outBar) outBar.style.width = Math.min(100, (m.out_level || 0) * 600) + '%';

  const bpmVal = $('bpm-val');
  if (bpmVal && m.bpm !== undefined) bpmVal.textContent = (m.bpm || 0).toFixed(0);

  const chaosVal = $('chaos-val');
  if (chaosVal && m.chaos !== undefined) chaosVal.textContent = Math.round((m.chaos || 0) * 100) + '%';

  outLevelSmoothed += ((m.out_level || 0) - outLevelSmoothed) * 0.18;
  if (m.sends) updateWires(m.sends);
  if (rack) rack.update(m);

  // drum + rec buttons follow the engine (REC stops itself if recording fails)
  if (drumBtn && m.drum_on !== undefined) drumBtn.classList.toggle('on', m.drum_on);
  if (recBtn && m.recording !== undefined && recording !== m.recording) {
    recording = m.recording;
    recBtn.classList.toggle('on', recording);
  }

  if (audioStatus) {
    const st = synth.ctx ? synth.ctx.state : 'none';
    audioStatus.textContent = audioError ? 'AUDIO ERROR' : st === 'running' ? 'AUDIO ON' : st === 'none' ? 'TAP TO START' : 'TAP FOR SOUND';
    audioStatus.classList.toggle('warn', !!audioError || (st !== 'running' && st !== 'none'));
  }
}

// Engine clock: qubit drift, routing, klong + ching groove, HUD refresh.
let lastStep = performance.now();
setInterval(() => {
  const now = performance.now();
  engine.step(Math.min(0.2, (now - lastStep) / 1000));
  lastStep = now;
  updateHud(engine.snapshot());
}, 33);
