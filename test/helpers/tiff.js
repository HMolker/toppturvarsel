import { deflateSync } from 'node:zlib';

/* ---------- a small GeoTIFF writer ---------- */
export function writeTiff({ width, height, values, bits = 32, format = 3, compression = 8, predictor = 3, tile = null, rowsPerStrip = 7, le = true, scale = null, tie = null, nodata = null }) {
  const bps = bits / 8;
  const encodeRows = (rows, W) => {
    // rows: array of arrays of numbers, W wide
    const buf = Buffer.alloc(rows.length * W * bps);
    const dv = new DataView(buf.buffer);
    rows.forEach((row, y) => {
      if (predictor === 3) {
        const be = Buffer.alloc(W * bps), bdv = new DataView(be.buffer);
        row.forEach((v, x) => (bps === 4 ? bdv.setFloat32(x * 4, v, false) : bdv.setFloat64(x * 8, v, false)));
        // planes, most significant byte first, then differenced
        const planes = Buffer.alloc(W * bps);
        for (let x = 0; x < W; x++) for (let b = 0; b < bps; b++) planes[b * W + x] = be[x * bps + b];
        for (let i = planes.length - 1; i > 0; i--) planes[i] = (planes[i] - planes[i - 1]) & 0xff;
        planes.copy(buf, y * W * bps);
      } else {
        const vals = predictor === 2 ? row.map((v, x) => (x ? v - row[x - 1] : v)) : row;
        vals.forEach((v, x) => {
          const o = (y * W + x) * bps;
          if (format === 3) dv.setFloat32(o, v, le);
          else if (bits === 16) format === 2 ? dv.setInt16(o, v, le) : dv.setUint16(o, ((v % 65536) + 65536) % 65536, le);
          else dv.setInt32(o, v, le);
        });
      }
    });
    return compression === 8 ? deflateSync(buf) : buf;
  };
  const blocks = [];
  if (tile) {
    for (let ty = 0; ty < Math.ceil(height / tile); ty++) for (let tx = 0; tx < Math.ceil(width / tile); tx++) {
      const rows = [];
      for (let y = 0; y < tile; y++) {
        const row = [];
        for (let x = 0; x < tile; x++) { const gx = tx * tile + x, gy = ty * tile + y; row.push(gx < width && gy < height ? values(gx, gy) : 0); }
        rows.push(row);
      }
      blocks.push(encodeRows(rows, tile));
    }
  } else {
    for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
      const rows = [];
      for (let y = y0; y < Math.min(height, y0 + rowsPerStrip); y++) rows.push(Array.from({ length: width }, (_, x) => values(x, y)));
      blocks.push(encodeRows(rows, width));
    }
  }
  // Layout: header, then blocks, then extra arrays, then the IFD.
  const entries = [];
  const extra = [];
  let pos = 8 + blocks.reduce((a, b) => a + b.length, 0);
  const offsets = [];
  { let o = 8; for (const b of blocks) { offsets.push(o); o += b.length; } }
  const arr = (type, list) => {
    const size = { 3: 2, 4: 4, 12: 8, 2: 1 }[type];
    const buf = Buffer.alloc(size * list.length);
    list.forEach((v, i) => (type === 3 ? (le ? buf.writeUInt16LE(v, i * 2) : buf.writeUInt16BE(v, i * 2)) : type === 4 ? (le ? buf.writeUInt32LE(v, i * 4) : buf.writeUInt32BE(v, i * 4)) : type === 12 ? (le ? buf.writeDoubleLE(v, i * 8) : buf.writeDoubleBE(v, i * 8)) : (buf[i] = v)));
    return buf;
  };
  const tag = (id, type, list) => {
    const data = type === 2 ? Buffer.from(`${list}\0`, 'latin1') : arr(type, list);
    const count = type === 2 ? data.length : list.length;
    if (data.length <= 4) entries.push({ id, type, count, inline: data });
    else { entries.push({ id, type, count, off: pos }); extra.push(data); pos += data.length + (data.length % 2); if (data.length % 2) extra.push(Buffer.alloc(1)); }
  };
  tag(256, 4, [width]); tag(257, 4, [height]); tag(258, 3, [bits]); tag(259, 3, [compression]); tag(277, 3, [1]); tag(284, 3, [1]); tag(317, 3, [predictor]); tag(339, 3, [format]);
  if (tile) { tag(322, 3, [tile]); tag(323, 3, [tile]); tag(324, 4, offsets); tag(325, 4, blocks.map((b) => b.length)); }
  else { tag(273, 4, offsets); tag(278, 3, [rowsPerStrip]); tag(279, 4, blocks.map((b) => b.length)); }
  if (scale) tag(33550, 12, scale);
  if (tie) tag(33922, 12, tie);
  if (nodata !== null) tag(42113, 2, String(nodata));
  entries.sort((a, b) => a.id - b.id);
  const ifdAt = pos;
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  const w16 = (b, v, o) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b, v, o) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  w16(ifd, entries.length, 0);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    w16(ifd, e.id, o); w16(ifd, e.type, o + 2); w32(ifd, e.count, o + 4);
    if (e.inline) e.inline.copy(ifd, o + 8); else w32(ifd, e.off, o + 8);
  });
  const head = Buffer.alloc(8);
  head.write(le ? 'II' : 'MM', 0, 'latin1'); w16(head, 42, 2); w32(head, ifdAt, 4);
  return Buffer.concat([head, ...blocks, ...extra, ifd]);
}

