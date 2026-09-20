import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Resort layer: Fnugg (verified response shape) and OpenStreetMap
 * (Overpass `out tags center bb`) shaping, and the endpoint end to end.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-resorts-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { shapeFnugg } = await import('../src/sources/fnugg.js');
const { shapeOsmResorts, resortsQuery } = await import('../src/sources/osm-resorts.js');
const { createServer } = await import('../src/server.js');

const hit = (id, src) => ({ _index: 'fnugg_resort', _type: 'resort', _id: String(id), found: true, _source: { id, ...src } });
const fnuggBody = {
  took: 1,
  timed_out: false,
  hits: {
    total: 4,
    hits: [
      hit(1, {
        name: 'Hemsedal', site_path: '/hemsedal/', location: { lat: 60.8604, lon: 8.4988 },
        urls: { homepage: 'https://www.skistar.com/hemsedal' }, resort_open: true,
        lifts: { list: [], open: 12, count: 20, closed: 8 }, slopes: { list: [], open: 30, count: 51, closed: 21 },
      }),
      hit(2, {
        name: 'Nesfjellet Bike Park', site_path: '/nesfjelletsommer/', location: { lat: 60.53, lon: 9.02 },
        urls: { homepage: 'https://nesfjellet.no/nb' }, resort_open: true,
        lifts: { open: 1, count: 1 }, slopes: { open: 3, count: 6 },
      }),
      hit(3, {
        name: 'Stranda', location: { lat: 62.3, lon: 6.95 }, urls: { homepage: 'javascript:alert(1)' },
        resort_open: false, lifts: { open: 4, count: 7 }, slopes: { open: 0, count: 0 },
      }),
      hit(5, {
        name: 'Dombås Skiheiser', location: { lat: 62.08, lon: 9.14 },
        urls: { homepage: 'http://www.trolltun.no/    http://www.dombasskiheiser.no/' }, lifts: { open: 2, count: 2 },
      }),
      hit(4, { name: 'No location', urls: {}, lifts: { open: 1, count: 1 } }),
    ],
  },
};

test('Fnugg: shapes live counts, drops summer venues and bad links', () => {
  const r = shapeFnugg(fnuggBody);
  assert.deepEqual(r.map((x) => x.name), ['Hemsedal', 'Stranda', 'Dombås Skiheiser']);
  assert.equal(r[2].url, 'http://www.trolltun.no/', 'first of two space-separated links');
  const [h, s] = r;
  assert.deepEqual(h.lifts, { open: 12, count: 20 });
  assert.deepEqual(h.slopes, { open: 30, count: 51 });
  assert.equal(h.url, 'https://www.skistar.com/hemsedal');
  assert.equal(h.live, true);
  assert.equal(s.url, null, 'only http(s) links are kept');
  assert.deepEqual(s.lifts, { open: 0, count: 7 }, 'a resort flagged closed shows nothing open');
  assert.equal(s.slopes, null, 'no slopes reported: unknown, not 0 %');
  assert.throws(() => shapeFnugg({ error: 'x' }), /unexpected/);
});

const bb = (lat, lon, d) => ({ minlat: lat - d, minlon: lon - d * 2, maxlat: lat + d, maxlon: lon + d * 2 });
const overpassBody = {
  elements: [
    { type: 'way', id: 1, center: { lat: 61.155, lon: 12.99 }, bounds: bb(61.155, 12.99, 0.01), tags: { landuse: 'winter_sports', name: 'Lindvallen', website: 'www.skistar.com/salen' } },
    { type: 'relation', id: 2, center: { lat: 61.156, lon: 12.991 }, bounds: bb(61.156, 12.991, 0.004), tags: { site: 'piste', name: 'Lindvallen' } },
    { type: 'way', id: 3, center: { lat: 63.40, lon: 13.08 }, bounds: bb(63.4, 13.08, 0.02), tags: { landuse: 'winter_sports', name: 'Åre' } },
    { type: 'way', id: 4, center: { lat: 59.3, lon: 18.0 }, bounds: bb(59.3, 18.0, 0.0003), tags: { landuse: 'winter_sports', name: 'Pulkabacken' } },
    { type: 'way', id: 10, center: { lat: 61.156, lon: 12.995 }, tags: { aerialway: 'chair_lift' } },
    { type: 'way', id: 11, center: { lat: 61.15, lon: 12.98 }, tags: { aerialway: 't-bar' } },
    { type: 'way', id: 12, center: { lat: 63.41, lon: 13.07 }, tags: { aerialway: 'gondola' } },
  ],
};

