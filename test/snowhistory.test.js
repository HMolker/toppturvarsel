import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-sh-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { seasonOf, seasonUrl, shapeSeason, getSnowHistory } = await import('../src/snowhistory.js');
const { snowHistoryModel, snowHistorySvg } = await import('../public/snowhistory.js');
// Six real winters at Høgeloft, as seNorge returned them (demo/fixtures).
const fixture = JSON.parse(await readFile(new URL('../demo/fixtures/senorge-hogeloft-5y.json', import.meta.url), 'utf8'));

test('season keys and request ranges', () => {
  assert.equal(seasonOf(new Date('2026-02-15T12:00:00Z')), '2025-26');
  assert.equal(seasonOf(new Date('2026-09-22T12:00:00Z')), '2026-27', 'from July on, the coming winter');
  const tour = { name: 'Høgeloft', lat: 61.0539, lon: 8.2143 };
  const past = seasonUrl(tour, '2023-24', { today: new Date('2026-02-15T12:00:00Z') });
  assert.match(past.url, /\/134068\/6787786\/2023-10-01\/2024-06-30\/sd\.json$/);
  const cur = seasonUrl(tour, '2025-26', { today: new Date('2026-02-15T12:00:00Z') });
  assert.equal(cur.to, '2026-02-15', 'the current winter only up to today');
  assert.deepEqual(shapeSeason({ NoDataValue: 65535, Data: [1.24, 65535, 3], Altitude: 1618 }, '2023-10-01'), { start: '2023-10-01', depth: [1.2, null, 3], altitude: 1618 });
});

test('model: five-winter average, range, today and the leap day', () => {
  const m = snowHistoryModel({ seasons: fixture.seasons, current: '2025-26', today: '2026-02-15' });
  assert.deepEqual(m.past, ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25']);
  assert.equal(m.now, 72.8);
  assert.equal(Math.round(m.avgNow), 154);
  assert.equal(m.pct, -53);
  assert.equal(m.avg.length, 273, '1 Oct – 30 Jun, 29 Feb dropped from 2023/24');
  assert.ok(m.lo.every((v, i) => v === null || (v <= m.avg[i] && m.avg[i] <= m.hi[i])));
  assert.equal(m.cur.slice(m.todayIdx + 1).every((v) => v === null), true, 'nothing after today');
  const svg = snowHistorySvg(m);
  assert.match(svg, /73 cm today/);
  assert.match(svg, /−53 % vs average \(154 cm\)/);
  assert.match(snowHistorySvg(m, { lastWinter: true }), /Last winter 2025\/26/);
  assert.doesNotMatch(snowHistorySvg(m, { lastWinter: true }), /cm today/);
});

test('server: six winters fetched once, past winters cached for good', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes('gts.nve.no')) throw new Error(`unstubbed request in tests: ${u}`);
    calls.push(u);
    const [, from] = u.match(/\/(\d{4}-\d\d-\d\d)\/\d{4}-\d\d-\d\d\/sd\.json$/);
    const key = `${from.slice(0, 4)}-${String((Number(from.slice(0, 4)) + 1) % 100).padStart(2, '0')}`;
    const s = fixture.seasons[key];
    return new Response(JSON.stringify({ NoDataValue: 65535, Altitude: 1618, Data: s ? s.depth.map((v) => v ?? 65535) : [] }), { status: 200 });
  };
  try {
    const tour = { name: 'Høgeloft', lat: 61.0539, lon: 8.2143 };
    const today = new Date('2026-02-15T12:00:00Z');
    const h = await getSnowHistory(tour, { today });
    assert.equal(calls.length, 6);
    assert.deepEqual(Object.keys(h.seasons), ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25', '2025-26']);
    assert.equal(h.current, '2025-26');
    assert.equal(h.altitude, 1618);
    await getSnowHistory(tour, { today });
    assert.equal(calls.length, 6, 'second call is all cache (current winter within its 6 h)');
  } finally {
    globalThis.fetch = realFetch;
  }
});
