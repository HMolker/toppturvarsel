#!/usr/bin/env node
/**
 * Browser check of Switzerland (v6), offline.
 *
 *   node demo/swiss-check.mjs <outdir> [path/to/playwright]
 *
 * Runs the real server and a real refresh with the Swiss services answered
 * locally in their checked shapes: SLF's CAAMLv6 bulletin (test fixture,
 * SLF's own for 15 Feb 2026), IMIS stations and daily snow, swisstopo map
 * and slope tiles (drawn here), Open-Meteo heights (made-up mountains around
 * each Swiss tour) and a quiet forecast. Then: Switzerland in the country
 * picker, the sketch map, a region and a tour, and Plan a tour on
 * swisstopo's map with a route up the Allalinhorn.
 */

import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const [outDir = 'demo/out/swiss', pwPath] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
await mkdir(outDir, { recursive: true });

const dataDir = await mkdtemp(path.join(tmpdir(), 'ttv-swiss-check-'));
await mkdir(path.join(dataDir, 'cache'), { recursive: true });
Object.assign(process.env, { DATA_DIR: dataDir, LOG_LEVEL: 'error', TRACKS_WARMUP: 'false', SEASON_ONLY: 'false', TERRAIN_DAILY_POINTS: '1000000', GLO30: 'off', DEMO: 'off' });

const tours = JSON.parse(await readFile(path.join(repo, 'data/tours.json'), 'utf8'));
const regions = JSON.parse(await readFile(path.join(repo, 'data/regions.json'), 'utf8'));
const swissIds = new Set(regions.filter((r) => r.country === 'CH').map((r) => r.id));
const swiss = tours.filter((t) => swissIds.has(t.region));
const bulletins = JSON.parse(await readFile(path.join(repo, 'test/fixtures/slf-bulletins.json'), 'utf8'));

/* ---------- made-up Alps: a cone per Swiss tour ---------- */
const R = Math.PI / 180;
function z(lat, lon) {
  let h = 1500;
  for (const t of swiss) {
    const km = Math.hypot((lat - t.lat) * 111.2, (lon - t.lon) * 111.2 * Math.cos(t.lat * R));
    h = Math.max(h, t.summit_m - km * 420 + 60 * Math.sin(lat * 900) * Math.cos(lon * 700));
  }
  return Math.round(h);
}

/* ---------- a tiny PNG encoder ---------- */
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A grey swisstopo-like map, or the slope classes over 30° (yellow, orange, red, violet). */
function drawTile(tz, tx, ty, kind) {
  const N = 2 ** tz, n = 64, px = Buffer.alloc(256 * 256 * 4);
  const at = (i, j) => {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (j + 0.5) / n)) / N))) / R;
    const lon = ((tx + (i + 0.5) / n) / N) * 360 - 180;
    return z(lat, lon);
  };
  const lat0 = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 0.5)) / N))) / R;
  const cell = (40075016.686 * Math.cos(lat0 * R)) / N / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const e = at(i, j), dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell), dy = (at(i, j - 1) - at(i, j + 1)) / (2 * cell);
    const slope = Math.atan(Math.hypot(dx, dy)) / R;
    let c;
    if (kind === 'ch') {
      const shade = Math.max(0, Math.min(1, 0.75 + 0.8 * (-dx * 0.6 + dy * 0.6)));
      const g = (e > 2600 ? 245 : 225) * shade * (Math.abs(((e % 100) + 100) % 100) < 5 ? 0.75 : 1);
      c = [g, g, g, 255];
    } else {
      c = slope >= 45 ? [150, 60, 170, 190] : slope >= 40 ? [220, 40, 40, 190] : slope >= 35 ? [245, 150, 30, 190] : slope >= 30 ? [250, 230, 60, 190] : [0, 0, 0, 0];
    }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) px.set(c, (((j * 4 + y) * 256) + i * 4 + x) * 4);
  }
  return png(256, 256, px);
}

