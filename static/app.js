// morlam — 3D Lissajous touch UI, well-tempered pentatonic keyboard and an
// SVG patchbay overlay.
//
// • The Lissajous curve (x = sin(a·t+δ), y = sin(b·t), z = sin(c·t+φ)) lives in
//   Three.js as a TubeGeometry. Three 'a', 'b', 'c' ratios are entangled with
//   the qubit router on the server — the geometry breathes with them.
// • Touch on the curve to play. The hit point is projected onto the closest
//   parametric t, mapped to a 5-note window of the current lai, and played
//   as { type:'note', voice, midi, hz, velocity }.
// • The keyboard lays the current lai out over three octaves; every pitch is
//   tuned to the selected well temperament (tuning.js).
// • The SVG patchbay overlay shows the 16 qubit-driven send levels as wires
//   between voice nodes (left) and bus nodes (right). Drag a wire to bias the
//   base routing matrix.
//
// Runs two ways:
// • Linked: served by the Rust binary on the Pi; control goes over the WS.
// • Standalone: hosted statically (e.g. GitHub Pages) or with no reachable
//   server — LocalEngine (engine.js) stands in for the Pi and the Web Audio
//   synth (synth.js) plays in the browser.

import * as THREE from './vendor/three.module.js';

// =====================================================================
// Web Audio Synth
// =====================================================================
const synth = new MorlamSynth();
const engine = new LocalEngine(synth);
let audioReady = false;

async function initAudio() {
  try {
    await synth.init();
    audioReady = true;
    engine.retune();
    console.log('Audio synth ready');
  } catch (e) {
    console.error('Audio init failed:', e);
  }
}

// Resume audio on first user interaction (browser autoplay policy).
// Safari may block AudioContext creation outside a gesture, so retry init here.
async function resumeAudio() {
  if (!audioReady) {
    try {
      await synth.init();
      audioReady = true;
      engine.retune();
    } catch (e) {
      console.error('Audio init retry failed:', e);
      return;
    }
  }
  await synth.resume();
  const gate = document.getElementById('start');
  if (gate && synth.ctx && synth.ctx.state === 'running') gate.classList.add('hidden');
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

// Initialize audio on page load
window.addEventListener('load', () => {
  initAudio().catch(console.error);
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
// WebSocket (only when served by the Pi) + standalone fallback
// =====================================================================
const wsStatus = document.getElementById('ws-status');
const params = new URLSearchParams(location.search);
// Static hosts have no /ws endpoint — don't even try.
const STANDALONE = params.has('standalone')
  || location.protocol === 'file:'
  || location.hostname.endsWith('github.io');
let ws = null;
let linked = false;
let everLinked = false;
const queued = [];

function setStatus(text) { if (wsStatus) wsStatus.textContent = text; }

function connect() {
  if (STANDALONE) { setStatus('STANDALONE'); return; }
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open',  () => {
      linked = everLinked = true;
      setStatus('LINKED');
      while (queued.length) {
        try { ws.send(queued.shift()); } catch (e) { console.error('WebSocket send error:', e); }
      }
    });
    ws.addEventListener('close', () => {
      linked = false;
      queued.length = 0;
      // Never reached a server: run standalone, keep probing quietly.
      setStatus(everLinked ? 'LOST — RECONNECTING' : 'STANDALONE');
      setTimeout(connect, everLinked ? 1500 : 10000);
    });
    ws.addEventListener('message', e => {
      try {
        let m = JSON.parse(e.data);
        if (m && m.type === 'tick') onTick(m);
      } catch (err) {
        console.error('Message parse error:', err);
      }
    });
  } catch (e) {
    console.error('WebSocket connection error:', e);
    if (wsStatus) wsStatus.textContent = 'CONNECTION ERROR';
  }
}
function send(obj) {
  // Recording happens on the Pi when linked, in the browser otherwise.
  if (!(obj.type === 'record' && linked)) {
    try { engine.handle(obj); } catch (e) { console.error('Engine error:', e); }
  }
  if (STANDALONE || (!linked && !everLinked)) return;
  try {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1) ws.send(s); else if (queued.length < 64) queued.push(s);
  } catch (e) {
    console.error('Send error:', e);
  }
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
renderer.setClearColor(0x0b0d10, 1);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0d10, 9, 30);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 9);
camera.lookAt(0, 0, 0);

// lights
scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x1a1c20, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(5, 6, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xffb000, 0.8); fill.position.set(-6, 2, 3); scene.add(fill);
const rim = new THREE.PointLight(0xff5a1f, 1.2, 30); rim.position.set(-5, -3, -2); scene.add(rim);

