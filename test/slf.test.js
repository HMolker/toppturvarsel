import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shapeSwiss, aspectBits, heightBand } from '../src/sources/slf.js';
import { shapeSwissSnow, pickStation } from '../src/sources/slfsnow.js';
import { problemKey } from '../public/avalanche.js';
import { problemBands, problemsHit } from '../public/planner.js';

/**
 * Switzerland (v6): SLF's CAAMLv6 bulletin and IMIS snow stations. The first
 * bulletin in the fixture is SLF's own for 15 Feb 2026 (read from the live
 * API with ?activeAt=); the second is made up in the same shape to cover a
 * spring day (morning and afternoon levels, wet snow below a height).
 */

const body = JSON.parse(await readFile(new URL('./fixtures/slf-bulletins.json', import.meta.url), 'utf8'));
const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const swiss = regions.filter((r) => r.country === 'CH');

test('every Swiss region names an SLF micro-region', () => {
  assert.ok(swiss.length >= 10);
  for (const r of swiss) assert.match(r.slfRegion, /^CH-\d{4}$/, r.id);
});

test('a bulletin reaches each region through its micro-region', () => {
  const out = shapeSwiss(body, swiss);
  const zermatt = out['ch-4222'];
  assert.equal(zermatt.source, 'slf');
  assert.equal(zermatt.danger, 3);
  assert.equal(zermatt.dangerSub, '+');
  assert.equal(zermatt.publishTime, '2026-02-15T07:00:00Z');
  assert.match(zermatt.headline, /considerable.*3\+.*above 2000m/i);
  // One description, not one per problem.
  assert.equal(zermatt.description.match(/strong northerly wind/g).length, 1);
  assert.doesNotMatch(zermatt.description, /<br/);
  assert.deepEqual(zermatt.problems.map((p) => problemKey(p.problemType)), ['windSlab', 'persistent']);
  assert.equal(zermatt.problems[0].aspects, '11111111');
  assert.deepEqual(zermatt.problems[0].heights, { fill: 1, h1: 2000, h2: 2000 });
  // Saas Fee and Arolla are in the same bulletin; Samnaun is in none.
  assert.equal(out['ch-4223'].danger, 3);
  assert.equal(out['ch-7121'].danger, null);
  assert.equal(out['ch-7121'].outOfSeason, false);
});

test('a spring day: the higher afternoon level leads, wet snow sits below its height', () => {
  const davos = shapeSwiss(body, swiss)['ch-5123'];
  assert.equal(davos.danger, 2);
  assert.equal(davos.dangerSub, '−');
  assert.deepEqual(davos.dangerRatings.map((r) => [r.period, r.danger]), [['earlier', 1], ['later', 2]]);
  const [wet, glide] = davos.problems;
  assert.equal(problemKey(wet.problemType), 'wetSnow');
  assert.equal(wet.aspects, '00111110');
  assert.deepEqual(problemBands(wet.heights), [[-Infinity, 2400]]);
  assert.equal(problemKey(glide.problemType), 'gliding');
  assert.deepEqual(problemBands(glide.heights), [[1800, 2600]]);
  // The planner reads them like Varsom's: a south-facing tour at 2000-3000 m meets both.
  const hit = problemsHit({ aspect: 'S', summit_m: 3000, vertical_m: 1000 }, davos.problems);
  assert.equal(hit.length, 2);
});

test('out of season SLF publishes nothing, and the page says so', () => {
  const out = shapeSwiss({ bulletins: [] }, swiss);
  assert.equal(out['ch-4222'].danger, null);
  assert.equal(out['ch-4222'].outOfSeason, true);
  assert.match(out['ch-4222'].headline, /no bulletin/i);
  assert.throws(() => shapeSwiss({ nope: 1 }, swiss), /unexpected response shape/);
});

test('aspects and heights convert both ways round', () => {
  assert.equal(aspectBits(['N', 'NE', 'NW']), '11000001');
  assert.equal(aspectBits([]), '11111111');
  assert.equal(heightBand({ lowerBound: 'treeline' }), null);
  assert.deepEqual(heightBand({ lowerBound: 1800, upperBound: 2600 }), { fill: 4, h1: 1800, h2: 2600 });
  assert.deepEqual(heightBand({ upperBound: '2200' }), { fill: 2, h1: 2200, h2: 2200 });
});

/* ---------- IMIS snow ---------- */

const stations = [
  { code: 'ZER2', label: 'Zermatt Triftchumme', lat: 46.0, lon: 7.7, elevation: 2700 },
  { code: 'ZER1', label: 'Zermatt Village', lat: 46.02, lon: 7.75, elevation: 1600 },
  { code: 'FAR', label: 'Far away', lat: 47.4, lon: 9.4, elevation: 2500 },
];
const day = (code, d, HS, HN_1D) => ({ station_code: code, measure_date: `2026-02-${d}T06:00:00Z`, HS, HN_1D });
const rows = [
  day('ZER2', 10, 150, 0), day('ZER2', 11, 150, 0), day('ZER2', 12, 160, 12), day('ZER2', 13, 185, 30), day('ZER2', 14, 190, 8),
  day('ZER1', 14, 40, 5),
];

test('a tour takes the near station at a similar height', () => {
  const high = pickStation(stations, { lat: 45.99, lon: 7.72, ele: 2800 });
  assert.equal(high.code, 'ZER2');
  const low = pickStation(stations, { lat: 46.02, lon: 7.75, ele: 1500 });
  assert.equal(low.code, 'ZER1');
  assert.equal(pickStation(stations, { lat: 45.0, lon: 6.0 }), null);
});

test('depth is the last reading; new snow sums the daily values', () => {
  const out = shapeSwissSnow([{ key: 'Breithorn (Zermatt)', lat: 45.94, lon: 7.75, ele: 3900 }], stations, rows);
  const s = out['Breithorn (Zermatt)'];
  assert.equal(s.source, 'slf');
  assert.equal(s.depthCm, 190);
  assert.equal(s.new24, 8);
  assert.equal(s.new48, 38);
  assert.equal(s.new72, 50);
  assert.equal(s.gridAltitude, 2700);
  assert.equal(s.station.code, 'ZER2');
  assert.ok(s.station.km > 5 && s.station.km < 10);
  assert.equal(s.observedAt, '2026-02-14T06:00:00Z');
});

test('a station without readings is passed over; none near is an error, not a zero', () => {
  const out = shapeSwissSnow(
    [{ key: 'a', lat: 46.0, lon: 7.7, ele: 2700 }, { key: 'b', lat: 45.0, lon: 6.0 }],
    stations,
    [day('ZER1', 14, 40, 5), day('ZER2', 14, null, null)],
  );
  assert.equal(out.a.station.code, 'ZER1');
  assert.match(out.b.error, /no SLF station/);
  assert.equal(out.b.depthCm, undefined);
});
