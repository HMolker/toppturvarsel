import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * v5.2: Lantmäteriet's 1 m terrain model, read from Cloud-Optimized
 * GeoTIFFs by HTTP range requests.
 *
 * The file is test/fixtures/lm-sample.tif, written by the system libtiff
 * (make-cog.py) packed like the real files: float32, DEFLATE, floating-point
 * predictor, tiled, with an overview. Here it is served as if it were a
 * Lantmäteriet file placed at Njulla (Abisko), with the STAC catalogue and
 * the download server stubbed in their real shapes.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-lm-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.LANTMATERIET_USER = 'fjallskred';
process.env.LANTMATERIET_PASSWORD = 'secret:with:colons';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const FIX = await readFile(new URL('./fixtures/lm-sample.tif', import.meta.url));
const lm = await import('../src/sources/lmcog.js');
const { bestElevations } = await import('../src/sources/elevation.js');
const { createServer } = await import('../src/server.js');
const { latLonToUTM } = await import('../src/util/utm.js');

// Place the 200 x 150 m fixture so that Njulla's summit is at pixel (100, 75).
const NJULLA = { lat: 68.36, lon: 18.7 };
const c = latLonToUTM(NJULLA.lat, NJULLA.lon, 33);
const X0 = Math.round(c.x) - 100, Y0 = Math.round(c.y) + 75;
const HREF = 'https://dl1.lantmateriet.se/hojd/data/grid/mhm/76_6/m768_68.tif';
// The fixture's heights, x and y in pixels from the NW corner (y down).
const h = (x, y) => 500 + 0.8 * x - 0.3 * y + 20 * Math.sin(x / 9);
// A point at pixel centre (x, y), as lat/lon: invert SWEREF 99 TM numerically.
function pixelToLatLon(x, y) {
  const e = X0 + x + 0.5, n = Y0 - y - 0.5;
  let lat = NJULLA.lat, lon = NJULLA.lon;
  for (let k = 0; k < 40; k++) {
    const p = latLonToUTM(lat, lon, 33, { round: false });
    lat += (n - p.y) / 111320;
    lon += (e - p.x) / (111320 * Math.cos((lat * Math.PI) / 180));
  }
  return { lat, lon };
}

/** Forget everything, including what is cached on disk. */
async function fresh() {
  lm._resetLm();
  await rm(path.join(tmp, 'cache', 'lm'), { recursive: true, force: true });
}

