/**
 * A whole tour (v5.4): a start, one or more descents you draw, and the legs
 * between them found here.
 *
 *   start → top of descent 1, bottom of descent 1 → top of descent 2, …,
 *   bottom of the last descent → start
 *
 * Each leg is the quickest way by the Munter method that keeps off
 * avalanche terrain as far as the terrain allows. Pure functions, so the
 * page and the tests share them.
 *
 * Munter: one unit is 1 km of distance or 100 m of height difference.
 * Skinning (and flat travel) goes at 4 units an hour, skiing downhill at 10.
 */

import { problemAspects, problemBands } from '../planner.js';
import { OCT8 } from './analysis.js';

export const MUNTER = { up: 4, ski: 10 };

/** Hours for a stretch of `dd` metres along the ground with height change `dz`. */
export function munterHours(dd, dz) {
  if (dz < -0.05 * dd) return (dd / 1000 + -dz / 100) / MUNTER.ski; // skiing down
  return (dd / 1000 + Math.max(0, dz) / 100) / MUNTER.up; // skinning, or flat
}

const octantOf = (deg) => (Number.isFinite(deg) ? OCT8[Math.round(deg / 45) % 8] : null);

/**
 * What a step onto a node costs on top of its Munter time, going up and
 * going down. Danger 1: problems and runout zones are not considered, but
 * skinning keeps off 35°+ (it cannot be skinned) and nothing goes onto 45°+.
 * Danger 2: steep ground, today's problem slopes and runout zones cost
 * extra. Danger 3 and up: they cost much more. No bulletin: as danger 2,
 * without problems to test.
 */
export function hazardFactors({ slope, aspect, ele, runout = null, problems = [], danger = null }) {
  const N = slope.length;
  const up = new Float32Array(N), down = new Float32Array(N);
  const probs = (problems ?? []).map((p) => ({ aspects: new Set(problemAspects(p.aspects)), bands: problemBands(p.heights) }));
  const low = danger === 1;
  const hi = Number.isFinite(danger) && danger >= 3;
  for (let k = 0; k < N; k++) {
    const s = slope[k];
    if (!Number.isFinite(s)) { up[k] = down[k] = 5; continue; }
    if (low) {
      up[k] = s >= 40 ? 40 : s >= 35 ? 12 : 1;
      down[k] = s >= 45 ? 40 : 1;
      continue;
    }
    let f = s >= 40 ? 40 : s >= 35 ? 12 : s >= 30 ? 4 : s >= 25 ? 1.5 : 1;
    if (hi) f = f * f > 1 ? Math.min(400, f * f) : f;
    const o = octantOf(aspect[k]);
    if (probs.length && s >= 25 && o && probs.some((p) => p.aspects.has(o) && p.bands.some(([lo, h]) => ele[k] >= lo && ele[k] <= h))) f *= hi ? 20 : 8;
    if (runout?.[k]) f *= hi ? 6 : 3;
    up[k] = down[k] = f;
  }
  return { up, down };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) m = r;
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * The quickest way between two grid nodes by Munter time, each step
 * weighted by the hazard of the node it enters (up or down). A skin track
 * steeper than about 22° (grade 0.4) costs ten times as much, so the path
 * zig-zags. Returns { path: [[i, j]], hours } or null.
 */
export function legPath(grid, factors, start, goal, { maxExpand = 2e6 } = {}) {
  const { nx, ny, ele, cellM } = grid;
  const N = nx * ny;
  const s = start[1] * nx + start[0], g = goal[1] * nx + goal[0];
  if (!Number.isFinite(ele[s]) || !Number.isFinite(ele[g])) return null;
  const gi = goal[0], gj = goal[1], gz = ele[g];
  const cost = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  // Admissible: the straight line at skiing speed, the net climb at skinning speed.
  const h = (i, j, z) => (Math.hypot(i - gi, j - gj) * cellM) / 1000 / MUNTER.ski + Math.max(0, gz - z) / 100 / MUNTER.up;
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
      const nk = nj * nx + ni;
      if (closed[nk]) continue;
      const nz = ele[nk];
      if (!Number.isFinite(nz)) continue;
      const d = w * cellM, dz = nz - cz;
      let t = munterHours(d, dz);
      if (dz > 0.4 * d) t *= 10; // too steep to skin straight up
      t *= dz < -0.05 * d ? factors.down[nk] : factors.up[nk];
      const c = cost[cur] + t;
      if (c < cost[nk]) {
        cost[nk] = c;
        from[nk] = cur;
        open.push(c + h(ni, nj, nz), nk);
      }
    }
  }
  if (s !== g && from[g] < 0) return null;
  const path = [];
  for (let k = g; k >= 0; k = from[k]) {
    path.push([k % nx, Math.floor(k / nx)]);
    if (k === s) break;
  }
  return { path: path.reverse(), hours: cost[g] };
}

