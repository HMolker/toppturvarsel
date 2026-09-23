import test from 'node:test';
import assert from 'node:assert/strict';

/** v5.4: the tour builder's routing and numbers (public/terrain/tour.js). */

const T = await import('../public/terrain/tour.js');

test('Munter: 1 km or 100 m is a unit; 4 an hour skinning, 10 skiing down', () => {
  assert.equal(T.munterHours(1000, 0), 0.25);
  assert.equal(T.munterHours(2000, 800), 2.5);
  assert.equal(T.munterHours(2000, -800), 1);
  // A gentle downhill (under 5 %) is travel on the flat, not skiing.
  assert.equal(T.munterHours(1000, -20), 0.25);
});

// A 60 x 60 grid, 40 m cells, rising to the north (row 0) at ~14°. Rows 25-32
// are a steep band at 36°, facing south, from x = 0 to 44, with a gentle ramp
// at x >= 45. The rest is gentle.
function testGrid() {
  const nx = 60, ny = 60, cellM = 40;
  const ele = new Float32Array(nx * ny), slope = new Float32Array(nx * ny), aspect = new Float32Array(nx * ny).fill(180);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    ele[k] = 1000 + (ny - j) * 10;
    slope[k] = j >= 25 && j <= 32 && i < 45 ? 36 : 14;
  }
  return { nx, ny, cellM, ele, slope, aspect };
}
const crossings = (path, g) => path.filter(([i, j]) => g.slope[j * g.nx + i] >= 35).length;

test('at danger 2+ a leg goes round steep ground; at danger 1 it may take it when quicker', () => {
  const g = testGrid();
  const d2 = T.hazardFactors({ ...g, danger: 2 });
  const p2 = T.legPath(g, d2, [5, 55], [5, 5]);
  assert.ok(p2);
  assert.equal(crossings(p2.path, g), 0, 'danger 2: round the 36° band');
  assert.ok(p2.path.some(([i]) => i >= 45));
  // Danger 1: 36° still costs for skinning (it cannot be skinned) ...
  const d1 = T.hazardFactors({ ...g, danger: 1 });
  const up1 = T.legPath(g, d1, [5, 55], [5, 5]);
  assert.equal(crossings(up1.path, g), 0, 'danger 1: skin tracks keep off 35°+');
  // ... but skiing down it is allowed, and quicker than the detour.
  const down1 = T.legPath(g, d1, [5, 5], [5, 55]);
  assert.ok(crossings(down1.path, g) > 0, 'danger 1: may ski down 36°');
  const down2 = T.legPath(g, d2, [5, 5], [5, 55]);
  assert.equal(crossings(down2.path, g), 0, 'danger 2: not even downhill');
});

test('today’s problem slopes and runout zones cost extra at danger 2, not at danger 1', () => {
  const g = testGrid();
  g.slope.fill(26); // everything moderately steep, facing south
  const problems = [{ problemType: 'Wind-drifted snow', aspects: '00001000', heights: { h1: 0, h2: 0, fill: 1 } }]; // S, all heights
  const f2 = T.hazardFactors({ ...g, problems, danger: 2 });
  const f1 = T.hazardFactors({ ...g, problems, danger: 1 });
  assert.ok(f2.up[100] >= 1.5 * 8 - 1e-9, 'problem slope weighted at danger 2');
  assert.equal(f1.up[100], 1, 'ignored at danger 1');
  const runout = new Uint8Array(g.nx * g.ny);
  runout[100] = 1;
  const r2 = T.hazardFactors({ ...g, runout, danger: 2 });
  const r1 = T.hazardFactors({ ...g, runout, danger: 1 });
  assert.ok(r2.up[100] > r2.up[101]);
  assert.equal(r1.up[100], r1.up[101]);
  // Danger 3 weighs harder than 2.
  const f3 = T.hazardFactors({ ...g, problems, danger: 3 });
  assert.ok(f3.up[100] > f2.up[100]);
});

test('tourLegs: start, each descent, and back; touching ends need no leg', () => {
  const S0 = [61.0, 8.0];
  const d1 = [[61.05, 8.05], [61.02, 8.04]];
  const d2 = [[61.0200001, 8.0400001], [61.01, 8.02]]; // starts where d1 ends
  const legs = T.tourLegs(S0, [d1, d2]);
  assert.deepEqual(legs.map((l) => [l.label, l.before]), [['Up to descent 1', 0], ['Back to the start', -1]]);
  const legs2 = T.tourLegs(S0, [d1, [[61.06, 8.06], [61.03, 8.05]]]);
  assert.deepEqual(legs2.map((l) => l.label), ['Up to descent 1', 'To descent 2', 'Back to the start']);
});

test('assembleTour joins legs and descents and marks every part', () => {
  const S0 = [61.0, 8.0];
  const d1 = [[61.05, 8.05], [61.04, 8.045], [61.02, 8.04]];
  const legs = T.tourLegs(S0, [d1]);
  legs[0].points = [S0, [61.03, 8.03], [61.05, 8.05]];
  legs[1].points = [[61.02, 8.04], [61.01, 8.02], S0];
  const t = T.assembleTour(S0, [d1], legs);
  assert.equal(t.points.length, 1 + 2 + 2 + 2);
  assert.deepEqual(t.parts.map((p) => [p.kind, p.v0, p.v1]), [['leg', 0, 2], ['descent', 2, 4], ['leg', 4, 6]]);
  assert.deepEqual(t.points[2], d1[0]);
  assert.deepEqual(t.points.at(-1), S0);
});

test('tourNumbers: length, climb, vertical on descents only, Munter time', () => {
  // Up 600 m over 3 km (leg), down 600 m over 2 km (descent), 1 km flat back (leg).
  const samples = [
    { d: 0, ele: 1000, v: 0 }, { d: 1500, ele: 1300 }, { d: 3000, ele: 1600, v: 1 },
    { d: 4000, ele: 1300 }, { d: 5000, ele: 1000, v: 2 },
    { d: 6000, ele: 1000, v: 3 },
  ];
  const parts = [{ kind: 'leg', label: 'Up', v0: 0, v1: 1 }, { kind: 'descent', label: 'D1', v0: 1, v1: 2 }, { kind: 'leg', label: 'Back', v0: 2, v1: 3 }];
  const n = T.tourNumbers({ samples }, parts);
  assert.equal(n.total.distanceM, 6000);
  assert.equal(n.total.climbM, 600);
  assert.equal(n.total.skiedM, 600);
  // (3 + 6)/4 + (2 + 6)/10 + 1/4 = 2.25 + 0.8 + 0.25
  assert.ok(Math.abs(n.total.hours - 3.3) < 1e-9, `${n.total.hours}`);
  const w = T.partWarnings(n.rows, { problemSections: [{ d0: 3500, d1: 3800 }], runoutSections: [{ d0: 5500, d1: 7000 }] });
  assert.deepEqual(w.map((x) => [x.problemM, x.runoutM]), [[0, 0], [300, 0], [0, 500]]);
});
