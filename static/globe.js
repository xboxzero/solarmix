// morlam globe — a minimal 3D Earth strung with the world's submarine
// fibre-optic cables. Each cable is a playable string: touch it and the
// position along the cable (0 at one end, 1 at the other) picks the note.
//
// Data (static/data/, built by tools/build_map_data.py):
//   cables.json, landing.json — TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0
//   land.json                 — Natural Earth 1:110m coastlines, public domain

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
    // slerp
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

export class Globe {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.cables = [];          // { name, lines: Vector3[][] }
    this.ready = false;

    // the sphere itself: matte paper
    this.group.add(new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 1, metalness: 0 }),
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
      new THREE.LineBasicMaterial({ color: 0xd3d0c9, transparent: true, opacity: 0.8 })));

    this.cableMat = new THREE.LineBasicMaterial({ color: 0xff5a00, transparent: true, opacity: 0.55 });
    this.highlights = new Map(); // voice → mesh
  }

  async load(base = 'data/') {
    const get = f => fetch(base + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    const [land, cables, landing] = await Promise.all([get('land.json'), get('cables.json'), get('landing.json')]);

    // coastlines
    this.group.add(new THREE.LineSegments(segmentsGeometry(land.arcs.map(a => polyline(a, R * 1.002))),
      new THREE.LineBasicMaterial({ color: 0x4a4945 })));

    // cables
    const all = [];
    for (const [name, , flats] of cables.cables) {
      const lines = flats.map(f => polyline(f, R * 1.006));
      this.cables.push({ name, lines });
      all.push(...lines);
    }
    this.group.add(new THREE.LineSegments(segmentsGeometry(all), this.cableMat));

    // landing stations
    const lp = new Float32Array(landing.points.length * 3);
    const v = new THREE.Vector3();
    landing.points.forEach(([lon, lat], i) => { latLon(lon, lat, R * 1.007, v); lp[i * 3] = v.x; lp[i * 3 + 1] = v.y; lp[i * 3 + 2] = v.z; });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    this.group.add(new THREE.Points(lg, new THREE.PointsMaterial({ color: 0x1d1d1b, size: 2.2, sizeAttenuation: false })));

    this._buildPickTable();
    this.ready = true;
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
  // is within `maxPx` pixels.
  pick(clientX, clientY, camera, width, height, maxPx = 22) {
    if (!this.ready) return null;
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

  // Draw the struck cable as a solid tube in the voice's colour.
  highlight(voice, cable, color) {
    const old = this.highlights.get(voice);
    if (old && old.userData.cable === cable) return;
    if (old) { this.group.remove(old); old.traverse(o => o.geometry && o.geometry.dispose()); }
    const g = new THREE.Group(); g.userData.cable = cable;
    const mat = new THREE.MeshBasicMaterial({ color });
    for (const l of this.cables[cable].lines) {
      if (l.length < 2) continue;
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(l), Math.min(400, l.length * 3), 0.012, 6, false), mat));
    }
    this.group.add(g);
    this.highlights.set(voice, g);
  }

  // Cables brighten with the output level.
  update(level) {
    this.cableMat.opacity = Math.min(1, 0.45 + level * 2.5);
  }
}
