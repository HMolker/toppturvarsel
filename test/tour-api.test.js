import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The route/forecast/tile endpoints end to end through the real server,
 * with Overpass, Open-Meteo and the tile servers stubbed in their documented
 * response shapes.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-tour-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { createServer } = await import('../src/server.js');

const calls = { overpass: 0, elevation: 0, kartverket: 0, forecast: 0, tiles: 0 };
const realFetch = globalThis.fetch;

// A winding path from a road at sea level up to Rørnestinden (69.6533, 20.0252).
function syntheticOsm() {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push({ lat: 69.6400 + 0.0133 * t, lon: 20.0000 + 0.0252 * t + 0.002 * Math.sin(t * 12) });
  }
  return {
    elements: [
      { type: 'way', id: 1, tags: { highway: 'unclassified' }, geometry: [{ lat: 69.6400, lon: 19.99 }, pts[0]] },
      { type: 'way', id: 2, tags: { highway: 'path' }, nodes: [], geometry: pts },
      { type: 'node', id: 3, lat: 69.6534, lon: 20.0253, tags: { natural: 'peak', name: 'Rørnestinden', ele: '1035' } },
    ],
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('overpass')) {
    calls.overpass++;
    assert.equal(opts.method, 'POST', 'Overpass is queried with POST');
    return J(syntheticOsm());
  }
  if (u.includes('/v1/elevation')) {
    calls.elevation++;
    const lats = new URL(u).searchParams.get('latitude').split(',').map(Number);
    return J({ elevation: lats.map((la) => Math.round(((la - 69.64) / 0.0134) * 1000)) });
  }
  if (u.includes('/v1/forecast')) {
    calls.forecast++;
    const days = ['2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'];
    return J({
      elevation: 1035,
      daily: {
        time: days, weather_code: [73, 3, 0, 85, 1],
        temperature_2m_max: [-4, -6, -9, -3, -5], temperature_2m_min: [-8, -11, -15, -7, -9],
        precipitation_sum: [6, 0.4, 0, 9, 0], snowfall_sum: [8, 0.2, 0, 12.5, 0],
        wind_speed_10m_max: [14, 8, 4, 17, 6], wind_gusts_10m_max: [24, 13, 7, 29, 10],
        wind_direction_10m_dominant: [260, 300, 20, 250, 180],
      },
      hourly: { time: days.map((d) => `${d}T12:00`), freezing_level_height: [300, 0, 0, 450, 200] },
    });
  }
  // Kartverket's point elevation API (the first choice for Norwegian tours),
  // over the same synthetic slope as the Copernicus stub above.
  if (u.includes('hoydedata') || u.includes('geonorge')) {
    calls.kartverket++;
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    return J({ koordsys: 4258, punkter: pts.map(([lon, lat]) => ({ datakilde: 'dtm1', x: lon, y: lat, z: Math.round(((lat - 69.64) / 0.0134) * 1000) })) });
  }
  if (u.includes('kartverket') || u.includes('opentopomap')) {
    calls.tiles++;
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  // The test's own server may be called; nothing else may leave the test.
  // An unstubbed upstream request would make the result depend on the live
  // internet: CI once reached Kartverket and profiled a synthetic route
  // against the real terrain of Lyngen.
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
  throw new Error(`unstubbed request in tests: ${u}`);
};
test.after(() => (globalThis.fetch = realFetch));

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('derives, profiles and caches a route for a listed tour', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/track?tour=${encodeURIComponent('Rørnestinden')}`)).json();
    assert.equal(r.found, true);
    assert.equal(r.source, 'osm');
    assert.equal(r.summit.ele, 1035);
    assert.equal(r.startType, 'road');
    // One elevation sample per ~50 m of route, capped at one request (100).
    const expected = Math.min(100, Math.ceil(r.profile.stats.distanceM / 50) + 1);
    assert.ok(Math.abs(r.profile.samples.length - expected) <= 1, `${r.profile.samples.length} samples for ${r.profile.stats.distanceM} m`);
    assert.ok(r.profile.stats.ascentM > 900 && r.profile.stats.ascentM < 1100, `ascent ${r.profile.stats.ascentM}`);
    // The heights must come from the stubs, never from the live services:
    // a Norwegian tour profiles against Kartverket's model.
    assert.equal(r.profile.source, 'kartverket-dtm');
    assert.ok(calls.kartverket > 0, 'Kartverket was asked, and answered from the stub');

    // Second call is served from cache: no new upstream calls.
    const before = { ...calls };
    const again = await (await fetch(`${base}/api/track?tour=rornestinden`)).json();
    assert.equal(again.lengthM, r.lengthM, 'slug lookup returns the same route');
    assert.equal(calls.overpass, before.overpass);
    assert.equal(calls.elevation, before.elevation);
  });
});

test('GPX export carries the route and the OSM licence', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/track.gpx?tour=rornestinden`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /gpx/);
    assert.match(res.headers.get('content-disposition'), /rornestinden\.gpx/);
    const xml = await res.text();
    assert.match(xml, /<trkpt lat="69\.64/);
    assert.match(xml, /odbl/i);
    assert.match(xml, /Not a recommendation/);
  });
});

