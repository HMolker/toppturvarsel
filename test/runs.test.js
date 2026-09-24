import test from 'node:test';
import assert from 'node:assert/strict';
import { findRuns, cellRules, RUN_DEFAULTS, SKILL_PRESETS, octantOf } from '../public/terrain/runs.js';
import { slopeAspect } from '../public/terrain/dem.js';

/**
 * Find runs (v5.7) on made-up terrain: a smooth mountain whose sides get
 * steeper towards the top, over a flat valley floor.
 */

function mountain({ n = 161, cellM = 20, peak = 900, r0 = 1400, bumps = null } = {}) {
  const ele = new Float32Array(n * n);
  const c = (n - 1) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(i - c, j - c) * cellM;
      // Concave profile: steep near the top, easing out to the valley.
      let z = r < r0 ? peak * (1 - r / r0) ** 1.6 : 0;
      if (bumps) z += bumps(i, j);
      ele[j * n + i] = 600 + z;
    }
  }
  return { nx: n, ny: n, ele, cellM, toLatLon: (i, j) => ({ lat: 62 - j * 0.00018, lon: 12 + i * 0.00038 }) };
}

const terrainOf = (g, extra = {}) => ({ ...slopeAspect(g.ele, g.nx, g.ny, g.cellM), ...extra });

test('runs on a mountain: in the angle band, long, spread over the aspects', () => {
  const g = mountain();
  const t = terrainOf(g);
  const runs = findRuns(g, t, { count: 4 });
  assert.equal(runs.length, 4);
  for (const r of runs) {
    for (const k of r.cells.slice(1)) assert.ok(t.slope[k] >= 15 - 1e-6 && t.slope[k] <= 35 + 1e-6, `angle ${t.slope[k]}`);
    assert.ok(r.stats.verticalM >= 150);
    assert.ok(r.stats.lengthM > 500, `long: ${r.stats.lengthM} m`);
    assert.ok(r.stats.avgSlope >= 15 && r.stats.avgSlope <= 35, `average ${r.stats.avgSlope}`);
    assert.ok(r.points.length >= 2 && r.points.length <= r.cells.length + 2 && r.points[0].length === 2);
  }
  // Different faces: every pair 30°+ apart in aspect, or far apart.
  for (let a = 0; a < runs.length; a++) {
    for (let b = a + 1; b < runs.length; b++) {
      const d = Math.abs(runs[a].stats.aspect - runs[b].stats.aspect) % 360;
      assert.ok(Math.min(d, 360 - d) >= 25, `runs ${a + 1} and ${b + 1} face ${runs[a].stats.aspect}° and ${runs[b].stats.aspect}°`);
    }
  }
  assert.ok(runs[0].score >= runs[1].score, 'best first');
});

test('a run-out on gentle ground is added, and not counted in the angles', () => {
  const g = mountain();
  const runs = findRuns(g, terrainOf(g), { count: 1, runoutM: 300 });
  assert.ok(runs[0].stats.runoutM > 60, `run-out ${runs[0].stats.runoutM} m`);
  const none = findRuns(g, terrainOf(g), { count: 1, runoutM: 0 });
  assert.equal(none[0].stats.runoutM, 0);
});

test('rider skill moves the angles; today\'s problem aspects are kept under the hazard limit', () => {
  const g = mountain();
  const t = terrainOf(g);
  const easy = findRuns(g, t, { count: 1, ...SKILL_PRESETS.easy })[0];
  const expert = findRuns(g, t, { count: 1, ...SKILL_PRESETS.expert })[0];
  assert.ok(expert.stats.avgSlope > easy.stats.avgSlope + 4, `${easy.stats.avgSlope} → ${expert.stats.avgSlope}`);
  // Problem on N-NE-E above 900 m: no cell there steeper than 25°.
  const probAsp = new Set(['N', 'NE', 'E']);
  const hazard = (k) => probAsp.has(octantOf(t.aspect[k])) && g.ele[k] >= 900;
  const runs = findRuns(g, { ...t, hazard }, { count: 6, minVerticalM: 100 });
  for (const r of runs) for (const k of r.cells.slice(1)) if (hazard(k)) assert.ok(t.slope[k] <= 25 + 1e-6);
  assert.ok(runs.some((r) => r.stats.flagM.capped > 0 || !probAsp.has(r.stats.octant)));
});

test('cliffs are never skied; a flat area finds nothing', () => {
  const g = mountain({ bumps: (i, j) => (i > 78 && i < 83 && j < 80 ? -120 : 0) }); // a slot with vertical walls
  const t = terrainOf(g);
  const runs = findRuns(g, t, { count: 4 });
  const { blocked } = cellRules(g, t, RUN_DEFAULTS);
  for (const r of runs) for (const k of r.cells) assert.equal(blocked[k], 0);
  const flat = { nx: 20, ny: 20, cellM: 20, ele: new Float32Array(400).fill(500), toLatLon: (i, j) => ({ lat: j, lon: i }) };
  assert.deepEqual(findRuns(flat, terrainOf(flat)), []);
});

test('on a slab day, convex rolls are avoided when asked', () => {
  // A roll: gentle, then suddenly steep, down the west side.
  const g = mountain({ bumps: (i, j) => (i < 70 ? -Math.max(0, (70 - i) - 8) * 6 : 0) });
  const t = terrainOf(g);
  const on = cellRules(g, { ...t, slabDay: true }, RUN_DEFAULTS);
  const off = cellRules(g, { ...t, slabDay: true }, { ...RUN_DEFAULTS, avoidConvex: false });
  const count = (f) => f.reduce((a, x) => a + (x & 1), 0);
  assert.ok(count(on.flags) > 0, 'rolls found');
  assert.equal(count(off.flags), 0, 'not looked for when switched off');
  const runs = findRuns(g, { ...t, slabDay: true }, { count: 4 });
  const rolled = runs.reduce((a, r) => a + r.stats.flagM.convex, 0);
  const runsOff = findRuns(g, { ...t, slabDay: true }, { count: 4, avoidConvex: false });
  assert.ok(runsOff.length >= runs.length - 1);
  assert.ok(rolled <= 200, `little time on rolls: ${rolled} m`);
});

test('runs stay inside the marked area, run-outs too', () => {
  const g = mountain();
  const t = terrainOf(g);
  const inside = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (i >= 80 && j <= 90) inside[j * g.nx + i] = 1; // the north-east quarter
  const runs = findRuns(g, { ...t, inside }, { count: 4 });
  assert.ok(runs.length >= 1);
  for (const r of runs) for (const k of [...r.cells, ...r.runout]) assert.equal(inside[k], 1);
});
