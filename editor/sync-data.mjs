#!/usr/bin/env node
/**
 * Copies the region list and the existing tour names into the editor page,
 * so it works as a single file with no server (and as a published page).
 *
 *   npm run editor:sync
 *
 * test/editor.test.js fails when the copy has drifted from data/.
 */
import { readFile, writeFile } from 'node:fs/promises';

const here = (p) => new URL(p, import.meta.url);
const regions = JSON.parse(await readFile(here('../data/regions.json'), 'utf8'));
const tours = JSON.parse(await readFile(here('../data/tours.json'), 'utf8'));

export const editorData = () => ({
  regions: regions.map(({ id, name, country, lat, lon, noForecast, offMap }) => ({
    id, name, country, lat, lon, ...(noForecast ? { noForecast: true } : {}), ...(offMap ? { offMap: true } : {}),
  })),
  tours: tours.map((t) => t.name),
});

const file = here('./tour-editor.html');
const html = await readFile(file, 'utf8');
const re = /(<script type="application\/json" id="fjData">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('fjData block not found in tour-editor.html');
// "</" cannot occur in the JSON (no such text in names), but escape it anyway.
const json = JSON.stringify(editorData()).replace(/<\//g, '<\\/');
const next = html.replace(re, `$1${json}$2`);
if (next !== html) {
  await writeFile(file, next);
  console.log(`editor: ${editorData().regions.length} regions, ${editorData().tours.length} tour names written`);
} else console.log('editor: already up to date');
