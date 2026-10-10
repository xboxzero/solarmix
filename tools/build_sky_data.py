"""Build the satellite and 5G globe layers in static/data/.

Inputs (download into one directory first):
  starlink.json, oneweb.json, iridium-NEXT.json, gps-ops.json, geo.json
      CelesTrak GP data, e.g. https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json
  countries-110m.json
      https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json (Natural Earth, public domain)

Usage: python3 tools/build_sky_data.py <input-dir> static/data
"""
import json
import math
import sys
from datetime import datetime, timezone

src, out = sys.argv[1], sys.argv[2]

# ---- satellites: circular-orbit elements, all advanced to one reference epoch ----
GROUPS = [
    ("starlink", "Starlink", "#e8e2d0"),
    ("oneweb", "OneWeb", "#7fb3ff"),
    ("iridium-NEXT", "Iridium", "#9fe8c8"),
    ("gps-ops", "GPS", "#ffd27a"),
    ("geo", "Geostationary", "#ff8a4a"),
]
MU = 398600.4418  # km^3/s^2
R_EARTH = 6371.0


def epoch(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


records = {g: json.load(open(f"{src}/{g}.json")) for g, _, _ in GROUPS}
ref = max(epoch(r["EPOCH"]) for recs in records.values() for r in recs)

groups = []
for key, name, color in GROUPS:
    sats = []
    for r in records[key]:
        n = r["MEAN_MOTION"] * 2 * math.pi / 86400  # rad/s
        a = (MU / n ** 2) ** (1 / 3)
        alt = a - R_EARTH
        # argument of latitude at the reference epoch (circular orbit)
        u = math.radians(r["ARG_OF_PERICENTER"] + r["MEAN_ANOMALY"]) + n * (ref - epoch(r["EPOCH"]))
        u = math.degrees(u) % 360
        sats.append([round(r["MEAN_MOTION"], 5), round(r["INCLINATION"], 3),
                     round(r["RA_OF_ASC_NODE"], 3), round(u, 3), round(alt)])
    groups.append({"name": name, "color": color, "sats": sats})

json.dump({
    "source": "CelesTrak GP data (celestrak.org), orbital elements from the US Space Force",
    "refEpoch": ref,
    "fields": ["meanMotionRevPerDay", "inclinationDeg", "raanDeg", "argLatitudeDegAtRef", "altitudeKm"],
    "groups": groups,
}, open(f"{out}/sats.json", "w"), separators=(",", ":"))

# ---- 5G: countries with commercial 5G service (approximate, compiled 2025) ----
FIVEG = {
    # Americas
    "United States of America", "Canada", "Mexico", "Brazil", "Chile", "Argentina", "Colombia", "Peru",
    "Uruguay", "Paraguay", "Ecuador", "Puerto Rico", "Dominican Rep.", "Trinidad and Tobago", "Guatemala",
    "El Salvador", "Costa Rica", "Panama", "Suriname", "Bahamas",
    # Europe
    "United Kingdom", "Ireland", "France", "Germany", "Spain", "Portugal", "Italy", "Netherlands", "Belgium",
    "Luxembourg", "Switzerland", "Austria", "Denmark", "Norway", "Sweden", "Finland", "Iceland", "Estonia",
    "Latvia", "Lithuania", "Poland", "Czechia", "Slovakia", "Hungary", "Slovenia", "Croatia", "Romania",
    "Bulgaria", "Greece", "Cyprus", "Serbia", "Montenegro", "Albania", "Macedonia", "Moldova", "Turkey",
    "Kosovo", "Bosnia and Herz.", "Georgia",
    # Middle East & Central Asia
    "Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Oman", "Israel", "Jordan", "Egypt",
    "Kazakhstan", "Uzbekistan", "Kyrgyzstan", "Iran", "Iraq",
    # Asia-Pacific
    "China", "Japan", "South Korea", "Taiwan", "Philippines", "Thailand", "Vietnam", "Malaysia", "Indonesia",
    "India", "Sri Lanka", "Brunei", "Laos", "Cambodia", "Mongolia", "Australia", "New Zealand", "Fiji",
    "New Caledonia", "Papua New Guinea",
    # Africa
    "South Africa", "Nigeria", "Kenya", "Morocco", "Tanzania", "Uganda", "Zambia", "Zimbabwe", "Botswana",
    "Namibia", "Ethiopia", "Senegal", "Ghana", "Côte d'Ivoire", "Madagascar", "Gabon", "Lesotho", "Togo",
    "Dem. Rep. Congo", "Mozambique", "Rwanda",
}

topo = json.load(open(f"{src}/countries-110m.json"))
sx, sy = topo["transform"]["scale"]
tx, ty = topo["transform"]["translate"]
arcs = []
for arc in topo["arcs"]:
    x = y = 0
    pts = []
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((round(x * sx + tx, 2), round(y * sy + ty, 2)))
    arcs.append(pts)


def ring(idx):
    pts = []
    for i in idx:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a if not pts else a[1:])
    return [c for p in pts for c in p]


