import { UA } from '../util/ua.js';

/**
 * Point forecast from MET Norway's Locationforecast 2.0 (the data behind
 * yr.no), for the terrain page's "Weather on the route" (v5.1).
 *
 *   GET https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=..&lon=..&altitude=..
 *
 * Checked against MET's documentation (2026-09-23):
 * - lat/lon: "Do not use more than 4 decimals to avoid blocking";
 *   altitude: "Ground surface height above sea level in whole meters
 *   (integers). Optional but recommended" — MET corrects the temperature to
 *   it, which is why the start and the summit are asked for separately.
 * - A missing or generic User-Agent gets 403; ours names the app.
 * - Keep Expires and Last-Modified, re-ask with If-Modified-Since; watch for
 *   203 (product deprecated) and 429 (throttled).
 * - GeoJSON: properties.meta.{updated_at, units}; properties.timeseries[] with
 *   time and data.instant.details.{air_temperature, wind_speed,
 *   wind_speed_of_gust, wind_from_direction, cloud_area_fraction, ...} and
 *   data.next_1_hours / next_6_hours .{summary.symbol_code,
 *   details.precipitation_amount}. "complete" rather than "compact" for the
 *   gusts; every field is read as optional.
 *
 * Data © MET Norway, CC BY 4.0 (credit "MET Norway").
 */

const API = process.env.METNO_URL || 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

export function metnoUrl({ lat, lon, altitude }) {
  const q = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4) });
  if (Number.isFinite(altitude)) q.set('altitude', String(Math.round(altitude)));
  return `${API}?${q}`;
}

const n = (v) => (Number.isFinite(v) ? v : null);

/** MET's GeoJSON -> hourly rows (the hourly part of the series only). */
export function parseMetno(body, { hours = 60 } = {}) {
  const ts = body?.properties?.timeseries;
  if (!Array.isArray(ts)) throw new Error('met.no: unexpected response shape');
  const out = [];
  for (const t of ts) {
    const d = t?.data;
    const i = d?.instant?.details ?? {};
    const h1 = d?.next_1_hours;
    // After the first ~2.5 days MET steps to 6-hourly values; stop there.
    if (!h1) break;
    out.push({
      time: t.time,
      temp: n(i.air_temperature),
      wind: n(i.wind_speed),
      gust: n(i.wind_speed_of_gust),
      dir: n(i.wind_from_direction),
      cloud: n(i.cloud_area_fraction),
      precip: n(h1.details?.precipitation_amount),
      symbol: h1.summary?.symbol_code ?? null,
    });
    if (out.length >= hours) break;
  }
  return { updatedAt: body.properties.meta?.updated_at ?? null, hours: out };
}

/**
 * One request. `lastModified` from the previous answer makes it conditional:
 * a 304 returns { notModified: true } and the caller keeps what it has.
 */
export async function fetchMetno({ lat, lon, altitude }, { lastModified = null } = {}) {
  const res = await fetch(metnoUrl({ lat, lon, altitude }), {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(lastModified ? { 'If-Modified-Since': lastModified } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const expires = res.headers.get('expires');
  if (res.status === 304) return { notModified: true, expires };
  if (res.status === 429) throw new Error('met.no is throttling this service (429); try again later');
  if (!res.ok) throw new Error(`met.no HTTP ${res.status}`);
  const parsed = parseMetno(await res.json());
  return {
    ...parsed,
    deprecated: res.status === 203,
    expires,
    lastModified: res.headers.get('last-modified'),
  };
}
