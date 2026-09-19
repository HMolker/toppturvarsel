#!/usr/bin/env node
/**
 * ~2-minute walkthrough of the complete tool through the simulated storm week:
 * map layers, tours, alerts, routes on contour lines, elevation profile,
 * forecast, photos panel, GPX, the ski resort layer with zoom, dark theme.
 *
 *   node demo/simulate.mjs <daysDir>
 *   node demo/record-full.mjs <daysDir> <out.mp4> [path/to/playwright]
 *
 * Same principle as demo/record.mjs: the page is the real app on the real
 * server; only /api/* answers from the simulation (whose snapshots, routes
 * and forecasts were themselves produced by the real pipeline). Captions,
 * the push toast, the pointer and title cards are overlays. Map tiles are
 * not simulated: the route maps show on plain paper, and the video says so.
 */

import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [daysDir, outFile, pwPath] = process.argv.slice(2);
if (!daysDir || !outFile) {
  console.error('usage: node demo/record-full.mjs <daysDir> <out.mp4> [playwright module path]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');

process.env.DATA_DIR = path.join(tmpdir(), 'ttv-record-full');
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'true';
process.env.TRACKS_WARMUP = 'false';
const { createServer } = await import('../src/server.js');

const FPS = 20;
const W = 1280, H = 720, SCALE = 1.5;

const days = [];
for (let d = 1; d <= 7; d++) days.push(JSON.parse(await readFile(path.join(daysDir, `day-${d}.json`), 'utf8')));
const routes = JSON.parse(await readFile(path.join(daysDir, 'routes.json'), 'utf8'));
const terrains = JSON.parse(await readFile(path.join(daysDir, 'terrain.json'), 'utf8'));

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayLabel = (d) => {
  const dt = new Date(days[d - 1].date);
  return `${WEEKDAY[dt.getUTCDay()]} ${dt.getUTCDate()} Feb 2027`;
};
const topAlert = (d) => {
  const f = days[d - 1].alerts.firing[0];
  return f ? `${f.regionName} +${Math.round(f.new48)} cm` : '';
};
const fcToday = (d, tour) => Math.round(days[d - 1].forecasts?.[tour]?.days?.[0]?.snowCm ?? 0);
const route = (name) => routes[name];

/* ------------------------------------------------------------------ *
 * overlays
 * ------------------------------------------------------------------ */

const OVERLAY_CSS = `
/* Overlays are pictures on top of the app, never click targets. */
#demo-cap, #demo-toast, #demo-card, #demo-click, #demo-cursor { pointer-events: none; }
#demo-cap { position: fixed; right: 20px; bottom: 20px; width: 470px; z-index: 50;
  background: #1A1A1A; color: #EDEBE5; border-radius: 12px; padding: 15px 19px 17px; font-family: var(--sans); }
#demo-cap .eb { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #A8A49B; display: flex; justify-content: space-between; gap: 12px; }
#demo-cap .eb b { color: #EDEBE5; font-weight: 600; }
#demo-cap .tx { font-size: 17.5px; line-height: 1.35; font-weight: 600; margin: 8px 0 12px; }
#demo-cap .tl { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
#demo-cap .tl i { height: 5px; border-radius: 2px; background: #3A3833; }
#demo-cap .tl i.on { background: #EDEBE5; }
#demo-cap .tl i.hot { background: #C0392B; }
#demo-cap .tl span { font-family: var(--mono); font-size: 10px; color: #A8A49B; text-align: center; margin-top: 4px; }
#demo-cap .tl span.on { color: #EDEBE5; }
.demo-sim { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  color: #1A1A1A; background: #fff; border-radius: 4px; padding: 2px 6px; }
#demo-toast { position: fixed; right: 20px; top: 150px; width: 390px; z-index: 51;
  background: #fff; color: #1A1A1A; border: 1px solid #D8D5CC; border-radius: 12px; padding: 12px 16px;
  font-family: var(--sans); box-shadow: 0 8px 28px rgba(26,26,26,.18); }
#demo-toast .eb { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #706C64; display: flex; justify-content: space-between; }
#demo-toast .ti { font-weight: 700; font-size: 16px; margin: 4px 0 2px; color: #C0392B; }
#demo-toast .bo { font-size: 13px; line-height: 1.45; color: #4A473F; white-space: pre-line; }
#demo-toast .ml { margin-top: 8px; padding-top: 8px; border-top: 1px solid #E3E0D8; font-size: 12.5px; color: #4A473F; }
#demo-toast .ml b { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #706C64; font-weight: 400; margin-right: 6px; }
#demo-card { position: fixed; inset: 0; z-index: 60; background: #F4F3EF; color: #1A1A1A;
  display: flex; flex-direction: column; justify-content: center; padding: 0 96px; font-family: var(--sans); }
#demo-card .logo { height: 150px; width: auto; align-self: flex-start; margin-bottom: 10px; }
#demo-card .eb { font-family: var(--mono); font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #706C64; }
#demo-card h1 { font-size: 48px; line-height: 1.08; margin: 14px 0 18px; font-weight: 700; letter-spacing: -.015em; max-width: 1040px; }
#demo-card .rule { height: 2px; background: #1A1A1A; width: 100%; margin: 6px 0 22px; }
#demo-card p { font-size: 19px; line-height: 1.5; color: #4A473F; margin: 0; max-width: 1000px; }
#demo-card ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
#demo-card li { font-size: 20px; display: flex; gap: 14px; align-items: baseline; }
#demo-card li b { font-family: var(--mono); font-size: 13px; color: #706C64; font-weight: 400; min-width: 28px; }
#demo-card .ft { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: #706C64; margin-top: 30px; display: flex; gap: 10px; align-items: center; }
#demo-card .ft i { width: 9px; height: 9px; border-radius: 50%; background: #C0392B; display: inline-block; }
#demo-cursor { position: fixed; left: 0; top: 0; z-index: 70; width: 22px; height: 22px; pointer-events: none;
  filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
#demo-click { position: fixed; z-index: 69; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
  border: 2px solid #1A1A1A; pointer-events: none; opacity: 0; }
`;

const TITLE_HTML = `
  <img class="logo" src="/brand/logo.png" alt="">
  <div class="eb">Fjällskred · Molker Digital · Walkthrough</div>
  <h1>The complete tool, through one simulated storm week</h1>
  <div class="rule"></div>
  <p>Monday 8 – Sunday 14 February 2027. Snow, avalanche bulletins, routes, terrain, forecasts and
  lift status are simulated and run through the real service; what you see is what the live tool
  would show. Map tiles and Commons photos are live-only, so they do not appear here.</p>
  <div class="ft"><span class="demo-sim">Simulated data · not a forecast</span></div>`;

const END_HTML = `
  <img class="logo" src="/brand/logo.png" alt="" style="height:120px">
  <h1>Where the snow fell, what it means, and how to get up there</h1>
  <div class="rule"></div>
  <ul>
    <li><b>01</b>Avalanche bulletins for 30 regions in Norway and Sweden</li>
    <li><b>02</b>Modelled snow depth and new snow at 48 touring objectives</li>
    <li><b>03</b>Email and phone push when 30 cm falls in 48 hours, bulletin first</li>
    <li><b>04</b>Routes on contour lines, elevation profile, GPX export, your own tracks</li>
    <li><b>05</b>Five-day summit forecast and openly licensed photos from near the summit</li>
    <li><b>06</b>Ski resorts: lifts and slopes open, for the days that aren't touring days</li>
  </ul>
  <div class="ft"><i></i>Self-hosted in one Docker container · this walkthrough uses simulated data</div>`;

const CURSOR_SVG = `<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.3 19.2 L10.3 12.8 L16.3 12.6 Z" fill="#1A1A1A" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme: 'light' });

let current = days[0];
await page.route('**/api/conditions', (r) => r.fulfill({ json: { ...current.snapshot, fetchedAt: new Date().toISOString() } }));
await page.route('**/api/alerts', (r) => r.fulfill({ json: current.alerts }));
await page.route('**/api/refresh', (r) => r.fulfill({ json: { ok: true } }));
await page.route('**/api/track?*', (r) => {
  const name = new URL(r.request().url()).searchParams.get('tour');
  r.fulfill({ json: routes[name] ?? { found: false, reason: 'Not part of the simulation.' } });
});
await page.route('**/api/forecast?*', (r) => {
  const name = new URL(r.request().url()).searchParams.get('tour');
  const f = current.forecasts?.[name];
  r.fulfill(f ? { json: f } : { status: 502, json: { error: 'not part of the simulation' } });
});
await page.route('**/api/terrain?*', (r) => {
  const t = terrains[new URL(r.request().url()).searchParams.get('tour')];
  r.fulfill(t ? { json: t } : { status: 502, json: { error: 'not part of the simulation' } });
});
// Commons photos are live-only; the panel shows its real fallback.
await page.route('**/api/photos?*', (r) => r.fulfill({ status: 502, json: { error: 'photos unavailable', detail: 'offline demo' } }));
await page.route('**/api/resorts', (r) => r.fulfill({ json: current.resorts }));
await page.route('**/tiles/**', (r) => r.fulfill({ status: 404, body: '' }));

await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.addStyleTag({ content: OVERLAY_CSS });
await page.evaluate((cursor) => {
  Element.prototype.scrollIntoView = function () {};
  document.documentElement.style.scrollBehavior = 'auto';
  for (const id of ['demo-cap', 'demo-toast', 'demo-card', 'demo-click']) {
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

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const frameDir = path.join(tmpdir(), 'ttv-frames-full');
await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
let frame = 0;
const shot = () => page.screenshot({ path: path.join(frameDir, `f${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const setOpacity = (id, o) => page.evaluate(([i, v]) => (document.getElementById(i).style.opacity = String(v)), [id, o]);
const setHtml = (id, html) => page.evaluate(([i, h]) => (document.getElementById(i).innerHTML = h), [id, html]);

async function loadDay(d) {
  current = days[d - 1];
  await page.evaluate(() => document.getElementById('refreshBtn').click());
  await page.waitForFunction(() => document.getElementById('refreshBtn').textContent === 'Refresh now');
  await page.waitForTimeout(100);
}
const setLayer = (l) => page.evaluate((x) => document.querySelector(`[data-layer="${x}"]`).click(), l);

async function targets() {
  return page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + window.scrollY : 0;
    };
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const c = (v) => Math.max(0, Math.min(max, v));
    return {
      top: 0,
      map: c(y('.mapbox') - 16),
      mapSouth: c(y('.mapbox') + 330),
      detail: c(y('#detailCard') - 12),
      detailLower: c(y('#forecast') - 150),
      photos: c(y('#photos') - 330),
      legend: c(y('#legend') - window.innerHeight + 170),
      sources: c(y('#sources') - 260),
    };
  });
}

