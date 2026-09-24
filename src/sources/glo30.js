import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { UA } from '../util/ua.js';
import { parseTiff, decodeTile, NeedMore } from './lmcog.js';

/**
 * Copernicus DEM GLO-30 (v5.6.2): the 30 m terrain model for the whole
 * world, read from its public copy on Amazon's open-data store as
 * cloud-optimised GeoTIFFs — one file per 1° × 1° square, of which only the
 * pieces needed are fetched (HTTP range requests) and then kept a year.
 *
 *   https://copernicus-dem-30m.s3.amazonaws.com/
 *     Copernicus_DSM_COG_10_N61_00_E012_00_DEM/Copernicus_DSM_COG_10_N61_00_E012_00_DEM.tif
 *
 * The file for a square is named by its south-west corner. No key and no
 * daily limit (a courtesy cap, GLO30_DAILY_MB, still applies here). Squares
 * over open sea have no file (404), remembered as such.
 *
 * It replaces Open-Meteo's 90 m heights (the same Copernicus model, a third
 * as fine, and limited to a few thousand points a day) wherever Lantmäteriet
 * (Sweden, 1 m) or Kartverket (Norway, 1-10 m) have no answer.
 *
 * © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
 * provided under COPERNICUS by the European Union and ESA; all rights reserved.
 * Free to use under the Copernicus DEM licence.
 */

const BASE = process.env.GLO30_URL || 'https://copernicus-dem-30m.s3.amazonaws.com';
const FILE_TTL = 365 * 86400e3;
const NONE_TTL = 90 * 86400e3;
const HEADER_BYTES = 32768;
const cacheDir = (...p) => path.resolve(config.dataDir, 'cache', 'glo30', ...p);

export const glo30Enabled = () => !/^(off|false|0|no)$/i.test(process.env.GLO30 ?? 'on');

// After a failure (the store unreachable), left alone for 10 minutes.
let downUntil = 0;
export let glo30LastError = null;
export const glo30Usable = () => glo30Enabled() && Date.now() >= downUntil;

const traffic = { day: null, bytes: 0 };
const dailyBytes = () => Math.max(0, Number(process.env.GLO30_DAILY_MB ?? 2000)) * 1e6;
export function glo30Traffic() {
  const d = new Date().toISOString().slice(0, 10);
  if (traffic.day !== d) Object.assign(traffic, { day: d, bytes: 0 });
  return { day: traffic.day, mb: Math.round(traffic.bytes / 1e5) / 10, limitMb: dailyBytes() / 1e6 };
}

