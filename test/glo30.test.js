import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * Copernicus GLO-30 read from its open files (v5.6.2): a small GeoTIFF made
 * here in the same layout (tiled float32, an overview, the GeoTIFF placement
 * tags), served with range requests; LZW and DEFLATE; the height chain puts
 * it before Open-Meteo and charges no budget for it.
 */

const tmp = await mkdtemp(path.join(tmpdir(), 'ttv-glo30-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'error';
delete process.env.LANTMATERIET_USER;
delete process.env.LANTMATERIET_PASSWORD;
await mkdir(path.join(tmp, 'cache'), { recursive: true });

const { lzwDecode, parseTiff } = await import('../src/sources/lmcog.js');

// ---- a TIFF LZW encoder, as libtiff's (MSB-first, early change), for the round trip ----
function lzwEncode(data) {
  const out = [];
  let acc = 0, nbits = 0;
  const put = (code, width) => {
    acc = (acc << width) | code;
    nbits += width;
    while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; }
    acc &= (1 << nbits) - 1;
  };
  let dict = new Map(), next = 258, width = 9;
  const grow = () => {
    if (next === 4094) { put(256, width); dict = new Map(); next = 258; width = 9; }
    else if (next > (1 << width) - 1) width++;
  };
  put(256, width);
  let w = data[0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const key = w * 256 + c;
    if (dict.has(key)) { w = dict.get(key); continue; }
    put(w, width);
    dict.set(key, next++);
    grow();
    w = c;
  }
  put(w, width);
  next++;
  grow();
  put(257, width);
  if (nbits) out.push((acc << (8 - nbits)) & 0xff);
  return Buffer.from(out);
}

test('LZW: what goes in comes out', () => {
  const data = Buffer.alloc(20000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 5)) % 251 === 0 ? 3 : (i % 13) * 9;
  assert.deepEqual(Buffer.from(lzwDecode(lzwEncode(data), data.length)), data);
});

test('LZW: a strip written by libtiff decodes to what was written', async () => {
  const { readFile } = await import('node:fs/promises');
  // Made with Pillow/libtiff: 64 × 64 float32, a[j][i] = (64 j + i) · 0.37 + i mod 7.
  const enc = await readFile(new URL('./fixtures/lzw-libtiff.bin', import.meta.url));
  const want = new Float32Array(64 * 64);
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) want[j * 64 + i] = Math.fround(Math.fround((64 * j + i) * 0.37) + (i % 7));
  const got = new Float32Array(new Uint8Array(lzwDecode(enc, want.length * 4)).buffer);
  let bad = 0;
  for (let k = 0; k < want.length; k++) if (Math.abs(got[k] - want[k]) > 1e-3) bad++;
  assert.equal(bad, 0);
});

// ---- a GLO-30-like file for 61-62 N, 12-13 E ----
const h = (lat, lon) => 500 + 1000 * (lat - 61) + 100 * (lon - 12); // linear: bilinear is exact
const W = 90, H = 180, T = 32, SX = 1 / 90, SY = 1 / 180;

function makeTiff(compression) {
  const levels = [{ w: W, h: H, f: 1 }, { w: W / 2, h: H / 2, f: 2 }];
  const chunks = [];
  let pos = 8;
  const add = (b) => { const at = pos; chunks.push(b); pos += b.length; return at; };
  const ifdInfo = levels.map(({ w, h: hh, f }) => {
    const across = Math.ceil(w / T), down = Math.ceil(hh / T);
    const offsets = [], counts = [];
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const a = new Float32Array(T * T).fill(-32767);
        for (let j = 0; j < T; j++) {
          for (let i = 0; i < T; i++) {
            const px = tx * T + i, py = ty * T + j;
            if (px >= w || py >= hh) continue;
            a[j * T + i] = h(62 - (py + 0.5) * SY * f, 12 + (px + 0.5) * SX * f);
          }
        }
        const raw = Buffer.from(a.buffer);
        const c = compression === 5 ? lzwEncode(raw) : deflateSync(raw);
        offsets.push(add(c));
        counts.push(c.length);
      }
    }
    return { w, hh, offsets, counts, overview: f > 1 };
  });
  // IFDs after the data (a COG puts them first; the reader does not mind, the fixture keeps it simple).
  const entries = (d) => {
    const e = [
      [254, 4, 1, d.overview ? 1 : 0], [256, 4, 1, d.w], [257, 4, 1, d.hh], [258, 3, 1, 32], [259, 3, 1, compression], [277, 3, 1, 1],
      [317, 3, 1, 1], [322, 3, 1, T], [323, 3, 1, T], [324, 4, d.offsets.length, d.offsets], [325, 4, d.counts.length, d.counts], [339, 3, 1, 3],
    ];
    if (!d.overview) {
      e.push([33550, 12, 3, [SX, SY, 0]], [33922, 12, 6, [0, 0, 0, 12, 62, 0]], [34735, 3, 8, [1, 1, 0, 1, 1025, 0, 1, 1]], [42113, 2, 7, '-32767']);
    }
    return e;
  };
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifdBufs = [];
  let ifdPos = pos;
  const firstIfd = ifdPos;
  ifdInfo.forEach((d, n) => {
    const es = entries(d);
    const extra = [];
    let extraPos = ifdPos + 2 + es.length * 12 + 4;
    const b = Buffer.alloc(2 + es.length * 12 + 4);
    b.writeUInt16LE(es.length, 0);
    es.forEach(([tag, type, count, val], k) => {
      const o = 2 + k * 12;
      b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
      const vals = Array.isArray(val) ? val : type === 2 ? null : [val];
      const bytes = size[type] * count;
      const vb = Buffer.alloc(Math.max(4, bytes));
      if (type === 2) vb.write(`${val}\0`, 0, 'latin1');
      else vals.forEach((v, i) => (type === 3 ? vb.writeUInt16LE(v, i * 2) : type === 4 ? vb.writeUInt32LE(v, i * 4) : vb.writeDoubleLE(v, i * 8)));
      if (bytes <= 4) vb.copy(b, o + 8, 0, 4);
      else { b.writeUInt32LE(extraPos, o + 8); extra.push(vb.subarray(0, bytes)); extraPos += bytes; }
    });
    const len = b.length + extra.reduce((a, x) => a + x.length, 0);
    const nextIfd = n < ifdInfo.length - 1 ? ifdPos + len : 0;
    b.writeUInt32LE(nextIfd, 2 + es.length * 12);
    ifdBufs.push(b, ...extra);
    ifdPos += len;
  });
  const head = Buffer.alloc(8);
  head.write('II', 0, 'latin1'); head.writeUInt16LE(42, 2); head.writeUInt32LE(firstIfd, 4);
  return Buffer.concat([head, ...chunks, ...ifdBufs]);
}

