import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * v5 terrain page: the DEM tile and route-profile endpoints through the real
 * server (elevation services stubbed with a tilted plane of known slope and
 * aspect), the NVE tile proxy, and the page's pure modules.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-terrain-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.TERRAIN_DAILY_POINTS = '20000';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { createServer } = await import('../src/server.js');
const dem = await import('../src/dem.js');

// Rørnestinden (Lyngen) is a listed tour, so the ground around it is inside
// the service area. The stubbed terrain is a plane rising to the north at
// 30°: every slope there faces south.
const TOUR = { lat: 69.6533, lon: 20.0252 };
const TAN30 = Math.tan((30 * Math.PI) / 180);
const plane = (lat) => 500 + (lat - TOUR.lat) * 111320 * TAN30;

const calls = { kartverket: 0, points: 0, nve: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('hoydedata')) {
    calls.kartverket++;
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    calls.points += pts.length;
    return J({ koordsys: 4258, punkter: pts.map(([lon, lat]) => ({ datakilde: 'dtm1', x: lon, y: lat, z: plane(lat) })) });
  }
  if (u.includes('/v1/elevation')) {
    const q = new URL(u).searchParams;
    return J({ elevation: q.get('latitude').split(',').map((la) => plane(Number(la))) });
  }
  if (u.includes('gis3.nve.no')) {
    calls.nve++;
    // One tile has a drawing, the rest are empty (404), as NVE answers.
    if (u.endsWith('/14/3561/8959') === false && u.includes('/tile/14/')) return new Response('not found', { status: 404 });
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  // Anything else (resort lists, …) is unavailable in tests.
  return new Response('offline in tests', { status: 503 });
};

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const tileOf = (lat, lon, z) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
};

test('GET /api/dem returns a 17 × 17 grid over the tile, cached on disk', async () => {
  const [x, y] = tileOf(TOUR.lat, TOUR.lon, 14);
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/dem/14/${x}/${y}`);
    assert.equal(res.status, 200);
    const t = await res.json();
    assert.equal(t.n, 17);
    assert.equal(t.ele.length, 289);
    assert.equal(t.source, 'kartverket-dtm');
    assert.equal(t.country, 'NO');
    // Row 0 is the north edge: higher than the south edge on a north-rising plane.
    assert.ok(t.ele[0] > t.ele[16 * 17], 'north row higher');
    const before = calls.kartverket;
    const again = await (await fetch(`${base}/api/dem/14/${x}/${y}`)).json();
    assert.deepEqual(again.ele, t.ele);
    assert.equal(calls.kartverket, before, 'second request served from the cache');
    await stat(path.join(tmp, 'cache', 'dem', '14', String(x), `${y}.json`));
  });
});

test('DEM tiles outside the service area or zoom range are refused without asking upstream', async () => {
  await withServer(async (base) => {
    const before = calls.kartverket;
    const [x, y] = tileOf(48.85, 2.35, 14); // Paris
    assert.equal((await fetch(`${base}/api/dem/14/${x}/${y}`)).status, 403);
    const [a, b] = tileOf(TOUR.lat, TOUR.lon, 9);
    assert.equal((await fetch(`${base}/api/dem/9/${a}/${b}`)).status, 400);
    assert.equal(calls.kartverket, before);
  });
});

test('POST /api/terrain/profile measures the slope and aspect of the ground under the route', async () => {
  // A traverse along the contour: the route itself is flat, the ground is 30°.
  const pts = [[TOUR.lat - 0.01, TOUR.lon - 0.02], [TOUR.lat - 0.01, TOUR.lon + 0.01]];
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/terrain/profile`, { method: 'POST', body: JSON.stringify({ points: pts }) });
    assert.equal(res.status, 200);
    const p = await res.json();
    assert.equal(p.country, 'NO');
    assert.equal(p.spacingM, 25);
    assert.ok(p.samples.length > 40);
    for (const s of p.samples) {
      assert.ok(Math.abs(s.slope - 30) < 0.5, `slope ${s.slope}`);
      assert.ok(Math.abs(s.aspect - 180) < 1, `aspect ${s.aspect}`);
    }
    // Along the contour: the height barely changes.
    const e = p.samples.map((s) => s.ele);
    assert.ok(Math.max(...e) - Math.min(...e) <= 2);
    assert.equal(p.samples[0].v, 0);
    assert.equal(p.samples.at(-1).v, 1);
  });
});

test('route profile: moving one vertex re-asks only for the samples it changed', async () => {
  const a = [[TOUR.lat - 0.02, TOUR.lon], [TOUR.lat - 0.01, TOUR.lon + 0.005], [TOUR.lat, TOUR.lon]];
  const b = [a[0], a[1], [TOUR.lat + 0.001, TOUR.lon]];
  await withServer(async (base) => {
    const post = (points) => fetch(`${base}/api/terrain/profile`, { method: 'POST', body: JSON.stringify({ points }) }).then((r) => r.json());
    await post(a);
    const before = calls.points;
    const p = await post(b);
    const asked = calls.points - before;
    assert.ok(asked > 0 && asked < p.samples.length * 5 * 0.7, `asked for ${asked} of ${p.samples.length * 5} points`);
  });
});

