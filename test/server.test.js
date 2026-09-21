import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * These run the real HTTP server against a temp DATA_DIR. No network: the
 * snapshot is written straight to the store, which is exactly the state the
 * server sees in production after a refresh.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-'));
process.env.DATA_DIR = tmp;
process.env.ALERT_THRESHOLD_CM = '30';
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { createServer } = await import('../src/server.js');

const snapshot = {
  fetchedAt: new Date().toISOString(),
  durationMs: 1200,
  season: true,
  status: 'ok',
  sources: {
    varsom: { ok: true, regions: 24 },
    lavinprognoser: { ok: true, regions: 6, scraped: true },
    senorge: { ok: true, points: 48 },
    regobs: { enabled: false, verified: false, lastError: null },
  },
  regions: [
    {
      id: 'lyngen', name: 'Lyngen', country: 'NO', lat: 69.6, lon: 20.1, offMap: false,
      bulletinUrl: 'https://www.varsom.no/en/snow/forecast/warning/Lyngen/',
      bulletin: { danger: 3, headline: 'Wind slab', problems: [{ type: 'Dry slab avalanche' }] },
      snow: { depthCm: 180, new48: 42, new24: 20, topTour: 'Rørnestinden', sampleCount: 4 },
      observations: null, observationSummary: { latest: 'Observers report…', avalancheActivity: null },
    },
    {
      id: 'voss', name: 'Voss', country: 'NO', lat: 60.75, lon: 6.4, offMap: false,
      bulletinUrl: 'https://x', bulletin: { danger: 2, problems: [] },
      snow: { depthCm: 90, new48: 5, sampleCount: 1 }, observations: null, observationSummary: null,
    },
  ],
  tours: [
    { name: 'Rørnestinden', region: 'lyngen', lat: 69.66, lon: 20.05, summit_m: 1035, vertical_m: 1030,
      aspect: 'W–SW', difficulty: 2, quality: 5, access: 'Roadside', season: 'Feb–May', note: 'n',
      snow: { depthCm: 190, new48: 42 } },
  ],
};

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify(snapshot), 'utf8');

test('GET /api/conditions returns the stored snapshot', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/conditions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.regions.length, 2);
    assert.equal(body.regions[0].bulletin.danger, 3);
  });
});

test('GET /api/alerts reports the firing region and its danger level', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/alerts`)).json();
    assert.equal(body.threshold, 30);
    assert.equal(body.firing.length, 1, 'only Lyngen is over 30 cm');
    assert.equal(body.firing[0].regionId, 'lyngen');
    assert.equal(body.firing[0].new48, 42);
    assert.equal(body.firing[0].dangerKnown, true);
  });
});

test('GET /api/health is ok for a fresh snapshot', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.snapshotAgeMinutes < 5);
  });
});

test('GET /api/health reports 503 when the snapshot is stale', async () => {
  const stale = { ...snapshot, fetchedAt: new Date(Date.now() - 48 * 3600e3).toISOString() };
  await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify(stale), 'utf8');
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503, 'a stale snapshot must fail a healthcheck, not pass quietly');
    assert.equal((await res.json()).ok, false);
  });
  await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify(snapshot), 'utf8');
});

test('serves the frontend and refuses path traversal', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Fjällskred/);

    const logo = await fetch(`${base}/brand/logo-header.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png', 'logo served as an image');

    for (const attack of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await fetch(`${base}${attack}`, { redirect: 'manual' });
      assert.ok(res.status === 403 || res.status === 404, `${attack} returned ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /"name": "toppturvarsel"/, `${attack} leaked package.json`);
      assert.doesNotMatch(body, /root:/, `${attack} leaked /etc/passwd`);
    }
  });
});

test('the tour editor is served at /editor, marked as a read-only preview', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/editor`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    // The marker is what turns off loading and saving in the page.
    assert.match(html, /window\.FJALLSKRED_PREVIEW = true/);
    assert.match(html, /<title>Fjällskred Tour Editor<\/title>/);
    assert.equal((await fetch(`${base}/editor`, { method: 'POST' })).status, 405);
    // Only that one file: the folder is not browsable.
    assert.equal((await fetch(`${base}/editor/sync-data.mjs`)).status, 404);
  });
});

test('unknown API routes 404 rather than falling through to static', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown endpoint');
  });
});

test('POST /api/test-alert is a dry run and writes no ledger entry', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/test-alert`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, true);
    const ledger = await readFile(path.join(tmp, 'cache', 'alerts.json'), 'utf8').catch(() => null);
    assert.equal(ledger, null, 'a dry run must not record alerts as sent');
  });
});

test('GET on an API route that requires POST is not silently accepted', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/refresh`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/version reports the package version and when it started', async () => {
  const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await withServer(async (base) => {
    const v = await (await fetch(`${base}/api/version`)).json();
    assert.equal(v.version, version);
    assert.ok(!Number.isNaN(Date.parse(v.startedAt)));
    assert.match(v.node, /^v\d+/);
  });
});
