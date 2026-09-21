import test from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, osloOffset, hhmm, daylightText } from '../public/daylight.js';
import { dayWindow, tourHours, hourScore, wetHours, isWetProblem } from '../public/daywindow.js';
import { snowQuality, windRelation, CORN_HOURS } from '../public/snowquality.js';
import { planTrip } from '../public/areaplan.js';
import * as P from '../public/planner.js';

/* ---------- helpers: a columnar hourly series ---------- */

function hourly(dates, fn) {
  const out = { time: [], temp: [], wind: [], gust: [], dir: [], cloud: [], snow: [], precip: [], fl: [] };
  for (const d of dates) {
    for (let h = 0; h < 24; h++) {
      const v = { temp: -5, wind: 3, gust: 6, dir: 270, cloud: 10, snow: 0, precip: 0, fl: 0, ...fn(d, h) };
      out.time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      for (const k of Object.keys(out)) if (k !== 'time') out[k].push(v[k]);
    }
  }
  return out;
}
const TROMSO = { lat: 69.65, lon: 18.96 };
const JOTUN = { lat: 61.6, lon: 8.3 };

/* ---------- daylight ---------- */

test('daylight: Oslo midwinter sunrise and sunset, CET/CEST switch', () => {
  const s = sunTimes('2026-12-21', 59.91, 10.75);
  assert.ok(Math.abs(s.sunrise - 9.3) < 0.1, `sunrise ${hhmm(s.sunrise)}`);
  assert.ok(Math.abs(s.sunset - 15.2) < 0.1, `sunset ${hhmm(s.sunset)}`);
  assert.equal(s.polarNight, false);
  assert.equal(osloOffset('2027-01-15'), 1);
  assert.equal(osloOffset('2027-04-15'), 2);
  assert.equal(osloOffset('2027-03-27'), 1, 'day before the last Sunday of March');
  assert.equal(osloOffset('2027-03-28'), 2);
});

test('daylight: Tromsø has polar night with twilight in December and midnight sun in June', () => {
  const dec = sunTimes('2026-12-21', TROMSO.lat, TROMSO.lon);
  assert.equal(dec.polarNight, true);
  assert.equal(dec.sunrise, null);
  assert.ok(dec.lightH > 3.5 && dec.lightH < 5.5, `civil twilight ${dec.lightH} h`);
  assert.match(daylightText(dec), /polar night · twilight 09:\d\d–1[34]:\d\d/);
  const jun = sunTimes('2027-06-21', TROMSO.lat, TROMSO.lon);
  assert.equal(jun.midnightSun, true);
  assert.deepEqual(jun.light, { start: 0, end: 24 });
  assert.equal(daylightText(jun), 'midnight sun');
});

/* ---------- day window ---------- */

test('tour time: 400 m/h up, 1500 m/h down, half an hour extra', () => {
  assert.equal(tourHours({ vertical_m: 1200 }), 4.25);
  assert.equal(tourHours({}), 4);
});

test('day window: calm morning, gale in the afternoon, so go early', () => {
  const h = hourly(['2027-03-10'], (d, hr) => ({ wind: hr < 12 ? 3 : 16, gust: hr < 12 ? 6 : 25 }));
  const w = dayWindow({ ...JOTUN, vertical_m: 900 }, h, '2027-03-10');
  assert.equal(w.fit, 'fits');
  assert.ok(w.start >= 6 && w.end <= 12, `window ${w.start}–${w.end}`);
  assert.ok(w.score > 0.8);
  assert.ok(hourScore(h, 15) <= 0.3, 'gusts ≥ 17 cap the hour');
});

test('day window: a long tour does not fit the Tromsø polar night', () => {
  const h = hourly(['2026-12-21'], () => ({}));
  const long = dayWindow({ ...TROMSO, vertical_m: 1400 }, h, '2026-12-21');
  assert.equal(long.fit, 'no');
  const short = dayWindow({ ...TROMSO, vertical_m: 500 }, h, '2026-12-21');
  assert.notEqual(short.fit, 'no');
  assert.equal(dayWindow({ ...TROMSO }, h, '2026-12-22'), null, 'no hours for that date');
});

/* ---------- snow quality ---------- */

const stormThenClear = (dir, { warm = false } = {}) =>
  hourly(['2027-02-08', '2027-02-09', '2027-02-10'], (d, hr) =>
    d === '2027-02-10'
      ? { temp: -8, wind: 2 }
      : { snow: 0.5, wind: 12, dir, cloud: 100, temp: warm && d === '2027-02-09' && hr > 10 ? 2 : -6 });

