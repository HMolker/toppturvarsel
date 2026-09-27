import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Logins (v5.8): the users list, sessions, premium and sneaky, and the
 * Harahorn demo a sneaky login plans in — stored terrain only, never a new
 * height, and "slope closed" for the rest.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-auth-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.BASE_PATH = '/fjallskred';
process.env.DEMO = 'off';
process.env.TRUST_PROXY = 'true';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

// Nothing leaves the machine: every upstream is "down", and counted.
let upstream = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (/^https?:\/\/127\.0\.0\.1/.test(String(url))) return realFetch(url, opts);
  // The resort list refreshes itself in the background; heights and tiles are what count here.
  if (!/fnugg|overpass/.test(String(url))) upstream++;
  return new Response('offline', { status: 503 });
};

const auth = await import('../src/auth.js');
const demo = await import('../src/demo.js');
const { createServer } = await import('../src/server.js');
const { heightsFromStore, DEM_N } = await import('../src/dem.js');

const HARA = { lat: 60.9394, lon: 8.4945 };
const usersFile = path.join(tmp, 'auth', 'users.csv');
const tileXY = (z, lat, lon) => {
  const n = 2 ** z, R = Math.PI / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(lat * R) + 1 / Math.cos(lat * R)) / Math.PI) / 2) * n)];
};
async function storeDem(z, x, y, ele = 1000) {
  const f = path.join(tmp, 'cache', 'dem', String(z), String(x), `${y}.json`);
  await mkdir(path.dirname(f), { recursive: true });
  // A plane rising to the north-east, so slopes come out non-zero.
  const e = [];
  for (let j = 0; j < DEM_N; j++) for (let i = 0; i < DEM_N; i++) e.push(ele + i * 2 - j * 3);
  await writeFile(f, JSON.stringify({ z, x, y, n: DEM_N, ele: e, fetchedAt: '2020-01-01T00:00:00Z', source: 'test' }));
}

async function start() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const go = (p, opts = {}) => realFetch(base + p, { redirect: 'manual', ...opts });
  return { server, go };
}
const cookieFrom = (res) => res.headers.get('set-cookie')?.split(';')[0];
async function loginAs(go, username, password, ip = '10.0.0.1') {
  return go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    body: new URLSearchParams({ username, password, next: 'terrain' }).toString(),
  });
}

test('no users list: logins are off and everything is open, as before', async () => {
  auth._resetAuth();
  await auth.loadUsers({ force: true });
  assert.equal(auth.authEnabled(), false);
  const { server, go } = await start();
  try {
    const me = await (await go('/api/me')).json();
    assert.deepEqual({ auth: me.auth, role: me.role }, { auth: false, role: 'premium' });
    assert.equal((await go('/')).status, 200);
    // The login page just sends you home.
    assert.equal((await go('/login')).status, 303);
  } finally {
    server.close();
  }
});

test('users.csv: plain passwords become scrypt hashes in place; bad lines are skipped', async () => {
  await mkdir(path.dirname(usersFile), { recursive: true });
  await writeFile(usersFile, [
    '# username,role,password',
    'Anna,premium,anna-secret-1',
    'olle,sneaky,olle-secret-1',
    'kort,sneaky,short',
    'x y,premium,whatever-long',
    'eva,admin,whatever-long',
    '',
  ].join('\n'));
  auth._resetAuth();
  const users = await auth.loadUsers({ force: true });
  assert.deepEqual([...users.keys()].sort(), ['anna', 'olle']);
  const text = await readFile(usersFile, 'utf8');
  assert.doesNotMatch(text, /anna-secret-1|olle-secret-1/);
  assert.match(text, /^anna,premium,scrypt\$16384\$/m);
  assert.match(text, /^# username,role,password$/m, 'comments are kept');
  assert.equal(auth.authEnabled(), true);
  // Hashes stay as they are on the next read.
  await auth.loadUsers({ force: true });
  assert.equal(await readFile(usersFile, 'utf8'), text);
});

test('logged out: pages go to the login (relative, so it works under /fjallskred/), the API says 401', async () => {
  const { server, go } = await start();
  try {
    let r = await go('/');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), 'login?next=');
    r = await go('/terrain');
    assert.equal(r.headers.get('location'), 'login?next=terrain');
    r = await go('/api/conditions');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).login, true);
    r = await go('/tiles/no/12/2144/1178.png');
    assert.equal(r.status, 401);
    // The login page and what it needs are open.
    r = await go('/login?next=terrain');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /action="login"/);
    assert.match(html, /name="next" value="terrain"/);
    assert.equal((await go('/styles.css')).status, 200);
    assert.notEqual((await go('/api/health')).status, 401);
  } finally {
    server.close();
  }
});

