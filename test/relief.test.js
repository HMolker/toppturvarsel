import test from 'node:test';
import assert from 'node:assert/strict';
import { aspectBearing, steepestBearing, fallLine, hillshade, sampleZ, reliefSvg } from '../public/relief.js';

// A synthetic mountain: a summit in the middle, steep on the east side,
// gentle to the west, so the steepest way down is known in advance.
function mountain() {
  const nx = 24, ny = 20;
  const box = { south: 62.98, north: 63.02, west: 9.95, east: 10.05 };
  const z = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const lat = box.north - ((box.north - box.south) * j) / (ny - 1);
      const lon = box.west + ((box.east - box.west) * i) / (nx - 1);
      const dN = (lat - 63) * 111320, dE = (lon - 10) * 111320 * Math.cos(63 * Math.PI / 180);
      const k = dE > 0 ? 0.9 : 0.25; // east side three times steeper
      z.push(Math.max(300, 1600 - k * Math.hypot(dE, dN)));
    }
  }
  return { box, nx, ny, z, source: 'synthetic' };
}
const terrain = mountain();
const summit = { lat: 63, lon: 10 };

test('aspect becomes a bearing; varied has none', () => {
  assert.equal(aspectBearing('N'), 0);
  assert.equal(Math.round(aspectBearing('E')), 90);
  assert.equal(Math.round(aspectBearing('N–NE')), 23);
  assert.equal(Math.round(aspectBearing('NW–NE')), 0, 'averaged as directions, not numbers');
  assert.equal(aspectBearing('varied'), null);
});

test('without an aspect, the steepest way down is found', () => {
  const b = steepestBearing(terrain, summit);
  assert.ok(b >= 60 && b <= 120, `steepest side is east, got ${b}°`);
});

test('the fall line goes downhill and reports sensible angles', () => {
  const line = fallLine(terrain, summit, 90);
  assert.ok(line.length > 5);
  assert.ok(line[0].z > line[line.length - 1].z, 'ends lower than it starts');
  for (const p of line.slice(1)) assert.ok(p.angle > -5 && p.angle < 60, `angle ${p.angle}`);
  assert.equal(sampleZ(terrain, 70, 10), null, 'outside the grid is unknown, not zero');
});

test('hillshade stays between shadow and light', () => {
  const h = hillshade(terrain);
  assert.equal(h.length, (terrain.nx - 1) * (terrain.ny - 1));
  for (const v of h) assert.ok(v >= 0 && v <= 1);
});

test('the drawing follows the descent aspect, and says when it guessed', () => {
  const byAspect = reliefSvg(terrain, { name: 'T', lat: 63, lon: 10, summit_m: 1600, aspect: 'W' });
  assert.match(byAspect, /<svg class="relief"/);
  assert.match(byAspect, /down the <strong>W<\/strong> side, the tour.s descent aspect/);
  const guessed = reliefSvg(terrain, { name: 'T', lat: 63, lon: 10, summit_m: 1600, aspect: 'varied' });
  assert.match(guessed, /down the <strong>E<\/strong> side — the steepest way down/);
  assert.match(guessed, /not a photograph/);
  assert.equal(reliefSvg(null, { lat: 63, lon: 10, aspect: 'N' }), null, 'no grid, no drawing');
});
