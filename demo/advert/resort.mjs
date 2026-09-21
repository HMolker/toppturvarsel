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
const node = (tags, p) => ({ type: 'node', id: id++, tags, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) });

/** A straight lift with its pylons as vertices, as OSM maps them, plus station nodes. */
function lift(els, tags, a, b, { pylonEvery = 0, stations = [] } = {}) {
  const n = pylonEvery ? Math.max(1, Math.round(Math.hypot((b.lat - a.lat) * 111000, (b.lon - a.lon) * 55000) / pylonEvery)) : 1;
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lon: a.lon + ((b.lon - a.lon) * i) / n }));
  els.push(way(tags, pts));
  if (pylonEvery) for (let i = 1; i < n; i++) els.push(node({ aerialway: 'pylon' }, pts[i]));
  if (stations[0]) els.push(node({ aerialway: 'station', name: stations[0] }, a));
  if (stations[1]) els.push(node({ aerialway: 'station', name: stations[1] }, b));
}

export function makeResortOsm(base) {
  const P = (e, n) => at(base, e, n);
  const top = P(-2200, 2600), shoulder = P(-600, 2100), east = P(900, 1500), mid = P(-1300, 1300), low = P(250, 500);
  const els = [];
  // The resort's area, and a neighbour's lift just outside it (must be left out).
  els.push(way({ landuse: 'winter_sports', name: 'Testfjell skisenter' }, [P(-3300, -500), P(1600, -500), P(1600, 3000), P(-3300, 3000), P(-3300, -500)]));
  lift(els, { aerialway: 'chair_lift', name: 'Naboheisen' }, P(5200, 400), P(5600, 1400));

  lift(els, { aerialway: 'gondola', name: 'Toppekspressen', ref: 'G1', 'aerialway:capacity': '2400', 'aerialway:occupancy': '8', 'aerialway:duration': '9', 'aerialway:heating': 'no', 'aerialway:detachable': 'yes' },
    P(-80, 60), top, { pylonEvery: 380, stations: ['Sentrum', 'Toppen'] });
  lift(els, { aerialway: 'chair_lift', name: 'Holdeskaret', ref: 'C2', 'aerialway:capacity': '2800', 'aerialway:occupancy': '6', 'aerialway:duration': '6:30', 'aerialway:bubble': 'yes', 'aerialway:heating': 'yes', 'aerialway:detachable': 'yes' },
    P(120, 40), shoulder, { pylonEvery: 260, stations: ['Sentrum', 'Holdeskaret'] });
  lift(els, { aerialway: 'chair_lift', name: 'Solsida', ref: 'C3', 'aerialway:occupancy': '4', 'aerialway:detachable': 'no' }, P(500, 150), east, { pylonEvery: 220, stations: [null, 'Solsida topp'] });
  lift(els, { aerialway: 't-bar', name: 'Mid T-bar', ref: 'T4', 'aerialway:capacity': '1200', 'aerialway:occupancy': '2' }, mid, P(-1900, 2300), { pylonEvery: 150 });
  lift(els, { aerialway: 't-bar', name: 'Tinden', ref: 'T5', 'aerialway:capacity': '1100', 'aerialway:occupancy': '2', 'aerialway:duration': 'PT4M30S' }, P(-400, 1200), shoulder, { pylonEvery: 150 });
  lift(els, { aerialway: 'platter', name: 'Barnebakken', ref: 'P6', 'aerialway:capacity': '700', 'aerialway:occupancy': '1' }, P(-150, -120), P(-10, 180));
  lift(els, { aerialway: 'magic_carpet', name: 'Rullebåndet' }, P(60, -160), P(140, -60));

  const run = (tags, a, b, o) => els.push(way({ 'piste:type': 'downhill', ...tags }, line(a, b, o)));
  run({ 'piste:difficulty': 'intermediate', 'piste:name': 'Hollvinhytta', 'piste:ref': '12', 'piste:grooming': 'classic', snowmaking: 'yes' }, top, mid, { bend: 0.0018, wiggle: 0.0005, seed: 2 });
  run({ 'piste:difficulty': 'intermediate', 'piste:name': 'Hollvinhytta', 'piste:ref': '12', 'piste:grooming': 'classic', snowmaking: 'yes', lit: 'yes' }, mid, P(-60, 120), { bend: -0.001, wiggle: 0.0004, seed: 3 });
  run({ 'piste:difficulty': 'advanced', 'piste:name': 'Skaret', 'piste:ref': '21', 'piste:grooming': 'mogul' }, top, P(-1500, 2100), { bend: -0.0012, seed: 4 });
  run({ 'piste:difficulty': 'advanced', 'piste:name': 'Skaret', 'piste:ref': '21', 'piste:grooming': 'classic' }, P(-1500, 2100), P(-500, 900), { bend: 0.0008, seed: 5 });
  run({ 'piste:difficulty': 'easy', 'piste:name': 'Hengsletta', 'piste:ref': '3', 'piste:grooming': 'classic', lit: 'yes', snowmaking: 'yes' }, shoulder, P(50, 200), { bend: 0.0022, wiggle: 0.0006, seed: 6 });
  run({ 'piste:difficulty': 'easy', 'piste:name': 'Solsida', 'piste:ref': '5', 'piste:grooming': 'classic' }, east, P(420, 220), { bend: -0.0014, wiggle: 0.0005, seed: 7 });
  run({ 'piste:difficulty': 'intermediate', 'piste:name': 'Stiglia', 'piste:ref': '14', lit: 'yes' }, shoulder, low, { bend: -0.0009, wiggle: 0.0004, seed: 8 });
  run({ 'piste:difficulty': 'expert', 'piste:name': 'Buldreskaret', 'piste:ref': '30', 'piste:grooming': 'backcountry' }, P(-2000, 2500), P(-1800, 1500), { bend: 0.0006, seed: 9 });
  run({ 'piste:difficulty': 'freeride', 'piste:name': 'Nordsida', 'piste:grooming': 'backcountry', gladed: 'yes' }, top, P(-2900, 1300), { bend: 0.0015, wiggle: 0.0008, seed: 10 });
  run({ 'piste:difficulty': 'novice', 'piste:name': 'Barnebakken', 'piste:ref': '1', lit: 'yes', snowmaking: 'yes' }, P(-10, 180), P(-150, -110), { bend: 0.0004, seed: 11 });
  run({ 'piste:difficulty': 'easy', 'piste:name': 'Familieløypa', 'piste:ref': '4' }, mid, P(-900, 300), { bend: 0.0016, wiggle: 0.0006, seed: 12 });
  run({ 'piste:difficulty': 'easy', 'piste:name': 'Familieløypa', 'piste:ref': '4' }, P(-900, 300), P(-200, 60), { bend: -0.0006, seed: 13 });
  run({ 'piste:difficulty': 'intermediate', 'piste:name': 'Tinden', 'piste:ref': '15' }, shoulder, P(-450, 1150), { bend: 0.0007, seed: 14 });
  run({ 'piste:difficulty': 'easy' }, east, low, { bend: 0.001, seed: 15 });
  // A snow park, cross-country trails, a sledging run.
  els.push(way({ 'piste:type': 'snow_park', name: 'Parken' }, [P(-700, 800), P(-560, 820), P(-520, 560), P(-660, 540), P(-700, 800)]));
  els.push(way({ 'piste:type': 'nordic', 'piste:grooming': 'classic;skating', name: 'Lysløypa', lit: 'yes' }, line(P(800, -300), P(2400, 600), { bend: 0.004, wiggle: 0.001, seed: 16, n: 30 })));
  els.push(way({ 'piste:type': 'nordic', 'piste:grooming': 'classic', name: 'Fjelløypa' }, line(P(2400, 600), P(1400, 2600), { bend: -0.006, wiggle: 0.0015, seed: 17, n: 30 })));
  els.push(way({ 'piste:type': 'sled', name: 'Akebakken', lit: 'yes' }, line(P(-300, 900), P(-250, -50), { bend: 0.0012, seed: 18 })));
  // Where to eat, rent and learn.
  els.push(node({ amenity: 'restaurant', name: 'Skistua' }, P(-40, -30)));
  els.push(node({ amenity: 'cafe', name: 'Toppkafeen' }, P(-2150, 2560)));
  els.push(node({ amenity: 'restaurant', name: 'Hollvinhytta' }, P(-1250, 1260)));
  els.push(node({ amenity: 'bar', name: 'Afterski' }, P(20, -60)));
  els.push(node({ shop: 'ski', name: 'Skiutleie' }, P(80, -20)));
  els.push(node({ amenity: 'ski_school', name: 'Skiskolen' }, P(100, 10)));
  return els;
}
