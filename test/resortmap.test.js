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

test('Overpass query: the ski area, everything inside it, lifts and funiculars around it, and places', () => {
  const q = resortQuery(60.86, 8.51);
  assert.match(q, /way\(around:9000,60\.86,8\.51\)\[landuse=winter_sports\]/);
  assert.match(q, /relation\(around:9000,60\.86,8\.51\)\[site=piste\]/);
  assert.match(q, /\.a map_to_area->\.ar;/);
  assert.match(q, /way\(area\.ar\)\[aerialway\]/);
  assert.match(q, /way\(around:7000,60\.86,8\.51\)\[aerialway\]/);
  assert.match(q, /way\(area\.ar\)\[railway=funicular\]/);
  assert.match(q, /node\(area\.ar\)\[aerialway~"\^\(station\|pylon\)\$"\]/);
  assert.match(q, /way\(area\.ar\)\["piste:type"\]/);
  assert.match(q, /amenity~"\^\(restaurant\|cafe\|bar\|fast_food\|ski_school\)\$"/);
  assert.match(q, /shop=ski/);
});

test('lifts: those in the area, plus whatever links to them; a stranger stays out', async () => {
  const { keepLiftChain } = await import('../src/resortmap.js');
  const P = (e, n) => ({ lat: BASE.lat + n / 111320, lon: BASE.lon + e / 55000 });
  const L = (name, a, b) => ({ name, points: [a, b] });
  const lifts = [
    L('base', P(0, 0), P(0, 1500)),
    L('linked', P(0, 1550), P(0, 3000)),        // starts where the first ends
    L('linked again', P(50, 3050), P(600, 4400)),
    L('neighbour', P(9000, 200), P(9000, 1400)),
  ];
  const kept = keepLiftChain(lifts, null, BASE).map((l) => l.name);
  assert.deepEqual(kept, ['base', 'linked', 'linked again'], 'the chain is followed out of the circle');
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

test('shape: a resort area mapped as a multipolygon relation is used too', () => {
  const ring = [[-500, -500], [500, -500], [500, 500], [-500, 500], [-500, -500]].map(([e, n]) => ({ lat: BASE.lat + n / 111320, lon: BASE.lon + e / 55000 }));
  const els = [
    { type: 'relation', id: 1, tags: { landuse: 'winter_sports', type: 'multipolygon', name: 'Relasjonsfjellet' }, members: [{ type: 'way', role: 'outer', geometry: ring }] },
    { type: 'way', id: 2, tags: { aerialway: 't-bar', name: 'Inne' }, geometry: [{ lat: BASE.lat, lon: BASE.lon }, { lat: BASE.lat + 0.003, lon: BASE.lon }] },
    { type: 'way', id: 3, tags: { aerialway: 't-bar', name: 'Ute' }, geometry: [{ lat: BASE.lat + 0.05, lon: BASE.lon }, { lat: BASE.lat + 0.053, lon: BASE.lon }] },
  ];
  const s = shapeResort(els, BASE);
  assert.equal(s.boundary.name, 'Relasjonsfjellet');
  assert.deepEqual(s.lifts.map((l) => l.name), ['Inne']);
});

test('Overpass: a busy instance gets one wait and retry, then the next; a refusing one is rested', async () => {
  const { overpass, OVERPASS_URLS, _resetOverpass } = await import('../src/util/overpass.js');
  _resetOverpass();
  const realFetch = globalThis.fetch;
  const [a, b, c] = OVERPASS_URLS.map((u) => new URL(u).host);
  let hosts = [];
  let refuse = null;
  globalThis.fetch = async (url) => {
    const h = new URL(url).host;
    hosts.push(h);
    if (h === refuse) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
    if (h === a) return new Response('busy', { status: 429 });
    return new Response(JSON.stringify({ elements: [{ type: 'node', id: 1 }] }), { status: 200 });
  };
  try {
    assert.equal((await overpass('[out:json];node(1);out;')).length, 1);
    assert.deepEqual(hosts, [a, a, b], '429, wait, 429 again, then the next instance');
    _resetOverpass();
    hosts = [];
    refuse = a;
    await overpass('q');
    assert.deepEqual(hosts, [a, b]);
    hosts = [];
    await overpass('q');
    assert.equal(hosts[0], b, 'the refusing instance is rested and tried last');
    refuse = 'none';
    globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    await assert.rejects(overpass('q'), /Overpass\) unavailable: .*ECONNREFUSED/);
    void c;
  } finally {
    globalThis.fetch = realFetch;
    _resetOverpass();
  }
});

test('Overpass queue: a map someone is waiting for jumps the background work', async () => {
  const { overpass, _resetOverpass } = await import('../src/util/overpass.js');
  _resetOverpass();
  const realFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url, opts) => {
    const q = decodeURIComponent(String(opts.body).slice(5));
    order.push(q);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  };
  try {
    const all = [
      overpass('bg1', { priority: 'low' }),
      overpass('bg2', { priority: 'low' }),
      overpass('route', { priority: 'normal' }),
      overpass('map', { priority: 'high' }),
    ];
    await Promise.all(all);
    assert.deepEqual(order, ['bg1', 'map', 'route', 'bg2'], 'the first had already started; then high, normal, low');
  } finally {
    globalThis.fetch = realFetch;
    _resetOverpass();
  }
});

