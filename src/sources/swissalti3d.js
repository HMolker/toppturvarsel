import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { UA } from '../util/ua.js';
import { readRaster } from './tiffraster.js';

/**
 * Switzerland's terrain model, swissALTI3D (v6.1): swisstopo's open 2 m
 * grid, in 1 km × 1 km GeoTIFFs in the Swiss grid (LV95, EPSG:2056).
 *
 * Found through swisstopo's open STAC catalogue (checked 1 Oct 2026):
 *   GET https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items?bbox=w,s,e,n
 *   -> features[].{ id: "swissalti3d_2019_2634-1098", properties.datetime,
 *        assets["swissalti3d_2019_2634-1098_2_2056_5728.tif"].href: "https://data.geo.admin.ch/
 *          ch.swisstopo.swissalti3d/swissalti3d_2019_2634-1098/swissalti3d_2019_2634-1098_2_2056_5728.tif" }
 * "2634-1098" is the square's south-west corner in km (E 2634000, N 1098000).
 * A square can come in several years (2019 and 2024 at the Allalinhorn):
 * the newest is used. 0.5 m files exist too; 2 m is plenty for slopes and
 * a quarter of the download.
 *
 * Each 2 m file is fetched whole (500 × 500 heights), kept on disk for a
 * year, and counted against SWISSALTI3D_DAILY_MB (default 300). Free
 * geodata, © swisstopo. SWISSALTI3D=off leaves Switzerland on GLO-30.
 */

const STAC = process.env.SWISSALTI3D_STAC_URL || 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items';
const STAC_TTL = 90 * 86400e3;
const FILE_TTL = 365 * 86400e3;
const cacheDir = (...p) => path.resolve(config.dataDir, 'cache', 'swissalti3d', ...p);

/**
 * WGS84 -> LV95 (E, N metres), swisstopo's approximate formulas
 * ("Approximate formulas for the transformation between Swiss projection
 * coordinates and WGS84"), good to about a metre — far below a 2 m cell.
 */
export function lv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return { e, n };
}
/** The inverse, for tests and for the square's corner. */
export function wgs84(e, n) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return { lat: (p * 100) / 36, lon: (l * 100) / 36 };
}
export const squareOf = (e, n) => `${Math.floor(e / 1000)}-${Math.floor(n / 1000)}`;

/* ---------- download traffic, and a rest after failures ---------- */
const traffic = { day: null, bytes: 0 };
const dailyBytes = () => Math.max(0, Number(process.env.SWISSALTI3D_DAILY_MB ?? 300)) * 1e6;
export function swissTraffic() {
  const d = new Date().toISOString().slice(0, 10);
  if (traffic.day !== d) Object.assign(traffic, { day: d, bytes: 0 });
  return { day: traffic.day, mb: Math.round(traffic.bytes / 1e5) / 10, limitMb: dailyBytes() / 1e6 };
}
let downUntil = 0;
let lastError = null;
export const swissEnabled = () => !/^(off|false|0|no)$/i.test(process.env.SWISSALTI3D ?? 'on');
export const swissUsable = () => swissEnabled() && Date.now() >= downUntil;
export const swissPause = (err) => { downUntil = Date.now() + 10 * 60e3; lastError = err?.message ?? String(err); };
export const swissStatus = () => ({ enabled: swissEnabled(), usable: swissUsable(), lastError, traffic: swissTraffic(), filesInMemory: rasters.size });

async function readCached(file, ttl) {
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs > ttl) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}
async function writeCached(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  // A name of its own: two requests can fetch the same square at the same moment.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/* ---------- which file covers a square (STAC) ---------- */
const itemMemo = new Map();
const itemInflight = new Map();

/** The newest 2 m file of a 1 km square, or null (outside Switzerland). */
export function fileForSquare(square) {
  if (itemMemo.has(square)) return Promise.resolve(itemMemo.get(square));
  if (!itemInflight.has(square)) itemInflight.set(square, lookUp(square).finally(() => itemInflight.delete(square)));
  return itemInflight.get(square);
}

async function lookUp(square) {
  const file = cacheDir('stac', `${square}.json`);
  const cached = await readCached(file, STAC_TTL);
  if (cached) {
    const v = JSON.parse(cached.toString('utf8')).item;
    itemMemo.set(square, v);
    return v;
  }
  const [ke, kn] = square.split('-').map(Number);
  const c = wgs84(ke * 1000 + 500, kn * 1000 + 500);
  const d = 0.001;
  const url = `${STAC}?bbox=${(c.lon - d).toFixed(5)},${(c.lat - d).toFixed(5)},${(c.lon + d).toFixed(5)},${(c.lat + d).toFixed(5)}&limit=20`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`swisstopo STAC HTTP ${res.status}`);
  const body = await res.json();
  const v = pickItem(body, square);
  await writeCached(file, JSON.stringify({ item: v, fetchedAt: new Date().toISOString() }));
  itemMemo.set(square, v);
  return v;
}

