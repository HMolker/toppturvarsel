import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-plan-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const P = await import('../public/planner.js');
const { shapeProblems } = await import('../src/sources/varsom.js');
const { bulletinDays, snapshotDay } = await import('../src/outlook.js');
const { createServer } = await import('../src/server.js');

test('aspects: ranges go the short way round; varied is everything', () => {
  assert.deepEqual(P.parseAspect('N–E'), ['N', 'NE', 'E']);
  assert.deepEqual(P.parseAspect('N–W').sort(), ['N', 'NW', 'W']);
  assert.deepEqual(P.parseAspect('W–SW').sort(), ['SW', 'W']);
  assert.deepEqual(P.parseAspect('NW'), ['NW']);
  assert.equal(P.parseAspect('varied').length, 8);
  assert.deepEqual(P.problemAspects('11100011'), ['N', 'NE', 'E', 'W', 'NW']);
});

test('Varsom problem areas are kept, in the verified field names', () => {
  const [p] = shapeProblems([{ AvalancheProblemTypeName: 'Persistent weak layer (slab avalanches)', ValidExpositions: '11100011', ExposedHeight1: 300, ExposedHeight2: 300, ExposedHeightFill: 1, AvalProbabilityName: 'Possible', DestructiveSizeName: '2 - Medium' }]);
  assert.equal(p.aspects, '11100011');
  assert.deepEqual(p.heights, { fill: 1, h1: 300, h2: 300 });
  assert.equal(p.size, '2 - Medium');
  assert.equal(shapeProblems([{ ValidExpositions: 'nonsense' }])[0].aspects, null, 'garbage is not trusted');
  assert.deepEqual(P.problemBands({ fill: 2, h1: 800, h2: 800 }), [[-Infinity, 800]]);
  assert.deepEqual(P.problemBands({ fill: 4, h1: 1200, h2: 600 }), [[600, 1200]]);
  assert.deepEqual(P.problemBands({ fill: 3, h1: 1200, h2: 600 }), [[-Infinity, 600], [1200, Infinity]]);
});

const tour = (o = {}) => ({ name: 'T', region: 'r', aspect: 'NW', difficulty: 2, quality: 4, summit_m: 1200, vertical_m: 1000, snow: { depthCm: 150, new72: 25 }, lat: 69, lon: 19, ...o });
const windslabNE = { type: 'Wind slab', aspects: '01110000', heights: { fill: 1, h1: 600, h2: 600 } };

test('problem areas: aspect and elevation must both overlap', () => {
  assert.equal(P.problemsHit(tour({ aspect: 'NW' }), [windslabNE]).length, 0);
  assert.equal(P.problemsHit(tour({ aspect: 'N–E' }), [windslabNE]).length, 1);
  assert.equal(P.problemsHit(tour({ aspect: 'E', summit_m: 500, vertical_m: 400 }), [windslabNE]).length, 0, 'tour stays below 600 m');
});

test('the avalanche filter excludes rather than marks down', () => {
  const prefs = { maxDanger: 4, maxDifficulty: 5 };
  const day = (danger, problems = []) => ({ danger, problems });
  assert.equal(P.gate(tour({ difficulty: 4 }), day(4), prefs).status, 'excluded');
  assert.equal(P.gate(tour({ difficulty: 1 }), day(4), prefs).status, 'caution');
  assert.equal(P.gate(tour({ difficulty: 1, aspect: 'E' }), day(4, [windslabNE]), prefs).status, 'excluded', 'inside the problem at danger 4');
  assert.equal(P.gate(tour({ difficulty: 2 }), day(3), prefs).status, 'ok');
  assert.equal(P.gate(tour({ difficulty: 2, aspect: 'E' }), day(3, [windslabNE]), prefs).status, 'caution');
  assert.equal(P.gate(tour({ difficulty: 4 }), day(3), prefs).status, 'excluded');
  assert.equal(P.gate(tour({ difficulty: 5 }), day(2), prefs).status, 'ok');
  assert.equal(P.gate(tour({ difficulty: 2 }), day(5), prefs).status, 'excluded');
  assert.equal(P.gate(tour(), day(3), { maxDanger: 2 }).status, 'excluded', 'your own limit');
  assert.match(P.gate(tour(), day(3), { maxDanger: 2 }).why, /above your limit of 2/);
  assert.equal(P.gate(tour(), day(null), prefs).status, 'unassessed');
  assert.equal(P.gate(tour(), null, prefs).status, 'unassessed');
});

test('base: nothing at 20 cm, full marks from 100 cm, 100 and 300 cm the same', () => {
  assert.equal(P.baseScore(20), 0);
  assert.equal(P.baseScore(10), 0);
  assert.equal(P.baseScore(60), 0.5);
  assert.equal(P.baseScore(100), 1);
  assert.equal(P.baseScore(300), 1);
  assert.equal(P.baseScore(null), null);
});

