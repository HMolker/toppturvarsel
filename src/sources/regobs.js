import { log } from '../util/log.js';

/**
 * Field observations from Regobs (NVE), the public observation database
 * behind Varsom: geolocated snowpack, avalanche-activity and weather reports
 * submitted by tourers, guides and forecasters, each with an observer
 * competence rating.
 *
 * STATUS: OFF BY DEFAULT, AND HERE IS WHY
 * ---------------------------------------
 * The Regobs v5 search endpoint is a POST API. Everything else this service
 * talks to is a plain GET that was verified against the live service before
 * being written. This one could not be: the build environment has no route
 * to api.regobs.no, so the request body shape below comes from the API
 * documentation rather than from an observed request/response pair.
 *
 * Shipping an unverified request that silently returns a wrong NUMBER is
 * worse than shipping nothing - a "0 observations" badge that is really a
 * schema mismatch reads as "nobody has been out there", which is exactly
 * the sort of wrong that gets acted on.
 *
 * So: REGOBS_ENABLED defaults to false, and the frontend falls back to the
 * forecaster's own observation summary from the Varsom Detail endpoint
 * (LatestObservations / LatestAvalancheActivity), which IS verified.
 *
 * To turn it on: set REGOBS_ENABLED=true, then check /api/health - it
 * reports regobs.lastError and regobs.sampleCount so you can confirm the
 * shape against https://api.nve.no/doc/regobs/ before believing the counts.
 *
 * Attribution: Regobs data is CC-licensed and requires crediting both
 * Regobs and the individual observer. The frontend does; keep it.
 */

const SEARCH_COUNT_URL = 'https://api.regobs.no/v5/Search/Count';

export const regobsEnabled = () =>
  (process.env.REGOBS_ENABLED ?? 'false').toLowerCase() === 'true';

/**
 * Regobs geo-hazard ids: 10 = snow.
 * Region ids are the same 3003-3037 codes Varsom uses.
 */
export async function fetchObservationCounts(regions, { hoursBack = 48 } = {}) {
  const targets = regions.filter((r) => r.country === 'NO' && r.varsomId);
  const out = {};

  if (!regobsEnabled()) {
    for (const r of targets) {
      out[r.id] = { source: 'regobs', enabled: false, count: null };
    }
    return { counts: out, lastError: null, verified: false };
  }

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - hoursBack * 3600000);
  let lastError = null;

  for (const region of targets) {
    try {
      const res = await fetch(SEARCH_COUNT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          LangKey: 2,
          FromDate: fromDate.toISOString(),
          ToDate: toDate.toISOString(),
          SelectedRegions: [region.varsomId],
          SelectedGeoHazards: [10],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      // Documented as returning a count; accept a bare number or an object
      // with a count-ish field, and refuse to invent one if neither appears.
      const count =
        typeof body === 'number'
          ? body
          : Number.isFinite(body?.TotalMatches)
            ? body.TotalMatches
            : Number.isFinite(body?.Count)
              ? body.Count
              : null;

      if (count === null) {
        throw new Error(`unrecognised response shape: ${JSON.stringify(body).slice(0, 120)}`);
      }
      out[region.id] = { source: 'regobs', enabled: true, count, hoursBack };
    } catch (err) {
      lastError = err.message;
      log.warn(`regobs: ${region.id} failed: ${err.message}`);
      out[region.id] = { source: 'regobs', enabled: true, count: null, error: err.message };
    }
  }

  const sampleCount = Object.values(out).filter((v) => v.count !== null).length;
  return { counts: out, lastError, verified: sampleCount > 0, sampleCount };
}
