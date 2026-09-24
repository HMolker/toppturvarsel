import { UA } from '../util/ua.js';
import { haversineKm } from '../util/utm.js';
import { lmEnabled, lmElevations } from './lmcog.js';
import { log } from '../util/log.js';

/** The last reason Lantmäteriet's terrain model could not be used, for the status. */
export let lmLastError = null;

/**
 * Elevation along a route, from Open-Meteo's elevation API
 * (Copernicus DEM GLO-90, 90 m cells; up to 100 points per request).
 * Verified shape: GET /v1/elevation?latitude=a,b&longitude=c,d -> {"elevation":[...]}
 *
 * 90 m cells round off summits and ridges, so the profile is a SKETCH of the
 * climb: good for distance, total ascent and where the steep part is, not
 * for slope angles. Slope angle is avalanche-critical and deliberately not
 * computed here — use NVE's slope-angle map for that.
 *
 * Attribution: Copernicus DEM, via Open-Meteo.
 */

const API = process.env.ELEVATION_URL || 'https://api.open-meteo.com/v1/elevation';

/**
 * Norway: Kartverket's national elevation service, answered from the 1 m
 * terrain model (DTM1) where it exists and 10 m elsewhere. Verified live:
 *   GET https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4258&punkter=[[lon,lat],...]
 *   -> {"koordsys":4258,"punkter":[{"datakilde":"dtm1","terreng":"...","x":lon,"y":lat,"z":781.26}, ...]}
 * Far better than 90 m for a ski profile: summits and gullies keep their shape.
 * © Kartverket, CC BY 4.0. Outside Norway (and at sea) z comes back null.
 */
const KARTVERKET = process.env.KARTVERKET_ELEVATION_URL || 'https://ws.geonorge.no/hoydedata/v1/punkt';
const KV_BATCH = 50;

export function kartverketUrl(points) {
  const pts = points.map((p) => `[${p.lon.toFixed(6)},${p.lat.toFixed(6)}]`).join(',');
  // Brackets and commas percent-encoded: fetch() leaves them raw otherwise.
  return `${KARTVERKET}?koordsys=4258&geojson=false&punkter=${encodeURIComponent(`[${pts}]`)}`;
}