test('wind relation: lee, windward, cross', () => {
  assert.equal(windRelation('NE', 225), 'lee', 'SW wind loads NE');
  assert.equal(windRelation('SW', 225), 'windward');
  assert.equal(windRelation('SE', 225), 'cross');
});

test('snow quality: wind while it snowed loads the lee and scours the windward side', () => {
  const h = stormThenClear(225);
  const lee = snowQuality(['NE'], h, '2027-02-10');
  const wind = snowQuality(['SW'], h, '2027-02-10');
  assert.equal(lee.label, 'wind-loaded');
  assert.equal(lee.windFrom, 'SW');
  assert.equal(wind.label, 'scoured');
  assert.ok(wind.factor < lee.factor);
  assert.ok(lee.snowCm >= 20);
});

test('snow quality: warming after the snow makes crust; cold and calm keeps powder', () => {
  const crust = snowQuality(['S'], stormThenClear(225, { warm: true }), '2027-02-10');
  assert.equal(crust.label, 'sun crust');
  assert.ok(crust.factor <= 0.55);
  const calm = hourly(['2027-02-08', '2027-02-09', '2027-02-10'], (d) => (d === '2027-02-10' ? { temp: -12 } : { snow: 0.4, temp: -10 }));
  const q = snowQuality(['N'], calm, '2027-02-10');
  assert.equal(q.label, 'powder');
  assert.equal(q.factor, 1);
  assert.ok(q.notes.some((n) => /powder holds, best on north/.test(n[0])));
});

test('snow quality: spring corn on sunny aspects, timed by aspect', () => {
  const h = hourly(['2027-04-08', '2027-04-09', '2027-04-10'], (d, hr) => ({ temp: hr < 8 ? -4 : 4, cloud: 5 }));
  const se = snowQuality(['SE'], h, '2027-04-10');
  assert.equal(se.label, 'corn');
  assert.equal(se.floor, 0.8);
  assert.deepEqual([se.timing.start, se.timing.end], CORN_HOURS.SE);
  const w = snowQuality(['W'], h, '2027-04-10');
  assert.ok(w.timing.start > se.timing.start, 'west softens later');
  assert.notEqual(snowQuality(['N'], h, '2027-04-10').label, 'corn');
});

/* ---------- planner with hourly data ---------- */

const T = (o) => ({ name: 'A', region: 'r', lat: 61.6, lon: 8.3, summit_m: 1800, vertical_m: 1000, difficulty: 2, quality: 4, aspect: 'NE', snow: { depthCm: 150, new72: 0 }, ...o });
const daysFor = (dates) => dates.map((date) => ({ date, code: 1, label: 'Mainly clear', tMax: -3, tMin: -9, snowCm: 0, precipMm: 0, windMax: 16, gustMax: 25, freezingLevel: 0 }));

test('planner: hourly window replaces the daily summary and says when to go', () => {
  const dates = ['2027-03-10', '2027-03-11', '2027-03-12', '2027-03-13', '2027-03-14'];
  const h = hourly(['2027-03-08', '2027-03-09', ...dates], (d, hr) => ({ wind: hr < 12 ? 3 : 16, gust: hr < 12 ? 6 : 25 }));
  const daily = P.conditions(T(), { elevation: 1800, days: daysFor(dates) }, 0, {});
  const hourlyC = P.conditions(T(), { elevation: 1800, days: daysFor(dates), hourly: h }, 0, {});
  assert.ok(hourlyC.parts.weather > daily.parts.weather + 0.3, 'a calm morning rescues a day with a windy afternoon');
  assert.ok(hourlyC.why.some((w) => /^go 0\d–1[0-2]$/.test(w)), hourlyC.why.join(' | '));
  assert.equal(hourlyC.window.fit, 'fits');
  assert.equal(hourlyC.explain.weather.window, hourlyC.window.text);
});

test('planner: a tour longer than the daylight is marked down', () => {
  const dates = ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25'];
  const h = hourly(dates, () => ({}));
  const fc = { elevation: 1500, days: daysFor(dates).map((d) => ({ ...d, windMax: 3, gustMax: 6 })), hourly: h };
  const short = P.conditions(T({ ...TROMSO, vertical_m: 500 }), fc, 0, {});
  const long = P.conditions(T({ ...TROMSO, vertical_m: 1500 }), fc, 0, {});
  assert.ok(long.parts.weather < short.parts.weather * 0.6);
  assert.ok(long.why.some((w) => w.startsWith('longer than the daylight')));
});

/* ---------- a few days in one area ---------- */