test('route profile: refuses bad input, other methods and routes outside the area', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/terrain/profile`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/terrain/profile`)).status, 405);
    assert.equal((await post({ points: [[TOUR.lat, TOUR.lon]] })).status, 400);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post({ points: [[TOUR.lat, TOUR.lon], ['x', 1]] })).status, 400);
    assert.equal((await post({ points: Array.from({ length: 301 }, (_, i) => [TOUR.lat + i * 1e-4, TOUR.lon]) })).status, 400);
    assert.equal((await post({ points: [[TOUR.lat, TOUR.lon], [48.85, 2.35]] })).status, 400, 'over 50 km');
    assert.equal((await post({ points: [[48.85, 2.35], [48.86, 2.35]] })).status, 403, 'Paris is outside');
    const big = await fetch(`${base}/api/terrain/profile`, { method: 'POST', body: 'x'.repeat(70000) });
    assert.equal(big.status, 413);
  });
});

test('the daily budget stops upstream requests with 429', async () => {
  const [x, y] = tileOf(TOUR.lat + 0.03, TOUR.lon + 0.05, 15);
  dem._resetBudget();
  const saved = process.env.TERRAIN_DAILY_POINTS;
  process.env.TERRAIN_DAILY_POINTS = '100';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/dem/15/${x}/${y}`);
      assert.equal(res.status, 429);
      assert.match((await res.json()).error, /budget/);
    });
  } finally {
    process.env.TERRAIN_DAILY_POINTS = saved;
    dem._resetBudget();
  }
});

test('NVE slope tiles come through the proxy; empty ones are remembered', async () => {
  const [x, y] = tileOf(TOUR.lat, TOUR.lon, 14);
  await withServer(async (base) => {
    const first = await fetch(`${base}/tiles/nve/14/${x}/${y}.png`);
    const n = calls.nve;
    const second = await fetch(`${base}/tiles/nve/14/${x}/${y}.png`);
    assert.equal(first.status, second.status);
    assert.equal(calls.nve, n, 'the answer (tile or empty) is cached');
    const far = await fetch(`${base}/tiles/nve/14/${tileOf(48.85, 2.35, 14).join('/')}.png`);
    assert.equal(far.status, 403);
  });
});

test('GET /terrain serves the page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/terrain`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Plan a line/);
    const js = await fetch(`${base}/terrain/app.js`);
    assert.equal(js.status, 200);
  });
});

/* ------------------------- server helpers ------------------------- */

test('sampleRoute keeps samples per segment and caps the count', () => {
  const v = [{ lat: 60, lon: 8 }, { lat: 60.01, lon: 8 }, { lat: 60.01, lon: 8.02 }];
  const { samples, spacing } = dem.sampleRoute(v);
  assert.equal(spacing, 25);
  assert.equal(samples[0].v, 0);
  assert.equal(samples.filter((s) => s.v !== undefined).length, 3);
  const long = dem.sampleRoute([{ lat: 60, lon: 8 }, { lat: 60.3, lon: 8 }]);
  assert.ok(long.samples.length <= 401);
  assert.equal(long.spacing % 25, 0);
});

test('slopeAspect: a plane rising to the east faces west', () => {
  const r = dem.slopeAspect(110, 90, 100, 100, 10);
  assert.ok(Math.abs(r.slope - 45) < 1e-9);
  assert.ok(Math.abs(r.aspect - 270) < 1e-9);
  assert.equal(dem.octant(r.aspect), 'W');
});

/* ------------------------- page modules ------------------------- */

const A = await import('../public/terrain/analysis.js');
const D = await import('../public/terrain/dem.js');
const G = await import('../public/terrain/suggest.js');
const IO = await import('../public/terrain/routeio.js');

test('analyse: distance, climb, slope classes, steep sections and problem hits', () => {
  // 1 km: flat, then 400 m at 35° facing NE at 1100–1200 m, then flat.
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    const d = i * 25;
    const steep = d >= 300 && d < 700;
    samples.push({ d, lat: 60 + i * 1e-4, lon: 8, ele: 1000 + Math.min(Math.max(d - 300, 0), 400) * 0.5, slope: steep ? 35 : 10, aspect: steep ? 45 : 180 });
  }
  const problems = [{ type: 'Wind slab', problemType: 'Wind-drifted snow', aspects: '11000000', heights: { h1: 1000, h2: 0, fill: 1 } }];
  const a = A.analyse({ samples }, { problems });
  assert.equal(a.distanceM, 1000);
  assert.ok(Math.abs(a.ascentM - 200) <= 13);
  assert.equal(a.steepSections.length, 1);
  const s = a.steepSections[0];
  assert.ok(Math.abs(s.lengthM - 400) <= 25);
  assert.deepEqual(s.aspects, ['NE']);
  assert.equal(a.problemSections.length, 1);
  assert.deepEqual(a.problemSections[0].problems, ['Wind-drifted snow']);
  const c35 = a.classes.find((c) => c.key === 's35');
  assert.ok(Math.abs(c35.m - 400) <= 25);
  assert.ok(a.steepAspects.NE > 350);
  assert.equal(a.weatherPoints.start.ele, 1000);
  assert.equal(a.weatherPoints.summit.ele, 1200);
  // A problem on the other aspects does not hit.
  const none = A.analyse({ samples }, { problems: [{ ...problems[0], aspects: '00001000' }] });
  assert.equal(none.problemSections.length, 0);
  // Runout flags add up.
  const ro = A.analyse({ samples }, { runout: samples.map((x) => x.d >= 800) });
  assert.ok(Math.abs(ro.runoutM - 200) <= 25);
  assert.equal(ro.runoutSections.length, 1);
});