export async function fetchKartverket(points) {
  const out = [];
  for (let i = 0; i < points.length; i += KV_BATCH) {
    const batch = points.slice(i, i + KV_BATCH);
    const res = await fetch(kartverketUrl(batch), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`kartverket HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.punkter) || body.punkter.length !== batch.length) {
      throw new Error('kartverket: unexpected response shape');
    }
    for (const p of body.punkter) out.push(Number.isFinite(p?.z) ? p.z : null);
  }
  return out;
}

/**
 * Best available elevation for a set of points, finest source first:
 *
 *   1. Lantmäteriet's 1 m model (v5.2), whenever a Geotorget login is set
 *      and the points are not known to be elsewhere. It is tried for
 *      Norwegian-looking points too (v5.5.1): the country comes from the
 *      nearest listed tour, which near the border can be a Norwegian tour
 *      for Swedish ground. Outside Sweden it simply has nothing (and says so
 *      from a cached lookup), so this costs nothing there.
 *   2. Kartverket for what is left, when the country is Norway.
 *   3. Copernicus via Open-Meteo for anything still missing.
 *
 * `spacingM`: roughly how far apart the points are. Only file-based sources
 * (Lantmäteriet) use it, to read no finer detail than needed; callers that
 * do not say get a coarse read (their grids are 50 m or more apart).
 *
 * `maxCharged`: how many points may go to the per-point services (1–3 above
 * minus Lantmäteriet). Past it, a 429 error is thrown before asking them.
 *
 * Returns { values, source, charged }: `charged` is how many points were
 * sent to a per-point service, which is what the daily budget counts.
 */
export async function bestElevations(points, country, { spacingM = 50, maxCharged = Infinity } = {}) {
  const values = new Array(points.length).fill(null);
  let todo = points.map((_, i) => i);
  let source = null;
  const done = (src) => {
    const got = todo.filter((i) => Number.isFinite(values[i]));
    if (got.length > points.length / 2 && !source) source = src;
    todo = todo.filter((i) => !Number.isFinite(values[i]));
  };

  if (lmEnabled() && (country === 'SE' || country === 'NO' || !country)) {
    try {
      const lm = await lmElevations(points, { spacingM });
      lm.forEach((z, i) => (values[i] = Number.isFinite(z) ? z : null));
      lmLastError = null;
      done('lantmateriet-mhm');
    } catch (err) {
      lmLastError = err.message;
      log.warn(`elevation: Lantmäteriet failed (${err.message}); using the point services`);
    }
  }
  if (!todo.length) return { values, source: source ?? 'lantmateriet-mhm', charged: 0 };

  const charged = todo.length;
  if (charged > maxCharged) {
    const err = new Error(`daily terrain budget used: ${charged} heights needed from the point services, ${Math.max(0, maxCharged)} left today; it resets at midnight UTC`);
    err.status = 429;
    throw err;
  }
  if (country === 'NO') {
    try {
      const kv = await fetchKartverket(todo.map((i) => points[i]));
      todo.forEach((idx, k) => (values[idx] = kv[k]));
      done('kartverket-dtm');
    } catch {
      /* Copernicus below */
    }
  }
  if (todo.length) {
    const fill = await fetchElevationsBatched(todo.map((i) => points[i]));
    todo.forEach((idx, k) => (values[idx] = fill[k]));
    done('copernicus-glo90');
  }
  return { values, source: source ?? 'copernicus-glo90', charged };
}

async function fetchElevationsBatched(points) {
  const out = [];
  for (let i = 0; i < points.length; i += MAX_POINTS) out.push(...(await fetchElevations(points.slice(i, i + MAX_POINTS))));
  return out;
}
const MAX_POINTS = 100;

/** Evenly spaced samples along a polyline, by distance. */
export function resample(points, n = MAX_POINTS) {
  if (points.length < 2) return points.map((p) => ({ ...p, d: 0 }));
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) * 1000);
  }
  const total = cum[cum.length - 1];
  // One sample per ~50 m, capped at one API request's worth.
  const count = Math.max(2, Math.min(n, Math.ceil(total / 50) + 1));
  const out = [];
  let j = 1;
  for (let s = 0; s < count; s++) {
    const target = (total * s) / (count - 1);
    while (j < cum.length - 1 && cum[j] < target) j++;
    const a = points[j - 1], b = points[j];
    const span = cum[j] - cum[j - 1] || 1;
    const t = Math.min(1, Math.max(0, (target - cum[j - 1]) / span));
    const ele =
      Number.isFinite(a.ele) && Number.isFinite(b.ele) ? a.ele + (b.ele - a.ele) * t : undefined;
    out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, d: target, ...(ele !== undefined ? { ele } : {}) });
  }
  return out;
}

export async function fetchElevations(samples) {
  const lat = samples.map((p) => p.lat.toFixed(5)).join(',');
  const lon = samples.map((p) => p.lon.toFixed(5)).join(',');
  const res = await fetch(`${API}?latitude=${lat}&longitude=${lon}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`elevation HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.elevation) || body.elevation.length !== samples.length) {
    throw new Error('elevation: unexpected response shape');
  }
  return body.elevation.map((e) => (Number.isFinite(e) ? e : null));
}

/**
 * Profile statistics. Ascent is summed after a light 3-point median filter,
 * so DEM noise on flat ground does not add phantom metres.
 */
export function profileStats(samples) {
  const ele = samples.map((p) => p.ele);
  if (ele.some((e) => !Number.isFinite(e))) return null;
  const smooth = ele.map((e, i) => {
    if (i === 0 || i === ele.length - 1) return e;
    return [ele[i - 1], e, ele[i + 1]].sort((a, b) => a - b)[1];
  });
  let ascent = 0, descent = 0;
  for (let i = 1; i < smooth.length; i++) {
    const dz = smooth[i] - smooth[i - 1];
    if (dz > 0) ascent += dz;
    else descent -= dz;
  }
  return {
    distanceM: Math.round(samples[samples.length - 1].d),
    startEle: Math.round(ele[0]),
    endEle: Math.round(ele[ele.length - 1]),
    minEle: Math.round(Math.min(...ele)),
    maxEle: Math.round(Math.max(...ele)),
    ascentM: Math.round(ascent),
    descentM: Math.round(descent),
  };
}

/** Attach elevations (from the GPX if it has them, else the best DEM) and stats. */
export async function withProfile(points, { country } = {}) {
  const samples = resample(points);
  const hasOwn = samples.every((p) => Number.isFinite(p.ele));
  let source = 'gpx';
  if (!hasOwn) {
    const res = await bestElevations(samples, country);
    samples.forEach((p, i) => (p.ele = res.values[i]));
    source = res.source;
  }
  return {
    source,
    samples: samples.map((p) => ({ d: Math.round(p.d), ele: Number.isFinite(p.ele) ? Math.round(p.ele) : null, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) })),
    stats: profileStats(samples),
  };
}
