// morlam globe — a dark 3D Earth strung with the world's submarine
// fibre-optic cables, ringed by communication satellites, with the countries
// that run commercial 5G glowing like embers. Each cable is a playable
// string: touch it and the position along the cable (0 → 1) picks the note.
//
// Layers (toggle with setLayer): cables · satellites · 5g
//
// Data (static/data/, built by tools/build_map_data.py and tools/build_sky_data.py):
//   cables.json, landing.json — TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0
//   land.json                 — Natural Earth 1:110m coastlines, public domain
//   sats.json                 — CelesTrak GP orbital elements (snapshot)
//   fiveg.json                — countries with commercial 5G (approximate) + hubs

import * as THREE from './vendor/three.module.js';

export const R = 2.6;               // globe radius (scene units)
const DEG = Math.PI / 180;

export function latLon(lon, lat, r = R, out = new THREE.Vector3()) {
  const phi = (90 - lat) * DEG, th = (lon + 180) * DEG;
  return out.set(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
}

// Unit-sphere great-circle subdivision so long segments hug the surface.
function arcPoints(lon0, lat0, lon1, lat1, r, maxDeg = 2) {
  const a = latLon(lon0, lat0, 1), b = latLon(lon1, lat1, 1);
  const ang = a.angleTo(b), n = Math.max(1, Math.ceil(ang / (maxDeg * DEG)));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = Math.sin(ang) || 1;
    const k0 = ang ? Math.sin((1 - t) * ang) / s : 1 - t, k1 = ang ? Math.sin(t * ang) / s : t;
    pts.push(new THREE.Vector3().addScaledVector(a, k0).addScaledVector(b, k1).normalize().multiplyScalar(r));
  }
  return pts;
}

// Polyline [lon,lat,lon,lat,…] → Vector3[] on the sphere of radius r.
function polyline(flat, r) {
  const pts = [latLon(flat[0], flat[1], r)];
  for (let i = 2; i < flat.length; i += 2) pts.push(...arcPoints(flat[i - 2], flat[i - 1], flat[i], flat[i + 1], r));
  return pts;
}

