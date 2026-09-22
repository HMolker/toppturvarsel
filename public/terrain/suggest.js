/**
 * A suggested way up, from start to goal, over the terrain grid.
 *
 * Least-cost path (A*) over the grid's nodes, eight neighbours each. The
 * cost of a step is the time it takes on skins (4 km/h on the flat, 400 m
 * of climb an hour, a little for going down), multiplied by how much
 * avalanche terrain the step is on:
 *
 *   ground under 25°  ×1        30–34°  ×4       40° and steeper  ×40
 *   25–29°            ×1.5      35–39°  ×12
 *   an NVE runout zone ×2 (Norway), a slope in today's problems ×3
 *
 * and a step steeper than a skin track holds (about 22°, a grade of 0.4)
 * costs ten times as much, so the path zig-zags instead. It avoids steep
 * ground where there is a reasonable way round, and crosses it where there
 * is not; it knows nothing about cornices, glaciers, cliffs smaller than a
 * grid cell, forest, water or snow cover. It is a suggestion to check
 * against the map, never a route to follow.
 */

const SQRT2 = Math.SQRT2;
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

export const PROFILES = {
  normal: { m25: 1.5, m30: 4, m35: 12, m40: 40, runout: 2, problem: 3 },
  cautious: { m25: 2, m30: 10, m35: 40, m40: 150, runout: 4, problem: 8 },
};

export function terrainFactor(s, p) {
  if (!Number.isFinite(s)) return 3; // unknown ground: discouraged, not forbidden
  if (s >= 40) return p.m40;
  if (s >= 35) return p.m35;
  if (s >= 30) return p.m30;
  if (s >= 25) return p.m25;
  return 1;
}

/** Hours for one step on skins: horizontal metres d, height change dz. */
export function stepHours(d, dz) {
  let h = d / 4000 + (dz > 0 ? dz / 400 : -dz / 3000);
  if (Math.abs(dz) / d > 0.4) h *= 10;
  return h;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * grid: { nx, ny, ele, slope, cellM } (Float32Arrays, NaN unknown), plus
 * optional runout and problem masks (Uint8Array, 1 = inside).
 * start, goal: [i, j] integer node indices.
 * Returns { path: [[i, j], ...], hours, expanded } or null if unreachable.
 */
export function suggestPath(grid, start, goal, { profile = 'normal', maxExpand = 400000 } = {}) {
  const { nx, ny, ele, slope, cellM } = grid;
  const P = PROFILES[profile] ?? PROFILES.normal;
  const N = nx * ny;
  const idx = (i, j) => j * nx + i;
  const s = idx(...start), g = idx(...goal);
  if (!Number.isFinite(ele[s]) || !Number.isFinite(ele[g])) return null;
  const gi = goal[0], gj = goal[1], gz = ele[g];

  const cost = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const h = (i, j, z) => (Math.hypot(i - gi, j - gj) * cellM) / 4000 + Math.max(0, gz - z) / 400;

  const factor = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let f = terrainFactor(slope[k], P);
    if (grid.runout?.[k]) f *= P.runout;
    if (grid.problem?.[k]) f *= P.problem;
    factor[k] = f;
  }

  const open = new Heap();
  cost[s] = 0;
  open.push(h(start[0], start[1], ele[s]), s);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === g) break;
    closed[cur] = 1;
    if (++expanded > maxExpand) return null;
    const ci = cur % nx, cj = (cur - ci) / nx, cz = ele[cur];
    for (const [di, dj, w] of NB) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = idx(ni, nj);
      if (closed[nk]) continue;
      const nz = ele[nk];
      if (!Number.isFinite(nz)) continue;
      const d = w * cellM;
      const c = cost[cur] + stepHours(d, nz - cz) * (factor[cur] + factor[nk]) / 2;
      if (c < cost[nk]) {
        cost[nk] = c;
        from[nk] = cur;
        open.push(c + h(ni, nj, nz), nk);
      }
    }
  }
  if (from[g] < 0 && s !== g) return null;
  const path = [];
  for (let k = g; k >= 0; k = from[k]) {
    path.push([k % nx, Math.floor(k / nx)]);
    if (k === s) break;
  }
  path.reverse();
  return { path, hours: cost[g], expanded };
}

/** Douglas–Peucker on grid coordinates, to turn a staircase into a line. */
export function simplify(points, tol = 0.8) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let m = -1, md = tol;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = points[k];
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L;
      if (d > md) { md = d; m = k; }
    }
    if (m >= 0) {
      keep[m] = 1;
      stack.push([a, m], [m, b]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

/** Nearest node with a known height, searching outward a few rings. */
export function snapNode(grid, fi, fj) {
  const i0 = Math.round(fi), j0 = Math.round(fj);
  for (let r = 0; r < 6; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        if (Number.isFinite(grid.ele[j * grid.nx + i])) return [i, j];
      }
    }
  }
  return null;
}
