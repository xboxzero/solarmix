// SolarMix — minimal 3D water UI.
// Touch/drag the orb to control frequency (x), amp (y), and quantum chaos (z).
// Water surface deforms from quantum signals + audio output level.
// Three.js is self-hosted under /vendor/ so it works offline on the Pi.

import * as THREE from './vendor/three.module.js';

// surface any load error so it's visible on screen (Safari sometimes hides them)
window.addEventListener('error', e => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:60px;left:20px;right:20px;background:#3a0808;color:#ffeaea;padding:14px;border:1px solid #ff5050;border-radius:6px;font-family:monospace;font-size:12px;z-index:100;white-space:pre-wrap';
  d.textContent = 'JS error: ' + (e.error ? (e.error.stack || e.message) : e.message);
  document.body.appendChild(d);
});

// ---------- WebSocket ----------
const wsStatus = document.getElementById('ws-status');
let ws = null;
const queued = [];

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    wsStatus.textContent = 'LINKED';
    while (queued.length) ws.send(queued.shift());
  });
  ws.addEventListener('close', () => {
    wsStatus.textContent = 'LOST — RECONNECTING';
    setTimeout(connect, 1500);
  });
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'tick') onTick(m);
  });
}
function send(obj) {
  const s = JSON.stringify(obj);
  if (ws && ws.readyState === 1) ws.send(s);
  else queued.push(s);
}

// ---------- Three.js scene ----------
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x03060a, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x03060a, 8, 28);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 4.5, 9);
camera.lookAt(0, 0, 0);

// Lighting
const amb = new THREE.AmbientLight(0x4060a0, 0.45);
scene.add(amb);
const key = new THREE.DirectionalLight(0xffd47a, 1.4);
key.position.set(4, 8, 5);
scene.add(key);
const rim = new THREE.PointLight(0x5fa8ff, 0.9, 25);
rim.position.set(-5, 3, -3);
scene.add(rim);

// ---------- Water surface (deformable plane) ----------
const WATER_SIZE = 18;
const WATER_SEG = 80;
const waterGeo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, WATER_SEG, WATER_SEG);
waterGeo.rotateX(-Math.PI / 2);

const waterMat = new THREE.MeshStandardMaterial({
  color: 0x0a1a2a,
  metalness: 0.6,
  roughness: 0.25,
  flatShading: false,
  side: THREE.DoubleSide,
});
const water = new THREE.Mesh(waterGeo, waterMat);
water.position.y = -0.5;
scene.add(water);

// store baseline positions for water deformation
const basePos = waterGeo.attributes.position.array.slice();
const waveState = { q0: 0, q1: 0, q2: 0, q3: 0, level: 0, t: 0 };

// ---------- Orb (the touchable controller) ----------
const orbGeo = new THREE.IcosahedronGeometry(0.55, 2);
const orbMat = new THREE.MeshStandardMaterial({
  color: 0xffd47a,
  emissive: 0xff8a20,
  emissiveIntensity: 0.6,
  metalness: 0.3,
  roughness: 0.35,
});
const orb = new THREE.Mesh(orbGeo, orbMat);
orb.position.set(0, 0.6, 0);
scene.add(orb);

// halo around the orb
const haloGeo = new THREE.RingGeometry(0.7, 0.92, 64);
const haloMat = new THREE.MeshBasicMaterial({
  color: 0xffd47a, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
});
const halo = new THREE.Mesh(haloGeo, haloMat);
halo.rotateX(-Math.PI / 2);
halo.position.y = -0.48;
scene.add(halo);

// reflection of orb in water (cheap — flip Y)
const orbShadowGeo = new THREE.CircleGeometry(0.55, 32);
const orbShadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 });
const orbShadow = new THREE.Mesh(orbShadowGeo, orbShadowMat);
orbShadow.rotateX(-Math.PI / 2);
orbShadow.position.y = -0.49;
scene.add(orbShadow);

// ---------- Resize ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- Drag the orb in 3D ----------
// Map screen coords -> orb position on a virtual XY plane at y=0.6.
// Z (depth) is changed by two-finger pinch or wheel.
const raycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
const ndc = new THREE.Vector2();
let dragging = false;
let orbZ = 0;            // current Z on plane (front/back)
let orbXY = new THREE.Vector3();

function clientToNDC(x, y) {
  ndc.x = (x / window.innerWidth) * 2 - 1;
  ndc.y = -(y / window.innerHeight) * 2 + 1;
}

function pickOrPlane(clientX, clientY) {
  clientToNDC(clientX, clientY);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, hit);
  return hit;
}