countries = []
found = set()
for g in topo["objects"]["countries"]["geometries"]:
    name = g["properties"]["name"]
    if name not in FIVEG:
        continue
    found.add(name)
    polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
    countries.append([name, [[ring(r) for r in poly] for poly in polys]])

missing = FIVEG - found
if missing:
    print("not in map:", sorted(missing))

# Major 5G hubs (approximate city coordinates)
CITIES = [
    ("Seoul", 37.57, 126.98), ("Tokyo", 35.68, 139.69), ("Osaka", 34.69, 135.50), ("Beijing", 39.90, 116.40),
    ("Shanghai", 31.23, 121.47), ("Shenzhen", 22.54, 114.06), ("Guangzhou", 23.13, 113.26), ("Chengdu", 30.57, 104.07),
    ("Hong Kong", 22.32, 114.17), ("Taipei", 25.03, 121.57), ("Singapore", 1.35, 103.82), ("Bangkok", 13.76, 100.50),
    ("Kuala Lumpur", 3.14, 101.69), ("Jakarta", -6.21, 106.85), ("Manila", 14.60, 120.98), ("Ho Chi Minh City", 10.82, 106.63),
    ("Mumbai", 19.08, 72.88), ("Delhi", 28.61, 77.21), ("Bengaluru", 12.97, 77.59), ("Dubai", 25.20, 55.27),
    ("Riyadh", 24.71, 46.68), ("Doha", 25.29, 51.53), ("Tel Aviv", 32.09, 34.78), ("Istanbul", 41.01, 28.98),
    ("Cairo", 30.04, 31.24), ("Lagos", 6.52, 3.38), ("Nairobi", -1.29, 36.82), ("Johannesburg", -26.20, 28.05),
    ("London", 51.51, -0.13), ("Paris", 48.86, 2.35), ("Berlin", 52.52, 13.40), ("Madrid", 40.42, -3.70),
    ("Rome", 41.90, 12.50), ("Amsterdam", 52.37, 4.90), ("Stockholm", 59.33, 18.07), ("Helsinki", 60.17, 24.94),
    ("Warsaw", 52.23, 21.01), ("Zurich", 47.38, 8.54), ("New York", 40.71, -74.01), ("Los Angeles", 34.05, -118.24),
    ("Chicago", 41.88, -87.63), ("Dallas", 32.78, -96.80), ("Miami", 25.76, -80.19), ("Seattle", 47.61, -122.33),
    ("Toronto", 43.65, -79.38), ("Vancouver", 49.28, -123.12), ("Mexico City", 19.43, -99.13), ("São Paulo", -23.55, -46.63),
    ("Rio de Janeiro", -22.91, -43.17), ("Buenos Aires", -34.60, -58.38), ("Santiago", -33.45, -70.67), ("Bogotá", 4.71, -74.07),
    ("Lima", -12.05, -77.04), ("Sydney", -33.87, 151.21), ("Melbourne", -37.81, 144.96), ("Auckland", -36.85, 174.76),
]

json.dump({
    "note": "Countries with commercial 5G service, approximate (compiled 2025 from public operator announcements); "
            "hubs are major cities with dense 5G deployments. Illustrative, not a coverage map.",
    "countries": countries,
    "cities": [[n, lat, lon] for n, lat, lon in CITIES],
}, open(f"{out}/fiveg.json", "w"), separators=(",", ":"), ensure_ascii=False)

print(f"{sum(len(g['sats']) for g in groups)} satellites in {len(groups)} groups, "
      f"{len(countries)} 5G countries, {len(CITIES)} hubs")