function segmentsGeometry(lines) {
  let n = 0;
  for (const l of lines) n += (l.length - 1) * 2;
  const pos = new Float32Array(n * 3);
  let k = 0;
  for (const l of lines) for (let i = 0; i < l.length - 1; i++) {
    pos[k++] = l[i].x; pos[k++] = l[i].y; pos[k++] = l[i].z;
    pos[k++] = l[i + 1].x; pos[k++] = l[i + 1].y; pos[k++] = l[i + 1].z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

// Soft round sprite for glowing points.
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

// Greenwich mean sidereal time (radians) for a JS time in ms.
function gmst(ms) {
  const jd = ms / 86400000 + 2440587.5;
  return ((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360) * DEG;
}

// Satellites: circular orbits evaluated on the GPU. Altitude is compressed
// (not to scale) so GEO sits just outside the LEO shells instead of 6 Earth
// radii away.
const SAT_VERT = `
  attribute vec4 orbit;   // n (rad/s), inclination, raan, arg. of latitude at epoch (rad)
  attribute float radius;
  attribute vec3 tint;
  uniform float uTime;    // seconds since the data's reference epoch
  uniform float uGmst;    // Earth rotation angle now
  uniform float uSize;
  varying vec3 vTint;
  void main() {
    float u = orbit.w + orbit.x * uTime;
    float ci = cos(orbit.y), si = sin(orbit.y), cO = cos(orbit.z), sO = sin(orbit.z);
    float cu = cos(u), su = sin(u);
    vec3 eci = radius * vec3(cO * cu - sO * su * ci, sO * cu + cO * su * ci, su * si);
    float cg = cos(uGmst), sg = sin(uGmst);
    vec3 ecef = vec3(eci.x * cg + eci.y * sg, -eci.x * sg + eci.y * cg, eci.z);
    vec4 mv = modelViewMatrix * vec4(ecef.x, ecef.z, -ecef.y, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
    vTint = tint;
  }`;
const SAT_FRAG = `
  uniform sampler2D uTex;
  varying vec3 vTint;
  void main() {
    float a = texture2D(uTex, gl_PointCoord).a;
    gl_FragColor = vec4(vTint * a * 1.4, a);
  }`;

// Embers drifting up around the globe.
const EMBER_VERT = `
  attribute vec3 seed;
  uniform float uTime;
  uniform float uSize;
  varying float vFade;
  void main() {
    float t = fract(seed.z + uTime * 0.035);
    float ang = seed.x * 6.2831 + uTime * 0.05 * (seed.y - 0.5);
    float rad = 3.1 + seed.y * 3.2;
    vec3 p = vec3(cos(ang) * rad, -5.0 + t * 10.0, sin(ang) * rad);
    p.x += sin(uTime * 0.7 + seed.z * 20.0) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + seed.y) * (8.0 / -mv.z);
    vFade = sin(t * 3.14159);
  }`;
const EMBER_FRAG = `
  uniform sampler2D uTex;
  varying float vFade;
  void main() {
    float a = texture2D(uTex, gl_PointCoord).a * vFade;
    gl_FragColor = vec4(vec3(1.0, 0.45, 0.12) * a, a);
  }`;

// Warm rim of light around the globe.
const HALO_VERT = `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const HALO_FRAG = `
  varying vec3 vN; varying vec3 vV;
  void main() {
    float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
    gl_FragColor = vec4(vec3(1.0, 0.42, 0.12) * rim * 0.9, rim);
  }`;

export class Globe {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.cables = [];          // { name, lines: Vector3[][] }
    this.ready = false;
    this.layers = { cables: true, satellites: true, '5g': true };
    this.glow = glowTexture();
    this.t0 = performance.now();
    this.simStart = Date.now();
    this.warp = 60;            // satellite time speed (× real time)
    this.simMs = Date.now();

    // the sphere: weathered dark stone
    this.group.add(new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      new THREE.MeshStandardMaterial({ color: 0x1b1712, roughness: 1, metalness: 0.05 }),
    ));
    // atmosphere rim
    this.group.add(new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.12, 64, 48),
      new THREE.ShaderMaterial({ vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    ));

    // graticule every 30°
    const grat = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const l = []; for (let lon = -180; lon <= 180; lon += 3) l.push(latLon(lon, lat, R * 1.001)); grat.push(l);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const l = []; for (let lat = -90; lat <= 90; lat += 3) l.push(latLon(lon, lat, R * 1.001)); grat.push(l);
    }
    this.group.add(new THREE.LineSegments(segmentsGeometry(grat),
      new THREE.LineBasicMaterial({ color: 0x3a3128, transparent: true, opacity: 0.6 })));

    this.cableGroup = new THREE.Group();
    this.group.add(this.cableGroup);
    this.cableMat = new THREE.LineBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.highlights = new Map(); // voice → mesh

    // embers
    const n = 260, seeds = new Float32Array(n * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.emberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 6 }, uTex: { value: this.glow } },
      vertexShader: EMBER_VERT, fragmentShader: EMBER_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const embers = new THREE.Points(eg, this.emberMat);
    embers.frustumCulled = false;
    scene.add(embers);
  }

  async load(base = 'data/') {
    const get = f => fetch(base + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    const [land, cables, landing] = await Promise.all([get('land.json'), get('cables.json'), get('landing.json')]);

    // coastlines: tarnished gold
    this.group.add(new THREE.LineSegments(segmentsGeometry(land.arcs.map(a => polyline(a, R * 1.002))),
      new THREE.LineBasicMaterial({ color: 0x9c8455 })));

    // cables
    const all = [];
    for (const [name, , flats] of cables.cables) {
      const lines = flats.map(f => polyline(f, R * 1.006));
      this.cables.push({ name, lines });
      all.push(...lines);
    }
    this.cableGroup.add(new THREE.LineSegments(segmentsGeometry(all), this.cableMat));

    // landing stations
    const lp = new Float32Array(landing.points.length * 3);
    const v = new THREE.Vector3();
    landing.points.forEach(([lon, lat], i) => { latLon(lon, lat, R * 1.007, v); lp[i * 3] = v.x; lp[i * 3 + 1] = v.y; lp[i * 3 + 2] = v.z; });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    this.cableGroup.add(new THREE.Points(lg, new THREE.PointsMaterial({ color: 0xffb35c, size: 2.4, sizeAttenuation: false })));

    this._buildPickTable();
    this.ready = true;

    // the sky and 5G layers load after the playable cables
    get('sats.json').then(d => this._buildSatellites(d)).catch(e => console.warn('satellites', e));
    get('fiveg.json').then(d => this._buildFiveG(d)).catch(e => console.warn('5G', e));
  }

  _buildSatellites(data) {
    let n = 0;
    for (const g of data.groups) n += g.sats.length;
    const orbit = new Float32Array(n * 4), radius = new Float32Array(n), tint = new Float32Array(n * 3);
    let k = 0;
    this.satGroups = [];
    for (const g of data.groups) {
      const c = new THREE.Color(g.color);
      for (const [rev, inc, raan, u, alt] of g.sats) {
        orbit[k * 4] = rev * 2 * Math.PI / 86400;
        orbit[k * 4 + 1] = inc * DEG; orbit[k * 4 + 2] = raan * DEG; orbit[k * 4 + 3] = u * DEG;
        radius[k] = R * (1 + 0.1 * Math.sqrt(Math.max(0, alt) / 1000)); // compressed altitude
        tint[k * 3] = c.r; tint[k * 3 + 1] = c.g; tint[k * 3 + 2] = c.b;
        k++;
      }
      this.satGroups.push({ name: g.name, color: g.color, count: g.sats.length });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('orbit', new THREE.BufferAttribute(orbit, 4));
    geo.setAttribute('radius', new THREE.BufferAttribute(radius, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    this.refEpoch = data.refEpoch * 1000;
    this.satMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uGmst: { value: 0 }, uSize: { value: 3.4 }, uTex: { value: this.glow } },
      vertexShader: SAT_VERT, fragmentShader: SAT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.sats = new THREE.Points(geo, this.satMat);
    this.sats.frustumCulled = false;
    this.sats.visible = this.layers.satellites;
    this.group.add(this.sats);
    if (this.onSky) this.onSky(this.satGroups);
  }

  _buildFiveG(data) {
    // countries: painted onto an equirectangular texture wrapped round a shell
    const W = 2048, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = lon => (lon + 180) / 360 * W, Y = lat => (90 - lat) / 180 * H;
    g.fillStyle = 'rgba(255,90,30,0.55)'; g.strokeStyle = 'rgba(255,170,90,0.9)'; g.lineWidth = 1.5;
    for (const [, polys] of data.countries) {
      for (const rings of polys) {
        g.beginPath();
        for (const r of rings) for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(r[i]), Y(r[i + 1]));
        g.fill('evenodd'); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // three's sphere UV u = 0 sits at lon −180°, matching the canvas's left edge
    const shell = new THREE.Mesh(new THREE.SphereGeometry(R * 1.003, 128, 64),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    // hubs: pulsing glow points
    const hp = new Float32Array(data.cities.length * 3), v = new THREE.Vector3();
    data.cities.forEach(([, lat, lon], i) => { latLon(lon, lat, R * 1.012, v); hp[i * 3] = v.x; hp[i * 3 + 1] = v.y; hp[i * 3 + 2] = v.z; });
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    this.hubMat = new THREE.PointsMaterial({ color: 0xff8a3a, size: 0.22, map: this.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.fiveg = new THREE.Group();
    this.fiveg.add(shell, new THREE.Points(hg, this.hubMat));
    this.fiveg.visible = this.layers['5g'];
    this.group.add(this.fiveg);
    this.fivegCount = data.countries.length;
    if (this.onFiveG) this.onFiveG(this.fivegCount, data.cities.length);
  }

  setLayer(name, on) {
    this.layers[name] = on;
    if (name === 'cables') {
      this.cableGroup.visible = on;
      for (const h of this.highlights.values()) h.visible = on;
    }
    if (name === 'satellites' && this.sats) this.sats.visible = on;
    if (name === '5g' && this.fiveg) this.fiveg.visible = on;
  }

  setWarp(w) {
    // keep the satellites where they are, then continue at the new speed
    this.simStart = this.simMs; this.t0 = performance.now(); this.warp = w;
  }

  // Every cable vertex with its normalised position t along the cable.
  _buildPickTable() {
    let n = 0;
    for (const c of this.cables) for (const l of c.lines) n += l.length;
    this.pickPos = new Float32Array(n * 3);
    this.pickCable = new Int32Array(n);
    this.pickT = new Float32Array(n);
    let k = 0;
    this.cables.forEach((c, ci) => {
      let total = 0;
      for (const l of c.lines) for (let i = 1; i < l.length; i++) total += l[i].distanceTo(l[i - 1]);
      let run = 0;
      for (const l of c.lines) {
        l.forEach((p, i) => {
          if (i) run += p.distanceTo(l[i - 1]);
          this.pickPos[k * 3] = p.x; this.pickPos[k * 3 + 1] = p.y; this.pickPos[k * 3 + 2] = p.z;
          this.pickCable[k] = ci; this.pickT[k] = total ? run / total : 0;
          k++;
        });
      }
    });
  }

  // Nearest visible cable point to a screen position. Returns null if none
  // is within `maxPx` pixels (or the cable layer is hidden).
  pick(clientX, clientY, camera, width, height, maxPx = 22) {
    if (!this.ready || !this.layers.cables) return null;
    camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const P = this.pickPos;
    let best = -1, bestD = maxPx * maxPx;
    for (let i = 0, n = this.pickT.length; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (x * cx + y * cy + z * cz < R * R * 0.12) continue; // far side of the globe
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * width;
      const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * height;
      const d = (sx - clientX) ** 2 + (sy - clientY) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const ci = this.pickCable[best];
    return {
      cable: ci, name: this.cables[ci].name, t: this.pickT[best],
      point: new THREE.Vector3(P[best * 3], P[best * 3 + 1], P[best * 3 + 2]),
    };
  }

  // Draw the struck cable as a glowing tube in the voice's colour.
  highlight(voice, cable, color) {
    const old = this.highlights.get(voice);
    if (old && old.userData.cable === cable) return;
    if (old) { this.group.remove(old); old.traverse(o => o.geometry && o.geometry.dispose()); }
    const g = new THREE.Group(); g.userData.cable = cable;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const l of this.cables[cable].lines) {
      if (l.length < 2) continue;
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(l), Math.min(400, l.length * 3), 0.014, 6, false), mat));
    }
    g.visible = this.layers.cables;
    this.group.add(g);
    this.highlights.set(voice, g);
  }

  // Per frame: cables brighten with the output level; satellites, embers
  // and 5G hubs move.
  update(level) {
    this.cableMat.opacity = Math.min(1, 0.5 + level * 2.5);
    const now = performance.now(), secs = (now - this.t0) / 1000;
    this.emberMat.uniforms.uTime.value = now / 1000;
    if (this.satMat) {
      this.simMs = this.simStart + secs * 1000 * this.warp;
      this.satMat.uniforms.uTime.value = (this.simMs - this.refEpoch) / 1000;
      this.satMat.uniforms.uGmst.value = gmst(this.simMs);
    }
    if (this.hubMat) this.hubMat.opacity = 0.65 + 0.35 * Math.sin(now / 400);
  }
}