// =====================================================================
// Lissajous 3D curve
// =====================================================================
class LissajousCurve extends THREE.Curve {
  constructor(a, b, c, dPhase, ePhase) {
    super();
    this.a = a; this.b = b; this.c = c;
    this.dPhase = dPhase; this.ePhase = ePhase;
    this.scale = 2.6;
  }
  getPoint(t, opt) {
    const u = t * Math.PI * 2;
    const x = Math.sin(this.a * u + this.dPhase);
    const y = Math.sin(this.b * u);
    const z = Math.sin(this.c * u + this.ePhase);
    const p = opt || new THREE.Vector3();
    return p.set(x * this.scale, y * this.scale, z * this.scale);
  }
}

let lissA = 3, lissB = 2, lissC = 5;
let curve = new LissajousCurve(lissA, lissB, lissC, Math.PI / 2, 0);
let curveSegments = 320;

// polished steel cable that glows amber-hot with the output level
const tubeMat = new THREE.MeshStandardMaterial({
  color: 0xb8c0c8, emissive: 0xff7a00, emissiveIntensity: 0.25,
  metalness: 0.9, roughness: 0.28, flatShading: false,
});
let tubeMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, curveSegments, 0.06, 12, false), tubeMat);
scene.add(tubeMesh);

// ghost outline (extra glow)
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.08, side: THREE.BackSide });
let ghostMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, curveSegments, 0.18, 12, false), ghostMat);
scene.add(ghostMesh);

function rebuildCurve() {
  curve = new LissajousCurve(lissA, lissB, lissC, Math.PI / 2, 0);
  tubeMesh.geometry.dispose();
  tubeMesh.geometry = new THREE.TubeGeometry(curve, curveSegments, 0.06, 12, false);
  ghostMesh.geometry.dispose();
  ghostMesh.geometry = new THREE.TubeGeometry(curve, curveSegments, 0.18, 12, false);
}

// Machined cogs turning slowly behind the curve.
function makeGear(teeth, rOuter, rInner, rHole, depth) {
  const shape = new THREE.Shape();
  const n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = (i % 4 === 0 || i % 4 === 1) ? rOuter : rInner;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, rHole, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, curveSegments: 24 });
}
const gearMat = new THREE.MeshStandardMaterial({ color: 0x4a525b, metalness: 0.85, roughness: 0.45 });
const gears = [
  { mesh: new THREE.Mesh(makeGear(28, 4.6, 4.25, 3.7, 0.18), gearMat), spin: 0.05 },
  { mesh: new THREE.Mesh(makeGear(14, 2.2, 1.9, 0.9, 0.22), gearMat), spin: -0.1 },
];
gears[0].mesh.position.set(0, 0, -4.5);
gears[1].mesh.position.set(5.1, -3.6, -4.6);
for (const g of gears) scene.add(g.mesh);

// Touch handles — one per voice (khaen, phin, so, klong)
const voiceColors = [0xffb000, 0xe3e8ed, 0x39ff6a, 0xff5a1f];
const voiceLabels = ['khaen', 'phin', 'so', 'klong'];
const handles = voiceColors.map((c, i) => {
  const g = new THREE.SphereGeometry(0.18, 18, 18);
  const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.25 });
  const mesh = new THREE.Mesh(g, m);
  mesh.userData = { voice: i, t: i * 0.25, intensity: 0.0 };
  scene.add(mesh);
  return mesh;
});

