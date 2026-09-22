import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * v5.1: weather on the route (MET Norway, stubbed in its documented GeoJSON
 * shape), and GPX in and out on the terrain page.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-v51-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { createServer } = await import('../src/server.js');
const { parseMetno, metnoUrl } = await import('../src/sources/metno.js');
const { _clearWeatherCache, _expireWeatherCache } = await import('../src/weather.js');

const TOUR = { lat: 69.6533, lon: 20.0252 }; // Rørnestinden, a listed tour

function metBody(lat, altitude) {
  const t0 = Date.parse('2027-02-10T06:00:00Z');
  const timeseries = [];
  for (let i = 0; i < 70; i++) {
    const hourly = i < 60;
    timeseries.push({
      time: new Date(t0 + i * (hourly ? 1 : 6) * 3600e3).toISOString().replace('.000', ''),
      data: {
        instant: { details: { air_temperature: -2 - altitude / 200 + Math.sin(i / 4), wind_speed: 4 + i / 10, wind_speed_of_gust: 8 + i / 5, wind_from_direction: 250, cloud_area_fraction: 80 } },
        ...(hourly ? { next_1_hours: { summary: { symbol_code: i % 3 ? 'lightsnowshowers_day' : 'cloudy' }, details: { precipitation_amount: i % 3 ? 0.4 : 0 } } } : {}),
        next_6_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 1 } },
      },
    });
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [20, lat, altitude] }, properties: { meta: { updated_at: '2027-02-10T05:31:12Z', units: { air_temperature: 'celsius' } }, timeseries } };
}

const calls = [];
let mode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.includes('api.met.no')) {
    calls.push({ url: u, headers: opts.headers });
    if (mode === '304') return new Response(null, { status: 304, headers: { Expires: new Date(Date.now() + 3600e3).toUTCString() } });
    if (mode === 'down') return new Response('x', { status: 500 });
    const q = new URL(u).searchParams;
    return new Response(JSON.stringify(metBody(+q.get('lat'), +q.get('altitude'))), {
      status: 200,
      headers: { 'Content-Type': 'application/json', Expires: new Date(Date.now() - 1000).toUTCString(), 'Last-Modified': 'Wed, 10 Feb 2027 05:31:12 GMT' },
    });
  }
  return new Response('offline in tests', { status: 503 });
};

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (base, body) => fetch(`${base}/api/terrain/weather`, { method: 'POST', body: JSON.stringify(body) });

test('metnoUrl: four decimals, whole-metre altitude', () => {
  const u = new URL(metnoUrl({ lat: 69.653312, lon: 20.025187, altitude: 1034.6 }));
  assert.equal(u.searchParams.get('lat'), '69.6533');
  assert.equal(u.searchParams.get('lon'), '20.0252');
  assert.equal(u.searchParams.get('altitude'), '1035');
  assert.match(u.pathname, /locationforecast\/2\.0\/complete$/);
});

test('parseMetno keeps the hourly part and reads every field as optional', () => {
  const p = parseMetno(metBody(69.65, 1000));
  assert.equal(p.hours.length, 60);
  assert.equal(p.updatedAt, '2027-02-10T05:31:12Z');
  assert.equal(p.hours[1].symbol, 'lightsnowshowers_day');
  assert.equal(p.hours[1].precip, 0.4);
  assert.equal(p.hours[0].dir, 250);
  const bare = parseMetno({ properties: { timeseries: [{ time: 't', data: { instant: { details: {} }, next_1_hours: {} } }] } });
  assert.equal(bare.hours[0].temp, null);
  assert.throws(() => parseMetno({}), /unexpected/);
});

test('POST /api/terrain/weather: start and summit, each at its own height, with a User-Agent', async () => {
  _clearWeatherCache();
  calls.length = 0;
  mode = 'ok';
  await withServer(async (base) => {
    const res = await post(base, { points: [[TOUR.lat - 0.01, TOUR.lon, 20], [TOUR.lat, TOUR.lon, 1035]] });
    assert.equal(res.status, 200);
    const w = await res.json();
    assert.equal(w.points.length, 2);
    assert.equal(w.points[0].altitude, 20);
    assert.equal(w.points[1].altitude, 1035);
    assert.ok(w.points[1].hours[0].temp < w.points[0].hours[0].temp, 'colder at the summit');
    assert.equal(calls.length, 2);
    assert.match(calls[0].headers['User-Agent'], /^Fjallskred\/5 /);
    assert.equal(new URL(calls[1].url).searchParams.get('altitude'), '1035');
    assert.equal(w.credit, 'MET Norway');
  });
});

test('weather: kept until it expires, then re-asked with If-Modified-Since; a 304 keeps it', async () => {
  _clearWeatherCache();
  calls.length = 0;
  mode = 'ok';
  await withServer(async (base) => {
    const p = { points: [[TOUR.lat, TOUR.lon, 1035]] };
    const first = await (await post(base, p)).json();
    await post(base, p);
    assert.equal(calls.length, 1, 'held (at least 10 minutes, even when Expires is sooner)');
    _expireWeatherCache();
    mode = '304';
    const again = await (await post(base, p)).json();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers['If-Modified-Since'], 'Wed, 10 Feb 2027 05:31:12 GMT');
    assert.deepEqual(again.points[0].hours, first.points[0].hours);
  });
  mode = 'ok';
});

