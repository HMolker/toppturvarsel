import { inflateSync } from 'node:zlib';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { UA } from '../util/ua.js';
import { latLonToUTM } from '../util/utm.js';

/**
 * Sweden's 1 m terrain model (Lantmäteriet, Markhöjdmodell), read straight
 * from its Cloud-Optimized GeoTIFFs with HTTP range requests, no library.
 *
 * Found by Lantmäteriet's open STAC API:
 *   GET https://api.lantmateriet.se/stac-hojd/v1/search?collections=dtm-cog&bbox=w,s,e,n
 *   -> features[].{ id: "703_40", bbox, properties: { "proj:code": "EPSG:5845",
 *        "proj:shape": [10000, 10000], "proj:transform": [1,0,400000, 0,-1,7040000, 0,0,1] },
 *        assets.data.href: "https://dl1.lantmateriet.se/hojd/data/grid/mhm/70_4/m703_40.tif" }
 *   (checked live 2026-09-23). The catalogue is open; the files need Basic
 *   authentication with a Geotorget account that has ordered
 *   "Markhöjdmodell Nedladdning" (LANTMATERIET_USER / LANTMATERIET_PASSWORD).
 *
 * The files, from a real header (m703_40.tif, 2026-09-23): classic
 * little-endian TIFF, 10000 x 10000 float32 heights (SampleFormat 3, one
 * sample), 512 x 512 tiles, DEFLATE (8) with the floating-point predictor
 * (3), GDAL_NODATA as a string, plus reduced-resolution overviews in further
 * directories. Coordinates SWEREF 99 TM (the same transverse Mercator as
 * UTM zone 33 on GRS80), heights RH 2000. Placement comes from the STAC
 * item's proj:transform, so the GeoTIFF tags themselves are not needed.
 *
 * Downloads are counted against LANTMATERIET_DAILY_MB (default 1000). Tiles
 * are kept on disk as they came (compressed), for a year.
 *
 * © Lantmäteriet, CC BY 4.0.
 */

const STAC = process.env.LANTMATERIET_STAC_URL || 'https://api.lantmateriet.se/stac-hojd/v1';
const STAC_TTL = 30 * 86400e3;
const FILE_TTL = 365 * 86400e3;
const HEADER_BYTES = 65536;

export function lmCredentials() {
  const u = (process.env.LANTMATERIET_USER ?? '').trim();
  const p = process.env.LANTMATERIET_PASSWORD ?? '';
  return u && p ? { user: u, pass: p } : null;
}
export const lmEnabled = () => Boolean(lmCredentials()) && (process.env.LANTMATERIET ?? 'on') !== 'off';

const cacheDir = (...p) => path.resolve(config.dataDir, 'cache', 'lm', ...p);

/* ------------------------------------------------------------------ *
 * TIFF structure
 * ------------------------------------------------------------------ */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

export class NeedMore extends Error {
  constructor(end) {
    super(`need bytes up to ${end}`);
    this.end = end;
  }
}

/**
 * Every image directory in a TIFF, from the bytes at its start. Throws
 * NeedMore(end) when a directory or an array lies past the bytes given.
 */