function startDrag(e) {
  const t = e.touches ? e.touches[0] : e;
  dragging = true;
  canvas.classList.add('grabbing');
  const p = pickOrPlane(t.clientX, t.clientY);
  if (p) {
    orb.position.x = THREE.MathUtils.clamp(p.x, -4, 4);
    orb.position.z = THREE.MathUtils.clamp(p.z, -3, 3);
    sendOrb();
  }
  if (e.cancelable) e.preventDefault();
}
function moveDrag(e) {
  if (!dragging) return;
  // single-finger drag: x/z on plane. Multi-touch handled in pinch listener.
  if (e.touches && e.touches.length > 1) return;
  const t = e.touches ? e.touches[0] : e;
  const p = pickOrPlane(t.clientX, t.clientY);
  if (p) {
    orb.position.x = THREE.MathUtils.clamp(p.x, -4, 4);
    orb.position.z = THREE.MathUtils.clamp(p.z, -3, 3);
    // also lift the orb a bit while dragging vertically across the screen
    // so users without a wheel/pinch still get amp control
    const yScreen = (t.clientY / window.innerHeight); // 0 top, 1 bottom
    orb.position.y = THREE.MathUtils.lerp(2.0, 0.2, yScreen);
    sendOrb();
  }
  if (e.cancelable) e.preventDefault();
}
function endDrag() {
  dragging = false;
  canvas.classList.remove('grabbing');
}

// Wheel / pinch controls Y (amp). Mouse wheel up = louder; pinch in = louder.
function onWheel(e) {
  orb.position.y = THREE.MathUtils.clamp(orb.position.y - e.deltaY * 0.003, 0.1, 2.2);
  sendOrb();
  e.preventDefault();
}

canvas.addEventListener('mousedown', startDrag);
window.addEventListener('mousemove', moveDrag);
window.addEventListener('mouseup', endDrag);
canvas.addEventListener('touchstart', startDrag, { passive: false });
canvas.addEventListener('touchmove', moveDrag, { passive: false });
canvas.addEventListener('touchend', endDrag);
canvas.addEventListener('touchcancel', endDrag);
canvas.addEventListener('wheel', onWheel, { passive: false });
// also accept pointerdown for stylus / Apple Pencil
canvas.addEventListener('pointerdown', startDrag);

// two-finger pinch on touch devices for the Y axis
let lastPinch = null;
canvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const a = e.touches[0], b = e.touches[1];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (lastPinch != null) {
      const delta = d - lastPinch;
      orb.position.y = THREE.MathUtils.clamp(orb.position.y + delta * 0.006, 0.1, 2.2);
      sendOrb();
    }
    lastPinch = d;
    e.preventDefault();
  } else {
    lastPinch = null;
  }
}, { passive: false });

function sendOrb() {
  // Orb is the "frequencies + chaos mixer":
  //   x -> reverb wet/dry
  //   y -> tape echo feedback (from drag-up = louder)
  //   z -> quantum chaos (pinch/wheel)
  const nx = THREE.MathUtils.clamp(orb.position.x / 4, -1, 1);
  const ny = THREE.MathUtils.clamp((orb.position.y - 0.1) / 2.1 * 2 - 1, -1, 1);
  const nz = THREE.MathUtils.clamp(orb.position.z / 3, -1, 1);
  send({ type: 'orb', x: nx, y: ny, z: nz });
  // local readout (mirrors server-side mapping)
  const r = Math.min(1, Math.hypot(nx, ny));
  const lmin = Math.log(60), lmax = Math.log(1500);
  const freq = Math.exp(lmin + r * (lmax - lmin));
  document.getElementById('freq-val').textContent = freq.toFixed(0) + ' Hz';
  document.getElementById('rev-val').textContent = (((nx + 1) * 0.5) * 85).toFixed(0) + '%';
  document.getElementById('del-val').textContent = (((ny + 1) * 0.5) * 85).toFixed(0) + '%';
  document.getElementById('chaos-val').textContent = (((nz + 1) * 0.5) * 100).toFixed(0) + '%';
}

// ---------- Animate ----------
const clock = new THREE.Clock();

