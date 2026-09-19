#!/usr/bin/env node
/**
 * Simulated storm week for demos, out of season.
 *
 * This does NOT fake the app's output. It fakes the UPSTREAM: a small weather
 * model answers the same HTTP requests NVE's Varsom and seNorge APIs and
 * lavinprognoser.se would, and the service's real refresh() pipeline turns
 * those answers into snapshots — region summaries, fallback sampling, alert
 * evaluation and all. What the demo shows is what the code would show if the
 * week had actually happened.
 *
 *   node demo/simulate.mjs [outDir]      -> day-1.json … day-7.json
 *
 * Scenario, Mon 8 – Sun 14 Feb 2027:
 *   Mon  quiet, settled pack
 *   Tue  a westerly front reaches Finnmark and Troms
 *   Wed  peak in the north: 40–55 cm in 48 h, alerts fire
 *   Thu  front slides south through Nordland; danger peaks in Troms
 *   Fri  front reaches Møre og Romsdal
 *   Sat  Sunnmøre and Romsdal loaded, alerts fire in the south
 *   Sun  clearing; deep base, danger easing
 */

import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? new URL('./out', import.meta.url).pathname);
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), 'ttv-demo-'));
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'false';

const { refresh } = await import('../src/refresh.js');
const { evaluateAlerts, buildPush, buildEmail } = await import('../src/alerts.js');
const { loadRegions, loadTours } = await import('../src/config.js');
const { latLonToUTM } = await import('../src/util/utm.js');
const { getRoute } = await import('../src/tracks.js');
const { getTerrain } = await import('../src/terrain.js');
const { shapeFnugg } = await import('../src/sources/fnugg.js');
const { shapeOsmResorts } = await import('../src/sources/osm-resorts.js');
const { fetchForecast } = await import('../src/sources/forecast.js');
const { haversineKm } = await import('../src/util/utm.js');

const regions = await loadRegions();
const tours = await loadTours();
const regionById = Object.fromEntries(regions.map((r) => [r.id, r]));

/* ------------------------------------------------------------------ *
 * weather model
 * ------------------------------------------------------------------ */

const DAY0 = Date.UTC(2027, 1, 8); // Mon 8 Feb 2027
const dayIndex = (iso) => Math.round((Date.parse(iso.slice(0, 10)) - DAY0) / 86400000);

// One storm track, centre latitude and 24 h amplitude (cm) per day.
// Days before the week (negative index) are quiet, to build a settled base.
const TRACK = {
  0: { lat: 68.5, amp: 3, sigma: 4 },
  1: { lat: 70.0, amp: 22, sigma: 1.1 },
  2: { lat: 69.3, amp: 30, sigma: 1.2 },
  3: { lat: 66.8, amp: 16, sigma: 1.4 },
  4: { lat: 62.6, amp: 24, sigma: 1.0 },
  5: { lat: 62.0, amp: 22, sigma: 1.1 },
  6: { lat: 64.0, amp: 1, sigma: 4 },
};

// Westerly flow: the coast takes the brunt, inland Norway less, Sweden sits
// in the rain shadow.
const EXPOSURE = {
  lyngen: 1.1, tromso: 1.05, 'nord-troms': 1, 'sor-troms': 1, lofoten: 1, ofoten: 0.9,
  'vest-finnmark': 0.95, finnmarkskysten: 0.9, salten: 0.9, svartisen: 1, helgeland: 1,
  sunnmore: 1.15, romsdal: 1.05, 'indre-fjordane': 1, trollheimen: 0.85, voss: 0.8,
  hardanger: 0.75, 'indre-sogn': 0.8, jotunheimen: 0.65, hallingdal: 0.5,
  'vest-telemark': 0.5, heiane: 0.6, 'indre-troms': 0.75,
  abisko: 0.6, kebnekaise: 0.5, vindelfjallen: 0.45, 's-lappland': 0.4,
  's-jamtland': 0.45, 'v-harjedalen': 0.4,
};

