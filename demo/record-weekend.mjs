#!/usr/bin/env node
/**
 * The ~3 minute weekend film: a February weekend around Harahorn in
 * Hemsedal, planned in Fjällskred from the Friday to the après-ski on Sunday.
 *
 *   node demo/record-weekend.mjs <out.mp4> [path/to/playwright] [--probe]
 *   python3 demo/weekend/music.py <out.wav> <out>.timeline.json
 *   ffmpeg -i <out.mp4> -i <out.wav> -c:v copy -c:a aac -b:a 192k -shortest <final.mp4>
 *
 * The pages are the real app on the real server. Made up for the film:
 *   - the weekend's weather, snow, bulletins and lift status
 *     (demo/weekend/scenario.mjs), served in place of /api/conditions,
 *     /api/alerts, /api/outlook, /api/forecast and /api/resorts;
 *   - the terrain (demo/weekend/terrain.mjs): every height the server asks
 *     Kartverket or Open-Meteo for, and the map and NVE tiles, are drawn from
 *     it, so slopes, routes, runs, profiles and the 3D view are computed by
 *     the real code on made-up mountains;
 *   - MET Norway's point forecast on the route, and the place-name search.
 * The browser's clock is set to the story's days. Captions, the pointer and
 * the title and end cards are overlays.
 */

import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const [outFile, pwPath] = args.filter((a) => !a.startsWith('--'));
if (!outFile) {
  console.error('usage: node demo/record-weekend.mjs <out.mp4> [playwright module path] [--probe]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dataDir = await mkdtemp(path.join(tmpdir(), 'ttv-weekend-'));
await mkdir(path.join(dataDir, 'cache'), { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'false';
process.env.TRACKS_WARMUP = 'false';
process.env.RESORTS_ENABLED = 'false';
process.env.TERRAIN_DAILY_POINTS = '2000000';
process.env.GLO30 = 'off';
process.env.NOMINATIM_GAP_MS = '0';

const { makeTerrain, offset } = await import('./weekend/terrain.mjs');
const { buildWeek, dateOf, hourAt } = await import('./weekend/scenario.mjs');

const regionsJson = JSON.parse(await readFile(path.join(repo, 'data/regions.json'), 'utf8'));
const regions = regionsJson.regions ?? regionsJson;
const toursJson = JSON.parse(await readFile(path.join(repo, 'data/tours.json'), 'utf8'));
const tours = toursJson.tours ?? toursJson;
const fnugg = (await readFile(path.join(repo, 'demo/fixtures/fnugg-resorts.txt'), 'utf8'))
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));
const week = buildWeek({ regions, tours, fnugg });

const z = makeTerrain(tours.filter((t) => t.region === 'hallingdal'));
const HARA = tours.find((t) => t.name === 'Harahorn');
const TOP = [HARA.lat, HARA.lon];
const LODGE = [60.93496, 8.45092]; // Harahorn lodge parking

/** The day's descents, drawn by hand in the film: south-east face, south face, the long south-west run home. */
const line = (deg, from, to, n) => Array.from({ length: n }, (_, k) => offset(TOP[0], TOP[1], deg + (k % 2 ? 4 : -3) * (k > 0 && k < n - 1 ? 1 : 0), from + ((to - from) * k) / (n - 1)));
const DESCENTS = [line(140, 0.06, 1.25, 6), line(190, 0.07, 1.35, 6), line(248, 0.08, 1.85, 7)];

/* ---------- the server's upstream, made up ---------- */

const R = Math.PI / 180;
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
/** A map tile from the terrain: a grey topo with hill shading and contours, or NVE's slope classes. */
function drawTile(tz, tx, ty, kind) {
  const n = 128, N = 2 ** tz, W = n + 2;
  const g = new Float64Array(W * W);
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (j + 0.5) / n)) / N))) / R;
    const lon = ((tx + (i + 0.5) / n) / N) * 360 - 180;
    g[(j + 1) * W + (i + 1)] = z(lat, lon);
  }
  const lat0 = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 0.5)) / N))) / R;
  const cell = (40075016.686 * Math.cos(lat0 * R)) / N / n;
  const ci = tz >= 15 ? 20 : tz >= 13 ? 50 : 100;
  const px = Buffer.alloc(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = Math.min(n - 1, Math.floor((x / 256) * n)) + 1, j = Math.min(n - 1, Math.floor((y / 256) * n)) + 1;
    const e = g[j * W + i];
    const dx = (g[j * W + i + 1] - g[j * W + i - 1]) / (2 * cell), dy = (g[(j - 1) * W + i] - g[(j + 1) * W + i]) / (2 * cell);
    const slope = Math.atan(Math.hypot(dx, dy)) / R;
    const o = (y * 256 + x) * 4;
    if (kind === 'topo') {
      const shade = Math.max(0, Math.min(1, 0.8 + 1.1 * (-dx * 0.55 + dy * 0.55) / Math.hypot(1, Math.hypot(dx, dy))));
      const band = (v) => Math.abs(((v % ci) + ci) % ci);
      const onLine = band(e) < Math.max(1.2, Math.hypot(dx, dy) * cell * 0.55);
      const major = onLine && band(e) < ci && Math.abs(((e % (ci * 5)) + ci * 5) % (ci * 5)) < Math.max(1.2, Math.hypot(dx, dy) * cell * 0.55);
      const base = (e > 1150 ? 250 : e > 950 ? 242 : 232) * shade;
      const c = major ? 0.62 : onLine ? 0.8 : 1;
      px.set([base * c, base * c, Math.min(255, base * c * (e > 1150 ? 1.01 : 0.97)), 255], o);
    } else {
      let col = null;
      if (slope >= 50) col = [30, 30, 30];
      else if (slope >= 45) col = [130, 40, 150];
      else if (slope >= 40) col = [215, 40, 30];
      else if (slope >= 35) col = [240, 140, 30];
      else if (slope >= 30) col = [245, 215, 40];
      else if (slope >= 27) col = [140, 190, 60];
      if (col) px.set([...col, 190], o);
    }
  }
  return png(256, 256, px);
}

