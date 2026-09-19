import { loadRegions, loadTours, inSeason, config } from './config.js';
import { fetchNorwegianBulletins } from './sources/varsom.js';
import { fetchSwedishBulletins } from './sources/lavinprognoser.js';
import { fetchSnowForPoints, summariseByRegion } from './sources/senorge.js';
import { fetchObservationCounts } from './sources/regobs.js';
import { store } from './store.js';
import { cachedRouteStart } from './tracks.js';
import { log } from './util/log.js';

/**
 * One refresh = pull every upstream, merge into a single snapshot, persist.
 *
 * Partial failure is normal and must not be fatal: if Varsom is down we still
 * want snow depths, and if the Swedish scraper breaks we still want Norway.
 * Every section therefore carries its own error rather than throwing.
 */
export async function refresh({
  force = false,
  date = new Date(),
  seasonOnly = config.seasonOnly,
} = {}) {
  const startedAt = Date.now();
  const [regions, tours] = await Promise.all([loadRegions(), loadTours()]);

  if (seasonOnly && !inSeason(date) && !force) {
    log.info('refresh: out of season, skipping upstream calls');
    const snapshot = emptySnapshot(regions, tours, date, 'out-of-season');
    await store.saveSnapshot(snapshot);
    return snapshot;
  }

  // Snow is sampled at tour coordinates, because that is where anyone
  // actually stands. Regions with no tour in the list would otherwise show
  // no snow at all, so they get one fallback sample at the region point -
  // flagged as such, and carrying the grid cell's altitude so a reading
  // taken low down is visible as a low-altitude reading rather than passed
  // off as a summit depth.
  const tourPoints = tours.map((t) => ({ key: t.name, lat: t.lat, lon: t.lon }));
  // Where a route is known, also sample its start: the trip planner uses it
  // to say "skiable from the car" or "carry skis".
  const startPoints = [];
  for (const t of tours) {
    const s = await cachedRouteStart(t).catch(() => null);
    if (s) startPoints.push({ key: `start:${t.name}`, ...s });
  }
  const regionsWithoutTours = regions.filter(
    (r) => !r.offMap && !tours.some((t) => t.region === r.id)
  );
  const fallbackPoints = regionsWithoutTours.map((r) => ({
    key: `region:${r.id}`,
    lat: r.lat,
    lon: r.lon,
  }));

  const [norway, sweden, snowByTour, observations] = await Promise.all([
    fetchNorwegianBulletins(regions, { date }).catch((e) => {
      log.error(`varsom failed wholesale: ${e.message}`);
      return {};
    }),
    fetchSwedishBulletins(regions).catch((e) => {
      log.error(`lavinprognoser failed wholesale: ${e.message}`);
      return {};
    }),
    fetchSnowForPoints([...tourPoints, ...startPoints, ...fallbackPoints], { date }).catch((e) => {
      log.error(`senorge failed wholesale: ${e.message}`);
      return {};
    }),
    fetchObservationCounts(regions).catch((e) => {
      log.error(`regobs failed wholesale: ${e.message}`);
      return { counts: {}, lastError: e.message, verified: false };
    }),
  ]);

  const snowByRegion = summariseByRegion(snowByTour, tours);

  const regionRows = regions.map((region) => {
    const bulletin = region.noForecast
      ? { source: 'none', noForecast: true, assessed: false, danger: null, headline: 'No avalanche forecast is issued for this area.' }
      : region.country === 'NO' ? norway[region.id] : sweden[region.id];

    let snow = snowByRegion[region.id] ?? null;
    if (!snow) {
      const fb = snowByTour[`region:${region.id}`];
      if (fb && !fb.error && fb.depthCm !== null) {
        snow = {
          ...fb,
          sampleCount: 1,
          fallback: true,
          topTour: null,
          depthMaxCm: fb.depthCm,
        };
      }
    }
    const obs = observations.counts?.[region.id] ?? null;

    return {
      id: region.id,
      name: region.name,
      country: region.country,
      lat: region.lat,
      lon: region.lon,
      offMap: region.offMap ?? false,
      bulletinUrl: bulletinUrl(region),
      bulletin: bulletin ?? { error: 'not fetched', danger: null },
      snow,
      observations: obs,
      // The forecaster's own words about what observers saw. Verified field,
      // and for Norway it is what the observations panel actually shows.
      observationSummary:
        region.country === 'NO'
          ? {
              latest: bulletin?.latestObservations ?? null,
              avalancheActivity: bulletin?.latestAvalancheActivity ?? null,
            }
          : null,
    };
  });

  const tourRows = tours.map((t) => {
    const start = snowByTour[`start:${t.name}`];
    return {
      ...t,
      snow: snowByTour[t.name] ?? null,
      snowStart: start && !start.error ? { depthCm: start.depthCm, gridAltitude: start.gridAltitude } : null,
    };
  });

  const fallbackCount = regionRows.filter((r) => r.snow?.fallback).length;
  if (fallbackCount) {
    log.debug(`refresh: ${fallbackCount} region(s) using a single fallback snow sample`);
  }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    season: inSeason(date),
    status: 'ok',
    sources: {
      varsom: { ok: Object.keys(norway).length > 0, regions: Object.keys(norway).length },
      lavinprognoser: {
        ok: Object.keys(sweden).length > 0,
        regions: Object.keys(sweden).length,
        scraped: true,
      },
      senorge: {
        ok: Object.values(snowByTour).some((s) => s && !s.error),
        points: Object.keys(snowByTour).length,
      },
      regobs: {
        enabled: observations.counts
          ? Object.values(observations.counts).some((o) => o.enabled)
          : false,
        verified: observations.verified ?? false,
        lastError: observations.lastError ?? null,
      },
    },
    regions: regionRows,
    tours: tourRows,
  };

  await store.saveSnapshot(snapshot);
  log.info(
    `refresh: done in ${snapshot.durationMs}ms - ` +
      `${regionRows.filter((r) => r.bulletin?.danger).length} regions with a danger level, ` +
      `${tourRows.filter((t) => t.snow?.depthCm !== null && t.snow?.depthCm !== undefined).length} tours with snow data`
  );
  return snapshot;
}

function bulletinUrl(region) {
  if (region.noForecast) return null;
  if (region.country === 'NO') {
    return `https://www.varsom.no/en/snow/forecast/warning/${encodeURIComponent(region.name.replace(/ \(Svalbard\)$/, ''))}/`;
  }
  return `https://www.lavinprognoser.se/oversikt-alla-omraden/${region.slug}/`;
}

function emptySnapshot(regions, tours, date, status) {
  return {
    fetchedAt: new Date().toISOString(),
    durationMs: 0,
    season: inSeason(date),
    status,
    sources: {},
    regions: regions.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      offMap: r.offMap ?? false,
      bulletinUrl: bulletinUrl(r),
      bulletin: { danger: null, assessed: false, outOfSeason: true },
      snow: null,
      observations: null,
      observationSummary: null,
    })),
    tours: tours.map((t) => ({ ...t, snow: null })),
  };
}
