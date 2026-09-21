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

test('Overpass query asks for downhill runs and lifts only', () => {
  const q = resortQuery(60.86, 8.51);
  assert.match(q, /way\(around:4000,60\.86,8\.51\)\["piste:type"="downhill"\]/);
  assert.match(q, /aerialway~"\^\(cable_car\|gondola/);
  assert.doesNotMatch(q, /pylon|station|goods|zip_line/);
});

test('shape: lifts and runs, areas apart, junk skipped', () => {
  const els = [
    ...makeResortOsm(BASE),
    { type: 'way', id: 1, tags: { aerialway: 'pylon' }, geometry: [{ lat: 60, lon: 8 }, { lat: 60.01, lon: 8 }] },
    { type: 'node', id: 2, tags: { aerialway: 'station' }, lat: 60, lon: 8 },
    { type: 'way', id: 3, tags: { 'piste:type': 'downhill', area: 'yes', 'piste:difficulty': 'easy' },
      geometry: [{ lat: 60, lon: 8 }, { lat: 60.001, lon: 8 }, { lat: 60.001, lon: 8.002 }, { lat: 60, lon: 8 }] },
  ];
  const s = shapeResort(els);
  assert.equal(s.lifts.length, 7, 'pylons and stations are not lifts');
  assert.equal(s.areas.length, 1);
  assert.equal(s.runs.length, 14);
  const g = s.lifts.find((l) => l.kind === 'gondola');
  assert.equal(g.capacity, 2400);
  assert.equal(g.drag, false);
  assert.equal(s.lifts.find((l) => l.kind === 't-bar').drag, true);
  assert.ok(g.lengthM > 3000 && g.lengthM < 4000, `gondola ${g.lengthM} m`);
});

test('facts: runs counted by name, capacity from lifts that have it, longest, vertical', () => {
  const s = shapeResort(makeResortOsm(BASE));
  const f = resortFacts(s, [{ name: 'Toppekspressen', kind: 'gondola', bottom: 650, top: 1470 }, { name: 'Barnebakken', kind: 'platter', bottom: 640, top: 690 }]);
  assert.equal(f.runCount, 11, '14 ways: three names split in two, one unnamed');
  assert.equal(f.runsByDifficulty.easy, 4, 'Hengsletta, Solsida, Familieløypa (two pieces) and one unnamed');
  assert.equal(f.runsByDifficulty.unknown, 0);
  assert.equal(f.liftCount, 7);
  assert.equal(f.liftsByKind.chair_lift, 2);
  assert.equal(f.capacity, 2400 + 2800 + 1200 + 1100 + 700);
  assert.equal(f.capacityFrom, 5);
  assert.equal(f.longestRun.name, 'Hollvinhytta', 'two pieces add up');
  assert.equal(f.longestLift.name, 'Toppekspressen');
  assert.deepEqual([f.top, f.bottom, f.vertical], [1470, 640, 830]);
  assert.equal(f.biggestLift.rise, 820);
  assert.ok(f.runKm > 10);
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
    assert.equal(m.source, 'OpenStreetMap contributors (ODbL)');
    await getResortMap(BASE);
    assert.equal(calls.overpass, 1, 'cached for 30 days');
  } finally {
    globalThis.fetch = realFetch;
  }
});
