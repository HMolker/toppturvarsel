import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-own-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { getOwnPhotos, getOwnPhotoFile, cleanEntry } = await import('../src/own-photos.js');
const { createServer } = await import('../src/server.js');
const { slugify } = await import('../src/util/gpx.js');
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));
const tour = tours[0];
const dir = path.join(tmp, 'photos', slugify(tour.name));
await mkdir(dir, { recursive: true });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
await writeFile(path.join(dir, '01-top.jpg'), JPEG);
await writeFile(path.join(dir, '02-ridge.jpg'), JPEG);
await writeFile(path.join(tmp, 'secret.jpg'), JPEG);
await writeFile(path.join(dir, 'photos.json'), JSON.stringify({
  tour: tour.name,
  photos: [
    { file: '01-top.jpg', caption: 'Top', credit: 'H. Molker', takenAt: '2026-03-01T10:15:30', lat: 69.66, lon: 20.05, ele: 990, direction: 45 },
    { file: '../secret.jpg', caption: 'escape attempt', lat: 1, lon: 1 },
    { file: 'missing.jpg', caption: 'not on disk' },
    { file: '02-ridge.jpg', caption: 'Ridge', lat: 69.65, lon: 20.04, useLocation: false },
    { file: 'script.js', caption: 'not an image' },
  ],
}));

test('only listed image files with plain names are offered, and missing files are dropped', async () => {
  const { photos } = await getOwnPhotos(tour);
  assert.deepEqual(photos.map((p) => p.file), ['01-top.jpg', '02-ridge.jpg']);
  assert.deepEqual(photos.map((p) => p.i), [0, 1]);
});

test('positions are kept only when present and not switched off', async () => {
  const { photos } = await getOwnPhotos(tour);
  assert.equal(photos[0].located, true);
  assert.deepEqual([photos[0].lat, photos[0].lon, photos[0].ele, photos[0].direction], [69.66, 20.05, 990, 45]);
  assert.equal(photos[1].located, false);
  assert.equal(photos[1].lat, null, 'useLocation:false keeps a photo off the map');
});

test('entry validation rejects paths and odd values', () => {
  assert.equal(cleanEntry({ file: '../a.jpg' }), null);
  assert.equal(cleanEntry({ file: 'a/b.jpg' }), null);
  assert.equal(cleanEntry({ file: '.hidden.jpg' }), null);
  assert.equal(cleanEntry({ file: 'a.jpg', lat: 'x', lon: 5 }).located, false);
  assert.equal(cleanEntry({ file: 'a.jpg', takenAt: 'yesterday' }).takenAt, null);
});

test('the endpoints serve the listed photo and nothing else', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = encodeURIComponent(tour.name);
  try {
    const list = await (await fetch(`${base}/api/own-photos?tour=${q}`)).json();
    assert.equal(list.photos.length, 2);
    const img = await fetch(`${base}/api/own-photo?tour=${q}&i=0`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/api/own-photo?tour=${q}&i=5`)).status, 404);
    assert.equal((await fetch(`${base}/api/own-photo?tour=${q}&i=../x`)).status, 400);
    assert.equal((await fetch(`${base}/api/own-photos?tour=nope`)).status, 404);
    // A tour with no folder is simply empty.
    const other = await (await fetch(`${base}/api/own-photos?tour=${encodeURIComponent(tours[1].name)}`)).json();
    assert.deepEqual(other.photos, []);
  } finally {
    server.close();
  }
  assert.equal(await getOwnPhotoFile(tour, 9), null);
});
