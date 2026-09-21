import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Contours, Kartverket elevation, Commons photos and the endpoints that
 * serve them, with every upstream stubbed in its documented shape.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-terrain-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { contours, contourInterval, smooth } = await import('../public/contours.js');
const { shapePhotos, commonsUrl, commonsSearchUrl, isCommonsThumb } = await import('../src/sources/photos.js');
const { shapeFlickr, flickrUrl, isFlickrThumb } = await import('../src/sources/flickr.js');
const { kartverketUrl, bestElevations } = await import('../src/sources/elevation.js');
const { gridBox, gridPoints } = await import('../src/terrain.js');
const { createServer } = await import('../src/server.js');

// ---- contours ---------------------------------------------------------

function cone(nx = 21, ny = 21, peak = 1000, base = 0) {
  const z = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const r = Math.hypot(i - (nx - 1) / 2, j - (ny - 1) / 2) / ((nx - 1) / 2);
      z.push(Math.max(base, peak - (peak - base) * r));
    }
  return { box: { north: 70, south: 69, west: 19, east: 20 }, nx, ny, z };
}

test('contour interval follows relief', () => {
  assert.deepEqual(contourInterval(0, 1500), { step: 100, index: 500 });
  assert.deepEqual(contourInterval(200, 900), { step: 50, index: 250 });
  assert.deepEqual(contourInterval(500, 800), { step: 25, index: 100 });
});

test('a cone gives closed rings at every level, index lines marked', () => {
  const c = contours(cone());
  // relief 1000 -> 50 m steps; 0 and 1000 are touched only at points
  const levels = c.map((l) => l.level);
  assert.ok(levels.includes(500) && levels.includes(250) && levels.includes(900), levels.join(','));
  const ring = c.find((l) => l.level === 500);
  assert.equal(ring.index, true);
  assert.equal(c.find((l) => l.level === 450).index, false);
  assert.equal(ring.lines.length, 1, 'one continuous line');
  const line = ring.lines[0];
  assert.deepEqual(line[0], line[line.length - 1], 'ring is closed');
  // Every point of the 500 m ring sits about halfway out from the peak.
  for (const p of line) {
    const r = Math.hypot((p.lat - 69.5) / 0.5, (p.lon - 19.5) / 0.5);
    assert.ok(Math.abs(r - 0.5) < 0.06, `r=${r}`);
  }
});

test('contours skip unknown cells and need data', () => {
  assert.deepEqual(contours({ box: { north: 1, south: 0, west: 0, east: 1 }, nx: 2, ny: 2, z: [null, null, 1, 2] }), []);
  const g = cone();
  g.z = g.z.map((v, k) => (k % 21 < 10 ? null : v)); // west half unknown
  const c = contours(g);
  assert.ok(c.length > 0);
  for (const l of c) for (const line of l.lines) for (const p of line) assert.ok(p.lon >= 19.45, 'no line in the unknown half');
});

test('smoothing keeps endpoints of open lines and closure of rings', () => {
  const open = smooth([[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(open[0], [0, 0]);
  assert.deepEqual(open[open.length - 1], [10, 10]);
  const ring = smooth([[0, 0], [10, 0], [10, 10], [0, 0]]);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

// ---- grid -------------------------------------------------------------

test('terrain grid is at least 3 km across and row-major from the NW corner', () => {
  const box = gridBox([], { lat: 69.65, lon: 20.02 });
  assert.ok((box.north - box.south) * 111 >= 3);
  const pts = gridPoints(box, 4, 3);
  assert.equal(pts.length, 12);
  assert.deepEqual(pts[0], { lat: box.north, lon: box.west });
  assert.deepEqual(pts[11], { lat: box.south, lon: box.east });
});

// ---- photos -----------------------------------------------------------

const summit = { lat: 69.6533, lon: 20.0252 };
const page = (title, lat, lon, extra = {}) => ({
  pageid: Math.floor(Math.random() * 1e6),
  title: `File:${title}`,
  coordinates: [{ lat, lon }],
  imageinfo: [
    {
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title)}/480px-x.jpg`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}`,
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ola">Ola &amp; Kari</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
        DateTimeOriginal: { value: '2019-04-12 10:31:02' },
      },
      ...extra,
    },
  ],
});
const commonsBody = {
  query: {
    pages: [
      page('Far_view_of_Lyngen.jpg', 69.68, 20.06),
      page('Rørnestinden_summit.jpg', 69.6534, 20.0254),
      page('Lyngen_hiking_map.jpg', 69.654, 20.03), // a map, not a photo
      page('Logo.svg', 69.654, 20.03),
      page('Unlicensed.jpg', 69.654, 20.03, { extmetadata: {} }),
      page('Elsewhere.jpg', 69.654, 20.03, { thumburl: 'https://evil.example/x.jpg' }),
      { pageid: 9, title: 'File:No_coords.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x.jpg' }] },
    ],
  },
};

