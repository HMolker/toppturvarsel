import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-lifts-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';

const { shapeSsr, ssrLifts, matchToLifts } = await import('../src/sources/ssr.js');
const { shapeLiftFile, fileLifts, _resetLiftFile } = await import('../src/sources/liftfile.js');

const SSR_BODY = {
  metadata: { totaltAntallTreff: 4 },
  navn: [
    { navneobjekttype: 'Alpinanlegg', stedsnummer: 1, stedsnavn: [{ 'skrivemåte': 'Hemsedal Skisenter' }], representasjonspunkt: { nord: 60.86008, 'øst': 8.51703 } },
    { navneobjekttype: 'Skiheis', stedsnummer: 2, stedsnavn: [{ 'skrivemåte': 'Parallellheisen' }], representasjonspunkt: { nord: 60.85613, 'øst': 8.51577 } },
    { navneobjekttype: 'Fjellheis', stedsnummer: 3, stedsnavn: [{ 'skrivemåte': 'Toppheisen' }], representasjonspunkt: { nord: 60.8700, 'øst': 8.5300 } },
    { navneobjekttype: 'Haug', stedsnummer: 4, stedsnavn: [{ 'skrivemåte': 'Storhaugen' }], representasjonspunkt: { nord: 60.8600, 'øst': 8.5100 } },
  ],
};

test('Kartverket place names: lifts and the ski area are kept, other names dropped', () => {
  const s = shapeSsr(SSR_BODY);
  assert.deepEqual(s.lifts.map((l) => l.name), ['Parallellheisen', 'Toppheisen']);
  assert.deepEqual(s.areas.map((a) => a.name), ['Hemsedal Skisenter']);
  assert.deepEqual(shapeSsr({}), { lifts: [], areas: [] });
});

test('Kartverket place names: one keyless request, with the app named in the User-Agent', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), ua: opts.headers['User-Agent'] };
    return new Response(JSON.stringify(SSR_BODY), { status: 200 });
  };
  try {
    const { lifts } = await ssrLifts(60.86, 8.51, { radiusM: 4000 });
    assert.equal(lifts.length, 2);
    assert.match(seen.url, /ws\.geonorge\.no\/stedsnavn\/v1\/punkt\?nord=60\.86000&ost=8\.51000&koordsys=4258/);
    assert.match(seen.url, /radius=4000/);
    assert.match(seen.ua, /^Fjallskred\//);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a registered lift with nothing mapped near it counts as missing', () => {
  const lifts = [{ points: [{ lat: 60.8550, lon: 8.5150 }, { lat: 60.8580, lon: 8.5160 }] }];
  const { matched, missing } = matchToLifts(shapeSsr(SSR_BODY).lifts, lifts);
  assert.deepEqual(matched.map((m) => m.name), ['Parallellheisen']);
  assert.deepEqual(missing.map((m) => m.name), ['Toppheisen']);
});

test('a Lantmäteriet export is read from data/lifts-SE.geojson', async () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { namn: 'Hummelliften', objekttyp: 'Lintrafik' }, geometry: { type: 'LineString', coordinates: [[13.1, 63.4], [13.11, 63.41]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[13.2, 63.4], [13.21, 63.41]], [[13.3, 63.4], [13.31, 63.41]]] } },
      { type: 'Feature', properties: { namn: 'Dot' }, geometry: { type: 'Point', coordinates: [13.4, 63.4] } },
    ],
  };
  assert.equal(shapeLiftFile(gj).length, 3, 'two lines from the multi-line, the point ignored');
  assert.deepEqual(shapeLiftFile(gj)[0], { name: 'Hummelliften', kind: 'Lintrafik', points: [{ lat: 63.4, lon: 13.1 }, { lat: 63.41, lon: 13.11 }] });
  await writeFile(path.join(tmp, 'lifts-SE.geojson'), JSON.stringify(gj));
  _resetLiftFile();
  assert.equal((await fileLifts('SE')).length, 3);
  assert.deepEqual(await fileLifts('NO'), [], 'no file for Norway: nothing, and no error');
});