test('Overpass queue: a deadline ends the wait in line; background work rests after a total failure', async () => {
  const { overpass, overpassStatus, _resetOverpass } = await import('../src/util/overpass.js');
  _resetOverpass();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 300));
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  };
  try {
    const slow = overpass('slow', { priority: 'high', what: 'huts' });
    await assert.rejects(overpass('map', { priority: 'high', deadlineMs: 100 }), /busy: waited 0 s in line \(busy with huts/);
    await slow;
    assert.equal(calls, 1, 'the timed-out request never went out');

    globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    await assert.rejects(overpass('q'), /unavailable/);
    assert.ok(overpassStatus().coolingS > 0);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{"elements":[]}', { status: 200 }); };
    await assert.rejects(overpass('warm-up', { priority: 'low' }), /resting after failures/);
    assert.equal(calls, 0);
    await overpass('a click', { priority: 'normal' });
    assert.equal(calls, 1, 'a click still tries, and success ends the rest');
    assert.equal(overpassStatus().coolingS, 0);
  } finally {
    globalThis.fetch = realFetch;
    _resetOverpass();
  }
});

test('night scan: the window, and missing maps first, then the oldest, fresh ones skipped', async () => {
  const { inWindow, scanOrder } = await import('../src/nightly.js');
  assert.ok(inWindow(1, 1, 5) && inWindow(4, 1, 5) && !inWindow(5, 1, 5) && !inWindow(13, 1, 5));
  assert.ok(inWindow(23, 22, 4) && inWindow(3, 22, 4) && !inWindow(12, 22, 4), 'a window across midnight');
  const day = 86400e3;
  const meta = { a: { age: 10 * day, app: '5.0.0' }, b: { age: Infinity, app: null }, c: { age: 120 * day, app: '5.0.0' }, d: { age: 95 * day, app: '5.0.0' } };
  const order = await scanOrder(['a', 'b', 'c', 'd'].map((id) => ({ id })), async (id) => meta[id], 90, '5.0.0');
  assert.deepEqual(order.map((r) => r.id), ['b', 'c', 'd']);
  const afterUpgrade = await scanOrder(['a', 'b', 'c', 'd'].map((id) => ({ id })), async (id) => meta[id], 90, '5.1.0');
  assert.deepEqual(afterUpgrade.map((r) => r.id), ['b', 'c', 'd', 'a'], 'a new version refetches every map once');
});

test('getResortMap: a stored map is shown at once however old; an old one is refreshed behind the scenes', async () => {
  const { writeFile, mkdir: mk } = await import('node:fs/promises');
  const { getResortMap } = await import('../src/resortmap.js');
  const R = { ...BASE, id: 'fnugg-old' };
  const dir = path.join(tmp, 'cache', 'resortmap');
  await mk(dir, { recursive: true });
  const old = new Date(Date.now() - 200 * 86400e3).toISOString();
  await writeFile(path.join(dir, 'fnugg-old.json'), JSON.stringify({ v: 3, id: R.id, resort: 'Old', lifts: [], runs: [], facts: {}, fetchedAt: old }));
  const realFetch = globalThis.fetch;
  let overpassCalls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.fetch = async (url) => {
    if (String(url).includes('overpass')) {
      overpassCalls++;
      await gate;
      return new Response(JSON.stringify({ elements: makeResortOsm(R) }), { status: 200 });
    }
    return new Response(JSON.stringify({ punkter: [] }), { status: 200 });
  };
  try {
    const m = await getResortMap(R);
    assert.equal(m.fetchedAt, old, 'the old map comes back without waiting');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(overpassCalls, 1, 'and a refresh has started');
    release();
    await new Promise((r) => setTimeout(r, 100));
    const again = await getResortMap(R);
    assert.notEqual(again.fetchedAt, old, 'the refreshed map is stored');
    assert.equal(again.lifts.length, 7);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fun facts: the resort\'s own counts come first and the OpenStreetMap ones are marked as an estimate', async () => {
  const { factsHtml } = await import('../public/resortfacts.js');
  const s = shapeResort(makeResortOsm(BASE), BASE);
  const f = resortFacts(s, s.lifts.map(() => ({ a: 600, b: 1200 })));
  const html = factsHtml(f, { lifts: { count: 9 }, slopes: { count: 18 } });
  assert.match(html, /The resort&#39;s own count|The resort's own count/);
  assert.match(html, /9 lifts reported, 7 mapped \(2 missing from OpenStreetMap\)/);
  assert.match(html, /18 slopes reported, 11 mapped \(7 missing from OpenStreetMap\)/);
  assert.match(html, /≈ 7 lifts/);
  assert.match(html, /an estimate/);
  // No live counts: no comparison card, but still an estimate.
  const plain = factsHtml(f, null);
  assert.ok(!/own count/.test(plain));
  assert.match(plain, /≈ 11 runs/);
});