export function parseTiff(buf) {
  if (buf.length < 8) throw new NeedMore(8);
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  if (!le && !(buf[0] === 0x4d && buf[1] === 0x4d)) throw new Error('not a TIFF');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const need = (o, n) => { if (o + n > buf.length) throw new NeedMore(o + n); };
  const u16 = (o) => (need(o, 2), dv.getUint16(o, le));
  const u32 = (o) => (need(o, 4), dv.getUint32(o, le));
  const magic = u16(2);
  if (magic === 43) throw new Error('BigTIFF is not supported');
  if (magic !== 42) throw new Error('not a TIFF');

  const read = (type, count, at) => {
    const size = TYPE_SIZE[type] ?? 1;
    const off = size * count <= 4 ? at : u32(at);
    need(off, size * count);
    if (type === 2) return Buffer.from(buf.subarray(off, off + count)).toString('latin1').replace(/\0+$/, '');
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = off + i * size;
      out[i] = type === 3 ? dv.getUint16(o, le) : type === 4 ? dv.getUint32(o, le) : type === 12 ? dv.getFloat64(o, le) : type === 11 ? dv.getFloat32(o, le) : type === 1 ? buf[o] : dv.getUint32(o, le);
    }
    return out;
  };

  const ifds = [];
  let at = u32(4);
  const seen = new Set();
  while (at && !seen.has(at) && ifds.length < 32) {
    seen.add(at);
    const n = u16(at);
    need(at + 2, n * 12 + 4);
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    const one = (t, d = null) => (tags[t] ? read(tags[t].type, tags[t].count, tags[t].at)[0] : d);
    const nodataStr = tags[42113] ? read(2, tags[42113].count, tags[42113].at) : null;
    ifds.push({
      width: one(256), height: one(257),
      bits: one(258, 1), compression: one(259, 1), predictor: one(317, 1), sampleFormat: one(339, 1),
      samples: one(277, 1), planar: one(284, 1),
      tileW: one(322), tileH: one(323),
      offsets: tags[324] ? read(tags[324].type, tags[324].count, tags[324].at) : null,
      counts: tags[325] ? read(tags[325].type, tags[325].count, tags[325].at) : null,
      nodata: nodataStr !== null && nodataStr.trim() !== '' && Number.isFinite(Number(nodataStr)) ? Number(nodataStr) : null,
      reduced: (one(254, 0) & 1) === 1,
      // GeoTIFF placement (v5.6.2, for files that carry it themselves):
      // pixel size, the tie point, and whether it marks a pixel's corner or centre.
      scale: tags[33550] ? read(tags[33550].type, tags[33550].count, tags[33550].at) : null,
      tie: tags[33922] ? read(tags[33922].type, tags[33922].count, tags[33922].at) : null,
      pixelIsPoint: tags[34735] ? geoKey(read(tags[34735].type, tags[34735].count, tags[34735].at), 1025) === 2 : false,
    });
    at = u32(at + 2 + n * 12);
  }
  const first = ifds[0];
  if (!first) throw new Error('TIFF has no image');
  for (const d of ifds) {
    if (!d.tileW || !d.offsets) throw new Error('only tiled TIFFs are supported');
    if (d.bits !== 32 || d.sampleFormat !== 3 || d.samples !== 1) throw new Error(`unsupported pixels: ${d.bits}-bit format ${d.sampleFormat}, ${d.samples} samples`);
    if (![1, 5, 8, 32946].includes(d.compression)) throw new Error(`unsupported compression ${d.compression}`);
    if (![1, 3].includes(d.predictor)) throw new Error(`unsupported predictor ${d.predictor}`);
    d.tilesAcross = Math.ceil(d.width / d.tileW);
    d.tilesDown = Math.ceil(d.height / d.tileH);
  }
  return { le, ifds };
}

/** A value from a GeoKeyDirectory (4 shorts of header, then 4 per key). */
function geoKey(dir, id) {
  for (let i = 4; i + 3 < dir.length; i += 4) if (dir[i] === id) return dir[i + 1] === 0 ? dir[i + 3] : null;
  return null;
}