let scrollY = 0;
let pointer = { x: W * 0.6, y: H * 0.45, shown: false };

async function placePointer(x, y, { move = true } = {}) {
  pointer = { ...pointer, x, y };
  await page.evaluate(([px, py]) => {
    const c = document.getElementById('demo-cursor');
    c.style.transform = `translate(${px - 3}px, ${py - 2}px)`;
    c.style.opacity = '1';
  }, [x, y]);
  if (move) await page.mouse.move(x, y);
}

async function center(sel) {
  return page.evaluate((s) => {
    const el = typeof s === 'string' ? document.querySelector(s) : null;
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
async function clickPulseStep(t) {
  await page.evaluate((v) => {
    const c = document.getElementById('demo-click');
    c.style.opacity = String(Math.max(0, 1 - v));
    c.style.transform = `scale(${0.5 + v})`;
  }, t);
}

/** Scroll the tour list so a row is visible, without moving the page. */
async function revealRow(name) {
  await page.evaluate((n) => {
    const list = document.getElementById('tourlist');
    const row = list.querySelector(`.trow[data-tour="${CSS.escape(n)}"]`);
    if (!row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - row.clientHeight) list.scrollTop = Math.max(0, top - 80);
  }, name);
}

function captionHtml(day, text) {
  const alertDays = new Set(days.filter((d) => d.alerts.firing.length).map((d) => d.day));
  const ticks = [1, 2, 3, 4, 5, 6, 7]
    .map((d) => `<i class="${d === day ? (alertDays.has(d) ? 'hot' : 'on') : d < day ? 'on' : ''}"></i>`)
    .join('');
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l, i) => `<span class="${i + 1 === day ? 'on' : ''}">${l}</span>`).join('');
  return `<div class="eb"><span>Day ${day} / 7 · <b>${dayLabel(day)}</b></span><span class="demo-sim">Simulated</span></div>
    <div class="tx">${text}</div><div class="tl">${ticks}${labels}</div>`;
}

function toastHtml(d) {
  const push = days[d - 1].push, email = days[d - 1].email;
  return `<div class="eb"><span>ntfy · fjällskred</span><span>06:00</span></div>
    <div class="ti">${push.title}</div><div class="bo">${push.body.split('\n').slice(0, 3).join('\n')}</div>
    <div class="ml"><b>Email</b>${email.subject}</div>`;
}

/* ------------------------------------------------------------------ *
 * the storyboard
 *
 * A step: { dur, day, cap, cam: [targets…], on: { t: fn }, each(t) }
 * `on` fires once when the step's progress passes t; `each` runs per frame.
 * ------------------------------------------------------------------ */

const glide = (from, to, t0, t1) => async (t) => {
  if (t < t0 || t > t1 + 0.05) return;
  const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
  const a = typeof from === 'function' ? await from() : from;
  const b = typeof to === 'function' ? await to() : to;
  if (a && b) await placePointer(lerp(a.x, b.x, k), lerp(a.y, b.y, k));
};

let glideFrom = null;
const glideTo = (sel, t0, t1, dx = 0, dy = 0) => {
  let start = null;
  return async (t) => {
    // Stop once arrived: a glide that kept pinning the pointer would fight
    // later drags and clicks.
    if (t < t0 || t > t1 + 0.04) return;
    if (!start) start = { x: pointer.x, y: pointer.y };
    const c = await center(sel);
    if (!c) return;
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    await placePointer(lerp(start.x, c.x + dx, k), lerp(start.y, c.y + dy, k));
  };
};

const clickAt = (sel) => async () => {
  const c = await center(sel);
  if (!c) return;
  await placePointer(c.x, c.y);
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

const sweepProfile = (t0, t1) => async (t) => {
  if (t < t0 || t > t1) return;
  const c = await center('.profilesvg .hit');
  if (!c) return;
  const k = ease((t - t0) / (t1 - t0));
  await placePointer(c.left + 4 + (c.w - 8) * k, c.top + c.h * 0.55);
};

const pulse = (t0) => async (t) => {
  if (t >= t0 && t < t0 + 0.2) await clickPulseStep((t - t0) / 0.2);
};

/** Screen position of a map coordinate under the current zoom. */
const geoPoint = (lat, lon) =>
  page.evaluate(([la, lo]) => {
    const svg = document.getElementById('map');
    const r = svg.getBoundingClientRect();
    const [k, cx, cy] = (svg.dataset.view ?? '1 280 380').split(' ').map(Number);
    const bx = 250 + (lo - 17) * Math.cos((la * Math.PI) / 180) * 44;
    const by = (71.9 - la) * 44;
    const s = r.width / 560;
    let x = r.left + ((bx - cx) * k + 280) * s, y = r.top + ((by - cy) * k + 380) * s;
    // Never double-click onto a marker: that selects it instead.
    for (let i = 0; i < 8; i++) {
      const el = document.elementFromPoint(x, y);
      if (!el?.closest('g.reg, g.tourpin, g.resort, .resortdot, a')) break;
      x += 14;
    }
    return { x, y };
  }, [lat, lon]);

const mapMiddle = () =>
  page.evaluate((vh) => {
    const r = document.getElementById('map').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2 };
  }, H);

let zoomPt = null;
const dblAt = (lat, lon) => async () => {
  zoomPt ??= await geoPoint(lat, lon);
  await placePointer(zoomPt.x, zoomPt.y, { move: false });
  await clickPulse(zoomPt.x, zoomPt.y);
  await page.mouse.dblclick(zoomPt.x, zoomPt.y);
};
const glideGeo = (lat, lon, t0, t1) => {
  let a = null, b = null;
  return async (t) => {
    if (t < t0 || t > t1 + 0.03) return;
    a ??= { x: pointer.x, y: pointer.y };
    b ??= zoomPt = await geoPoint(lat, lon);
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    await placePointer(lerp(a.x, b.x, k), lerp(a.y, b.y, k), { move: false });
  };
};
/** Drag the map from wherever the pointer is to the middle of the map. */
const dragToMiddle = (t0, t1) => {
  let a = null, b = null, done = false;
  return async (t) => {
    if (t < t0 || done) return;
    if (!a) {
      a = { x: pointer.x, y: pointer.y };
      b = await mapMiddle();
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
    }
    const k = ease(Math.min(1, (t - t0) / (t1 - t0)));
    await placePointer(lerp(a.x, b.x, k), lerp(a.y, b.y, k));
    if (k >= 1) {
      await page.mouse.up();
      done = true;
      zoomPt = null;
    }
  };
};

const waitRoute = async () => {
  await page.waitForSelector('#routeMeta', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('#routeMeta')?.textContent.includes('Looking up'), null, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('#forecast')?.textContent.includes('Loading'), null, { timeout: 10000 });
  await page.waitForTimeout(80);
};

const rr = route('Rørnestinden');
const sk = route('Skårasalen');

const STEPS = [
  { card: 'title', dur: 4 },

  { day: 1, dur: 4, layer: 'depth', cam: ['top'],
    cap: 'Monday. Fjällskred: snow, avalanche danger and powder alerts for 30 regions in Norway and Sweden, on one page.' },
  { day: 1, dur: 7, cam: ['map'],
    cap: 'Three map layers: modelled snow depth, new snow in 48 hours, and EAWS avalanche danger.',
    each: [glideTo('[data-layer="new48"]', 0.15, 0.3), glideTo('[data-layer="danger"]', 0.55, 0.68), pulse(0.32), pulse(0.7)],
    on: { 0.32: clickAt('[data-layer="new48"]'), 0.7: clickAt('[data-layer="danger"]') } },
  { day: 1, dur: 7, cam: ['map'],
    cap: '48 touring objectives, each with the modelled snow at its own summit area. Search, filter and sort.',
    each: [glideTo('#q', 0.05, 0.18), typeInto('#q', 'tind', 0.22, 0.42), glideTo('#fSort', 0.62, 0.74), pulse(0.76)],
    on: {
      0.2: clickAt('#q'),
      0.55: async () => page.evaluate(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }),
      0.76: async () => { await clickPulse(pointer.x, pointer.y); await page.selectOption('#fSort', 'depth'); },
    } },

  { day: 2, dur: 5, layer: 'new48', cam: ['map'], cap: 'Tuesday. A westerly front reaches Finnmark and Troms.' },
  { day: 3, dur: 6, layer: 'new48', cam: ['top'], toast: 3,
    cap: () => `Wednesday. ${topAlert(3)} in 48 hours. Push and email go out, and every alert points to the bulletin first.` },
  { day: 3, dur: 4, cam: ['map'],
    cap: 'Red rings mark regions over your alert threshold. Sorting by new snow puts the loaded tours on top.',
    each: [glideTo('#fSort', 0.1, 0.35), pulse(0.4)],
    on: { 0.4: async () => { await clickPulse(pointer.x, pointer.y); await page.selectOption('#fSort', 'new'); } } },
  { day: 3, dur: 9, cam: ['map', 'detail', 'detail', 'detail'],
    cap: rr?.found
      ? `Rørnestinden: a ${(rr.lengthM / 1000).toFixed(1)} km route from OpenStreetMap over contour lines from the terrain model, and an elevation profile. Hover the climb to follow it on the map.`
      : 'Rørnestinden: route and elevation sketch.',
    pre: async () => revealRow('Rørnestinden'),
    each: [glideTo('.trow[data-tour="Rørnestinden"]', 0.02, 0.14, -120), pulse(0.16), sweepProfile(0.5, 0.97)],
    on: { 0.16: async () => { await clickAt('.trow[data-tour="Rørnestinden"]')(); await waitRoute(); } } },
  { day: 3, dur: 6, cam: ['detailLower'],
    cap: () => `Five-day summit forecast beside the bulletin: ${fcToday(3, 'Rørnestinden')} cm today, then clearing and cold. Danger 4 — read it first.`,
    on: { 0.01: async () => page.evaluate(() => document.getElementById('demo-cursor').style.opacity = '0') } },

  { day: 3, dur: 5, cam: ['photos'],
    cap: 'Openly licensed photos from near the summit, from Wikimedia Commons, credited and linked. Live-only, so the offline demo shows the fallback.' },

  { day: 4, dur: 5, layer: 'danger', cam: ['map'], cap: 'Thursday. Danger 4 (High) across Troms while the front moves south.' },
  { day: 5, dur: 5, layer: 'new48', cam: ['mapSouth'], cap: 'Friday. The front reaches Møre og Romsdal.' },
  { day: 6, dur: 5, layer: 'new48', cam: ['top'], toast: 6,
    cap: () => `Saturday. ${topAlert(6)}. Three regions over the threshold.` },
  { day: 6, dur: 7, cam: ['map', 'detail', 'detail'],
    cap: sk?.found
      ? `Skårasalen: ${(sk.lengthM / 1000).toFixed(1)} km and ${sk.profile?.stats?.ascentM} m of climbing on a danger-4 day. Take the GPX with you; the decision stays yours.`
      : 'Skårasalen on a danger-4 day.',
    pre: async () => { await page.selectOption('#fSort', 'new'); await revealRow('Skårasalen'); },
    each: [glideTo('.trow[data-tour="Skårasalen"]', 0.02, 0.16, -120), pulse(0.18), glideTo('a[href*="track.gpx"]', 0.62, 0.85)],
    on: { 0.18: async () => { await clickAt('.trow[data-tour="Skårasalen"]')(); await waitRoute(); } } },

  // Three camera legs so the scroll up to the map is finished (by ~0.2)
  // before anything is clicked: a click aimed during a scroll lands elsewhere.
  { day: 6, dur: 10, cam: ['map', 'map', 'map'],
    cap: 'Not every day is a touring day. Ski resorts: slopes left, lifts right, darker = more open. The storm has Sunnmøre\'s lifts on wind hold.',
    pre: async () => { await page.evaluate(() => (document.getElementById('demo-cursor').style.opacity = '1')); },
    each: [glideTo('#showResorts', 0.12, 0.2), pulse(0.22), glideGeo(62.35, 7.9, 0.27, 0.35),
      pulse(0.38), pulse(0.47), pulse(0.56), dragToMiddle(0.63, 0.86)],
    on: { 0.22: clickAt('#showResorts'), 0.38: dblAt(62.35, 7.9), 0.47: dblAt(62.35, 7.9), 0.56: dblAt(62.35, 7.9) } },
  { day: 6, dur: 10, cam: ['map', 'map', 'legend'],
    cap: 'Trysil and Hemsedal run everything today; each name links to the resort. Sweden publishes no open lift status, so its resorts show dashed \'no status\' icons, never \'closed\'.',
    each: [glideTo('.zoombtn[data-zoom="reset"]', 0.02, 0.1), pulse(0.12), glideGeo(61.25, 12.7, 0.18, 0.26),
      pulse(0.28), pulse(0.36), pulse(0.44), dragToMiddle(0.5, 0.66)],
    on: { 0.12: clickAt('.zoombtn[data-zoom="reset"]'), 0.28: dblAt(61.25, 12.7), 0.36: dblAt(61.25, 12.7), 0.44: dblAt(61.25, 12.7) } },

  { day: 7, dur: 7, cam: ['map', 'detail', 'detail'],
    pre: async () => page.evaluate(() => {
      const cb = document.getElementById('showResorts');
      if (cb.checked) cb.click();
      document.querySelector('.zoombtn[data-zoom="reset"]').click();
    }),
    cap: 'No mapped path reaches Hamperokken\'s summit, so no line is drawn. A guessed route has no place on a ski map.',
    each: [glideTo('#q', 0.02, 0.1), typeInto('#q', 'hamp', 0.12, 0.2), glideTo('.trow[data-tour="Hamperokken"]', 0.22, 0.3, -100), pulse(0.32)],
    on: { 0.11: clickAt('#q'), 0.32: async () => { await clickAt('.trow[data-tour="Hamperokken"]')(); await waitRoute(); } } },
  { day: 7, dur: 6, layer: 'depth', cam: ['map'],
    cap: 'Sunday. Clearing, and a deeper base everywhere. A dark theme for pre-dawn checks.',
    pre: async () => page.evaluate(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('demo-cursor').style.opacity = '0'; }),
    on: { 0.45: async () => page.emulateMedia({ colorScheme: 'dark' }) } },
  { day: 7, dur: 4, cam: ['sources'], cap: 'Every source on the page with its freshness: Varsom, Naturvårdsverket, seNorge, Regobs, Fnugg.',
    pre: async () => page.emulateMedia({ colorScheme: 'light' }) },

  { card: 'end', dur: 5 },
];

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

