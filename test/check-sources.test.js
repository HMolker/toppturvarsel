import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The live source check (v6.0.1), against stubbed upstreams: it must say OK
 * when the shapes are the known ones, and point at the right file when a
 * Swiss shape changes or the Swedish page cannot be read in season.
 */

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), 'ttv-check-'));
process.env.LOG_LEVEL = 'error';
const { runChecks, swedishSeason } = await import('../src/check-sources.js');

const bulletins = JSON.parse(await readFile(new URL('./fixtures/slf-bulletins.json', import.meta.url), 'utf8'));
const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const swiss = new Set(regions.filter((r) => r.country === 'CH').map((r) => r.slfRegion));
const swissTours = tours.filter((t) => regions.find((r) => r.id === t.region)?.country === 'CH');
// Every Swiss micro-region in one bulletin, so a full feed can be told apart from a gap.
const full = { bulletins: [{ ...bulletins.bulletins[0], regions: [...swiss].map((id) => ({ regionID: id, name: id })) }] };

const realFetch = globalThis.fetch;
let slfBody = full, swedishHtml = '<html><img alt="Risk 2"><p>Måttlig lavinfara</p></html>', dailyRow = { station_code: 'S0', measure_date: '2026-02-15T06:00:00Z', HS: 180, HN_1D: 12 };
const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api01.nve.no')) return J([{ DangerLevel: '3', AvalancheProblems: [] }]);
  if (u.includes('lavinprognoser.se')) return new Response(swedishHtml, { status: 200 });
  if (u.includes('gts.nve.no')) return J({ NoDataValue: 65535, Altitude: 1100, Data: [100, 110, 120], Unit: 'cm' });
  if (u.includes('aws.slf.ch')) return J(slfBody);
  if (u.endsWith('/imis/stations')) return J(swissTours.map((t, i) => ({ code: `S${i}`, label: t.name, lat: t.lat, lon: t.lon, elevation: 2500 })));
  if (u.includes('/imis/daily-snow')) return J([dailyRow]);
  if (u.includes('pixelkarte-grau')) return new Response(JPEG, { status: 200 });
  if (u.includes('hangneigung')) return new Response(PNG, { status: 200 });
  if (u.includes('open-meteo')) return J({ daily: { time: ['2026-02-15'] } });
  if (u.includes('api.met.no')) return J({ properties: { timeseries: [{}, {}] } });
  throw new Error(`unstubbed: ${u}`);
};
test.after(() => (globalThis.fetch = realFetch));

// One entry per check, by a short key.
const KEYS = [['SLF-daily', /daily snow/], ['SLF-stations', /IMIS stations/], ['SLF', /SLF bulletin/], ['lavinprognoser', /lavinprognoser/], ['swisstopo', /swisstopo/]];
const byName = (rs) => Object.fromEntries(KEYS.map(([k, re]) => [k, rs.find((r) => re.test(r.name))]));

test('known shapes everywhere: all OK', async () => {
  const rs = await runChecks({ now: new Date('2027-01-20T08:00:00Z') });
  assert.deepEqual(rs.filter((r) => r.status !== 'OK').map((r) => `${r.name}: ${r.detail}`), []);
  const b = byName(rs);
  assert.match(b.SLF.detail, /all 15 Swiss regions have a danger level/);
  assert.match(b.lavinprognoser.detail, /danger 2 read/);
  assert.match(b.swisstopo.detail, /map 200 JPEG, slope 200 PNG/);
});

test('Sweden in season with a page the code cannot read: a warning that says where to look', async () => {
  swedishHtml = '<html><div class="new-layout">Faregrad: tre</div></html>';
  try {
    const b = byName(await runChecks({ now: new Date('2026-12-12T08:00:00Z') }));
    assert.equal(b.lavinprognoser.status, 'WARN');
    assert.match(b.lavinprognoser.detail, /lavinprognoser\.js/);
    // The same page in October is simply out of season.
    const oct = byName(await runChecks({ now: new Date('2026-10-12T08:00:00Z') }));
    assert.equal(oct.lavinprognoser.status, 'OK');
  } finally {
    swedishHtml = '<html><img alt="Risk 2"><p>Måttlig lavinfara</p></html>';
  }
  assert.equal(swedishSeason(new Date('2026-12-10T12:00:00Z')), false);
  assert.equal(swedishSeason(new Date('2026-12-11T12:00:00Z')), true);
  assert.equal(swedishSeason(new Date('2027-05-02T12:00:00Z')), false);
});

test('Switzerland: a region missing from the feed, a changed shape, renamed fields', async () => {
  slfBody = bulletins; // the real bulletin does not cover every region listed here
  let b = byName(await runChecks());
  assert.equal(b.SLF.status, 'WARN');
  assert.match(b.SLF.detail, /Samnaun \(CH-7121\).*slfRegion/);
  slfBody = { items: [] };
  b = byName(await runChecks());
  assert.equal(b.SLF.status, 'FAIL');
  assert.match(b.SLF.detail, /slf\.js/);
  slfBody = full;
  dailyRow = { code: 'S0', date: '2026-02-15', snow: 180 };
  b = byName(await runChecks());
  assert.equal(b['SLF-daily'].status, 'FAIL');
  assert.match(b['SLF-daily'].detail, /expected station_code, measure_date, HS, HN_1D/);
});
