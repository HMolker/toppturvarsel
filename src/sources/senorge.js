import { getJSON, mapLimit } from '../util/http.js';
import { latLonToUTM } from '../util/utm.js';
import { log } from '../util/log.js';

/**
 * Snow depth from NVE's seNorge gridded model (gts.nve.no).
 *
 * Verified against the live API:
 *   https://gts.nve.no/api/GridTimeSeries/{x}/{y}/{from}/{to}/{theme}.json
 * -> {Theme, FullName, NoDataValue, X, Y, StartDate, EndDate, Unit,
 *     TimeResolution, Altitude, Data:[...]}
 *
 * Two things that matter:
 *  - Unit for theme "sd" is CENTIMETRES and values are daily at 06:00.
 *  - The grid is 1 km, and it covers the Swedish side of the mountains too
 *    (checked at Kebnekaise 1915 m and Åreskutan 1088 m), so this is the
 *    snow source for BOTH countries. Altitude in the response is the cell's
 *    mean elevation, not the summit - a 2469 m peak sits in a 2178 m cell.
 *
 * We sample at each TOUR's coordinates rather than a region centroid: a
 * region centroid often lands at sea level, which is how you get a "0 cm"
 * reading for a region with a metre of snow at 1200 m.
 */

const BASE = 'https://gts.nve.no/api/GridTimeSeries';
const NO_DATA = 65535;

const ymd = (d) => d.toISOString().slice(0, 10);

/** Depth history long enough to compute 24h/48h/72h change. */
const LOOKBACK_DAYS = 6;

export async function fetchSnowForPoints(points, { date = new Date() } = {}) {
  const to = ymd(date);
  const from = ymd(new Date(date.getTime() - LOOKBACK_DAYS * 86400000));

  const results = await mapLimit(points, 4, async (pt) => {
    const { x, y } = latLonToUTM(pt.lat, pt.lon);
    const url = `${BASE}/${x}/${y}/${from}/${to}/sd.json`;
    const raw = await getJSON(url);
    return { pt, raw };
  });

  const out = {};
  results.forEach((res, i) => {
    const pt = points[i];
    if (!res.ok || !res.value?.raw) {
      log.warn(`senorge: ${pt.key} failed: ${res.error ?? 'empty response'}`);
      out[pt.key] = { error: res.error ?? 'no data', source: 'senorge' };
      return;
    }
    out[pt.key] = shapeSnow(res.value.raw);
  });
  return out;
}

export function shapeSnow(raw) {
  const noData = Number.isFinite(raw.NoDataValue) ? raw.NoDataValue : NO_DATA;
  const series = (raw.Data ?? []).map((v) =>
    v === noData || !Number.isFinite(v) ? null : Math.round(v * 10) / 10
  );

  const last = lastValid(series);
  const depth = last.value;

  return {
    source: 'senorge',
    unit: raw.Unit ?? 'cm',
    gridAltitude: Number.isFinite(raw.Altitude) ? raw.Altitude : null,
    depthCm: depth,
    // New snow as the rise in modelled depth. Settlement means this
    // UNDER-reports what fell: 40 cm of new snow may show as +30 by morning.
    // It is the honest floor, not the headline number a resort would quote.
    new24: change(series, last.index, 1),
    new48: change(series, last.index, 2),
    new72: change(series, last.index, 3),
    series,
    observedAt: raw.EndDate ?? null,
  };
}

function lastValid(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return { value: series[i], index: i };
  }
  return { value: null, index: -1 };
}

function change(series, endIndex, daysBack) {
  if (endIndex < 0) return null;
  const startIndex = endIndex - daysBack;
  if (startIndex < 0) return null;
  const a = series[startIndex];
  const b = series[endIndex];
  if (a === null || b === null) return null;
  // Negative means the pack settled or melted; clamp to 0 for "new snow".
  return Math.max(0, Math.round((b - a) * 10) / 10);
}

/**
 * Region-level snow summary = the tours in that region, since those are the
 * points anyone actually skis. We report the max new-snow and the median
 * depth so one freak grid cell cannot drive an alert on its own.
 */
export function summariseByRegion(snowByTourKey, tours) {
  const byRegion = {};
  for (const tour of tours) {
    const s = snowByTourKey[tour.name];
    if (!s || s.error || s.depthCm === null) continue;
    (byRegion[tour.region] ??= []).push({ tour, snow: s });
  }

  const out = {};
  for (const [regionId, entries] of Object.entries(byRegion)) {
    const depths = entries.map((e) => e.snow.depthCm).sort((a, b) => a - b);
    const new48s = entries.map((e) => e.snow.new48).filter((v) => v !== null);
    const best = entries.reduce((a, b) => ((b.snow.new48 ?? -1) > (a.snow.new48 ?? -1) ? b : a));

    out[regionId] = {
      source: 'senorge',
      sampleCount: entries.length,
      depthCm: median(depths),
      depthMaxCm: depths[depths.length - 1],
      new48: new48s.length ? Math.max(...new48s) : null,
      new48Median: new48s.length ? median([...new48s].sort((a, b) => a - b)) : null,
      new24: maxOf(entries.map((e) => e.snow.new24)),
      new72: maxOf(entries.map((e) => e.snow.new72)),
      topTour: best.tour.name,
      observedAt: entries[0].snow.observedAt,
    };
  }
  return out;
}

const maxOf = (arr) => {
  const v = arr.filter((x) => x !== null && x !== undefined);
  return v.length ? Math.max(...v) : null;
};

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}