/** TIFF LZW (compression 5): MSB-first codes of 9-12 bits, early change. */
export function lzwDecode(input, expected = 0) {
  const out = Buffer.alloc(Math.max(expected, input.length * 3));
  let o = 0;
  const grow = (n) => { if (o + n > outBuf.length) { const b = Buffer.alloc(Math.max(outBuf.length * 2, o + n)); outBuf.copy(b, 0, 0, o); outBuf = b; } };
  let outBuf = out;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
  let next = 258, width = 9, prev = -1, bitPos = 0;
  const totalBits = input.length * 8;
  const emit = (code) => {
    const n = len[code];
    grow(n);
    let c = code;
    for (let k = n - 1; k >= 0; k--) { outBuf[o + k] = suffix[c]; c = prefix[c]; }
    o += n;
  };
  while (bitPos + width <= totalBits) {
    let code = 0;
    for (let k = 0; k < width; k++) {
      const b = bitPos + k;
      code = (code << 1) | ((input[b >> 3] >> (7 - (b & 7))) & 1);
    }
    bitPos += width;
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    if (prev === -1) { emit(code); prev = code; continue; }
    if (code < next) {
      emit(code);
      if (next < 4096) { prefix[next] = prev; suffix[next] = first[code]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; }
    } else {
      // The code being defined right now: prev + prev's first byte.
      if (next < 4096) { prefix[next] = prev; suffix[next] = first[prev]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; }
      emit(code);
    }
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return outBuf.subarray(0, o);
}

/**
 * One tile's bytes -> Float32Array of tileW * tileH heights.
 *
 * The floating-point predictor (Adobe Photoshop TIFF Technical Note 3, as
 * libtiff implements it): each row of W floats is stored as four planes of
 * W bytes, most significant byte first, then differenced byte by byte along
 * the whole 4W-byte row. Undo the differencing, then read the planes back
 * as big-endian floats, whatever the file's own byte order.
 */
export function decodeTile(raw, ifd, le) {
  const W = ifd.tileW, H = ifd.tileH, bps = 4;
  const bytes = ifd.compression === 1 ? Buffer.from(raw) : ifd.compression === 5 ? Buffer.from(lzwDecode(raw, W * H * bps)) : inflateSync(raw);
  if (bytes.length < W * H * bps) throw new Error(`tile is ${bytes.length} bytes, expected ${W * H * bps}`);
  const out = new Float32Array(W * H);
  if (ifd.predictor === 3) {
    const rowLen = W * bps;
    const dv = new DataView(new ArrayBuffer(4));
    for (let y = 0; y < H; y++) {
      const o = y * rowLen;
      for (let i = 1; i < rowLen; i++) bytes[o + i] = (bytes[o + i] + bytes[o + i - 1]) & 0xff;
      for (let x = 0; x < W; x++) {
        dv.setUint8(0, bytes[o + x]);
        dv.setUint8(1, bytes[o + W + x]);
        dv.setUint8(2, bytes[o + 2 * W + x]);
        dv.setUint8(3, bytes[o + 3 * W + x]);
        out[y * W + x] = dv.getFloat32(0, false);
      }
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let k = 0; k < W * H; k++) out[k] = dv.getFloat32(k * 4, le);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * HTTP: range requests with Basic authentication, and a daily cap
 * ------------------------------------------------------------------ */

const traffic = { day: null, bytes: 0 };
const dailyBytes = () => Math.max(0, Number(process.env.LANTMATERIET_DAILY_MB ?? 1000)) * 1e6;
export function lmTraffic() {
  const d = new Date().toISOString().slice(0, 10);
  if (traffic.day !== d) Object.assign(traffic, { day: d, bytes: 0 });
  return { day: traffic.day, mb: Math.round(traffic.bytes / 1e5) / 10, limitMb: dailyBytes() / 1e6 };
}
export function _resetLmTraffic() {
  Object.assign(traffic, { day: null, bytes: 0 });
}

async function rangeGet(url, start, end) {
  const t = lmTraffic();
  if (traffic.bytes > dailyBytes()) {
    throw Object.assign(new Error(`daily Lantmäteriet download cap reached (${t.mb} of ${t.limitMb} MB); it resets at midnight UTC`), { status: 429 });
  }
  const cred = lmCredentials();
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Range: `bytes=${start}-${end - 1}`,
      ...(cred ? { Authorization: `Basic ${Buffer.from(`${cred.user}:${cred.pass}`).toString('base64')}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) throw new Error('Lantmäteriet refused the login (401): check LANTMATERIET_USER and LANTMATERIET_PASSWORD');
  if (res.status === 403) throw new Error('Lantmäteriet: this account has no access to the terrain files yet (403): order "Markhöjdmodell Nedladdning" in Geotorget');
  if (res.status !== 206 && res.status !== 200) throw new Error(`Lantmäteriet HTTP ${res.status}`);
  let body = Buffer.from(await res.arrayBuffer());
  traffic.bytes += body.length;
  // A server that ignores Range sends the whole file: keep only what was asked for.
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

/* ------------------------------------------------------------------ *
 * which file covers a point (STAC), cached per 10 km square
 * ------------------------------------------------------------------ */

const stacMemo = new Map();

export function sweref(lat, lon) {
  const { x, y } = latLonToUTM(lat, lon, 33, { round: false });
  return { e: x, n: y };
}

function itemCovers(item, e, n) {
  const t = item.properties?.['proj:transform'], s = item.properties?.['proj:shape'];
  if (!t || !s) return false;
  const x0 = t[2], y0 = t[5], sx = t[0], sy = -t[4];
  return e >= x0 && e < x0 + s[1] * sx && n <= y0 && n > y0 - s[0] * sy;
}

/** The newest dtm-cog item whose grid covers the point, or null. */
export async function stacItemAt(lat, lon) {
  const { e, n } = sweref(lat, lon);
  const key = `${Math.floor(n / 10000)}_${Math.floor(e / 10000)}`;
  if (stacMemo.has(key)) return stacMemo.get(key);
  const file = cacheDir('stac', `${key}.json`);
  const cached = await readCached(file, STAC_TTL);
  if (cached) {
    const v = JSON.parse(cached.toString('utf8')).item;
    stacMemo.set(key, v);
    return v;
  }
  const d = 0.0005;
  const url = `${STAC}/search?collections=dtm-cog&bbox=${(lon - d).toFixed(5)},${(lat - d).toFixed(5)},${(lon + d).toFixed(5)},${(lat + d).toFixed(5)}&limit=10`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Lantmäteriet STAC HTTP ${res.status}`);
  const body = await res.json();
  const items = (body.features ?? []).filter((f) => f.assets?.data?.href && itemCovers(f, e, n));
  items.sort((a, b) => String(b.properties?.datetime).localeCompare(String(a.properties?.datetime)));
  const it = items[0];
  const v = it ? { id: it.id, href: it.assets.data.href, transform: it.properties['proj:transform'], shape: it.properties['proj:shape'], datetime: it.properties.datetime } : null;
  await writeCached(file, JSON.stringify({ item: v, fetchedAt: new Date().toISOString() }));
  stacMemo.set(key, v);
  return v;
}

/* ------------------------------------------------------------------ *
 * files and tiles
 * ------------------------------------------------------------------ */

const headers = new Map(); // id -> Promise<{le, ifds}>
const tileMemo = new Map(); // "id/level/tx/ty" -> Float32Array (LRU)
const TILE_MEMO_MAX = 48;
const inflight = new Map();

function fileHeader(item) {
  if (!headers.has(item.id)) {
    headers.set(item.id, (async () => {
      const file = cacheDir('files', item.id, 'header.bin');
      let buf = await readCached(file, FILE_TTL);
      for (let tries = 0; tries < 4; tries++) {
        if (!buf) buf = await rangeGet(item.href, 0, HEADER_BYTES);
        try {
          const t = parseTiff(buf);
          await writeCached(file, buf);
          return t;
        } catch (err) {
          if (!(err instanceof NeedMore)) throw err;
          // Directories past the first 64 KB: fetch far enough to hold them.
          buf = Buffer.concat([buf, await rangeGet(item.href, buf.length, Math.max(err.end, buf.length * 2))]);
        }
      }
      throw new Error('TIFF header too large');
    })().catch((err) => { headers.delete(item.id); throw err; }));
  }
  return headers.get(item.id);
}

async function tileAt(item, tiff, level, tx, ty) {
  const key = `${item.id}/${level}/${tx}/${ty}`;
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
    if (!cnt) {
      arr = new Float32Array(ifd.tileW * ifd.tileH).fill(NaN); // sparse tile: no data
    } else {
      const file = cacheDir('files', item.id, String(level), `${tx}_${ty}.bin`);
      let raw = await readCached(file, FILE_TTL);
      if (!raw) {
        raw = await rangeGet(item.href, off, off + cnt);
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

/** The coarsest directory whose pixels are no bigger than `maxPx` metres. */
export function pickLevel(tiff, basePx, maxPx) {
  let best = 0, bestPx = basePx;
  tiff.ifds.forEach((d, i) => {
    const px = basePx * (tiff.ifds[0].width / d.width);
    if (px <= maxPx + 1e-9 && px > bestPx) { best = i; bestPx = px; }
  });
  return best;
}

/**
 * Heights at many points, metres, null where there is no data. `spacingM`
 * is how far apart the caller's points are: the file level used has pixels
 * no bigger than half that (1 m at most detail).
 */
export async function lmElevations(points, { spacingM = 10 } = {}) {
  const out = new Array(points.length).fill(null);
  // Group by file first: one STAC lookup and one header per 10 km square.
  const byItem = new Map();
  for (let i = 0; i < points.length; i++) {
    const item = await stacItemAt(points[i].lat, points[i].lon);
    if (!item) continue;
    if (!byItem.has(item.id)) byItem.set(item.id, { item, idx: [] });
    byItem.get(item.id).idx.push(i);
  }
  for (const { item, idx } of byItem.values()) {
    const tiff = await fileHeader(item);
    const t = item.transform;
    const baseW = tiff.ifds[0].width;
    const level = pickLevel(tiff, t[0], Math.max(1, spacingM / 2));
    const ifd = tiff.ifds[level];
    const scale = baseW / ifd.width; // base pixels per level pixel
    const px = t[0] * scale, x0 = t[2], y0 = t[5];
    // Which tiles are needed, then fetch them two at a time.
    const need = new Map();
    const where = idx.map((i) => {
      const { e, n } = sweref(points[i].lat, points[i].lon);
      const fx = (e - x0) / px - 0.5, fy = (y0 - n) / px - 0.5;
      const cells = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cx = Math.min(ifd.width - 1, Math.max(0, Math.floor(fx) + dx));
        const cy = Math.min(ifd.height - 1, Math.max(0, Math.floor(fy) + dy));
        const tx = Math.floor(cx / ifd.tileW), ty = Math.floor(cy / ifd.tileH);
        need.set(`${tx}/${ty}`, [tx, ty]);
        cells.push({ tx, ty, i: cx - tx * ifd.tileW, j: cy - ty * ifd.tileH });
      }
      return { i, fx, fy, cells };
    });
    const tiles = new Map();
    const list = [...need.values()];
    for (let k = 0; k < list.length; k += 2) {
      await Promise.all(list.slice(k, k + 2).map(async ([tx, ty]) => tiles.set(`${tx}/${ty}`, await tileAt(item, tiff, level, tx, ty))));
    }
    for (const w of where) {
      const v = w.cells.map((c) => tiles.get(`${c.tx}/${c.ty}`)[c.j * ifd.tileW + c.i]);
      const u = w.fx - Math.floor(w.fx), s = w.fy - Math.floor(w.fy);
      let z = (v[0] * (1 - u) + v[1] * u) * (1 - s) + (v[2] * (1 - u) + v[3] * u) * s;
      if (!Number.isFinite(z)) z = v.find(Number.isFinite) ?? null; // at a data edge: nearest known
      out[w.i] = z === null ? null : Math.round(z * 100) / 100;
    }
  }
  return out;
}

export function lmStatus() {
  return { enabled: lmEnabled(), configured: Boolean(lmCredentials()), traffic: lmTraffic(), filesOpen: headers.size, tilesInMemory: tileMemo.size };
}

// After Lantmäteriet fails (a refused login, an order not yet active, the
// day's download cap), it is left alone for a while instead of being tried
// again for every tile, and the page is told Sweden is coarse for now.
export const LM_PAUSE_MS = 10 * 60 * 1000;
let lmDownUntil = 0;
export const lmPause = () => { lmDownUntil = Date.now() + LM_PAUSE_MS; };
/** Lantmäteriet configured and not resting after a failure. */
export const lmUsable = () => lmEnabled() && Date.now() >= lmDownUntil;

export function _resetLm() {
  lmDownUntil = 0;
  stacMemo.clear();
  headers.clear();
  tileMemo.clear();
  _resetLmTraffic();
}

