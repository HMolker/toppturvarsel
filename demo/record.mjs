#!/usr/bin/env node
/**
 * Records a 30-second demo of the real frontend playing back a simulated week.
 *
 *   node demo/simulate.mjs <daysDir>
 *   node demo/record.mjs <daysDir> <out.mp4> [path/to/playwright]
 *
 * The page is the unmodified app served by the real server. Only /api/* is
 * intercepted, and it answers with the snapshots demo/simulate.mjs produced.
 * Captions, the push toast and the title/end cards are overlays added for the
 * video; every number on screen underneath them comes from the pipeline.
 *
 * Frames are captured one screenshot at a time (not a screen recording), so
 * the result is deterministic and does not depend on machine speed.
 */

import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [daysDir, outFile, pwPath] = process.argv.slice(2);
if (!daysDir || !outFile) {
  console.error('usage: node demo/record.mjs <daysDir> <out.mp4> [playwright module path]');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath ?? 'playwright');

process.env.DATA_DIR = path.join(tmpdir(), 'ttv-record');
process.env.LOG_LEVEL = 'error';
process.env.SEASON_ONLY = 'true';
const { createServer } = await import('../src/server.js');

const FPS = 20;
const W = 1280, H = 720, SCALE = 1.5; // renders at 1920x1080, UI large enough to read

const days = [];
for (let d = 1; d <= 7; d++) days.push(JSON.parse(await readFile(path.join(daysDir, `day-${d}.json`), 'utf8')));

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayLabel = (d) => {
  const dt = new Date(days[d - 1].date);
  return `${WEEKDAY[dt.getUTCDay()]} ${dt.getUTCDate()} Feb 2027`;
};
const top = (d) => {
  const f = days[d - 1].alerts.firing[0];
  return f ? `${f.regionName} +${Math.round(f.new48)} cm` : '';
};

/* ------------------------------------------------------------------ *
 * storyboard — 30.0 s
 * ------------------------------------------------------------------ */

const SCENES = [
  { kind: 'title', dur: 3.0 },
  { day: 1, dur: 3.0, layer: 'new48', cam: ['top', 'map'], text: 'Quiet start. Settled pack, a few centimetres of new snow.' },
  { day: 2, dur: 3.0, layer: 'new48', cam: ['map'], text: 'A westerly front reaches Finnmark and Troms.' },
  { day: 3, dur: 4.5, layer: 'new48', cam: ['top', 'top', 'map'], toast: true, text: () => `30+ cm in 48 h in the north — alerts go out. ${top(3)}.` },
  { day: 4, dur: 3.0, layer: 'danger', cam: ['map'], text: 'Danger 4 (High) across Troms while the front moves south.' },
  { day: 5, dur: 3.0, layer: 'new48', cam: ['mapSouth'], text: 'The front reaches Møre og Romsdal.' },
  { day: 6, dur: 4.5, layer: 'new48', cam: ['top', 'mapSouth', 'detail', 'detail'], toast: true, tour: 'Skårasalen', tourAt: 0.5,
    text: () => `Sunnmøre loaded. ${top(6)}. Every alert points to the bulletin first.` },
  { day: 7, dur: 3.0, layer: 'depth', cam: ['map'], text: 'Clearing. A deeper base everywhere, danger easing.' },
  { kind: 'end', dur: 3.0 },
];

/* ------------------------------------------------------------------ *
 * overlays, in the graphical profile
 * ------------------------------------------------------------------ */

