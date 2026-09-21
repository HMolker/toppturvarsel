/**
 * A made-up ski area in OpenStreetMap's Overpass shape, for tests and
 * screenshots only: a base station at the resort's point, a mountain above
 * it to the north-west, lifts up it and named runs down.
 */
const R = 6371000, rad = Math.PI / 180;

/** Offset a point by metres east and north. */
const at = (p, e, n) => ({ lat: p.lat + (n / R) / rad, lon: p.lon + (e / (R * Math.cos(p.lat * rad))) / rad });

export function makeResortTerrain(base, { topE = -2200, topN = 2600, top = 1480, bottom = 640 } = {}) {
  const peak = at(base, topE, topN);
  return (lat, lon) => {
    const dN = (lat - peak.lat) * rad * R, dE = (lon - peak.lon) * rad * R * Math.cos(peak.lat * rad);
    const d = Math.hypot(dE, dN);
    const tex = 14 * Math.sin(lat * 900) * Math.cos(lon * 500);
    return Math.round(Math.max(bottom - 40, top - (top - bottom) * Math.pow(d / 3500, 0.8)) + tex);
  };
}

function line(from, to, { n = 14, bend = 0, wiggle = 0, seed = 1 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const b = Math.sin(t * Math.PI) * bend;
    const w = Math.sin(t * Math.PI * 5 + seed) * wiggle * Math.sin(t * Math.PI);
    // Bend sideways (perpendicular to the line).
    const dx = to.lon - from.lon, dy = to.lat - from.lat;
    const len = Math.hypot(dx, dy) || 1;
    pts.push({ lat: from.lat + dy * t + (dx / len) * (b + w) * 0.6, lon: from.lon + dx * t - (dy / len) * (b + w) });
  }
  return pts;
}

let id = 1000;
const way = (tags, pts) => ({ type: 'way', id: id++, tags, geometry: pts.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })) });

export function makeResortOsm(base) {
  const P = (e, n) => at(base, e, n);
  const top = P(-2200, 2600), shoulder = P(-600, 2100), east = P(900, 1500), mid = P(-1300, 1300), low = P(250, 500);
  const els = [
    way({ aerialway: 'gondola', name: 'Toppekspressen', 'aerialway:capacity': '2400', 'aerialway:occupancy': '8' }, line(P(-80, 60), top, { n: 2 })),
    way({ aerialway: 'chair_lift', name: 'Holdeskaret', 'aerialway:capacity': '2800' }, line(P(120, 40), shoulder, { n: 2 })),
    way({ aerialway: 'chair_lift', name: 'Solsida' }, line(P(500, 150), east, { n: 2 })),
    way({ aerialway: 't-bar', name: 'Mid T-bar', 'aerialway:capacity': '1200' }, line(mid, P(-1900, 2300), { n: 2 })),
    way({ aerialway: 't-bar', name: 'Tinden', 'aerialway:capacity': '1100' }, line(P(-400, 1200), shoulder, { n: 2 })),
    way({ aerialway: 'platter', name: 'Barnebakken', 'aerialway:capacity': '700' }, line(P(-150, -120), P(-10, 180), { n: 2 })),
    way({ aerialway: 'magic_carpet', name: 'Rullebåndet' }, line(P(60, -160), P(140, -60), { n: 2 })),
  ];
  const run = (name, difficulty, a, b, o) => els.push(way({ 'piste:type': 'downhill', 'piste:difficulty': difficulty, 'piste:name': name }, line(a, b, o)));
  // Named runs, a few split in two as OSM often has them.
  run('Hollvinhytta', 'intermediate', top, mid, { bend: 0.0018, wiggle: 0.0005, seed: 2 });
  run('Hollvinhytta', 'intermediate', mid, P(-60, 120), { bend: -0.001, wiggle: 0.0004, seed: 3 });
  run('Skaret', 'advanced', top, P(-1500, 2100), { bend: -0.0012, seed: 4 });
  run('Skaret', 'advanced', P(-1500, 2100), P(-500, 900), { bend: 0.0008, seed: 5 });
  run('Hengsletta', 'easy', shoulder, P(50, 200), { bend: 0.0022, wiggle: 0.0006, seed: 6 });
  run('Solsida', 'easy', east, P(420, 220), { bend: -0.0014, wiggle: 0.0005, seed: 7 });
  run('Stiglia', 'intermediate', shoulder, low, { bend: -0.0009, wiggle: 0.0004, seed: 8 });
  run('Buldreskaret', 'expert', P(-2000, 2500), P(-1800, 1500), { bend: 0.0006, seed: 9 });
  run('Freeride Nordsida', 'freeride', top, P(-2900, 1300), { bend: 0.0015, wiggle: 0.0008, seed: 10 });
  run('Barnebakken', 'novice', P(-10, 180), P(-150, -110), { bend: 0.0004, seed: 11 });
  run('Familieløypa', 'easy', mid, P(-900, 300), { bend: 0.0016, wiggle: 0.0006, seed: 12 });
  run('Familieløypa', 'easy', P(-900, 300), P(-200, 60), { bend: -0.0006, seed: 13 });
  run('Tinden', 'intermediate', shoulder, P(-450, 1150), { bend: 0.0007, seed: 14 });
  els.push(way({ 'piste:type': 'downhill', 'piste:difficulty': 'easy' }, line(east, low, { bend: 0.001, seed: 15 })));
  return els;
}
