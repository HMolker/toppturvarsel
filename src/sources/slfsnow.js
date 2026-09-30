import { getJSON } from '../util/http.js';
import { haversineKm } from '../util/utm.js';
import { log } from '../util/log.js';

/**
 * Snow depth and new snow in Switzerland (v6) from SLF's IMIS network, the
 * ~180 automatic stations in the Swiss Alps, most of them at 2000-3000 m.
 *
 *   https://measurement-api.slf.ch/public/api/imis/stations
 *     -> [{ code, label, lon, lat, elevation, country_code, canton_code, type }]
 *   https://measurement-api.slf.ch/public/api/imis/daily-snow?period_in_days=7
 *     -> [{ station_code, measure_date, HS, HN_1D }]   (cm; HN_1D = new snow in 24 h)
 *
 * Paths and fields from the API's own OpenAPI description (checked 30 Sep
 * 2026); period_in_days takes 1, 3 or 7. The daily values come from SLF's
 * snowpack model run at each station, so new snow is the model's, not a
 * ruler's — still the best open number in the Alps.
 *
 * Unlike seNorge's 1 km grid these are points, so each tour takes the
 * station that is near and at a similar height: 100 m of height counts as
 * much as 1 km of distance, up to 25 km away. The reading says which
 * station it is and how far, so no one mistakes it for the summit.
 *
 * Data © SLF, CC BY 4.0: credit "WSL Institute for Snow and Avalanche
 * Research SLF" with a link to slf.ch.
 */

const BASE = process.env.SLF_MEASUREMENT_URL || 'https://measurement-api.slf.ch/public/api/imis';
const MAX_KM = 25;
const KM_PER_100M = 1;

let stationsMemo = null;
const STATIONS_TTL = 7 * 86400e3;

async function stations() {
  if (stationsMemo && Date.now() - stationsMemo.at < STATIONS_TTL) return stationsMemo.list;
  const raw = await getJSON(`${BASE}/stations`, { timeoutMs: 20000 });
  if (!Array.isArray(raw)) throw new Error('slf stations: unexpected response shape');
  const list = raw
    .filter((s) => s?.code && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)))
    // Wind stations on ridges measure no snow depth.
    .filter((s) => !s.type || !/^WIND/i.test(s.type))
    .map((s) => ({ code: s.code, label: s.label ?? s.code, lat: Number(s.lat), lon: Number(s.lon), elevation: Number(s.elevation) || null }));
  stationsMemo = { at: Date.now(), list };
  return list;
}
export const _resetSlfSnow = () => { stationsMemo = null; };

/** The station for a point: near, and at a similar height when the point has one. */
export function pickStation(list, pt, withData = () => true) {
  let best = null, bestScore = Infinity;
  for (const s of list) {
    if (!withData(s.code)) continue;
    const km = haversineKm(pt.lat, pt.lon, s.lat, s.lon);
    if (km > MAX_KM) continue;
    const dz = Number.isFinite(pt.ele) && Number.isFinite(s.elevation) ? Math.abs(pt.ele - s.elevation) : 0;
    const score = km + (dz / 100) * KM_PER_100M;
    if (score < bestScore) { bestScore = score; best = { ...s, km: Math.round(km * 10) / 10 }; }
  }
  return best;
}

/** points: [{ key, lat, lon, ele? }] -> { [key]: snow } in the shape of senorge.js. */
export async function fetchSwissSnow(points) {
  if (!points.length) return {};
  let list, rows;
  try {
    [list, rows] = await Promise.all([stations(), getJSON(`${BASE}/daily-snow?period_in_days=7`, { timeoutMs: 20000 })]);
    if (!Array.isArray(rows)) throw new Error('slf daily-snow: unexpected response shape');
  } catch (err) {
    log.warn(`slf snow: ${err.message}`);
    return Object.fromEntries(points.map((p) => [p.key, { error: err.message, source: 'slf' }]));
  }
  return shapeSwissSnow(points, list, rows);
}

export function shapeSwissSnow(points, list, rows) {
  // station -> its days, oldest first
  const byStation = new Map();
  for (const r of rows) {
    if (!r?.station_code || !r.measure_date) continue;
    (byStation.get(r.station_code) ?? byStation.set(r.station_code, []).get(r.station_code)).push(r);
  }
  for (const v of byStation.values()) v.sort((a, b) => String(a.measure_date).localeCompare(String(b.measure_date)));
  const hasData = (code) => (byStation.get(code) ?? []).some((r) => Number.isFinite(r.HS));

  const out = {};
  for (const pt of points) {
    const st = pickStation(list, pt, hasData);
    if (!st) {
      out[pt.key] = { error: `no SLF station within ${MAX_KM} km`, source: 'slf' };
      continue;
    }
    const days = byStation.get(st.code);
    const hs = days.map((d) => (Number.isFinite(d.HS) ? Math.round(d.HS) : null));
    const hn = days.map((d) => (Number.isFinite(d.HN_1D) ? Math.max(0, d.HN_1D) : null));
    let last = hs.length - 1;
    while (last >= 0 && hs[last] === null) last--;
    const sumBack = (n) => {
      if (last < 0 || last - n + 1 < 0) return null;
      const part = hn.slice(last - n + 1, last + 1);
      return part.some((v) => v === null) ? null : Math.round(part.reduce((a, b) => a + b, 0));
    };
    out[pt.key] = {
      source: 'slf',
      unit: 'cm',
      // Not a grid cell: the station's own height, shown where seNorge shows its cell's.
      gridAltitude: st.elevation,
      station: { code: st.code, label: st.label, elevation: st.elevation, km: st.km },
      depthCm: last >= 0 ? hs[last] : null,
      new24: sumBack(1),
      new48: sumBack(2),
      new72: sumBack(3),
      series: hs,
      observedAt: last >= 0 ? days[last].measure_date : null,
    };
  }
  return out;
}
