import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-verify-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.SKILL_MIN_CASES = '5';

const {
  cellOf, cellsFor, climatology, emptyTally, addCase, scoreOf, aggregate,
  rowsOf, skillUrl, collectAndScore, getSkill, LEADS, PARAMS, PARAM_KEYS,
} = await import('../src/verify.js');

test('cells: places within 25 km share a cell, and the cell is named after what is in it', () => {
  const a = cellOf(60.860, 8.517);
  const b = cellOf(60.868, 8.530);
  assert.equal(a.key, b.key, 'two tours a kilometre apart are one cell');
  assert.notEqual(a.key, cellOf(61.4, 8.517).key, '60 km north is another cell');
  assert.ok(Math.abs(a.lat - 60.86) < 0.15 && Math.abs(a.lon - 8.52) < 0.3, 'the centre is inside the cell');

  const cells = cellsFor([
    { name: 'Nibbi', lat: 60.86, lon: 8.517, kind: 'tour', elevation: 1424 },
    { name: 'Skogshorn', lat: 60.868, lon: 8.53, kind: 'tour', elevation: 1728 },
    { name: 'Hemsedal', lat: 60.862, lon: 8.52, kind: 'resort' },
    { name: 'Gaustatoppen', lat: 59.85, lon: 8.65, kind: 'tour' },
    { name: 'no position', lat: null, lon: null, kind: 'tour' },
  ]);
  assert.equal(cells.length, 2);
  const hemsedal = cells.find((c) => c.names.includes('Nibbi'));
  assert.deepEqual([hemsedal.tours, hemsedal.resorts], [2, 1]);
  assert.equal(hemsedal.label, 'Nibbi');
  assert.equal(hemsedal.elevation, 1728);
});

test('scoring: skill is the error against saying "normal", and stays quiet until there are enough days', () => {
  // A climatology needs a score of observations before it is trusted.
  const winter = [-6, -2, 0, -9, -4, -1, -7, -3, -5, -8, -2, -11, -3, 1, -6, -4, -9, -2, -5, -7, -1, -8, -3, -6];
  const clim = climatology(winter);
  assert.equal(clim.n, 24);
  assert.ok(clim.mae > 2 && clim.mae < 4);

  const t = emptyTally();
  // Five days, each missed by 1 °C — well inside the spread of the climate.
  for (const [f, o] of [[-5, -4], [-3, -2], [-8, -7], [-1, 0], [-6, -5]]) addCase(t, f, o);
  const s = scoreOf(t, clim);
  assert.equal(s.n, 5);
  assert.equal(s.enough, true);
  assert.equal(s.mae, 1);
  assert.equal(s.bias, -1, 'every forecast was a degree too cold');
  assert.ok(s.skill > 0.6, `a 1 °C miss against a ${clim.mae.toFixed(1)} °C spread is real skill (${s.skill})`);

  const thin = emptyTally();
  addCase(thin, 0, 1);
  assert.deepEqual(scoreOf(thin, clim), { n: 1, enough: false });
  assert.equal(scoreOf(t, null).skill, undefined, 'no climatology, no skill score');
  assert.equal(scoreOf(t, { n: 3, mean: 0, mae: 3 }).skill, undefined, 'too little climatology, no skill score');

  const useless = emptyTally();
  for (let i = 0; i < 6; i++) addCase(useless, 10, -5);
  assert.equal(scoreOf(useless, clim).skill, 0, 'worse than climatology floors at zero, never negative');
});

test('scoring: a yes/no event gives hit rate and false alarms', () => {
  const t = emptyTally();
  //          forecast, observed  (5 cm event)
  for (const [f, o] of [[8, 9], [7, 1], [1, 6], [0, 0], [9, 12], [2, 0]]) addCase(t, f, o, 5);
  assert.deepEqual([t.hit, t.miss, t.fa, t.cn], [2, 1, 1, 2]);
  const snowDays = [0, 1, 9, 3, 0, 12, 4, 0, 6, 2, 0, 7, 1, 0, 5, 3, 0, 8, 0, 2, 11, 0, 1, 4];
  const s = scoreOf(t, climatology(snowDays), { event: 5 });
  assert.equal(s.pod, 0.667, 'two of the three snowy days were forecast');
  assert.equal(s.far, 0.333, 'one of the three forecast days stayed dry');
  assert.ok(s.eventSkill > 0 && s.eventSkill <= 1);
});

test('scoring: a cloud event counts the days BELOW the threshold (a bluebird day)', () => {
  const t = emptyTally();
  for (const [f, o] of [[10, 12], [20, 80], [90, 95], [15, 18]]) addCase(t, f, o, 30, true);
  assert.deepEqual([t.hit, t.miss, t.fa, t.cn], [2, 0, 1, 1]);
});

