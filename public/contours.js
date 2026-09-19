/**
 * Contour lines from a regular elevation grid (marching squares).
 * Pure functions, no DOM: the route map projects and draws the result,
 * and the tests run this file directly in Node.
 *
 * grid: { box:{north,south,west,east}, nx, ny, z:[row-major from NW, null = unknown] }
 */

export function contourInterval(min, max) {
  const relief = max - min;
  if (relief > 1200) return { step: 100, index: 500 };
  if (relief > 500) return { step: 50, index: 250 };
  return { step: 25, index: 100 };
}

/** -> [{ level, index, lines: [[{lat,lon}, ...], ...] }] */
export function contours(grid) {
  const { nx, ny, z, box } = grid;
  const at = (i, j) => z[j * nx + i];
  const vals = z.filter((v) => Number.isFinite(v));
  if (vals.length < 4) return [];
  const min = Math.min(...vals), max = Math.max(...vals);
  const { step, index } = contourInterval(min, max);

  const toGeo = (gi, gj) => ({
    lat: box.north - ((box.north - box.south) * gj) / (ny - 1),
    lon: box.west + ((box.east - box.west) * gi) / (nx - 1),
  });

  const out = [];
  for (let level = Math.ceil(min / step) * step; level <= max; level += step) {
    // Contour at a hair above the level, so a grid value exactly on the level
    // (common: DEM heights are rounded, levels are round numbers) never puts
    // a line through a vertex, which would split rings into fragments.
    const lv = level + 1e-6;
    const segs = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const tl = at(i, j), tr = at(i + 1, j), br = at(i + 1, j + 1), bl = at(i, j + 1);
        if (![tl, tr, br, bl].every(Number.isFinite)) continue;
        const code = (tl >= lv ? 8 : 0) | (tr >= lv ? 4 : 0) | (br >= lv ? 2 : 0) | (bl >= lv ? 1 : 0);
        if (code === 0 || code === 15) continue;

        const f = (a, b) => (lv - a) / (b - a || 1e-9);
        const T = [i + f(tl, tr), j];
        const R = [i + 1, j + f(tr, br)];
        const B = [i + f(bl, br), j + 1];
        const L = [i, j + f(tl, bl)];
        const centre = (tl + tr + br + bl) / 4 >= lv;

        const add = (a, b) => segs.push([a, b]);
        switch (code) {
          case 1: case 14: add(L, B); break;
          case 2: case 13: add(B, R); break;
          case 3: case 12: add(L, R); break;
          case 4: case 11: add(T, R); break;
          case 6: case 9: add(T, B); break;
          case 7: case 8: add(L, T); break;
          case 5: centre ? (add(L, T), add(B, R)) : (add(L, B), add(T, R)); break;
          case 10: centre ? (add(T, R), add(L, B)) : (add(L, T), add(B, R)); break;
        }
      }
    }
    const lines = chain(segs).map((line) => line.map(([gi, gj]) => toGeo(gi, gj)));
    if (lines.length) out.push({ level: Math.round(level), index: Math.round(level) % index === 0, lines });
  }
  return out;
}

/** Join segments that share endpoints into polylines. */
export function chain(segs) {
  const k = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  // A line passing within a hair of a grid vertex leaves a near-zero
  // segment there; its ends share a key, so it would fork the chain.
  segs = segs.filter(([a, b]) => k(a) !== k(b));
  const ends = new Map();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const key = k(p);
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push(idx);
    }
  });
  const used = new Array(segs.length).fill(false);
  const lines = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const line = [segs[s][0], segs[s][1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const tip = dir === 1 ? line[line.length - 1] : line[0];
        const next = (ends.get(k(tip)) ?? []).find((n) => !used[n]);
        if (next === undefined) break;
        used[next] = true;
        const [a, b] = segs[next];
        const far = k(a) === k(tip) ? b : a;
        dir === 1 ? line.push(far) : line.unshift(far);
      }
    }
    // Closed ring: make the ends identical, so smoothing treats it as a ring.
    if (line.length > 3 && k(line[0]) === k(line[line.length - 1])) line[line.length - 1] = line[0];
    lines.push(line);
  }
  return lines;
}

/** Chaikin corner-cutting, for drawing: grid contours are angular otherwise. */
export function smooth(pts, passes = 2) {
  let p = pts;
  for (let n = 0; n < passes && p.length > 2; n++) {
    const closed = p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1];
    const q = closed ? [] : [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    if (closed) q.push(q[0]);
    else q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}
