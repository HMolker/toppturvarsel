import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-trk-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
await mkdir(path.join(tmp, 'cache', 'tracks'), { recursive: true });
await mkdir(path.join(tmp, 'tracks'), { recursive: true });

const { trackStatuses } = await import('../src/tracks.js');
const { slugify } = await import('../src/util/gpx.js');
const tours = JSON.parse(await readFile(new URL('../data/tours.json', import.meta.url), 'utf8'));

test('track status comes from disk only: own GPX, cached OSM route, none, pending', async () => {
  // Refuse any network use: the list marker must never trigger a lookup.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('no network in trackStatuses'); };
  try {
    const [a, b, c, d] = tours.filter((t) => t.kind !== 'area');
    await writeFile(path.join(tmp, 'tracks', `${slugify(a.name)}.gpx`), '<gpx/>');
    await writeFile(path.join(tmp, 'cache', 'tracks', `${slugify(b.name)}.json`), JSON.stringify({ found: true, source: 'osm', kind: 'ski-route' }));
    await writeFile(path.join(tmp, 'cache', 'tracks', `${slugify(c.name)}.json`), JSON.stringify({ found: false, source: 'osm' }));
    const s = await trackStatuses();
    assert.equal(s[a.name].status, 'gpx');
    assert.deepEqual(s[b.name], { status: 'osm', kind: 'ski-route' });
    assert.equal(s[c.name].status, 'none');
    assert.equal(s[d.name].status, 'pending');
    assert.equal(Object.keys(s).length, tours.length);
  } finally {
    globalThis.fetch = realFetch;
  }
});
