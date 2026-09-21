#!/usr/bin/env node
/**
 * The ~2:10 advert: one made-up week in Hallingdal, planned in Fjällskred.
 *
 *   node demo/record-advert.mjs <out.mp4> [path/to/playwright] [--probe]
 *   python3 demo/advert/music.py <out.wav> <timeline.json>
 *   (the recorder writes <out>.timeline.json next to the video and prints
 *    the ffmpeg line that joins the two)
 *
 * The page is the real app on the real server. What is simulated:
 *   - the week's weather, snow, bulletins and lift status (demo/advert/scenario.mjs),
 *     served in place of /api/conditions, /api/alerts, /api/outlook, /api/forecast
 *     and /api/resorts;
 *   - the terrain: the server's elevation requests (Kartverket, Open-Meteo) are
 *     answered from a made-up terrain model (demo/advert/terrain.mjs), so contour
 *     lines, the profile of your GPX, the relief drawing and the red >25° layer are
 *     computed by the real code on invented mountains;
 *   - the GPX you "upload" is a made-up skin track on that terrain.
 * Map tiles are live-only and not shown. Captions, the pointer, the dragged file
 * and the push notification are overlays.
 */

import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const [outFile, pwPath] = args.filter((a) => !a.startsWith('--'));
if (!outFile) {
  console.error('usage: node demo/record-advert.mjs <out.mp4> [playwright module path] [--probe]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dataDir = await mkdtemp(path.join(tmpdir(), 'ttv-advert-'));
await mkdir(path.join(dataDir, 'cache'), { recursive: true });
await mkdir(path.join(dataDir, 'tracks'), { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'false';
process.env.TRACKS_WARMUP = 'false';

const { makeTerrain, skinTrack, toGpxXml } = await import('./advert/terrain.mjs');
const { buildWeek } = await import('./advert/scenario.mjs');

const regionsJson = JSON.parse(await readFile(path.join(repo, 'data/regions.json'), 'utf8'));
const regions = regionsJson.regions ?? regionsJson;
const toursJson = JSON.parse(await readFile(path.join(repo, 'data/tours.json'), 'utf8'));
const tours = toursJson.tours ?? toursJson;
const fnugg = (await readFile(path.join(repo, 'demo/fixtures/fnugg-resorts.txt'), 'utf8'))
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));
const week = buildWeek({ regions, tours, fnugg });

const hall = tours.filter((t) => t.region === 'hallingdal');
const z = makeTerrain(hall);
const HOG = tours.find((t) => t.name === 'Høgeloft');
const gpxXml = toGpxXml('Høgeloft', skinTrack(HOG, z));
const gpxPath = path.join(dataDir, 'hogeloft-from-watch.gpx');
await writeFile(gpxPath, gpxXml);

/* ---------- the server's upstream: terrain from the made-up model ---------- */

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
  if (u.includes('hoydedata') || u.includes('geonorge')) {
    const pts = JSON.parse(new URL(u).searchParams.get('punkter'));
    return J({ koordsys: 4258, punkter: pts.map(([lon, lat]) => ({ datakilde: 'dtm1', x: lon, y: lat, z: z(lat, lon) })) });
  }
  if (u.includes('/v1/elevation')) {
    const q = new URL(u).searchParams;
    const la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
    return J({ elevation: la.map((v, i) => z(v, lo[i])) });
  }
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
#demo-cap, #demo-toast, #demo-card, #demo-click, #demo-cursor, #demo-file { pointer-events: none; }
#demo-cap { position: fixed; right: 20px; bottom: 20px; width: 480px; z-index: 50;
  background: #1A1A1A; color: #EDEBE5; border-radius: 12px; padding: 14px 19px 16px; font-family: var(--sans);
  box-shadow: 0 10px 30px rgba(0,0,0,.25); }
#demo-cap .eb { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #A8A49B; display: flex; justify-content: space-between; gap: 12px; }
#demo-cap .eb b { color: #EDEBE5; font-weight: 600; }
#demo-cap .tx { font-size: 18px; line-height: 1.35; font-weight: 600; margin: 8px 0 12px; }
#demo-cap .tl { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
#demo-cap .tl i { height: 5px; border-radius: 2px; background: #3A3833; }
#demo-cap .tl i.tp { background: #6B675F; }
#demo-cap .tl i.on { background: #EDEBE5; }
#demo-cap .tl i.storm { background: #E8734F; }
#demo-cap .tl span { font-family: var(--mono); font-size: 10px; color: #A8A49B; text-align: center; margin-top: 4px; }
#demo-cap .tl span.on { color: #EDEBE5; }
.demo-sim { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  color: #1A1A1A; background: #fff; border-radius: 4px; padding: 2px 6px; }
#demo-toast { position: fixed; right: 20px; top: 20px; width: 380px; z-index: 51;
  background: #fff; color: #1A1A1A; border: 1px solid #D8D5CC; border-radius: 14px; padding: 12px 16px;
  font-family: var(--sans); box-shadow: 0 10px 30px rgba(26,26,26,.22); }
#demo-toast .eb { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #706C64; display: flex; justify-content: space-between; }
#demo-toast .ti { font-weight: 700; font-size: 16px; margin: 4px 0 2px; color: #C0392B; }
#demo-toast .bo { font-size: 13px; line-height: 1.45; color: #4A473F; white-space: pre-line; }
#demo-card { position: fixed; inset: 0; z-index: 60; background: #F4F3EF; color: #1A1A1A;
  display: flex; flex-direction: column; justify-content: center; padding: 0 96px; font-family: var(--sans); }