/**
 * The legs a tour needs: [{ from, to, label, before }], where `before` is
 * the descent the leg leads to, or -1 for the way back to the start. A leg
 * shorter than ~30 m (a descent ending where the next begins) is left out.
 */
export function tourLegs(start, descents, names = descents.map((_, k) => `Descent ${k + 1}`)) {
  const legs = [];
  const near = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180)) < 30;
  let at = start;
  descents.forEach((d, k) => {
    if (!near(at, d[0])) legs.push({ from: at, to: d[0], label: k === 0 ? `Up to ${names[k].toLowerCase()}` : `To ${names[k].toLowerCase()}`, before: k });
    at = d[d.length - 1];
  });
  if (!near(at, start)) legs.push({ from: at, to: start, label: 'Back to the start', before: -1 });
  return legs;
}

/**
 * The tour as one line, and which vertices belong to which part:
 * [{ kind: 'leg' | 'descent', label, v0, v1 }]. `legs` are tourLegs() with
 * `points` ([[lat, lon], ...], from its `from` to its `to`) filled in.
 */
export function assembleTour(start, descents, legs, names = descents.map((_, k) => `Descent ${k + 1}`)) {
  const pts = [start.slice()];
  const parts = [];
  const add = (list, kind, label) => {
    const v0 = pts.length - 1;
    for (const p of list.slice(1)) pts.push(p.slice());
    parts.push({ kind, label, v0, v1: pts.length - 1 });
  };
  descents.forEach((d, k) => {
    const leg = legs.find((l) => l.before === k);
    if (leg?.points?.length >= 2) add(leg.points, 'leg', leg.label);
    add(d, 'descent', names[k]);
  });
  const back = legs.find((l) => l.before === -1);
  if (back?.points?.length >= 2) add(back.points, 'leg', back.label);
  return { points: pts, parts };
}

/**
 * Numbers per part and in total, from the measured profile. Samples carry
 * `v` at the tour's own vertices, which is how parts are found in them.
 */
export function tourNumbers(profile, parts) {
  const S = profile?.samples ?? [];
  const at = new Map(S.map((s, i) => (s.v !== undefined ? [s.v, i] : null)).filter(Boolean));
  const rows = parts.map((p) => {
    const i0 = at.get(p.v0), i1 = at.get(p.v1);
    let dist = 0, up = 0, down = 0, hours = 0;
    if (i0 !== undefined && i1 !== undefined) {
      for (let i = i0 + 1; i <= i1; i++) {
        const dd = S[i].d - S[i - 1].d;
        const dz = Number.isFinite(S[i].ele) && Number.isFinite(S[i - 1].ele) ? S[i].ele - S[i - 1].ele : 0;
        dist += dd;
        if (dz > 0) up += dz;
        else down -= dz;
        hours += munterHours(dd, dz);
      }
    }
    return { ...p, d0: S[i0]?.d ?? null, d1: S[i1]?.d ?? null, distanceM: Math.round(dist), climbM: Math.round(up), descentM: Math.round(down), hours };
  });
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    rows,
    total: {
      distanceM: sum((r) => r.distanceM),
      climbM: sum((r) => r.climbM),
      skiedM: sum((r) => (r.kind === 'descent' ? r.descentM : 0)),
      hours: sum((r) => r.hours),
    },
  };
}

/** Where the analysis's red and blue stretches fall inside each part. */
export function partWarnings(parts, analysis) {
  if (!analysis) return parts.map(() => ({ problemM: 0, runoutM: 0 }));
  const overlap = (a0, a1, list) => list.reduce((m, s) => m + Math.max(0, Math.min(a1, s.d1) - Math.max(a0, s.d0)), 0);
  return parts.map((p) => ({
    problemM: p.d0 === null ? 0 : Math.round(overlap(p.d0, p.d1, analysis.problemSections ?? [])),
    runoutM: p.d0 === null ? 0 : Math.round(overlap(p.d0, p.d1, analysis.runoutSections ?? [])),
  }));
}
