/**
 * Norwegian ski resorts with live lift and slope status, from Fnugg.
 *
 * One request returns every resort Fnugg lists (126 at the time of
 * writing). Response shape, verified live in September 2026:
 *   { hits: { total, hits: [ { _id, _source: {
 *       id, name, site_path,
 *       location: { lat, lon },
 *       urls: { homepage },
 *       resort_open: bool, resort_opening_date, resort_closing_date,
 *       lifts:  { open, count, closed, list: [{ name, status }] },
 *       slopes: { open, count, closed, list: [{ name, status, slope_difficulty }] },
 *       last_updated? } } ] } }
 *
 * Fnugg publishes no terms for this endpoint. Keep the load light (the
 * service refreshes at most hourly, one request each time), identify the
 * client, and credit Fnugg on the page.
 */

const API = process.env.FNUGG_URL || 'https://api.fnugg.no/search';

export const fnuggUrl = () => `${API}?size=400`;

export async function fetchFnugg() {
  const res = await fetch(fnuggUrl(), {
    headers: { 'User-Agent': 'fjallskred/1.0 (self-hosted ski touring dashboard; hourly)', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fnugg HTTP ${res.status}`);
  return shapeFnugg(await res.json());
}

// Fnugg also lists summer venues (bike parks). They are not ski resorts.
const SUMMER = /bike|sykkel|sommer|summer|downhill ?mtb/i;

const safeUrl = (u) => {
  try {
    // Some entries hold two addresses separated by spaces; take the first.
    const url = new URL(String(u ?? '').trim().split(/\s+/)[0]);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/** {open, count} or null when the resort does not report that facility. */
function counts(block) {
  const count = Number(block?.count);
  const open = Number(block?.open);
  if (!Number.isFinite(count) || count <= 0) return null;
  return { open: Number.isFinite(open) ? Math.max(0, Math.min(count, open)) : 0, count };
}

export function shapeFnugg(body) {
  const hits = body?.hits?.hits;
  if (!Array.isArray(hits)) throw new Error('fnugg: unexpected response shape');
  const out = [];
  for (const h of hits) {
    const s = h?._source ?? {};
    const lat = Number(s.location?.lat), lon = Number(s.location?.lon);
    if (!s.name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (SUMMER.test(`${s.name} ${s.site_path ?? ''}`)) continue;
    let lifts = counts(s.lifts);
    let slopes = counts(s.slopes);
    // A resort flagged closed is closed, whatever stale per-lift flags say.
    if (s.resort_open === false) {
      if (lifts) lifts = { ...lifts, open: 0 };
      if (slopes) slopes = { ...slopes, open: 0 };
    }
    out.push({
      id: `fnugg-${s.id ?? h._id}`,
      name: String(s.name).trim(),
      country: 'NO',
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      url: safeUrl(s.urls?.homepage),
      open: typeof s.resort_open === 'boolean' ? s.resort_open : null,
      lifts,
      slopes,
      live: Boolean(lifts || slopes),
      source: 'fnugg',
      season: { from: s.resort_opening_date ?? null, to: s.resort_closing_date ?? null },
    });
  }
  return out;
}
