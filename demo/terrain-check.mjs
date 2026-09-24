#!/usr/bin/env node
/**
 * Browser check of the v5 terrain page, offline.
 *
 *   node demo/terrain-check.mjs <outdir> [path/to/playwright]
 *
 * Runs the real server with its upstream answered locally: heights from the
 * advert's made-up Hallingdal mountains (demo/advert/terrain.mjs), topo tiles
 * drawn as a hillshade of the same model, NVE's slope map drawn from it in
 * NVE's classes, a bulletin with a wind-slab problem on N–E aspects, and a MET Norway
 * forecast with snow showers and rising wind.
 * Then drives the page: shading, drawing a route on Høgeloft, the analysis,
 * the weather on the route, a GPX export and import, a suggested way up and
 * the 3D view, with screenshots of each.
 */

import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const [outDir = 'demo/out/terrain', pwPath] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
await mkdir(outDir, { recursive: true });

const dataDir = await mkdtemp(path.join(tmpdir(), 'ttv-terrain-check-'));
await mkdir(path.join(dataDir, 'cache'), { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';
process.env.TRACKS_WARMUP = 'false';
process.env.RESORTS_ENABLED = 'false';

const tours = JSON.parse(await readFile(path.join(repo, 'data/tours.json'), 'utf8'));
const regions = JSON.parse(await readFile(path.join(repo, 'data/regions.json'), 'utf8'));
const { makeTerrain } = await import('./advert/terrain.mjs');
const z = makeTerrain(tours.filter((t) => t.region === 'hallingdal'));

/* ---------------- a tiny PNG encoder ---------------- */
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- tiles drawn from the terrain model ---------------- */
const R = Math.PI / 180;
function tileGrid(tz, tx, ty, n = 64) {
  // heights on an (n+2)^2 grid covering the tile plus a one-cell border
  const N = 2 ** tz, g = new Float64Array((n + 2) * (n + 2));
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (j + 0.5) / n)) / N))) / R;
    const lon = ((tx + (i + 0.5) / n) / N) * 360 - 180;
    g[(j + 1) * (n + 2) + (i + 1)] = z(lat, lon);
  }
  const lat0 = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 0.5)) / N))) / R;
  const cell = (40075016.686 * Math.cos(lat0 * R)) / N / n;
  return { g, n, cell };
}
function drawTile(tz, tx, ty, kind) {
  const { g, n, cell } = tileGrid(tz, tx, ty);
  const W = n + 2, px = Buffer.alloc(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = Math.min(n - 1, Math.floor((x / 256) * n)) + 1, j = Math.min(n - 1, Math.floor((y / 256) * n)) + 1;
    const e = g[j * W + i];
    const dx = (g[j * W + i + 1] - g[j * W + i - 1]) / (2 * cell), dy = (g[(j - 1) * W + i] - g[(j + 1) * W + i]) / (2 * cell);
    const slope = Math.atan(Math.hypot(dx, dy)) / R;
    const o = (y * 256 + x) * 4;
    if (kind === 'topo') {
      const shade = Math.max(0, Math.min(1, 0.72 + 0.9 * (-dx * 0.6 + dy * 0.6) / Math.hypot(1, Math.hypot(dx, dy))));
      const contour = Math.abs(((e % 100) + 100) % 100) < 4 ? 0.72 : 1;
      const base = (e > 1300 ? 246 : 232) * shade * contour;
      px.set([base, base, base * (e > 1300 ? 1 : 0.95), 255], o);
    } else {
      let c = null;
      if (slope >= 50) c = [30, 30, 30];
      else if (slope >= 45) c = [130, 40, 150];
      else if (slope >= 40) c = [215, 40, 30];
      else if (slope >= 35) c = [240, 140, 30];
      else if (slope >= 30) c = [245, 215, 40];
      else if (slope >= 27) c = [140, 190, 60];
      else if (slope >= 20) c = [120, 160, 220];
      if (c) px.set([...c, 200], o);
    }
  }
  return png(256, 256, px);
}

