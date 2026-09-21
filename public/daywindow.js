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

/* ------------------------------------------------------------------ *
 * wet snow: warming and sun make the afternoon the dangerous part
 * ------------------------------------------------------------------ */

/** Problems that grow with warming through the day (EAWS wet snow, gliding snow). */
export const isWetProblem = (p) => /wet|glid/i.test(`${p?.problemType ?? ''} ${p?.type ?? ''}`);

/** When the sun is on a slope facing each way (local clock hours, spring). */
export const SUN_ON = { E: [8, 12], SE: [9, 14], S: [10, 15], SW: [12, 17], W: [13, 18] };

/** Degrees per metre, standard lapse rate: the tour's mid-height is warmer than the summit. */
const LAPSE = 0.0065;

/**
 * Which daylight hours are wet-snow hours, and why.
 * - thaw: the air at the tour's mid-height is above about +1°
 *   (0° when the bulletin names a wet-snow problem);
 * - sun: March–June, little cloud, the sun on an east-to-west aspect, and not too cold at
 *   mid-height (−1° in March, when the sun is still weak; −3° from April).
 * Returns { from, reason, hours: Set of wet clock hours, bulletin: bool }.
 */
export function wetHours(tour, hourly, iso, { aspects = [], problems = [] } = {}) {
  const bulletin = (problems ?? []).some(isWetProblem);
  const month = Number(iso.slice(5, 7));
  const spring = month >= 3 && month <= 6;
  const mid = ((tour.vertical_m ?? 600) / 2) * LAPSE;
  const thawAt = bulletin ? 0 : 1;
  const wet = new Set();
  const reasons = new Map();
  for (const { i, h } of hoursOf(hourly, iso)) {
    const t = hourly.temp?.[i];
    if (!Number.isFinite(t)) continue;
    const tMid = t + mid;
    if (tMid >= thawAt) {
      wet.add(h);
      reasons.set(h, 'thaw');
      continue;
    }
    const cloud = hourly.cloud?.[i] ?? 100;
    const sunny = spring && cloud < 50 && tMid >= (month === 3 ? -1 : -3) && aspects.some((a) => SUN_ON[a] && h >= SUN_ON[a][0] && h < SUN_ON[a][1]);
    if (sunny) {
      wet.add(h);
      reasons.set(h, 'sun');
    }
  }
  // Once it has gone soft it stays soft for the day: every later hour counts.
  const first = wet.size ? Math.min(...wet) : null;
  if (first != null) for (let h = first; h < 24; h++) wet.add(h);
  return { from: first, reason: first == null ? null : reasons.get(first), hours: wet, bulletin };
}

/**
 * The best window on a date for a tour.
 * { sun, needH, lightH, start, end, score, fit: 'fits'|'tight'|'no'|'dark', hours, wet }
 * null when there is no hourly forecast for that date.
 *
 * opts.aspects   the tour's descent aspects (for sun on the slope)
 * opts.problems  that day's avalanche problems (a wet-snow problem makes the thaw a hard limit)
 */
export function dayWindow(tour, hourly, iso, { aspects = [], problems = [] } = {}) {
  const hrs = hoursOf(hourly, iso);
  if (hrs.length < 12) return null;
  const sun = sunTimes(iso, tour.lat, tour.lon);
  const needH = tourHours(tour);
  const need = Math.max(1, Math.ceil(needH));
  const wet = wetHours(tour, hourly, iso, { aspects, problems });

  if (!sun.light) return { sun, needH, lightH: 0, start: null, end: null, score: 0, fit: 'dark', hours: [], wet };
  // Midnight sun: still a day out, not a night out. Keep to sensible hours.
  const from = Math.max(sun.light.start, sun.light.end - sun.light.start >= 23.9 ? 5 : 0);
  const to = Math.min(sun.light.end, sun.light.end - sun.light.start >= 23.9 ? 23 : 24);
  // An hour counts as light when most of it is.
  const usable = hrs.filter(({ h }) => h + 0.5 >= from && h + 0.5 <= to);
  // Wet-snow hours are poor hours, however fine the weather.
  const scored = usable.map(({ i, h }) => {
    const s = hourScore(hourly, i);
    return wet.hours.has(h) ? { h, s: Math.min(s, 0.25), wet: true } : { h, s };
  });
  const lightH = Math.round((to - from) * 10) / 10;

  if (!scored.length) return { sun, needH, lightH, start: null, end: null, score: 0, fit: 'no', hours: [], wet };

  const len = Math.min(need, scored.length);
  let runs = [];
  for (let a = 0; a + len <= scored.length; a++) {
    const run = scored.slice(a, a + len);
    // Consecutive clock hours only (a gap would mean missing data).
    if (run[run.length - 1].h - run[0].h !== len - 1) continue;
    runs.push({ start: run[0].h, end: run[0].h + len, score: run.reduce((t, x) => t + x.s, 0) / len, wetHours: run.filter((x) => x.wet).length });
  }
  // With a wet-snow problem in the bulletin the thaw is a hard limit: off the
  // slope before it, if the light allows that at all.
  const dry = runs.filter((r) => r.wetHours === 0);
  if (wet.bulletin && dry.length) runs = dry;
  // Near-ties (within 0.03) go to the earliest start: more margin at the end of the day.
  const top = Math.max(...runs.map((r) => r.score));
  const best = runs.find((r) => r.score >= top - 0.03) ?? null;
  if (!best) return { sun, needH, lightH, start: null, end: null, score: 0, fit: 'no', hours: scored, wet };

  // Usable light for the fit: the light before the thaw, when there is a thaw.
  const dryLight = wet.from != null ? Math.max(0, Math.min(to, wet.from) - from) : lightH;
  const spare = lightH - needH;
  let fit = spare < 0 ? 'no' : spare < 1 ? 'tight' : 'fits';
  if (wet.from != null && fit !== 'no' && dryLight < needH) fit = 'wet';
  return {
    sun, needH, lightH, start: best.start, end: best.end, score: Math.round(best.score * 100) / 100, fit, hours: scored,
    wet, wetInWindow: best.wetHours, dryLightH: Math.round(dryLight * 10) / 10,
  };
}

const hh = (h) => String(h).padStart(2, '0');
export const windowText = (w) => (w?.start == null ? null : `${hh(w.start)}–${hh(w.end)}`);