// Found by name, with no coordinates of their own — the common case for
// smaller summits, which is why the name search exists.
const commonsNamedBody = {
  query: {
    pages: [
      { pageid: 21, title: 'File:Rørnestinden_in_March.jpg', imageinfo: page('x', 0, 0).imageinfo },
      { pageid: 22, title: 'File:Rørnestinden_ridge.jpg', imageinfo: page('y', 0, 0).imageinfo },
    ],
  },
};

const flickrBody = {
  stat: 'ok',
  photos: {
    photo: [
      { id: '5551', owner: '99@N01', ownername: 'A Skier', pathalias: 'askier', title: 'Skinning up',
        latitude: '69.6520', longitude: '20.0200', license: '4', datetaken: '2024-03-02 11:00:00',
        url_z: 'https://live.staticflickr.com/65535/5551_z.jpg' },
      { id: '5552', owner: '98@N01', ownername: 'B', title: 'All rights reserved one',
        latitude: '69.6521', longitude: '20.0201', license: '0', url_z: 'https://live.staticflickr.com/65535/5552_z.jpg' },
      { id: '5553', owner: '97@N01', ownername: 'C', title: 'No position', latitude: '0', longitude: '0',
        license: '4', url_z: 'https://live.staticflickr.com/65535/5553_z.jpg' },
      { id: '5554', owner: '96@N01', ownername: 'D', title: 'Elsewhere host', latitude: '69.65', longitude: '20.02',
        license: '5', url_z: 'https://evil.example/x.jpg' },
    ],
  },
};