#demo-card .logo { height: 130px; width: auto; align-self: flex-start; margin-bottom: 10px; }
#demo-card .eb { font-family: var(--mono); font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #706C64; }
#demo-card h1 { font-size: 52px; line-height: 1.06; margin: 14px 0 18px; font-weight: 700; letter-spacing: -.015em; max-width: 1060px; }
#demo-card .rule { height: 2px; background: #1A1A1A; width: 100%; margin: 6px 0 22px; }
#demo-card p { font-size: 19px; line-height: 1.5; color: #4A473F; margin: 0; max-width: 1000px; }
#demo-card ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
#demo-card li { font-size: 20px; display: flex; gap: 14px; align-items: baseline; }
#demo-card li b { font-family: var(--mono); font-size: 13px; color: #706C64; font-weight: 400; min-width: 28px; }
#demo-card .ft { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: #706C64; margin-top: 30px; display: flex; gap: 10px; align-items: center; }
#demo-card .ft i { width: 9px; height: 9px; border-radius: 50%; background: #C2402A; display: inline-block; }
#demo-card .week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; max-width: 900px; margin-top: 8px; }
#demo-card .week div { border-top: 4px solid #D8D5CC; padding-top: 8px; font-family: var(--mono); font-size: 13px; color: #706C64; }
#demo-card .week div.trip { border-color: #1A1A1A; color: #1A1A1A; }
#demo-card .week div.storm { border-color: #C2402A; color: #C2402A; }
#demo-card .week small { display: block; font-family: var(--sans); font-size: 13px; margin-top: 3px; }
#demo-cursor { position: fixed; left: 0; top: 0; z-index: 70; width: 22px; height: 22px; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
#demo-click { position: fixed; z-index: 69; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #1A1A1A; opacity: 0; }
#demo-file { position: fixed; left: 0; top: 0; z-index: 68; display: flex; align-items: center; gap: 9px;
  background: #fff; border: 1px solid #D8D5CC; border-radius: 10px; padding: 9px 13px; font-family: var(--mono); font-size: 13px; color: #1A1A1A;
  box-shadow: 0 8px 22px rgba(26,26,26,.2); }
