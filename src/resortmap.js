import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { gridBox, gridPoints } from './terrain.js';
import { bestElevations } from './sources/elevation.js';
import { haversineKm } from './util/utm.js';
import { log } from './util/log.js';

/**
 * A ski resort's runs and lifts from OpenStreetMap, with a terrain grid for
 * contour lines and a few figures worth knowing ("fun facts").
 *
 *   GET /api/resortmap?resort=<id>   (listed resorts only)
 *
 * One Overpass request per resort, cached for 30 days, then elevations
 * (Kartverket in Norway, Copernicus elsewhere) for the contour grid and for
 * the lifts' end stations, which give the top of the lifts and the vertical.
 *
 * OSM tagging used (per the OSM wiki):
 *   piste:type=downhill + piste:difficulty=novice|easy|intermediate|advanced|expert|freeride
 *   aerialway=cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet
 *   aerialway:capacity (people per hour), name
 * A run is often split into several ways; runs are counted by name and
 * difficulty, and unnamed pieces one by one. These are OpenStreetMap's
 * figures, which can differ from the resort's own.
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

export function resortQuery(lat, lon, r = RADIUS_M) {
  const a = `(around:${r},${lat},${lon})`;
  return `[out:json][timeout:60];
(
  way${a}["piste:type"="downhill"];
  way${a}[aerialway~"^(${Object.keys(LIFT_KINDS).join('|')})$"];
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
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.elements)) throw new Error('Overpass: no elements array');
  return body.elements;
}

const lengthM = (pts) => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) * 1000;
  return Math.round(m);
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Overpass elements -> { lifts, runs, areas } (pure, tested). */
export function shapeResort(elements) {
  const lifts = [], runs = [], areas = [];
  for (const e of elements ?? []) {
    if (e.type !== 'way' || !Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const t = e.tags ?? {};
    const pts = e.geometry.map((g) => ({ lat: +g.lat.toFixed(5), lon: +g.lon.toFixed(5) }));
    if (t.aerialway && LIFT_KINDS[t.aerialway]) {
      lifts.push({
        id: e.id, kind: t.aerialway, kindName: LIFT_KINDS[t.aerialway], drag: DRAG.has(t.aerialway),
        name: t.name ?? null, capacity: num(t['aerialway:capacity']), occupancy: num(t['aerialway:occupancy']),
        points: pts, lengthM: lengthM(pts),
      });
      continue;
    }
    if (t['piste:type'] === 'downhill') {
      const difficulty = DIFFICULTIES.includes(t['piste:difficulty']) ? t['piste:difficulty'] : null;
      const closed = pts.length > 3 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
      const item = { id: e.id, difficulty, name: t['piste:name'] ?? t.name ?? null, points: pts };
      if (closed && (t.area === 'yes' || t.landuse)) areas.push(item);
      else runs.push({ ...item, lengthM: lengthM(pts) });
    }
  }
  return { lifts, runs, areas };
}

/** The figures: counts by type and difficulty, km of runs, capacity, longest, vertical. */
export function resortFacts({ lifts, runs }, stations = null) {
  // Named runs are one run however many ways they are split into.
  const byRun = new Map();
  for (const r of runs) {
    const key = r.name ? `${r.name}|${r.difficulty ?? ''}` : `#${r.id}`;
    const cur = byRun.get(key) ?? { name: r.name, difficulty: r.difficulty, lengthM: 0 };
    cur.lengthM += r.lengthM;
    byRun.set(key, cur);
  }
  const runList = [...byRun.values()];
  const runsByDifficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, runList.filter((r) => r.difficulty === d).length]));
  runsByDifficulty.unknown = runList.filter((r) => !r.difficulty).length;
  const liftsByKind = {};
  for (const l of lifts) liftsByKind[l.kind] = (liftsByKind[l.kind] ?? 0) + 1;
  const withCap = lifts.filter((l) => l.capacity);
  const longestRun = runList.filter((r) => r.name).sort((a, b) => b.lengthM - a.lengthM)[0] ?? null;
  const longestLift = [...lifts].sort((a, b) => b.lengthM - a.lengthM)[0] ?? null;
  const facts = {
    runCount: runList.length,
    runKm: Math.round(runs.reduce((t, r) => t + r.lengthM, 0) / 100) / 10,
    runsByDifficulty,
    liftCount: lifts.length,
    liftsByKind,
    capacity: withCap.length ? withCap.reduce((t, l) => t + l.capacity, 0) : null,
    capacityFrom: withCap.length,
    longestRun: longestRun ? { name: longestRun.name, difficulty: longestRun.difficulty, lengthM: longestRun.lengthM } : null,
    longestLift: longestLift ? { name: longestLift.name, kind: longestLift.kindName, lengthM: longestLift.lengthM } : null,
    top: null, bottom: null, vertical: null, biggestLift: null,
  };
  if (stations) {
    const zs = stations.flatMap((s) => [s.bottom, s.top]).filter(Number.isFinite);
    if (zs.length) {
      facts.top = Math.round(Math.max(...zs));
      facts.bottom = Math.round(Math.min(...zs));
      facts.vertical = facts.top - facts.bottom;
    }
    const big = stations.filter((s) => Number.isFinite(s.top) && Number.isFinite(s.bottom)).sort((a, b) => Math.abs(b.top - b.bottom) - Math.abs(a.top - a.bottom))[0];
    if (big) facts.biggestLift = { name: big.name, kind: big.kind, rise: Math.round(Math.abs(big.top - big.bottom)) };
  }
  return facts;
}

const cacheFile = (id) => path.resolve(config.dataDir, 'cache', 'resortmap', `${String(id).replace(/[^\w-]/g, '_')}.json`);

export async function getResortMap(resort) {
  const file = cacheFile(resort.id);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL) return cached;
  } catch {
    /* not cached */
  }
  const shaped = shapeResort(await fetchOverpass(resort.lat, resort.lon));
  const all = [...shaped.lifts, ...shaped.runs, ...shaped.areas].flatMap((x) => x.points);

  // Terrain for contours, framed on the runs and lifts (or the resort point).
  const centre = { lat: resort.lat, lon: resort.lon };
  const box = gridBox(all.length ? all : [], centre);
  const grid = gridPoints(box);
  // The lifts' end stations: the top of the lifts and the vertical.
  const ends = shaped.lifts.flatMap((l) => [l.points[0], l.points[l.points.length - 1]]);
  let terrain = null, stations = null;
  try {
    const { values, source } = await bestElevations([...grid, ...ends], resort.country);
    terrain = { box, nx: 24, ny: 20, z: values.slice(0, grid.length).map((v) => (Number.isFinite(v) ? Math.round(v) : null)), source };
    const ez = values.slice(grid.length);
    stations = shaped.lifts.map((l, i) => {
      const a = ez[2 * i], b = ez[2 * i + 1];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { name: l.name, kind: l.kindName, bottom: null, top: null };
      return { name: l.name, kind: l.kindName, bottom: Math.min(a, b), top: Math.max(a, b) };
    });
  } catch (err) {
    log.warn(`resortmap: elevations for ${resort.name} failed: ${err.message}`);
  }

  const value = {
    resort: resort.name,
    id: resort.id,
    ...shaped,
    terrain,
    facts: resortFacts(shaped, stations),
    source: 'OpenStreetMap contributors (ODbL)',
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
  return value;
}