test('Commons photos: filtered, credited, nearest first', () => {
  const p = shapePhotos(commonsBody, summit);
  assert.deepEqual(p.map((x) => x.title), ['Rørnestinden summit', 'Far view of Lyngen']);
  assert.equal(p[0].from, 'at the summit');
  assert.equal(p[0].author, 'Ola & Kari', 'HTML stripped from the credit');
  assert.equal(p[0].license, 'CC BY-SA 4.0');
  assert.equal(p[0].date, '2019-04-12');
  assert.match(p[1].from, /^3\.\d km NE of the summit$/);
  assert.match(p[0].pageUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
});

test('Commons photos: object-keyed pages (no formatversion=2) and empty answers', () => {
  const keyed = { query: { pages: Object.fromEntries(commonsBody.query.pages.map((p, i) => [String(i), p])) } };
  assert.equal(shapePhotos(keyed, summit).length, 2);
  assert.deepEqual(shapePhotos({ batchcomplete: true }, summit), []);
  assert.deepEqual(shapePhotos(null, summit), []);
});

test('Commons: photos found by name are kept, labelled and listed last', () => {
  const named = shapePhotos(commonsNamedBody, summit, { named: 'Rørnestinden' });
  assert.deepEqual(named.map((x) => x.title), ['Rørnestinden in March', 'Rørnestinden ridge']);
  assert.equal(named[0].from, 'named after Rørnestinden');
  assert.equal(named[0].lat, null, 'a named photo has no position, and no map marker');
  // Without `named`, a file with no coordinates is still refused.
  assert.deepEqual(shapePhotos(commonsNamedBody, summit), []);
  assert.match(commonsSearchUrl('Store Nup'), /generator=search/);
});

test('Flickr: only licences we can name, with a position and their own host', () => {
  const p = shapeFlickr(flickrBody, summit);
  assert.deepEqual(p.map((x) => x.title), ['Skinning up']);
  assert.equal(p[0].license, 'CC BY 2.0');
  assert.equal(p[0].author, 'A Skier');
  assert.equal(p[0].source, 'flickr');
  assert.equal(p[0].pageUrl, 'https://www.flickr.com/photos/askier/5551');
  assert.ok(p[0].distM < 1500);
  assert.ok(isFlickrThumb(p[0].thumbUrl));
  assert.equal(isFlickrThumb('https://evil.example/x.jpg'), false);
  assert.equal(isFlickrThumb('http://live.staticflickr.com/x.jpg'), false, 'https only');
  assert.match(flickrUrl(69.65, 20.02, { key: 'K', radiusKm: 5 }), /license=1%2C2%2C3%2C4%2C5%2C6%2C7%2C9%2C10/);
  assert.throws(() => shapeFlickr({}, summit), /unexpected response shape/);
});

test('Commons request and thumbnail host checks', () => {
  const u = new URL(commonsUrl(69.65, 20.02, 50000));
  assert.equal(u.searchParams.get('generator'), 'geosearch');
  assert.equal(u.searchParams.get('ggsradius'), '10000', 'capped at the API maximum');
  assert.equal(u.searchParams.get('ggsnamespace'), '6', 'files only');
  assert.ok(isCommonsThumb('https://upload.wikimedia.org/a.jpg'));
  assert.ok(!isCommonsThumb('http://upload.wikimedia.org/a.jpg'));
  assert.ok(!isCommonsThumb('https://upload.wikimedia.org.evil.example/a.jpg'));
  assert.ok(!isCommonsThumb('not a url'));
});

// ---- stubbed upstreams --------------------------------------------------

const calls = { kv: 0, kvPoints: [], om: 0, commons: 0, commonsByName: 0, flickr: 0, thumb: 0 };
const realFetch = globalThis.fetch;
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
let kvDown = false;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('ws.geonorge.no/hoydedata')) {
    calls.kv++;
    if (kvDown) return J({ error: 'down' }, 503);
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    calls.kvPoints.push(pts.length);
    // Documented shape; the sea (lat < 69.62) has no terrain -> null.
    return J({
      koordsys: 4258,
      punkter: pts.map(([x, y]) => ({ datakilde: 'dtm1', x, y, z: y < 69.62 ? null : Math.round((y - 69.6) * 20000) / 10 })),
    });
  }
  if (u.includes('/v1/elevation')) {
    calls.om++;
    const lats = new URL(u).searchParams.get('latitude').split(',');
    return J({ elevation: lats.map(() => 7) });
  }
  if (u.includes('commons.wikimedia.org/w/api.php')) {
    // Two ways in: by coordinates (geosearch) and by name (search).
    const gen = new URL(u).searchParams.get('generator');
    calls.commons++;
    if (gen === 'search') {
      calls.commonsByName++;
      return J(commonsNamedBody);
    }
    return J(commonsBody);
  }
  if (u.includes('api.flickr.com')) {
    calls.flickr++;
    return J(flickrBody);
  }
  if (/^https:\/\/live\.staticflickr\.com\//.test(u)) {
    calls.thumb++;
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (u.startsWith('https://upload.wikimedia.org/')) {
    calls.thumb++;
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (u.includes('overpass')) return J({ elements: [] });
  // The test's own server may be called; nothing else may leave the test.
  // An unstubbed upstream request would make the result depend on the live
  // internet: CI once reached Kartverket and profiled a synthetic route
  // against the real terrain of Lyngen.
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
  throw new Error(`unstubbed request in tests: ${u}`);
};
test.after(() => (globalThis.fetch = realFetch));

test('Kartverket: batches of 50, nulls filled from Copernicus', async () => {
  calls.kvPoints = [];
  const pts = Array.from({ length: 120 }, (_, k) => ({ lat: 69.61 + k * 0.0005, lon: 20 }));
  const om = calls.om;
  const { values, source } = await bestElevations(pts, 'NO');
  assert.deepEqual(calls.kvPoints, [50, 50, 20]);
  assert.equal(source, 'kartverket-dtm');
  assert.equal(values[0], 7, 'sea point filled from Open-Meteo');
  assert.ok(values[119] > 100);
  assert.equal(calls.om, om + 1);
  assert.match(decodeURIComponent(kartverketUrl([{ lat: 69.5, lon: 20.1 }])), /koordsys=4258.*punkter=\[\[20\.100000,69\.500000\]\]/);
  assert.doesNotMatch(kartverketUrl([{ lat: 69.5, lon: 20.1 }]), /[\[\],]/, 'sent percent-encoded');
});

test('Kartverket outage and Sweden both fall back to Copernicus', async () => {
  kvDown = true;
  const a = await bestElevations([{ lat: 69.7, lon: 20 }], 'NO');
  kvDown = false;
  assert.deepEqual(a, { values: [7], source: 'copernicus-glo90' });
  const kv = calls.kv;
  const b = await bestElevations([{ lat: 63.4, lon: 13.1 }], 'SE');
  assert.equal(b.source, 'copernicus-glo90');
  assert.equal(calls.kv, kv, 'Kartverket not asked about Sweden');
});

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('/api/terrain returns a cached DTM grid for a Norwegian tour', async () => {
  await withServer(async (base) => {
    const t = await (await fetch(`${base}/api/terrain?tour=rornestinden`)).json();
    assert.equal(t.nx * t.ny, t.z.length);
    assert.equal(t.source, 'kartverket-dtm');
    assert.ok(t.box.north > t.box.south && t.box.east > t.box.west);
    const n = calls.kv;
    await fetch(`${base}/api/terrain?tour=rornestinden`);
    assert.equal(calls.kv, n, 'second request from cache');
    assert.equal((await fetch(`${base}/api/terrain?tour=Matterhorn`)).status, 404);
  });
});

test('/api/photos hides upstream URLs; /api/photo proxies only listed thumbnails', async () => {
  await withServer(async (base) => {
    const p = await (await fetch(`${base}/api/photos?tour=rornestinden`)).json();
    // Two geotagged near the summit first, then two found by the summit's name.
    assert.equal(p.photos.length, 4);
    assert.deepEqual(p.photos.map((x) => x.lat != null), [true, true, false, false]);
    assert.equal(p.photos[2].from, 'named after Rørnestinden');
    assert.equal(p.photos[0].i, 0);
    assert.ok(!JSON.stringify(p).includes('upload.wikimedia.org'), 'no upstream thumbnail URL leaks');

    const img = await fetch(`${base}/api/photo?tour=rornestinden&i=0`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    const t = calls.thumb;
    await (await fetch(`${base}/api/photo?tour=rornestinden&i=0`)).arrayBuffer();
    assert.equal(calls.thumb, t, 'thumbnail cached');

    assert.equal((await fetch(`${base}/api/photo?tour=rornestinden&i=3`)).status, 200, 'a named photo has a thumbnail too');
    assert.equal((await fetch(`${base}/api/photo?tour=rornestinden&i=7`)).status, 404, 'no such photo');
    assert.notEqual((await fetch(`${base}/api/photo?tour=rornestinden&i=-1`)).status, 200);
    assert.notEqual((await fetch(`${base}/api/photo?tour=rornestinden&i=abc`)).status, 200);
    assert.notEqual((await fetch(`${base}/api/photo?tour=rornestinden&url=https://evil.example/`)).status, 200);
    assert.equal((await fetch(`${base}/api/photos?tour=Matterhorn`)).status, 404);
    // Geosearch first; the name search follows because two photos is thin.
    assert.equal(calls.commons, 2, 'Commons asked by coordinates and by name');
    assert.equal(calls.commonsByName, 1);
    assert.equal(calls.flickr, 0, 'Flickr is not asked without a key');
  });
});
