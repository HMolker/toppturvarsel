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

// v6.2: Austria likewise, one resort and one lift.
const overpassAustrian = {
  elements: [
    { type: 'way', id: 30, center: { lat: 47.45, lon: 12.39 }, bounds: bb(47.45, 12.39, 0.05), tags: { landuse: 'winter_sports', name: 'Kitzbühel', website: 'https://www.kitzbuehel.com' } },
    { type: 'way', id: 31, center: { lat: 47.44, lon: 12.38 }, tags: { aerialway: 'gondola' } },
  ],
};

// v6.3.1: one resort each for South Tyrol/Trentino, the Spanish Pyrenees and Andorra.
const one = (id, lat, lon, name) => ({ elements: [{ type: 'way', id, center: { lat, lon }, bounds: bb(lat, lon, 0.05), tags: { landuse: 'winter_sports', name } }] });
const overpassItalian = one(40, 46.74, 11.95, 'Kronplatz');
const overpassSpanish = one(41, 42.7, 0.94, 'Baqueira-Beret');
const overpassAndorran = one(42, 42.56, 1.67, 'Grandvalira');

const overpassSwiss = {
  elements: [
    { type: 'way', id: 20, center: { lat: 46.02, lon: 7.75 }, bounds: bb(46.02, 7.75, 0.05), tags: { landuse: 'winter_sports', name: 'Zermatt – Matterhorn', website: 'https://www.matterhornparadise.ch' } },
    { type: 'way', id: 21, center: { lat: 46.01, lon: 7.74 }, tags: { aerialway: 'gondola' } },
    { type: 'way', id: 22, center: { lat: 46.0, lon: 7.73 }, tags: { aerialway: 'chair_lift' } },
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

test('OSM queries: Italy is South Tyrol and Trentino, Spain its Pyrenean provinces, not whole countries (v6.3.1)', () => {
  const it = resortsQuery('IT');
  assert.match(it, /"ISO3166-2"="IT-32"/);
  assert.doesNotMatch(it, /"ISO3166-1"="IT"/);
  const es = resortsQuery('ES');
  assert.match(es, /ES-\(CT\|AR\|NC\)/);
  assert.match(es, /\(area\.c\)\(41\.9,-2\.2,43\.6,3\.4\)/, 'south of the Pyrenees is cut off');
  assert.match(resortsQuery('AD'), /"ISO3166-1"="AD"/);
  assert.match(resortsQuery('CH'), /\(area\.c\);/);
});

// ---- endpoint ----------------------------------------------------------

const calls = { fnugg: 0, overpass: 0 };
let fnuggDown = false;
let overpassSlowMs = 0;
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
    if (overpassSlowMs) await new Promise((r) => setTimeout(r, overpassSlowMs));
    assert.equal(opts.method, 'POST');
    // v6: the Swiss query gets a Swiss answer (one resort, two lifts).
    if (decodeURIComponent(String(opts.body)).includes('"CH"')) return J(overpassSwiss);
    if (decodeURIComponent(String(opts.body)).includes('"AT"')) return J(overpassAustrian);
    if (decodeURIComponent(String(opts.body)).includes('IT-32')) return J(overpassItalian);
    if (decodeURIComponent(String(opts.body)).includes('ES-(CT')) return J(overpassSpanish);
    if (decodeURIComponent(String(opts.body)).includes('"AD"')) return J(overpassAndorran);
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

process.env.RESORTS_SE_MIN = '1'; // the stub has two Swedish resorts
process.env.RESORTS_CH_MIN = '1'; // and one Swiss
process.env.RESORTS_AT_MIN = '1'; // and one Austrian
process.env.RESORTS_IT_MIN = '1';
process.env.RESORTS_ES_MIN = '1';
process.env.RESORTS_AD_MIN = '1';

test('/api/resorts merges both countries, caches, and survives an outage', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/resorts`)).json();
    assert.equal(r.resorts.length, 10);
    assert.equal(r.sources.no.name, 'Fnugg');
    assert.equal(r.sources.se.count, 2);
    assert.equal(r.sources.ch.count, 1);
    assert.equal(r.sources.at.count, 1);
    for (const [k, c, n] of [['it', 'IT', 'Kronplatz'], ['es', 'ES', 'Baqueira-Beret'], ['ad', 'AD', 'Grandvalira']]) {
      assert.equal(r.sources[k].count, 1, k);
      assert.equal(r.resorts.find((x) => x.country === c)?.name, n, `${c} resort`);
    }
    const zermatt = r.resorts.find((x) => x.country === 'CH');
    assert.equal(zermatt.mappedLifts, 2);
    assert.equal(zermatt.live, false);
    assert.equal(calls.fnugg, 1);
    await fetch(`${base}/api/resorts`);
    assert.equal(calls.fnugg, 1, 'served from cache');
    assert.equal(calls.overpass, 6, 'one query each for Sweden, Switzerland, Austria, South Tyrol and Trentino, the Spanish Pyrenees and Andorra');
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

test('an empty or near-empty Swedish answer is not kept as the list (v5.5.3)', async () => {
  const { _resetResorts } = await import('../src/resorts.js');
  _resetResorts();
  process.env.RESORTS_SE_MIN = '3'; // the stub's two now count as a broken answer
  try {
    await withServer(async (base) => {
      const r = await (await fetch(`${base}/api/resorts`)).json();
      assert.match(r.sources.se.error, /only 2 resorts/);
      assert.ok(r.resorts.filter((x) => x.country === 'SE').length > 20, 'the built-in list instead');
    });
  } finally {
    process.env.RESORTS_SE_MIN = '1';
    _resetResorts();
  }
});

test('a slow OpenStreetMap answer does not hold up the page: the built-in list meanwhile (v5.6.1)', async () => {
  const { _resetResorts, getResorts } = await import('../src/resorts.js');
  const { rm } = await import('node:fs/promises');
  await rm(path.join(tmp, 'cache', 'resorts', 'se.json'), { force: true });
  _resetResorts();
  process.env.RESORTS_GRACE_MS = '100';
  overpassSlowMs = 1500;
  try {
    const t0 = Date.now();
    const r = await getResorts();
    assert.ok(Date.now() - t0 < 1200, `answered in ${Date.now() - t0} ms`);
    assert.equal(r.sources.se.refreshing, true);
    assert.ok(r.resorts.filter((x) => x.country === 'SE').length > 20, 'the built-in list meanwhile');
    await new Promise((res) => setTimeout(res, 1700));
    const later = await getResorts();
    assert.equal(later.sources.se.stale, false, 'the fetched list once it has come');
  } finally {
    overpassSlowMs = 0;
    delete process.env.RESORTS_GRACE_MS;
    _resetResorts();
  }
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
  assert.doesNotMatch(svg, /<a /, 'names open the resort panel; the website link lives there');
  assert.match(svg, /data-resort="Big"/);
  assert.match(svg, /data-resort="Neighbour" x=/, 'dots are clickable too');
  assert.match(svg, /class="resortname">Edge</);
  assert.match(tooltip(pts[0].r), /lifts 2\/20 open · slopes 1\/2 open · Fnugg/);
});

test('names are escaped in the SVG', () => {
  const p = { r: { id: 'x', name: '<script>', url: 'https://a.no/?a=1&b="2"', lifts: null, slopes: null, live: false, source: 'osm' }, x: 100, y: 100 };
  const svg = resortSvg(layoutResorts([p], { detail: true, width: 560, height: 760 }));
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test('with OpenStreetMap down, every country still shows its resorts from the built-in list (v6.3.1)', async () => {
  const { _resetResorts, getResorts } = await import('../src/resorts.js');
  const { rm, readdir } = await import('node:fs/promises');
  for (const f of await readdir(path.join(tmp, 'cache', 'resorts'))) await rm(path.join(tmp, 'cache', 'resorts', f), { force: true });
  _resetResorts();
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('overpass')) throw new Error('simulated Overpass outage');
    return keep(url, opts);
  };
  try {
    const r = await getResorts();
    for (const c of ['CH', 'AT', 'IT', 'ES', 'AD']) {
      const list = r.resorts.filter((x) => x.country === c);
      assert.ok(list.length >= 4, `${c}: ${list.length} resorts from the built-in list`);
      assert.ok(list.every((x) => x.approx === true && x.source === 'seed' && Number.isFinite(x.lat) && Number.isFinite(x.lon)), `${c}: marked approximate`);
    }
    assert.ok(r.resorts.some((x) => x.name === 'Zermatt'));
    assert.ok(r.resorts.some((x) => x.name === 'Grandvalira'));
    assert.match(r.sources.ch.error, /Overpass|outage/);
  } finally {
    globalThis.fetch = keep;
    _resetResorts();
  }
});

test('the built-in resorts lie where they should', async () => {
  const { readFile } = await import('node:fs/promises');
  const seed = JSON.parse(await readFile(new URL('../data/resorts-seed.json', import.meta.url), 'utf8'));
  const box = { CH: [45.8, 47.9, 5.9, 10.6], AT: [46.3, 48.0, 9.5, 17.2], IT: [45.65, 47.1, 10.3, 12.5], ES: [41.9, 43.4, -2.2, 3.4], AD: [42.4, 42.7, 1.4, 1.8] };
  for (const [c, list] of Object.entries(seed)) {
    if (c.startsWith('_')) continue;
    const names = new Set();
    for (const r of list) {
      assert.ok(!names.has(r.name), `${c}: duplicate ${r.name}`);
      names.add(r.name);
      const b = box[c];
      assert.ok(r.lat > b[0] && r.lat < b[1] && r.lon > b[2] && r.lon < b[3], `${c} ${r.name}: outside the country`);
    }
  }
});
