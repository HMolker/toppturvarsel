import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { gridBox, gridPoints } from './terrain.js';
import { bestElevations } from './sources/elevation.js';
import { haversineKm } from './util/utm.js';
import { log } from './util/log.js';

/**
 * A ski resort from OpenStreetMap: lifts with their stations, pylons and
 * technical details, runs with difficulty, grooming, floodlights and snow
 * making, cross-country trails, snow parks, sledging, the resort boundary,
 * and the restaurants, ski rental and ski schools in it. Plus a terrain grid
 * for contour lines, the lift stations' heights, and the figures worth
 * knowing ("fun facts").
 *
 *   GET /api/resortmap?resort=<id>   (listed resorts only)
 *
 * One Overpass request per resort, cached for 30 days.
 *
 * OSM tagging used (OSM wiki: Piste Maps, Key:aerialway):
 *   aerialway=cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet
 *     name, ref, operator, aerialway:capacity (people/h), aerialway:occupancy (per chair/cabin),
 *     aerialway:duration (minutes), aerialway:heating, aerialway:bubble, aerialway:detachable
 *   aerialway=station (node), aerialway=pylon (node)
 *   piste:type=downhill|nordic|sled|snow_park|skitour
 *     piste:difficulty=novice|easy|intermediate|advanced|expert|freeride, piste:grooming,
 *     piste:name / name, piste:ref / ref, piste:lit / lit, snowmaking / piste:snowmaking, gladed
 *   landuse=winter_sports (the resort's area)
 *   amenity=restaurant|cafe|bar|fast_food|ski_school, shop=ski, tourism=alpine_hut
 *
 * A run is often split into several ways; runs are counted by name (or
 * number) and difficulty, and unnamed pieces one by one. These are
 * OpenStreetMap's figures and can differ from the resort's own.
 *
 * Data © OpenStreetMap contributors, ODbL.
 */

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const TTL = 30 * 86400e3;
const RADIUS_M = 4000;

export const LIFT_KINDS = {
  cable_car: 'cable car', gondola: 'gondola', mixed_lift: 'mixed lift', chair_lift: 'chairlift',
  drag_lift: 'drag lift', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'platter lift', rope_tow: 'rope tow', magic_carpet: 'magic carpet',
};
const DRAG = new Set(['drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']);
export const DIFFICULTIES = ['novice', 'easy', 'intermediate', 'advanced', 'expert', 'freeride'];
const POI = { restaurant: 'restaurant', cafe: 'café', bar: 'bar', fast_food: 'kiosk', ski_school: 'ski school', ski: 'ski rental', alpine_hut: 'hut' };

export function resortQuery(lat, lon, r = RADIUS_M) {
  const a = `(around:${r},${lat},${lon})`;
  return `[out:json][timeout:90];
(
  way${a}["piste:type"];
  way${a}[aerialway~"^(${Object.keys(LIFT_KINDS).join('|')})$"];
  node${a}[aerialway~"^(station|pylon)$"];
  way${a}[landuse=winter_sports];
  nwr${a}[amenity~"^(restaurant|cafe|bar|fast_food|ski_school)$"];
  nwr${a}[shop=ski];
  nwr${a}[tourism=alpine_hut];
);
out geom tags;`;
}

