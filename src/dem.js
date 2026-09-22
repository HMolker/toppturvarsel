import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { bestElevations } from './sources/elevation.js';
import { lmEnabled, lmStatus } from './sources/lmcog.js';
import * as elevation from './sources/elevation.js';
import { tileBounds, tileAllowed, pointAllowed, zoneBoxes } from './tiles.js';
import { haversineKm } from './util/utm.js';
import { log } from './util/log.js';

/**
 * The terrain model behind the v5 terrain page (/terrain): slope and aspect
 * shading, route analysis, the 3D view and route suggestions.
 *
 * Two ways in, both limited to the service area (within ~12 km of a listed
 * tour or ski resort, the same rule as the map tiles), so this box never
 * becomes a free elevation relay for the internet:
 *
 *   GET  /api/dem/{z}/{x}/{y}   a 17 × 17 elevation grid over one Web
 *        Mercator tile (z 11-15), edges shared with the neighbours. 16
 *        screen pixels per cell at the tile's own zoom: ~150 m cells at
 *        z13, ~37 m at z15 (61°N). Kept on disk for a year; terrain does
 *        not change.
 *   POST /api/terrain/profile   a drawn route, resampled every 25 m or
 *        more, each sample with its height and the slope angle and aspect
 *        of the ground under it (a small cross of points around it, so the
 *        slope is the terrain's fall line, not the route's own gradient).
 *
 * Norway: Kartverket's national terrain model (DTM 1 m / 10 m), Sweden:
 * Copernicus GLO-90 via Open-Meteo. Both are free, neither is fast, so
 * every upstream point is counted against a daily budget
 * (TERRAIN_DAILY_POINTS, default 60 000 ≈ 1 200 Kartverket requests) and
 * requests are made one tile at a time.
 */

export const DEM_N = 17;
export const DEM_MIN_Z = 11;
export const DEM_MAX_Z = 15;
const DEM_TTL = 365 * 86400e3;
const PROFILE_MAX_VERTICES = 300;
const PROFILE_MAX_KM = 50;
const PROFILE_MAX_SAMPLES = 400;

const dailyPoints = () => Math.max(0, Number(process.env.TERRAIN_DAILY_POINTS ?? 60000));

/* ------------------------------------------------------------------ *
 * budget: upstream points per UTC day
 * ------------------------------------------------------------------ */

const budget = { day: null, used: 0 };
function today() {
  return new Date().toISOString().slice(0, 10);
}
export function budgetStatus() {
  if (budget.day !== today()) Object.assign(budget, { day: today(), used: 0 });
  const limit = dailyPoints();
  return { day: budget.day, used: budget.used, limit, left: Math.max(0, limit - budget.used) };
}
function spend(n) {
  const b = budgetStatus();
  if (b.used + n > b.limit) {
    const err = new Error(`daily terrain budget used (${b.used} of ${b.limit} points); it resets at midnight UTC`);
    err.status = 429;
    throw err;
  }
  budget.used += n;
}
export function _resetBudget() {
  Object.assign(budget, { day: today(), used: 0 });
}

/* ------------------------------------------------------------------ *
 * country: the nearest listed tour or resort decides
 * ------------------------------------------------------------------ */

