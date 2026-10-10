"""Build the compact globe data files in static/data/.

Inputs (download into one directory first):
  cable-geo.json          https://www.submarinecablemap.com/api/v3/cable/cable-geo.json
  landing-point-geo.json  https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json
  land-110m.json          https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json

Usage: python3 tools/build_map_data.py <input-dir> static/data
"""
import json
import sys

src, out = sys.argv[1], sys.argv[2]
r2 = lambda v: round(v, 2)

# ---- submarine cables (TeleGeography, CC BY-NC-SA 3.0) ----
cables = []
for f in json.load(open(f"{src}/cable-geo.json"))["features"]:
    p, g = f["properties"], f["geometry"]
    lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    flat = []
    for line in lines:
        pts, last = [], None
        for lon, lat in line:
            # drop points closer than ~0.15° to the previous kept one
            if last and abs(lon - last[0]) < 0.15 and abs(lat - last[1]) < 0.15:
                continue
            pts += [r2(lon), r2(lat)]
            last = (lon, lat)
        if len(pts) >= 4:
            flat.append(pts)
    if flat:
        cables.append([p["name"], p.get("color", "#939597"), flat])

json.dump({
    "source": "TeleGeography Submarine Cable Map — submarinecablemap.com",
    "license": "CC BY-NC-SA 3.0",
    "cables": cables,
}, open(f"{out}/cables.json", "w"), separators=(",", ":"), ensure_ascii=False)

landing = [[r2(c) for c in f["geometry"]["coordinates"]]
           for f in json.load(open(f"{src}/landing-point-geo.json"))["features"]]
json.dump({
    "source": "TeleGeography Submarine Cable Map — submarinecablemap.com",
    "license": "CC BY-NC-SA 3.0",
    "points": landing,
}, open(f"{out}/landing.json", "w"), separators=(",", ":"))

# ---- coastlines (Natural Earth 1:110m via world-atlas, public domain) ----
topo = json.load(open(f"{src}/land-110m.json"))
sx, sy = topo["transform"]["scale"]
tx, ty = topo["transform"]["translate"]
arcs = []
for arc in topo["arcs"]:
    x = y = 0
    pts = []
    for dx, dy in arc:  # delta-encoded, quantized
        x += dx; y += dy
        pts += [r2(x * sx + tx), r2(y * sy + ty)]
    arcs.append(pts)
json.dump({"source": "Natural Earth 1:110m land (public domain), via world-atlas", "arcs": arcs},
          open(f"{out}/land.json", "w"), separators=(",", ":"))

print(f"{len(cables)} cables, {len(landing)} landing points, {len(arcs)} coastline arcs")