test('log in and out: a signed cookie for /fjallskred, back to where you were going', async () => {
  const { server, go } = await start();
  try {
    let r = await loginAs(go, 'anna', 'wrong-password', '10.0.0.2');
    assert.equal(r.status, 401);
    assert.match(await r.text(), /Wrong username or password/);
    r = await loginAs(go, 'ANNA', 'anna-secret-1', '10.0.0.2');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), 'terrain');
    const set = r.headers.get('set-cookie');
    assert.match(set, /^fjs_session=/);
    assert.match(set, /Path=\/fjallskred/, 'through Caddy: the cookie is kept to /fjallskred');
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.doesNotMatch(set, /Secure/, 'plain http: no Secure flag');
    const direct = await go('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=anna&password=anna-secret-1' });
    assert.match(direct.headers.get('set-cookie'), /Path=\/;/, 'straight to the port: the whole site');
    const cookie = cookieFrom(r);
    const me = await (await go('/api/me', { headers: { cookie } })).json();
    assert.deepEqual({ auth: me.auth, user: me.user, role: me.role, demo: me.demo }, { auth: true, user: 'anna', role: 'premium', demo: null });
    // A forged cookie is nobody.
    const forged = cookie.slice(0, -3) + 'abc';
    assert.equal((await go('/api/me', { headers: { cookie: forged } })).status, 401);
    // Over HTTPS (Caddy says so) the cookie is Secure.
    r = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '10.0.0.3' },
      body: 'username=anna&password=anna-secret-1&next=https%3A%2F%2Fevil.example%2F',
    });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    assert.equal(r.headers.get('location'), './', 'no redirect off the site');
    // Log out clears it.
    r = await go('/logout', { headers: { cookie } });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    server.close();
  }
});

test('five wrong passwords lock the name for a while, even with the right one', async () => {
  const { server, go } = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await loginAs(go, 'olle', `nope-${i}-xxxx`, `10.1.0.${i}`)).status, 401);
    assert.equal((await loginAs(go, 'olle', 'olle-secret-1', '10.1.0.99')).status, 429);
  } finally {
    server.close();
  }
  auth._resetAuth();
  await auth.loadUsers({ force: true });
});

test('a new password (or a removed line) ends the sessions made before', async () => {
  const { server, go } = await start();
  try {
    const cookie = cookieFrom(await loginAs(go, 'anna', 'anna-secret-1', '10.2.0.1'));
    assert.equal((await go('/api/me', { headers: { cookie } })).status, 200);
    const text = await readFile(usersFile, 'utf8');
    await writeFile(usersFile, text.replace(/^anna,premium,.*$/m, 'anna,premium,a-brand-new-one'));
    await auth.loadUsers({ force: true });
    assert.equal((await go('/api/me', { headers: { cookie } })).status, 401);
    assert.equal((await loginAs(go, 'anna', 'a-brand-new-one', '10.2.0.2')).status, 303);
  } finally {
    server.close();
  }
});

test('sneaky: the premium things say "slope closed"', async () => {
  const { server, go } = await start();
  try {
    const cookie = cookieFrom(await loginAs(go, 'olle', 'olle-secret-1', '10.3.0.1'));
    const h = { headers: { cookie } };
    const me = await (await go('/api/me', h)).json();
    assert.equal(me.role, 'sneaky');
    assert.equal(me.demo.name, 'Harahorn');
    assert.equal(me.demo.radiusKm, 3);
    assert.equal(me.demo.firstKm, 1.5);

    for (const p of ['/api/track.gpx?tour=Harahorn', '/api/skill']) {
      const r = await go(p, h);
      assert.equal(r.status, 403, p);
      const b = await r.json();
      assert.equal(b.closed, true);
      assert.match(b.error, /Slope closed: .* open for premium skiers only/);
    }
    let r = await go('/api/places/pick', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"id":"x"}' });
    assert.equal(r.status, 403);
    for (const p of ['/skill', '/editor']) {
      r = await go(p, h);
      assert.equal(r.status, 403);
      const html = await r.text();
      assert.match(html, /Slope closed/);
      assert.match(html, /Open for premium skiers only/);
    }
    // The conditions and Plan a tour pages are open.
    assert.equal((await go('/', h)).status, 200);
    assert.equal((await go('/terrain', h)).status, 200);
    assert.equal((await go('/api/conditions', h)).status !== 403, true);
    // Premium gets the forecast-accuracy page.
    const pc = cookieFrom(await loginAs(go, 'anna', 'a-brand-new-one', '10.3.0.2'));
    assert.equal((await go('/skill', { headers: { cookie: pc } })).status, 200);
    // A trailing slash would break the relative links: sent back.
    r = await go('/terrain/', h);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '../terrain');
  } finally {
    server.close();
  }
});

