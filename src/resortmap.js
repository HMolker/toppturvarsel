import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { gridBox, gridPoints } from './terrain.js';
import { bestElevations } from './sources/elevation.js';
import { haversineKm } from './util/utm.js';
import { log } from './util/log.js';
import { overpass } from './util/overpass.js';
import { appVersion } from './util/appversion.js';
import { ssrLifts, matchToLifts } from './sources/ssr.js';
import { fileLifts } from './sources/liftfile.js';

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

// Ski areas change slowly: a stored map is refreshed after about three months
// (by the night scan, see nightly.js). Older ones are still shown meanwhile.
export const RESORT_MAP_MAX_AGE_DAYS = Number(process.env.RESORT_MAP_MAX_AGE_DAYS ?? 30);
const TTL = RESORT_MAP_MAX_AGE_DAYS * 86400e3;
// How far out to look for lifts. Big areas (Trysil, Åre) spill well past a
// 4 km circle, so the search is wide and the resort's own boundary — or a
// chain of lifts meeting end to end — decides what belongs to it.
const RADIUS_M = Number(process.env.RESORT_RADIUS_M ?? 7000);
const AREA_RADIUS_M = 9000;
// A lift counts as part of the resort when it starts or ends this close to
// one already accepted (lifts feed each other at shared stations).
const CHAIN_M = 700;
const CENTRE_M = 3500;

export const LIFT_KINDS = {
  cable_car: 'cable car', gondola: 'gondola', mixed_lift: 'mixed lift', chair_lift: 'chairlift',
  drag_lift: 'drag lift', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'platter lift', rope_tow: 'rope tow',
  magic_carpet: 'magic carpet', funicular: 'funicular', zip_line: 'zip line',
};
/** A funicular is a railway in OSM, not an aerialway. */
const liftKind = (t) => (LIFT_KINDS[t.aerialway] ? t.aerialway : t.railway === 'funicular' ? 'funicular' : null);
const DRAG = new Set(['drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']);
export const DIFFICULTIES = ['novice', 'easy', 'intermediate', 'advanced', 'expert', 'freeride'];
const POI = { restaurant: 'restaurant', cafe: 'café', bar: 'bar', fast_food: 'kiosk', ski_school: 'ski school', ski: 'ski rental', alpine_hut: 'hut' };

export function resortQuery(lat, lon, r = RADIUS_M, ar = AREA_RADIUS_M) {
  const a = `(around:${r},${lat},${lon})`;
  const area = `(around:${ar},${lat},${lon})`;
  // The ski area itself first; then everything inside it, plus everything
  // within the circle, so a resort with no boundary mapped still comes out.
  return `[out:json][timeout:120];
(
  way${area}[landuse=winter_sports];
  relation${area}[landuse=winter_sports];
  relation${area}[site=piste];
)->.a;
.a map_to_area->.ar;
(
  .a;
  way(area.ar)[aerialway];
  way${a}[aerialway];
  way(area.ar)[railway=funicular];
  way${a}[railway=funicular];
  node(area.ar)[aerialway~"^(station|pylon)$"];
  node${a}[aerialway~"^(station|pylon)$"];
  way(area.ar)["piste:type"];
  way${a}["piste:type"];
  nwr${a}[amenity~"^(restaurant|cafe|bar|fast_food|ski_school)$"];
  nwr${a}[shop=ski];
  nwr${a}[tourism=alpine_hut];
);
out geom tags;`;
}

// Someone is looking at the panel: first in line, 75 s at most.
const CLICK = { timeoutMs: 60000, what: 'resortmap', priority: 'high', deadlineMs: 75000 };
// The night scan: last in line, no hurry.
const NIGHT = { timeoutMs: 120000, what: 'resortmap (night scan)', priority: 'low' };

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

/**
 * Which lifts belong to this resort: those inside its boundary (or, with no
 * boundary, near its point), and then anything meeting those end to end,
 * repeatedly — how a ski area actually hangs together.
 */