const OVERLAY_CSS = `
#demo-cap { position: fixed; right: 20px; bottom: 20px; width: 450px; z-index: 50;
  background: #1A1A1A; color: #EDEBE5; border-radius: 12px; padding: 16px 20px 18px;
  font-family: var(--sans); box-shadow: 0 0 0 1px rgba(0,0,0,.25); }
#demo-cap .eb { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #A8A49B; display: flex; justify-content: space-between; gap: 12px; }
#demo-cap .eb b { color: #EDEBE5; font-weight: 600; }
#demo-cap .tx { font-size: 18px; line-height: 1.35; font-weight: 600; margin: 8px 0 12px; }
#demo-cap .tl { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
#demo-cap .tl i { height: 5px; border-radius: 2px; background: #3A3833; }
#demo-cap .tl i.on { background: #EDEBE5; }
#demo-cap .tl i.hot { background: #C0392B; }
#demo-cap .tl span { font-family: var(--mono); font-size: 10px; color: #A8A49B; text-align: center; margin-top: 4px; }
#demo-cap .tl span.on { color: #EDEBE5; }
#demo-sim { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  color: #1A1A1A; background: #fff; border-radius: 4px; padding: 2px 6px; }
#demo-toast { position: fixed; right: 20px; top: 150px; width: 380px; z-index: 51;
  background: #fff; color: #1A1A1A; border: 1px solid #D8D5CC; border-radius: 12px; padding: 12px 16px;
  font-family: var(--sans); box-shadow: 0 8px 28px rgba(26,26,26,.18); }
#demo-toast .eb { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #706C64; display: flex; justify-content: space-between; }
#demo-toast .ti { font-weight: 700; font-size: 16px; margin: 4px 0 2px; color: #C0392B; }
#demo-toast .bo { font-size: 13px; line-height: 1.45; color: #4A473F; white-space: pre-line; }
#demo-card { position: fixed; inset: 0; z-index: 60; background: #F4F3EF; color: #1A1A1A;
  display: flex; flex-direction: column; justify-content: center; padding: 0 96px; font-family: var(--sans); }
#demo-card .eb { font-family: var(--mono); font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #706C64; }
#demo-card h1 { font-size: 50px; line-height: 1.08; margin: 14px 0 18px; font-weight: 700; letter-spacing: -.015em; max-width: 1000px; }
#demo-card .rule { height: 2px; background: #1A1A1A; width: 100%; margin: 6px 0 22px; }
#demo-card p { font-size: 20px; line-height: 1.5; color: #4A473F; margin: 0; max-width: 980px; }
#demo-card ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
#demo-card li { font-size: 22px; display: flex; gap: 14px; align-items: baseline; }
#demo-card li b { font-family: var(--mono); font-size: 13px; color: #706C64; font-weight: 400; min-width: 28px; }
#demo-card .ft { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: #706C64; margin-top: 34px; display: flex; gap: 10px; align-items: center; }
#demo-card .ft i { width: 9px; height: 9px; border-radius: 50%; background: #C0392B; display: inline-block; }
`;

const TITLE_HTML = `
  <div class="eb">Fjällskred · Demo</div>
  <h1>One simulated storm week in the Nordic mountains</h1>
  <div class="rule"></div>
  <p>Monday 8 – Sunday 14 February 2027. A weather model feeds simulated upstream data through the real service,
  and this is what the live tool shows day by day.</p>
  <div class="ft"><span id="demo-sim">Simulated data · not a forecast</span></div>`;

const END_HTML = `
  <div class="eb">Fjällskred</div>
  <h1>Where the snow fell, and what it means</h1>
  <div class="rule"></div>
  <ul>
    <li><b>01</b>Live avalanche bulletins from Varsom and Naturvårdsverket, 30 regions</li>
    <li><b>02</b>Modelled snow depth sampled at 48 touring objectives</li>
    <li><b>03</b>Email and phone push when 30 cm falls in 48 hours, bulletin first</li>
  </ul>
  <div class="ft"><i></i>Self-hosted in one Docker container · this demo uses simulated data</div>`;

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme: 'light' });

let current = days[0];
await page.route('**/api/conditions', (r) =>
  r.fulfill({ json: { ...current.snapshot, fetchedAt: new Date().toISOString() } })
);
await page.route('**/api/alerts', (r) => r.fulfill({ json: current.alerts }));
await page.route('**/api/refresh', (r) => r.fulfill({ json: { ok: true } }));

await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.addStyleTag({ content: OVERLAY_CSS });
await page.evaluate(() => {
  // The camera is driven per frame; stop the app's own smooth scrolling.
  Element.prototype.scrollIntoView = function () {};
  document.documentElement.style.scrollBehavior = 'auto';
  for (const id of ['demo-cap', 'demo-toast', 'demo-card']) {
    const el = document.createElement('div');
    el.id = id;
    el.style.opacity = '0';
    document.body.appendChild(el);
  }
});

async function loadDay(d) {
  current = days[d - 1];
  await page.evaluate(() => document.getElementById('refreshBtn').click());
  await page.waitForFunction(() => document.getElementById('refreshBtn').textContent === 'Refresh now');
  await page.waitForTimeout(120);
}

async function setLayer(layer) {
  await page.evaluate((l) => document.querySelector(`[data-layer="${l}"]`).click(), layer);
}

