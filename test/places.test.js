import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Place search (v5.6): Kartverket's place names for Norway, Nominatim for
 * Sweden, both stubbed in their documented shapes; picking a result adds it
 * to the service area, and nothing else can.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-places-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.NOMINATIM_GAP_MS = '0';
process.env.PLACES_DAILY = '3';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const calls = { kv: 0, nom: 0, nomUA: null };
let kvDown = false;
const realFetch = globalThis.fetch;
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^https?:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, opts);
  if (u.includes('ws.geonorge.no/stedsnavn')) {
    calls.kv++;
    if (kvDown) return J({ error: 'down' }, 503);
    const q = new URL(u).searchParams.get('sok');
    if (q === 'Romsdalen') {
      return J({
        metadata: { totaltAntallTreff: 2 },
        navn: [
          { skrivemåte: 'Romsdalshorn', navneobjekttype: 'Fjell', stedsnummer: 11, representasjonspunkt: { øst: 7.8589, nord: 62.4783, koordsys: 4258 }, kommuner: [{ kommunenavn: 'Rauma' }], fylker: [{ fylkesnavn: 'Møre og Romsdal' }] },
          { skrivemåte: 'Romsdalen', navneobjekttype: 'Dal', stedsnummer: 12, representasjonspunkt: { øst: 7.95, nord: 62.47, koordsys: 4258 }, kommuner: [{ kommunenavn: 'Rauma' }], fylker: [{ fylkesnavn: 'Møre og Romsdal' }] },
        ],
      });
    }
    return J({ metadata: { totaltAntallTreff: 0 }, navn: [] });
  }
  if (u.includes('nominatim')) {
    calls.nom++;
    calls.nomUA = opts.headers?.['User-Agent'] ?? null;
    const q = new URL(u).searchParams;
    assert.equal(q.get('countrycodes'), 'se');
    if (q.get('q') === 'Städjan') {
      return J([{ place_id: 1, osm_type: 'node', osm_id: 42, lat: '61.9197', lon: '12.8730', name: 'Städjan', type: 'peak', display_name: 'Städjan, Älvdalens kommun, Dalarnas län, Sverige' }]);
    }
    if (q.get('q') === 'Omberg') {
      return J([{ place_id: 2, osm_type: 'node', osm_id: 7, lat: '58.3200', lon: '14.6500', name: 'Omberg', type: 'hill', display_name: 'Omberg, Ödeshögs kommun, Östergötlands län, Sverige' }]);
    }
    return J([]);
  }
  return new Response('offline', { status: 503 });
};

const { searchPlaces, pickPlace, _resetPlaces } = await import('../src/places.js');
const { createServer } = await import('../src/server.js');

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('Norway from Kartverket, Sweden from Nominatim, mountains first, kept', async () => {
  _resetPlaces();
  const no = await searchPlaces('Romsdalen');
  assert.equal(no.places[0].name, 'Romsdalen', 'the exact name first');
  assert.deepEqual(no.places[1], { id: 'kv:11', name: 'Romsdalshorn', kind: 'Fjell', area: 'Rauma, Møre og Romsdal', country: 'NO', lat: 62.4783, lon: 7.8589 });
  const se = await searchPlaces('Städjan');
  assert.deepEqual(se.places, [{ id: 'osm:node42', name: 'Städjan', kind: 'peak', area: 'Älvdalens kommun, Dalarnas län', country: 'SE', lat: 61.9197, lon: 12.873 }]);
  assert.match(calls.nomUA, /Fjallskred/, 'identifies itself to Nominatim');
  const n = calls.kv + calls.nom;
  await searchPlaces('  städjan ');
  assert.equal(calls.kv + calls.nom, n, 'answered from the cache');
  const onlyNo = await searchPlaces('Romsdalen', { country: 'NO' });
  assert.ok(onlyNo.places.every((p) => p.country === 'NO'));
  await assert.rejects(searchPlaces('a'), (e) => e.status === 400);
});