const fc = (over = {}) => ({ elevation: 1200, days: Array.from({ length: 5 }, (_, i) => ({ date: `2027-02-1${i}`, code: 0, label: 'Clear', tMax: -6, tMin: -12, precipMm: 0, snowCm: 0, windMax: 4, gustMax: 8, freezingLevel: 0, ...over })) });

test('conditions: reasons for thin cover, crust, wind, carry skis', () => {
  const thin = P.conditions(tour({ difficulty: 3, snow: { depthCm: 45, new72: 0 } }), fc(), 0, {});
  assert.ok(thin.why.some((w) => /thin cover: 45 cm where ~70 cm/.test(w)));
  const warm = P.conditions(tour(), fc({ tMax: 3 }), 0, {});
  assert.ok(warm.why.some((w) => /crust/.test(w)));
  const windy = P.conditions(tour(), fc({ windMax: 16, gustMax: 25 }), 0, {});
  assert.ok(windy.why.some((w) => /wind-affected/.test(w)));
  assert.ok(windy.parts.weather <= 0.3, 'strong gusts cap the weather part');
  const carry = P.conditions(tour({ snowStart: { depthCm: 5 } }), fc(), 0, {});
  assert.match(carry.startNote, /carry skis/);
  const fromCar = P.conditions(tour({ snowStart: { depthCm: 80 } }), fc(), 0, {});
  assert.equal(fromCar.startNote, 'skiable from the car');
  const rain = P.conditions(tour(), fc({ freezingLevel: 1500 }), 0, {});
  assert.ok(rain.why.includes('0° level above the summit'));
});

test('fresh snow ages and forecast snow adds up', () => {
  const d0 = P.conditions(tour({ snow: { depthCm: 150, new72: 20 } }), fc(), 0, {});
  const d2 = P.conditions(tour({ snow: { depthCm: 150, new72: 20 } }), fc(), 2, {});
  assert.ok(d2.freshCm < d0.freshCm);
  const snowy = fc();
  snowy.days[0].snowCm = 15;
  const after = P.conditions(tour({ snow: { depthCm: 150, new72: 0 } }), snowy, 1, {});
  assert.equal(after.freshCm, 15);
});

test('distance counts only when you give a starting point', () => {
  const near = P.conditions(tour(), fc(), 0, { from: { lat: 69, lon: 19 } });
  const far = P.conditions(tour(), fc(), 0, { from: { lat: 59.9, lon: 10.7 } });
  assert.ok(near.parts.fit > far.parts.fit);
  assert.ok(far.km > 900);
});

test('plan: bulletins reused ahead are labelled; excluded tours never rank above passing ones', () => {
  const tours = [
    tour({ name: 'Steep powder', difficulty: 4, quality: 5, snow: { depthCm: 250, new72: 35 } }),
    tour({ name: 'Mellow', difficulty: 1, quality: 3, snow: { depthCm: 120, new72: 10 } }),
    tour({ name: 'Too hard', difficulty: 5 }),
  ];
  const outlook = {
    bulletins: { r: [{ date: '2027-02-10', danger: 3, problems: [] }, { date: '2027-02-11', danger: 3, problems: [] }] },
    forecasts: Object.fromEntries(tours.map((t) => [t.name, fc()])),
  };
  const p = P.plan({ tours, outlook, prefs: { maxDifficulty: 4, maxDanger: 3 } });
  assert.equal(p.hiddenByDifficulty, 1);
  assert.deepEqual(p.dates, ['2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13', '2027-02-14']);
  const d0 = p.days[0].rows;
  assert.equal(d0[0].tour, 'Mellow', 'the passing tour ranks first despite a lower score');
  assert.equal(d0[1].status, 'excluded');
  assert.ok(d0[1].score > d0[0].score, 'even though the excluded one scores higher');
  assert.equal(d0[0].confidence, 'high');
  const d3 = p.days[3].rows[0];
  assert.equal(d3.assumed, true);
  assert.match(d3.avalanche, /as of the 2027-02-11 bulletin/);
  assert.notEqual(d3.confidence, 'high');
  assert.equal(p.days[4].rows[0].confidence, 'low');
});

test('bulletin days: Swedish (undated) bulletins count as the snapshot day', () => {
  const se = { bulletin: { source: 'lavinprognoser', danger: 3, problems: [] } };
  assert.deepEqual(bulletinDays(se, '2027-02-10').map((b) => b.date), ['2027-02-10']);
  const no = { bulletin: { source: 'varsom', validFrom: '2027-02-10T00:00:00', danger: 3, problems: [], outlook: [{ validFrom: '2027-02-11T00:00:00', danger: 2, problems: [] }] } };
  assert.deepEqual(bulletinDays(no).map((b) => [b.date, b.danger]), [['2027-02-10', 3], ['2027-02-11', 2]]);
  assert.equal(snapshotDay({ regions: [no, se], fetchedAt: '2027-02-10T05:00:00Z' }), '2027-02-10');
});

