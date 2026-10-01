import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * swissALTI3D (v6.1): the GeoTIFF reader on files written here in the
 * layouts GeoTIFFs come in, the Swiss grid conversion, and the height chain
 * against a stubbed swisstopo (STAC answer in the shape checked on 1 Oct
 * 2026, two years of the same square).
 */

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), 'ttv-swiss-'));
process.env.LOG_LEVEL = 'error';
const { readRaster } = await import('../src/sources/tiffraster.js');
const sw = await import('../src/sources/swissalti3d.js');

import { writeTiff } from './helpers/tiff.js';

const plane = (x, y) => 2500 + x * 0.8 - y * 0.6;

test('reader: deflate strips with the floating-point predictor, both byte orders', () => {
  for (const le of [true, false]) {
    const r = readRaster(writeTiff({ width: 13, height: 11, values: plane, le, scale: [2, 2, 0], tie: [0, 0, 0, 2634000, 1099000, 0] }));
    assert.equal(r.width, 13);
    assert.ok(Math.abs(r.data[5 * 13 + 7] - plane(7, 5)) < 1e-3);
    assert.ok(Math.abs(r.data[10 * 13 + 12] - plane(12, 10)) < 1e-3, 'the short last strip');
    assert.deepEqual(r.scale.slice(0, 2), [2, 2]);
    assert.match(r.info, /strips of 7 rows, 32-bit float, compression 8, predictor 3/);
  }
});

test('reader: tiles, uncompressed int16 with the horizontal predictor, and no-data', () => {
  const r = readRaster(writeTiff({ width: 20, height: 18, values: (x, y) => (x === 3 && y === 4 ? -9999 : 1800 + x * 3 - y), bits: 16, format: 2, compression: 1, predictor: 2, tile: 16, nodata: -9999 }));
  assert.equal(r.data[4 * 20 + 2], 1800 + 6 - 4);
  assert.ok(Number.isNaN(r.data[4 * 20 + 3]), 'no-data becomes NaN');
  assert.equal(r.data[17 * 20 + 19], 1800 + 57 - 17, 'the corner of a partial tile');
  assert.throws(() => readRaster(Buffer.from('not a tiff at all')), /not a TIFF/);
});

test('the Swiss grid: Bern is the origin; the conversion goes both ways within a metre', () => {
  const b = sw.lv95(46.95108, 7.43864);
  assert.ok(Math.abs(b.e - 2600000) < 2 && Math.abs(b.n - 1200000) < 2);
  const a = sw.lv95(46.037, 7.884);
  assert.equal(sw.squareOf(a.e, a.n), '2634-1098', 'the Allalinhorn square, as swisstopo names it');
  const back = sw.lv95(...Object.values(sw.wgs84(2634500, 1098500)));
  assert.ok(Math.abs(back.e - 2634500) < 1 && Math.abs(back.n - 1098500) < 1);
});

test('STAC: the newest year of the square, its 2 m GeoTIFF', () => {
  const asset = (id, res) => [`${id}_${res}_2056_5728.tif`, { href: `https://data.geo.admin.ch/ch.swisstopo.swissalti3d/${id}/${id}_${res}_2056_5728.tif`, type: 'image/tiff' }];
  const f = (year, sq) => {
    const id = `swissalti3d_${year}_${sq}`;
    return { id, properties: { datetime: `${year}-01-01T00:00:00Z` }, assets: Object.fromEntries([asset(id, '0.5'), asset(id, '2'), [`${id}_2_2056_5728.xyz.zip`, { href: 'x.zip' }]]) };
  };
  const pick = sw.pickItem({ features: [f(2019, '2634-1098'), f(2024, '2634-1098'), f(2024, '2635-1098')] }, '2634-1098');
  assert.equal(pick.id, 'swissalti3d_2024_2634-1098');
  assert.match(pick.href, /_2_2056_5728\.tif$/);
  assert.equal(sw.pickItem({ features: [] }, '2634-1098'), null);
});

test('heights from swisstopo, files fetched once and kept', async () => {
  sw._resetSwiss();
  // The Allalinhorn square at 2 m: a plane rising east, falling north.
  const sq = '2634-1098', W = 500;
  const height = (e, n) => 3000 + (e - 2634000) * 0.5 - (n - 1098000) * 0.25;
  const file = writeTiff({ width: W, height: W, values: (x, y) => height(2634000 + (x + 0.5) * 2, 1099000 - (y + 0.5) * 2), tile: 128, scale: [2, 2, 0], tie: [0, 0, 0, 2634000, 1099000, 0] });
  const calls = { stac: 0, file: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/stac/')) {
      calls.stac++;
      const id = `swissalti3d_2024_${sq}`;
      return new Response(JSON.stringify({ features: [{ id, properties: { datetime: '2024-01-01T00:00:00Z' }, assets: { [`${id}_2_2056_5728.tif`]: { href: `https://data.geo.admin.ch/ch.swisstopo.swissalti3d/${id}/${id}_2_2056_5728.tif` } } }] }), { status: 200 });
    }
    if (u.endsWith('.tif')) { calls.file++; return new Response(file, { status: 200 }); }
    throw new Error(`unstubbed ${u}`);
  };
  try {
    const pts = [{ e: 2634250, n: 1098600 }, { e: 2634777.7, n: 1098123.4 }].map((p) => ({ ...sw.wgs84(p.e, p.n), want: height(p.e, p.n) }));
    const got = await sw.swissElevations(pts);
    pts.forEach((p, i) => assert.ok(Math.abs(got[i] - p.want) < 1.0, `${got[i]} vs ${p.want.toFixed(2)}`));
    await sw.swissElevations(pts);
    assert.deepEqual(calls, { stac: 1, file: 1 }, 'the square and its file are kept');
    // Outside Switzerland: no item, no height.
    globalThis.fetch = async (url) => (String(url).includes('/api/stac/') ? new Response(JSON.stringify({ features: [] }), { status: 200 }) : null);
    const [far] = await sw.swissElevations([{ lat: 61.0, lon: 8.5 }]);
    assert.equal(far, null);
    const d = await sw.describeSquare(pts[0].lat, pts[0].lon);
    assert.match(d.info, /tiles 128×128/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('two requests for the same new square at once: one lookup, one file, no clash on disk', async () => {
  sw._resetSwiss();
  const file = writeTiff({ width: 50, height: 50, values: () => 2800, scale: [20, 20, 0], tie: [0, 0, 0, 2635000, 1099000, 0] });
  const calls = { stac: 0, file: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    await new Promise((r) => setTimeout(r, 20));
    if (u.includes('/api/stac/')) {
      calls.stac++;
      const id = 'swissalti3d_2024_2635-1098';
      return new Response(JSON.stringify({ features: [{ id, properties: { datetime: '2024-01-01T00:00:00Z' }, assets: { [`${id}_2_2056_5728.tif`]: { href: `https://x/${id}_2_2056_5728.tif` } } }] }), { status: 200 });
    }
    calls.file++;
    return new Response(file, { status: 200 });
  };
  try {
    const p = [sw.wgs84(2635500, 1098500)];
    const [a, b, c] = await Promise.all([sw.swissElevations(p), sw.swissElevations(p), sw.swissElevations(p)]);
    assert.equal(a[0], 2800);
    assert.equal(b[0], 2800);
    assert.equal(c[0], 2800);
    assert.equal(calls.stac, 1);
    assert.equal(calls.file, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