#demo-file b { display: inline-block; background: #C2402A; color: #fff; border-radius: 4px; padding: 2px 5px; font-size: 10.5px; }
`;

const WEEK_STRIP = `<div class="week">
  <div>MON<small>plan</small></div><div class="trip">TUE<small>tour</small></div><div class="storm">WED<small>storm</small></div>
  <div class="trip">THU<small>powder</small></div><div>FRI</div><div>SAT</div><div>SUN</div></div>`;

const TITLE_HTML = `
  <img class="logo" src="/brand/logo.png" alt="">
  <div class="eb">Fjällskred · ski touring conditions for Norway and Sweden</div>
  <h1>Four days off. Where, and which day for what?</h1>
  <div class="rule"></div>
  <p>One week in Hallingdal, planned in Fjällskred. The weather, snow, avalanche bulletins and lift status are
  made up for this film and run through the real app.</p>
  ${WEEK_STRIP}
  <div class="ft"><span class="demo-sim">Simulated week · not a forecast</span></div>`;

const END_HTML = `
  <img class="logo" src="/brand/logo.png" alt="" style="height:110px">
  <h1>Plan the week, not just the day</h1>
  <div class="rule"></div>
  <ul>
    <li><b>01</b>Avalanche bulletins, snow and powder alerts for Norway and Sweden, on one page</li>
    <li><b>02</b>A trip planner that ranks tours, finds the best hours in the daylight, and a few days in one area</li>
    <li><b>03</b>Snow surface by aspect: wind-loaded, scoured, crust, corn, powder</li>
    <li><b>04</b>Your own GPX lines and descriptions, made in the tour editor</li>
    <li><b>05</b>Ski resorts with open lifts, for the days that aren't touring days</li>
  </ul>
  <div class="ft"><i></i>Self-hosted in one Docker container · simulated week · read the bulletin before you go</div>`;

const CURSOR_SVG = `<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.3 19.2 L10.3 12.8 L16.3 12.6 Z" fill="#1A1A1A" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const editorHtml = await readFile(path.join(repo, 'editor/tour-editor.html'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme: 'light', acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let current = week[0];
await page.route('**/api/conditions', (r) => r.fulfill({ json: { ...current.snapshot, fetchedAt: new Date().toISOString() } }));
await page.route('**/api/alerts', (r) => r.fulfill({ json: current.alerts }));
await page.route('**/api/outlook', (r) => r.fulfill({ json: current.outlook }));
await page.route('**/api/refresh', (r) => r.fulfill({ json: { ok: true } }));
await page.route('**/api/resorts', (r) => r.fulfill({ json: current.resorts }));
await page.route('**/api/forecast?*', (r) => {
  const f = current.forecasts[new URL(r.request().url()).searchParams.get('tour')];
  r.fulfill(f ? { json: f } : { status: 502, json: { error: 'not part of the simulation' } });
});
await page.route('**/api/photos?*', (r) => r.fulfill({ json: { photos: [] } }));
await page.route('**/tiles/**', (r) => r.fulfill({ status: 404, body: '' }));
// The full editor, as it runs on its own (the page's /editor is the preview).
await page.route('**/editor-full', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: editorHtml }));