/** Deterministic noise in [-1, 1] so the demo renders identically every run. */
function noise(...keys) {
  let h = 2166136261;
  for (const ch of keys.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 5000 - 1;
}

function snowfall(lat, lon, region, d, key) {
  const s = TRACK[d];
  if (!s) return Math.max(0, 1.5 + 1.5 * noise(key, d, 'q')); // quiet pre-week days
  const core = s.amp * Math.exp(-((lat - s.lat) ** 2) / (2 * s.sigma ** 2));
  const exp = EXPOSURE[region] ?? 0.7;
  return Math.max(0, core * exp * (1 + 0.18 * noise(key, d)) + 1.2 * (1 + noise(key, d, 'b')));
}

/** Base depth before the week: deeper north and on the coast, shallower east. */
function baseDepth(lat, region, key) {
  const exp = EXPOSURE[region] ?? 0.7;
  return Math.round((70 + (lat - 59) * 9) * (0.7 + 0.35 * exp) * (1 + 0.12 * noise(key, 'base')));
}

// Every point the pipeline will sample: 48 tours plus fallback region points.
const points = new Map();
for (const t of tours) {
  const { x, y } = latLonToUTM(t.lat, t.lon);
  points.set(`${x},${y}`, { key: t.name, lat: t.lat, lon: t.lon, region: t.region });
}
for (const r of regions.filter((r) => !r.offMap && !tours.some((t) => t.region === r.id))) {
  const { x, y } = latLonToUTM(r.lat, r.lon);
  points.set(`${x},${y}`, { key: `region:${r.id}`, lat: r.lat, lon: r.lon, region: r.id });
}

// Daily depth series for each point, days -10 … 6. New snow settles: a day's
// fall compacts ~20% overnight and the whole pack loses a little, so the
// pipeline's "rise in depth" under-reads the true fall, as it does for real.
const FIRST = -10, LAST = 6;
const depthSeries = new Map();
const fallSeries = new Map();
for (const [xy, p] of points) {
  let depth = baseDepth(p.lat, p.region, p.key);
  const depths = {}, falls = {};
  for (let d = FIRST; d <= LAST; d++) {
    const fall = snowfall(p.lat, p.lon, p.region, d, p.key);
    depth = depth + fall * 0.8 - 0.6 - depth * 0.003;
    depths[d] = Math.round(depth * 10) / 10;
    falls[d] = fall;
  }
  depthSeries.set(xy, depths);
  fallSeries.set(xy, falls);
}

/* ------------------------------------------------------------------ *
 * avalanche danger model
 * ------------------------------------------------------------------ */

// Loading per region = the heaviest 48 h fall among its sample points.
function regionLoad48(regionId, d) {
  let max = 0;
  for (const [xy, p] of points) {
    if (p.region !== regionId) continue;
    const f = fallSeries.get(xy);
    max = Math.max(max, (f[d] ?? 0) + (f[d - 1] ?? 0));
  }
  return max;
}

const dangerMemo = new Map();
function danger(regionId, d) {
  const k = `${regionId}:${d}`;
  if (dangerMemo.has(k)) return dangerMemo.get(k);
  const load = regionLoad48(regionId, d);
  const stormy = (TRACK[d]?.amp ?? 0) > 10;
  let raw = load < 10 ? 2 : load < 30 ? 3 : load < 45 ? (stormy ? 4 : 3) : 4;
  if (d > -3) raw = Math.max(raw, danger(regionId, d - 1) - 1); // slabs heal slowly
  raw = Math.max(1, Math.min(4, raw));
  dangerMemo.set(k, raw);
  return raw;
}

function bulletin(regionId, d) {
  const lvl = danger(regionId, d);
  const load = Math.round(regionLoad48(regionId, d));
  const prev = danger(regionId, d - 1);
  const falling = lvl < prev;
  const fresh = load >= 10;

  const main = {
    4: 'Heavy snowfall and strong westerly wind have built large, reactive slabs in lee terrain. Natural avalanches are likely. Stay out of avalanche terrain.',
    3: fresh
      ? 'Fresh snow and wind have formed slabs in lee terrain above the tree line. A single skier can trigger them on steep slopes.'
      : 'Storm slabs are stabilising slowly but can still be triggered on steep lee slopes. Choose conservative terrain.',
    2: falling
      ? 'Conditions are improving. Isolated slabs remain on steep, wind-loaded slopes near ridges.'
      : 'Mostly stable conditions. Watch for small wind slabs in steep terrain near ridges.',
    1: 'Generally stable snowpack. Avalanches are unlikely outside extreme terrain.',
  }[lvl];

  const problems = fresh
    ? [
        { AvalancheExtName: 'Dry slab avalanche', AvalProbabilityName: lvl >= 4 ? 'Very likely' : 'Likely', DestructiveSizeExtName: lvl >= 4 ? '3 - Large' : '2 - Medium' },
        { AvalancheExtName: 'Wind slab', AvalProbabilityName: 'Likely', DestructiveSizeExtName: '2 - Medium' },
      ]
    : lvl >= 3
      ? [{ AvalancheExtName: 'Dry slab avalanche', AvalProbabilityName: 'Possible', DestructiveSizeExtName: '2 - Medium' }]
      : [{ AvalancheExtName: 'Wind slab', AvalProbabilityName: 'Possible', DestructiveSizeExtName: '1 - Small' }];

  return {
    DangerLevel: String(lvl),
    DangerLevelName: `${lvl} ${['', 'Low', 'Moderate', 'Considerable', 'High', 'Very high'][lvl]}`,
    MainText: main,
    EmergencyWarning: 'Not given',
    PublishTime: new Date(DAY0 + (d - 1) * 86400000 + 15 * 3600000).toISOString().slice(0, 19),
    SnowSurface: fresh
      ? `${Math.max(5, load - 10)}–${load} cm of new, wind-affected snow over an older, hard surface.`
      : 'Wind-packed and partly crusted snow; soft snow remains in sheltered terrain.',
    CurrentWeaklayers: fresh
      ? 'The interface between new snow and the old hard surface is the main weakness.'
      : 'No significant persistent weak layers observed.',
    LatestAvalancheActivity:
      lvl >= 4
        ? 'Several natural slab avalanches up to size 3 in lee aspects during the storm.'
        : lvl === 3 && !fresh
          ? 'Skier-triggered size 2 slab reported yesterday on a steep north-east slope.'
          : fresh
            ? 'Shooting cracks and small natural releases reported in lee terrain.'
            : 'No recent avalanches reported.',
    LatestObservations: fresh
      ? `Observers report ${Math.max(5, load - 12)}–${load} cm of new snow in 48 h, easily triggered on test slopes.`
      : 'Observers report generally good skiing; wind effect above the tree line.',
    AvalancheProblems: problems,
    MountainWeather: {
      CloudCoverName: (TRACK[d]?.amp ?? 0) > 10 ? 'Snow showers' : 'Clear to partly cloudy',
      Comment: (TRACK[d]?.amp ?? 0) > 10 ? 'Strong breeze to near gale from the west' : 'Light breeze',
      MeasurementTypes: [],
    },
    AvalancheAdvices: [],
  };
}

/* ------------------------------------------------------------------ *
 * fake upstream: answers exactly the URLs the service requests
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * featured tours: simulated paths, terrain and summit weather
 *
 * For the tour-detail part of the demo, OpenStreetMap and Open-Meteo are
 * simulated too. Each featured tour gets a synthetic path network (road,
 * car park, a switchbacking path) and a synthetic terrain surface, and the
 * real route finder and profile code run over them. Hamperokken's path is
 * deliberately left 1 km short of the summit, so the demo can show what the
 * tool does when no mapped path reaches the top: it draws nothing.
 * ------------------------------------------------------------------ */

const FEATURED = {
  'Rørnestinden': { bearing: 265, reach: true },
  'Skårasalen': { bearing: 95, reach: true },
  'Storsnasen (Snasahögarna)': { bearing: 160, reach: true },
  'Hamperokken': { bearing: 300, reach: false },
};
const featured = tours
  .filter((t) => FEATURED[t.name])
  .map((t) => {
    const f = FEATURED[t.name];
    const L = Math.max(1800, t.vertical_m / 0.27); // metres from start to summit
    const b = (f.bearing * Math.PI) / 180;
    const kmLat = 111.2, kmLon = 111.2 * Math.cos((t.lat * Math.PI) / 180);
    const start = { lat: t.lat + (Math.cos(b) * L) / 1000 / kmLat, lon: t.lon + (Math.sin(b) * L) / 1000 / kmLon };
    return { tour: t, ...f, L, start, kmLat, kmLon, startEle: Math.max(5, t.summit_m - t.vertical_m) };
  });

const nearestFeatured = (lat, lon, maxKm = 9) =>
  featured
    .map((f) => ({ f, d: haversineKm(lat, lon, f.tour.lat, f.tour.lon) }))
    .filter((x) => x.d <= maxKm)
    .sort((a, b) => a.d - b.d)[0]?.f;

/** Terrain: steeper near the top, a little texture, never below the start. */
function terrainAt(lat, lon) {
  const f = nearestFeatured(lat, lon);
  if (!f) return 300;
  const d = haversineKm(lat, lon, f.tour.lat, f.tour.lon) * 1000;
  const V = f.tour.summit_m - f.startEle;
  const ele = f.tour.summit_m - V * Math.pow(Math.min(1.3, d / f.L), 0.78) + 14 * Math.sin(d / 180);
  return Math.round(Math.max(f.startEle * 0.6, ele));
}

function syntheticPath(f) {
  const pts = [];
  const endT = f.reach ? 0.985 : 0.62; // Hamperokken's path stops well short
  const perp = { lat: -(f.start.lon - f.tour.lon) * (f.kmLon / f.kmLat), lon: (f.start.lat - f.tour.lat) * (f.kmLat / f.kmLon) };
  const plen = Math.hypot(perp.lat * f.kmLat, perp.lon * f.kmLon) || 1;
  for (let i = 0; i <= 70; i++) {
    const t = (i / 70) * endT;
    // a gentle valley curve, then switchbacks on the steep upper third
    const lateralM = 260 * Math.sin(Math.PI * t) + 110 * Math.sin(t * Math.PI * 9) * Math.max(0, (t - 0.5) / 0.5);
    const k = lateralM / 1000 / plen;
    pts.push({
      lat: f.start.lat + (f.tour.lat - f.start.lat) * t + perp.lat * k,
      lon: f.start.lon + (f.tour.lon - f.start.lon) * t + perp.lon * k,
    });
  }
  return pts;
}

function overpassFor(lat, lon) {
  const f = nearestFeatured(lat, lon, 3);
  if (!f) return { elements: [] };
  const path = syntheticPath(f);
  const s = f.start;
  return {
    elements: [
      { type: 'way', id: 1, tags: { highway: 'tertiary' }, geometry: [{ lat: s.lat - 0.004, lon: s.lon - 0.006 }, s, { lat: s.lat + 0.005, lon: s.lon + 0.004 }] },
      { type: 'way', id: 2, tags: { highway: 'path' }, geometry: path },
      { type: 'node', id: 3, lat: s.lat + 0.0002, lon: s.lon + 0.0003, tags: { amenity: 'parking' } },
      { type: 'node', id: 4, lat: f.tour.lat, lon: f.tour.lon, tags: { natural: 'peak', name: f.tour.name.replace(/ \(.*\)$/, ''), ele: String(f.tour.summit_m) } },
    ],
  };
}

/** Summit weather for the 5 days from `currentDay`, consistent with the storm track. */
function forecastFor(lat, lon, elevation) {
  const f = nearestFeatured(lat, lon, 3);
  const region = f?.tour.region ?? 'lyngen';
  const key = f?.tour.name ?? 'x';
  const days = [], wx = { weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], snowfall_sum: [],
    wind_speed_10m_max: [], wind_gusts_10m_max: [], wind_direction_10m_dominant: [] };
  const hourly = { time: [], freezing_level_height: [] };
  for (let k = 0; k < 5; k++) {
    const dd = currentDay + k;
    const date = new Date(DAY0 + dd * 86400000).toISOString().slice(0, 10);
    const fall = dd > LAST ? Math.max(0, 0.6 * noise(key, dd, 'late')) : snowfall(lat, lon, region, dd, key);
    const stormy = fall > 6;
    const tMax = Math.round((-2 - (lat - 60) * 0.3 - (elevation / 1000) * 4 + (stormy ? 2 : -1) + 1.5 * noise(key, dd, 't')) * 10) / 10;
    days.push(date);
    wx.weather_code.push(fall > 15 ? 75 : fall > 6 ? 73 : fall > 1.5 ? 85 : fall > 0.5 ? 3 : noise(key, dd, 'c') > 0 ? 0 : 2);
    wx.temperature_2m_max.push(tMax);
    wx.temperature_2m_min.push(Math.round((tMax - (stormy ? 3 : 5.5)) * 10) / 10);
    wx.snowfall_sum.push(Math.round(fall * 10) / 10);
    wx.precipitation_sum.push(Math.round((fall / 0.7) * 10) / 10);
    const wind = stormy ? 13 + 5 * Math.min(1, fall / 25) : 4 + 2 * (1 + noise(key, dd, 'w'));
    wx.wind_speed_10m_max.push(Math.round(wind));
    wx.wind_gusts_10m_max.push(Math.round(wind * (stormy ? 1.75 : 1.5)));
    wx.wind_direction_10m_dominant.push(stormy ? 262 : 40 + 40 * noise(key, dd, 'dir'));
    hourly.time.push(`${date}T12:00`);
    hourly.freezing_level_height.push(stormy ? 600 : 150);
  }
  return { elevation, daily: { time: days, ...wx }, hourly };
}