test('one register down: the other still answers, and it is not kept', async () => {
  _resetPlaces();
  kvDown = true;
  const r = await searchPlaces('Fjätervålen');
  assert.match(r.partial, /Kartverket/);
  kvDown = false;
  const before = calls.kv;
  await searchPlaces('Fjätervålen');
  assert.equal(calls.kv, before + 1, 'asked again');
});

test('only a place the server found can be picked; it joins the service area; a daily cap', async () => {
  _resetPlaces();
  await assert.rejects(pickPlace('kv:999'), (e) => e.status === 404);
  await withServer(async (base) => {
    const far = { z: 14, ...(() => { const n = 2 ** 14, lat = 58.32, lon = 14.65; return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n) }; })() };
    // Omberg is far from every listed tour and resort: its tiles are refused.
    assert.equal((await fetch(`${base}/tiles/se/${far.z}/${far.x}/${far.y}.png`)).status, 403);
    const s = await (await fetch(`${base}/api/places?q=Omberg`)).json();
    const res = await fetch(`${base}/api/places/pick`, { method: 'POST', body: JSON.stringify({ id: s.places[0].id }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).place.name, 'Omberg');
    const zone = await (await fetch(`${base}/api/terrain/zone`)).json();
    assert.ok(zone.places.some((p) => p.name === 'Omberg' && p.country === 'SE'));
    // Now inside the service area: no longer refused (the stub upstream is offline, so not a 200 either).
    assert.notEqual((await fetch(`${base}/tiles/se/${far.z}/${far.x}/${far.y}.png`)).status, 403);
    const saved = JSON.parse(await readFile(path.join(tmp, 'cache', 'places-zones.json'), 'utf8'));
    assert.equal(saved.zones.length, 1);
    // Picking it again is free; new ones stop at PLACES_DAILY (3).
    await pickPlace(s.places[0].id);
    const r2 = await searchPlaces('Romsdalen');
    await pickPlace(r2.places[0].id);
    await pickPlace(r2.places[1].id);
    const r3 = await fetch(`${base}/api/places/pick`, { method: 'POST', body: JSON.stringify({ id: 'kv:11' }) });
    assert.equal(r3.status, 200, 'already picked: fine');
    await searchPlaces('Fjätervålen');
    assert.equal((await fetch(`${base}/api/places/pick`, { method: 'GET' })).status, 405);
  });
});

test('daily cap', async () => {
  _resetPlaces();
  const { writeFile } = await import('node:fs/promises');
  const today = new Date().toISOString();
  await writeFile(path.join(tmp, 'cache', 'places-zones.json'), JSON.stringify({ zones: [1, 2, 3].map((i) => ({ id: `x${i}`, name: `x${i}`, lat: 60, lon: 10, country: 'NO', added: today, at: today })) }));
  _resetPlaces();
  const s = await searchPlaces('Städjan');
  await assert.rejects(pickPlace(s.places[0].id), (e) => e.status === 429);
});

// ---- the sketch map's snow areas (pure) -----------------------------------

test('snow areas: each region gets the land nearer to it, within the radius', async () => {
  const { regionAreas } = await import('../public/snowareas.js');
  const areas = regionAreas([{ id: 'a', lat: 61, lon: 9 }, { id: 'b', lat: 61, lon: 10.5 }, { id: 'far', lat: 68, lon: 18 }, { id: 'bad', lat: null, lon: 3 }]);
  assert.deepEqual(areas.map((x) => x.id), ['a', 'b', 'far']);
  const a = areas.find((x) => x.id === 'a');
  const east = Math.max(...a.ring.map(([, lon]) => lon));
  assert.ok(Math.abs(east - 9.75) < 1e-6, `a stops half-way to b (${east})`);
  const far = areas.find((x) => x.id === 'far');
  const northKm = (Math.max(...far.ring.map(([lat]) => lat)) - 68) * 111.2;
  assert.ok(Math.abs(northKm - 110) < 3, `a lone region reaches 110 km (${northKm.toFixed(1)})`);
});