async function fetchOverpass(lat, lon) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'toppturvarsel/1.0 (self-hosted ski touring dashboard)',
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(resortQuery(lat, lon))}`,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.elements)) throw new Error('Overpass: no elements array');
  return body.elements;
}

/* ------------------------------------------------------------------ *
 * geometry helpers
 * ------------------------------------------------------------------ */

const distM = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
const lengthM = (pts) => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distM(pts[i - 1], pts[i]);
  return Math.round(m);
};
/** Metres from a point to a polyline (flat-earth, fine at resort scale). */
function distToLine(p, pts) {
  const k = 111320, c = Math.cos((p.lat * Math.PI) / 180);
  const X = (q) => [(q.lon - p.lon) * k * c, (q.lat - p.lat) * k];
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = X(pts[i - 1]), [bx, by] = X(pts[i]);
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}
const centroid = (pts) => ({ lat: pts.reduce((t, p) => t + p.lat, 0) / pts.length, lon: pts.reduce((t, p) => t + p.lon, 0) / pts.length });
const isClosed = (pts) => pts.length > 3 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;

const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const yes = (v) => (v == null ? null : /^(yes|true|1|24\/7|interval|automatic)$/i.test(String(v)) ? true : /^no$/i.test(String(v)) ? false : null);
/** aerialway:duration is minutes, or "mm:ss", or "PT5M". */
function minutes(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return Math.round((+m[1] + +m[2] / 60) * 10) / 10;
  m = s.match(/^PT(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (m) return Math.round(((+m[1] || 0) + (+m[2] || 0) / 60) * 10) / 10;
  return num(s);
}

/* ------------------------------------------------------------------ *
 * shaping (pure, tested)
 * ------------------------------------------------------------------ */

export function shapeResort(elements, centre = null) {
  const out = { boundary: null, lifts: [], stations: [], pylons: [], runs: [], areas: [], nordic: [], sled: [], parks: [], pois: [] };
  const boundaries = [];
  for (const e of elements ?? []) {
    const t = e.tags ?? {};
    // Nodes: stations, pylons and points of interest.
    if (e.type === 'node') {
      const p = { lat: +e.lat.toFixed(6), lon: +e.lon.toFixed(6) };
      if (t.aerialway === 'station') out.stations.push({ ...p, name: t.name ?? null });
      else if (t.aerialway === 'pylon') out.pylons.push(p);
      else {
        const kind = POI[t.amenity] ?? (t.shop === 'ski' ? POI.ski : t.tourism === 'alpine_hut' ? POI.alpine_hut : null);
        if (kind) out.pois.push({ ...p, kind, name: t.name ?? null });
      }
      continue;
    }
    if (!Array.isArray(e.geometry) || e.geometry.length < 2) {
      // A POI mapped as a building relation or way without geometry: use its centre if given.
      const kind = POI[t.amenity] ?? (t.shop === 'ski' ? POI.ski : null);
      if (kind && e.center) out.pois.push({ lat: e.center.lat, lon: e.center.lon, kind, name: t.name ?? null });
      continue;
    }
    const pts = e.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => ({ lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) }));
    if (pts.length < 2) continue;
    const kindPoi = POI[t.amenity] ?? (t.shop === 'ski' ? POI.ski : t.tourism === 'alpine_hut' ? POI.alpine_hut : null);
    if (kindPoi && !t.aerialway && !t['piste:type']) {
      out.pois.push({ ...centroid(pts), kind: kindPoi, name: t.name ?? null });
      continue;
    }
    if (t.landuse === 'winter_sports' && isClosed(pts)) {
      boundaries.push({ name: t.name ?? null, points: pts });
      continue;
    }
    if (t.aerialway && LIFT_KINDS[t.aerialway]) {
      out.lifts.push({
        id: e.id, kind: t.aerialway, kindName: LIFT_KINDS[t.aerialway], drag: DRAG.has(t.aerialway),
        name: t.name ?? null, ref: t.ref ?? null, operator: t.operator ?? null,
        capacity: num(t['aerialway:capacity']), occupancy: num(t['aerialway:occupancy']),
        duration: minutes(t['aerialway:duration']),
        heating: yes(t['aerialway:heating']), bubble: yes(t['aerialway:bubble']), detachable: yes(t['aerialway:detachable']),
        points: pts, lengthM: lengthM(pts),
      });
      continue;
    }
    const type = t['piste:type'];
    if (!type) continue;
    const name = t['piste:name'] ?? t.name ?? null;
    const ref = t['piste:ref'] ?? t.ref ?? null;
    const lit = yes(t['piste:lit'] ?? t.lit);
    const base = { id: e.id, name, ref, points: pts };
    if (type === 'downhill') {
      const difficulty = DIFFICULTIES.includes(t['piste:difficulty']) ? t['piste:difficulty'] : null;
      const run = {
        ...base, difficulty, lit, grooming: t['piste:grooming'] ?? null,
        snowmaking: yes(t.snowmaking ?? t['piste:snowmaking']), gladed: yes(t.gladed ?? t['piste:gladed']),
      };
      if (isClosed(pts) && (t.area === 'yes' || t.landuse)) out.areas.push(run);
      else out.runs.push({ ...run, lengthM: lengthM(pts) });
    } else if (type === 'nordic') {
      if (!isClosed(pts)) out.nordic.push({ ...base, lit, grooming: t['piste:grooming'] ?? null, lengthM: lengthM(pts) });
    } else if (type === 'sled') {
      out.sled.push({ ...base, lit, lengthM: lengthM(pts) });
    } else if (type === 'snow_park') {
      out.parks.push({ ...base, area: isClosed(pts) });
    }
  }

  // The resort's own area: the winter_sports polygon around the resort point,
  // else the nearest one within 1.5 km. Features outside it (a neighbouring
  // resort within the search radius) are dropped.
  if (centre && boundaries.length) {
    const hit = boundaries.find((b) => inside(centre, b.points)) ??
      boundaries.map((b) => ({ b, d: distM(centre, centroid(b.points)) })).filter((x) => x.d < 1500).sort((a, b) => a.d - b.d)[0]?.b;
    if (hit) out.boundary = hit;
  }
  if (out.boundary) {
    const poly = out.boundary.points;
    const near = (pts) => pts.some((p) => inside(p, poly) || distToLine(p, poly) < 400);
    for (const k of ['lifts', 'runs', 'areas', 'parks', 'sled']) out[k] = out[k].filter((x) => near(x.points));
    out.pois = out.pois.filter((p) => inside(p, poly) || distToLine(p, poly) < 300);
  }
  // Nordic trails can run for tens of kilometres: keep the ones that touch the area.
  const liftPts = out.lifts.flatMap((l) => l.points);
  if (liftPts.length) {
    const c = centroid(liftPts);
    out.nordic = out.nordic.filter((n) => n.points.some((p) => distM(p, c) < 3500));
  }

  // Pylons and named stations belong to the lift they sit on.
  for (const l of out.lifts) {
    l.pylons = out.pylons.filter((p) => distToLine(p, l.points) < 15);
    const end = (p) => out.stations.filter((s) => distM(s, p) < 80).sort((a, b) => distM(a, p) - distM(b, p))[0] ?? null;
    l.stationA = end(l.points[0])?.name ?? null;
    l.stationB = end(l.points[l.points.length - 1])?.name ?? null;
  }
  delete out.pylons;
  return out;
}

/** The figures, and a row per lift. `ends` = [{ a, b }] station heights per lift, in order. */
export function resortFacts(r, ends = null) {
  const runKey = (x) => (x.name || x.ref ? `${x.name ?? ''}|${x.ref ?? ''}|${x.difficulty ?? ''}` : `#${x.id}`);
  const byRun = new Map();
  for (const x of r.runs) {
    const cur = byRun.get(runKey(x)) ?? { name: x.name, ref: x.ref, difficulty: x.difficulty, lengthM: 0, lit: false, snowmaking: false, grooming: x.grooming };
    cur.lengthM += x.lengthM;
    cur.lit ||= Boolean(x.lit);
    cur.snowmaking ||= Boolean(x.snowmaking);
    byRun.set(runKey(x), cur);
  }
  const runList = [...byRun.values()].sort((a, b) => DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty) || b.lengthM - a.lengthM);
  const runsByDifficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, runList.filter((x) => x.difficulty === d).length]));
  runsByDifficulty.unknown = runList.filter((x) => !x.difficulty).length;
  const km = (list, pick = () => true) => Math.round(list.filter(pick).reduce((t, x) => t + x.lengthM, 0) / 100) / 10;

  const lifts = r.lifts.map((l, i) => {
    const e = ends?.[i];
    const a = e?.a, b = e?.b;
    const ok = Number.isFinite(a) && Number.isFinite(b);
    return {
      name: l.name, ref: l.ref, kind: l.kind, kindName: l.kindName, occupancy: l.occupancy, capacity: l.capacity,
      lengthM: l.lengthM, duration: l.duration, heating: l.heating, bubble: l.bubble, detachable: l.detachable,
      pylons: l.pylons?.length ?? 0, bottom: ok ? Math.round(Math.min(a, b)) : null, top: ok ? Math.round(Math.max(a, b)) : null,
      rise: ok ? Math.round(Math.abs(a - b)) : null,
      from: ok && a > b ? l.stationB : l.stationA, to: ok && a > b ? l.stationA : l.stationB,
    };
  }).sort((x, y) => y.lengthM - x.lengthM);

  const liftsByKind = {};
  for (const l of r.lifts) liftsByKind[l.kind] = (liftsByKind[l.kind] ?? 0) + 1;
  const withCap = r.lifts.filter((l) => l.capacity);
  const tops = lifts.map((l) => l.top).filter(Number.isFinite), bottoms = lifts.map((l) => l.bottom).filter(Number.isFinite);
  const longestRun = runList.filter((x) => x.name || x.ref).sort((a, b) => b.lengthM - a.lengthM)[0] ?? null;
  const biggest = [...lifts].filter((l) => l.rise != null).sort((a, b) => b.rise - a.rise)[0] ?? null;

  return {
    runCount: runList.length,
    runKm: km(r.runs),
    runsByDifficulty,
    runs: runList.map((x) => ({ name: x.name, ref: x.ref, difficulty: x.difficulty, lengthM: Math.round(x.lengthM), lit: x.lit, snowmaking: x.snowmaking, grooming: x.grooming })),
    litKm: km(r.runs, (x) => x.lit),
    snowmakingKm: km(r.runs, (x) => x.snowmaking),
    offPiste: r.runs.filter((x) => x.difficulty === 'freeride' || /backcountry/.test(x.grooming ?? '')).length,
    liftCount: r.lifts.length,
    liftsByKind,
    lifts,
    capacity: withCap.length ? withCap.reduce((t, l) => t + l.capacity, 0) : null,
    capacityFrom: withCap.length,
    seats: r.lifts.reduce((t, l) => t + (l.occupancy ?? 0), 0) || null,
    pylons: r.lifts.reduce((t, l) => t + (l.pylons?.length ?? 0), 0),
    liftKm: Math.round(r.lifts.reduce((t, l) => t + l.lengthM, 0) / 100) / 10,
    longestRun: longestRun ? { name: longestRun.name ?? `Run ${longestRun.ref}`, difficulty: longestRun.difficulty, lengthM: Math.round(longestRun.lengthM) } : null,
    longestLift: lifts[0] ? { name: lifts[0].name, kind: lifts[0].kindName, lengthM: lifts[0].lengthM } : null,
    biggestLift: biggest ? { name: biggest.name, kind: biggest.kindName, rise: biggest.rise } : null,
    top: tops.length ? Math.max(...tops) : null,
    bottom: bottoms.length ? Math.min(...bottoms) : null,
    vertical: tops.length && bottoms.length ? Math.max(...tops) - Math.min(...bottoms) : null,
    nordicKm: km(r.nordic),
    nordicLitKm: km(r.nordic, (x) => x.lit),
    sledKm: km(r.sled),
    parks: r.parks.length,
    pois: Object.fromEntries(Object.values(POI).map((k) => [k, r.pois.filter((p) => p.kind === k).map((p) => p.name).filter(Boolean)]).filter(([k]) => r.pois.some((p) => p.kind === k))),
    poiCounts: Object.fromEntries(Object.values(POI).map((k) => [k, r.pois.filter((p) => p.kind === k).length]).filter(([, n]) => n)),
  };
}

