import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * SLF's micro-region outlines (v6.1): any Swiss point finds its own
 * bulletin. The outline file is stubbed in the shape checked on 1 Oct 2026
 * (FeatureCollection, properties.id "CH-4222", MultiPolygon); the bulletin
 * is SLF's own from 15 Feb 2026.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-micro-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { parseRegions, regionIn, swissMicroRegionAt, _resetEaws } = await import('../src/sources/eawsregions.js');
const { shapeSwissAll } = await import('../src/sources/slf.js');
const bulletins = JSON.parse(await readFile(new URL('./fixtures/slf-bulletins.json', import.meta.url), 'utf8'));

const box = (id, w, s, e, n, hole = null) => ({
  type: 'Feature',
  properties: { id },
  geometry: { type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]], ...(hole ? [hole] : [])]] },
});
// Zermatt west of 7.8, Saas Fee east of it; a hole in Saas Fee belongs to nobody.
const outlines = {
  type: 'FeatureCollection',
  features: [
    box('CH-4222', 7.6, 45.9, 7.8, 46.1),
    box('CH-4223', 7.8, 45.9, 8.0, 46.2, [[7.95, 46.15], [7.98, 46.15], [7.98, 46.18], [7.95, 46.18], [7.95, 46.15]]),
  ],
};

test('outlines: a point finds its micro-region; holes and the outside find none', () => {
  const regions = parseRegions(outlines);
  assert.equal(regions.length, 2);
  assert.equal(regionIn(regions, 45.94, 7.75), 'CH-4222');
  assert.equal(regionIn(regions, 46.05, 7.89), 'CH-4223');
  assert.equal(regionIn(regions, 46.16, 7.96), null, 'inside the hole');
  assert.equal(regionIn(regions, 47.5, 9.0), null);
  assert.throws(() => parseRegions({ type: 'Feature' }), /FeatureCollection/);
});

test('every bulletin once, and which micro-region reads which', () => {
  const all = shapeSwissAll(bulletins);
  assert.equal(all.bulletins.length, 2);
  assert.equal(all.byMicro['CH-4222'], 0);
  assert.equal(all.byMicro['CH-5123'], 1);
  assert.equal(all.names['CH-4222'], 'Zermatt');
  assert.equal(all.bulletins[all.byMicro['CH-4124']].danger, 3, "Val d'Anniviers has no listed tour, but has its bulletin");
});

test('/api/region: the micro-region at a point with its bulletin; downloaded once, kept', async () => {
  _resetEaws();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (/^https?:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, opts);
    if (u.includes('regions.avalanches.org')) { calls++; return new Response(JSON.stringify(outlines), { status: 200 }); }
    return new Response('offline', { status: 503 });
  };
  try {
    const all = shapeSwissAll(bulletins);
    await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), status: 'ok', regions: [], tours: [], swiss: all }));
    const { createServer } = await import('../src/server.js');
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let r = await (await realFetch(`${base}/api/region?lat=46.05&lon=7.89`)).json();
      assert.equal(r.microRegion, 'CH-4223');
      assert.equal(r.name, 'Saas Fee');
      assert.equal(r.bulletin.danger, 3);
      assert.match(r.bulletinUrl, /slf\.ch/);
      r = await realFetch(`${base}/api/region?lat=61&lon=8.5`);
      assert.equal(r.status, 404);
      assert.equal((await realFetch(`${base}/api/region?lat=x`)).status, 400);
      assert.equal(await swissMicroRegionAt(45.94, 7.75), 'CH-4222');
      assert.equal(calls, 1, 'the outlines are downloaded once');
    } finally {
      server.close();
    }
    // After a restart, the stored copy is used.
    _resetEaws();
    assert.equal(await swissMicroRegionAt(45.94, 7.75), 'CH-4222');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
