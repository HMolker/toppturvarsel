import test from 'node:test';
import assert from 'node:assert/strict';
import { problemKey, problemIcon, problemIcons, problemRose, elevationDiagram, elevationText, hazardCells, dangerChip, DANGER, PROBLEMS } from '../public/avalanche.js';

test("Varsom's and Naturvårdsverket's names map onto the EAWS problem types", () => {
  const cases = {
    'New snow': 'newSnow', 'Nysnø (tørre flakskred)': 'newSnow', 'Wind-drifted snow': 'windSlab', 'Wind slabs': 'windSlab',
    'Fokksnø': 'windSlab', 'Persistent weak layers': 'persistent', 'Vedvarende svakt lag': 'persistent',
    'Wet snow (slab avalanches)': 'wetSnow', 'Våt snø': 'wetSnow', 'Glide avalanches': 'gliding', 'Cornices': 'cornices',
  };
  for (const [name, key] of Object.entries(cases)) assert.equal(problemKey(name), key, name);
  assert.equal(problemKey('Dry slab avalanche'), null, 'an avalanche type is not a problem type');
});

test('every problem has a name, an explanation and a drawing in both styles', () => {
  for (const key of Object.keys(PROBLEMS)) {
    assert.ok(PROBLEMS[key].text.length > 40, key);
    assert.match(problemIcon(key), /<svg class="avicon"/, key);
    assert.notEqual(problemIcon(key, { colour: true }), problemIcon(key), `${key}: colour differs`);
  }
  for (const d of [1, 2, 3, 4, 5]) assert.ok(DANGER[d].name && DANGER[d].text, `level ${d}`);
});

test('icons are black and white below danger 3, in colour from 3', () => {
  const probs = [{ problemType: 'Wind slab' }, { problemType: 'New snow' }];
  assert.doesNotMatch(problemIcons(probs, { danger: 2 }), /#4A9A9A/);
  assert.match(problemIcons(probs, { danger: 3 }), /#4A9A9A/);
  assert.equal((problemIcons([...probs, { problemType: 'Wind-drifted snow' }], { danger: 2 }).match(/data-key=/g) ?? []).length, 2, 'one icon per type');
  assert.match(dangerChip(4), /data-level="4"/);
  assert.equal(dangerChip(null), '');
});

test('aspects and elevation are drawn and said the same way', () => {
  assert.match(problemRose('01110000'), /Aspects: NE, E, SE/);
  assert.match(problemRose('11111111'), /all aspects/);
  assert.equal(elevationText({ fill: 1, h1: 700 }), 'above 700 m');
  assert.equal(elevationText({ fill: 4, h1: 900, h2: 400 }), '400–900 m');
  assert.match(elevationDiagram({ fill: 2, h1: 600 }), /Elevation: below 600 m/);
  const a = elevationDiagram({ fill: 1, h1: 500 }), b = elevationDiagram({ fill: 1, h1: 500 });
  assert.notEqual(a.match(/clipPath id="(\w+)"/)[1], b.match(/clipPath id="(\w+)"/)[1], 'each diagram clips with its own id');
});

// A 35° slope facing east, dropping from 1200 m, on a 50 m grid.
function eastFace() {
  const nx = 30, ny = 20, lat0 = 63;
  const dLon = 50 / (111320 * Math.cos((lat0 * Math.PI) / 180)), dLat = 50 / 111320;
  const box = { west: 10, east: 10 + dLon * (nx - 1), north: lat0 + dLat * (ny - 1), south: lat0 };
  const z = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z.push(1200 - i * 50 * Math.tan((35 * Math.PI) / 180));
  return { box, nx, ny, z };
}

test('steep slopes are marked only where a problem faces and reaches', () => {
  const g = eastFace();
  const east = hazardCells(g, [{ problemType: 'Wind slab', aspects: '00100000', heights: { fill: 1, h1: 500 } }]);
  assert.ok(east.length > 50, `east-facing above 500 m: ${east.length} cells`);
  assert.ok(east.every((c) => c.aspect === 'E' && c.angle >= 25 && c.elev >= 500));
  assert.deepEqual(hazardCells(g, [{ problemType: 'Wind slab', aspects: '00000010', heights: { fill: 1, h1: 500 } }]), [], 'west only: nothing');
  assert.deepEqual(hazardCells(g, [{ problemType: 'Wind slab', aspects: '11111111', heights: { fill: 1, h1: 2000 } }]), [], 'above 2000 m: nothing');
  assert.deepEqual(hazardCells(g, []), [], 'no problems, no shading');
  const gentle = { ...g, z: g.z.map((v) => 1000 + (v - 1000) * 0.3) };
  assert.deepEqual(hazardCells(gentle, [{ problemType: 'New snow', aspects: '11111111' }]), [], 'under 25°: nothing');
});