/** From a STAC answer: the newest item of the square, with its 2 m GeoTIFF. */
export function pickItem(body, square) {
  const items = (body?.features ?? [])
    .filter((f) => String(f.id ?? '').endsWith(`_${square}`))
    .map((f) => {
      const asset = Object.entries(f.assets ?? {}).find(([k, a]) => /_2_2056_\d+\.tif$/.test(k) || (/\.tif$/.test(a?.href ?? '') && /_2_2056_/.test(a.href)));
      return asset ? { id: f.id, href: asset[1].href, datetime: f.properties?.datetime ?? '' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)) || b.id.localeCompare(a.id));
  return items[0] ?? null;
}

/* ---------- the files themselves ---------- */
const rasters = new Map(); // id -> Promise<raster> (LRU)
const MEMO_MAX = 24;

async function rasterFor(item) {
  if (rasters.has(item.id)) {
    const p = rasters.get(item.id);
    rasters.delete(item.id);
    rasters.set(item.id, p);
    return p;
  }
  const p = (async () => {
    const file = cacheDir('files', `${item.id}.tif`);
    let buf = await readCached(file, FILE_TTL);
    if (!buf) {
      const t = swissTraffic();
      if (traffic.bytes > dailyBytes()) throw Object.assign(new Error(`daily swissALTI3D download cap reached (${t.mb} of ${t.limitMb} MB); it resets at midnight UTC`), { status: 429 });
      const res = await fetch(item.href, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`swissALTI3D HTTP ${res.status} for ${item.id}`);
      buf = Buffer.from(await res.arrayBuffer());
      traffic.bytes += buf.length;
      await writeCached(file, buf);
    }
    const r = readRaster(buf);
    const [ke, kn] = item.id.split('_').pop().split('-').map(Number);
    // Placement: from the file's own tags, else from its name (a 1 km square, area pixels).
    let x0, y0, sx, sy;
    if (r.scale && r.tie) {
      [sx, sy] = r.scale;
      const [I, J, , X, Y] = r.tie;
      x0 = X - I * sx;
      y0 = Y + J * sy;
      if (r.pixelIsPoint) { x0 -= sx / 2; y0 += sy / 2; }
    } else {
      sx = sy = 1000 / r.width;
      x0 = ke * 1000;
      y0 = (kn + 1) * 1000;
    }
    return { ...r, x0, y0, sx, sy };
  })();
  rasters.set(item.id, p);
  p.catch(() => rasters.delete(item.id));
  if (rasters.size > MEMO_MAX) rasters.delete(rasters.keys().next().value);
  return p;
}

/** Bilinear height in a raster at LV95 (e, n), or null. */
export function sampleRaster(r, e, n) {
  const fx = (e - r.x0) / r.sx - 0.5, fy = (r.y0 - n) / r.sy - 0.5;
  if (fx < -1 || fy < -1 || fx > r.width || fy > r.height) return null;
  const i = Math.max(0, Math.min(r.width - 1, Math.floor(fx))), j = Math.max(0, Math.min(r.height - 1, Math.floor(fy)));
  const i1 = Math.min(r.width - 1, i + 1), j1 = Math.min(r.height - 1, j + 1);
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
  const q = [r.data[j * r.width + i], r.data[j * r.width + i1], r.data[j1 * r.width + i], r.data[j1 * r.width + i1]];
  let z = (q[0] * (1 - u) + q[1] * u) * (1 - v) + (q[2] * (1 - u) + q[3] * u) * v;
  if (!Number.isFinite(z)) z = q.find(Number.isFinite) ?? null;
  return z === null ? null : Math.round(z * 100) / 100;
}

/** Heights at many points, metres; null outside Switzerland or without data. */
export async function swissElevations(points) {
  const out = new Array(points.length).fill(null);
  const bySquare = new Map();
  points.forEach((p, i) => {
    const { e, n } = lv95(p.lat, p.lon);
    const sq = squareOf(e, n);
    if (!bySquare.has(sq)) bySquare.set(sq, []);
    bySquare.get(sq).push({ i, e, n });
  });
  const squares = [...bySquare.keys()];
  // Two files at a time: polite, and a DEM tile needs a handful.
  for (let k = 0; k < squares.length; k += 2) {
    await Promise.all(squares.slice(k, k + 2).map(async (sq) => {
      const item = await fileForSquare(sq);
      if (!item) return;
      const r = await rasterFor(item);
      for (const { i, e, n } of bySquare.get(sq)) out[i] = sampleRaster(r, e, n);
    }));
  }
  return out;
}

/** A square's file, for check-sources: what it is and how it is stored. */
export async function describeSquare(lat, lon) {
  const { e, n } = lv95(lat, lon);
  const item = await fileForSquare(squareOf(e, n));
  if (!item) return null;
  const r = await rasterFor(item);
  return { id: item.id, info: r.info, height: sampleRaster(r, e, n) };
}

export function _resetSwiss() {
  itemMemo.clear();
  itemInflight.clear();
  rasters.clear();
  downUntil = 0;
  lastError = null;
  Object.assign(traffic, { day: null, bytes: 0 });
}