test('OSM: Swedish resorts with website and mapped lifts, no live status', () => {
  const r = shapeOsmResorts(overpassBody, 'SE');
  assert.deepEqual(r.map((x) => x.name).sort(), ['Lindvallen', 'Åre']);
  const l = r.find((x) => x.name === 'Lindvallen');
  assert.equal(l.url, 'https://www.skistar.com/salen', 'scheme added to bare hostnames');
  assert.equal(l.mappedLifts, 2, 'duplicate mapping merged, lifts kept');
  assert.equal(l.live, false);
  assert.equal(l.lifts, null, 'no status is not the same as closed');
  assert.equal(r.find((x) => x.name === 'Åre').url, null);
  assert.match(resortsQuery('SE'), /ISO3166-1"="SE"/);
  assert.match(resortsQuery('SE'), /out tags center bb/);
});

// ---- endpoint ----------------------------------------------------------

const calls = { fnugg: 0, overpass: 0 };
let fnuggDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.fnugg.no')) {
    calls.fnugg++;
    return fnuggDown ? J({ error: 'down' }, 503) : J(fnuggBody);
  }
  if (u.includes('overpass')) {
    calls.overpass++;
    assert.equal(opts.method, 'POST');
    return J(overpassBody);
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

test('/api/resorts merges both countries, caches, and survives an outage', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/resorts`)).json();
    assert.equal(r.resorts.length, 5);
    assert.equal(r.sources.no.name, 'Fnugg');
    assert.equal(r.sources.se.count, 2);
    assert.equal(calls.fnugg, 1);
    await fetch(`${base}/api/resorts`);
    assert.equal(calls.fnugg, 1, 'served from cache');
    assert.equal(calls.overpass, 1);
  });

  // Expire the Norwegian cache, then take Fnugg down: last good list stays.
  const { writeFile, readFile } = await import('node:fs/promises');
  const f = path.join(tmp, 'cache', 'resorts', 'no.json');
  const c = JSON.parse(await readFile(f, 'utf8'));
  c.fetchedAt = new Date(Date.now() - 40 * 86400e3).toISOString();
  await writeFile(f, JSON.stringify(c));
  fnuggDown = true;
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/resorts`)).json();
    assert.equal(r.sources.no.stale, true);
    assert.match(r.sources.no.error, /503/);
    assert.equal(r.resorts.filter((x) => x.country === 'NO').length, 3, 'stale list still served');
  });
});

// ---- map layer (pure) ----------------------------------------------------

const { shade, layoutResorts, resortSvg, tooltip } = await import('../public/resorts.js');

test('open share shading: closed, bands, and unknown kept apart', () => {
  assert.equal(shade({ open: 0, count: 5 }).closed, true);
  assert.equal(shade({ open: 5, count: 5 }).bg, 'var(--ro4)');
  assert.equal(shade({ open: 1, count: 5 }).bg, 'var(--ro1)');
  const u = shade(null);
  assert.equal(u.unknown, true);
  assert.equal(u.closed, false, 'no status is never shown as closed');
});

test('layout: dots zoomed out; badges, names and fallbacks zoomed in', () => {
  const r = (name, x, y, lifts = 5, url = 'https://x.no/') => ({ r: { id: name, name, url, lifts: { open: 2, count: lifts }, slopes: { open: 1, count: 2 }, live: true, source: 'fnugg' }, x, y });
  const pts = [r('Big', 200, 200, 20), r('Neighbour', 205, 205, 3), r('Far', 400, 500), r('Edge', 552, 300, 4, null), r('Gone', 900, 900)];
  const out = layoutResorts(pts, { detail: false, width: 560, height: 760 });
  assert.equal(out.dots.length, 4, 'off-map resort skipped');
  const d = layoutResorts(pts, { detail: true, width: 560, height: 760, blocked: [[0, 0, 46, 116]] });
  assert.deepEqual(d.badges.map((b) => b.r.name).sort(), ['Big', 'Edge', 'Far']);
  assert.deepEqual(d.dots.map((b) => b.r.name), ['Neighbour'], 'overlapping smaller resort falls back to a dot');
  const edge = d.badges.find((b) => b.r.name === 'Edge');
  assert.ok(edge.named && edge.nameDx < 0, 'name near the edge slides inward');
  const svg = resortSvg(d);
  assert.match(svg, /<a href="https:\/\/x\.no\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(svg, /class="resortname nolink">Edge</, 'no link without a homepage');
  assert.match(tooltip(pts[0].r), /lifts 2\/20 open · slopes 1\/2 open · Fnugg/);
});

test('names are escaped in the SVG', () => {
  const p = { r: { id: 'x', name: '<script>', url: 'https://a.no/?a=1&b="2"', lifts: null, slopes: null, live: false, source: 'osm' }, x: 100, y: 100 };
  const svg = resortSvg(layoutResorts([p], { detail: true, width: 560, height: 760 }));
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&amp;b=&quot;2&quot;/);
});