const byVarsomId = Object.fromEntries(regions.filter((r) => r.varsomId).map((r) => [r.varsomId, r]));
const bySlug = Object.fromEntries(regions.filter((r) => r.slug).map((r) => [r.slug, r]));
const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const SE_WORD = { 1: 'Liten', 2: 'Måttlig', 3: 'Betydande', 4: 'Stor', 5: 'Mycket stor' };

let currentDay = 0;

globalThis.fetch = async (url, opts) => {
  const u = String(url);

  let m = u.match(/AvalancheWarningByRegion\/Detail\/(\d+)\/\d+\/([\d-]+)\/([\d-]+)/);
  if (m) {
    const region = byVarsomId[Number(m[1])];
    const d0 = dayIndex(m[2]);
    return J([0, 1, 2].map((k) => ({
      RegionId: region.varsomId,
      RegionName: region.name,
      ValidFrom: new Date(DAY0 + (d0 + k) * 86400000).toISOString().slice(0, 19),
      ...bulletin(region.id, Math.min(d0 + k, LAST)),
    })));
  }

  m = u.match(/GridTimeSeries\/(\d+)\/(\d+)\/([\d-]+)\/([\d-]+)\/sd\.json/);
  if (m) {
    const xy = `${m[1]},${m[2]}`;
    const series = depthSeries.get(xy);
    if (!series) return J({ NoDataValue: 65535, Unit: 'cm', Data: [65535] });
    const from = dayIndex(m[3]), to = dayIndex(m[4]);
    const data = [];
    for (let d = from; d <= to; d++) data.push(series[d] ?? 65535);
    return J({
      Theme: 'sd', NoDataValue: 65535, Unit: 'cm', X: +m[1], Y: +m[2],
      Altitude: 900 + Math.round(350 * (1 + noise(xy, 'alt'))),
      EndDate: `${m[4].split('-').reverse().join('.')} 06:00:00`,
      Data: data,
    });
  }

  m = u.match(/oversikt-alla-omraden\/([a-z_]+)\//);
  if (m) {
    const region = bySlug[m[1]];
    const lvl = danger(region.id, currentDay);
    return new Response(
      `<html><body><img alt="Risk ${lvl}"><p>${SE_WORD[lvl]} lavinfara</p></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  }

  if (u.includes('overpass')) {
    const q = decodeURIComponent(String(opts?.body ?? '').replace(/^data=/, ''));
    const a = q.match(/around:\d+,([\d.]+),([\d.]+)/);
    return J(a ? overpassFor(+a[1], +a[2]) : { elements: [] });
  }
  if (u.includes('/v1/elevation')) {
    const q = new URL(u).searchParams;
    const la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
    return J({ elevation: la.map((l, i) => terrainAt(l, lo[i])) });
  }
  if (u.includes('hoydedata')) {
    // Kartverket's point service, same synthetic terrain, documented shape.
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    return J({ koordsys: 4258, punkter: pts.map(([x, y]) => ({ datakilde: 'dtm1', x, y, z: terrainAt(y, x) })) });
  }
  if (u.includes('/v1/forecast')) {
    const q = new URL(u).searchParams;
    return J(forecastFor(+q.get('latitude'), +q.get('longitude'), +(q.get('elevation') ?? 1000)));
  }
  throw new Error(`demo upstream: unexpected request ${u}`);
};

/* ------------------------------------------------------------------ *
 * run the real pipeline once per day
 * ------------------------------------------------------------------ */

await mkdir(outDir, { recursive: true });
const summary = [];

// Routes are static: derive them once through the real route finder.
const routes = {};
for (const f of featured) routes[f.tour.name] = await getRoute(f.tour);
await writeFile(path.join(outDir, 'routes.json'), JSON.stringify(routes));

// Contour grids over the same synthetic terrain, through the real terrain code.
const terrains = {};
for (const f of featured) terrains[f.tour.name] = await getTerrain(f.tour);
await writeFile(path.join(outDir, 'terrain.json'), JSON.stringify(terrains));
for (const [name, r] of Object.entries(routes)) {
  summary.push(
    `route ${name}: ${r.found ? `${r.kind}, ${(r.lengthM / 1000).toFixed(1)} km, ascent ${r.profile?.stats?.ascentM} m, gap ${r.endGapM} m` : r.reason}`
  );
}

/* ------------------------------------------------------------------ *
 * ski resorts: real Fnugg list (fixture), simulated open counts
 *
 * Wind, not snow, shuts lifts: on a stormy day (lots of new snow in 24 h in
 * the nearest forecast region) exposed lifts go on wind hold, and a few
 * small hills stay shut. Calm areas run everything.
 * ------------------------------------------------------------------ */

const { readFile: readFixture } = await import('node:fs/promises');
const fnuggList = (await readFixture(new URL('./fixtures/fnugg-resorts.txt', import.meta.url), 'utf8'))
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));

// Swedish resorts at APPROXIMATE positions, written for the demo: the live
// service reads them from OpenStreetMap, which the build environment could
// not reach. Links only where the address was confirmed.
const SE_RESORTS = [
  ['Åre', 63.399, 13.08, 'https://www.skistar.com/sv/vara-skidorter/are/', 40], ['Duved', 63.392, 12.93, null, 8],
  ['Edsåsdalen', 63.47, 13.17, 'https://edsasdalen.se/', 6], ['Storlien', 63.31, 12.1, null, 7],
  ['Vemdalsskalet', 62.47, 13.97, 'https://www.skistar.com/sv/vara-skidorter/vemdalen/', 16], ['Björnrike', 62.4, 13.95, null, 9],
  ['Klövsjö', 62.53, 14.17, null, 12], ['Funäsdalsberget', 62.54, 12.55, null, 8], ['Ramundberget', 62.7, 12.39, null, 9],
  ['Idre Fjäll', 61.89, 12.72, 'https://www.idrefjall.se/', 30], ['Lindvallen', 61.155, 13.2, 'https://www.skistar.com/sv/vara-skidorter/salen/', 22],
  ['Högfjället', 61.18, 13.13, null, 12], ['Tandådalen', 61.17, 12.98, null, 20], ['Hundfjället', 61.16, 13.03, null, 15],
  ['Kläppen', 61.03, 13.35, null, 12], ['Stöten', 61.27, 12.88, null, 10], ['Branäs', 60.66, 13.03, null, 20],
  ['Romme Alpin', 60.39, 15.39, null, 18], ['Orsa Grönklitt', 61.21, 14.53, null, 8], ['Kungsberget', 60.78, 16.47, null, 12],
  ['Hassela', 62.1, 16.7, null, 8], ['Isaberg', 57.43, 13.62, null, 8], ['Hammarbybacken', 59.3, 18.1, null, 4],
  ['Hemavan', 65.82, 15.1, null, 12], ['Tärnaby', 65.72, 15.28, null, 7], ['Kittelfjäll', 65.25, 15.5, null, 5],
  ['Borgafjäll', 64.83, 15.02, null, 5], ['Dundret', 67.12, 20.6, null, 7], ['Björkliden', 68.41, 18.68, null, 6],
  ['Riksgränsen', 68.43, 18.12, 'https://www.riksgransen.se/', 6],
];
const seElements = [];
let seId = 1;
for (const [name, lat, lon, url, lifts] of SE_RESORTS) {
  const d = 0.012;
  seElements.push({ type: 'way', id: seId++, center: { lat, lon }, bounds: { minlat: lat - d, maxlat: lat + d, minlon: lon - 2 * d, maxlon: lon + 2 * d }, tags: { landuse: 'winter_sports', name, ...(url ? { website: url } : {}) } });
  for (let k = 0; k < lifts; k++) seElements.push({ type: 'way', id: seId++, center: { lat: lat + ((k % 3) - 1) * 0.003, lon: lon + ((k % 5) - 2) * 0.006 }, tags: { aerialway: 'chair_lift' } });
}
const seResorts = shapeOsmResorts({ elements: seElements }, 'SE');

function resortsFor(snap, d, at) {
  const regs = snap.regions.filter((r) => r.country === 'NO' && r.snow);
  const hits = fnuggList.map(([id, name, lat, lon, url, lc, sc]) => {
    const near = regs.reduce((a, r) => (haversineKm(+lat, +lon, r.lat, r.lon) < haversineKm(+lat, +lon, a.lat, a.lon) ? r : a), regs[0]);
    const storm = near?.snow?.new24 ?? 0;
    const u = noise(name, d, 'lift') * 0.5 + 0.5;
    // storm: 12+ cm in 24 h puts upper lifts on wind hold; 25+ shuts small hills
    const frac = storm >= 25 ? (u < 0.35 ? 0 : 0.2 + 0.3 * u) : storm >= 12 ? 0.45 + 0.35 * u : u < 0.06 ? 0.7 : 1;
    const L = +lc, S = +sc;
    const lo = Math.round(L * frac);
    const so = Math.min(S, Math.round(S * Math.min(1, frac + 0.1)));
    return { _id: id, _source: { id: +id, name, location: { lat: +lat, lon: +lon }, urls: { homepage: url || null }, resort_open: lo > 0, lifts: { open: lo, count: L }, slopes: { open: so, count: S } } };
  });
  const no = shapeFnugg({ hits: { hits } });
  return {
    sources: {
      no: { name: 'Fnugg', fetchedAt: at, count: no.length, stale: false },
      se: { name: 'OpenStreetMap', fetchedAt: at, count: seResorts.length, stale: false },
    },
    inSeason: true,
    resorts: [...no, ...seResorts],
  };
}

for (let d = 0; d <= 6; d++) {
  currentDay = d;
  const date = new Date(DAY0 + d * 86400000 + 6 * 3600000); // 06:00, when seNorge updates
  const snap = await refresh({ force: true, date });
  const firing = evaluateAlerts(snap, { threshold: 30, watch: 'all' });
  const push = firing.length ? buildPush(firing) : null;
  const email = firing.length ? buildEmail(firing) : null;

  const forecasts = {};
  for (const f of featured) {
    const r = routes[f.tour.name];
    const s = r?.summit ?? f.tour;
    forecasts[f.tour.name] = { tour: f.tour.name, ...(await fetchForecast({ lat: s.lat, lon: s.lon, elevation: s.ele ?? f.tour.summit_m })) };
  }

  const alerts = {
    threshold: 30,
    watching: 'all',
    quietHours: { from: 22, to: 6 },
    firing,
    pending: [],
    recentlySent: [],
    channels: { email: true, ntfy: true },
  };

  await writeFile(
    path.join(outDir, `day-${d + 1}.json`),
    JSON.stringify({ day: d + 1, date: date.toISOString(), snapshot: snap, alerts, push, email, forecasts, resorts: resortsFor(snap, d, new Date(date.getTime() + 3.25 * 3600e3).toISOString()) }, null, 0)
  );

  const max = [...snap.regions].filter((r) => r.snow?.new48 != null).sort((a, b) => b.snow.new48 - a.snow.new48)[0];
  summary.push(
    `day ${d + 1} ${date.toISOString().slice(0, 10)}  alerts: ${String(firing.length).padStart(2)}  ` +
      `max 48h: ${max?.snow.new48 ?? '-'} cm (${max?.name ?? '-'})  ` +
      `danger 4: ${snap.regions.filter((r) => r.bulletin?.danger === 4).map((r) => r.name).join(', ') || '-'}`
  );
}

console.log(summary.join('\n'));
console.log(`\nwrote 7 days to ${outDir}`);
