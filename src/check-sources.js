#!/usr/bin/env node
/**
 * Are the upstreams still answering the way this code reads them? (v6.0.1)
 *
 *   docker compose exec toppturvarsel node src/check-sources.js
 *
 * One small request to each source, the same calls the refresh and the maps
 * make, then a line per source: OK, WARN (answers, but something to look at)
 * or FAIL (down, or a shape the code does not know). Exit code 1 on any
 * FAIL. Nothing is stored and no alert is sent; safe to run any time.
 *
 * Written for the first run against the live Swiss services (built from
 * their documentation and a real February bulletin, never called from the
 * build machine), and for the first Swedish bulletin of the season (11
 * December): the Swedish page is scraped, and its in-season markup has not
 * been seen yet.
 */

import { loadRegions, loadTours } from './config.js';
import { getJSON } from './util/http.js';
import { UA } from './util/ua.js';
import { fetchNorwegianBulletins } from './sources/varsom.js';
import { fetchSwedishBulletins } from './sources/lavinprognoser.js';
import { fetchSnowForPoints } from './sources/senorge.js';
import { shapeSwiss } from './sources/slf.js';
import { pickStation } from './sources/slfsnow.js';
import { describeSquare } from './sources/swissalti3d.js';
import { swissMicroRegions, regionIn, microRegions } from './sources/eawsregions.js';
import { fetchEawsFeed, stateUrl } from './sources/eawsfeed.js';
import { fetchAlpineSnow } from './sources/geosphere.js';

const SLF_BULLETIN = process.env.SLF_BULLETIN_URL || 'https://aws.slf.ch/api/bulletin/caaml';
const SLF_MEASURE = process.env.SLF_MEASUREMENT_URL || 'https://measurement-api.slf.ch/public/api/imis';

const tileXY = (z, lat, lon) => {
  const n = 2 ** z, R = Math.PI / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(lat * R) + 1 / Math.cos(lat * R)) / Math.PI) / 2) * n)];
};
/** Swedish avalanche season: 11 December to the end of April. */
export const swedishSeason = (d = new Date()) => {
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return (m === 12 && day >= 11) || m <= 4;
};
/** Swiss season: SLF publishes daily from about November to May. */
const swissSeason = (d = new Date()) => {
  const m = d.getUTCMonth() + 1;
  return m >= 12 || m <= 4;
};

/** Austrian and Euregio season: the services publish from about December to April. */
const alpineSeason = (d = new Date()) => {
  const m = d.getUTCMonth() + 1;
  return m >= 12 || m <= 4;
};

async function tile(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const kind = buf[0] === 0xff && buf[1] === 0xd8 ? 'JPEG' : buf[0] === 0x89 && buf[1] === 0x50 ? 'PNG' : 'not an image';
  return { status: res.status, kind, bytes: buf.length };
}

