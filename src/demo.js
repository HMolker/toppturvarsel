import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, loadTours } from './config.js';
import { log } from './util/log.js';

/**
 * The demo area (v5.8): what a sneaky login can use of Plan a tour — the
 * ground within DEMO_RADIUS_KM (3) of DEMO_TOUR (Harahorn), from what the
 * server has stored and never a new height.
 *
 * The server fetches the area ahead, a little each day so it stays well
 * inside the height budget (DEMO_DAILY_POINTS, 20 000 a day): first
 * everything within DEMO_FIRST_KM (1.5), then out to the full radius. Map
 * and NVE tiles cost no heights and come along at a polite pace.
 */

const R = Math.PI / 180;
export const DEMO_DEM_ZOOMS = [15, 14, 13, 12];
export const DEMO_TILE_ZOOMS = [12, 13, 14, 15, 16];
let area = null;

export async function demoArea() {
  if (area) return area;
  const name = process.env.DEMO_TOUR || 'Harahorn';
  const t = (await loadTours()).find((x) => x.name === name);
  if (!t) throw new Error(`demo tour ${name} is not in data/tours.json`);
  area = {
    name, lat: t.lat, lon: t.lon,
    radiusKm: Math.max(0.5, Number(process.env.DEMO_RADIUS_KM) || 3),
    firstKm: Math.max(0.2, Number(process.env.DEMO_FIRST_KM) || 1.5),
  };
  return area;
}
export const _resetDemo = () => { area = null; statusMemo = null; };

export const kmBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111.2, (a.lon - b.lon) * 111.2 * Math.cos(a.lat * R));

/** Is a point inside the area (plus `padKm`)? */
export async function inDemo(lat, lon, padKm = 0) {
  const a = await demoArea();
  return kmBetween(a, { lat, lon }) <= a.radiusKm + padKm;
}

function tileBox(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) / R;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y / n), south: lat((y + 1) / n) };
}
/** Km from the area's centre to the nearest point of a map tile. */
export function tileKm(a, z, x, y) {
  const b = tileBox(z, x, y);
  const lat = Math.max(b.south, Math.min(b.north, a.lat)), lon = Math.max(b.west, Math.min(b.east, a.lon));
  return kmBetween(a, { lat, lon });
}
export async function tileInDemo(z, x, y) {
  const a = await demoArea();
  return tileKm(a, z, x, y) <= a.radiusKm;
}

/** Every tile to fetch, nearest ring first: [{ kind: 'dem' | 'no' | 'nve', z, x, y, km }]. */
export async function demoJobs() {
  const a = await demoArea();
  const jobs = [];
  const add = (kind, zooms) => {
    for (const z of zooms) {
      const n = 2 ** z;
      const dLat = a.radiusKm / 111.2, dLon = a.radiusKm / (111.2 * Math.cos(a.lat * R));
      const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
      const ty = (lat) => Math.floor(((1 - Math.log(Math.tan(lat * R) + 1 / Math.cos(lat * R)) / Math.PI) / 2) * n);
      for (let x = tx(a.lon - dLon); x <= tx(a.lon + dLon); x++) {
        for (let y = ty(a.lat + dLat); y <= ty(a.lat - dLat); y++) {
          const km = tileKm(a, z, x, y);
          if (km <= a.radiusKm) jobs.push({ kind, z, x, y, km });
        }
      }
    }
  };
  add('dem', DEMO_DEM_ZOOMS);
  add('no', DEMO_TILE_ZOOMS);
  add('nve', DEMO_TILE_ZOOMS);
  // The first ring before anything else; inside a ring, nearest first, heights before pictures.
  const ring = (j) => (j.km <= a.firstKm ? 0 : 1);
  jobs.sort((p, q) => ring(p) - ring(q) || (p.kind === 'dem' ? 0 : 1) - (q.kind === 'dem' ? 0 : 1) || p.km - q.km || q.z - p.z);
  return jobs;
}

