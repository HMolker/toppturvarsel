import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The Spanish Pyrenees and Andorra (v6.3): regions, tours, map and heights,
 * but no bulletin and no snow source yet. The point of these tests is the
 * "not read" state: a missing danger level must never be taken for a low one,
 * and those points must never be sent to seNorge.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-pyr-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'false';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { refresh } = await import('../src/refresh.js');
const { alpineStubs } = await import('./helpers/alps.js');
const { COUNTRIES, GROUPS } = await import('../public/countries.js');
const { gate, plan } = await import('../public/planner.js');
const { bulletinDays } = await import('../src/outlook.js');

const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const pyr = (c) => c === 'ES' || c === 'AD';
const pyrRegions = regions.filter((r) => pyr(r.country));
const pyrIds = new Set(pyrRegions.map((r) => r.id));
const pyrTours = tours.filter((t) => pyrIds.has(t.region));

test('the Pyrenees are a group of Spain and Andorra, off by default', () => {
  const g = GROUPS.find((x) => x.id === 'pyrenees');
  assert.deepEqual(g.countries, ['ES', 'AD']);
  for (const c of g.countries) {
    assert.ok(COUNTRIES[c].optIn, `${c} is opt-in`);
    assert.ok(COUNTRIES[c].frame.length >= 8, `${c} has an outline`);
  }
});

test('every Pyrenean region links to a bulletin and every region has tours', () => {
  assert.ok(pyrRegions.length >= 8);
  for (const r of pyrRegions) {
    assert.match(r.bulletinUrl, /^https:\/\//, `${r.id}: bulletin link`);
    assert.ok(tours.some((t) => t.region === r.id), `${r.id}: has a tour`);
    assert.equal(r.slfRegion, undefined);
    assert.equal(r.eawsState, undefined);
  }
  assert.ok(pyrTours.length >= 12);
});

test('refresh: no danger level, no snow, and nothing sent to seNorge for Spain and Andorra', async () => {
  const gts = [];
  const alpine = alpineStubs({ regions });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('gts.nve.no')) {
      gts.push(u);
      return new Response(JSON.stringify({ Theme: 'sd', NoDataValue: 65535, Unit: 'cm', Altitude: 1200, EndDate: '10.02.2026 06:00:00', Data: [100, 100, 100, 100, 100, 100, 100] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('api01.nve.no')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('lavinprognoser.se')) return new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (u.includes('slf.ch')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const alp = alpine(u);
    if (alp) return alp;
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const snap = await refresh({ force: true, date: new Date('2026-02-10T08:00:00Z') });
    const rows = snap.regions.filter((r) => pyr(r.country));
    assert.equal(rows.length, pyrRegions.length);
    for (const r of rows) {
      assert.equal(r.bulletin.danger, null, `${r.id}: no danger level`);
      assert.equal(r.bulletin.notRead, true, `${r.id}: marked as not read`);
      assert.equal(r.bulletin.noForecast, undefined, `${r.id}: a forecast exists, it is just not read`);
      assert.equal(r.snow, null, `${r.id}: no snow source`);
      assert.match(r.bulletinUrl, /^https:\/\//);
    }
    for (const t of snap.tours.filter((x) => pyrIds.has(x.region))) assert.equal(t.snow, null, `${t.name}: no snow`);
    // seNorge was asked about the Nordic points only.
    const nordic = new Set(regions.filter((r) => r.country === 'NO' || r.country === 'SE').map((r) => r.id));
    const nordicPoints = tours.filter((t) => nordic.has(t.region)).length + regions.filter((r) => nordic.has(r.id) && !r.offMap && !tours.some((t) => t.region === r.id)).length;
    assert.ok(gts.length <= nordicPoints, `${gts.length} seNorge requests for ${nordicPoints} Nordic points`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the planner does not rank a Pyrenean tour without a bulletin, and says why', () => {
  const day = bulletinDays({ bulletin: { source: 'none', notRead: true, assessed: false, danger: null } }, '2027-02-10')[0];
  assert.equal(day.notRead, true);
  assert.equal(day.assessed, false);
  const g = gate({ difficulty: 2, aspect: 'S', summit_m: 2900 }, day, {});
  assert.equal(g.status, 'unassessed');
  assert.match(g.why, /not read here yet/);
});

test('a plan keeps Pyrenean tours out of the ranking, whatever the weather', () => {
  const regionRows = regions.map((r) => ({ id: r.id, bulletin: pyr(r.country) ? { source: 'none', notRead: true, assessed: false, danger: null } : { danger: 2, problems: [], validFrom: '2027-02-10T00:00:00' } }));
  const bulletins = Object.fromEntries(regionRows.map((r) => [r.id, bulletinDays(r, '2027-02-10')]));
  const t = pyrTours[0];
  const days = Array.from({ length: 5 }, (_, i) => ({ date: `2027-02-${10 + i}`, snowCm: 10, tMax: -4, tMin: -9, windMax: 3, code: 71 }));
  const out = plan({ tours: [{ ...t, snow: null }], outlook: { bulletins, forecasts: { [t.name]: { days } } } });
  for (const d of out.days) assert.equal(d.rows[0].status, 'unassessed', `${d.date}: not ranked`);
  assert.ok(out.days.length >= 3);
});
