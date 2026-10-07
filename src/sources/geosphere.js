import { getJSON } from '../util/http.js';
import { haversineKm } from '../util/utm.js';
import { log } from '../util/log.js';
import { pickStation } from './slfsnow.js';

/**
 * Snow depth and new snow in Austria and next to it (v6.2) from GeoSphere
 * Austria's automatic stations (TAWES, ~370 of them; the ones that measure
 * snow are mostly in the valleys, a few at 2000-3400 m), through the open
 * Data Hub:
 *
 *   https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min/metadata
 *     -> { parameters[], stations: [{ id: "11266", name, state, lat, lon, altitude, is_active }] }
 *   https://dataset.api.hub.geosphere.at/v1/station/historical/tawes-v1-10min
 *        ?parameters=SCHNEE&station_ids=11266,11125&start=2026-10-06T12:00&end=2026-10-07T18:00
 *     -> { timestamps: ["2026-10-06T12:00+00:00", …],
 *          features: [{ geometry, properties: { station: "11266", parameters: { SCHNEE: { unit: "cm", data: [null, 12.0, …] } } } }] }
 *
 * (both shapes read on 7 Oct 2026; SCHNEE = "Schneehöhe", cm, every 10 min,
 * null where a station has no snow sensor or no snow cover is reported).
 *
 * Unlike SLF's IMIS there is no modelled new-snow number, so new snow here is
 * DERIVED from the depth: the rises in snow depth between 6-hour readings
 * over the last 24, 48 and 72 hours, ignoring falls (settling, melt) and
 * rises under 1 cm (sensor noise). It reads low in wind or when snow settles
 * fast, and the page says it is derived. The station chosen is the nearest
 * with data at a similar height (100 m of height counts like 1 km), up to
 * 25 km away, and the reading names it.
 *
 * Data © GeoSphere Austria, CC BY 4.0.
 */

const BASE = (process.env.GEOSPHERE_URL || 'https://dataset.api.hub.geosphere.at/v1/station').replace(/\/$/, '');
const MAX_KM = 25;
const BATCH = 40;
const HOUR = 3600e3;
const STATIONS_TTL = 7 * 86400e3;

let stationsMemo = null;
async function stations() {
  if (stationsMemo && Date.now() - stationsMemo.at < STATIONS_TTL) return stationsMemo.list;
  const raw = await getJSON(`${BASE}/current/tawes-v1-10min/metadata`, { timeoutMs: 20000 });
  if (!Array.isArray(raw?.stations)) throw new Error('geosphere stations: unexpected response shape');
  const list = raw.stations
    .filter((s) => s?.id && s.is_active !== false && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)))
    .map((s) => ({ code: String(s.id), label: s.name ?? String(s.id), lat: Number(s.lat), lon: Number(s.lon), elevation: Number(s.altitude) || null }));
  stationsMemo = { at: Date.now(), list };
  return list;
}
export const _resetGeosphere = () => { stationsMemo = null; };

const stamp = (t) => new Date(t).toISOString().slice(0, 16);

/** The series of snow depth for some stations: Map(code -> { t: [ms], v: [cm|null] }). */
async function depthSeries(codes, now) {
  const out = new Map();
  const start = stamp(now.getTime() - 75 * HOUR), end = stamp(now.getTime());
  for (let i = 0; i < codes.length; i += BATCH) {
    const ids = codes.slice(i, i + BATCH);
    const body = await getJSON(`${BASE}/historical/tawes-v1-10min?parameters=SCHNEE&station_ids=${ids.join(',')}&start=${start}&end=${end}`, { timeoutMs: 30000 });
    if (!body || !Array.isArray(body.timestamps) || !Array.isArray(body.features)) throw new Error('geosphere data: unexpected response shape');
    const t = body.timestamps.map((x) => Date.parse(x));
    for (const f of body.features) {
      const data = f?.properties?.parameters?.SCHNEE?.data;
      if (f?.properties?.station && Array.isArray(data)) out.set(String(f.properties.station), { t, v: data.map((x) => (Number.isFinite(x) ? x : null)) });
    }
  }
  return out;
}

/** points: [{ key, lat, lon, ele? }] -> { [key]: snow } in the shape of slfsnow.js / senorge.js. */
export async function fetchAlpineSnow(points, { now = new Date() } = {}) {
  if (!points.length) return {};
  let list, series;
  try {
    list = await stations();
    const near = list.filter((s) => points.some((p) => haversineKm(p.lat, p.lon, s.lat, s.lon) <= MAX_KM));
    series = await depthSeries(near.map((s) => s.code), now);
  } catch (err) {
    log.warn(`geosphere snow: ${err.message}`);
    return Object.fromEntries(points.map((p) => [p.key, { error: err.message, source: 'geosphere' }]));
  }
  return shapeAlpineSnow(points, list, series, now);
}

/** Depth at a time: the reading nearest it within 30 minutes, or null. */
function depthAt(s, ms) {
  let best = null, bestD = 31 * 60e3;
  for (let i = 0; i < s.t.length; i++) {
    const d = Math.abs(s.t[i] - ms);
    if (s.v[i] !== null && d < bestD) { bestD = d; best = s.v[i]; }
  }
  return best;
}

export function shapeAlpineSnow(points, list, series, now = new Date()) {
  const hasData = (code) => (series.get(code)?.v ?? []).some((v) => v !== null);
  const out = {};
  for (const pt of points) {
    const st = pickStation(list, pt, hasData);
    if (!st) {
      out[pt.key] = { error: `no GeoSphere station with snow data within ${MAX_KM} km`, source: 'geosphere' };
      continue;
    }
    const s = series.get(st.code);
    let last = s.v.length - 1;
    while (last >= 0 && s.v[last] === null) last--;
    const T = s.t[last];
    // Readings every 6 hours back from the latest one; null where there is a gap.
    const steps = Array.from({ length: 13 }, (_, k) => depthAt(s, T - k * 6 * HOUR));
    const rise = (n) => {
      const part = steps.slice(0, n * 4 + 1);
      if (part.some((v) => v === null)) return null;
      let sum = 0;
      for (let k = 0; k < part.length - 1; k++) {
        const d = part[k] - part[k + 1];
        if (d >= 1) sum += d;
      }
      return Math.round(sum);
    };
    out[pt.key] = {
      source: 'geosphere',
      unit: 'cm',
      derived: true,
      gridAltitude: st.elevation,
      station: { code: st.code, label: st.label, elevation: st.elevation, km: st.km },
      depthCm: Math.round(s.v[last]),
      new24: rise(1),
      new48: rise(2),
      new72: rise(3),
      series: [3, 2, 1, 0].map((d) => depthAt(s, T - d * 24 * HOUR)).map((v) => (v === null ? null : Math.round(v))),
      observedAt: new Date(T).toISOString(),
      stale: now.getTime() - T > 36 * HOUR,
    };
  }
  return out;
}