function positionHandle(h) {
  const p = curve.getPoint(h.userData.t);
  h.position.copy(p);
  const s = 0.6 + h.userData.intensity * 1.3;
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
// Pointer / touch — pick closest point on the curve
// =====================================================================
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const activePointers = new Map(); // pointerId -> voice index

function clientToNDC(x, y) { ndc.x = (x / window.innerWidth) * 2 - 1; ndc.y = -(y / window.innerHeight) * 2 + 1; }

// Approximate nearest-t by sampling the curve coarsely (32 pts) and refining locally.
const SAMPLE_N = 96;
const sampleBuf = new Float32Array(SAMPLE_N * 3);
function resampleBuf() {
  const p = new THREE.Vector3();
  for (let i = 0; i < SAMPLE_N; i++) {
    curve.getPoint(i / (SAMPLE_N - 1), p);
    sampleBuf[i*3] = p.x; sampleBuf[i*3+1] = p.y; sampleBuf[i*3+2] = p.z;
  }
}
resampleBuf();

function pickT(clientX, clientY) {
  clientToNDC(clientX, clientY);
  raycaster.setFromCamera(ndc, camera);
  // Project each sample to screen; pick the one with min screen-space distance.
  const tmp = new THREE.Vector3();
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < SAMPLE_N; i++) {
    tmp.set(sampleBuf[i*3], sampleBuf[i*3+1], sampleBuf[i*3+2]).project(camera);
    const dx = tmp.x - ndc.x, dy = tmp.y - ndc.y;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return { t: bestI / (SAMPLE_N - 1), distSq: bestD };
}

function activeVoiceIndex() {
  // The voice currently "highlighted" in the UI; first .on voice button wins.
  const on = document.querySelector('.voices .v.on');
  return on ? parseInt(on.dataset.voice, 10) : 0;
}

function strikeAt(pointerId, clientX, clientY, intensity) {
  const { t, distSq } = pickT(clientX, clientY);
  if (distSq > 0.05) return; // too far from curve — ignore
  let voice = activePointers.get(pointerId);
  if (voice === undefined) {
    voice = activeVoiceIndex();
    activePointers.set(pointerId, voice);
  }
  handles[voice].userData.t = t;
  handles[voice].userData.intensity = intensity;
  positionHandle(handles[voice]);

  // Lai × temperament pitch mapping lives in LocalEngine + tuning.js; the
  // Pi just receives the resulting pitch.
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

// Camera orbit when dragging outside the curve (only when no active pointer is "on" the curve)
let camYaw = 0, camPitch = 0.05;
let lastCam = null;
canvas.addEventListener('pointerdown', e => {
  if (activePointers.has(e.pointerId)) return;
  // we still get here only if the strike missed the curve; treat as orbit
  lastCam = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', e => {
  if (!lastCam || activePointers.has(e.pointerId)) return;
  const dx = e.clientX - lastCam.x; const dy = e.clientY - lastCam.y;
  camYaw   += dx * 0.005;
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
  const ys = [0, 1, 2, 3].map(i => top + (bot - top) * i / 3);
  voicePts.length = 0; busPts.length = 0; wireEls.length = 0;

  for (let i = 0; i < 4; i++) {
    voicePts[i] = { x: xR, y: ys[i] };
    busPts[i]   = { x: xL, y: ys[i] };
  }
  // wires first so nodes draw on top
  for (let v = 0; v < 4; v++) {
    for (let b = 0; b < 4; b++) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#ffb000');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('opacity', '0.2');
      svg.appendChild(path);
      wireEls.push(path);
    }
  }
  const drawNode = (p, label, color) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 12);
    c.setAttribute('fill', '#2b3036'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
    // hex socket in the middle of each jack
    const hex = document.createElementNS(SVG_NS, 'polygon');
    hex.setAttribute('points', [0, 1, 2, 3, 4, 5].map(k => {
      const a = Math.PI / 6 + k * Math.PI / 3;
      return `${p.x + Math.cos(a) * 5},${p.y + Math.sin(a) * 5}`;
    }).join(' '));
    hex.setAttribute('fill', '#0b0d10');
    svg.appendChild(hex);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', p.x); t.setAttribute('y', p.y + 28);
    t.setAttribute('fill', color);
    t.setAttribute('font-family', '"Share Tech Mono", ui-monospace, monospace');
    t.setAttribute('font-size', '9');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('letter-spacing', '1.5');
    t.textContent = label;
    svg.appendChild(t);
  };
  for (let i = 0; i < 4; i++) drawNode(voicePts[i], voiceLabels[i].toUpperCase(), '#ffb000');
  const busLabels = ['DRY', 'REV', 'DLY', 'DARK'];
  for (let i = 0; i < 4; i++) drawNode(busPts[i], busLabels[i], '#c9cfd6');
}
window.addEventListener('resize', buildPatchbay);
buildPatchbay();

function updateWires(qcoef) {
  let idx = 0;
  for (let v = 0; v < 4; v++) {
    for (let b = 0; b < 4; b++) {
      const a = voicePts[v], c = busPts[b];
      const mid = (a.x + c.x) * 0.5;
      const d = `M${a.x},${a.y} C${mid},${a.y} ${mid},${c.y} ${c.x},${c.y}`;
      const w = wireEls[idx++];
      w.setAttribute('d', d);
      w.setAttribute('opacity', String(0.15 + qcoef[v*4 + b] * 0.85));
      w.setAttribute('stroke-width', String(0.5 + qcoef[v*4 + b] * 2.2));
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
bindSlider('reverb_mix');
bindSlider('delay_fb');

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
// Tuning: temperament + key
// =====================================================================
const keyVal = $('key-val');
function afterRetune() {
  // Keep the Pi's root (drone + drum pitch) in step with the browser tuning.
  send({ type: 'set', id: 'root', value: engine.root });
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
let smoothA = 3, smoothB = 2, smoothC = 5;
let outLevelSmoothed = 0;

let animationRunning = false;
function animate() {
  try {
    if (!renderer || !scene || !camera || !clock || !curve || !handles || !tubeMat) {
      console.warn('animate: missing scene objects, skipping frame');
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(animate);
      return;
    }

    const dt = clock.getDelta();
    // smooth toward server-reported Lissajous ratios
    smoothA += (lissA - smoothA) * 0.05;
    smoothB += (lissB - smoothB) * 0.05;
    smoothC += (lissC - smoothC) * 0.05;
    if (Math.abs(smoothA - curve.a) > 0.05 || Math.abs(smoothB - curve.b) > 0.05 || Math.abs(smoothC - curve.c) > 0.05) {
      curve.a = smoothA; curve.b = smoothB; curve.c = smoothC;
      rebuildCurve();
      resampleBuf();
    }
    // orbit camera
    const r = 9;
    camera.position.x = Math.sin(camYaw) * Math.cos(camPitch) * r;
    camera.position.z = Math.cos(camYaw) * Math.cos(camPitch) * r;
    camera.position.y = Math.sin(camPitch) * r;
    camera.lookAt(0, 0, 0);

    for (const g of gears) g.mesh.rotation.z += g.spin * dt * (1 + outLevelSmoothed * 6);

    // handles ride the curve
    if (handles && handles.length > 0) {
      handles.forEach(h => {
        if (h && h.userData) {
          h.userData.intensity *= 0.96;
          positionHandle(h);
        }
      });
    }
    // tube emissive responds to overall output level (set in onTick)
    if (tubeMat && typeof outLevelSmoothed === 'number') {
      tubeMat.emissiveIntensity = 0.15 + Math.max(0, Math.min(1.2, outLevelSmoothed * 1.5));
    }

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
// Tick from server
// =====================================================================
function onTick(m) {
  if (!m) return;

  const inBar = $('in-bar');
  const outBar = $('out-bar');
  if (inBar) inBar.style.width = Math.min(100, (m.in_level || 0) * 600) + '%';
  if (outBar) outBar.style.width = Math.min(100, (m.out_level || 0) * 600) + '%';

  const bpmVal = $('bpm-val');
  if (bpmVal && m.bpm !== undefined) bpmVal.textContent = (m.bpm || 0).toFixed(0);

  const chaosVal = $('chaos-val');
  if (chaosVal && m.chaos !== undefined) chaosVal.textContent = Math.round((m.chaos || 0) * 100) + '%';

  const lissVal = $('liss-val');
  if (lissVal && m.liss_a !== undefined && m.liss_b !== undefined && m.liss_c !== undefined) {
    lissVal.textContent = `${(m.liss_a || 0).toFixed(1)} : ${(m.liss_b || 0).toFixed(1)} : ${(m.liss_c || 0).toFixed(1)}`;
  }

  outLevelSmoothed += ((m.out_level || 0) - outLevelSmoothed) * 0.18;
  if (m.liss_a !== undefined) lissA = m.liss_a;
  if (m.liss_b !== undefined) lissB = m.liss_b;
  if (m.liss_c !== undefined) lissC = m.liss_c;
  if (m.qcoef) updateWires(m.qcoef);

  // sync master + chaos sliders without triggering input events
  if (masterEl && masterVal && m.master !== undefined) {
    if (Math.abs(parseFloat(masterEl.value) - m.master) > 0.01) {
      masterEl.value = m.master;
      masterVal.textContent = Math.round(m.master * 100) + '%';
    }
  }

  // sync drum + rec + mode buttons
  if (drumBtn && m.drum_on !== undefined) drumBtn.classList.toggle('on', m.drum_on);
  if (recBtn && m.recording !== undefined) {
    if (recBtn.classList.contains('on') !== m.recording) {
      recording = m.recording;
      recBtn.classList.toggle('on', recording);
    }
  }
  if (m.mode !== undefined) {
    if (m.mode !== engine.mode && m.mode >= 1 && m.mode <= LAI_COUNT) {
      engine.handle({ type: 'mode', value: m.mode });
      afterRetune();
    }
    document.querySelectorAll('#modes button').forEach(b => {
      const btnMode = parseInt(b.dataset.mode, 10);
      b.classList.toggle('on', !isNaN(btnMode) && btnMode === m.mode);
    });
  }
}

// Local engine clock: qubit drift, routing, kebero groove. When no Pi is
// linked it also feeds the UI the same `tick` the server would send.
let lastStep = performance.now();
setInterval(() => {
  const now = performance.now();
  engine.step(Math.min(0.2, (now - lastStep) / 1000));
  lastStep = now;
  if (!linked) onTick(engine.tick());
}, 33);

if (STANDALONE || !everLinked) {
  const hint = document.querySelector('.hud-side .hint');
  if (hint) hint.innerHTML = 'Play the keyboard (mouse, touch or <b>Z…/</b> &amp; <b>Q…Y</b>) or touch the curve.<br>Voices: <b>khaen · phin · so · klong</b>.<br>Drag off the curve to orbit.';
}

connect();