export function keepLiftChain(lifts, boundary, centre, { chainM = CHAIN_M, centreM = CENTRE_M } = {}) {
  if (!lifts.length) return lifts;
  const poly = boundary?.points ?? null;
  const ends = (l) => [l.points[0], l.points[l.points.length - 1]];
  const seed = (l) =>
    poly ? l.points.some((p) => inside(p, poly) || distToLine(p, poly) < 400)
      : centre ? l.points.some((p) => distM(p, centre) < centreM)
        : true;
  const keep = new Set(lifts.filter(seed));
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of lifts) {
      if (keep.has(l)) continue;
      const mine = ends(l);
      if ([...keep].some((k) => ends(k).some((p) => mine.some((q) => distM(p, q) < chainM)))) {
        keep.add(l);
        grew = true;
      }
    }
  }
  return lifts.filter((l) => keep.has(l));
}

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
    // A resort area mapped as a multipolygon: its biggest closed outer ring.
    if (e.type === 'relation' && t.landuse === 'winter_sports') {
      const rings = (e.members ?? [])
        .filter((m) => m.role !== 'inner' && Array.isArray(m.geometry) && m.geometry.length > 3)
        .map((m) => m.geometry.map((g) => ({ lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) })))
        .filter(isClosed)
        .sort((a, b) => b.length - a.length);
      if (rings[0]) boundaries.push({ name: t.name ?? null, points: rings[0] });
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
    const lk = liftKind(t);
    if (lk) {
      out.lifts.push({
        id: e.id, kind: lk, kindName: LIFT_KINDS[lk], drag: DRAG.has(lk),
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
    for (const k of ['runs', 'areas', 'parks', 'sled']) out[k] = out[k].filter((x) => near(x.points));
    out.pois = out.pois.filter((p) => inside(p, poly) || distToLine(p, poly) < 300);
  }
  // Lifts: inside the area, or reached from one that is. A beginner lift just
  // outside the mapped boundary, or the far end of a linked area, still counts;
  // a neighbouring resort's lift, standing on its own, does not.
  out.lifts = keepLiftChain(out.lifts, out.boundary, centre);
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


/**
 * A second opinion on OpenStreetMap's lifts:
 *   Norway  Kartverket's place-name register (SSR) — official lift names.
 *   Sweden  data/lifts-SE.geojson, if you have exported Lantmäteriet's
 *           Topografi 50 lift lines (see src/sources/liftfile.js).
 * Anything from those with no mapped lift near it is drawn on the map and
 * listed in the facts as missing from OpenStreetMap.
 */
async function crossCheck(resort, lifts, boundary, centre) {
  const extras = [];
  const facts = {};
  const belongs = (p) => (boundary ? inside(p, boundary.points) || distToLine(p, boundary.points) < 600 : distM(p, centre) < CENTRE_M + 1500);

  if (resort.country === 'NO') {
    try {
      const { lifts: named, areas } = await ssrLifts(resort.lat, resort.lon);
      const here = named.filter(belongs);
      const { matched, missing } = matchToLifts(here, lifts);
      facts.ssr = { total: here.length, matched: matched.length, missing: missing.map((m) => m.name), area: areas[0]?.name ?? null, source: 'Kartverket (SSR)' };
      for (const m of missing) extras.push({ source: 'Kartverket', name: m.name, kind: m.type, lat: m.lat, lon: m.lon });
    } catch (err) {
      log.warn(`resortmap: SSR lift names for ${resort.name}: ${err.message}`);
      facts.ssr = { error: err.message };
    }
  }

  const agency = resort.country === 'SE' ? 'Lantmäteriet' : 'national map data';
  const file = (await fileLifts(resort.country)).filter((l) => l.points.some(belongs));
  if (file.length) {
    const mids = file.map((l) => ({ ...l, ...l.points[Math.floor(l.points.length / 2)] }));
    const { matched, missing } = matchToLifts(mids, lifts, { withinM: 250 });
    facts.file = { total: file.length, matched: matched.length, missing: missing.map((m) => m.name).filter(Boolean), source: agency };
    for (const m of missing) extras.push({ source: agency, name: m.name, kind: m.kind, points: m.points, lengthM: lengthM(m.points) });
  }
  return { extras, facts };
}

// One lookup per resort at a time: a second click joins the first.
const inflight = new Map();

const readCached = (id) => readFile(cacheFile(id), 'utf8').then(JSON.parse).then((c) => (c?.v === 3 ? c : null)).catch(() => null);
const ageMs = (c) => Date.now() - new Date(c.fetchedAt).getTime();

/**
 * The map for the panel. A stored map is returned at once whatever its age;
 * one older than the limit is also refreshed in the background (the night
 * scan normally gets there first). Only a resort never looked up waits for
 * OpenStreetMap.
 */
export async function getResortMap(resort) {
  const cached = await readCached(resort.id);
  if (cached) {
    if (ageMs(cached) >= TTL && !inflight.has(resort.id)) {
      refreshResortMap(resort).catch((err) => log.warn(`resortmap: background refresh of ${resort.name} failed: ${err.message}`));
    }
    return cached;
  }
  return refreshResortMap(resort, { click: true });
}

/** Fetch and store a resort's map now (a click waits; the night scan does not). */
export function refreshResortMap(resort, { click = false } = {}) {
  if (inflight.has(resort.id)) return inflight.get(resort.id);
  const job = loadResortMap(resort, click ? CLICK : NIGHT).finally(() => inflight.delete(resort.id));
  inflight.set(resort.id, job);
  return job;
}

/** A stored map's age in ms and the app version that made it. */
export async function resortMapMeta(id) {
  const c = await readCached(id);
  return c ? { age: ageMs(c), app: c.app ?? null } : { age: Infinity, app: null };
}

/** When each stored map was written: key -> ms (from the file's time, cheaply). */
export async function storedResortMaps() {
  const dir = path.dirname(cacheFile('x'));
  const out = new Map();
  for (const f of await readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const st = await stat(path.join(dir, f)).catch(() => null);
    if (st) out.set(f.slice(0, -5), st.mtimeMs);
  }
  return out;
}
export const resortMapKey = (id) => String(id).replace(/[^\w-]/g, '_');

async function loadResortMap(resort, opts) {
  const file = cacheFile(resort.id);
  const stale = await readCached(resort.id);
  const centre = { lat: resort.lat, lon: resort.lon };
  let elements;
  try {
    elements = await overpass(resortQuery(resort.lat, resort.lon), opts);
  } catch (err) {
    // An old map beats no map.
    if (stale) return { ...stale, stale: true, error: err.message };
    throw err;
  }
  const shaped = shapeResort(elements, centre);
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

  const cross = await crossCheck(resort, shaped.lifts, shaped.boundary, centre);

  const value = {
    v: 3,
    app: await appVersion(),
    resort: resort.name,
    id: resort.id,
    ...shaped,
    terrain,
    facts: { ...resortFacts(shaped, stationZ), cross: cross.facts },
    extras: cross.extras,
    source: 'OpenStreetMap contributors (ODbL)',
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
  return value;
}