/** Every check: { name, run() -> { status: 'OK'|'WARN'|'FAIL', detail } }. */
export async function checks({ now = new Date() } = {}) {
  const [regions, tours] = await Promise.all([loadRegions(), loadTours()]);
  const swissRegions = regions.filter((r) => r.country === 'CH');
  const swissIds = new Set(swissRegions.map((r) => r.id));
  const swissTours = tours.filter((t) => swissIds.has(t.region));
  // v6.2: Austria and Euregio.
  const alpineRegions = regions.filter((r) => r.country === 'AT' || r.country === 'IT');
  const alpineIds = new Set(alpineRegions.map((r) => r.id));
  const alpineTours = tours.filter((t) => alpineIds.has(t.region));
  const ok = (detail) => ({ status: 'OK', detail });
  const warn = (detail) => ({ status: 'WARN', detail });
  const fail = (detail) => ({ status: 'FAIL', detail });

  return [
    {
      name: 'Varsom (Norway, bulletin)',
      async run() {
        const r = regions.find((x) => x.id === 'lyngen') ?? regions.find((x) => x.country === 'NO' && x.varsomId);
        const b = (await fetchNorwegianBulletins([r], { date: now }))[r.id];
        if (b?.error) return fail(b.error);
        return b.danger ? ok(`${r.name}: danger ${b.danger}, ${b.problems.length} problem(s)`) : ok(`${r.name}: answers, no danger level (out of season)`);
      },
    },
    {
      name: 'lavinprognoser.se (Sweden, scraped page)',
      async run() {
        const r = regions.find((x) => x.country === 'SE' && x.slug);
        const b = (await fetchSwedishBulletins([r]))[r.id];
        if (b?.error) return fail(b.error);
        if (b.confidence === 'parsed') return ok(`${r.name}: danger ${b.danger} read from the page`);
        if (swedishSeason(now) && !b.seasonOver) {
          return warn(`${r.name}: in season, but no danger level could be read (confidence ${b.confidence}). The page may have changed: compare ${b.url} with src/sources/lavinprognoser.js`);
        }
        return ok(`${r.name}: page read, not assessed (${b.seasonOver ? 'season over' : 'out of season'}; the season opens 11 December)`);
      },
    },
    {
      name: 'seNorge (Nordic snow grid)',
      async run() {
        const t = tours.find((x) => x.name === 'Harahorn') ?? tours[0];
        const s = (await fetchSnowForPoints([{ key: t.name, lat: t.lat, lon: t.lon }], { date: now }))[t.name];
        if (s?.error) return fail(s.error);
        return ok(`${t.name}: ${s.depthCm ?? 'no'} cm (grid cell ${s.gridAltitude} m)`);
      },
    },
    {
      name: 'SLF bulletin (Switzerland)',
      async run() {
        const body = await getJSON(`${SLF_BULLETIN}/en/json`, { timeoutMs: 20000, retries: 1 });
        let shaped;
        try {
          shaped = shapeSwiss(body, swissRegions);
        } catch (err) {
          return fail(`${err.message} — the CAAML shape has changed; see src/sources/slf.js`);
        }
        const n = body.bulletins.length;
        if (!n) return swissSeason(now) ? warn('no bulletin in the feed although it is the season') : ok('answers; no bulletin (outside the season)');
        const odd = body.bulletins.filter((b) => !Array.isArray(b.regions) || !Array.isArray(b.dangerRatings));
        if (odd.length) return fail(`${odd.length} of ${n} bulletins lack regions or dangerRatings`);
        const missing = swissRegions.filter((r) => !shaped[r.id]?.danger);
        if (missing.length) {
          return warn(`${n} bulletins, but no danger level for ${missing.map((r) => `${r.name} (${r.slfRegion})`).join(', ')}: check slfRegion in data/regions.json`);
        }
        return ok(`${n} bulletins; all ${swissRegions.length} Swiss regions have a danger level`);
      },
    },
    {
      name: 'SLF IMIS stations (Swiss snow)',
      async run() {
        const list = await getJSON(`${SLF_MEASURE}/stations`, { timeoutMs: 20000, retries: 1 });
        if (!Array.isArray(list) || !list.length) return fail('no station list');
        const bad = list.filter((s) => !s.code || !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon)));
        if (bad.length === list.length) return fail('stations lack code/lat/lon — the shape has changed; see src/sources/slfsnow.js');
        const stations = list.map((s) => ({ code: s.code, label: s.label, lat: Number(s.lat), lon: Number(s.lon), elevation: Number(s.elevation) || null }));
        const lonely = swissTours.filter((t) => !pickStation(stations, { lat: t.lat, lon: t.lon, ele: t.summit_m - 0.4 * t.vertical_m }));
        if (lonely.length) return warn(`${list.length} stations; none within 25 km of ${lonely.map((t) => t.name).join(', ')}`);
        return ok(`${list.length} stations; every Swiss tour has one within 25 km`);
      },
    },
    {
      name: 'SLF IMIS daily snow',
      async run() {
        const rows = await getJSON(`${SLF_MEASURE}/daily-snow?period_in_days=3`, { timeoutMs: 20000, retries: 1 });
        if (!Array.isArray(rows)) return fail('not a list — the shape has changed; see src/sources/slfsnow.js');
        if (!rows.length) return warn('an empty list');
        const r = rows[0];
        if (!('station_code' in r) || !('measure_date' in r) || !('HS' in r) || !('HN_1D' in r)) {
          return fail(`fields are ${Object.keys(r).join(', ')}; expected station_code, measure_date, HS, HN_1D`);
        }
        const latest = rows.map((x) => String(x.measure_date)).sort().pop();
        const withHs = rows.filter((x) => Number.isFinite(x.HS)).length;
        return ok(`${rows.length} readings, latest ${latest.slice(0, 16)}; ${withHs} with a snow depth`);
      },
    },
    {
      name: 'swissALTI3D (Swiss terrain, 2 m)',
      async run() {
        const t = swissTours[0];
        if (!t) return warn('no Swiss tours listed');
        const d = await describeSquare(t.lat, t.lon);
        if (!d) return fail(`no file found for ${t.name}'s square in swisstopo's catalogue`);
        const off = Number.isFinite(d.height) ? Math.round(d.height - t.summit_m) : null;
        const line = `${d.id}: ${d.info}; ${Math.round(d.height)} m at ${t.name}'s point (listed summit ${t.summit_m} m)`;
        // The listed coordinates are approximate: far below the summit means they miss it.
        return off !== null && off < -150 ? warn(`${line} — the tour's coordinates may be off`) : ok(line);
      },
    },
    {
      name: 'SLF micro-region outlines (EAWS)',
      async run() {
        const regions = await swissMicroRegions();
        if (!regions) return fail('could not load the outlines (regions.avalanches.org)');
        const wrong = [];
        for (const t of swissTours) {
          const listed = swissRegions.find((r) => r.id === t.region)?.slfRegion;
          const at = regionIn(regions, t.lat, t.lon);
          if (at !== listed) wrong.push(`${t.name}: listed ${listed}, lies in ${at ?? 'none'}`);
        }
        return wrong.length
          ? warn(`${regions.length} micro-regions; ${wrong.length} tour(s) in another one than listed — ${wrong.join('; ')} (fix slfRegion / the tour's region in data/)`)
          : ok(`${regions.length} micro-regions; every Swiss tour lies in the one it is listed in`);
      },
    },
    {
      name: 'swisstopo map and slope tiles',
      async run() {
        const t = swissTours[0];
        if (!t) return warn('no Swiss tours listed');
        const [x, y] = tileXY(13, t.lat, t.lon);
        const topo = await tile(`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/13/${x}/${y}.jpeg`);
        const slope = await tile(`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hangneigung-ueber_30/default/current/3857/13/${x}/${y}.png`);
        const line = `map ${topo.status} ${topo.kind}, slope ${slope.status} ${slope.kind} (at ${t.name})`;
        if ([400, 404].includes(topo.status)) return fail(`${line} — check the layer name in src/tiles.js`);
        if (topo.status !== 200 || topo.kind === 'not an image') return fail(line);
        if (![200, 204, 404].includes(slope.status)) return fail(line);
        return ok(line);
      },
    },
    {
      name: 'EAWS bulletin files (Austria, Euregio)',
      async run() {
        if (!alpineRegions.length) return warn('no Austrian or Italian regions listed');
        // The file layout, on a day with a bulletin: 1 March of this winter.
        const y = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        const known = `${y}-03-01`;
        const probe = await getJSON(stateUrl(known, 'AT-07'), { timeoutMs: 20000, retries: 1 });
        if (probe === null) return fail(`${stateUrl(known, 'AT-07')} does not exist — the file layout has changed; see src/sources/eawsfeed.js`);
        const b0 = probe.bulletins?.[0];
        if (!b0 || !Array.isArray(b0.regions) || !Array.isArray(b0.dangerRatings) || !b0.regions[0]?.regionID) return fail('a known day\'s file lacks bulletins[].regions / dangerRatings — the CAAML shape has changed');
        const feed = await fetchEawsFeed(alpineRegions, { now });
        const bad = Object.entries(feed.states).filter(([, v]) => !v.ok);
        if (bad.length) return fail(bad.map(([k, v]) => `${k}: ${v.error}`).join('; '));
        const days = Object.entries(feed.states).map(([k, v]) => `${k} ${v.day ? `${v.bulletins} bulletins (${v.day})` : 'none'}`).join(', ');
        const open = Object.values(feed.states).some((v) => v.day);
        if (!open) return alpineSeason(now) ? warn(`no bulletin although it is the season (${days})`) : ok(`file layout fine (checked ${known}: ${probe.bulletins.length} bulletins); none published now (outside the season)`);
        const missing = alpineRegions.filter((r) => !feed.byRegion[r.id]?.danger);
        if (missing.length) return warn(`${days}; no danger level for ${missing.map((r) => `${r.name} (${feed.byRegion[r.id]?.microRegion ?? feed.byRegion[r.id]?.error ?? '?'})`).join(', ')}`);
        const providers = [...new Set(alpineRegions.map((r) => feed.byRegion[r.id]?.provider).filter(Boolean))];
        return ok(`${days}; all ${alpineRegions.length} regions have a danger level${providers.length ? ` (${providers.join(', ')})` : ''}`);
      },
    },
    {
      name: 'EAWS micro-region outlines (Austria, Euregio)',
      async run() {
        if (!alpineRegions.length) return warn('no Austrian or Italian regions listed');
        const wrong = [];
        let n = 0;
        for (const code of [...new Set(alpineRegions.map((r) => r.eawsState))]) {
          const list = await microRegions(code);
          if (!list) return fail(`could not load the outlines of ${code} (regions.avalanches.org)`);
          n += list.length;
          for (const r of alpineRegions.filter((x) => x.eawsState === code)) {
            if (!regionIn(list, r.lat, r.lon)) wrong.push(`${r.name}: its point lies in no ${code} micro-region`);
          }
        }
        for (const t of alpineTours) {
          const r = alpineRegions.find((x) => x.id === t.region);
          const list = await microRegions(r.eawsState);
          const here = regionIn(list, t.lat, t.lon), there = regionIn(list, r.lat, r.lon);
          if (here !== there) wrong.push(`${t.name}: lies in ${here ?? 'none'}, its region ${r.name} in ${there}`);
        }
        return wrong.length
          ? warn(`${n} micro-regions; ${wrong.join('; ')} (move the tour to another region in data/, or check eawsState)`)
          : ok(`${n} micro-regions; every region's point and every tour lie in the same micro-region`);
      },
    },
    {
      name: 'GeoSphere Austria (snow stations)',
      async run() {
        if (!alpineTours.length) return warn('no Austrian or Italian tours listed');
        const pts = alpineTours.map((t) => ({ key: t.name, lat: t.lat, lon: t.lon, ele: t.summit_m - 0.4 * t.vertical_m }));
        const got = await fetchAlpineSnow(pts, { now });
        const errs = Object.values(got).filter((x) => x.error && !/no GeoSphere station/.test(x.error));
        if (errs.length) return fail(errs[0].error);
        const hits = Object.values(got).filter((x) => !x.error);
        if (!hits.length) return alpineSeason(now) ? warn('no tour has a station with snow data within 25 km although it is the season') : ok('answers; no station reports snow now (outside the season)');
        const old = hits.filter((x) => x.stale).length;
        return old
          ? warn(`${hits.length} of ${alpineTours.length} tours have a station; ${old} reading(s) more than a day old`)
          : ok(`${hits.length} of ${alpineTours.length} tours have a station with snow data within 25 km`);
      },
    },
    {
      name: 'basemap.at tile (Austria)',
      async run() {
        const t = alpineTours.find((x) => alpineRegions.find((r) => r.id === x.region)?.country === 'AT');
        if (!t) return warn('no Austrian tours listed');
        const [x, y] = tileXY(13, t.lat, t.lon);
        const r = await tile(`https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/13/${y}/${x}.png`);
        const line = `map ${r.status} ${r.kind} (at ${t.name})`;
        if ([400, 404].includes(r.status)) return fail(`${line} — check the layer name in src/tiles.js`);
        return r.status === 200 && r.kind !== 'not an image' ? ok(line) : fail(line);
      },
    },
    {
      name: 'Open-Meteo (forecast, all countries)',
      async run() {
        const t = swissTours[0] ?? tours[0];
        const b = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${t.lat}&longitude=${t.lon}&daily=temperature_2m_max&forecast_days=1`, { retries: 1 });
        return Array.isArray(b?.daily?.time) ? ok(`answers (${t.name})`) : fail('unexpected shape');
      },
    },
    {
      name: 'MET Norway (route weather, all countries)',
      async run() {
        const t = swissTours[0] ?? tours[0];
        const b = await getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${t.lat.toFixed(4)}&lon=${t.lon.toFixed(4)}`, { retries: 1 });
        return Array.isArray(b?.properties?.timeseries) ? ok(`answers (${t.name}), ${b.properties.timeseries.length} hours`) : fail('unexpected shape');
      },
    },
  ];
}

export async function runChecks(opts) {
  const out = [];
  for (const c of await checks(opts)) {
    let r;
    try {
      r = await c.run();
    } catch (err) {
      r = { status: 'FAIL', detail: err.message };
    }
    out.push({ name: c.name, ...r });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runChecks();
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  const bad = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  console.log(`\n${results.length - bad - warns} OK, ${warns} to look at, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}