async function installOverlays() {
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate((cursor) => {
    Element.prototype.scrollIntoView = function () {};
    document.documentElement.style.scrollBehavior = 'auto';
    for (const id of ['demo-cap', 'demo-toast', 'demo-card', 'demo-click', 'demo-file']) {
      const el = document.createElement('div');
      el.id = id;
      el.style.opacity = '0';
      document.body.appendChild(el);
    }
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = cursor;
    c.style.opacity = '0';
    document.body.appendChild(c);
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

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const frameDir = path.join(tmpdir(), 'ttv-frames-advert');
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

async function loadDay(a) {
  current = week[a];
  await page.evaluate(() => document.getElementById('refreshBtn').click());
  await page.waitForFunction(() => document.getElementById('refreshBtn').textContent === 'Refresh now');
  await page.waitForTimeout(400);
}

let scrollY = 0;
let pointer = { x: W * 0.6, y: H * 0.45 };

async function placePointer(x, y, { move = true } = {}) {
  pointer = { x, y };
  await page.evaluate(([px, py]) => {
    const c = document.getElementById('demo-cursor');
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

const clickAt = (sel, dx = 0) => async () => {
  const c = await center(sel);
  if (!c) return console.warn('click: not found', sel);
  await placePointer(c.x + dx, c.y);
  await clickPulse(c.x + dx, c.y);
  await page.mouse.click(c.x + dx, c.y);
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

/** A pointer sweep across an element (profile hover). */
const sweep = (sel, t0, t1, yFrac = 0.55) => async (t) => {
  if (t < t0 || t > t1) return;
  const c = await center(sel);
  if (!c) return;
  const k = ease((t - t0) / (t1 - t0));
  await placePointer(c.left + 6 + (c.w - 12) * k, c.top + c.h * yFrac);
};

/** Drag the GPX "file" overlay from off-screen right into the drop zone, then load it. */
const dragFileIn = (t0, t1) => {
  let done = false;
  return async (t) => {
    if (t < t0 || done) return;
    const c = await center('#drop');
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    const x = lerp(W + 40, c.x - 40, k), y = lerp(H * 0.2, c.y, k);
    await page.evaluate(([px, py, o]) => {
      const f = document.getElementById('demo-file');
      f.innerHTML = '<b>GPX</b> hogeloft-from-watch.gpx';
      f.style.transform = `translate(${px}px, ${py}px)`;
      f.style.opacity = String(o);
    }, [x, y - 16, 1]);
    await placePointer(x + 4, y + 8, { move: false });
    if (k >= 1) {
      done = true;
      await page.setInputFiles('#fileIn', gpxPath);
      await setOpacity('demo-file', 0);
      await clickPulse(x + 4, y + 8);
    }
  };
};

const scrollTargetsApp = () =>
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
      mapMid: (() => {
        const m = document.getElementById('map')?.getBoundingClientRect();
        return m ? c(m.top + window.scrollY + m.height / 2 - vh / 2 + 40) : 0;
      })(),
      tours: c(y('#tourlist', -140)),
      plan: c(y('#planCard', -12)),
      trip: c(y('#tripPlan', -40)),
      planList: c(y('#planList', -120)),
      detail: c(y('#detailCard', -12)),
      forecast: c(y('#forecast', -60)),
      window: c(y('#forecast', 120)),
      edTrack: 0,
      edForm: c(y('#form', -60)),
      edNote: c(y('#fNote', -300)),
      edOut: c(y('#actions', -360)),
    };
  }, H);

function captionHtml(a, text) {
  const ticks = [0, 1, 2, 3, 4, 5, 6].map((i) => `<i class="${i === a ? (i === 2 ? 'storm' : 'on') : i === 1 || i === 3 ? 'tp' : i === 2 ? 'storm' : ''}"></i>`).join('');
  const labels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((l, i) => `<span class="${i === a ? 'on' : ''}">${l}</span>`).join('');
  const d = new Date(`${week[a].date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `<div class="eb"><span><b>${day}</b> · Hallingdal</span><span class="demo-sim">Simulated</span></div>
    <div class="tx">${text}</div><div class="tl">${ticks}${labels}</div>`;
}

/* ------------------------------------------------------------------ *
 * storyboard
 * ------------------------------------------------------------------ */

const ALERT = week[3].alerts.firing.find((f) => f.regionId === 'hallingdal');
const TOAST = `<div class="eb"><span>ntfy · fjällskred</span><span>06:00</span></div>
  <div class="ti">Powder alert: Hallingdal +${ALERT?.new48 ?? 34} cm</div>
  <div class="bo">${ALERT?.new48 ?? 34} cm in 48 h · danger ${ALERT?.danger ?? 2} (Moderate), wind slab
Read the bulletin first: varsom.no</div>`;

const NOTE = 'Long, even climb from the south to a big summit plateau. Ski the east bowl in powder; the north-east face loads in south-westerly wind, so check it before you drop in.';

const STEPS = [
  { card: 'title', dur: 6, scene: 'title' },

  { a: 0, dur: 6, scene: 'monday', cam: ['top', 'map'],
    cap: 'Monday. Fine and cold, four days off from tomorrow. Where to go, and which day for what?',
    pre: async () => page.evaluate(() => document.querySelector('[data-layer="danger"]').click()) },

  // ---- the tour editor ----
  { a: 0, dur: 7, scene: 'editor', app: 'editor', cam: ['edTrack'],
    cap: 'First, your own line. The tour editor: drop the GPX from your watch.',
    each: [glideTo('#newBtn', 0.05, 0.2), pulse(0.22), dragFileIn(0.42, 0.8), pulse(0.82)],
    on: { 0.22: clickAt('#newBtn') } },
  { a: 0, dur: 8, scene: 'editor', cam: ['edTrack'],
    cap: 'Track, height profile and the way it faces come out of the file. Summit, height and region are filled in for you.',
    each: [sweep('#prof', 0.15, 0.85)] },
  { a: 0, dur: 9, scene: 'editor', cam: ['edTrack', 'edNote'],
    cap: 'Write what the tour list should say about it.',
    each: [glideTo('#fNote', 0.3, 0.42), pulse(0.44), typeInto('#fNote', NOTE, 0.46, 0.95)],
    on: { 0.44: clickAt('#fNote') } },
  { a: 0, dur: 6, scene: 'editor', cam: ['edNote', 'edOut'],
    cap: 'Download the .gpx and .tour.json, and drop them in the tracks folder on your server.',
    each: [glideTo('#dlZip', 0.45, 0.62), pulse(0.66)],
    on: { 0.66: async () => { await clickPulse(pointer.x, pointer.y); await page.click('#dlZip').catch(() => {}); } } },

  // ---- back in the app ----
  { a: 0, dur: 9, scene: 'monday', app: 'app', cam: ['tours', 'tours', 'detail'],
    cap: 'Back in Fjällskred, Høgeloft gets a red GPX tag: it now follows your own track, drawn on the terrain.',
    pre: async () => page.evaluate(() => { const q = document.getElementById('q'); q.value = 'Høg'; q.dispatchEvent(new Event('input', { bubbles: true })); }),
    each: [glideTo('.trow[data-tour="Høgeloft"] .trk', 0.08, 0.26), glideTo('.trow[data-tour="Høgeloft"]', 0.3, 0.36, -80), pulse(0.38)],
    on: { 0.38: async () => { await clickAt('.trow[data-tour="Høgeloft"]', -80)(); await waitRoute(); } } },

  // ---- the plan ----
  { a: 0, dur: 9, scene: 'plan', cam: ['plan', 'plan', 'trip'],
    cap: 'The trip planner: three days from tomorrow, in one area, one different tour a day.',
    pre: async () => page.evaluate(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }),
    each: [glideTo('#planDays [data-k="1"]', 0.1, 0.24), pulse(0.26)],
    on: { 0.26: clickAt('#planDays [data-k="1"]') } },
  { a: 0, dur: 10, scene: 'plan', cam: ['trip'],
    cap: 'Hallingdal comes out on top: Skogshorn on Tuesday morning, a storm on Wednesday, then Høgeloft in fresh powder on Thursday.',
    each: [glideTo('#tripAreas .tarea:first-child li:nth-child(1) .tdtour', 0.08, 0.2), glideTo('#tripAreas .tarea:first-child li:nth-child(2) .tdtour', 0.36, 0.48),
      glideTo('#tripAreas .tarea:first-child li:nth-child(3) .tdtour', 0.64, 0.76)] },

  // ---- Tuesday ----
  { a: 1, dur: 11, scene: 'tuesday', cam: ['detail', 'window'],
    cap: 'Tuesday. Go early: the best window on Skogshorn is in the morning. Wind and cloud move in after lunch.',
    pre: async () => { await selectTour('Skogshorn'); },
    each: [glideTo('#forecast tbody tr:nth-last-child(2) td:nth-child(2) .hstrip', 0.55, 0.7)] },

  // ---- Wednesday ----
  { a: 2, dur: 7, scene: 'storm', cam: ['map'],
    cap: 'Wednesday. Storm: 25 cm of snow, gusts near 30 m/s, danger 3. Not a touring day.',
    pre: async () => { await hideCursor(); await page.evaluate(() => document.querySelector('[data-layer="new48"]').click()); } },
  { a: 2, dur: 8, scene: 'storm', cam: ['plan', 'trip'],
    cap: 'The planner knows: poor touring weather, so it points to the lifts nearby.',
    pre: async () => page.evaluate(() => document.querySelector('#planDays [data-k="0"]').click()),
    each: [glideTo('#tripAreas .tarea:first-child .tdresort a', 0.55, 0.75), pulse(0.8)],
    on: { 0.8: async () => { await clickAt('#tripAreas .tarea:first-child .tdresort a')(); } } },
  { a: 2, dur: 12, scene: 'resort', cam: ['mapMid'],
    cap: () => `Hemsedal runs ${liftText('Hemsedal')} with the top lifts on wind hold. Tree runs, and après-ski.`,
    each: [async (t) => { if (t > 0.1 && t < 0.2) { const c = await resortPoint('Hemsedal'); if (c) await placePointer(lerp(pointer.x, c.x, (t - 0.1) / 0.1), lerp(pointer.y, c.y, (t - 0.1) / 0.1)); } }] },

  // ---- Thursday ----
  { a: 3, dur: 8, scene: 'thursday', cam: ['top'], toast: true,
    cap: () => `Thursday, 06:00. Clear, calm and −14°, with ${ALERT?.new48 ?? 34} cm of new snow. The powder alert is on your phone.`,
    pre: async () => { await hideCursor(); await page.evaluate(() => { const cb = document.getElementById('showResorts'); if (cb.checked) cb.click(); document.querySelector('.zoombtn[data-zoom="reset"]').click(); }); } },
  { a: 3, dur: 9, scene: 'thursday', cam: ['plan', 'planList'],
    cap: 'Today\'s ranking: fresh powder, cold and calm, and the hours to go.',
    pre: async () => page.evaluate(() => document.querySelector('#planDays [data-k="0"]').click()),
    each: [glideTo('#planList .prow:first-child .pscore', 0.35, 0.5), async (t) => { if (t > 0.52 && t < 0.56) await page.mouse.move(pointer.x, pointer.y); }] },
  { a: 3, dur: 12, scene: 'thursday', cam: ['detail', 'detail', 'detail', 'forecast'],
    cap: 'Høgeloft, on your own line. Red: slopes over 25° where today\'s wind slab problem is. Ski the rest.',
    pre: async () => { await page.mouse.move(5, 5); await hideCursor(); await selectTour('Høgeloft'); } },

  { card: 'end', dur: 8, scene: 'end' },
];

function liftText(name) {
  const r = week[2].resorts.resorts.find((x) => x.name.includes(name));
  return r?.lifts ? `${r.lifts.open} of ${r.lifts.count} lifts` : 'most lifts';
}
async function resortPoint(name) {
  return page.evaluate((n) => {
    const t = [...document.querySelectorAll('#map text')].find((e) => e.textContent.includes(n));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 + 14 };
  }, name);
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
  await page.waitForFunction(() => !document.querySelector('#routeMeta')?.textContent.includes('Looking up'), null, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#forecast')?.textContent.includes('Loading'), null, { timeout: 15000 });
  await page.waitForTimeout(400);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

await openApp();
let where = 'app';
let lastA = 0;
let clock = 0;
const timeline = [];

for (const step of STEPS) {
  const n = Math.round(step.dur * FPS);
  timeline.push({ scene: step.scene, start: +clock.toFixed(2), dur: step.dur });
  clock += step.dur;

  if (step.card) {
    if (where !== 'app') {
      await openApp();
      where = 'app';
    }
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

  if (step.app === 'editor' && where !== 'editor') {
    await page.goto(base + '/editor-full', { waitUntil: 'networkidle' });
    await installOverlays();
    where = 'editor';
    scrollY = 0;
  }
  if (step.app === 'app' && where !== 'app') {
    // The files from the editor land in the server's tracks folder.
    await writeFile(path.join(dataDir, 'tracks', 'hogeloft.gpx'), gpxXml);
    await openApp();
    where = 'app';
    scrollY = 0;
  }
  if (where === 'app' && step.a !== lastA) {
    await loadDay(step.a);
    lastA = step.a;
  }
  if (step.pre) await step.pre();
  await setOpacity('demo-card', 0);
  await setHtml('demo-cap', captionHtml(step.a, typeof step.cap === 'function' ? step.cap() : step.cap));
  await setOpacity('demo-cap', 1);
  if (step.toast) await setHtml('demo-toast', TOAST);

  const fired = new Set();
  const legs = step.cam.length;
  let tg = await scrollTargetsApp();

  for (let i = 0; i < n; i++) {
    const t = i / n;
    for (const [at, fn] of Object.entries(step.on ?? {})) {
      if (t >= Number(at) && !fired.has(at)) {
        fired.add(at);
        await fn();
        tg = await scrollTargetsApp();
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
      const o = t < 0.1 ? 0 : t < 0.2 ? (t - 0.1) / 0.1 : t < 0.88 ? 1 : Math.max(0, 1 - (t - 0.88) / 0.1);
      await setOpacity('demo-toast', o);
    }
    if (!PROBE || i === Math.floor(n * 0.9)) await shot(PROBE ? path.join(path.dirname(outFile), `probe-${timeline.length}-${step.scene}.jpg`) : undefined);
  }
  scrollY = tg[step.cam[legs - 1]];
  await setOpacity('demo-toast', 0);
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