test('weather: when MET fails, the last answer is served marked stale; with none, 502', async () => {
  _clearWeatherCache();
  mode = 'ok';
  await withServer(async (base) => {
    const p = { points: [[TOUR.lat, TOUR.lon, 900]] };
    await post(base, p);
    _expireWeatherCache();
    mode = 'down';
    const res = await post(base, p);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).points[0].stale, true);
    assert.equal((await post(base, { points: [[TOUR.lat + 0.02, TOUR.lon, 900]] })).status, 502);
  });
  mode = 'ok';
});

test('weather: refuses bad input, other methods and points outside the area', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/terrain/weather`)).status, 405);
    assert.equal((await post(base, { points: [] })).status, 400);
    assert.equal((await post(base, { points: [[1, 2], [3, 4], [5, 6]] })).status, 400);
    assert.equal((await post(base, { points: [[TOUR.lat, TOUR.lon, 99999]] })).status, 400);
    assert.equal((await post(base, { points: [[48.85, 2.35, 50]] })).status, 403);
  });
});

/* ------------------------- page modules ------------------------- */

const G = await import('../public/terrain/gpx.js');
const W = await import('../public/terrain/weather.js');

const garmin = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin Connect" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Metadata name</name><time>2027-02-13T08:40:00Z</time></metadata>
  <trk>
    <name>Høgeloft &amp; back</name>
    <type>backcountry_skiing</type>
    <trkseg>
      <trkpt lat="61.0200" lon="8.2400"><ele>1010.4</ele><time>2027-02-13T08:40:00Z</time></trkpt>
      <trkpt lat="61.0300" lon="8.2300"><ele>1400</ele></trkpt>
      <trkpt lat='61.0539' lon='8.2143'/>
    </trkseg>
  </trk>
</gpx>`;

test('GPX import: Garmin track with name, heights and mixed quoting', () => {
  const g = G.parseGpx(garmin);
  assert.equal(g.kind, 'track');
  assert.equal(g.name, 'Høgeloft & back');
  assert.equal(g.points.length, 3);
  assert.equal(g.points[0].ele, 1010.4);
  assert.equal(g.points[2].ele, null);
});

test('GPX import: routes, then waypoints, and clear errors', () => {
  const rte = `<gpx><rte><name>R</name><rtept lat="60" lon="8"/><rtept lat="60.1" lon="8.1"/></rte></gpx>`;
  assert.deepEqual([G.parseGpx(rte).kind, G.parseGpx(rte).name], ['route', 'R']);
  const wpt = `<gpx><wpt lat="60" lon="8"/><wpt lat="60.1" lon="8.1"/></gpx>`;
  assert.equal(G.parseGpx(wpt).kind, 'waypoints');
  assert.throws(() => G.parseGpx('<kml/>'), /not a GPX/);
  assert.throws(() => G.parseGpx('<gpx><trk><trkseg><trkpt lat="60" lon="8"/></trkseg></trk></gpx>'), /two or more/);
});

test('thinTrack keeps the shape in at most 150 points, ends included', () => {
  const pts = [];
  for (let i = 0; i <= 2000; i++) pts.push({ lat: 61 + i * 2e-5, lon: 8.2 + 0.003 * Math.sin(i / 60) });
  const t = G.thinTrack(pts, 150);
  assert.ok(t.length <= 150 && t.length > 10, `${t.length}`);
  assert.deepEqual(t[0], [pts[0].lat, pts[0].lon]);
  assert.deepEqual(t.at(-1), [pts.at(-1).lat, pts.at(-1).lon]);
  assert.equal(G.thinTrack([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]).length, 2);
});

test('GPX export: track and route, heights where known, and it reads back', () => {
  const xml = G.toGpx({ name: 'Høgeloft <NE>', points: [[61.02, 8.24], [61.0539, 8.2143]], eles: [1010.4, null] });
  assert.match(xml, /<name>Høgeloft &lt;NE&gt;<\/name>/);
  assert.match(xml, /<trkpt lat="61.020000" lon="8.240000"><ele>1010<\/ele><\/trkpt>/);
  assert.match(xml, /<rtept lat="61.053900" lon="8.214300"><\/rtept>/);
  assert.doesNotMatch(xml, /<time>/);
  const back = G.parseGpx(xml);
  assert.equal(back.kind, 'track');
  assert.equal(back.name, 'Høgeloft <NE>');
  assert.equal(back.points.length, 2);
  assert.equal(G.gpxFileName('Høgeloft NE, via Ål'), 'hogeloft-ne-via-al.gpx');
  assert.equal(G.gpxFileName(''), 'route.gpx');
});

test('weather words and totals', () => {
  assert.equal(W.symbolText('lightsnowshowers_day'), 'light snow showers');
  assert.equal(W.symbolText('heavyrainandthunder'), 'heavy rain and thunder');
  assert.equal(W.symbolText('clearsky_night'), 'clear');
  assert.equal(W.symbolText('partlycloudy_polartwilight'), 'partly cloudy');
  const s = W.summarise([
    { temp: -5, wind: 6, gust: 11, precip: 1.2, symbol: 'snow' },
    { temp: 2, wind: 9, gust: 17, precip: 0.5, symbol: 'rain' },
    { temp: -1, wind: 3, gust: null, precip: 0, symbol: 'cloudy' },
  ]);
  assert.deepEqual(s, { tMin: -5, tMax: 2, windMax: 9, gustMax: 17, snowMm: 1.2, rainMm: 0.5 });
});