test('area trip: one different tour a day, rest days count zero, best area first', () => {
  const row = (tour, region, score, status = 'ok') => ({ tour, region, score, status });
  const p = {
    days: [
      { date: 'd0', k: 0, rows: [row('A1', 'a', 80), row('A2', 'a', 70), row('B1', 'b', 90), row('C1', 'c', 60, 'excluded')] },
      { date: 'd1', k: 1, rows: [row('A1', 'a', 85), row('A2', 'a', 75), row('B1', 'b', 95), row('C1', 'c', 60, 'excluded')] },
      { date: 'd2', k: 2, rows: [row('A1', 'a', 60), row('A2', 'a', 65), row('B1', 'b', 95), row('C1', 'c', 60, 'excluded')] },
    ],
  };
  const t = planTrip(p, { start: 0, length: 3 });
  assert.deepEqual(t.areas.map((a) => a.region), ['a', 'b'], 'c never passes, so it is not an area');
  const a = t.areas[0];
  assert.deepEqual(a.days.map((d) => d.row?.tour ?? null), ['A1', 'A2', null], 'A1 day 1, A2 day 2, then nothing left');
  assert.equal(a.restDays, 1);
  assert.equal(a.mean, Math.round((80 + 75) / 3));
  assert.equal(t.areas[1].mean, Math.round(90 / 3), 'one great tour is one day, not three');
  const late = planTrip(p, { start: 2, length: 3 });
  assert.equal(late.length, 1, 'clamped to the forecast');
});

/* ---------- wet snow: the afternoon thaw ---------- */

// A clear, calm day that goes above zero after lunch (summit temperatures).
const thawDay = (iso) => hourly([iso], (d, hr) => ({ temp: hr < 11 ? -6 : -1 + (hr - 11) * 0.8, cloud: 5, wind: 2, gust: 4 }));
const WET = { type: 'Wet loose snow avalanche', problemType: 'Wet snow' };

test('wet snow: thaw at mid-height marks the afternoon, and it stays soft', () => {
  const t = { ...JOTUN, vertical_m: 800 }; // mid-height ~2.6° warmer than the summit
  const w = wetHours(t, thawDay('2027-02-10'), '2027-02-10');
  assert.equal(w.from, 11, 'summit −1° + 2.6° at mid-height ≥ +1°');
  assert.equal(w.reason, 'thaw');
  assert.ok(w.hours.has(16) && !w.hours.has(10));
  assert.equal(isWetProblem(WET), true);
  assert.equal(isWetProblem({ problemType: 'Wind slab' }), false);
  assert.equal(isWetProblem({ problemType: 'Gliding snow' }), true);
});

test('wet snow: a wet-snow problem in the bulletin makes the thaw a hard limit', () => {
  const t = { ...JOTUN, vertical_m: 800 }; // ~3 h
  const h = thawDay('2027-02-10');
  const soft = dayWindow(t, h, '2027-02-10');
  const hard = dayWindow(t, h, '2027-02-10', { problems: [WET] });
  assert.ok(hard.end <= hard.wet.from, `off the slope by ${hard.wet.from}, window ${hard.start}–${hard.end}`);
  assert.equal(hard.wetInWindow, 0);
  assert.ok(soft.end <= 11, 'even without the bulletin the wet hours score poor, so the window comes earlier');
  assert.equal(hard.hours.find((x) => x.h === 14).wet, true);
});

test('wet snow: spring sun on a south face softens it before the air thaws', () => {
  const iso = '2027-04-12';
  const h = hourly([iso], (d, hr) => ({ temp: -4, cloud: 5, wind: 2, gust: 4 }));
  const t = { ...JOTUN, vertical_m: 600 };
  const south = wetHours(t, h, iso, { aspects: ['S'] });
  assert.equal(south.from, 10);
  assert.equal(south.reason, 'sun');
  assert.equal(wetHours(t, h, iso, { aspects: ['N'] }).from, null, 'north stays cold');
});

test('wet snow: a tour too long to finish before the thaw is marked down and says so', () => {
  const dates = ['2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13', '2027-02-14'];
  const h = hourly(dates, (d, hr) => ({ temp: hr < 10 ? -6 : 0.5, cloud: 5, wind: 2, gust: 4 }));
  const fc = { elevation: 1800, days: daysFor(dates).map((d) => ({ ...d, windMax: 2, gustMax: 4 })), hourly: h };
  const short = P.conditions(T({ vertical_m: 500 }), fc, 0, {}, { problems: [WET] });
  const long = P.conditions(T({ vertical_m: 1500 }), fc, 0, {}, { problems: [WET] });
  assert.ok(short.why.some((w) => /^off the slope by \d\d: wet snow after \(wet-snow problem in the bulletin\)$/.test(w)), short.why.join(' | '));
  assert.equal(long.window.fit, 'wet');
  assert.ok(long.why.some((w) => w.startsWith('too long to finish before wet snow')));
  assert.ok(long.parts.weather < short.parts.weather);
});
