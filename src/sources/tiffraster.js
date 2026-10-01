import { inflateSync } from 'node:zlib';
import { lzwDecode } from './lmcog.js';

/**
 * A whole single-band GeoTIFF, decoded (v6.1): for small files that are
 * simplest fetched whole, such as swisstopo's 1 km swissALTI3D tiles.
 *
 * lmcog.js reads big Cloud-Optimized files a tile at a time and knows one
 * layout; this one takes what GeoTIFFs commonly are, because the Swiss files'
 * insides could not be inspected from where this was written:
 *   - classic TIFF, either byte order (not BigTIFF)
 *   - tiles or strips
 *   - no compression (1), LZW (5), Deflate (8 / 32946)
 *   - predictor none (1), horizontal (2, integers) or floating point (3)
 *   - float32, float64, int16, uint16, int32, uint32 samples, one band
 * Placement from the GeoTIFF tags (ModelPixelScale, ModelTiepoint,
 * RasterPixelIsPoint), and GDAL_NODATA.
 *
 *   readRaster(buf) -> { width, height, data: Float32Array (row-major, NaN = no data),
 *                        scale: [sx, sy], tie: [I, J, K, X, Y, Z], pixelIsPoint, info }
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function ifd0(buf) {
  if (buf.length < 8) throw new Error('not a TIFF (too short)');
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  if (!le && !(buf[0] === 0x4d && buf[1] === 0x4d)) throw new Error('not a TIFF');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const magic = u16(2);
  if (magic === 43) throw new Error('BigTIFF is not supported');
  if (magic !== 42) throw new Error('not a TIFF');
  const read = (type, count, at) => {
    const size = TYPE_SIZE[type] ?? 1;
    const off = size * count <= 4 ? at : u32(at);
    if (off + size * count > buf.length) throw new Error('TIFF cut short');
    if (type === 2) return Buffer.from(buf.subarray(off, off + count)).toString('latin1').replace(/\0+$/, '');
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = off + i * size;
      out[i] = type === 1 || type === 7 ? buf[o] : type === 3 ? u16(o) : type === 8 ? dv.getInt16(o, le) : type === 4 ? u32(o) : type === 9 ? dv.getInt32(o, le)
        : type === 11 ? dv.getFloat32(o, le) : type === 12 ? dv.getFloat64(o, le) : u32(o);
    }
    return out;
  };
  const at = u32(4);
  const n = u16(at);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
  }
  const all = (t) => (tags[t] ? read(tags[t].type, tags[t].count, tags[t].at) : null);
  const one = (t, d = null) => all(t)?.[0] ?? d;
  const nodataStr = tags[42113] ? read(2, tags[42113].count, tags[42113].at) : null;
  const geo = all(34735);
  let pixelIsPoint = false;
  if (geo) for (let i = 4; i + 3 < geo.length; i += 4) if (geo[i] === 1025 && geo[i + 1] === 0) pixelIsPoint = geo[i + 3] === 2;
  const tiled = Boolean(tags[322]);
  const width = one(256), height = one(257);
  return {
    le,
    width, height,
    bits: one(258, 1), compression: one(259, 1), predictor: one(317, 1), sampleFormat: one(339, 1), samples: one(277, 1),
    blockW: tiled ? one(322) : width,
    blockH: tiled ? one(323) : one(278, height),
    offsets: tiled ? all(324) : all(273),
    counts: tiled ? all(325) : all(279),
    tiled,
    nodata: nodataStr !== null && nodataStr.trim() !== '' && Number.isFinite(Number(nodataStr)) ? Number(nodataStr) : null,
    scale: all(33550),
    tie: all(33922),
    pixelIsPoint,
  };
}

function inflate(raw, d, expected) {
  if (d.compression === 1) return Buffer.from(raw);
  if (d.compression === 5) return Buffer.from(lzwDecode(raw, expected));
  if (d.compression === 8 || d.compression === 32946) return inflateSync(raw);
  throw new Error(`unsupported compression ${d.compression}`);
}

/** One block (tile or strip) -> numbers, row-major, blockW x rows. */
function decodeBlock(raw, d, rows) {
  const bps = d.bits / 8, W = d.blockW, rowLen = W * bps;
  const bytes = inflate(raw, d, rowLen * rows);
  const out = new Float64Array(W * rows);
  if (d.predictor === 3) {
    // Floating point: per row, the bytes of all samples are split into planes
    // (most significant first) and differenced along the row.
    const tmp = new DataView(new ArrayBuffer(8));
    for (let y = 0; y < rows; y++) {
      const o = y * rowLen;
      for (let i = 1; i < rowLen; i++) bytes[o + i] = (bytes[o + i] + bytes[o + i - 1]) & 0xff;
      for (let x = 0; x < W; x++) {
        for (let b = 0; b < bps; b++) tmp.setUint8(b, bytes[o + b * W + x]);
        out[y * W + x] = bps === 4 ? tmp.getFloat32(0, false) : tmp.getFloat64(0, false);
      }
    }
    return out;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get = (o) => {
    if (d.sampleFormat === 3) return bps === 4 ? dv.getFloat32(o, d.le) : dv.getFloat64(o, d.le);
    if (d.sampleFormat === 2) return bps === 2 ? dv.getInt16(o, d.le) : dv.getInt32(o, d.le);
    return bps === 2 ? dv.getUint16(o, d.le) : bps === 4 ? dv.getUint32(o, d.le) : bytes[o];
  };
  for (let k = 0; k < W * rows; k++) out[k] = get(k * bps);
  if (d.predictor === 2) {
    if (d.sampleFormat === 3) throw new Error('horizontal predictor on floats is not supported');
    const mod = 2 ** d.bits;
    const signed = d.sampleFormat === 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 1; x < W; x++) {
        let v = (out[y * W + x] + out[y * W + x - 1]) % mod;
        if (v < 0) v += mod;
        if (signed && v >= mod / 2) v -= mod;
        out[y * W + x] = v;
      }
    }
  }
  return out;
}

