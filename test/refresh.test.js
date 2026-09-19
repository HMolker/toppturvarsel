import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Full-pipeline test: refresh() with globalThis.fetch stubbed to answer like
 * the real upstreams. This is the closest thing to an integration test that
 * can run without network, and it is what catches wiring mistakes between
 * fetchers, the region summary and the alert engine.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-refresh-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'false';
process.env.ALERT_THRESHOLD_CM = '30';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { refresh } = await import('../src/refresh.js');
const { evaluateAlerts } = await import('../src/alerts.js');

const realFetch = globalThis.fetch;

function stubFetch({ snowByCell = () => 120, dangerFor = () => '3', failVarsom = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);

    if (u.includes('api01.nve.no')) {
      if (failVarsom) throw new Error('simulated Varsom outage');
      const regionId = Number(u.match(/Detail\/(\d+)\//)?.[1]);
      return jsonResponse([
        {
          RegionId: regionId,
          RegionName: `Region ${regionId}`,
          DangerLevel: dangerFor(regionId),
          DangerLevelName: `${dangerFor(regionId)} Considerable`,
          MainText: 'Test bulletin',
          EmergencyWarning: 'Not given',
          AvalancheProblems: [{ AvalancheExtName: 'Dry slab avalanche' }],
          PublishTime: '2026-02-10T15:00:00',
        },
      ]);
    }

    if (u.includes('gts.nve.no')) {
      const [, x, y] = u.match(/GridTimeSeries\/(\d+)\/(\d+)\//) ?? [];
      const depth = snowByCell(Number(x), Number(y));
      // 7 daily values ending at `depth`, rising by `rise` over the last 2 days
      const rise = depth > 150 ? 40 : 4;
      return jsonResponse({
        Theme: 'sd', NoDataValue: 65535, Unit: 'cm', Altitude: 1200,
        EndDate: '10.02.2026 06:00:00',
        Data: [depth - rise - 10, depth - rise - 8, depth - rise - 5, depth - rise, depth - rise, depth - rise / 2, depth],
      });
    }

    if (u.includes('lavinprognoser.se')) {
      return textResponse('<html><body><img alt="Risk 2"><p>Måttlig lavinfara</p></body></html>');
    }

    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const textResponse = (body) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });

test.after(() => {
  globalThis.fetch = realFetch;
});

test('a full refresh populates every region and tour', async () => {
  stubFetch();
  const snap = await refresh({ force: true, date: new Date('2026-02-10T08:00:00Z') });

  assert.equal(snap.status, 'ok');
  const { loadRegions } = await import('../src/config.js');
  assert.equal(snap.regions.length, (await loadRegions()).length);
  const { loadTours } = await import('../src/config.js');
  assert.equal(snap.tours.length, (await loadTours()).length);

  const no = snap.regions.filter((r) => r.country === 'NO');
  assert.equal(no.length, 24);
  assert.ok(no.every((r) => r.bulletin.danger === 3), 'every Norwegian region got its bulletin');

  const se = snap.regions.filter((r) => r.country === 'SE');
  assert.ok(se.filter((r) => !r.bulletin.noForecast).every((r) => r.bulletin.danger === 2), 'Swedish pages parsed to danger 2');
  assert.ok(se.some((r) => r.bulletin.noForecast && r.bulletin.danger === null && r.bulletinUrl === null), 'no-forecast area says so');

  assert.ok(snap.tours.every((t) => t.snow?.depthCm != null), 'every tour got a snow depth');
  assert.equal(snap.sources.senorge.ok, true);
  assert.equal(snap.sources.varsom.regions, 24);
});

test('region snow summaries are derived from their own tours', async () => {
  stubFetch();
  const snap = await refresh({ force: true, date: new Date('2026-02-10T08:00:00Z') });
  const lyngen = snap.regions.find((r) => r.id === 'lyngen');
  const lyngenTours = snap.tours.filter((t) => t.region === 'lyngen');

  assert.ok(lyngenTours.length >= 3);
  assert.equal(lyngen.snow.sampleCount, lyngenTours.length);
  assert.equal(lyngen.snow.new48, Math.max(...lyngenTours.map((t) => t.snow.new48)));
});

test('a region with a deep loaded cell raises an alert; a quiet one does not', async () => {
  // Only cells north of 7.6M northing (roughly Troms and north) get deep snow.
  stubFetch({ snowByCell: (x, y) => (y > 7600000 ? 220 : 80) });
  const snap = await refresh({ force: true, date: new Date('2026-02-10T08:00:00Z') });
  const firing = evaluateAlerts(snap, { threshold: 30 });

  assert.ok(firing.length > 0, 'the loaded north should fire');
  assert.ok(
    firing.every((f) => ['lyngen', 'tromso', 'nord-troms', 'sor-troms', 'indre-troms', 'abisko', 'kebnekaise', 'ofoten', 'lofoten', 'vest-finnmark', 'finnmarkskysten'].includes(f.regionId)),
    `unexpected region fired: ${firing.map((f) => f.regionId).join(', ')}`
  );
  assert.ok(!firing.some((f) => f.regionId === 'heiane'), 'the quiet south must not fire');
  assert.ok(firing.every((f) => f.dangerKnown), 'alerts carry the danger level');
});

test('a Varsom outage does not lose the snow data or crash the refresh', async () => {
  stubFetch({ failVarsom: true });
  const snap = await refresh({ force: true, date: new Date('2026-02-10T08:00:00Z') });

  assert.equal(snap.status, 'ok', 'partial failure must still produce a snapshot');
  assert.ok(snap.tours.every((t) => t.snow?.depthCm != null), 'snow survived the bulletin outage');

  const no = snap.regions.filter((r) => r.country === 'NO');
  assert.ok(no.every((r) => r.bulletin.danger == null), 'no invented danger levels');
  assert.ok(no.every((r) => r.bulletin.error), 'the failure is recorded, not hidden');

  // An alert during the outage still fires, flagged as danger-unknown.
  // Sweden is unaffected by a Varsom outage, so check the Norwegian regions.
  const loaded = {
    ...snap,
    regions: snap.regions.map((r) => ({ ...r, snow: { ...r.snow, new48: 50 } })),
  };
  const firing = evaluateAlerts(loaded, { threshold: 30 });
  assert.ok(firing.length > 0, 'snow alerts must survive a bulletin outage');

  const norwegian = firing.filter((f) => f.country === 'NO');
  assert.ok(norwegian.length > 0);
  assert.ok(
    norwegian.every((f) => f.dangerKnown === false),
    'with Varsom down, Norwegian alerts must say the danger level is unknown'
  );
  assert.ok(
    firing.filter((f) => f.country === 'SE').every((f) => f.dangerKnown === true),
    'a Varsom outage must not blank out Swedish bulletins'
  );
});

test('out of season, no upstream calls are made at all', async () => {
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    throw new Error('should not be called');
  };
  const snap = await refresh({ seasonOnly: true, date: new Date('2026-08-15T08:00:00Z') });
  assert.equal(called, 0, 'summer must not poll public agency APIs');
  assert.equal(snap.status, 'out-of-season');
  assert.equal(snap.regions.length, (await (await import('../src/config.js')).loadRegions()).length);
  assert.ok(snap.regions.every((r) => r.bulletin.danger === null));
});

test('force overrides the season gate', async () => {
  stubFetch();
  const snap = await refresh({
    seasonOnly: true,
    force: true,
    date: new Date('2026-08-15T08:00:00Z'),
  });
  assert.equal(snap.status, 'ok');
});
