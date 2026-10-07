import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Austria and Euregio (v6.2): the EAWS daily files (which day, which states,
 * whose bulletin wins), outlines with retired regions, GeoSphere's snow
 * (new snow derived from the depth), the basemap.at tile address and
 * /api/region for a point in Tyrol. All upstreams are stubbed in the shapes
 * read from the live services on 7 Oct 2026.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-euregio-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const { alpineStubs } = await import('./helpers/alps.js');
const { fetchEawsFeed, candidateDays, mergeStates, stateUrl } = await import('../src/sources/eawsfeed.js');
const { parseRegions, regionIn, _resetEaws } = await import('../src/sources/eawsregions.js');
const { shapeAlpineSnow, fetchAlpineSnow, _resetGeosphere } = await import('../src/sources/geosphere.js');

const realFetch = globalThis.fetch;
const alpineRegions = regions.filter((r) => r.country === 'AT' || r.country === 'IT');
let stub = alpineStubs({ regions, tours });
let log = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (/^https?:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, opts);
  log.push(u);
  return stub(u) ?? new Response('offline', { status: 503 });
};
test.after(() => (globalThis.fetch = realFetch));

test('which day: tomorrow first once the evening bulletin is out (17:00 Vienna), else today', () => {
  assert.deepEqual(candidateDays(new Date('2026-12-01T10:00:00Z')), ['2026-12-01']);
  assert.deepEqual(candidateDays(new Date('2026-12-01T17:30:00Z')), ['2026-12-02', '2026-12-01']);
  assert.deepEqual(candidateDays(new Date('2026-12-31T20:00:00Z')), ['2027-01-01', '2026-12-31']);
  assert.equal(stateUrl('2026-03-01', 'IT-32-BZ'), 'https://static.avalanche.report/eaws_bulletins/2026-03-01/2026-03-01-IT-32-BZ.json');
});

test('outlines: a retired micro-region (end date in the past) is left out', () => {
  const f = (id, end) => ({ type: 'Feature', properties: { id, start_date: '2022-10-01', end_date: end }, geometry: { type: 'MultiPolygon', coordinates: [[[[10, 46], [11, 46], [11, 47], [10, 47], [10, 46]]]] } });
  const list = parseRegions({ type: 'FeatureCollection', features: [f('AT-07-01', '2022-09-30'), f('AT-07-02', null), f('AT-07-03', '2099-01-01')] });
  assert.deepEqual(list.map((r) => r.id), ['AT-07-02', 'AT-07-03']);
  assert.equal(regionIn(list, 46.5, 10.5), 'AT-07-02');
});

test('a feed: every region finds the bulletin of its micro-region; the three Euregio files are always read', async () => {
  _resetEaws();
  log = [];
  const feed = await fetchEawsFeed(alpineRegions, { now: new Date('2027-01-20T09:00:00Z') });
  const states = Object.keys(feed.states);
  for (const s of ['AT-07', 'AT-05', 'AT-06', 'IT-32-BZ', 'IT-32-TN']) assert.ok(states.includes(s), `${s} read`);
  const wild = feed.byRegion['at-oetztal'];
  assert.equal(wild.source, 'eaws');
  assert.equal(wild.danger, 3);
  assert.equal(wild.provider, 'LWD Tirol');
  assert.equal(wild.microName, 'Ötztal Alps (micro)');
  assert.equal(feed.byRegion['it-puez'].provider, 'Provincia autonoma di Bolzano');
  // the highest level of the day, with the heights it applies to
  assert.equal(wild.dangerRatings.length, 2);
  assert.deepEqual(wild.problems[0].heights, { fill: 1, h1: 2000, h2: 2000 });
  assert.equal(wild.problems[0].aspects, '11100011', 'W, NW, N, NE, E');
  assert.ok(feed.all.bulletins.length >= alpineRegions.length);
  // today's folder only before 17:00
  assert.ok(log.filter((u) => u.includes('static.avalanche.report')).every((u) => u.includes('/2027-01-20/')));
});

test('no folder yet is "no bulletin" (outside the season); an error is an error', async () => {
  _resetEaws();
  stub = alpineStubs({ regions, tours, day: '2020-01-01' }); // nothing published for the days asked
  let feed = await fetchEawsFeed(alpineRegions, { now: new Date('2026-10-07T09:00:00Z') });
  assert.equal(feed.all, null);
  const b = feed.byRegion['at-oetztal'];
  assert.equal(b.danger, null);
  assert.equal(b.outOfSeason, true);
  assert.match(b.headline, /outside the winter season/);
  assert.equal(feed.states['AT-07'].day, null);

  // A server error is shown as one, state by state.
  stub = (u) => (u.includes('-AT-05.json') ? new Response('boom', { status: 500 }) : alpineStubs({ regions, tours })(u));
  _resetEaws();
  feed = await fetchEawsFeed(alpineRegions, { now: new Date('2027-01-20T09:00:00Z') });
  assert.equal(feed.states['AT-05'].ok, false);
  assert.match(feed.byRegion['at-sonnblick'].error, /getJSON failed/);
  assert.equal(feed.byRegion['at-oetztal'].danger, 3, 'the other states are unaffected');
  stub = alpineStubs({ regions, tours });
});

test('without the outlines the region at a point is not known, and the page says so', async () => {
  _resetEaws();
  await import('node:fs/promises').then((f) => f.rm(path.join(tmp, 'cache', 'eaws'), { recursive: true, force: true }));
  stub = (u) => (u.includes('regions.avalanches.org') ? new Response('down', { status: 503 }) : alpineStubs({ regions, tours })(u));
  const feed = await fetchEawsFeed(alpineRegions, { now: new Date('2027-01-20T09:00:00Z') });
  assert.match(feed.byRegion['at-oetztal'].error, /outlines are not available/);
  stub = alpineStubs({ regions, tours });
  _resetEaws();
});

