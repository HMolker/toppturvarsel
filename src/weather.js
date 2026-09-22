import { fetchMetno } from './sources/metno.js';
import { pointAllowed, zoneBoxes } from './tiles.js';
import { log } from './util/log.js';

/**
 * Weather on a drawn route (v5.1): MET Norway's hourly forecast for up to
 * two points, the start and the highest point, each at its own height.
 *
 * POST /api/terrain/weather {"points": [[lat, lon, ele], ...]}
 *
 * Service area only, as for the route profile. Answers are kept per point
 * (3 decimals ≈ 100 m, height to 10 m) until the Expires MET sent, then
 * re-asked with If-Modified-Since, so a 304 costs MET nothing.
 */

const MAX_POINTS = 2;
const MIN_TTL = 10 * 60e3;
const cache = new Map(); // key -> { value, expiresAt, lastModified }

const keyOf = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)},${Number.isFinite(p.ele) ? Math.round(p.ele / 10) * 10 : ''}`;

function expiresAt(header) {
  const t = header ? Date.parse(header) : NaN;
  return Number.isFinite(t) ? Math.max(t, Date.now() + MIN_TTL) : Date.now() + 30 * 60e3;
}

export function validateWeather(body) {
  const raw = body?.points;
  if (!Array.isArray(raw) || !raw.length) return { error: 'need one or two points' };
  if (raw.length > MAX_POINTS) return { error: `at most ${MAX_POINTS} points` };
  const pts = [];
  for (const p of raw) {
    const lat = Number(p?.[0] ?? p?.lat), lon = Number(p?.[1] ?? p?.lon);
    const eleRaw = p?.[2] ?? p?.ele;
    const ele = eleRaw === null || eleRaw === undefined ? null : Number(eleRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return { error: 'bad coordinate' };
    if (ele !== null && (!Number.isFinite(ele) || ele < -100 || ele > 9000)) return { error: 'bad height' };
    pts.push({ lat, lon, ele });
  }
  return { points: pts };
}

async function pointWeather(p) {
  const k = keyOf(p);
  const hit = cache.get(k);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const r = await fetchMetno({ lat: p.lat, lon: p.lon, altitude: p.ele }, { lastModified: hit?.lastModified });
    if (r.notModified && hit) {
      hit.expiresAt = expiresAt(r.expires);
      return hit.value;
    }
    const value = { lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), altitude: Number.isFinite(p.ele) ? Math.round(p.ele) : null, updatedAt: r.updatedAt, hours: r.hours, deprecated: r.deprecated || undefined };
    cache.set(k, { value, expiresAt: expiresAt(r.expires), lastModified: r.lastModified });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  } catch (err) {
    // An old answer is better than none; say how old it is.
    if (hit) {
      log.warn(`weather: met.no failed (${err.message}); serving the last answer`);
      return { ...hit.value, stale: true };
    }
    throw err;
  }
}

export async function getRouteWeather(body) {
  const v = validateWeather(body);
  if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
  const list = await zoneBoxes();
  if (!v.points.every((p) => pointAllowed(p.lat, p.lon, list))) {
    throw Object.assign(new Error('outside the service area (within 12 km of a tour or ski resort)'), { status: 403 });
  }
  const points = [];
  for (const p of v.points) points.push(await pointWeather(p));
  return { source: 'MET Norway Locationforecast 2.0', credit: 'MET Norway', points, fetchedAt: new Date().toISOString() };
}

export function _clearWeatherCache() {
  cache.clear();
}
/** Tests: make every kept answer due for a re-ask. */
export function _expireWeatherCache() {
  for (const v of cache.values()) v.expiresAt = 0;
}