async function camTargets() {
  return page.evaluate(() => {
    const y = (sel) => document.querySelector(sel).getBoundingClientRect().top + window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const clamp = (v) => Math.max(0, Math.min(max, v));
    return {
      top: 0,
      map: clamp(y('.mapbox') - 20),
      mapSouth: clamp(y('.mapbox') + 330),
      detail: clamp(y('#detailCard') - 20),
    };
  });
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function captionHtml(scene, alertDays) {
  const text = typeof scene.text === 'function' ? scene.text() : scene.text;
  const ticks = [1, 2, 3, 4, 5, 6, 7]
    .map((d) => `<i class="${d === scene.day ? (alertDays.has(d) ? 'hot' : 'on') : d < scene.day ? 'on' : ''}"></i>`)
    .join('');
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    .map((l, i) => `<span class="${i + 1 === scene.day ? 'on' : ''}">${l}</span>`)
    .join('');
  return `<div class="eb"><span>Day ${scene.day} / 7 · <b>${dayLabel(scene.day)}</b></span><span id="demo-sim">Simulated</span></div>
    <div class="tx">${text}</div><div class="tl">${ticks}${labels}</div>`;
}

function toastHtml(push) {
  const body = push.body.split('\n').slice(0, 3).join('\n');
  return `<div class="eb"><span>ntfy · toppturvarsel</span><span>06:00</span></div>
    <div class="ti">${push.title}</div><div class="bo">${body}</div>`;
}

const alertDays = new Set(days.filter((d) => d.alerts.firing.length).map((d) => d.day));
const frameDir = path.join(tmpdir(), 'ttv-frames');
await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });

let frame = 0;
let scrollY = 0;
const setOpacity = (id, o) => page.evaluate(([i, v]) => (document.getElementById(i).style.opacity = String(v)), [id, o]);

for (const scene of SCENES) {
  const n = Math.round(scene.dur * FPS);

  if (scene.kind) {
    await page.evaluate(
      ([html]) => (document.getElementById('demo-card').innerHTML = html),
      [scene.kind === 'title' ? TITLE_HTML : END_HTML]
    );
    await setOpacity('demo-cap', 0);
    await setOpacity('demo-toast', 0);
    if (scene.kind === 'end') { await loadDay(7); await setLayer('depth'); }
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // title fades out at the end; end card fades in at the start
      const o = scene.kind === 'title' ? (t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1) : Math.min(1, t / 0.15);
      await setOpacity('demo-card', o);
      await page.screenshot({ path: path.join(frameDir, `f${String(frame++).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
    }
    continue;
  }

  await loadDay(scene.day);
  await setLayer(scene.layer);
  await page.evaluate(([html]) => (document.getElementById('demo-cap').innerHTML = html), [captionHtml(scene, alertDays)]);
  await setOpacity('demo-card', 0);
  await setOpacity('demo-cap', 1);
  if (scene.toast && current.push) {
    await page.evaluate(([html]) => (document.getElementById('demo-toast').innerHTML = html), [toastHtml(current.push)]);
  }

  let targets = await camTargets();
  let tourClicked = false;
  const legs = scene.cam.length;

  for (let i = 0; i < n; i++) {
    const t = i / n;

    if (scene.tour && !tourClicked && t >= scene.tourAt) {
      await page.evaluate((name) => document.querySelector(`.trow[data-tour="${name}"]`)?.click(), scene.tour);
      await page.waitForTimeout(80);
      targets = await camTargets();
      tourClicked = true;
    }

    // Camera: ease through the scene's list of targets, one leg each.
    const legT = Math.min(0.999, t) * legs;
    const leg = Math.floor(legT);
    const from = leg === 0 ? scrollY : targets[scene.cam[leg - 1]];
    const to = targets[scene.cam[leg]];
    const y = from + (to - from) * ease(Math.min(1, (legT - leg) / 0.55));
    await page.evaluate((v) => window.scrollTo(0, v), y);

    if (scene.toast && current.push) {
      const o = t < 0.08 ? 0 : t < 0.18 ? (t - 0.08) / 0.1 : t < 0.78 ? 1 : Math.max(0, 1 - (t - 0.78) / 0.1);
      await setOpacity('demo-toast', o);
    }

    await page.screenshot({ path: path.join(frameDir, `f${String(frame++).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  scrollY = targets[scene.cam[legs - 1]];
  await setOpacity('demo-toast', 0);
}

await browser.close();
server.close();

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', path.join(frameDir, 'f%04d.jpg'),
  '-vf', 'fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart',
  outFile,
]);

console.log(`${frame} frames -> ${outFile} (${(frame / FPS).toFixed(1)} s)`);