const calls = { stac: 0, ranges: [], auth: null, elevation: 0 };
let mode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.includes('api.lantmateriet.se/stac-hojd/v1/search')) {
    calls.stac++;
    assert.match(u, /collections=dtm-cog/);
    return new Response(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', id: '768_68', bbox: [18.6, 68.3, 18.8, 68.4],
        properties: { datetime: '2021-08-26T12:00:00Z', 'proj:code': 'EPSG:5845', 'proj:shape': [150, 200], 'proj:transform': [1, 0, X0, 0, -1, Y0, 0, 0, 1] },
        assets: { data: { href: HREF, type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/geo+json' } });
  }
  if (u === HREF) {
    const hd = opts.headers ?? {};
    calls.auth = hd.Authorization;
    if (mode === '401') return new Response('<html>401 Authorization Required</html>', { status: 401 });
    if (mode === '403') return new Response('<html>403 Forbidden</html>', { status: 403 });
    const [, a, b] = hd.Range.match(/bytes=(\d+)-(\d+)/);
    calls.ranges.push([+a, +b]);
    return new Response(FIX.subarray(+a, Math.min(FIX.length, +b + 1)), { status: 206 });
  }
  if (u.includes('/v1/elevation')) {
    calls.elevation++;
    const n = new URL(u).searchParams.get('latitude').split(',').length;
    return new Response(JSON.stringify({ elevation: Array(n).fill(111) }), { status: 200 });
  }
  return new Response('offline in tests', { status: 503 });
};

test('parseTiff reads every directory of the libtiff-written file', () => {
  const t = lm.parseTiff(FIX);
  assert.equal(t.le, true);
  assert.equal(t.ifds.length, 2);
  assert.deepEqual([t.ifds[0].width, t.ifds[0].height, t.ifds[0].tileW, t.ifds[0].compression, t.ifds[0].predictor], [200, 150, 64, 8, 3]);
  assert.equal(t.ifds[1].reduced, true);
  assert.equal(t.ifds[0].tilesAcross, 4);
  assert.equal(t.ifds[0].tilesDown, 3);
  assert.throws(() => lm.parseTiff(FIX.subarray(0, 8)), /need bytes/);
  assert.throws(() => lm.parseTiff(Buffer.from('not a tiff at all')), /not a TIFF/);
});

test('decodeTile undoes DEFLATE and the floating-point predictor exactly', () => {
  const t = lm.parseTiff(FIX);
  const d = t.ifds[0];
  let worst = 0;
  for (let k = 0; k < d.offsets.length; k++) {
    const tile = lm.decodeTile(FIX.subarray(d.offsets[k], d.offsets[k] + d.counts[k]), d, t.le);
    const tx = k % d.tilesAcross, ty = Math.floor(k / d.tilesAcross);
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      const x = tx * 64 + i, y = ty * 64 + j;
      if (x >= 200 || y >= 150 || (x === 0 && y === 0)) continue;
      worst = Math.max(worst, Math.abs(tile[j * 64 + i] - h(x, y)));
    }
    if (k === 0) assert.equal(tile[0], -9999);
  }
  assert.ok(worst < 1e-3, `worst error ${worst}`);
  const o = t.ifds[1];
  const ov = lm.decodeTile(FIX.subarray(o.offsets[0], o.offsets[0] + o.counts[0]), o, t.le);
  assert.ok(Math.abs(ov[3 * 64 + 5] - h(5 * 4 + 1.5, 3 * 4 + 1.5)) < 1e-3);
});

test('pickLevel takes the coarsest level fine enough', () => {
  const t = lm.parseTiff(FIX);
  assert.equal(lm.pickLevel(t, 1, 0.5), 0);
  assert.equal(lm.pickLevel(t, 1, 2), 0);
  assert.equal(lm.pickLevel(t, 1, 5), 1);
  assert.equal(lm.pickLevel(t, 1, 100), 1);
});

test('lmElevations: heights at points, with Basic auth, range requests and a disk cache', async () => {
  lm._resetLm();
  calls.ranges.length = 0;
  const pts = [[20, 10], [100, 75], [150, 120], [199, 149]].map(([x, y]) => pixelToLatLon(x, y));
  const z = await lm.lmElevations(pts, { spacingM: 1 });
  [[20, 10], [100, 75], [150, 120], [199, 149]].forEach(([x, y], i) => assert.ok(Math.abs(z[i] - h(x, y)) < 0.05, `point ${i}: ${z[i]} vs ${h(x, y)}`));
  assert.equal(calls.auth, `Basic ${Buffer.from('fjallskred:secret:with:colons').toString('base64')}`);
  assert.equal(calls.ranges[0][0], 0, 'the header first');
  assert.ok(calls.ranges.length <= 1 + 4, 'header plus only the tiles needed');
  // Everything is cached: a fresh process (memory cleared) reads the disk.
  lm._resetLm();
  const before = calls.ranges.length, stac = calls.stac;
  const again = await lm.lmElevations(pts, { spacingM: 1 });
  assert.deepEqual(again, z);
  assert.equal(calls.ranges.length, before, 'no new downloads');
  assert.equal(calls.stac, stac, 'no new catalogue lookups');
});

test('lmElevations: the nodata pixel is not a height, and a coarse spacing reads the overview', async () => {
  lm._resetLm();
  const [zc] = await lm.lmElevations([pixelToLatLon(0, 0)], { spacingM: 1 });
  assert.ok(Math.abs(zc - h(1, 0)) < 2 || Math.abs(zc - h(0, 1)) < 2, `corner: ${zc}`);
  lm._resetLm();
  calls.ranges.length = 0;
  const p = pixelToLatLon(100, 75);
  const [zo] = await lm.lmElevations([p], { spacingM: 20 });
  assert.ok(Math.abs(zo - h(100, 75)) < 3, `overview height ${zo}`);
  const t = lm.parseTiff(FIX);
  const ovTile = t.ifds[1].offsets[0];
  assert.ok(calls.ranges.some(([a]) => a === ovTile), 'read from the overview');
});

test('bestElevations uses Lantmäteriet in Sweden, and Copernicus outside its data', async () => {
  lm._resetLm();
  const inside = pixelToLatLon(50, 50);
  const res = await bestElevations([inside, inside], 'SE', { spacingM: 1 });
  assert.equal(res.source, 'lantmateriet-mhm');
  assert.ok(Math.abs(res.values[0] - h(50, 50)) < 0.05);
  const far = { lat: 68.2, lon: 18.2 }; // no file there in the stub
  const mix = await bestElevations([inside, far], 'SE', { spacingM: 1 });
  assert.equal(mix.values[1], 111, 'filled by Copernicus');
  assert.equal(res.charged, 0, 'Lantmäteriet costs no point budget');
  assert.equal(mix.charged, 1, 'only the Copernicus point is charged');
});

test('Swedish ground near the border is read from Lantmäteriet even when the nearest tour is Norwegian (v5.5.1)', async () => {
  lm._resetLm();
  const inside = pixelToLatLon(50, 50);
  const no = await bestElevations([inside], 'NO', { spacingM: 1 });
  assert.equal(no.source, 'lantmateriet-mhm');
  assert.equal(no.charged, 0);
  await assert.rejects(bestElevations([inside, { lat: 68.2, lon: 18.2 }], 'SE', { spacingM: 1, maxCharged: 0 }), (e) => e.status === 429);
});

test('a refused login falls back to Copernicus and says why', async () => {
  lm._resetLm();
  const el = await import('../src/sources/elevation.js');
  for (const m of ['401', '403']) {
    mode = m;
    await fresh();
    const res = await bestElevations([pixelToLatLon(60, 60)], 'SE', { spacingM: 1 });
    assert.equal(res.source, 'copernicus-glo90');
    assert.match(el.lmLastError, m === '401' ? /refused the login/ : /no access/);
  }
  mode = 'ok';
});

test('the daily download cap stops file reads with a clear error', async () => {
  await fresh();
  const saved = process.env.LANTMATERIET_DAILY_MB;
  process.env.LANTMATERIET_DAILY_MB = '0';
  try {
    await assert.rejects(lm.lmElevations([pixelToLatLon(10, 10)], { spacingM: 1 }), /daily Lantmäteriet download cap/);
  } finally {
    process.env.LANTMATERIET_DAILY_MB = saved ?? '';
    delete process.env.LANTMATERIET_DAILY_MB;
    lm._resetLm();
  }
});

test('route profile in Sweden: a 10 m cross on the 1 m model, and the zone reports it', async () => {
  lm._resetLm();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = pixelToLatLon(40, 40), b = pixelToLatLon(160, 110);
    const res = await fetch(`${base}/api/terrain/profile`, { method: 'POST', body: JSON.stringify({ points: [[a.lat, a.lon], [b.lat, b.lon]] }) });
    assert.equal(res.status, 200);
    const p = await res.json();
    assert.equal(p.country, 'SE');
    assert.equal(p.crossM, 10);
    assert.equal(p.source, 'lantmateriet-mhm');
    // The fixture's slope at a sample: gradient of h in metres (1 px = 1 m).
    const s = p.samples[2];
    const { x: e, y: n } = latLonToUTM(s.lat, s.lon, 33, { round: false });
    const px = e - X0 - 0.5, py = Y0 - n - 0.5;
    // The server's own method: central differences over a ±10 m cross.
    const gx = (h(px + 10, py) - h(px - 10, py)) / 20, gy = (h(px, py - 10) - h(px, py + 10)) / 20;
    const want = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    assert.ok(Math.abs(s.slope - want) < 2.5, `slope ${s.slope} vs ${want.toFixed(1)}`);
    assert.ok(Math.abs(s.ele - h(px, py)) < 1, `height ${s.ele} vs ${h(px, py).toFixed(1)}`);
    const zone = await (await fetch(`${base}/api/terrain/zone`)).json();
    assert.deepEqual(zone.fine, ['SE']);
    assert.equal(zone.lantmateriet.enabled, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('without a login, Sweden stays on Copernicus and nothing is sent to Lantmäteriet', async () => {
  const u = process.env.LANTMATERIET_USER;
  delete process.env.LANTMATERIET_USER;
  lm._resetLm();
  const before = calls.ranges.length;
  try {
    assert.equal(lm.lmEnabled(), false);
    const res = await bestElevations([pixelToLatLon(50, 50)], 'SE', {});
    assert.equal(res.source, 'copernicus-glo90');
    assert.equal(calls.ranges.length, before);
  } finally {
    process.env.LANTMATERIET_USER = u;
  }
});
