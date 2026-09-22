#!/usr/bin/env node
/**
 * Example pictures of the resort view: the lift map and the fun facts, drawn
 * by the real frontend modules from a made-up ski area (demo/advert/resort.mjs).
 *
 *   node demo/shot-resort.mjs demo/out [path/to/playwright]
 *
 * Map tiles are not fetched, so the background is the plain paper colour.
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const [outDir = 'demo/out', pwPath] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)(pwPath ?? 'playwright');

process.env.DATA_DIR = path.join(process.cwd(), 'demo/out/.shotdata');
process.env.LOG_LEVEL = 'error';
process.env.NIGHT_SCAN = 'off';
process.env.TRACKS_WARMUP = 'false';

const { shapeResort, resortFacts } = await import('../src/resortmap.js');
const { gridBox, gridPoints } = await import('../src/terrain.js');
const { makeResortOsm, makeResortTerrain } = await import('./advert/resort.mjs');

const BASE = { id: 'demo', name: 'Testfjell', country: 'NO', lat: 60.8601, lon: 8.5178 };
const z = makeResortTerrain(BASE);
const shaped = shapeResort(makeResortOsm(BASE), BASE);
const framing = [...shaped.lifts, ...shaped.runs].flatMap((x) => x.points);
const box = gridBox(framing, BASE);
const grid = gridPoints(box);
const ends = shaped.lifts.flatMap((l) => [l.points[0], l.points[l.points.length - 1]]);
const stationZ = shaped.lifts.map((_, i) => ({ a: z(ends[2 * i].lat, ends[2 * i].lon), b: z(ends[2 * i + 1].lat, ends[2 * i + 1].lon) }));
shaped.lifts.forEach((l, i) => { l.za = Math.round(stationZ[i].a); l.zb = Math.round(stationZ[i].b); });
const data = {
  ...shaped,
  terrain: { box, nx: 24, ny: 20, z: grid.map((p) => z(p.lat, p.lon)), source: 'demo' },
  facts: resortFacts(shaped, stationZ),
};
// What the resort itself reports (Fnugg), deliberately more than OSM has.
const resort = { ...BASE, lifts: { count: 9, open: 7 }, slopes: { count: 18, open: 14 }, live: true };

const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
<style>body{background:var(--paper);margin:0;padding:18px;width:600px;font-family:var(--font)}
#facts{margin-top:14px}</style>
<div class="tourcol"><h4>${resort.name}</h4><div class="routemap" id="map"></div><h4>Fun facts</h4><div id="facts"></div></div>
<script type="module">
import { renderResortMap } from '/route.js';
import { factsHtml } from '/resortfacts.js';
const data = ${JSON.stringify(data)};
const resort = ${JSON.stringify(resort)};
renderResortMap(document.querySelector('#map'), { resort, data, country: 'NO' });
document.querySelector('#facts').innerHTML = factsHtml(data.facts, resort);
document.querySelectorAll('.rsdetails').forEach((d) => { d.open = true; });
document.body.dataset.ready = '1';
</script>`;

await mkdir(path.join('public'), { recursive: true });
await writeFile('public/_shot.html', page);
const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((r) => server.listen(8123, r));
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 640, height: 1200 }, deviceScaleFactor: 2 });
await p.route('**/tiles/**', (r) => r.abort());
await p.goto('http://127.0.0.1:8123/_shot.html', { waitUntil: 'networkidle' });
await p.waitForSelector('body[data-ready]');
await mkdir(outDir, { recursive: true });
await p.locator('#map').screenshot({ path: path.join(outDir, 'resort-map.png') });
await p.locator('#facts').screenshot({ path: path.join(outDir, 'resort-facts.png') });
await p.screenshot({ path: path.join(outDir, 'resort-view.png'), fullPage: true });
await browser.close();
server.close();
await rm('public/_shot.html', { force: true });
console.log('wrote resort-map.png, resort-facts.png, resort-view.png to', outDir);
process.exit(0);
