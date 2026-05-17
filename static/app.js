// tezeta — 3D Lissajous touch UI + SVG patchbay overlay.
//
// • The Lissajous curve (x = sin(a·t+δ), y = sin(b·t), z = sin(c·t+φ)) lives in
//   Three.js as a TubeGeometry. Three 'a', 'b', 'c' ratios are entangled with
//   the qubit router on the server — the geometry breathes with them.
// • Touch on the curve to play. The hit point is projected onto the closest
//   parametric t, mapped to a 5-note window of the current qenet mode, and
//   sent up over WebSocket as { type:'lissajous', voice, t, intensity }.
// • The SVG patchbay overlay shows the 16 qubit-driven send levels as wires
//   between voice nodes (left) and bus nodes (right). Drag a wire to bias the
//   base routing matrix.
//
// No audio is ever played in the browser — the Pi is the only output.

import * as THREE from './vendor/three.module.js';

// =====================================================================
// Web Audio Synth
// =====================================================================
const synth = new TezetaSynth();
let audioReady = false;

async function initAudio() {
  try {
    await synth.init();
    audioReady = true;
    console.log('Audio synth ready');
  } catch (e) {
    console.error('Audio init failed:', e);
  }
}

// Resume audio on first user interaction (browser autoplay policy)
function resumeAudio() {
  if (audioReady) synth.resume();
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

// Resume audio on user interaction
document.addEventListener('click', resumeAudio, { once: true });
document.addEventListener('touchstart', resumeAudio, { once: true });
document.addEventListener('keydown', resumeAudio, { once: true });

window.addEventListener('unhandledrejection', e => {
  let msg = 'Unhandled Promise rejection';
  if (e && e.reason) {
    msg = e.reason && e.reason.message ? String(e.reason.message) : String(e.reason);
  }
  showError(msg);
});

// =====================================================================
// WebSocket
// =====================================================================
const wsStatus = document.getElementById('ws-status');
let ws = null;
const queued = [];
function connect() {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open',  () => {
      if (wsStatus) wsStatus.textContent = 'LINKED';
      while (queued.length) {
        try { ws.send(queued.shift()); } catch (e) { console.error('WebSocket send error:', e); }
      }
    });
    ws.addEventListener('close', () => {
      if (wsStatus) wsStatus.textContent = 'LOST — RECONNECTING';
      setTimeout(connect, 1500);
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
  try {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1) ws.send(s); else queued.push(s);
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
renderer.setClearColor(0x03060a, 1);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x03060a, 9, 30);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 9);
camera.lookAt(0, 0, 0);

// lights
scene.add(new THREE.AmbientLight(0x224060, 0.55));
const key = new THREE.DirectionalLight(0xfcdd09, 1.2); key.position.set(5, 6, 5); scene.add(key);
const rim = new THREE.PointLight(0x157a3c, 1.0, 30); rim.position.set(-5, -3, -2); scene.add(rim);

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

const tubeMat = new THREE.MeshStandardMaterial({
  color: 0xfcdd09, emissive: 0xda121a, emissiveIntensity: 0.35,
  metalness: 0.45, roughness: 0.3,
});
let tubeMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, curveSegments, 0.06, 12, false), tubeMat);
scene.add(tubeMesh);

// ghost outline (extra glow)
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x157a3c, transparent: true, opacity: 0.18, side: THREE.BackSide });
let ghostMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, curveSegments, 0.18, 12, false), ghostMat);
scene.add(ghostMesh);

function rebuildCurve() {
  curve = new LissajousCurve(lissA, lissB, lissC, Math.PI / 2, 0);
  tubeMesh.geometry.dispose();
  tubeMesh.geometry = new THREE.TubeGeometry(curve, curveSegments, 0.06, 12, false);
  ghostMesh.geometry.dispose();
  ghostMesh.geometry = new THREE.TubeGeometry(curve, curveSegments, 0.18, 12, false);
}

// Touch handles — one per voice (krar, masinko, washint, kebero)
const voiceColors = [0xfcdd09, 0xffffff, 0x157a3c, 0xda121a];
const voiceLabels = ['krar', 'masinko', 'washint', 'kebero'];
const handles = voiceColors.map((c, i) => {
  const g = new THREE.SphereGeometry(0.18, 18, 18);
  const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.2 });
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

  // Map curve parameter t to pitch (5-note window, ~qenet mode)
  const baseNote = 440; // A4
  const notes = [0, 2, 3, 5, 7]; // pentatonic intervals in semitones
  const noteIdx = Math.round(t * (notes.length - 1));
  const interval = notes[noteIdx] / 12; // convert to octaves
  const hz = baseNote * Math.pow(2, interval);

  // Trigger synth voice
  if (audioReady) {
    synth.setGate(voice, true);
    synth.setPitch(voice, hz);
  }

  send({ type: 'lissajous', voice, t, intensity });
}

function release(pointerId) {
  const voice = activePointers.get(pointerId);
  if (voice === undefined) return;
  activePointers.delete(pointerId);
  handles[voice].userData.intensity = 0.0;

  // Release synth voice
  if (audioReady) {
    synth.setGate(voice, false);
  }

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
  const ys = [h * 0.30, h * 0.45, h * 0.60, h * 0.75];
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
      path.setAttribute('stroke', '#fcdd09');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('opacity', '0.2');
      svg.appendChild(path);
      wireEls.push(path);
    }
  }
  const drawNode = (p, label, color) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 12);
    c.setAttribute('fill', '#03060a'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', p.x); t.setAttribute('y', p.y + 28);
    t.setAttribute('fill', color);
    t.setAttribute('font-family', 'ui-monospace, monospace');
    t.setAttribute('font-size', '9');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('letter-spacing', '1.5');
    t.textContent = label;
    svg.appendChild(t);
  };
  for (let i = 0; i < 4; i++) drawNode(voicePts[i], voiceLabels[i].toUpperCase(), '#fcdd09');
  const busLabels = ['DRY', 'REV', 'DLY', 'DARK'];
  for (let i = 0; i < 4; i++) drawNode(busPts[i], busLabels[i], '#157a3c');
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
bindSlider('root');
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
      if (audioReady) synth.setMaster(v);
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
      if (!isNaN(mode)) send({ type: 'mode', value: mode });
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
      tubeMat.emissiveIntensity = 0.25 + Math.max(0, Math.min(1.2, outLevelSmoothed * 1.2));
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
    document.querySelectorAll('#modes button').forEach(b => {
      const btnMode = parseInt(b.dataset.mode, 10);
      b.classList.toggle('on', !isNaN(btnMode) && btnMode === m.mode);
    });
  }
}

connect();