const demFile = (z, x, y) => path.resolve(config.dataDir, 'cache', 'dem', String(z), String(x), `${y}.json`);
const tileFile = (src, z, x, y) => path.resolve(config.dataDir, 'cache', 'tiles', src, String(z), String(x), `${y}.png`);
const exists = (f) => stat(f).then(() => true, () => false);
async function isDone(j) {
  if (j.kind === 'dem') return exists(demFile(j.z, j.x, j.y));
  return (await exists(tileFile(j.kind, j.z, j.x, j.y))) || exists(`${tileFile(j.kind, j.z, j.x, j.y)}.none`);
}

const stateFile = () => path.resolve(config.dataDir, 'cache', 'demo-state.json');
async function readState() {
  try { return JSON.parse(await readFile(stateFile(), 'utf8')); } catch { return {}; }
}
async function writeState(s) {
  await mkdir(path.dirname(stateFile()), { recursive: true });
  await writeFile(`${stateFile()}.tmp`, JSON.stringify(s));
  await rename(`${stateFile()}.tmp`, stateFile());
}
const dailyPoints = () => Math.max(0, Number(process.env.DEMO_DAILY_POINTS ?? 20000));

let running = null;
/**
 * Fetch what is missing, nearest first, until today's share of heights is
 * spent. `getDemTile` and `getTile` are the server's own (passed in, so the
 * tests can stand in for them).
 */
export function runDemoPrefetch({ getDemTile, getTile, gapMs = 300 } = {}) {
  running ??= (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const st = await readState();
    let spent = st.day === today ? st.points ?? 0 : 0;
    let fetched = 0, heights = 0;
    for (const j of await demoJobs()) {
      if (await isDone(j)) continue;
      if (j.kind === 'dem') {
        if (spent + 289 > dailyPoints()) break;
        try {
          await getDemTile(j.z, j.x, j.y);
          spent += 289;
          heights += 289;
          fetched++;
          await writeState({ day: today, points: spent });
        } catch (err) {
          log.warn(`demo: height tile ${j.z}/${j.x}/${j.y}: ${err.message}`);
          if (err.status === 429) break;
        }
      } else {
        const t = await getTile(j.kind, j.z, j.x, j.y);
        if (t.status === 200 || t.status === 404) fetched++;
      }
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    statusMemo = null;
    if (fetched) log.info(`demo: ${fetched} tiles of the demo area fetched (${heights} heights, ${spent} today)`);
    return { fetched, heights, spent };
  })().finally(() => { running = null; });
  return running;
}

/** How much of the area is stored: for /api/terrain/zone and the page. */
let statusMemo = null;
export async function demoStatus() {
  if (statusMemo && Date.now() - statusMemo.at < 60e3) return statusMemo.value;
  const value = await readStatus();
  statusMemo = { at: Date.now(), value };
  return value;
}
async function readStatus() {
  const a = await demoArea();
  const jobs = await demoJobs();
  let done = 0, first = 0, firstDone = 0;
  for (const j of jobs) {
    const ok = await isDone(j);
    if (ok) done++;
    if (j.km <= a.firstKm) { first++; if (ok) firstDone++; }
  }
  return { ...a, tiles: jobs.length, stored: done, firstRingReady: first > 0 && firstDone === first, ready: done === jobs.length };
}

/** Start the daily fetching: once soon after start, then each hour of the night scan. */
export function startDemoPrefetch(deps) {
  if (/^(off|false|0|no)$/i.test(process.env.DEMO ?? 'on')) return;
  const hours = String(process.env.NIGHT_SCAN_HOURS ?? '1-5').split('-').map(Number);
  const run = () => runDemoPrefetch(deps).catch((e) => log.warn(`demo: ${e.message}`));
  setTimeout(run, 90e3).unref();
  setInterval(() => {
    const h = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hour12: false }));
    if (h >= (hours[0] ?? 1) && h <= (hours[1] ?? 5)) run();
  }, 3600e3).unref();
}