/* ---------------- the server's upstream ---------------- */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
  if (u.includes('hoydedata')) {
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    return J({ koordsys: 4258, punkter: pts.map(([lon, lat]) => ({ datakilde: 'dtm1', x: lon, y: lat, z: z(lat, lon) })) });
  }
  if (u.includes('/v1/elevation')) {
    const q = new URL(u).searchParams;
    const la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
    return J({ elevation: la.map((v, i) => z(v, lo[i])) });
  }
  let m = u.match(/topograatone\/default\/webmercator\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (m) return new Response(drawTile(+m[1], +m[3], +m[2], 'topo'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  m = u.match(/Bratthet_med_utlop_2024\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)/);
  if (m) return new Response(drawTile(+m[1], +m[3], +m[2], 'nve'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  if (u.includes('overpass')) return J({ elements: [] });
  if (u.includes('ws.geonorge.no/stedsnavn')) {
    const q = new URL(u).searchParams.get('sok');
    return J({ navn: /hardanger|vidda/i.test(q) ? [
      { skrivemåte: 'Hårteigen', navneobjekttype: 'Fjell', stedsnummer: 501, representasjonspunkt: { øst: 6.9, nord: 60.3 }, kommuner: [{ kommunenavn: 'Ullensvang' }], fylker: [{ fylkesnavn: 'Vestland' }] },
      { skrivemåte: 'Hardangervidda', navneobjekttype: 'Fjellområde', stedsnummer: 502, representasjonspunkt: { øst: 7.4, nord: 60.1 }, kommuner: [{ kommunenavn: 'Eidfjord' }], fylker: [{ fylkesnavn: 'Vestland' }] },
    ] : [] });
  }
  if (u.includes('nominatim')) {
    const q = new URL(u).searchParams.get('q');
    return J(/st[äa]djan/i.test(q) ? [{ place_id: 1, osm_type: 'node', osm_id: 42, lat: '61.9197', lon: '12.8730', name: 'Städjan', type: 'peak', display_name: 'Städjan, Älvdalens kommun, Dalarnas län, Sverige' }] : []);
  }
  m = u.match(/tile\.opentopomap\.org\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (m) return new Response(drawTile(+m[1], +m[2], +m[3], 'topo'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  if (u.includes('/v1/forecast')) {
    // Open-Meteo, Norwegian local time: clear and calm mornings, spring-mild
    // afternoons, a front on day 3.
    const q = new URL(u).searchParams;
    const days = [];
    const d0 = new Date(Date.now() - 2 * 86400e3);
    for (let k = 0; k < 7; k++) days.push(new Date(d0.getTime() + k * 86400e3).toISOString().slice(0, 10));
    const time = [], t = [], w = [], g = [], dir = [], cl = [], sn = [], pr = [], fl = [];
    days.forEach((d, k) => { for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      const front = k === 4;
      t.push(-6 + 5 * Math.sin(((h - 8) / 24) * 2 * Math.PI)); w.push(front ? 16 : 3 + h / 6); g.push(front ? 24 : 6 + h / 4);
      dir.push(240); cl.push(front ? 100 : 15); sn.push(front ? 1.2 : 0); pr.push(front ? 1.2 : 0); fl.push(800);
    } });
    return J({ elevation: +q.get('elevation') || 1000, daily: { time: days, weather_code: days.map(() => 1), temperature_2m_max: days.map(() => -2), temperature_2m_min: days.map(() => -9),
      precipitation_sum: days.map(() => 0), snowfall_sum: days.map(() => 0), wind_speed_10m_max: days.map(() => 6), wind_gusts_10m_max: days.map(() => 10), wind_direction_10m_dominant: days.map(() => 240) },
      hourly: { time, temperature_2m: t, wind_speed_10m: w, wind_gusts_10m: g, wind_direction_10m: dir, cloud_cover: cl, snowfall: sn, precipitation: pr, freezing_level_height: fl } });
  }
  if (u.includes('api.met.no')) {
    // MET Norway's GeoJSON: a cold front with snow showers and rising wind.
    const q = new URL(u).searchParams;
    const alt = +q.get('altitude') || 0;
    const t0 = Math.floor(Date.now() / 3600e3) * 3600e3;
    const timeseries = Array.from({ length: 60 }, (_, i) => ({
      time: new Date(t0 + i * 3600e3).toISOString().replace('.000', ''),
      data: {
        instant: { details: { air_temperature: +(1 - alt / 150 - i / 12).toFixed(1), wind_speed: +(3 + i / 4 + alt / 400).toFixed(1), wind_speed_of_gust: +(6 + i / 2.5 + alt / 250).toFixed(1), wind_from_direction: 240, cloud_area_fraction: 90 } },
        next_1_hours: { summary: { symbol_code: i > 12 ? 'snowshowers_day' : 'cloudy' }, details: { precipitation_amount: i > 12 ? +(0.3 + (i % 5) / 10).toFixed(1) : 0 } },
      },
    }));
    return new Response(JSON.stringify({ type: 'Feature', properties: { meta: { updated_at: new Date(t0).toISOString() }, timeseries } }), {
      status: 200, headers: { 'Content-Type': 'application/json', Expires: new Date(Date.now() + 3600e3).toUTCString(), 'Last-Modified': new Date(t0).toUTCString() },
    });
  }
  return new Response('offline', { status: 503 });
};

// A bulletin: wind slab on N–E aspects above 1300 m, danger 3.
const snapshot = {
  fetchedAt: new Date().toISOString(), status: 'ok', season: true, sources: {},
  regions: regions.map((r) => ({
    ...r,
    bulletin: r.id === 'hallingdal' ? { danger: 3, headline: 'Wind slab on lee slopes', problems: [{ type: 'Dry slab avalanche', problemType: 'Wind-drifted snow', aspects: '11100000', heights: { h1: 1300, h2: 0, fill: 1 } }] } : null,
    snow: null,
  })),
  tours: tours.map((t) => ({ ...t, snow: null })),
};
// Snow on the regions, so the sketch has something to colour: deeper north, a storm in the west.
snapshot.regions.forEach((r, i) => {
  r.snow = r.offMap ? null : { depthCm: Math.round(20 + (r.lat - 58) * 18 + (i % 4) * 15), new48: Math.round(Math.max(0, (9 - r.lon) * 6 + (i % 3) * 4)) };
});
await writeFile(path.join(dataDir, 'cache', 'current.json'), JSON.stringify(snapshot));

const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('server', base);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
// 404s are expected: fonts that are not installed, NVE tiles with nothing drawn, a tour with no route.
page.on('response', (r) => { if (r.status() >= 400 && !/fonts|\/tiles\/nve\/|\/api\/track|\/api\/resorts/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const shot = async (name, el = null) => {
  const f = path.join(outDir, `${name}.png`);
  if (el) await page.locator(el).screenshot({ path: f });
  else await page.screenshot({ path: f, fullPage: false });
  console.log('shot', f);
};

await page.goto(`${base}/terrain#tour=${encodeURIComponent('Høgeloft')}`);
await page.waitForFunction(() => window.fjallskredTerrain?.state.ref?.tour);
await page.waitForFunction(() => [...document.querySelectorAll('.slippy-layer img')].every((i) => i.complete), null, { timeout: 60000 });
await page.waitForTimeout(500);
await shot('1-nve-map', '.tmapcard');

// Computed slope shading.
await page.selectOption('#lyrShade', 'slope');
await page.uncheck('#lyrNve');
await page.waitForFunction(() => window.fjallskredTerrain.dem.busy === 0 && window.fjallskredTerrain.dem.tiles.size > 0, null, { timeout: 60000 });
await page.waitForTimeout(500);
await shot('2-computed-slope', '.tmapcard');
await page.selectOption('#lyrShade', 'aspect');
await page.waitForTimeout(600);
await shot('3-aspect', '.tmapcard');
await page.selectOption('#lyrShade', 'problems');
await page.waitForTimeout(600);
await shot('4-problems', '.tmapcard');
await page.selectOption('#lyrShade', 'off');
await page.check('#lyrNve');

// Draw a route: from the valley south-east of Høgeloft straight up its NE side.
const H = tours.find((t) => t.name === 'Høgeloft');
const pts = [[H.lat - 0.03, H.lon + 0.03], [H.lat - 0.012, H.lon + 0.022], [H.lat + 0.004, H.lon + 0.012], [H.lat, H.lon]];
await page.evaluate((p) => window.fjallskredTerrain.map.fit(p.map(([lat, lon]) => ({ lat, lon })), 80, 15), pts);
await page.click('#drawBtn');
const box = await page.locator('#tmap').boundingBox();
for (const [lat, lon] of pts) {
  const [x, y] = await page.evaluate(([a, b]) => window.fjallskredTerrain.map.project(a, b), [lat, lon]);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(120);
}
await page.click('#drawBtn');
await page.waitForFunction(() => window.fjallskredTerrain.state.analysis, null, { timeout: 60000 });
await page.waitForTimeout(400);
await shot('5-route-map', '.tmapcard');
await shot('6-route-panel', '.tside');
const a = await page.evaluate(() => {
  const s = window.fjallskredTerrain.state;
  return { dist: s.analysis.distanceM, up: s.analysis.ascentM, steep: s.analysis.steepest?.slope, sections: s.analysis.steepSections.length, problems: s.analysis.problemSections.length, runout: s.analysis.runoutM, src: s.profile.source, n: s.profile.samples.length };
});
console.log('analysis', a);

// Weather on the route (v5.1).
await page.waitForSelector('#rweather .wtable', { timeout: 30000 });
await page.locator('#rweather').scrollIntoViewIfNeeded();
await shot('6b-weather', '#rweather');

// GPX export and import (v5.1).
{
  await page.fill('#rname', 'Høgeloft NE');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gpxOutBtn')]);
  const gpxFile = path.join(outDir, dl.suggestedFilename());
  await dl.saveAs(gpxFile);
  const xml = await readFile(gpxFile, 'utf8');
  console.log('exported', dl.suggestedFilename(), (xml.match(/<trkpt/g) ?? []).length, 'trkpt,', (xml.match(/<ele>/g) ?? []).length, 'ele');
  // Import it again as a long made-up watch track.
  const trk = [];
  for (let i = 0; i <= 800; i++) {
    const t = i / 800;
    trk.push(`<trkpt lat="${(H.lat - 0.03 * (1 - t)).toFixed(6)}" lon="${(H.lon + 0.03 * (1 - t) + 0.002 * Math.sin(t * 40)).toFixed(6)}"><ele>${Math.round(z(H.lat - 0.03 * (1 - t), H.lon + 0.03 * (1 - t)))}</ele></trkpt>`);
  }
  const watch = path.join(outDir, 'watch.gpx');
  await writeFile(watch, `<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect"><trk><name>Morning ski tour</name><trkseg>${trk.join('')}</trkseg></trk></gpx>`);
  const saved = await page.evaluate(() => window.fjallskredTerrain.state.route.map((p) => p.slice()));
  await page.setInputFiles('input[type=file]', watch);
  await page.waitForFunction(() => document.querySelector('#rname').value === 'Morning ski tour');
  await page.waitForFunction(() => window.fjallskredTerrain.state.analysis && window.fjallskredTerrain.state.profileKey === JSON.stringify(window.fjallskredTerrain.state.route.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])), null, { timeout: 60000 });
  console.log('imported', await page.evaluate(() => window.fjallskredTerrain.state.route.length), 'points;', await page.textContent('#tmsg'));
  await shot('6c-gpx-imported', '.tmapcard');
  // Back to the drawn route for the rest.
  await page.evaluate((r) => { const t = window.fjallskredTerrain; t.state.route = r; }, saved);
  await page.click('#undoBtn');
  await page.waitForFunction(() => window.fjallskredTerrain.state.analysis && document.querySelector('#rname'));
}

// Drag the second point to check editing.
{
  const [x, y] = await page.evaluate(([a, b]) => window.fjallskredTerrain.map.project(a, b), pts[1]);
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x - 60, box.y + y + 10, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction((old) => window.fjallskredTerrain.state.route[1][1] !== old, pts[1][1]);
  console.log('dragged point 2 ok');
}

// A whole tour: start in the valley, two descents, build it.
{
  await page.click('#clearBtn');
  const click = async ([lat, lon]) => {
    const [x, y] = await page.evaluate(([a, b]) => window.fjallskredTerrain.map.project(a, b), [lat, lon]);
    await page.mouse.click(box.x + x, box.y + y);
    await page.waitForTimeout(80);
  };
  const S0 = [H.lat - 0.03, H.lon + 0.03];
  const D1 = [[H.lat - 0.001, H.lon + 0.001], [H.lat - 0.006, H.lon - 0.008], [H.lat - 0.014, H.lon - 0.012]];
  const D2 = [[H.lat - 0.004, H.lon + 0.004], [H.lat - 0.012, H.lon + 0.012], [H.lat - 0.02, H.lon + 0.02]];
  await page.evaluate((p) => window.fjallskredTerrain.map.fit(p.map(([lat, lon]) => ({ lat, lon })), 80, 15), [S0, ...D1, ...D2]);
  await page.click('#startBtn');
  await click(S0);
  await page.click('#descBtn');
  for (const p of D1) await click(p);
  await page.click('#descBtn'); // finish descent 1
  await page.click('#descBtn'); // start descent 2
  for (const p of D2) await click(p);
  await click([H.lat - 0.025, H.lon + 0.025]); // one point too many...
  await page.click('#tourUndoBtn'); // ...undone
  await page.click('#descBtn'); // finish descent 2
  const t = await page.evaluate(() => window.fjallskredTerrain.state.tour);
  console.log('tour input', { start: !!t.start, descents: t.descents.map((d) => d.length) });
  await shot('7-tour-input', '.tmapcard');
  await page.click('#buildBtn');
  await page.waitForFunction(() => { const s = window.fjallskredTerrain.state; return s.built && s.analysis && s.profileKey === s.built.key; }, null, { timeout: 180000 });
  await page.waitForTimeout(400);
  await shot('8-tour-map', '.tmapcard');
  await page.locator('#rdetail .tourtbl').first().scrollIntoViewIfNeeded();
  await shot('8b-tour-panel', '.tside');
  // When to go.
  await page.waitForSelector('#tourDay .daystrip, #tourDay .note', { timeout: 120000 });
  await page.waitForFunction(() => !/Loading the forecast/.test(document.querySelector('#tourDay')?.textContent ?? ''), null, { timeout: 120000 });
  await page.locator('#tourDay').scrollIntoViewIfNeeded();
  await shot('8c-when-to-go', '#tourDay');
  console.log('when to go:', (await page.textContent('#tourDay .daysum').catch(() => 'no plan')).trim());
  if (await page.locator('#reorderBtn').count()) {
    await page.click('#reorderBtn');
    await page.waitForFunction(() => !/Trying the orders/.test(document.querySelector('#reorderOut')?.textContent ?? 'Trying'), null, { timeout: 120000 });
    await page.locator('#reorderOut').scrollIntoViewIfNeeded();
    await shot('8d-reorder', '#tourDay');
    console.log('reorder:', (await page.textContent('#reorderOut')).replace(/\s+/g, ' ').slice(0, 220));
    if (await page.locator('#useOrderBtn').count()) {
      const before = await page.evaluate(() => window.fjallskredTerrain.state.built);
      await page.click('#useOrderBtn');
      await page.waitForFunction((b) => { const s = window.fjallskredTerrain.state; return s.built && s.built.key !== b && s.analysis && s.profileKey === s.built.key; }, before.key, { timeout: 180000 });
      await page.waitForFunction(() => /Leave/.test(document.querySelector('#tourDay .daysum')?.textContent ?? ''), null, { timeout: 120000 });
      console.log('after reorder:', (await page.textContent('#tourDay .daysum')).trim(), '·', await page.evaluate(() => window.fjallskredTerrain.state.built.parts.map((p) => p.label).join(' → ')));
      await shot('8e-reordered', '#tourDay');
    }
  }
  console.log('tour', await page.evaluate(() => {
    const s = window.fjallskredTerrain.state;
    return { points: s.route.length, parts: s.built.parts.map((p) => `${p.kind}:${p.label}`), danger: s.built.danger, cellM: Math.round(s.built.cellM), text: document.querySelector('.tourtbl tr.tot')?.textContent };
  }));
}

// Wet snow on the drawn order: a north face first, a south face second.
{
  await page.click('#tourClearBtn');
  await page.click('#clearBtn');
  await page.locator('#tmap').scrollIntoViewIfNeeded();
  const click = async ([lat, lon]) => {
    const mb = await page.locator('#tmap').boundingBox(); // the page may have scrolled
    const [x, y] = await page.evaluate(([a, b]) => window.fjallskredTerrain.map.project(a, b), [lat, lon]);
    await page.mouse.click(mb.x + x, mb.y + y);
    await page.waitForTimeout(80);
  };
  const S0 = [H.lat - 0.02, H.lon];
  const DN = [[H.lat + 0.001, H.lon], [H.lat + 0.008, H.lon], [H.lat + 0.016, H.lon]]; // skis north
  const DS = [[H.lat - 0.001, H.lon], [H.lat - 0.006, H.lon], [H.lat - 0.012, H.lon]]; // skis south
  await page.evaluate((p) => window.fjallskredTerrain.map.fit(p.map(([lat, lon]) => ({ lat, lon })), 80, 15), [S0, ...DN, ...DS]);
  await page.click('#startBtn'); await click(S0);
  await page.click('#descBtn'); for (const p of DN) await click(p); await page.click('#descBtn');
  await page.click('#descBtn'); for (const p of DS) await click(p); await page.click('#descBtn');
  console.log('N+S input:', JSON.stringify(await page.evaluate(() => { const s = window.fjallskredTerrain.state; return { start: !!s.tour.start, d: s.tour.descents.map((d) => d.length), mode: s.mode, hint: document.querySelector('#tourHint').textContent }; })));
  await page.click('#buildBtn');
  await page.waitForFunction(() => { const s = window.fjallskredTerrain.state; return s.built && s.analysis && s.profileKey === s.built.key; }, null, { timeout: 180000 });
  await page.waitForFunction(() => /Leave/.test(document.querySelector('#tourDay .daysum')?.textContent ?? ''), null, { timeout: 120000 });
  // Pick the first forecast day with wet snow in the plan.
  const opts = await page.$$eval('#tourDaySel option', (o) => o.map((x) => x.value));
  for (const d of opts) {
    await page.selectOption('#tourDaySel', d);
    await page.waitForFunction(() => /Leave|No hourly/.test(document.querySelector('#tourDay')?.textContent ?? ''), null, { timeout: 60000 });
    if (await page.locator('#reorderBtn').count()) break;
  }
  console.log('N+S tour:', (await page.textContent('#tourDay .daysum')).trim(), '· reorder button:', await page.locator('#reorderBtn').count());
  if (await page.locator('#reorderBtn').count()) {
    await page.click('#reorderBtn');
    await page.waitForFunction(() => !/Trying the orders/.test(document.querySelector('#reorderOut')?.textContent ?? 'Trying'), null, { timeout: 120000 });
    console.log('N+S reorder:', (await page.textContent('#reorderOut')).replace(/\s+/g, ' ').slice(0, 160));
    await page.locator('#reorderOut').scrollIntoViewIfNeeded();
    await shot('8f-reorder-better', '#tourDay');
    if (await page.locator('#useOrderBtn').count()) {
      const before = await page.evaluate(() => window.fjallskredTerrain.state.built.key);
      await page.click('#useOrderBtn');
      await page.waitForFunction((b) => { const s = window.fjallskredTerrain.state; return s.built && s.built.key !== b && s.analysis && s.profileKey === s.built.key; }, before, { timeout: 180000 });
      await page.waitForFunction(() => /Leave/.test(document.querySelector('#tourDay .daysum')?.textContent ?? ''), null, { timeout: 120000 });
      console.log('N+S after:', await page.evaluate(() => window.fjallskredTerrain.state.built.parts.map((p) => p.label).join(' → ')), '·', (await page.textContent('#tourDay .daysum')).trim(), '· wet warnings:', await page.locator('#tourDay .warnline').count());
      await shot('8g-reordered', '#tourDay');
    }
  }
}

// 3D.
await page.selectOption('#lyrShade', 'slope');
await page.click('#view3dBtn');
await page.waitForFunction(() => /grid|along the route/.test(document.querySelector('#t3dNote').textContent) || /WebGL/.test(document.querySelector('#t3dNote').textContent), null, { timeout: 120000 });
await page.waitForTimeout(800);
await shot('9-3d', '#t3d');
console.log('3d note:', await page.textContent('#t3dNote'));
await page.click('#t3dClose');

// The conditions page: the real map.
{
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.querySelectorAll('#map .slippy-svg g.reg').length > 5, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await shot('14-main-map', '.mapbox');
  console.log('sketch: snow areas', await page.locator('#map .snowareas path').count(), '· tiles', await page.locator('#map .slippy-layer img').count());
  await page.click('.seg button[data-layer="danger"]');
  await page.waitForTimeout(300);
  await shot('14b-main-map-danger', '.mapbox');
  console.log('danger layer: snow areas', await page.locator('#map .snowareas path').count());
  await page.click('.seg button[data-layer="snow"]');
  // Zoom in twice on the buttons and click a tour pin.
  await page.click('.zoombtn[data-zoom="in"]');
  await page.click('.zoombtn[data-zoom="in"]');
  await page.waitForTimeout(800);
  // A pin well inside the visible map (not under the zoom buttons).
  const target = await page.evaluate(() => {
    const m = document.querySelector('#map').getBoundingClientRect();
    for (const g of document.querySelectorAll('#map g.tourpin')) {
      const b = g.getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      if (x > m.x + 80 && x < m.right - 40 && y > m.y + 60 && y < m.bottom - 40 && document.elementFromPoint(x, y)?.closest('g.tourpin') === g) return { x, y, name: g.dataset.tour };
    }
    return null;
  });
  const name = target?.name;
  if (target) await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(600);
  console.log('main map: regions', await page.locator('#map g.reg').count(), '· clicked', name, '→ detail:', await page.textContent('#detailTitle'));
  // Drag to pan.
  const mb = await page.locator('#map').boundingBox();
  await page.mouse.move(mb.x + 300, mb.y + 300); await page.mouse.down(); await page.mouse.move(mb.x + 380, mb.y + 340, { steps: 5 }); await page.mouse.up();
  await page.locator('#showResorts').check().catch(() => {});
  await page.waitForTimeout(800);
  await shot('15-main-map-zoomed', '.mapbox');

  // Find a place: the list, the pin, and Plan a tour there.
  await page.fill('#mapFind', 'Hardanger');
  await page.press('#mapFind', 'Enter');
  await page.waitForSelector('.psbox .psitem', { timeout: 20000 });
  await page.waitForTimeout(300);
  await shot('16-find', '.mapbox');
  console.log('find:', JSON.stringify(await page.$$eval('.psbox .psitem', (els) => els.map((e) => e.textContent))));
  await page.click('.psbox .psitem:has-text("Hårteigen")');
  await page.waitForSelector('#pinbar:not([hidden])');
  await page.waitForTimeout(500);
  await shot('17-pin', '.mapbox');
  console.log('pin bar:', await page.textContent('#pinbar'), '· needle', await page.locator('#map .needle').count());
  await page.click('#pinPlan');
  await page.waitForURL(/\/terrain#/);
  await page.waitForFunction(() => window.fjallskredTerrain?.state.zoneLoaded);
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => [...document.querySelectorAll('.slippy-layer img')].every((i) => i.complete), null, { timeout: 60000 });
  await shot('18-terrain-at-place', '.tmapcard');
  console.log('terrain at place:', await page.evaluate(() => { const S = window.fjallskredTerrain.state; return JSON.stringify({ pin: S.pin, places: S.zone.filter((t) => t.kind === 'place').map((t) => t.name), tiles: document.querySelectorAll('.slippy-layer img').length, msg: document.querySelector('#tmsg').hidden ? '' : document.querySelector('#tmsg').textContent }); }));
  // Go to on Plan a tour: a Swedish name.
  await page.fill('#goto', 'Städjan');
  await page.press('#goto', 'Enter');
  await page.waitForSelector('.psbox .psitem', { timeout: 20000 });
  await page.waitForTimeout(500);
  console.log('goto list:', JSON.stringify(await page.$$eval('.psbox .psitem', (els) => els.map((e) => e.textContent))), await page.$$eval('.psbox .psnote', (els) => els.map((e) => e.textContent).join(' | ')));
  await shot('19a-terrain-goto-list', '.tmapcard');
  await page.click('.psbox .psitem:has-text("Sweden")');
  await page.waitForFunction(() => window.fjallskredTerrain.state.pin?.name === 'Städjan');
  await page.waitForTimeout(1500);
  await shot('19-terrain-goto-sweden', '.tmapcard');
  console.log('goto Sweden:', await page.evaluate(() => { const S = window.fjallskredTerrain.state; return JSON.stringify({ places: S.zone.filter((t) => t.kind === 'place').map((t) => t.name), centre: window.fjallskredTerrain.map?.center?.() }); }));
}

// Same frame on every sub-page.
for (const [name, url] of [['11-skill', '/skill'], ['12-editor', '/editor'], ['13-terrain', '/terrain']]) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}${url}`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } });
  const back = await page.locator('a[href="/"]:has-text("Conditions")').count();
  console.log(url, 'back link:', back);
}
await page.goto(`${base}/terrain`);

// Phone width.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, '10-phone.png'), fullPage: true });

const real = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
console.log(real.length ? `ERRORS:\n${real.join('\n')}` : 'no page errors');
await browser.close();
server.close();
process.exit(real.length ? 1 : 0);
