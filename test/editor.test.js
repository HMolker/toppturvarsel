import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { slugify } from '../src/util/gpx.js';

const html = await readFile(new URL('../editor/tour-editor.html', import.meta.url), 'utf8');
const regions = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const data = JSON.parse(html.match(/<script type="application\/json" id="fjData">([\s\S]*?)<\/script>/)[1]);

test('the editor carries the current regions and tour names (run npm run editor:sync)', () => {
  assert.deepEqual(data.regions.map((r) => r.id), regions.map((r) => r.id));
  assert.deepEqual(data.tours, tours.map((t) => t.name));
});

test("the editor's slug rule is the server's, so GPX file names match", () => {
  const src = html.match(/function slugify\(name\) \{([\s\S]*?)\n\}/)[1];
  const editorSlug = new Function('name', src);
  for (const t of tours) assert.equal(editorSlug(t.name), slugify(t.name), t.name);
  for (const n of ['Rørnestinden', 'Kårsavagge / Kårsatjåkka', 'Urevassnutane (Urvassnuten)', 'Æra Ålesund']) {
    assert.equal(editorSlug(n), slugify(n), n);
  }
});

test("the editor reads a photo's position, height, direction and time from EXIF", async () => {
  const src = html.match(/function parseExif\(buf\) \{([\s\S]*?)\n\}/)[1];
  const parseExif = new Function('buf', src);
  const buf = async (f) => {
    const b = await readFile(new URL(`./fixtures/${f}`, import.meta.url));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const e = parseExif(await buf('photo-gps.jpg'));
  assert.equal(e.lat, 69.6605);
  assert.equal(e.lon, 20.0484);
  assert.equal(e.ele, 987);
  assert.equal(e.direction, 45);
  assert.equal(e.takenAt, '2026-03-01T10:15:30+01:00');
  const none = parseExif(await buf('photo-nogps.jpg'));
  assert.equal(none?.lat, undefined, 'a photo without GPS has no position');
  assert.equal(parseExif(new ArrayBuffer(8)), null, 'not a JPEG');
});