test('/api/outlook serves bulletins and every tour forecast, one request per tour', async () => {
  await mkdir(path.join(tmp), { recursive: true });
  const snapshot = {
    fetchedAt: '2027-02-10T06:00:00Z',
    regions: [{ id: 'lyngen', country: 'NO', bulletin: { source: 'varsom', validFrom: '2027-02-10T00:00:00', danger: 3, problems: [], outlook: [] } }],
    tours: [],
  };
  await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify(snapshot));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v1/forecast')) {
      calls++;
      const days = ['2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13', '2027-02-14'];
      return new Response(JSON.stringify({ elevation: 1000, daily: { time: days, weather_code: [0, 0, 0, 0, 0], temperature_2m_max: [-5, -5, -5, -5, -5], temperature_2m_min: [-9, -9, -9, -9, -9], precipitation_sum: [0, 0, 0, 0, 0], snowfall_sum: [0, 0, 0, 0, 0], wind_speed_10m_max: [4, 4, 4, 4, 4], wind_gusts_10m_max: [7, 7, 7, 7, 7], wind_direction_10m_dominant: [0, 0, 0, 0, 0] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  try {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const o = await (await fetch(`${base}/api/outlook`)).json();
    await new Promise((r) => server.close(r));
    const { loadTours } = await import('../src/config.js');
    const n = (await loadTours()).length;
    assert.equal(Object.keys(o.forecasts).length, n);
    assert.equal(calls, n, 'one forecast request per tour');
    assert.equal(o.bulletins.lyngen[0].date, '2027-02-10');
    assert.equal(o.failed, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('explanation box shows the working: filter, parts, points that add up, method', async () => {
  const { explainHtml } = await import('../public/explain.js');
  const tours = [tour({ name: 'Mellow', difficulty: 1, quality: 3, snow: { depthCm: 60, new72: 10 } }), tour({ name: 'Steep', difficulty: 4 })];
  const outlook = { bulletins: { r: [{ date: '2027-02-10', danger: 3, problems: [windslabNE] }] }, forecasts: { Mellow: fc(), Steep: fc() } };
  const p = P.plan({ tours, outlook, prefs: { maxDifficulty: 5, maxDanger: 3 } });
  const ok = p.days[0].rows.find((r) => r.tour === 'Mellow');
  const html = explainHtml(ok, { dayLabel: 'Today 10.02' });
  assert.match(html, /Avalanche filter: Passes/);
  assert.match(html, /60 cm<\/b> modelled/);
  assert.match(html, /full marks from 100 cm/);
  const nums = html.match(/xsum">([^<]+)=/)[1].split('+').map(Number);
  assert.ok(Math.abs(nums.reduce((a, b) => a + b, 0) - ok.score) <= 1, 'the points add up to the score');
  assert.match(html, /In general/);
  const ex = p.days[0].rows.find((r) => r.tour === 'Steep');
  assert.match(explainHtml(ex), /Excluded[\s\S]*never ranked/);
});

test('"Refresh now" has a cooldown: a fresh snapshot is returned without asking upstream', async () => {
  await writeFile(path.join(tmp, 'cache', 'current.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), status: 'ok', regions: [], tours: [] }));
  let upstream = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('http://127.0.0.1')) upstream++;
    return realFetch(url, opts);
  };
  try {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const r = await (await realFetch(`http://127.0.0.1:${server.address().port}/api/refresh`, { method: 'POST' })).json();
    await new Promise((res) => server.close(res));
    assert.equal(r.cooldown, true);
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no-forecast areas: gentle tours ranked with caution and "own judgement", steeper ones not', () => {
  const day = { date: '2027-02-10', danger: null, problems: [], noForecast: true };
  const gentle = P.gate(tour({ difficulty: 1 }), day, { maxDanger: 3 });
  assert.equal(gentle.status, 'caution');
  assert.match(gentle.why, /your own judgement/);
  assert.equal(P.gate(tour({ difficulty: 3 }), day, { maxDanger: 3 }).status, 'unassessed');
  const p = P.plan({ tours: [tour({ name: 'Städjan', difficulty: 1 })], outlook: { bulletins: { r: [day] }, forecasts: { Städjan: fc() } } });
  assert.equal(p.days[0].rows[0].status, 'caution');
  assert.equal(p.days[0].rows[0].confidence, 'noforecast');
  assert.equal(p.days[2].rows[0].confidence, 'noforecast', 'reused for later days, still labelled');
  assert.doesNotMatch(p.days[2].rows[0].avalanche, /bulletin/, 'no talk of a bulletin where none exists');
});