test('sneaky: terrain within 3 km of Harahorn from the store only, never a new height', async () => {
  const [x15, y15] = tileXY(15, HARA.lat, HARA.lon);
  await storeDem(15, x15, y15, 1400);
  const { server, go } = await start();
  try {
    const cookie = cookieFrom(await loginAs(go, 'olle', 'olle-secret-1', '10.4.0.1'));
    const h = { headers: { cookie } };
    const before = upstream;

    // Stored, inside: served.
    let r = await go(`/api/dem/15/${x15}/${y15}`, h);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).n, DEM_N);
    // Inside, not stored yet: "not yet", not "closed".
    r = await go(`/api/dem/15/${x15 + 3}/${y15}`, h);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).pending, true);
    // Outside the demo (15 km east), still in the service area: closed.
    const [xo, yo] = tileXY(15, HARA.lat, HARA.lon + 0.28);
    r = await go(`/api/dem/15/${xo}/${yo}`, h);
    assert.equal(r.status, 403);
    assert.notEqual((await r.json()).closed, true, 'quietly: the map asks for what it shows');

    // A route profile from the stored tile.
    const inside = { points: [[HARA.lat, HARA.lon], [HARA.lat + 0.0012, HARA.lon + 0.0015]] };
    r = await go('/api/terrain/profile', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(inside) });
    assert.equal(r.status, 200);
    const prof = await r.json();
    assert.equal(prof.source, 'stored demo terrain');
    assert.ok(prof.samples.every((p) => Number.isFinite(p.ele)));
    assert.ok(prof.samples.some((p) => p.slope > 0));
    // Outside: closed.
    const outside = { points: [[HARA.lat, HARA.lon], [HARA.lat, HARA.lon + 0.1]] };
    r = await go('/api/terrain/profile', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(outside) });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).closed, true);
    // Weather outside the area: closed.
    r = await go('/api/terrain/weather', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ points: [[HARA.lat, HARA.lon + 0.2, 1200]] }) });
    assert.equal(r.status, 403);
    // Map tiles: the demo area yes, elsewhere no.
    const [tx, ty] = tileXY(14, HARA.lat, HARA.lon + 0.3);
    r = await go(`/tiles/no/14/${tx}/${ty}.png`, h);
    assert.equal(r.status, 403);

    assert.equal(upstream, before, 'no request left the server for a sneaky login');
    // The zone tells how far the download has come, and opens no new places.
    const z = await (await go('/api/terrain/zone', h)).json();
    assert.equal(z.role, 'sneaky');
    assert.deepEqual(z.places, []);
    assert.ok(z.demo.tiles > 0);
    assert.ok(z.demo.stored >= 1);
  } finally {
    server.close();
  }
});

test('heightsFromStore: bilinear from the finest stored tile, "not yet" where nothing is', async () => {
  const [x15, y15] = tileXY(15, HARA.lat, HARA.lon);
  const [v] = await heightsFromStore([HARA]);
  assert.ok(v > 1300 && v < 1500, `height ${v}`);
  await assert.rejects(heightsFromStore([{ lat: HARA.lat + 0.5, lon: HARA.lon }]), (e) => e.status === 409 && e.pending);
  assert.ok(x15 > 0 && y15 > 0);
});

test('demo download: the first 1.5 km before the rest, heights first, a daily cap', async () => {
  demo._resetDemo();
  const a = await demo.demoArea();
  const jobs = await demo.demoJobs();
  const firstOuter = jobs.findIndex((j) => j.km > a.firstKm);
  assert.ok(firstOuter > 0);
  assert.ok(jobs.slice(0, firstOuter).every((j) => j.km <= a.firstKm), 'first ring first');
  assert.ok(jobs.slice(firstOuter).every((j) => j.km > a.firstKm));
  const firstTileJob = jobs.findIndex((j) => j.kind !== 'dem');
  assert.ok(jobs.slice(0, firstTileJob).every((j) => j.kind === 'dem' && j.km <= a.firstKm), 'heights before pictures');
  assert.ok(jobs.every((j) => j.km <= a.radiusKm));

  // The cap: 3 tiles' worth of heights today, then stop until tomorrow.
  process.env.DEMO_DAILY_POINTS = String(289 * 3);
  await rm(path.join(tmp, 'cache', 'demo-state.json'), { force: true });
  const got = [];
  const res = await demo.runDemoPrefetch({
    getDemTile: async (z, x, y) => { got.push(`${z}/${x}/${y}`); await storeDem(z, x, y); },
    getTile: async () => ({ status: 200 }),
    gapMs: 0,
  });
  assert.equal(res.heights, 289 * 3);
  assert.equal(got.length, 3);
  const again = await demo.runDemoPrefetch({ getDemTile: async () => { throw new Error('over the cap'); }, getTile: async () => ({ status: 200 }), gapMs: 0 });
  assert.equal(again.heights, 0, 'nothing more today');
  const st = JSON.parse(await readFile(path.join(tmp, 'cache', 'demo-state.json'), 'utf8'));
  assert.equal(st.points, 289 * 3);
  delete process.env.DEMO_DAILY_POINTS;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await rm(tmp, { recursive: true, force: true });
});