test('aggregate: the four parameters, weighted, ignoring the ones without a score', () => {
  const per = {
    snow: { enough: true, skill: 0.2, n: 40 },
    temp: { enough: true, skill: 0.8, n: 40 },
    cloud: { enough: true, skill: 0.4, n: 40 },
    wind: { enough: true, skill: 0.6, n: 40 },
  };
  const a = aggregate(per);
  assert.equal(a.skill, +(0.4 * 0.2 + 0.25 * 0.8 + 0.15 * 0.4 + 0.2 * 0.6).toFixed(3));
  assert.equal(a.of, 1);

  const partial = aggregate({ ...per, snow: { enough: false, n: 3 }, cloud: { enough: false, n: 0 } });
  assert.equal(partial.of, 0.45, 'only temperature and wind counted');
  assert.equal(partial.skill, +((0.25 * 0.8 + 0.2 * 0.6) / 0.45).toFixed(3));
  assert.equal(aggregate({}).enough, false);
});

test('the request asks for 16 days and the days just gone, for several points at once', () => {
  const u = skillUrl([{ lat: 60.86, lon: 8.51 }, { lat: 63.4, lon: 13.08 }]);
  assert.match(u, /latitude=60\.8600%2C63\.4000/);
  assert.match(u, /longitude=8\.5100%2C13\.0800/);
  assert.match(u, /forecast_days=16/);
  assert.match(u, /past_days=5/);
  for (const k of PARAM_KEYS) assert.ok(u.includes(encodeURIComponent(PARAMS[k].daily)) || u.includes(PARAMS[k].daily), `${k} is asked for`);
  assert.match(u, /wind_speed_unit=ms/);
});

test('rows: only the days with usable numbers come through', () => {
  const rows = rowsOf({
    daily: {
      time: ['2026-02-01', '2026-02-02'],
      temperature_2m_max: [-3.2, null],
      snowfall_sum: [6, 0],
      cloud_cover_mean: [80, 20],
      wind_speed_10m_max: [9.4, 4],
    },
  });
  assert.deepEqual(rows['2026-02-01'], { temp: -3.2, snow: 6, cloud: 80, wind: 9.4 });
  assert.equal(rows['2026-02-02'].temp, undefined, 'a missing value is left out');
  assert.equal(rows['2026-02-02'].snow, 0, 'but zero is a value');
  assert.deepEqual(rowsOf({}), {});
});

test('a run of days: forecasts are kept, then scored when the day has happened', async () => {
  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
  // A perfect 1-day forecast, a hopeless 15-day one, and weather that varies.
  const truth = (d) => {
    const k = Number(d.slice(-2));
    return { temp: -8 + (k % 7) * 2, snow: k % 5 === 0 ? 9 : 0.4, cloud: (k * 17) % 100, wind: 3 + (k % 6) };
  };
  const points = (chunk, today) => chunk.map((c) => {
    const daily = { time: [] };
    for (const p of PARAM_KEYS) daily[PARAMS[p].daily] = [];
    for (let k = -5; k <= 16; k++) {
      const d = new Date(new Date(`${today}T00:00:00Z`).getTime() + k * 86400e3).toISOString().slice(0, 10);
      const t = truth(d);
      daily.time.push(d);
      for (const p of PARAM_KEYS) {
        const drift = k <= 0 ? 0 : (k === 15 ? 9 : k * 0.15) * (p === 'cloud' ? 6 : p === 'snow' ? 0.8 : 1);
        daily[PARAMS[p].daily].push(t[p] + drift * (c.key.charCodeAt(1) % 3 === 0 ? 1 : -1));
      }
    }
    return { daily };
  });

  let stored = 0, scored = 0;
  for (let i = 0; i < 40; i++) {
    const today = day(i);
    const r = await collectAndScore({ today, fetchPoints: (chunk) => Promise.resolve(points(chunk, today)), gapMs: 0 });
    stored += r.stored;
    scored += r.scored;
  }
  assert.ok(stored > 100 && scored > 100, `forecasts kept (${stored}) and scored (${scored})`);

  const skill = await getSkill();
  assert.ok(skill.cells.length > 0, 'cells come back');
  assert.deepEqual(skill.leads, LEADS);
  const cell = skill.cells[0];
  const near = cell.leads[1].temp, far = cell.leads[15].temp;
  assert.equal(near.enough, true);
  assert.ok(near.skill > far.skill, `tomorrow beats a fortnight away (${near.skill} vs ${far.skill})`);
  assert.equal(near.mae, 0.15, 'the 1-day forecast was out by 0.15 °C here');
  assert.ok(cell.leads[1].all.enough && cell.leads[1].all.skill > 0);
  assert.ok(skill.collecting.passes >= 40 && skill.collecting.observedDays > 30);
  assert.match(skill.source, /Open-Meteo/);
});

test('a chunk that fails costs that day, not the run', async () => {
  const today = '2026-03-01';
  const r = await collectAndScore({ today, fetchPoints: () => Promise.reject(new Error('offline')), gapMs: 0 });
  assert.equal(r.stored, 0);
  assert.ok(r.failed > 0);
  const skill = await getSkill();
  assert.ok(skill.cells.length > 0, 'what was scored before is still there');
});