/** MET Norway's point forecast from the story: all the weekend, hourly, in UTC. */
function metFor(lat, lon, alt) {
  const t0 = Date.parse(`${dateOf(-1)}T00:00:00Z`);
  const timeseries = [];
  for (let k = 0; k < 24 * 6; k++) {
    const t = t0 + k * 3600e3;
    const local = new Date(t + 3600e3); // Norwegian winter time
    const a = Math.round((Date.parse(local.toISOString().slice(0, 10)) - Date.parse(`${dateOf(0)}T00:00:00Z`)) / 864e5);
    const x = hourAt({ lat, lon, summit_m: alt, name: 'route' }, a, local.getUTCHours());
    const snow = x.snow;
    const sym = snow >= 0.3 ? (snow >= 1 ? 'snow' : 'lightsnow') : x.cloud < 20 ? 'clearsky_day' : x.cloud < 50 ? 'fair_day' : x.cloud < 85 ? 'partlycloudy_day' : 'cloudy';
    timeseries.push({
      time: new Date(t).toISOString().replace('.000', ''),
      data: {
        instant: { details: { air_temperature: x.temp, wind_speed: x.wind, wind_speed_of_gust: x.gust, wind_from_direction: x.dir, cloud_area_fraction: x.cloud } },
        next_1_hours: { summary: { symbol_code: sym }, details: { precipitation_amount: +(snow / 1.1).toFixed(1) } },
      },
    });
  }
  return { type: 'Feature', properties: { meta: { updated_at: new Date(t0 + 30 * 3600e3).toISOString() }, timeseries } };
}

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
  m = u.match(/tile\.opentopomap\.org\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (m) return new Response(drawTile(+m[1], +m[2], +m[3], 'topo'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  if (u.includes('api.met.no')) {
    const q = new URL(u).searchParams;
    return new Response(JSON.stringify(metFor(+q.get('lat'), +q.get('lon'), +q.get('altitude') || 1000)), {
      status: 200, headers: { 'Content-Type': 'application/json', Expires: new Date(Date.now() + 3600e3).toUTCString(), 'Last-Modified': new Date().toUTCString() },
    });
  }
  if (u.includes('ws.geonorge.no/stedsnavn')) {
    const q = new URL(u).searchParams.get('sok') ?? '';
    return J({ navn: /hara/i.test(q) ? [
      { skrivemåte: 'Harahorn', navneobjekttype: 'Fjell', stedsnummer: 9001, representasjonspunkt: { øst: HARA.lon, nord: HARA.lat }, kommuner: [{ kommunenavn: 'Hemsedal' }], fylker: [{ fylkesnavn: 'Buskerud' }] },
      { skrivemåte: 'Harahorn fjellgard', navneobjekttype: 'Hotell', stedsnummer: 9002, representasjonspunkt: { øst: LODGE[1], nord: LODGE[0] }, kommuner: [{ kommunenavn: 'Hemsedal' }], fylker: [{ fylkesnavn: 'Buskerud' }] },
    ] : [] });
  }
  if (u.includes('nominatim')) return J([]);
  if (u.includes('overpass')) return J({ elements: [] });
  return new Response('offline', { status: 503 });
};

const { createServer } = await import('../src/server.js');

const FPS = 20;
const W = 1280, H = 720, SCALE = 1.5;

/* ------------------------------------------------------------------ *
 * overlays
 * ------------------------------------------------------------------ */

const OVERLAY_CSS = `
#demo-cap, #demo-toast, #demo-card, #demo-click, #demo-cursor { pointer-events: none; }
#demo-cap { position: fixed; right: 18px; bottom: 18px; width: 440px; z-index: 50;
  background: #1A1A1A; color: #EDEBE5; border-radius: 12px; padding: 13px 18px 15px; font-family: var(--sans);
  box-shadow: 0 10px 30px rgba(0,0,0,.25); }
#demo-cap .eb { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #A8A49B; display: flex; justify-content: space-between; gap: 12px; }
#demo-cap .eb b { color: #EDEBE5; font-weight: 600; }
#demo-cap .tx { font-size: 17px; line-height: 1.35; font-weight: 600; margin: 8px 0 11px; }
#demo-cap .tl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
#demo-cap .tl i { height: 5px; border-radius: 2px; background: #3A3833; }
#demo-cap .tl i.on { background: #EDEBE5; }
#demo-cap .tl span { font-family: var(--mono); font-size: 10px; color: #A8A49B; text-align: center; margin-top: 4px; }
#demo-cap .tl span.on { color: #EDEBE5; }
.demo-sim { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  color: #1A1A1A; background: #fff; border-radius: 4px; padding: 2px 6px; }
#demo-toast { position: fixed; right: 18px; top: 18px; width: 380px; z-index: 51;
  background: #fff; color: #1A1A1A; border: 1px solid #D8D5CC; border-radius: 14px; padding: 12px 16px;
  font-family: var(--sans); box-shadow: 0 10px 30px rgba(26,26,26,.22); }
#demo-toast .eb { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #706C64; display: flex; justify-content: space-between; }
#demo-toast .ti { font-weight: 700; font-size: 16px; margin: 4px 0 2px; color: #C0392B; }
#demo-toast .bo { font-size: 13px; line-height: 1.45; color: #4A473F; white-space: pre-line; }
#demo-card { position: fixed; inset: 0; z-index: 60; background: #F4F3EF; color: #1A1A1A;
  display: flex; flex-direction: column; justify-content: center; padding: 0 96px; font-family: var(--sans); }
#demo-card .logo { height: 120px; width: auto; align-self: flex-start; margin-bottom: 10px; }
#demo-card .eb { font-family: var(--mono); font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #706C64; }
#demo-card h1 { font-size: 50px; line-height: 1.06; margin: 14px 0 18px; font-weight: 700; letter-spacing: -.015em; max-width: 1060px; }
#demo-card .rule { height: 2px; background: #1A1A1A; width: 100%; margin: 6px 0 22px; }
#demo-card p { font-size: 19px; line-height: 1.5; color: #4A473F; margin: 0; max-width: 1000px; }
#demo-card ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 9px; }
#demo-card li { font-size: 19px; display: flex; gap: 14px; align-items: baseline; }
#demo-card li b { font-family: var(--mono); font-size: 13px; color: #706C64; font-weight: 400; min-width: 28px; }
#demo-card .ft { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: #706C64; margin-top: 28px; display: flex; gap: 10px; align-items: center; }
#demo-card .ft i { width: 9px; height: 9px; border-radius: 50%; background: #C2402A; display: inline-block; }
#demo-card .week { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; max-width: 700px; margin-top: 10px; }
#demo-card .week div { border-top: 4px solid #D8D5CC; padding-top: 8px; font-family: var(--mono); font-size: 13px; color: #706C64; }
#demo-card .week div.snow { border-color: #6B675F; color: #1A1A1A; }
#demo-card .week div.trip { border-color: #1A1A1A; color: #1A1A1A; }
#demo-card .week div.party { border-color: #C2402A; color: #C2402A; }
#demo-card .week small { display: block; font-family: var(--sans); font-size: 13px; margin-top: 3px; }
#demo-cursor { position: fixed; left: 0; top: 0; z-index: 70; width: 22px; height: 22px; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
#demo-click { position: fixed; z-index: 69; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #1A1A1A; opacity: 0; }
`;

const DAYS_STRIP = `<div class="week">
  <div class="snow">FRI<small>snow easing · plan</small></div><div class="trip">SAT<small>bluebird · tour</small></div><div class="party">SUN<small>lifts · après-ski</small></div></div>`;

const TITLE_HTML = `
  <img class="logo" src="/brand/logo.png" alt="">
  <div class="eb">Fjällskred · ski touring conditions for Norway and Sweden</div>
  <h1>A February weekend. Where is the snow — and which line, which hour?</h1>
  <div class="rule"></div>
  <p>Around Harahorn in Hemsedal, planned in Fjällskred from Friday to the après-ski. The weather, snow,
  bulletins, lift status and terrain are made up for this film and run through the real app.</p>
  ${DAYS_STRIP}
  <div class="ft"><span class="demo-sim">Simulated weekend · not a forecast</span></div>`;

const END_HTML = `
  <img class="logo" src="/brand/logo.png" alt="" style="height:100px">
  <h1>From "where is the snow?" to "leave at 08:15"</h1>
  <div class="rule"></div>
  <ul>
    <li><b>01</b>Snow base, new snow and avalanche danger for Norway and Sweden on one map, with powder alerts</li>
    <li><b>02</b>A trip planner that ranks tours and finds the best hours in the daylight</li>
    <li><b>03</b>Plan a tour: your own lines, legs found around avalanche terrain, Munter times, when to go</li>
    <li><b>04</b>Find runs in any area for your angles and today's bulletin; 3D; weather on the route</li>
    <li><b>05</b>Ski resorts with open lifts, and how good the forecasts have been</li>
  </ul>
  <div class="ft"><i></i>Self-hosted in one Docker container · simulated weekend · read the bulletin before you go</div>`;

const CURSOR_SVG = `<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.3 19.2 L10.3 12.8 L16.3 12.6 Z" fill="#1A1A1A" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme: 'light' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let current = week[0];
let dayA = 0;
const localTime = (a, hhmm) => new Date(`${dateOf(a)}T${hhmm}:00+01:00`);
await page.clock.setSystemTime(localTime(0, '07:40'));
await page.route('**/api/conditions', (r) => r.fulfill({ json: { ...current.snapshot, fetchedAt: localTime(dayA, '06:20').toISOString() } }));
await page.route('**/api/alerts', (r) => r.fulfill({ json: current.alerts }));
await page.route('**/api/outlook', (r) => r.fulfill({ json: current.outlook }));
await page.route('**/api/refresh', (r) => r.fulfill({ json: { ok: true } }));
await page.route('**/api/resorts', (r) => r.fulfill({ json: current.resorts }));
await page.route('**/api/forecast?*', (r) => {
  const f = current.forecasts[new URL(r.request().url()).searchParams.get('tour')];
  r.fulfill(f ? { json: f } : { status: 502, json: { error: 'not part of the simulation' } });
});
await page.route('**/api/photos?*', (r) => r.fulfill({ json: { photos: [] } }));

async function installOverlays() {
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate((cursor) => {
    Element.prototype.scrollIntoView = function () {};
    document.documentElement.style.scrollBehavior = 'auto';
    for (const id of ['demo-cap', 'demo-toast', 'demo-card', 'demo-click']) {
      if (document.getElementById(id)) continue;
      const el = document.createElement('div');
      el.id = id;
      el.style.opacity = '0';
      document.body.appendChild(el);
    }
    if (!document.getElementById('demo-cursor')) {
      const c = document.createElement('div');
      c.id = 'demo-cursor';
      c.innerHTML = cursor;
      c.style.opacity = '0';
      document.body.appendChild(c);
    }
  }, CURSOR_SVG);
}

async function openApp() {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    try {
      localStorage.setItem('fjallskred.plan.v1', JSON.stringify({ maxDifficulty: 3, maxDanger: 3, from: '', tripLen: 3 }));
    } catch {}
  });
  await page.reload({ waitUntil: 'networkidle' });
  await installOverlays();
}
async function openTerrain(hash) {
  await page.goto(`${base}/terrain${hash}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.fjallskredTerrain?.state.zoneLoaded, null, { timeout: 30000 });
  await page.evaluate(() => { try { localStorage.removeItem('fjallskred.runSettings'); } catch {} });
  await installOverlays();
  await page.waitForTimeout(600);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const frameDir = path.join(tmpdir(), 'ttv-frames-weekend');
await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
let frame = 0;
const shot = (name) =>
  page.screenshot({ path: name ?? path.join(frameDir, `f${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const setOpacity = (id, o) => page.evaluate(([i, v]) => { const e = document.getElementById(i); if (e) e.style.opacity = String(v); }, [id, o]);
const setHtml = (id, html) => page.evaluate(([i, h]) => { const e = document.getElementById(i); if (e) e.innerHTML = h; }, [id, html]);
const hideCursor = () => setOpacity('demo-cursor', 0);

async function loadDay(a, time = '07:40') {
  dayA = a;
  current = week[a];
  await page.clock.setSystemTime(localTime(a, time));
}

let scrollY = 0;
let pointer = { x: W * 0.6, y: H * 0.45 };

async function placePointer(x, y, { move = true } = {}) {
  pointer = { x, y };
  await page.evaluate(([px, py]) => {
    const c = document.getElementById('demo-cursor');
    if (!c) return;
    c.style.transform = `translate(${px - 3}px, ${py - 2}px)`;
    c.style.opacity = '1';
  }, [x, y]);
  if (move) await page.mouse.move(x, y);
}

async function center(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
  }, sel);
}
/** A lat/lon on the terrain page's map, in screen pixels. */
async function mapPoint([lat, lon]) {
  return page.evaluate(([la, lo]) => {
    const m = window.fjallskredTerrain.map;
    const [x, y] = m.project(la, lo);
    const r = m.el.getBoundingClientRect();
    return { x: r.left + x, y: r.top + y };
  }, [lat, lon]);
}

async function clickPulse(x, y) {
  await page.evaluate(([px, py]) => {
    const c = document.getElementById('demo-click');
    c.style.left = `${px}px`;
    c.style.top = `${py}px`;
    c.style.opacity = '1';
    c.style.transform = 'scale(.5)';
  }, [x, y]);
}
const pulse = (t0) => async (t) => {
  if (t >= t0 && t < t0 + 0.2) {
    await page.evaluate((v) => {
      const c = document.getElementById('demo-click');
      c.style.opacity = String(Math.max(0, 1 - v));
      c.style.transform = `scale(${0.5 + v})`;
    }, (t - t0) / 0.2);
  }
};

const glideTo = (sel, t0, t1, dx = 0, dy = 0) => {
  let start = null;
  return async (t) => {
    if (t < t0 || t > t1 + 0.04) return;
    if (!start) start = { ...pointer };
    const c = await center(sel);
    if (!c) return;
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    await placePointer(lerp(start.x, c.x + dx, k), lerp(start.y, c.y + dy, k));
  };
};
const glideToPoint = (pt, t0, t1) => {
  let start = null;
  return async (t) => {
    if (t < t0 || t > t1 + 0.04) return;
    if (!start) start = { ...pointer };
    const c = await mapPoint(pt);
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    await placePointer(lerp(start.x, c.x, k), lerp(start.y, c.y, k), { move: false });
  };
};

const clickAt = (sel, dx = 0) => async () => {
  const c = await center(sel);
  if (!c) return console.warn('click: not found', sel);
  await placePointer(c.x + dx, c.y);
  await clickPulse(c.x + dx, c.y);
  await page.mouse.click(c.x + dx, c.y);
};
const clickMap = (pt) => async () => {
  const c = await mapPoint(pt);
  await placePointer(c.x, c.y, { move: false });
  await clickPulse(c.x, c.y);
  await page.mouse.click(c.x, c.y);
};

const typeInto = (sel, text, t0, t1) => {
  let typed = -1;
  return async (t) => {
    if (t < t0) return;
    const n = Math.min(text.length, Math.floor(((t - t0) / (t1 - t0)) * text.length) + 1);
    if (n === typed) return;
    typed = n;
    await page.evaluate(([s, v]) => {
      const el = document.querySelector(s);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [sel, text.slice(0, n)]);
  };
};

/** Click the points of a descent one after another, the pointer gliding between them. */
function drawLine(pts, t0, t1) {
  const per = (t1 - t0) / pts.length;
  const out = [];
  pts.forEach((p, k) => {
    out.push(glideToPoint(p, t0 + k * per, t0 + k * per + per * 0.7));
    out.push(pulse(t0 + k * per + per * 0.75));
  });
  const on = {};
  pts.forEach((p, k) => { on[(t0 + k * per + per * 0.75).toFixed(4)] = clickMap(p); });
  return { each: out, on };
}

const scrollTargets = () =>
  page.evaluate((vh) => {
    const y = (sel, off = 0) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + window.scrollY + off : 0;
    };
    const max = document.documentElement.scrollHeight - vh;
    const c = (v) => Math.max(0, Math.min(max, v));
    return {
      top: 0,
      map: c(y('.mapbox', -16)),
      tours: c(y('#tourlist', -140)),
      plan: c(y('#planCard', -12)),
      trip: c(y('#tripPlan', -40)),
      planList: c(y('#planList', -120)),
      detail: c(y('#detailCard', -12)),
      forecast: c(y('#forecast', -60)),
      window: c(y('#forecast', 120)),
      // Plan a tour
      tmap: c(y('.tmapcard', -12)),
      ttools: c(y('.tmap', -6)),
      runs: c(y('.runtools', -330)),
      runsOut: c(y('#runsOut', -60)),
      intro: c(y('#rstats', -70)),
      legs: c(y('.tourtbl', -120)),
      tourDay: c(y('#tourDay', -40)),
      weather: c(y('#rweather', -40)),
      weatherTable: c(y('#rweather .wtablewrap', -120)),
    };
  }, H);

function captionHtml(a, text) {
  const ticks = [0, 1, 2].map((i) => `<i class="${i === a ? 'on' : ''}"></i>`).join('');
  const labels = ['FRI', 'SAT', 'SUN'].map((l, i) => `<span class="${i === a ? 'on' : ''}">${l}</span>`).join('');
  const d = new Date(`${week[a].date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `<div class="eb"><span><b>${day}</b> · Hemsedal</span><span class="demo-sim">Simulated</span></div>
    <div class="tx">${text}</div><div class="tl">${ticks}${labels}</div>`;
}

/* ------------------------------------------------------------------ *
 * storyboard
 * ------------------------------------------------------------------ */

const hall = () => current.snapshot.regions.find((r) => r.id === 'hallingdal');
const ALERT = week[0].alerts.firing.find((f) => f.regionId === 'hallingdal') ?? { new48: hall()?.snow?.new48 ?? 32 };
const TOAST = `<div class="eb"><span>ntfy · fjällskred</span><span>06:20</span></div>
  <div class="ti">Powder alert: Hallingdal +${ALERT.new48} cm</div>
  <div class="bo">${ALERT.new48} cm in 48 h · danger 3 (Considerable), wind slab
Read the bulletin first: varsom.no</div>`;

const [D1, D2, D3] = DESCENTS;
const d1 = drawLine(D1, 0.12, 0.42), d2 = drawLine(D2, 0.46, 0.7), d3 = drawLine(D3, 0.72, 0.95);

const STEPS = [
  { card: 'title', dur: 8, scene: 'title' },

  // ---- Friday: where is the snow ----
  { a: 0, dur: 11, scene: 'snow', cam: ['map', 'map'], toast: true,
    cap: () => `Friday. It has snowed since Thursday: ${hall().snow.new48} cm in 48 hours around Hemsedal, and the powder alert goes off.`,
    pre: async () => { await hideCursor(); await page.evaluate(() => document.querySelector('.seg [data-layer="snow"]')?.click()); } },
  { a: 0, dur: 10, scene: 'snow', cam: ['map'],
    cap: 'The map: the land in its snow base, each region’s circle in its new snow. Hallingdal is the deep, fresh one.',
    each: [glideTo('#map g.reg[data-region="hallingdal"]', 0.2, 0.45)] },
  { a: 0, dur: 10, scene: 'snow', cam: ['map'],
    cap: 'Find a place: Harahorn. Pinned, with the nearest listed tour — and a way straight into planning it.',
    each: [glideTo('#mapFind', 0.05, 0.15), pulse(0.17), typeInto('#mapFind', 'Harahorn', 0.2, 0.36)],
    on: {
      0.17: clickAt('#mapFind'),
      0.4: async () => { await page.press('#mapFind', 'Enter'); await page.waitForSelector('.psbox .psitem', { timeout: 10000 }).catch(() => {}); },
      0.55: async () => { await page.click('.psbox .psitem:has-text("Buskerud")').catch(() => page.click('.psbox .psitem')); },
    } },

  // ---- Friday: the plan ----
  { a: 0, dur: 12, scene: 'plan', cam: ['plan', 'plan', 'trip'],
    cap: 'The trip planner, from tomorrow: in the danger and the snow, Hallingdal comes out on top.',
    pre: async () => { await hideCursor(); await page.evaluate(() => document.getElementById('pinClear')?.click()); },
    each: [glideTo('#planDays [data-k="1"]', 0.1, 0.24), pulse(0.26)],
    on: { 0.26: clickAt('#planDays [data-k="1"]') } },

  // ---- Saturday: the tour ----
  { a: 1, dur: 13, scene: 'bluebird', cam: ['detail', 'detail', 'window'],
    cap: 'Saturday: bluebird, calm and −12° on cold powder. Harahorn: red is steep ground where today’s wind slab sits. The window is all day.',
    pre: async () => { await hideCursor(); await selectTour('Harahorn'); } },
  { a: 1, dur: 8, scene: 'bluebird', app: 'terrain', cam: ['tmap'],
    cap: 'Plan a tour. The same bulletin on the map: soft red on the lee faces, 25° and steeper, NVE’s slope classes under it.',
    each: [async (t) => { if (t < 0.05) await hideCursor(); }] },
  { a: 1, dur: 8, scene: 'tour', cam: ['ttools', 'ttools'],
    cap: 'Start at the Harahorn lodge parking.',
    each: [glideTo('#startBtn', 0.08, 0.26), pulse(0.28), glideToPoint(LODGE, 0.36, 0.62), pulse(0.66)],
    on: { 0.28: clickAt('#startBtn'), 0.66: clickMap(LODGE) } },
  { a: 1, dur: 17, scene: 'tour', cam: ['ttools'],
    cap: 'Three descents for the day, off the wind slab: the south-east face, the south face, and the long south-west run home.',
    each: [glideTo('#descBtn', 0.02, 0.09), pulse(0.1), ...d1.each, glideTo('#descBtn', 0.425, 0.44), pulse(0.445), ...d2.each, glideTo('#descBtn', 0.7, 0.715), pulse(0.718), ...d3.each, glideTo('#descBtn', 0.955, 0.975), pulse(0.98)],
    on: { 0.1: clickAt('#descBtn'), ...d1.on, 0.445: nextDescent, ...d2.on, 0.718: nextDescent, ...d3.on, 0.98: clickAt('#descBtn') } },
  { a: 1, dur: 9, scene: 'tour', cam: ['ttools'],
    cap: 'Build tour: the legs up are found by Munter time, around the steep lee slopes.',
    each: [glideTo('#buildBtn', 0.05, 0.2), pulse(0.22)],
    on: { 0.22: async () => { await clickAt('#buildBtn')(); await page.waitForFunction(() => window.fjallskredTerrain.state.built?.parts, null, { timeout: 60000 }); await page.waitForTimeout(800); } } },
  { a: 1, dur: 12, scene: 'tour', cam: ['tmap', 'intro', 'intro', 'legs'],
    cap: 'The tour, introduced like the listed ones: region and problems, aspects, then the numbers once, and every leg and descent.',
    pre: async () => { await hideCursor(); await page.waitForSelector('.tintro', { timeout: 30000 }).catch(() => {}); } },
  { a: 1, dur: 12, scene: 'tour', cam: ['tourDay', 'tourDay', 'weatherTable'],
    cap: 'When to go: leave in the morning light, every descent before the sun softens it. The weather on the route boxes the hours.',
    pre: async () => { await page.waitForSelector('#rweather .wtable', { timeout: 30000 }).catch(() => {}); } },
  { a: 1, dur: 13, scene: 'tour', cam: ['tmap', 'runs', 'runsOut'],
    cap: 'Or let it find runs: mark an area, and the longest lines in your angles come out, with today’s problems on each.',
    pre: async () => { await page.evaluate(() => window.scrollTo(0, 0)); },
    on: {
      0.12: async () => {
        await page.evaluate(([lat, lon]) => {
          const dLat = 2.2 / 111, dLon = 2.6 / (111 * Math.cos((lat * Math.PI) / 180));
          window.fjallskredTerrain.findRunsIn({ south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon });
        }, TOP);
        await page.waitForFunction(() => window.fjallskredTerrain.state.runs?.length, null, { timeout: 60000 }).catch(() => {});
      },
    } },
  { a: 1, dur: 12, scene: 'tour', cam: ['tmap'], close3d: true,
    cap: 'And in 3D, the tour on the terrain.',
    on: {
      0.02: async () => {
        await page.evaluate(() => { window.fjallskredTerrain.state.runs = null; document.getElementById('runClearBtn')?.click(); });
        await page.click('#view3dBtn');
        await page.waitForFunction(() => /along the route|grid|WebGL/.test(document.querySelector('#t3dNote')?.textContent ?? ''), null, { timeout: 90000 }).catch(() => {});
      },
    },
    each: [async (t) => {
      if (t < 0.2 || t > 0.95) return;
      const c = await center('#t3d canvas');
      if (!c) return;
      const k = (t - 0.2) / 0.75;
      if (!drag3d) { drag3d = true; await page.mouse.move(c.x, c.y); await page.mouse.down(); }
      await page.mouse.move(c.x + Math.sin(k * Math.PI * 1.2) * 180, c.y + Math.sin(k * Math.PI) * 30);
      if (k > 0.98) { await page.mouse.up(); }
    }] },

  // ---- Sunday: lifts and après ----
  { a: 2, dur: 14, scene: 'apres', app: 'app', cam: ['map', 'map'],
    cap: () => `Sunday: sun on the lifts. Hemsedal runs ${liftText('Hemsedal')} — and the après-ski starts at three.`,
    pre: async () => {
      await hideCursor();
      await page.evaluate(() => { const cb = document.getElementById('showResorts'); if (!cb.checked) cb.click(); });
      await page.waitForTimeout(600);
    },
    each: [glideTo('#mapFind', 0.05, 0.14), pulse(0.16), typeInto('#mapFind', 'Harahorn', 0.18, 0.3)],
    on: {
      0.16: clickAt('#mapFind'),
      0.33: async () => { await page.press('#mapFind', 'Enter'); await page.waitForSelector('.psbox .psitem', { timeout: 10000 }).catch(() => {}); },
      0.42: async () => {
        await page.click('.psbox .psitem:has-text("Buskerud")').catch(() => page.click('.psbox .psitem'));
        await page.waitForTimeout(300);
        await hideCursor();
      },
    } },
  { a: 2, dur: 10, scene: 'apres', app: 'skill', cam: ['top'],
    cap: 'And how good were the forecasts? Every forecast is kept and scored against what happened.' },

  { card: 'end', dur: 9, scene: 'end' },
];
let drag3d = false;
/** Finish the descent being drawn and start the next one. */
async function nextDescent() {
  await clickAt('#descBtn')();
  await page.waitForTimeout(150);
  await page.click('#descBtn');
}

function liftText(name) {
  const r = week[2].resorts.resorts.find((x) => x.name.includes(name));
  return r?.lifts ? `${r.lifts.open} of ${r.lifts.count} lifts` : 'all its lifts';
}
async function selectTour(name) {
  await page.evaluate((n) => {
    const q = document.getElementById('q');
    q.value = n;
    q.dispatchEvent(new Event('input', { bubbles: true }));
  }, name);
  await page.click(`.trow[data-tour="${name}"]`, { force: true });
  await waitRoute();
  await page.evaluate(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function waitRoute() {
  await page.waitForSelector('#routeMeta', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#routeMeta')?.textContent.includes('Looking up'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#forecast')?.textContent.includes('Loading'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

await openApp();
let where = 'app';
let appDay = 0;
let clock = 0;
const timeline = [];

for (const step of STEPS) {
  const n = Math.round(step.dur * FPS);
  timeline.push({ scene: step.scene, start: +clock.toFixed(2), dur: step.dur });
  clock += step.dur;

  if (step.card) {
    await setHtml('demo-card', step.card === 'title' ? TITLE_HTML : END_HTML);
    await setOpacity('demo-cap', 0);
    await setOpacity('demo-toast', 0);
    await hideCursor();
    for (let i = 0; i < n; i++) {
      const t = i / n;
      await setOpacity('demo-card', step.card === 'title' ? (t > 0.9 ? 1 - (t - 0.9) / 0.1 : 1) : Math.min(1, t / 0.1));
      if (!PROBE || i === Math.floor(n / 2)) await shot(PROBE ? path.join(path.dirname(outFile), `probe-${timeline.length}-${step.scene}.jpg`) : undefined);
    }
    continue;
  }

  if (step.a !== dayA) await loadDay(step.a, step.a === 2 ? '12:30' : '07:40');
  if (step.app === 'terrain' && where !== 'terrain') {
    await openTerrain(`#tour=${encodeURIComponent('Harahorn')}`);
    // The listed route of Harahorn is only a reference here: take it off, frame the mountain.
    // A shorter map for the film, so the map and the tour buttons fit on one screen.
    await page.addStyleTag({ content: '.tmap { height: 380px !important; min-height: 0 !important; }' });
    await page.click('#refDrop').catch(() => {});
    await page.evaluate(([lat, lon]) => {
      const T = window.fjallskredTerrain;
      T.map.render?.();
      T.map.setView({ lat: lat - 0.0035, lon: lon - 0.013 }, 13.55);
    }, TOP);
    await page.waitForTimeout(1500);
    where = 'terrain';
    scrollY = 0;
  }
  if (step.app === 'app' && where !== 'app') {
    await openApp();
    where = 'app';
    appDay = step.a;
    scrollY = 0;
  }
  if (step.app === 'skill' && where !== 'skill') {
    await page.goto(base + '/skill', { waitUntil: 'networkidle' });
    await installOverlays();
    await page.waitForTimeout(800);
    where = 'skill';
    scrollY = 0;
  }
  if (where === 'app' && step.a !== appDay) {
    // The page asks again: the day's conditions, alerts and forecasts.
    await page.evaluate(() => document.getElementById('refreshBtn')?.click());
    await page.waitForFunction(() => document.getElementById('refreshBtn')?.textContent === 'Refresh now', null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    appDay = step.a;
  }
  if (step.pre) await step.pre();
  await setOpacity('demo-card', 0);
  await setHtml('demo-cap', captionHtml(step.a, typeof step.cap === 'function' ? step.cap() : step.cap));
  await setOpacity('demo-cap', 1);
  if (step.toast) await setHtml('demo-toast', TOAST);

  const fired = new Set();
  const legs = step.cam.length;
  let tg = await scrollTargets();

  for (let i = 0; i < n; i++) {
    const t = i / n;
    for (const [at, fn] of Object.entries(step.on ?? {}).sort((x, y) => Number(x[0]) - Number(y[0]))) {
      if (t >= Number(at) && !fired.has(at)) {
        fired.add(at);
        await fn();
        tg = await scrollTargets();
      }
    }
    const legT = Math.min(0.999, t) * legs;
    const leg = Math.floor(legT);
    const from = leg === 0 ? scrollY : tg[step.cam[leg - 1]];
    const to = tg[step.cam[leg]];
    const y = from + (to - from) * ease(Math.min(1, (legT - leg) / 0.55));
    await page.evaluate((v) => window.scrollTo(0, v), y);

    for (const fn of step.each ?? []) await fn(t);

    if (step.toast) {
      const o = t < 0.08 ? 0 : t < 0.16 ? (t - 0.08) / 0.08 : t < 0.8 ? 1 : Math.max(0, 1 - (t - 0.8) / 0.1);
      await setOpacity('demo-toast', o);
    }
    if (!PROBE || i === Math.floor(n * 0.9)) await shot(PROBE ? path.join(path.dirname(outFile), `probe-${timeline.length}-${step.scene}.jpg`) : undefined);
  }
  scrollY = tg[step.cam[legs - 1]];
  await setOpacity('demo-toast', 0);
  if (step.close3d) {
    await page.mouse.up().catch(() => {});
    await page.click('#t3dClose').catch(() => {});
  }
}

await browser.close();
server.close();
globalThis.fetch = realFetch;

const tlFile = outFile.replace(/\.mp4$/, '') + '.timeline.json';
await writeFile(tlFile, JSON.stringify({ fps: FPS, total: clock, scenes: timeline }, null, 1));
console.log('errors:', errors);
if (PROBE) {
  console.log('probe done', clock, 's');
  process.exit(0);
}
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', path.join(frameDir, 'f%05d.jpg'),
  '-vf', 'fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-movflags', '+faststart',
  outFile,
]);
console.log(`${frame} frames -> ${outFile} (${(frame / FPS).toFixed(1)} s), timeline ${tlFile}`);
