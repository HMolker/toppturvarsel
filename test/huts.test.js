import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-huts-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { winterOpen, orgOf, shapeHuts, hutsQuery, clusterPoints, getHuts } = await import('../src/huts.js');

test('open in winter: seasonal and opening_hours months, else unknown', () => {
  assert.equal(winterOpen({ opening_hours: 'Feb 15-Apr 30: 08:00-22:00' }), true);
  assert.equal(winterOpen({ opening_hours: 'Jun 20-Sep 10' }), false);
  assert.equal(winterOpen({ opening_hours: 'Mar,Apr: Sa,Su 10:00-16:00' }), true);
  assert.equal(winterOpen({ opening_hours: 'Nov-Jan' }), true, 'a range across the new year');
  assert.equal(winterOpen({ opening_hours: '24/7' }), true, 'an unlocked hut');
  assert.equal(winterOpen({ opening_hours: 'Mo-Fr 08:00-16:00' }), null, 'weekdays only: cannot tell');
  assert.equal(winterOpen({ seasonal: 'summer' }), false);
  assert.equal(winterOpen({ seasonal: 'winter' }), true);
  assert.equal(winterOpen({}), null);
});

test('who runs it: DNT and STF from operator', () => {
  assert.equal(orgOf({ operator: 'Den Norske Turistforening' }), 'DNT');
  assert.equal(orgOf({ operator: 'Bergen og Hordaland Turlag' }), 'DNT', 'member associations count');
  assert.equal(orgOf({ operator: 'Svenska Turistföreningen' }), 'STF');
  assert.equal(orgOf({ operator: 'Privat' }), null);
});

const TOUR = { lat: 61.0, lon: 8.2 };
const n = (id, tags, lat, lon) => ({ type: 'node', id, tags, lat, lon });

test('shape: cabins, shelters, lodges and remote cafés — not the café in the village, never a bar', () => {
  const els = [
    n(1, { place: 'village', name: 'Bygda' }, 61.0, 8.1),
    n(2, { amenity: 'cafe', name: 'Kafé i sentrum' }, 61.001, 8.101),
    n(3, { amenity: 'cafe', name: 'Toppkafeen', opening_hours: 'Feb-Apr' }, 61.05, 8.25),
    n(4, { amenity: 'bar', name: 'Afterski' }, 61.05, 8.26),
    n(5, { tourism: 'alpine_hut', name: 'Stølsbu', operator: 'Den Norske Turistforening', beds: '24', ele: '1120', staffed: 'yes' }, 61.02, 8.3),
    n(6, { tourism: 'wilderness_hut', name: 'Gapahuk', opening_hours: '24/7' }, 61.03, 8.15),
    { type: 'way', id: 7, tags: { tourism: 'hotel', name: 'Tyinholmen Fjellstue', website: 'https://example.no' }, center: { lat: 61.04, lon: 8.2 } },
    { type: 'way', id: 8, tags: { tourism: 'hotel', name: 'Grand Hotel' }, center: { lat: 61.04, lon: 8.21 } },
    n(9, { tourism: 'alpine_hut', name: 'Langt unna' }, 62.5, 9.5),
    n(10, { amenity: 'restaurant', name: 'Seterrestauranten', seasonal: 'summer' }, 61.06, 8.3),
  ];
  const out = shapeHuts(els, [TOUR]);
  const names = out.map((p) => p.name).sort();
  assert.deepEqual(names, ['Gapahuk', 'Seterrestauranten', 'Stølsbu', 'Toppkafeen', 'Tyinholmen Fjellstue']);
  const hut = out.find((p) => p.name === 'Stølsbu');
  assert.deepEqual([hut.kind, hut.org, hut.beds, hut.ele, hut.staffed, hut.winter], ['hut', 'DNT', 24, 1120, true, null]);
  assert.match(hut.more, /google\.com\/search\?q=site%3Aut\.no/);
  assert.equal(out.find((p) => p.name === 'Toppkafeen').winter, true);
  assert.equal(out.find((p) => p.name === 'Seterrestauranten').winter, false);
  assert.equal(out.find((p) => p.name === 'Tyinholmen Fjellstue').kind, 'lodge');
  assert.equal(out.find((p) => p.name === 'Tyinholmen Fjellstue').website, 'https://example.no/');
});

test('query: one circle per cluster of tours, settlements asked for too', () => {
  const pts = clusterPoints([{ lat: 61, lon: 8 }, { lat: 61.01, lon: 8.02 }, { lat: 62, lon: 9 }]);
  assert.equal(pts.length, 2);
  const q = hutsQuery(pts);
  assert.equal((q.match(/alpine_hut\|wilderness_hut/g) ?? []).length, 2);
  assert.match(q, /place~"\^\(village\|town\|city\)\$"/);
  assert.doesNotMatch(q, /bar|pub|fast_food/);
  assert.match(q, /out center tags;/);
});

test('getHuts: one Overpass request for all tours, then cached', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('overpass')) throw new Error(`unstubbed request in tests: ${u}`);
    calls++;
    assert.equal(opts.method, 'POST');
    return new Response(JSON.stringify({ elements: [n(5, { tourism: 'alpine_hut', name: 'Test' }, 61.0539, 8.2143)] }), { status: 200 });
  };
  try {
    const a = await getHuts();
    assert.equal(calls, 1);
    assert.equal(a.places.length, 1);
    await getHuts();
    assert.equal(calls, 1, 'cached');
  } finally {
    globalThis.fetch = realFetch;
  }
});
