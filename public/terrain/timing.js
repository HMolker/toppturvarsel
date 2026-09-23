/**
 * When to go (v5.5): a built tour laid out on a day. Given each part's
 * Munter time, the daylight, the hourly weather and when wet snow starts on
 * each descent's aspect, pick the departure that keeps the tour in the light,
 * gets every descent done before its wet snow, and has the best weather on
 * the way — earliest among near-equals, for margin at the end of the day.
 *
 * Uses the planner's own pieces (daywindow.js, daylight.js), so the tour and
 * the trip planner agree about light, weather and wet snow.
 */

import { sunTimes } from '../daylight.js';
import { hoursOf, hourScore, wetHours } from '../daywindow.js';

/** Minutes for changing over at the top of each descent (skins off) and at its bottom (skins on). */
export const TRANSITION_H = 0.25;

const clampLight = (sun) => {
  if (!sun.light) return null;
  const all = sun.light.end - sun.light.start >= 23.9;
  // Midnight sun: still a day out, not a night out.
  return { start: all ? 5 : sun.light.start, end: all ? 23 : sun.light.end };
};

export const hhmm = (h) => {
  if (!Number.isFinite(h)) return '–';
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * parts: [{ kind: 'leg' | 'descent', label, hours, aspects?: ['S', …] }]
 * place: { lat, lon, vertical_m } (the tour; vertical for the wet-snow height)
 * hourly: the planner's hourly series (time "YYYY-MM-DDTHH:00", Norwegian time)
 * iso: the date; problems: that day's avalanche problems
 * Returns null without an hourly forecast for the day, else
 *   { iso, sun, light, depart, finish, parts: [{…, from, to, wetFrom, onWet}],
 *     fit: 'fits' | 'tight' | 'no' | 'dark', weather, warnings: [] }.
 */
export function planDay({ parts, place, hourly, iso, problems = [], stepH = 0.25 }) {
  const hrs = hoursOf(hourly, iso);
  if (hrs.length < 12) return null;
  const sun = sunTimes(iso, place.lat, place.lon);
  const light = clampLight(sun);
  const base = { iso, sun, light, parts: [], warnings: [] };
  if (!light) return { ...base, fit: 'dark', depart: null, finish: null, weather: null, warnings: ['No daylight on this day.'] };

  // Wet snow per descent aspect: from what hour it is soft.
  const wetFor = new Map();
  const wetAt = (aspects) => {
    const key = aspects.join(',');
    if (!wetFor.has(key)) { const w = wetHours(place, hourly, iso, { aspects, problems }); wetFor.set(key, { from: w.from, reason: w.reason }); }
    return wetFor.get(key);
  };
  const score = new Map(hrs.map(({ i, h }) => [h, hourScore(hourly, i)]));
  const total = parts.reduce((a, p) => a + p.hours + (p.kind === 'descent' ? 2 * TRANSITION_H : 0), 0);

  const simulate = (t0) => {
    let t = t0;
    const out = parts.map((p) => {
      if (p.kind === 'descent') t += TRANSITION_H; // skins off at the top
      const from = t;
      t += p.hours;
      const to = t;
      if (p.kind === 'descent') t += TRANSITION_H; // skins on at the bottom
      const w = p.kind === 'descent' ? wetAt(p.aspects?.length ? p.aspects : []) : null;
      const wetFrom = w?.from ?? null;
      const onWet = wetFrom != null ? Math.max(0, to - Math.max(from, wetFrom)) : 0;
      // 'thaw': warm air, every aspect; 'sun': spring sun on this aspect.
      return { ...p, from, to, wetFrom, wetReason: w?.reason ?? null, onWet };
    });
    // Weather: the hours on the tour, descents counting double.
    let ws = 0, wn = 0;
    for (const p of out) {
      for (let h = Math.floor(p.from); h < p.to; h++) {
        const s = score.get(h);
        if (s === undefined) continue;
        const w = p.kind === 'descent' ? 2 : 1;
        ws += s * w;
        wn += w;
      }
    }
    const weather = wn ? ws / wn : 0.5;
    const wetH = out.reduce((a, p) => a + p.onWet, 0);
    const late = Math.max(0, t - light.end);
    return { parts: out, finish: t, weather, wetH, late };
  };

  let best = null;
  const latest = Math.max(light.start, light.end - total);
  for (let t0 = Math.ceil(light.start / stepH) * stepH; t0 <= Math.max(latest, light.start) + 1e-9; t0 += stepH) {
    const r = simulate(t0);
    // Wet snow on a descent is the worst thing; darkness next; then weather.
    const value = r.weather - 2 * r.wetH - 3 * r.late;
    if (!best || value > best.value + 0.02) best = { ...r, depart: t0, value };
  }
  if (!best) best = { ...simulate(light.start), depart: light.start };

  const spare = light.end - best.finish;
  const fit = spare < 0 ? 'no' : spare < 1 ? 'tight' : 'fits';
  const warnings = [];
  if (fit === 'no') warnings.push(`The tour takes about ${hhmm(total)} h and there are ${hhmm(light.end - light.start)} h of light: it does not fit in the day.`);
  else if (fit === 'tight') warnings.push(`Less than an hour of light to spare: back at ${hhmm(best.finish)}, dark at ${hhmm(light.end)}.`);
  for (const p of best.parts) {
    if (p.onWet > 0.05) {
      const leaveBy = best.depart - (p.to - p.wetFrom);
      warnings.push(`${p.label} faces ${p.aspects?.join(', ') || 'mixed aspects'}: wet snow from about ${hhmm(p.wetFrom)}, and you would be on it until ${hhmm(p.to)}.` +
        (leaveBy >= light.start ? ` Leave by ${hhmm(leaveBy)}, or ski it earlier in the tour.` : ' Not possible to be off it in time in daylight: ski it earlier in the tour, or choose another day.'));
    }
  }
  return { ...base, parts: best.parts, depart: best.depart, finish: best.finish, fit, weather: Math.round(best.weather * 100) / 100, warnings };
}

/** The aspects a descent faces most, from its profile samples (slopes 15°+ only when there are any). */
export function descentAspects(samples, octant, minShare = 0.2) {
  const steep = samples.filter((s) => Number.isFinite(s.slope) && s.slope >= 15 && s.aspect != null);
  const use = steep.length >= 3 ? steep : samples.filter((s) => s.aspect != null);
  const count = new Map();
  for (const s of use) {
    const o = octant(s.aspect);
    if (o) count.set(o, (count.get(o) ?? 0) + 1);
  }
  const n = use.length || 1;
  return [...count].filter(([, c]) => c / n >= minShare).sort((a, b) => b[1] - a[1]).map(([o]) => o);
}

/* ------------------------------------------------------------------ *
 * a better order of descents when wet snow gets in the way (v5.5)
 * ------------------------------------------------------------------ */

/** All orders of 0..n-1 (n ≤ 6: at most 720). */
export function permutations(n) {
  const out = [];
  const rec = (a, rest) => {
    if (!rest.length) { out.push(a); return; }
    rest.forEach((x, i) => rec([...a, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], [...Array(n).keys()]);
  return out;
}

/**
 * Try every order of the descents (each skied as drawn) and time each on
 * the day. `legHours(from, to)` gives the Munter hours of the leg between
 * two points (null when there is no way); `descents[k]` is { label, hours,
 * aspects, top, bottom }. Best: least time on wet snow, then fits the light,
 * then the shortest day, then the best weather.
 * Returns [{ order, plan, wetH, finish }] best first, the current order marked.
 */
export function rankOrders({ start, descents, legHours, day }) {
  const n = descents.length;
  if (n > 6) return [];
  const near = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180)) < 30;
  const results = [];
  for (const order of permutations(n)) {
    const parts = [];
    let at = start, ok = true;
    order.forEach((k, pos) => {
      const d = descents[k];
      if (!near(at, d.top)) {
        const h = legHours(at, d.top);
        if (h == null) ok = false;
        parts.push({ kind: 'leg', label: pos === 0 ? `Up to ${d.label.toLowerCase()}` : `To ${d.label.toLowerCase()}`, hours: h ?? 0 });
      }
      parts.push({ kind: 'descent', label: d.label, hours: d.hours, aspects: d.aspects });
      at = d.bottom;
    });
    if (!near(at, start)) {
      const h = legHours(at, start);
      if (h == null) ok = false;
      parts.push({ kind: 'leg', label: 'Back to the start', hours: h ?? 0 });
    }
    if (!ok) continue;
    const plan = planDay({ ...day, parts });
    if (!plan || !plan.light) continue;
    const wetH = plan.parts.reduce((a, p) => a + p.onWet, 0);
    results.push({ order, plan, wetH, finish: plan.finish, current: order.every((k, i) => k === i) });
  }
  const fitRank = { fits: 0, tight: 1, no: 2 };
  results.sort((a, b) => (a.wetH - b.wetH > 0.05 || b.wetH - a.wetH > 0.05 ? a.wetH - b.wetH : 0)
    || fitRank[a.plan.fit] - fitRank[b.plan.fit]
    || (Math.abs(a.finish - b.finish) > 0.1 ? a.finish - b.finish : 0)
    || b.plan.weather - a.plan.weather
    || (a.current ? -1 : b.current ? 1 : 0));
  return results;
}
