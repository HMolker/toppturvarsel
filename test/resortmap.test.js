import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-rm-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { shapeResort, resortFacts, resortQuery, getResortMap } = await import('../src/resortmap.js');
const { makeResortOsm, makeResortTerrain } = await import('../demo/advert/resort.mjs');

const BASE = { id: 'fnugg-test', name: 'Testfjell', country: 'NO', lat: 60.8601, lon: 8.5178 };

test('Overpass query: every piste type, lifts, stations and pylons, the area, and places', () => {
  const q = resortQuery(60.86, 8.51);
  assert.match(q, /way\(around:4000,60\.86,8\.51\)\["piste:type"\]/);
  assert.match(q, /aerialway~"\^\(cable_car\|gondola/);
  assert.match(q, /node\(around:4000,60\.86,8\.51\)\[aerialway~"\^\(station\|pylon\)\$"\]/);
  assert.match(q, /landuse=winter_sports/);
  assert.match(q, /amenity~"\^\(restaurant\|cafe\|bar\|fast_food\|ski_school\)\$"/);
  assert.match(q, /shop=ski/);
});

test('shape: the resort area keeps a neighbour out; stations, pylons and details land on their lift', () => {
  const s = shapeResort(makeResortOsm(BASE), BASE);
  assert.equal(s.boundary.name, 'Testfjell skisenter');
  assert.equal(s.lifts.length, 7, 'the neighbour resort\'s chairlift is outside the area');
  assert.ok(!s.lifts.some((l) => l.name === 'Naboheisen'));
  const g = s.lifts.find((l) => l.kind === 'gondola');
  assert.deepEqual([g.ref, g.capacity, g.occupancy, g.duration, g.detachable, g.heating], ['G1', 2400, 8, 9, true, false]);
  assert.deepEqual([g.stationA, g.stationB], ['Sentrum', 'Toppen']);
  assert.equal(g.pylons.length, 9, 'pylon nodes on the cable belong to it');
  const c = s.lifts.find((l) => l.name === 'Holdeskaret');
  assert.deepEqual([c.duration, c.bubble, c.heating], [6.5, true, true], '"6:30" is six and a half minutes');
  assert.equal(s.lifts.find((l) => l.name === 'Tinden').duration, 4.5, 'PT4M30S');
  assert.equal(s.lifts.find((l) => l.kind === 't-bar').drag, true);
  assert.equal(s.runs.length, 14);
  const lit = s.runs.filter((r) => r.lit).map((r) => r.name);
  assert.ok(lit.includes('Barnebakken') && lit.includes('Stiglia'));
  assert.equal(s.runs.find((r) => r.name === 'Nordsida').gladed, true);
  assert.equal(s.nordic.length, 2);
  assert.equal(s.sled.length, 1);
  assert.equal(s.parks.length, 1);
  assert.deepEqual(s.pois.map((p) => p.kind).sort(), ['bar', 'café', 'restaurant', 'restaurant', 'ski rental', 'ski school']);
});

test('facts: runs by name and number, lifts table, capacity, lit and snowmaking km, places', () => {
  const s = shapeResort(makeResortOsm(BASE), BASE);
  const ends = s.lifts.map((l) => (l.name === 'Toppekspressen' ? { a: 650, b: 1470 } : l.name === 'Barnebakken' ? { a: 640, b: 690 } : { a: null, b: null }));
  const f = resortFacts(s, ends);
  assert.equal(f.runCount, 11, '14 ways: three runs in two pieces, one unnamed');
  assert.equal(f.runsByDifficulty.easy, 4);
  assert.equal(f.liftCount, 7);
  assert.equal(f.capacity, 2400 + 2800 + 1200 + 1100 + 700);
  assert.equal(f.capacityFrom, 5);
  assert.equal(f.lifts[0].name, 'Toppekspressen', 'lifts longest first');
  assert.deepEqual([f.lifts[0].from, f.lifts[0].to, f.lifts[0].rise, f.lifts[0].top], ['Sentrum', 'Toppen', 820, 1470]);
  assert.deepEqual([f.top, f.bottom, f.vertical], [1470, 640, 830]);
  assert.equal(f.biggestLift.name, 'Toppekspressen');
  assert.ok(f.litKm > 2 && f.snowmakingKm > 2);
  assert.equal(f.offPiste, 2, 'freeride and the backcountry-groomed expert run');
  assert.ok(f.nordicKm > 3);
  assert.equal(f.parks, 1);
  assert.deepEqual(f.pois.restaurant, ['Skistua', 'Hollvinhytta']);
  assert.equal(f.longestRun.name, 'Hollvinhytta');
  const hv = f.runs.find((r) => r.name === 'Hollvinhytta');
  assert.equal(hv.lit, true, 'a run is floodlit if any piece is');
});

test('getResortMap: one Overpass request, elevations for contours and stations, then cached', async () => {
  const z = makeResortTerrain(BASE);
  const realFetch = globalThis.fetch;
  const calls = { overpass: 0, elevation: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const J = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (u.includes('overpass')) {
      calls.overpass++;
      assert.equal(opts.method, 'POST');
      return J({ elements: makeResortOsm(BASE) });
    }
    if (u.includes('hoydedata') || u.includes('geonorge')) {
      calls.elevation++;
      const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
      return J({ punkter: pts.map(([lon, lat]) => ({ z: z(lat, lon) })) });
    }
    throw new Error(`unstubbed request in tests: ${u}`);
  };
  try {
    const m = await getResortMap(BASE);
    assert.equal(calls.overpass, 1);
    assert.ok(calls.elevation >= 10, 'grid + stations in batches of 50');
    assert.equal(m.terrain.z.length, 24 * 20);
    assert.ok(m.facts.vertical > 600, `vertical ${m.facts.vertical}`);
    assert.ok(m.lifts.every((l) => Number.isFinite(l.za) && Number.isFinite(l.zb)), 'station heights for the map');
    assert.equal(m.source, 'OpenStreetMap contributors (ODbL)');
    await getResortMap(BASE);
    assert.equal(calls.overpass, 1, 'cached for 30 days');
  } finally {
    globalThis.fetch = realFetch;
  }
});