const cacheFile = (id) => path.resolve(config.dataDir, 'cache', 'resortmap', `${String(id).replace(/[^\w-]/g, '_')}.json`);

export async function getResortMap(resort) {
  const file = cacheFile(resort.id);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (cached.v === 2 && Date.now() - new Date(cached.fetchedAt).getTime() < TTL) return cached;
  } catch {
    /* not cached */
  }
  const centre = { lat: resort.lat, lon: resort.lon };
  const shaped = shapeResort(await fetchOverpass(resort.lat, resort.lon), centre);
  const framing = [...shaped.lifts, ...shaped.runs, ...shaped.areas, ...shaped.parks].flatMap((x) => x.points);
  const box = gridBox(framing.length ? framing : [], centre);
  const grid = gridPoints(box);
  const ends = shaped.lifts.flatMap((l) => [l.points[0], l.points[l.points.length - 1]]);
  let terrain = null, stationZ = null;
  try {
    const { values, source } = await bestElevations([...grid, ...ends], resort.country);
    terrain = { box, nx: 24, ny: 20, z: values.slice(0, grid.length).map((v) => (Number.isFinite(v) ? Math.round(v) : null)), source };
    const ez = values.slice(grid.length);
    stationZ = shaped.lifts.map((_, i) => ({ a: ez[2 * i], b: ez[2 * i + 1] }));
  } catch (err) {
    log.warn(`resortmap: elevations for ${resort.name} failed: ${err.message}`);
  }
  // The lift ends' heights ride along for the map's station labels.
  shaped.lifts.forEach((l, i) => {
    const z = stationZ?.[i];
    l.za = Number.isFinite(z?.a) ? Math.round(z.a) : null;
    l.zb = Number.isFinite(z?.b) ? Math.round(z.b) : null;
  });

  const value = {
    v: 2,
    resort: resort.name,
    id: resort.id,
    ...shaped,
    terrain,
    facts: resortFacts(shaped, stationZ),
    source: 'OpenStreetMap contributors (ODbL)',
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
  return value;
}