/** The file name for the 1° square holding a point. */
export function glo30Name(lat, lon) {
  const la = Math.floor(lat), lo = Math.floor(lon);
  const ns = la >= 0 ? 'N' : 'S', ew = lo >= 0 ? 'E' : 'W';
  const id = `Copernicus_DSM_COG_10_${ns}${String(Math.abs(la)).padStart(2, '0')}_00_${ew}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
  return { id, url: `${BASE}/${id}/${id}.tif` };
}

async function rangeGet(url, start, end) {
  glo30Traffic();
  if (traffic.bytes > dailyBytes()) {
    throw Object.assign(new Error(`daily GLO-30 download cap reached (${glo30Traffic().mb} MB); it resets at midnight UTC`), { status: 429 });
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404 || res.status === 403) return null; // no file for this square (open sea)
  if (res.status !== 206 && res.status !== 200) throw new Error(`GLO-30 HTTP ${res.status}`);
  let body = Buffer.from(await res.arrayBuffer());
  traffic.bytes += body.length;
  if (res.status === 200 && body.length > end - start) body = body.subarray(start, end);
  return body;
}

async function readCached(file, ttl) {
  try {
    const { mtimeMs } = await stat(file);
    if (Date.now() - mtimeMs > ttl) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}
async function writeCached(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

const headers = new Map(); // id -> Promise<{le, ifds} | null>
function fileHeader(name) {
  if (!headers.has(name.id)) {
    headers.set(name.id, (async () => {
      if (await readCached(cacheDir(name.id, 'none'), NONE_TTL)) return null;
      const file = cacheDir(name.id, 'header.bin');
      let buf = await readCached(file, FILE_TTL);
      for (let tries = 0; tries < 5; tries++) {
        if (!buf) {
          buf = await rangeGet(name.url, 0, HEADER_BYTES);
          if (!buf) {
            await writeCached(cacheDir(name.id, 'none'), '');
            return null;
          }
        }
        try {
          const t = parseTiff(buf);
          const g = t.ifds[0];
          if (!g.scale || !g.tie) throw new Error('GLO-30 file without its placement');
          await writeCached(file, buf);
          return t;
        } catch (err) {
          if (!(err instanceof NeedMore)) throw err;
          const more = await rangeGet(name.url, buf.length, Math.max(err.end, buf.length * 2));
          if (!more) throw new Error('GLO-30 header cut short');
          buf = Buffer.concat([buf, more]);
        }
      }
      throw new Error('GLO-30 header too large');
    })().catch((err) => { headers.delete(name.id); throw err; }));
  }
  return headers.get(name.id);
}

const tileMemo = new Map();
const TILE_MEMO_MAX = 32;
const inflight = new Map();
async function tileAt(name, tiff, level, tx, ty) {
  const key = `${name.id}/${level}/${tx}/${ty}`;
  if (tileMemo.has(key)) {
    const v = tileMemo.get(key);
    tileMemo.delete(key);
    tileMemo.set(key, v);
    return v;
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const ifd = tiff.ifds[level];
    const k = ty * ifd.tilesAcross + tx;
    const off = ifd.offsets[k], cnt = ifd.counts[k];
    let arr;
    if (!cnt) arr = new Float32Array(ifd.tileW * ifd.tileH).fill(NaN);
    else {
      const file = cacheDir(name.id, String(level), `${tx}_${ty}.bin`);
      let raw = await readCached(file, FILE_TTL);
      if (!raw) {
        raw = await rangeGet(name.url, off, off + cnt);
        if (!raw) throw new Error('GLO-30 tile vanished');
        await writeCached(file, raw);
      }
      arr = decodeTile(raw, ifd, tiff.le);
      const nd = ifd.nodata ?? tiff.ifds[0].nodata;
      for (let i = 0; i < arr.length; i++) if (arr[i] === nd || arr[i] < -1000 || arr[i] > 9000) arr[i] = NaN;
    }
    tileMemo.set(key, arr);
    if (tileMemo.size > TILE_MEMO_MAX) tileMemo.delete(tileMemo.keys().next().value);
    return arr;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * Heights at many points, metres, null where there is no file or no data.
 * `spacingM`: how far apart the points are; a coarser overview is read when
 * its pixels are still no bigger than half that.
 */
export async function glo30Elevations(points, { spacingM = 30 } = {}) {
  const out = new Array(points.length).fill(null);
  const bySquare = new Map();
  points.forEach((p, i) => {
    const n = glo30Name(p.lat, p.lon);
    if (!bySquare.has(n.id)) bySquare.set(n.id, { name: n, idx: [] });
    bySquare.get(n.id).idx.push(i);
  });
  try {
    for (const { name, idx } of bySquare.values()) {
      const tiff = await fileHeader(name);
      if (!tiff) continue;
      const g = tiff.ifds[0];
      const sx0 = g.scale[0], sy0 = g.scale[1];
      // The tie point: pixel (I, J) at (X, Y). Corner or centre of that pixel.
      const [I, J, , X, Y] = g.tie;
      const half = g.pixelIsPoint ? 0 : 0.5;
      const basePx = sy0 * 111320; // metres, north-south
      // The coarsest level whose pixels are no bigger than half the spacing.
      let level = 0;
      tiff.ifds.forEach((d, i) => {
        if (basePx * (g.width / d.width) <= Math.max(basePx, spacingM / 2) + 1e-9 && d.width < tiff.ifds[level].width) level = i;
      });
      const ifd = tiff.ifds[level];
      const fx0 = g.width / ifd.width, fy0 = g.height / ifd.height;
      const need = new Map();
      const where = idx.map((i) => {
        const p = points[i];
        // Fractional pixel in the base image, centres at integers.
        const cx = (p.lon - X) / sx0 + I - half, cy = (Y - p.lat) / sy0 + J - half;
        // In this level's pixels.
        const fx = (cx + 0.5) / fx0 - 0.5, fy = (cy + 0.5) / fy0 - 0.5;
        const cells = [];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const px = Math.min(ifd.width - 1, Math.max(0, Math.floor(fx) + dx));
          const py = Math.min(ifd.height - 1, Math.max(0, Math.floor(fy) + dy));
          const tx = Math.floor(px / ifd.tileW), ty = Math.floor(py / ifd.tileH);
          need.set(`${tx}/${ty}`, [tx, ty]);
          cells.push({ tx, ty, i: px - tx * ifd.tileW, j: py - ty * ifd.tileH });
        }
        return { i, fx, fy, cells };
      });
      const tiles = new Map();
      const list = [...need.values()];
      for (let k = 0; k < list.length; k += 3) {
        await Promise.all(list.slice(k, k + 3).map(async ([tx, ty]) => tiles.set(`${tx}/${ty}`, await tileAt(name, tiff, level, tx, ty))));
      }
      for (const w of where) {
        const v = w.cells.map((c) => tiles.get(`${c.tx}/${c.ty}`)[c.j * ifd.tileW + c.i]);
        const u = w.fx - Math.floor(w.fx), s = w.fy - Math.floor(w.fy);
        let z = (v[0] * (1 - u) + v[1] * u) * (1 - s) + (v[2] * (1 - u) + v[3] * u) * s;
        if (!Number.isFinite(z)) z = v.find(Number.isFinite) ?? null;
        out[w.i] = z === null ? null : Math.round(z * 100) / 100;
      }
    }
    glo30LastError = null;
  } catch (err) {
    glo30LastError = err.message;
    downUntil = Date.now() + 10 * 60 * 1000;
    throw err;
  }
  return out;
}

export function glo30Status() {
  return { enabled: glo30Enabled(), usable: glo30Usable(), traffic: glo30Traffic(), lastError: glo30LastError };
}

/** For tests. */
export function _resetGlo30() {
  headers.clear();
  tileMemo.clear();
  downUntil = 0;
  glo30LastError = null;
  Object.assign(traffic, { day: null, bytes: 0 });
}
