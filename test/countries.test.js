import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COUNTRIES, fitFrame, normaliseSelection, joinNames } from '../public/countries.js';

const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));

test('every country in the data is known to the picker, with a map frame', () => {
  for (const c of new Set(regions.map((r) => r.country))) {
    assert.ok(COUNTRIES[c], `country ${c} missing from public/countries.js`);
    assert.ok(COUNTRIES[c].frame.length >= 4);
  }
});

const project = (f, lat, lon) => ({
  x: f.ox + (lon - f.lon0) * Math.cos((lat * Math.PI) / 180) * f.s,
  y: f.oy - lat * f.s,
});

test('each country frame keeps all of its regions and tours on the map', () => {
  const countryOf = Object.fromEntries(regions.map((r) => [r.id, r.country]));
  for (const [code, c] of Object.entries(COUNTRIES)) {
    const f = fitFrame([c.frame], { width: 560 });
    const pts = [
      ...regions.filter((r) => r.country === code && !r.offMap),
      ...tours.filter((t) => countryOf[t.region] === code),
    ];
    for (const p of pts) {
      const q = project(f, p.lat, p.lon);
      assert.ok(q.x >= 0 && q.x <= 560 && q.y >= 0 && q.y <= f.height, `${code}: ${p.name ?? p.id} falls outside its frame`);
    }
  }
});

test('the frame follows the shape: tall for Norway, wide for a wide box', () => {
  const no = fitFrame([COUNTRIES.NO.frame]);
  assert.ok(no.height > 560, 'Norway is portrait');
  const wide = fitFrame([[[42.3, -1.8], [43.3, 2.9], [42.4, 3.2], [43.4, -1.7]]]); // a Pyrenees-shaped box
  assert.ok(wide.height < 400, 'a wide range gets a short map');
  assert.ok(wide.height >= 360, 'but never shorter than the minimum');
});

test('a saved selection is cleaned against what is available', () => {
  assert.deepEqual(normaliseSelection(['SE', 'XX'], ['NO', 'SE']), ['SE']);
  assert.deepEqual(normaliseSelection([], ['NO', 'SE']), ['NO', 'SE']);
  assert.deepEqual(normaliseSelection('garbage', ['NO']), ['NO']);
});

test('country names read naturally', () => {
  assert.equal(joinNames(['NO']), 'Norway');
  assert.equal(joinNames(['NO', 'SE']), 'Norway & Sweden');
});
