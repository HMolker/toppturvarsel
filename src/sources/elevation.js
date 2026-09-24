import { UA } from '../util/ua.js';
import { haversineKm } from '../util/utm.js';
import { lmEnabled, lmElevations, lmUsable, lmPause, LM_PAUSE_MS } from './lmcog.js';
import { glo30Usable, glo30Elevations } from './glo30.js';
import { log } from '../util/log.js';

/** The last reason Lantmäteriet's terrain model could not be used, for the status. */
export let lmLastError = null;

export { lmUsable };

// Open-Meteo's free API limits how many heights it gives a minute and a day,
// and each point counts. Asked too fast it answers 429; then it is left
// alone for a while (2 min, doubling up to an hour) so the page gets a clear
// answer at once instead of a stream of refusals.
const OM_PER_MIN = Math.max(50, Number(process.env.OPEN_METEO_POINTS_PER_MIN) || 500);
let omBlockedUntil = 0, omBackoffMs = 0;
const omWindow = []; // [time, points] of the last minute's requests
export function _resetElevation() {
  omBlockedUntil = 0; omBackoffMs = 0; omWindow.length = 0; lmLastError = null;
}
function omBlockedError() {
  const min = Math.max(1, Math.ceil((omBlockedUntil - Date.now()) / 60000));
  return Object.assign(new Error(`Open-Meteo's free height service is refusing more heights for now (too many today or this hour); try again in about ${min} min`), { status: 429, retryAfterS: min * 60 });
}
/** Wait until sending `n` more points keeps under the per-minute limit. */
async function omPace(n) {
  for (;;) {
    const now = Date.now();
    while (omWindow.length && now - omWindow[0][0] > 60000) omWindow.shift();
    const used = omWindow.reduce((a, [, k]) => a + k, 0);
    if (!omWindow.length || used + n <= OM_PER_MIN) { omWindow.push([now, n]); return; }
    await new Promise((r) => setTimeout(r, Math.min(60000, 60000 - (now - omWindow[0][0]) + 50)));
  }
}

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

  let lmFailed = null;
  if (lmUsable() && (country === 'SE' || country === 'NO' || !country)) {
    try {
      const lm = await lmElevations(points, { spacingM });
      lm.forEach((z, i) => (values[i] = Number.isFinite(z) ? z : null));
      lmLastError = null;
      done('lantmateriet-mhm');
    } catch (err) {
      lmLastError = err.message;
      lmFailed = err.message;
      lmPause();
      log.warn(`elevation: Lantmäteriet failed (${err.message}); using the point services, trying it again in ${LM_PAUSE_MS / 60000} min`);
    }
  } else if (lmEnabled() && country === 'SE' && lmLastError) {
    lmFailed = lmLastError;
  }
  if (!todo.length) return { values, source: source ?? 'lantmateriet-mhm', charged: 0 };

  // Points sent to a per-point service (Kartverket, Open-Meteo): what the daily budget counts.
  const sent = new Set();
  const allow = (n) => {
    if (sent.size + n > maxCharged) {
      const err = new Error(`daily terrain budget used: ${n} heights needed from the point services, ${Math.max(0, maxCharged - sent.size)} left today; it resets at midnight UTC`);
      err.status = 429;
      throw err;
    }
  };
  if (country === 'NO') {
    allow(todo.length);
    todo.forEach((i) => sent.add(i));
    try {
      const kv = await fetchKartverket(todo.map((i) => points[i]));
      todo.forEach((idx, k) => (values[idx] = kv[k]));
      done('kartverket-dtm');
    } catch {
      /* GLO-30 / Copernicus below */
    }
  }
  // v5.6.2: Copernicus GLO-30 from its open files, 30 m, no daily limit —
  // before Open-Meteo's 90 m copy of the same model.
  let gloFailed = null;
  if (todo.length && glo30Usable()) {
    try {
      const g = await glo30Elevations(todo.map((i) => points[i]), { spacingM });
      todo.forEach((idx, k) => (values[idx] = g[k]));
      done('copernicus-glo30');
    } catch (err) {
      gloFailed = err.message;
      log.warn(`elevation: GLO-30 failed (${err.message}); using Open-Meteo, trying it again in 10 min`);
    }
  }
  if (todo.length) {
    const fresh = todo.filter((i) => !sent.has(i));
    allow(fresh.length);
    fresh.forEach((i) => sent.add(i));
    let fill;
    try {
      fill = await fetchElevationsBatched(todo.map((i) => points[i]));
    } catch (err) {
      // Say why the finer sources were not used, too: that is the thing to fix.
      if (lmFailed) err.message = `${err.message}. Lantmäteriet (Sweden's 1 m model) was not used: ${lmFailed}`;
      if (gloFailed) err.message = `${err.message}. GLO-30 (30 m) was not used: ${gloFailed}`;
      throw err;
    }
    todo.forEach((idx, k) => (values[idx] = fill[k]));
    done('copernicus-glo90');
  }
  return { values, source: source ?? 'copernicus-glo30', charged: sent.size };
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
  if (Date.now() < omBlockedUntil) throw omBlockedError();
  await omPace(samples.length);
  const lat = samples.map((p) => p.lat.toFixed(5)).join(',');
  const lon = samples.map((p) => p.lon.toFixed(5)).join(',');
  const res = await fetch(`${API}?latitude=${lat}&longitude=${lon}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) {
    omBackoffMs = Math.min(60 * 60000, omBackoffMs ? omBackoffMs * 2 : 2 * 60000);
    omBlockedUntil = Date.now() + omBackoffMs;
    log.warn(`elevation: Open-Meteo says 429 (rate limit); leaving it alone for ${omBackoffMs / 60000} min`);
    throw omBlockedError();
  }
  if (!res.ok) throw new Error(`elevation HTTP ${res.status}`);
  omBackoffMs = 0;
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
