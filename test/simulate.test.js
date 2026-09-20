import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulate, simulateResorts } from '../public/simulate.js';
import { plan } from '../public/planner.js';

const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const now = new Date('2027-02-10T09:00:00Z');
const sim = simulate({ regions, tours, now, seed: 'storm' });

test('a simulated winter fills every panel with plausible numbers', () => {
  assert.equal(sim.snapshot.simulated, true);
  assert.equal(sim.snapshot.regions.length, regions.length);
  assert.equal(sim.snapshot.tours.length, tours.length);
  for (const r of sim.snapshot.regions) {
    const d = r.bulletin.danger;
    assert.ok(d === null || [1, 2, 3, 4, 5].includes(d), `${r.id}: danger ${d}`);
    assert.ok(r.snow.depthCm > 0 && r.snow.depthCm < 400, `${r.id}: depth`);
    assert.ok(r.snow.new48 >= 0 && r.snow.new48 <= 60, `${r.id}: new snow`);
    assert.ok(r.snow.new24 <= r.snow.new48 && r.snow.new48 <= r.snow.new72, `${r.id}: 24 <= 48 <= 72`);
    for (const p of r.bulletin.problems ?? []) assert.match(p.aspects, /^[01]{8}$/, `${r.id}: aspect bits`);
  }
  for (const t of sim.snapshot.tours) {
    assert.ok(Number.isFinite(t.snow.depthCm) && t.snow.depthCm > 0, `${t.name}: depth`);
    assert.equal(sim.outlook.forecasts[t.name].days.length, 5, `${t.name}: 5 forecast days`);
  }
});

test('no bulletin passes itself off as real', () => {
  for (const r of sim.snapshot.regions) {
    if (r.bulletin.noForecast) continue;
    assert.equal(r.bulletin.simulated, true);
    assert.match(r.bulletin.headline, /[Ss]imulated/);
  }
  assert.equal(sim.alerts.simulated, true);
  assert.equal(sim.outlook.simulated, true);
});

test('alerts fire exactly where the invented 48 h load crosses the threshold', () => {
  const over = sim.snapshot.regions.filter((r) => !r.offMap && r.snow.new48 >= 30).map((r) => r.id).sort();
  assert.deepEqual(sim.alerts.firing.map((f) => f.regionId).sort(), over);
  assert.ok(sim.alerts.firing.length > 0, 'the storm loads at least one region');
  for (let i = 1; i < sim.alerts.firing.length; i++) {
    assert.ok(sim.alerts.firing[i - 1].new48 >= sim.alerts.firing[i].new48, 'biggest load first');
  }
});

test('the planner can rank the simulated week', () => {
  const p = plan({ tours: sim.snapshot.tours, outlook: sim.outlook, prefs: { maxDifficulty: 3, maxDanger: 3, from: null } });
  assert.ok(p.dates.length >= 3, 'several days');
  const day0 = p.days[0].rows;
  assert.ok(day0.some((r) => r.status === 'ok' || r.status === 'caution'), 'something passes the filter');
  assert.ok(day0.some((r) => r.status === 'excluded'), 'and the loaded regions are excluded');
  for (const r of day0) assert.ok(r.score >= 0 && r.score <= 100, `${r.tour}: score ${r.score}`);
});

test('the same seed draws the same winter, a different seed another one', () => {
  const again = simulate({ regions, tours, now, seed: 'storm' });
  assert.deepEqual(again.snapshot.regions[0].snow, sim.snapshot.regions[0].snow);
  const other = simulate({ regions, tours, now, seed: 'thaw' });
  assert.notDeepEqual(other.snapshot.regions[0].snow, sim.snapshot.regions[0].snow);
});

test('resort status is invented over a real list, never conjured out of nothing', () => {
  assert.equal(simulateResorts(null), null);
  const real = { resorts: [
    { id: 'a', name: 'A', country: 'NO', lat: 62, lon: 7, lifts: { count: 10, open: 0 }, slopes: { count: 20, open: 0 }, live: true },
    { id: 'b', name: 'B', country: 'SE', lat: 63, lon: 13, lifts: null, slopes: null, live: false },
  ], sources: {} };
  const out = simulateResorts(real, 'storm');
  assert.equal(out.simulated, true);
  assert.deepEqual(out.resorts.map((r) => r.name), ['A', 'B']);
  for (const r of out.resorts) {
    assert.ok(r.lifts.open <= r.lifts.count && r.lifts.open >= 0, `${r.name}: lifts`);
    assert.ok(r.slopes.open <= r.slopes.count && r.slopes.open >= 0, `${r.name}: slopes`);
  }
});