export function nearestCountry(lat, lon, list) {
  let best = null, bd = Infinity;
  for (const b of list) {
    if (!b.country) continue;
    const d = (b.lat - lat) ** 2 + ((b.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bd) { bd = d; best = b.country; }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * one queue for upstream elevation calls
 * ------------------------------------------------------------------ */

let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Heights already fetched, by point rounded to ~1 m. A route edited at one
// vertex resamples only the two segments that touch it, so the rest of the
// profile is answered from here without asking upstream again.
const pointCache = new Map();
const POINT_CACHE_MAX = 200000;
const pkey = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

/** Sweden with a Geotorget login reads Lantmäteriet's files, not per-point APIs. */
const lmFor = (country) => country === 'SE' && lmEnabled();

async function elevationsCached(points, country, { spacingM = 10 } = {}) {
  const out = new Array(points.length);
  const missing = [];
  points.forEach((p, i) => {
    const hit = pointCache.get(pkey(p));
    if (hit) out[i] = hit;
    else missing.push(i);
  });
  let source = null;
  if (missing.length) {
    // Lantmäteriet's files have their own cap (LANTMATERIET_DAILY_MB); the
    // point budget is for Kartverket and Open-Meteo.
    if (!lmFor(country)) spend(missing.length);
    const res = await queued(() => bestElevations(missing.map((i) => points[i]), country, { spacingM }));
    source = res.source;
    missing.forEach((idx, k) => {
      const v = { z: res.values[k], source: res.source };
      out[idx] = v;
      if (Number.isFinite(v.z)) pointCache.set(pkey(points[idx]), v);
    });
    if (pointCache.size > POINT_CACHE_MAX) {
      const drop = pointCache.size - POINT_CACHE_MAX;
      let k = 0;
      for (const key of pointCache.keys()) {
        if (k++ >= drop) break;
        pointCache.delete(key);
      }
    }
  }
  const sources = new Set(out.map((v) => v.source));
  return { values: out.map((v) => v.z), source: source ?? [...sources][0] ?? null, sources: [...sources] };
}

/* ------------------------------------------------------------------ *
 * DEM tiles
 * ------------------------------------------------------------------ */

const unmercY = (t) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI;

/** The 17 × 17 sample points of a tile, row-major from its north-west corner. */
export function demPoints(z, x, y, n = DEM_N) {
  const size = 2 ** z;
  const pts = [];
  for (let j = 0; j < n; j++) {
    const lat = unmercY((y + j / (n - 1)) / size);
    for (let i = 0; i < n; i++) {
      pts.push({ lat, lon: ((x + i / (n - 1)) / size) * 360 - 180 });
    }
  }
  return pts;
}

const demInflight = new Map();

export async function getDemTile(z, x, y) {
  if (!Number.isInteger(z) || z < DEM_MIN_Z || z > DEM_MAX_Z) {
    const e = new Error(`zoom ${z} outside ${DEM_MIN_Z}-${DEM_MAX_Z}`);
    e.status = 400;
    throw e;
  }
  const list = await zoneBoxes();
  // tileAllowed also checks x/y are inside the world at that zoom.
  if (!tileAllowedAnyZoom(z, x, y, list)) {
    const e = new Error('outside the service area (tours and ski resorts)');
    e.status = 403;
    throw e;
  }
  const key = `${z}/${x}/${y}`;
  if (demInflight.has(key)) return demInflight.get(key);
  const job = (async () => {
    const file = path.resolve(config.dataDir, 'cache', 'dem', String(z), String(x), `${y}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < DEM_TTL) return cached;
    } catch {
      /* not cached */
    }
    const b = tileBounds(z, x, y);
    const country = nearestCountry((b.north + b.south) / 2, (b.east + b.west) / 2, list);
    const pts = demPoints(z, x, y);
    // Metres between the grid's points, so a file-based source reads the right detail.
    const spacingM = (40075016.686 * Math.cos((((b.north + b.south) / 2) * Math.PI) / 180)) / 2 ** z / (DEM_N - 1);
    const { values, source } = await elevationsCached(pts, country, { spacingM });
    const tile = {
      z, x, y, n: DEM_N,
      // metres, row-major from the NW corner; null where unknown
      ele: values.map((v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)),
      source, country,
      fetchedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(tile));
    await rename(`${file}.tmp`, file);
    return tile;
  })().finally(() => demInflight.delete(key));
  demInflight.set(key, job);
  return job;
}

/**
 * tiles.js allows z 9-16 for map images. DEM tiles use the same distance
 * rule; a z11 tile is bigger than the margin, so it is allowed when any
 * tour or resort sits inside it or within the margin of its edge.
 */
function tileAllowedAnyZoom(z, x, y, list) {
  if (z >= 9) return tileAllowed(z, x, y, list);
  return false;
}

/* ------------------------------------------------------------------ *
 * route profile with terrain slope and aspect
 * ------------------------------------------------------------------ */

const R = Math.PI / 180;
const OCT8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function segLenM(a, b) {
  return haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
}

/**
 * Samples along the route, per segment from its own start, so moving one
 * vertex changes only the samples of the two segments that touch it. The
 * spacing is a multiple of 25 m, chosen so the route has at most 400.
 */
export function sampleRoute(vertices) {
  const lens = [];
  for (let i = 1; i < vertices.length; i++) lens.push(segLenM(vertices[i - 1], vertices[i]));
  const total = lens.reduce((a, b) => a + b, 0);
  const spacing = Math.max(25, Math.ceil(total / PROFILE_MAX_SAMPLES / 25) * 25);
  const out = [{ lat: vertices[0].lat, lon: vertices[0].lon, d: 0, v: 0 }];
  let d0 = 0;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1], b = vertices[i], L = lens[i - 1];
    const n = Math.max(1, Math.ceil(L / spacing));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, d: d0 + L * t, ...(k === n ? { v: i } : {}) });
    }
    d0 += L;
  }
  return { samples: out, spacing, totalM: total };
}

/** Five points per sample: the centre, and east, west, north, south of it. */
export function crossPoints(samples, offsetM) {
  const pts = [];
  for (const s of samples) {
    const dLat = offsetM / 111320;
    const dLon = offsetM / (111320 * Math.cos(s.lat * R));
    pts.push(
      { lat: s.lat, lon: s.lon },
      { lat: s.lat, lon: s.lon + dLon },
      { lat: s.lat, lon: s.lon - dLon },
      { lat: s.lat + dLat, lon: s.lon },
      { lat: s.lat - dLat, lon: s.lon },
    );
  }
  return pts;
}

/** Slope angle (degrees) and the direction the slope faces (degrees from north). */
export function slopeAspect(e, w, n, s, offsetM) {
  if (![e, w, n, s].every(Number.isFinite)) return { slope: null, aspect: null };
  const gx = (e - w) / (2 * offsetM); // rise towards east
  const gy = (n - s) / (2 * offsetM); // rise towards north
  const slope = Math.atan(Math.hypot(gx, gy)) / R;
  // The ground faces downhill: opposite the gradient.
  const aspect = slope < 0.5 ? null : ((Math.atan2(-gx, -gy) / R) + 360) % 360;
  return { slope, aspect };
}

export const octant = (deg) => (deg === null || !Number.isFinite(deg) ? null : OCT8[Math.round(deg / 45) % 8]);

export function validateRoute(body) {
  const raw = body?.points;
  if (!Array.isArray(raw) || raw.length < 2) return { error: 'need at least two points' };
  if (raw.length > PROFILE_MAX_VERTICES) return { error: `at most ${PROFILE_MAX_VERTICES} points` };
  const pts = [];
  for (const p of raw) {
    const lat = Number(Array.isArray(p) ? p[0] : p?.lat);
    const lon = Number(Array.isArray(p) ? p[1] : p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return { error: 'bad coordinate' };
    pts.push({ lat, lon });
  }
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += segLenM(pts[i - 1], pts[i]);
  if (total > PROFILE_MAX_KM * 1000) return { error: `route longer than ${PROFILE_MAX_KM} km` };
  return { points: pts, totalM: total };
}

const profileMemo = new Map();

export async function getRouteProfile(body) {
  const v = validateRoute(body);
  if (v.error) {
    const e = new Error(v.error);
    e.status = 400;
    throw e;
  }
  const list = await zoneBoxes();
  if (!v.points.every((p) => pointAllowed(p.lat, p.lon, list))) {
    const e = new Error('part of the route is outside the service area (within 12 km of a tour or ski resort)');
    e.status = 403;
    throw e;
  }
  const memoKey = createHash('sha1').update(JSON.stringify(v.points.map(pkey))).digest('hex');
  const hit = profileMemo.get(memoKey);
  if (hit) return hit;

  const mid = v.points[Math.floor(v.points.length / 2)];
  const country = nearestCountry(mid.lat, mid.lon, list);
  // Kartverket's 1 m / 10 m model and Lantmäteriet's 1 m model resolve a
  // 10 m cross; Copernicus is 90 m cells, so the cross must span them or
  // every slope reads flat.
  const offsetM = country === 'NO' || lmFor(country) ? 10 : 90;
  const { samples, spacing } = sampleRoute(v.points);
  const pts = crossPoints(samples, offsetM);
  const { values, source, sources } = await elevationsCached(pts, country, { spacingM: offsetM });

  const out = samples.map((s, k) => {
    const [c, e, w, n, so] = values.slice(k * 5, k * 5 + 5);
    const { slope, aspect } = slopeAspect(e, w, n, so, offsetM);
    return {
      d: Math.round(s.d),
      lat: +s.lat.toFixed(5),
      lon: +s.lon.toFixed(5),
      ele: Number.isFinite(c) ? Math.round(c) : null,
      slope: slope === null ? null : Math.round(slope * 10) / 10,
      aspect: aspect === null ? null : Math.round(aspect),
      ...(s.v !== undefined ? { v: s.v } : {}),
    };
  });
  const result = {
    source: sources.filter(Boolean).length > 1 ? 'mixed' : source,
    country,
    spacingM: spacing,
    crossM: offsetM,
    samples: out,
    budget: budgetStatus(),
    fetchedAt: new Date().toISOString(),
  };
  profileMemo.set(memoKey, result);
  if (profileMemo.size > 300) profileMemo.delete(profileMemo.keys().next().value);
  log.debug(`terrain: profile of ${out.length} samples (${source})`);
  return result;
}

/** What the page needs to know about the service area, and nothing else. */
export async function zoneInfo() {
  const list = await zoneBoxes();
  const lm = lmStatus();
  return {
    marginKm: 12,
    demZoom: { min: DEM_MIN_Z, max: DEM_MAX_Z, n: DEM_N },
    budget: budgetStatus(),
    count: list.length,
    // Countries whose terrain comes from files (cheap to read finely): the
    // 3D view can use a finer grid there.
    fine: lm.enabled ? ['SE'] : [],
    lantmateriet: { enabled: lm.enabled, traffic: lm.traffic, lastError: elevation.lmLastError },
  };
}