let file = makeTiff(8);
const calls = { glo: 0, om: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('copernicus-dem-30m')) {
    calls.glo++;
    if (!u.includes('N61_00_E012_00')) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range ?? '') ?? [];
    const slice = file.subarray(+a, Math.min(file.length, +b + 1));
    return new Response(slice, { status: 206 });
  }
  if (u.includes('/v1/elevation')) {
    calls.om++;
    const lats = new URL(u).searchParams.get('latitude').split(',');
    return new Response(JSON.stringify({ elevation: lats.map(() => 7) }), { status: 200 });
  }
  return realFetch(url, opts);
};

const glo = await import('../src/sources/glo30.js');
const { bestElevations } = await import('../src/sources/elevation.js');

test('the file names its square by the south-west corner', () => {
  assert.equal(glo.glo30Name(61.92, 12.87).id, 'Copernicus_DSM_COG_10_N61_00_E012_00_DEM');
  assert.equal(glo.glo30Name(69.1, 20.9).id, 'Copernicus_DSM_COG_10_N69_00_E020_00_DEM');
  const t = parseTiff(file);
  assert.deepEqual(t.ifds[0].scale.slice(0, 2), [SX, SY]);
  assert.equal(t.ifds[0].pixelIsPoint, false);
});

test('heights from the file, a coarser overview for sparse points, kept on disk', async () => {
  for (const comp of [8, 5]) {
    file = makeTiff(comp);
    glo._resetGlo30();
    const { rm } = await import('node:fs/promises');
    await rm(path.join(tmp, 'cache', 'glo30'), { recursive: true, force: true });
    const pts = [{ lat: 61.5, lon: 12.5 }, { lat: 61.123, lon: 12.777 }, { lat: 61.9, lon: 12.05 }];
    const fine = await glo.glo30Elevations(pts, { spacingM: 30 });
    pts.forEach((p, i) => assert.ok(Math.abs(fine[i] - h(p.lat, p.lon)) < 0.05, `compression ${comp}: ${fine[i]} vs ${h(p.lat, p.lon)}`));
    const coarse = await glo.glo30Elevations(pts, { spacingM: 5000 });
    pts.forEach((p, i) => assert.ok(Math.abs(coarse[i] - h(p.lat, p.lon)) < 0.05, 'the overview agrees'));
    const n = calls.glo;
    glo._resetGlo30();
    await glo.glo30Elevations(pts, { spacingM: 30 });
    assert.equal(calls.glo, n, 'answered from the files on disk');
  }
});

test('in the height chain: before Open-Meteo, no budget; open sea falls through', async () => {
  glo._resetGlo30();
  const om = calls.om;
  const r = await bestElevations([{ lat: 61.5, lon: 12.5 }, { lat: 61.6, lon: 12.2 }], 'SE', { spacingM: 30 });
  assert.equal(r.source, 'copernicus-glo30');
  assert.equal(r.charged, 0);
  assert.equal(calls.om, om, 'Open-Meteo not asked');
  const sea = await bestElevations([{ lat: 57.5, lon: 3.5 }], 'SE');
  assert.equal(sea.values[0], 7, 'no GLO-30 file there: Open-Meteo');
  assert.equal(sea.charged, 1);
});

test('the store unreachable: Open-Meteo, and GLO-30 rested', async () => {
  glo._resetGlo30();
  const { rm } = await import('node:fs/promises');
  await rm(path.join(tmp, 'cache', 'glo30'), { recursive: true, force: true });
  const saved = file;
  file = Buffer.from('not a tiff at all');
  const r = await bestElevations([{ lat: 61.5, lon: 12.5 }], 'SE');
  assert.equal(r.values[0], 7);
  assert.equal(glo.glo30Usable(), false);
  assert.match(glo.glo30Status().lastError, /TIFF/);
  file = saved;
  glo._resetGlo30();
});