function animate() {
  const dt = clock.getDelta();
  waveState.t += dt;

  // smooth wave-state toward latest quantum + level values
  // (assigned in onTick)
  const pos = waterGeo.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    const x = basePos[i], z = basePos[i + 2];
    const r = Math.hypot(x, z);
    // four overlapping waves whose phases/amps come from the quantum signals
    const w =
      Math.sin(x * 0.6 + waveState.t * 1.2 + waveState.q0 * 3.0) * 0.10 * (0.5 + Math.abs(waveState.q0)) +
      Math.sin(z * 0.45 + waveState.t * 0.9 - waveState.q1 * 2.4) * 0.09 * (0.5 + Math.abs(waveState.q1)) +
      Math.cos((x + z) * 0.32 + waveState.t * 0.6 + waveState.q2 * 2.0) * 0.07 +
      Math.cos((x - z) * 0.5 + waveState.t * 1.4 - waveState.q3 * 1.8) * 0.06 +
      // ripple from the orb's XZ position
      Math.cos(Math.hypot(x - orb.position.x, z - orb.position.z) * 2.0 - waveState.t * 6.0)
        * 0.15 / (1.0 + r * 0.6);
    pos[i + 1] = w + waveState.level * 0.4;
  }
  waterGeo.attributes.position.needsUpdate = true;
  waterGeo.computeVertexNormals();

  // orb pulse from output level + quantum
  const pulse = 1 + waveState.level * 0.6 + Math.abs(waveState.q0) * 0.08;
  orb.scale.setScalar(pulse);
  orb.rotation.y += dt * (0.4 + waveState.q1 * 0.8);
  orb.rotation.x += dt * (0.2 + waveState.q2 * 0.4);
  orbMat.emissiveIntensity = 0.4 + waveState.level * 1.4;

  // halo follows orb
  halo.position.set(orb.position.x, halo.position.y, orb.position.z);
  halo.scale.setScalar(1 + waveState.level * 1.2);
  haloMat.opacity = 0.20 + Math.min(0.5, waveState.level * 1.5);

  orbShadow.position.set(orb.position.x, orbShadow.position.y, orb.position.z);
  orbShadow.scale.setScalar(1 + orb.position.y * 0.25);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

// ---------- HUD: presets + drum toggle + record ----------
document.querySelectorAll('#presets button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#presets button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    send({ type: 'preset', value: parseInt(b.dataset.preset, 10) });
  });
});

const playBtn = document.getElementById('play-btn');
playBtn.addEventListener('click', () => {
  send({ type: 'toggle', id: 'drum' });
});

const micBtn = document.getElementById('mic-btn');
micBtn.addEventListener('click', () => {
  send({ type: 'toggle', id: 'mic' });
});

const recBtn = document.getElementById('rec-btn');
let recording = false;
recBtn.addEventListener('click', () => {
  recording = !recording;
  recBtn.classList.toggle('on', recording);
  send({ type: 'record', on: recording });
});

// step bar
const stepsEl = document.getElementById('steps');
const stepDivs = [];
for (let i = 0; i < 16; i++) {
  const d = document.createElement('div');
  d.className = 's';
  stepsEl.appendChild(d);
  stepDivs.push(d);
}

// ---------- Tick handler ----------
let lastStep = -1;
function onTick(m) {
  document.getElementById('in-bar').style.width = Math.min(100, m.in_level * 600) + '%';
  document.getElementById('out-bar').style.width = Math.min(100, m.out_level * 600) + '%';
  document.getElementById('bpm-val').textContent = m.bpm.toFixed(0);

  // smooth wave state toward server-reported q/level
  waveState.q0 += (m.q0 - waveState.q0) * 0.08;
  waveState.q1 += (m.q1 - waveState.q1) * 0.08;
  waveState.q2 += (m.q2 - waveState.q2) * 0.08;
  waveState.q3 += (m.q3 - waveState.q3) * 0.08;
  waveState.level += (m.out_level - waveState.level) * 0.25;

  // chaos affects water color: darker when smooth, more electric when chaotic
  const c = m.chaos;
  const r = 0.04 + c * 0.05;
  const g = 0.10 + c * 0.20;
  const b = 0.18 + c * 0.45;
  waterMat.color.setRGB(r, g, b);

  // step
  if (m.drum_step !== lastStep) {
    if (lastStep >= 0) stepDivs[lastStep].classList.remove('cur');
    if (m.drum_on) stepDivs[m.drum_step].classList.add('cur');
    lastStep = m.drum_step;
  }
  if (!m.drum_on && lastStep >= 0) {
    stepDivs[lastStep].classList.remove('cur');
    lastStep = -1;
  }

  // sync play/rec/mic button states from server
  playBtn.classList.toggle('on', m.drum_on);
  micBtn.classList.toggle('on', m.mic_on);
  // when mic is open AND server is recording, flag the VOX glow on the mic
  // button — distinguishes auto-record from a manual REC press
  micBtn.classList.toggle('vox', m.mic_on && m.recording);
  if (recBtn.classList.contains('on') !== m.recording) {
    recording = m.recording;
    recBtn.classList.toggle('on', recording);
  }

  // sync preset highlight
  document.querySelectorAll('#presets button').forEach(b => {
    b.classList.toggle('on', parseInt(b.dataset.preset, 10) === m.preset);
  });
}

connect();
sendOrb();