test('your own GPX in data/tracks wins over OpenStreetMap', async () => {
  await mkdir(path.join(tmp, 'tracks'), { recursive: true });
  await writeFile(
    path.join(tmp, 'tracks', 'tromsdalstinden.gpx'),
    `<gpx><trk><trkseg><trkpt lat="69.62" lon="19.0"><ele>50</ele></trkpt><trkpt lat="69.63" lon="19.05"><ele>1238</ele></trkpt></trkseg></trk></gpx>`
  );
  const before = calls.overpass;
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/track?tour=Tromsdalstinden`)).json();
    assert.equal(r.source, 'gpx');
    assert.equal(r.kind, 'own-gpx');
    assert.equal(r.profile.source, 'gpx', 'uses the elevations in the file');
    assert.equal(r.profile.stats.maxEle, 1238);
  });
  assert.equal(calls.overpass, before, 'no Overpass call for a tour with its own GPX');
});

test('area tours report why there is no single line, without calling Overpass', async () => {
  const before = calls.overpass;
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/track?tour=${encodeURIComponent('Sulitjelma area')}`)).json();
    assert.equal(r.found, false);
    assert.equal(r.kind, 'area');
    const gpx = await fetch(`${base}/api/track.gpx?tour=${encodeURIComponent('Sulitjelma area')}`);
    assert.equal(gpx.status, 404);
  });
  assert.equal(calls.overpass, before);
});

test('unknown tours and arbitrary coordinates are refused', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/track?tour=Mont%20Blanc`)).status, 404);
    assert.equal((await fetch(`${base}/api/forecast?tour=../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/api/forecast?lat=45&lon=6`)).status, 404);
  });
});

test('forecast is downscaled to the summit and cached', async () => {
  await withServer(async (base) => {
    const f = await (await fetch(`${base}/api/forecast?tour=${encodeURIComponent('Rørnestinden')}`)).json();
    assert.equal(f.days.length, 5);
    assert.equal(f.where.elevation, 1035, 'uses the OSM summit elevation');
    assert.equal(f.days[3].label, 'Snow showers');
    assert.equal(f.days[3].snowCm, 12.5);
    assert.equal(f.days[0].windDir, 'W');
    const n = calls.forecast;
    await fetch(`${base}/api/forecast?tour=rornestinden`);
    assert.equal(calls.forecast, n, 'second request served from cache');
  });
});

test('tile proxy serves tour-area tiles, refuses the rest, and caches', async () => {
  const z = 13, n = 2 ** z;
  const x = Math.floor(((20.05 + 180) / 360) * n);
  const r = (69.66 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  await withServer(async (base) => {
    const ok = await fetch(`${base}/tiles/no/${z}/${x}/${y}.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    const count = calls.tiles;
    await fetch(`${base}/tiles/no/${z}/${x}/${y}.png`);
    assert.equal(calls.tiles, count, 'cached tile is not refetched');

    assert.equal((await fetch(`${base}/tiles/no/${z}/0/0.png`)).status, 403, 'far from any tour');
    assert.equal((await fetch(`${base}/tiles/xx/${z}/${x}/${y}.png`)).status, 404, 'unknown source');
    assert.equal((await fetch(`${base}/tiles/no/3/4/2.png`)).status, 403, 'world-scale zoom');
  });
});