test('a micro-region listed in two files belongs to the file of its own state', () => {
  const b = (id, regionID, mainValue) => ({ bulletinID: id, regions: [{ regionID, name: regionID }], dangerRatings: [{ mainValue }], avalancheProblems: [] });
  const m = mergeStates([
    { state: 'AT-02', bulletins: [b('carinthia', 'AT-07-24', 'low')] }, // Carinthia lists a Tyrolean border region
    { state: 'AT-07', bulletins: [b('tyrol', 'AT-07-24', 'considerable')] },
  ]);
  assert.equal(m.bulletins[m.byMicro['AT-07-24']].danger, 3);
  const m2 = mergeStates([{ state: 'AT-07', bulletins: [b('tyrol', 'AT-07-24', 'considerable')] }, { state: 'AT-02', bulletins: [b('carinthia', 'AT-07-24', 'low')] }]);
  assert.equal(m2.bulletins[m2.byMicro['AT-07-24']].danger, 3, 'whichever file comes first');
});

test('GeoSphere: depth now, and new snow as the rises in depth (falls and noise ignored)', () => {
  const now = new Date('2026-12-10T12:00:00Z'), T = now.getTime();
  const t = Array.from({ length: 451 }, (_, i) => T - 75 * 3600e3 + i * 600e3);
  // 20 cm, +1 cm/h for 24 h, a slow fall, flat, then +1.5 cm/h for the last 24 h
  const v = t.map((x) => { const h = (x - (T - 72 * 3600e3)) / 3600e3; return h < 0 ? 20 : h < 24 ? 20 + h : h < 36 ? 44 - (h - 24) * 0.2 : h < 48 ? 41.6 : 41.6 + (h - 48) * 1.5; });
  const list = [{ code: '1', label: 'Hoch', lat: 47.01, lon: 11.0, elevation: 2300 }, { code: '2', label: 'Tal', lat: 47.0, lon: 11.01, elevation: 600 }];
  const series = new Map([['1', { t, v }], ['2', { t, v: t.map(() => null) }]]);
  const s = shapeAlpineSnow([{ key: 'a', lat: 47.0, lon: 11.0, ele: 2500 }, { key: 'far', lat: 47.0, lon: 12.5, ele: 2500 }], list, series, now).a;
  assert.equal(s.source, 'geosphere');
  assert.equal(s.derived, true);
  assert.equal(s.station.label, 'Hoch', 'the station with data, not the nearer one without');
  assert.equal(s.depthCm, 78);
  assert.equal(s.new24, 36);
  assert.equal(s.new48, 36);
  assert.equal(s.new72, 60);
  assert.equal(s.stale, false);
  const far = shapeAlpineSnow([{ key: 'far', lat: 47.0, lon: 12.5 }], list, series, now).far;
  assert.match(far.error, /no GeoSphere station with snow data within 25 km/);
});

test('GeoSphere: stations and one series request, through the stubbed API; an error is kept per point', async () => {
  _resetGeosphere();
  log = [];
  const pts = tours.filter((t) => t.region === 'at-oetztal').map((t) => ({ key: t.name, lat: t.lat, lon: t.lon, ele: t.summit_m }));
  const got = await fetchAlpineSnow(pts, { now: new Date('2027-01-20T09:00:00Z') });
  assert.ok(got.Wildspitze.depthCm > 0);
  assert.ok(got.Wildspitze.new24 > 0);
  assert.equal(log.filter((u) => u.includes('/historical/tawes')).length, 1, 'one request for all the stations');
  assert.match(log.find((u) => u.includes('/historical/tawes')), /parameters=SCHNEE&station_ids=\d+/);
  _resetGeosphere();
  stub = () => new Response('down', { status: 503 });
  const bad = await fetchAlpineSnow(pts, { now: new Date('2027-01-20T09:00:00Z') });
  assert.match(bad.Wildspitze.error, /getJSON failed/);
  stub = alpineStubs({ regions, tours });
});

test('basemap.at: row before column, grey style; South Tyrol keeps OpenTopoMap', async () => {
  const { getTile } = await import('../src/tiles.js');
  log = [];
  stub = () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
  const r = await getTile('at', 13, 4300, 2850, { skipZoneCheck: true });
  assert.equal(r.status, 200);
  assert.ok(log.some((u) => u === 'https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/13/2850/4300.png'), log.join('\n'));
  stub = alpineStubs({ regions, tours });
});

test('/api/region in Tyrol: the micro-region at the point and its bulletin; Switzerland is tried first', async () => {
  _resetEaws();
  const { alpineStubs: mk } = await import('./helpers/alps.js');
  stub = mk({ regions, tours });
  const feed = await fetchEawsFeed(alpineRegions, { now: new Date('2027-01-20T09:00:00Z') });
  await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), status: 'ok', regions: [], tours: [], eaws: feed.all }));
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const w = tours.find((t) => t.name === 'Wildspitze');
    const r = await (await realFetch(`${base}/api/region?lat=${w.lat}&lon=${w.lon}`)).json();
    assert.equal(r.country, 'AT');
    assert.match(r.microRegion, /^AT-07-/);
    assert.equal(r.bulletin.danger, 3);
    assert.equal(r.bulletin.source, 'eaws');
    assert.equal(r.bulletinUrl, 'https://avalanche.report/');
    const it = tours.find((t) => t.name === 'Peitlerkofel');
    assert.equal((await (await realFetch(`${base}/api/region?lat=${it.lat}&lon=${it.lon}`)).json()).country, 'IT');
    assert.equal((await realFetch(`${base}/api/region?lat=61&lon=8.5`)).status, 404);
  } finally {
    server.close();
  }
});
