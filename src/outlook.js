import { store } from './store.js';
import { loadTours } from './config.js';
import { getForecast } from './tracks.js';
import { mapLimit } from './util/http.js';
import { log } from './util/log.js';

/**
 * Inputs for the trip planner: the avalanche bulletin for each coming day
 * per region, and the 5-day summit forecast for every tour. The browser
 * does the scoring (public/planner.js), so changing your limits re-ranks
 * instantly without asking the server again.
 *
 * Forecasts come from the same 2-hour cache as the tour panel. A cold
 * cache costs one Open-Meteo request per tour (48), four at a time; after
 * that it is free until the cache expires. The endpoint takes no
 * parameters, so it cannot be used to query arbitrary places.
 */

const TTL = 30 * 60e3;
let memo = null;
let inflight = null;

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

/** Bulletin per day for one region: today plus whatever outlook days exist. */
export function bulletinDays(region, fallbackDate = null) {
  const b = region?.bulletin;
  if (!b || b.error) return [];
  const out = [];
  // Swedish bulletins are scraped and carry no date: they are today's.
  const today = dayOf(b.validFrom) ?? fallbackDate;
  out.push({
    date: today,
    danger: b.danger ?? null,
    problems: b.problems ?? [],
    source: b.source ?? null,
    assessed: b.assessed !== false && b.danger != null,
  });
  for (const o of b.outlook ?? []) {
    out.push({ date: dayOf(o.validFrom), danger: o.danger ?? null, problems: o.problems ?? [], source: b.source, assessed: o.danger != null });
  }
  return out.filter((x) => x.date);
}

/** The snapshot's "today": the Norwegian bulletins' date, else when it was fetched. */
export function snapshotDay(snapshot) {
  const dates = (snapshot?.regions ?? []).map((r) => dayOf(r.bulletin?.validFrom)).filter(Boolean).sort();
  return dates[0] ?? dayOf(snapshot?.fetchedAt) ?? null;
}

export async function getOutlook({ force = false } = {}) {
  if (!force && memo && Date.now() - memo.at < TTL) return memo.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [snapshot, tours] = await Promise.all([store.getSnapshot(), loadTours()]);
      const bulletins = {};
      const today = snapshotDay(snapshot);
      for (const r of snapshot?.regions ?? []) bulletins[r.id] = bulletinDays(r, today);

      const results = await mapLimit(tours, 4, (t) => getForecast(t));
      const forecasts = {};
      let failed = 0;
      results.forEach((res, i) => {
        if (res.ok) forecasts[tours[i].name] = { elevation: res.value.elevation, days: res.value.days };
        else {
          failed++;
          forecasts[tours[i].name] = null;
        }
      });
      if (failed) log.warn(`outlook: ${failed} tour forecast(s) failed`);
      const value = { generatedAt: new Date().toISOString(), snapshotAt: snapshot?.fetchedAt ?? null, bulletins, forecasts, failed };
      memo = { at: Date.now(), value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
