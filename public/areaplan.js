/**
 * A few days in one area: which region gives the best run of tours over the
 * trip, one different tour per day.
 *
 * Works on the planner's output (plan() in planner.js), so it inherits the
 * avalanche filter as it is: a day where nothing passes in a region is a rest
 * day and counts as zero, which is what it is on a trip.
 */

const PASS = (r) => r.status === 'ok' || r.status === 'caution';

/**
 * @param p        plan() result
 * @param start    index of the first day (0 = today)
 * @param length   trip length in days (clamped to what the forecast covers)
 * @param top      how many areas to return
 * @returns { start, length, dates, areas: [{ region, mean, tourDays, restDays, days: [{ date, k, row|null }] }] }
 */
export function planTrip(p, { start = 0, length = 3, top = 3 } = {}) {
  const days = p?.days ?? [];
  const s = Math.max(0, Math.min(start, days.length - 1));
  const n = Math.max(1, Math.min(length, days.length - s));
  const span = days.slice(s, s + n);
  if (!span.length) return { start: s, length: 0, dates: [], areas: [] };

  const regions = new Set();
  for (const d of span) for (const r of d.rows) regions.add(r.region);

  const areas = [];
  for (const region of regions) {
    const used = new Set();
    const picks = span.map((d) => {
      const row = d.rows.filter((r) => r.region === region && PASS(r) && !used.has(r.tour)).sort((a, b) => b.score - a.score)[0] ?? null;
      if (row) used.add(row.tour);
      return { date: d.date, k: d.k, row };
    });
    const tourDays = picks.filter((x) => x.row).length;
    if (!tourDays) continue;
    const mean = Math.round(picks.reduce((t, x) => t + (x.row?.score ?? 0), 0) / picks.length);
    // How many tours the area has at all, so "one good tour and nothing else" shows.
    const depth = new Set(span.flatMap((d) => d.rows.filter((r) => r.region === region).map((r) => r.tour))).size;
    areas.push({ region, mean, tourDays, restDays: picks.length - tourDays, tours: depth, days: picks });
  }
  // Best mean first; ties go to the area with more tours to fall back on.
  areas.sort((a, b) => b.mean - a.mean || b.tours - a.tours);
  return { start: s, length: n, dates: span.map((d) => d.date), areas: areas.slice(0, top) };
}