test('routeHours follows the planner rule plus 4 km/h on the flat', () => {
  assert.equal(A.routeHours({ ascentM: 800, descentM: 0, flatM: 0 }), 2);
  assert.equal(A.routeHours({ ascentM: 0, descentM: 1500, flatM: 4000 }), 2);
  assert.equal(A.fmtHours(2.25), '2 h 15 min');
});

test('client DEM: mosaic stitches shared edges and slopeAspect recovers the plane', () => {
  const z = 14;
  const [x, y] = tileOf(TOUR.lat, TOUR.lon, z);
  const tiles = new Map();
  const mk = (tx, ty) => {
    const ele = [];
    for (let j = 0; j < 17; j++) {
      const lat = D.unmy((ty + j / 16) / 2 ** z);
      for (let i = 0; i < 17; i++) ele.push(plane(lat));
    }
    return { z, x: tx, y: ty, ele };
  };
  for (const [a, b] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) tiles.set(`${a}/${b}`, mk(a, b));
  const g = D.mosaic({ z, x0: x, x1: x + 1, y0: y, y1: y + 1 }, (_, a, b) => tiles.get(`${a}/${b}`));
  assert.equal(g.nx, 33);
  assert.equal(g.ny, 33);
  const { slope, aspect } = D.slopeAspect(g.ele, g.nx, g.ny, g.cellM);
  const k = 16 * g.nx + 16;
  // Mercator cells vs the plane in metres: within a degree.
  assert.ok(Math.abs(slope[k] - 30) < 1, `slope ${slope[k]}`);
  assert.ok(Math.abs(aspect[k] - 180) < 1, `aspect ${aspect[k]}`);
  const [fi, fj] = g.fromLatLon(TOUR.lat, TOUR.lon);
  const back = g.toLatLon(fi, fj);
  assert.ok(Math.abs(back.lat - TOUR.lat) < 1e-9 && Math.abs(back.lon - TOUR.lon) < 1e-9);
  const cells = D.tileCells(tiles.get(`${x}/${y}`));
  assert.ok(Math.abs(cells.slope[8 * 16 + 8] - 30) < 1);
});

test('suggestPath goes round a steep band when there is a gentle way', () => {
  // A 60 × 60 grid, 30 m cells, a slope rising to the north. A band of
  // 40° ground across the middle, open at the east end.
  const nx = 60, ny = 60, cellM = 30;
  const ele = new Float32Array(nx * ny), slope = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      ele[j * nx + i] = (ny - j) * 5;
      slope[j * nx + i] = j >= 28 && j <= 32 && i < 50 ? 40 : 9;
    }
  }
  const res = G.suggestPath({ nx, ny, ele, slope, cellM }, [5, 55], [5, 5]);
  assert.ok(res);
  const crossed = res.path.filter(([i, j]) => slope[j * nx + i] >= 40).length;
  assert.equal(crossed, 0, 'no step on the 40° band');
  assert.ok(res.path.some(([i]) => i >= 50), 'goes round at the east end');
  const simple = G.simplify(res.path, 0.9);
  assert.ok(simple.length < res.path.length && simple.length >= 3);
  // With no way round, it crosses rather than failing.
  for (let i = 50; i < nx; i++) for (let j = 28; j <= 32; j++) slope[j * nx + i] = 40;
  assert.ok(G.suggestPath({ nx, ny, ele, slope, cellM }, [5, 55], [5, 5]));
});

test('snapNode finds the nearest known height', () => {
  const ele = new Float32Array(25).fill(NaN);
  ele[2 * 5 + 3] = 100;
  assert.deepEqual(G.snapNode({ nx: 5, ny: 5, ele }, 1, 1), [3, 2]);
});

test('encoded polylines round-trip', () => {
  const pts = [[69.65331, 20.02521], [69.66, 20.03], [61.5, 8.25]];
  const back = IO.decodePolyline(IO.encodePolyline(pts));
  back.forEach((p, i) => { assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-5 && Math.abs(p[1] - pts[i][1]) < 1e-5); });
  assert.equal(IO.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});
