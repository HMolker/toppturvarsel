/**
 * When in the day to go: the best run of hours inside the usable light, from
 * the hourly summit forecast, and whether the tour fits in it at all.
 *
 * A day's weather as a single number hides the thing that decides a tour:
 * "wind 14 m/s" may be 3 m/s until noon and a gale after. So each daylight
 * hour gets its own score (wind, gusts, cloud, snowfall, rain) and the window
 * is the stretch, as long as the tour needs, with the best average.
 */
import { sunTimes } from './daylight.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Rough tour time: 400 vertical metres an hour up, 1500 down, half an hour for
 * transitions and a break. Same rule of thumb as most Nordic guidebooks;
 * difficult terrain is slower, which the "tight" margin is there to absorb.
 */
export function tourHours(tour) {
  const v = Number(tour?.vertical_m);
  if (!Number.isFinite(v) || v <= 0) return 4;
  return Math.round((v / 400 + v / 1500 + 0.5) * 4) / 4;
}

/** Indices of the hourly series that belong to a date ("YYYY-MM-DD"). */
export function hoursOf(hourly, iso) {
  const out = [];
  (hourly?.time ?? []).forEach((t, i) => {
    if (t.startsWith(iso)) out.push({ i, h: Number(t.slice(11, 13)) });
  });
  return out;
}

/** One hour on the hill, 0–1. */
export function hourScore(hourly, i) {
  const wind = hourly.wind?.[i];
  const gust = hourly.gust?.[i];
  const cloud = hourly.cloud?.[i];
  const snow = hourly.snow?.[i] ?? 0;
  const precip = hourly.precip?.[i] ?? 0;
  const temp = hourly.temp?.[i];

  const w = Number.isFinite(wind) ? clamp01((15 - wind) / 9) : 0.6;
  // Clear is best for seeing the terrain; full cloud at the summit often means flat light.
  const sky = Number.isFinite(cloud) ? 1 - 0.55 * (cloud / 100) : 0.7;
  let wet = 1;
  if (snow >= 1) wet = 0.35;
  else if (snow >= 0.3) wet = 0.6;
  if (precip >= 0.3 && Number.isFinite(temp) && temp > 0.5) wet = Math.min(wet, 0.2); // rain
  let s = 0.45 * w + 0.35 * sky + 0.2 * wet;
  if (Number.isFinite(gust) && gust >= 17) s = Math.min(s, 0.3);
  return clamp01(s);
}

/**
 * The best window on a date for a tour.
 * { light, needH, lightH, start, end, score, fit: 'fits'|'tight'|'no'|'dark', hours }
 * null when there is no hourly forecast for that date.
 */
export function dayWindow(tour, hourly, iso) {
  const hrs = hoursOf(hourly, iso);
  if (hrs.length < 12) return null;
  const sun = sunTimes(iso, tour.lat, tour.lon);
  const needH = tourHours(tour);
  const need = Math.max(1, Math.ceil(needH));

  if (!sun.light) return { sun, needH, lightH: 0, start: null, end: null, score: 0, fit: 'dark', hours: [] };
  // Midnight sun: still a day out, not a night out. Keep to sensible hours.
  const from = Math.max(sun.light.start, sun.light.end - sun.light.start >= 23.9 ? 5 : 0);
  const to = Math.min(sun.light.end, sun.light.end - sun.light.start >= 23.9 ? 23 : 24);
  // An hour counts as light when most of it is.
  const usable = hrs.filter(({ h }) => h + 0.5 >= from && h + 0.5 <= to);
  const scored = usable.map(({ i, h }) => ({ h, s: hourScore(hourly, i) }));
  const lightH = Math.round((to - from) * 10) / 10;

  if (!scored.length) return { sun, needH, lightH, start: null, end: null, score: 0, fit: 'no', hours: [] };

  const len = Math.min(need, scored.length);
  const runs = [];
  for (let a = 0; a + len <= scored.length; a++) {
    const run = scored.slice(a, a + len);
    // Consecutive clock hours only (a gap would mean missing data).
    if (run[run.length - 1].h - run[0].h !== len - 1) continue;
    runs.push({ start: run[0].h, end: run[0].h + len, score: run.reduce((t, x) => t + x.s, 0) / len });
  }
  // Near-ties (within 0.03) go to the earliest start: more margin at the end of the day.
  const top = Math.max(...runs.map((r) => r.score));
  const best = runs.find((r) => r.score >= top - 0.03) ?? null;
  if (!best) return { sun, needH, lightH, start: null, end: null, score: 0, fit: 'no', hours: scored };

  const spare = lightH - needH;
  const fit = spare < 0 ? 'no' : spare < 1 ? 'tight' : 'fits';
  return { sun, needH, lightH, start: best.start, end: best.end, score: Math.round(best.score * 100) / 100, fit, hours: scored };
}

const hh = (h) => String(h).padStart(2, '0');
export const windowText = (w) => (w?.start == null ? null : `${hh(w.start)}–${hh(w.end)}`);
