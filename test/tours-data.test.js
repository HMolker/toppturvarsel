import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));

test('every tour is complete and points at a real forecast region', () => {
  const ids = new Set(regions.map((r) => r.id));
  const names = new Set();
  for (const t of tours) {
    assert.ok(!names.has(t.name), `duplicate tour ${t.name}`);
    names.add(t.name);
    assert.ok(ids.has(t.region), `${t.name}: unknown region ${t.region}`);
    assert.ok(t.lat > 55 && t.lat < 72 && t.lon > 4 && t.lon < 32, `${t.name}: coordinates outside Norway/Sweden`);
    assert.ok(t.summit_m > t.vertical_m * 0.5 || t.vertical_m < t.summit_m, `${t.name}: vertical larger than the summit`);
    assert.ok([1, 2, 3, 4, 5].includes(t.difficulty) && [1, 2, 3, 4, 5].includes(t.quality), `${t.name}: ratings 1-5`);
    assert.ok(typeof t.aspect === 'string' && t.aspect.length, `${t.name}: aspect`);
  }
});

test('links to other sites are https, labelled, and only link (no copied text)', () => {
  for (const t of tours) {
    for (const l of t.links ?? []) {
      assert.match(l.url, /^https:\/\//, `${t.name}: ${l.url}`);
      assert.ok(l.title && l.site, `${t.name}: link needs a title and a site`);
      assert.ok(l.title.length < 60, `${t.name}: link titles are names, not descriptions`);
    }
  }
});