export function readRaster(buf) {
  const d = ifd0(buf);
  if (d.samples !== 1) throw new Error(`${d.samples} bands; one expected`);
  if (![16, 32, 64].includes(d.bits)) throw new Error(`unsupported ${d.bits}-bit samples`);
  if (![1, 2, 3].includes(d.predictor)) throw new Error(`unsupported predictor ${d.predictor}`);
  if (!d.offsets || !d.counts) throw new Error('TIFF without block offsets');
  const W = d.width, H = d.height;
  const data = new Float32Array(W * H).fill(NaN);
  const across = Math.ceil(W / d.blockW);
  d.offsets.forEach((off, k) => {
    const bx = d.tiled ? k % across : 0, by = d.tiled ? Math.floor(k / across) : k;
    const x0 = bx * d.blockW, y0 = by * d.blockH;
    if (y0 >= H || !d.counts[k]) return;
    // A tile is always full size; the last strip may be shorter.
    const rows = d.tiled ? d.blockH : Math.min(d.blockH, H - y0);
    const block = decodeBlock(buf.subarray(off, off + d.counts[k]), d, rows);
    for (let y = 0; y < rows && y0 + y < H; y++) {
      for (let x = 0; x < d.blockW && x0 + x < W; x++) {
        const v = block[y * d.blockW + x];
        data[(y0 + y) * W + x0 + x] = v === d.nodata || !Number.isFinite(v) || v < -1000 || v > 9000 ? NaN : v;
      }
    }
  });
  return {
    width: W, height: H, data,
    scale: d.scale, tie: d.tie, pixelIsPoint: d.pixelIsPoint,
    info: `${d.tiled ? `tiles ${d.blockW}×${d.blockH}` : `strips of ${d.blockH} rows`}, ${d.bits}-bit ${d.sampleFormat === 3 ? 'float' : d.sampleFormat === 2 ? 'int' : 'uint'}, compression ${d.compression}, predictor ${d.predictor}, ${W}×${H}`,
  };
}