/* ---------- the upstreams ---------- */
const seen = { slf: 0, imis: 0, chTiles: 0, chsTiles: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
  if (u.includes('aws.slf.ch')) { seen.slf++; return J(bulletins); }
  if (u.includes('measurement-api.slf.ch') && u.endsWith('/stations')) {
    seen.imis++;
    return J(swiss.map((t, i) => ({ code: `IMIS${i}`, label: `${t.name.split(' ')[0]} station`, lat: t.lat + 0.03, lon: t.lon - 0.02, elevation: Math.round((t.summit_m - 900) / 10) * 10, country_code: 'CH', canton_code: 'VS', type: 'SNOW_FLAT' })));
  }
  if (u.includes('measurement-api.slf.ch') && u.includes('daily-snow')) {
    return J(swiss.flatMap((t, i) => [9, 10, 11, 12, 13, 14, 15].map((d) => ({ station_code: `IMIS${i}`, measure_date: `2026-02-${String(d).padStart(2, '0')}T06:00:00Z`, HS: 120 + i * 9 + d * 4, HN_1D: d >= 13 ? 10 + (i % 4) * 6 : 0 }))));
  }
  let m = u.match(/wmts\.geo\.admin\.ch\/1\.0\.0\/([^/]+)\/default\/current\/3857\/(\d+)\/(\d+)\/(\d+)\.(\w+)/);
  if (m) {
    const kind = m[1].includes('hangneigung') ? 'chs' : 'ch';
    seen[`${kind}Tiles`]++;
    return new Response(drawTile(+m[2], +m[3], +m[4], kind), { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  if (u.includes('/v1/elevation')) {
    const q = new URL(u).searchParams;
    const la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
    return J({ elevation: la.map((v, i) => z(v, lo[i])) });
  }
  if (u.includes('/v1/forecast')) {
    const days = [], time = [];
    const d0 = new Date(Date.now() - 2 * 86400e3);
    for (let k = 0; k < 7; k++) days.push(new Date(d0.getTime() + k * 86400e3).toISOString().slice(0, 10));
    days.forEach((d) => { for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`); });
    const H = (f) => time.map((_, i) => f(i % 24));
    return J({ elevation: 3000, daily: { time: days.slice(2), weather_code: days.slice(2).map(() => 1), temperature_2m_max: days.slice(2).map(() => -4), temperature_2m_min: days.slice(2).map(() => -12), precipitation_sum: days.slice(2).map(() => 0), snowfall_sum: days.slice(2).map(() => 0), wind_speed_10m_max: days.slice(2).map(() => 8), wind_gusts_10m_max: days.slice(2).map(() => 14), wind_direction_10m_dominant: days.slice(2).map(() => 320) },
      hourly: { time, temperature_2m: H((h) => -10 + 5 * Math.sin(((h - 8) / 24) * 2 * Math.PI)), wind_speed_10m: H(() => 4), wind_gusts_10m: H(() => 8), wind_direction_10m: H(() => 320), cloud_cover: H(() => 10), snowfall: H(() => 0), precipitation: H(() => 0), freezing_level_height: H(() => 1800) } });
  }
  if (u.includes('api.met.no')) {
    // MET Norway's Locationforecast covers the whole world (ECMWF outside the Nordics): clear and cold.
    const alt = +new URL(u).searchParams.get('altitude') || 0;
    const t0 = Math.floor(Date.now() / 3600e3) * 3600e3;
    const timeseries = Array.from({ length: 60 }, (_, i) => ({
      time: new Date(t0 + i * 3600e3).toISOString().replace('.000', ''),
      data: { instant: { details: { air_temperature: +(2 - alt / 160 - 4 * Math.cos((i / 24) * 2 * Math.PI)).toFixed(1), wind_speed: 3 + alt / 1000, wind_speed_of_gust: 6 + alt / 600, wind_from_direction: 320, cloud_area_fraction: 5 } },
        next_1_hours: { summary: { symbol_code: 'clearsky_day' }, details: { precipitation_amount: 0 } } },
    }));
    return new Response(JSON.stringify({ type: 'Feature', properties: { meta: { updated_at: new Date(t0).toISOString() }, timeseries } }), {
      status: 200, headers: { 'Content-Type': 'application/json', Expires: new Date(Date.now() + 3600e3).toUTCString(), 'Last-Modified': new Date(t0).toUTCString() },
    });
  }
  if (u.includes('overpass')) return J({ elements: [] });
  return new Response('offline', { status: 503 });
};

const { refresh } = await import('../src/refresh.js');
const snap = await refresh({ force: true, date: new Date('2026-02-15T08:00:00Z') });
const zer = snap.regions.find((r) => r.id === 'ch-4222');
console.log('refresh:', JSON.stringify({ slf: snap.sources.slf, slfSnow: snap.sources.slfSnow, zermatt: { danger: zer.bulletin.danger, sub: zer.bulletin.dangerSub, problems: zer.bulletin.problems.length, depth: zer.snow?.depthCm, new48: zer.snow?.new48 } }));

const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400 && !/fonts|\/tiles\/|\/api\/track|\/api\/resorts|snowhistory|\/api\/huts|\/api\/photos/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = async (name, el = null) => {
  const f = path.join(outDir, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: f });
  else await page.screenshot({ path: f });
  console.log('shot', f);
};

// Someone new: the page opens on Norway and Sweden, Switzerland one click away.
await page.goto(`${base}/`);
await page.waitForSelector('#countryBar [data-country="CH"]');
console.log('first view:', await page.evaluate(() => [...document.querySelectorAll('#countryBar [aria-pressed="true"]')].map((b) => b.textContent).join(', ')));
await page.click('#countryBar [data-country="NO"]');
await page.click('#countryBar [data-country="SE"]').catch(() => {});
await page.click('#countryBar [data-country="CH"]');
await page.evaluate(() => {
  for (const c of ['NO', 'SE']) {
    const b = document.querySelector(`#countryBar [data-country="${c}"]`);
    if (b?.getAttribute('aria-pressed') === 'true') b.click();
  }
});
await page.waitForTimeout(800);
console.log('after the clicks:', await page.evaluate(() => [...document.querySelectorAll('#countryBar [aria-pressed="true"]')].map((b) => b.textContent).join(', ')));
await shot('1-map-switzerland', '.mapcard, #map');

// A region: SLF's bulletin.
await page.evaluate(() => document.querySelector('[data-region="ch-4222"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(400);
let det = await page.evaluate(() => document.querySelector('#detail')?.innerText ?? '');
if (!/Zermatt/.test(await page.evaluate(() => document.querySelector('#detailTitle')?.textContent ?? ''))) {
  // No clickable region marker found: pick it from the region list instead.
  await page.selectOption('#fRegion', 'ch-4222').catch(() => {});
}
await page.evaluate(() => window.scrollTo(0, 0));
console.log('region:', det.replace(/\s+/g, ' ').slice(0, 420));
await shot('2-region-zermatt', '#detail');

// A tour.
await page.evaluate(() => document.querySelector('[data-tour="Allalinhorn"]')?.click());
await page.waitForTimeout(1500);
det = await page.evaluate(() => document.querySelector('#detail')?.innerText ?? '');
console.log('tour:', det.replace(/\s+/g, ' ').slice(0, 600));
await shot('3-tour-allalinhorn', '#detail');

// Plan a tour on swisstopo's map.
await page.goto(`${base}/terrain#tour=Allalinhorn`);
await page.waitForFunction(() => window.fjallskredTerrain?.state.ref?.tour, null, { timeout: 30000 });
await page.waitForFunction(() => [...document.querySelectorAll('.slippy-layer img')].length > 0 && [...document.querySelectorAll('.slippy-layer img')].every((i) => i.complete), null, { timeout: 60000 });
await page.waitForTimeout(600);
const layers = await page.evaluate(() => [...new Set([...document.querySelectorAll('.slippy-layer img')].map((i) => i.getAttribute('src').split('/')[1]))]);
console.log('terrain tiles from:', layers.join(', '), '·', JSON.stringify(seen));
console.log('legend:', await page.evaluate(() => document.querySelector('#tlegend')?.innerText.replace(/\s+/g, ' ')));
console.log('credit:', await page.evaluate(() => document.querySelector('#tattrib')?.innerText));
await shot('4-plan-swisstopo', '.tmapcard');

const T = swiss.find((t) => t.name === 'Allalinhorn');
const pts = [[T.lat + 0.035, T.lon - 0.02], [T.lat + 0.02, T.lon - 0.012], [T.lat + 0.008, T.lon - 0.004], [T.lat, T.lon]];
await page.evaluate((p) => window.fjallskredTerrain.map.fit(p.map(([lat, lon]) => ({ lat, lon })), 80, 15), pts);
await page.click('#drawBtn');
const box = await page.locator('#tmap').boundingBox();
for (const [lat, lon] of pts) {
  const [x, y] = await page.evaluate(([a, b]) => window.fjallskredTerrain.map.project(a, b), [lat, lon]);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(120);
}
await page.click('#drawBtn');
await page.waitForFunction(() => window.fjallskredTerrain.state.analysis || !document.querySelector('#tmsg').hidden, null, { timeout: 60000 }).catch(() => {});
console.log('after drawing:', await page.evaluate(() => JSON.stringify({ route: window.fjallskredTerrain.state.route?.length, msg: document.querySelector('#tmsg').hidden ? '' : document.querySelector('#tmsg').textContent, analysis: !!window.fjallskredTerrain.state.analysis })));
await page.waitForFunction(() => window.fjallskredTerrain.state.analysis, null, { timeout: 60000 });
await page.waitForTimeout(600);
const a = await page.evaluate(() => {
  const s = window.fjallskredTerrain.state;
  return { dist: s.analysis.distanceM, up: s.analysis.ascentM, steep: Math.round(s.analysis.steepest?.slope ?? 0), problems: s.analysis.problemSections.length, src: s.profile.source, country: s.profile.country };
});
console.log('route:', JSON.stringify(a));
await shot('5-route', '.tmapcard');
await shot('6-route-panel', '.tside');

const real = errors.filter((e) => !/Failed to load resource/.test(e));
console.log(real.length ? `ERRORS:\n${real.join('\n')}` : 'no page errors');
await browser.close();
server.close();
process.exit(real.length ? 1 : 0);