let lastDay = 0;
for (const step of STEPS) {
  const n = Math.round(step.dur * FPS);

  if (step.card) {
    await setHtml('demo-card', step.card === 'title' ? TITLE_HTML : END_HTML);
    await setOpacity('demo-cap', 0);
    await setOpacity('demo-toast', 0);
    await page.evaluate(() => (document.getElementById('demo-cursor').style.opacity = '0'));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      await setOpacity('demo-card', step.card === 'title' ? (t > 0.88 ? 1 - (t - 0.88) / 0.12 : 1) : Math.min(1, t / 0.12));
      await shot();
    }
    continue;
  }

  if (step.day !== lastDay) {
    await loadDay(step.day);
    lastDay = step.day;
  }
  if (step.layer) await setLayer(step.layer);
  if (step.pre) await step.pre();
  await setOpacity('demo-card', 0);
  await setHtml('demo-cap', captionHtml(step.day, typeof step.cap === 'function' ? step.cap() : step.cap));
  await setOpacity('demo-cap', 1);
  if (step.toast) await setHtml('demo-toast', toastHtml(step.toast));

  const fired = new Set();
  const legs = step.cam.length;
  let tg = await targets();

  for (let i = 0; i < n; i++) {
    const t = i / n;
    for (const [at, fn] of Object.entries(step.on ?? {})) {
      if (t >= Number(at) && !fired.has(at)) {
        fired.add(at);
        await fn();
        tg = await targets(); // layout may have changed (detail opened, alerts appeared)
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
      const o = t < 0.08 ? 0 : t < 0.18 ? (t - 0.08) / 0.1 : t < 0.82 ? 1 : Math.max(0, 1 - (t - 0.82) / 0.1);
      await setOpacity('demo-toast', o);
    }
    await shot();
  }
  scrollY = tg[step.cam[legs - 1]];
  await setOpacity('demo-toast', 0);
}

await browser.close();
server.close();

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', path.join(frameDir, 'f%05d.jpg'),
  '-vf', 'fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-movflags', '+faststart',
  outFile,
]);
console.log(`${frame} frames -> ${outFile} (${(frame / FPS).toFixed(1)} s)`);
