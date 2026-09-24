/**
 * Find runs (v5.7): mark an area, get the best descents in it for the
 * settings — angle band, a target average angle, today's avalanche
 * problems, convex rolls, runout zones, terrain traps, narrow lines,
 * cornices — spread over the area and over aspects.
 *
 * How: a descent always goes downhill, so the grid is a one-way network from
 * high to low. Walking the cells from the highest down, each cell keeps the
 * best-scoring run that reaches it (dynamic programming, one pass). A step
 * scores its length, less the further its angle is from the target average,
 * less what the settings ask to avoid. The best end cell gives the run; its
 * surroundings (of the same aspect) are then set aside and the next run is
 * found, and so on. Where a run's slope drops under the minimum, a run-out
 * on gentler ground is added (not counted in its angles).
 *
 * Pure: a grid in, runs out. The page draws them and makes them descents.
 */

import { OCT8 } from './analysis.js';

export const RUN_DEFAULTS = {
  count: 4,
  minSlope: 15,
  maxSlope: 35,
  targetAvg: 28,
  hazardMax: 25, // on today's problem aspects and heights
  runoutM: 200,
  minVerticalM: 150,
  separationM: 500,
  aspectDiff: 30,
  traverseDeg: 50, // how far off the fall line a step may go
  avoidConvex: true,
  avoidRunoutZones: true,
  avoidTraps: true,
  avoidNarrow: true,
  minWidthM: 40,
  corniceM: 40,
};

/** Rider skill: the angles that suit, as starting points for the settings. */
export const SKILL_PRESETS = {
  easy: { label: 'Easy', minSlope: 12, maxSlope: 30, targetAvg: 22 },
  intermediate: { label: 'Intermediate', minSlope: 15, maxSlope: 35, targetAvg: 28 },
  advanced: { label: 'Advanced', minSlope: 18, maxSlope: 40, targetAvg: 32 },
  expert: { label: 'Expert', minSlope: 20, maxSlope: 44, targetAvg: 36 },
};

const R = Math.PI / 180;
const CLIFF = 45; // never skied, and not next to it either
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export const octantOf = (deg) => (Number.isFinite(deg) ? OCT8[Math.round(deg / 45) % 8] : null);

/** Circular mean of compass directions, weighted. */
function meanAspect(list) {
  let sx = 0, sy = 0;
  for (const [a, w] of list) { sx += Math.sin(a * R) * w; sy += Math.cos(a * R) * w; }
  if (!sx && !sy) return null;
  return ((Math.atan2(sx, sy) / R) + 360) % 360;
}
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * What the settings and the day say about each cell. `hazard(k)`: the cell
 * faces a problem aspect at a problem height today. `windLee(k)`: the same
 * for a wind-slab problem (cornices). `slabDay`: danger 2+ with a slab problem,
 * the day convex rolls matter.
 */
export function cellRules(grid, { slope, aspect, runout = null, hazard = () => false, windLee = () => false, slabDay = false }, set = RUN_DEFAULTS) {
  const { nx, ny, ele, cellM } = grid;
  const N = nx * ny;
  const cap = new Float32Array(N);
  const blocked = new Uint8Array(N);
  const flags = new Uint8Array(N); // 1 convex, 2 runout zone, 4 trap, 8 narrow, 16 capped by the day
  const at = (arr, fi, fj) => {
    const i = Math.round(fi), j = Math.round(fj);
    return i < 0 || j < 0 || i >= nx || j >= ny ? NaN : arr[j * nx + i];
  };
  // Crests: a cell not lower than the ground a step uphill of it (along its own aspect).
  const crest = new Uint8Array(N);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, a = aspect[k];
      if (!Number.isFinite(ele[k])) { blocked[k] = 1; continue; }
      if (!Number.isFinite(a)) continue;
      const up = at(ele, i - Math.sin(a * R), j + Math.cos(a * R));
      if (Number.isFinite(up) && up <= ele[k] + 0.3) crest[k] = 1;
    }
  }
  const dStep = Math.max(1, Math.round(30 / cellM)); // ~30 m for curvature
  const wStep = Math.max(1, Math.round(set.minWidthM / 2 / cellM));
  const trapStep = Math.max(1, Math.round(40 / cellM));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const s = slope[k], a = aspect[k];
      if (!Number.isFinite(s)) { blocked[k] = 1; continue; }
      // Cliffs, and the cells next to them.
      let cliff = s >= CLIFF;
      for (const [di, dj] of NB) if (at(slope, i + di, j + dj) >= CLIFF + 5) cliff = true;
      if (cliff) { blocked[k] = 1; continue; }
      cap[k] = set.maxSlope;
      if (hazard(k)) { cap[k] = Math.min(set.maxSlope, set.hazardMax); flags[k] |= 16; }
      if (!Number.isFinite(a)) continue;
      const dx = Math.sin(a * R), dy = -Math.cos(a * R); // downhill, in grid steps
      // Convex roll: steeper below than above, along the fall line.
      if (slabDay && set.avoidConvex && s >= 25) {
        const below = at(slope, i + dx * dStep, j + dy * dStep), above = at(slope, i - dx * dStep, j - dy * dStep);
        const per100 = ((below - above) / (2 * dStep * cellM)) * 100;
        if (per100 >= 20) flags[k] |= 1;
      }
      if (runout?.[k] && set.avoidRunoutZones) flags[k] |= 2;
      // Across the slope: both sides rising (a gully: a terrain trap), or the
      // skiable width narrower than the minimum.
      const px = -dy, py = dx; // across
      const l1 = at(ele, i + px * trapStep, j + py * trapStep), r1 = at(ele, i - px * trapStep, j - py * trapStep);
      if (set.avoidTraps && l1 - ele[k] > 6 && r1 - ele[k] > 6) flags[k] |= 4;
      if (set.avoidNarrow && s >= set.minSlope) {
        const ls = at(slope, i + px * wStep, j + py * wStep), rs = at(slope, i - px * wStep, j - py * wStep);
        if (ls > cap[k] + 5 || rs > cap[k] + 5 || ls >= CLIFF || rs >= CLIFF) flags[k] |= 8;
      }
      // Below a crest on a lee slope of today's wind slab: keep off the cornice.
      if (set.corniceM > 0 && windLee(k)) {
        const steps = Math.ceil(set.corniceM / cellM);
        for (let t = 1; t <= steps; t++) {
          const ci = Math.round(i - dx * t), cj = Math.round(j - dy * t);
          if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) break;
          if (crest[cj * nx + ci]) { blocked[k] = 1; break; }
        }
      }
    }
  }
  return { cap, blocked, flags };
}

const PENALTY = { 1: 0.9, 2: 1.2, 4: 0.6, 8: 0.5 }; // per metre, subtracted from the metre's score

function stepGain(s, d, set, flag) {
  // Every metre in the band counts (runs go on down to the minimum angle);
  // metres near the target average count most, so it steers the line.
  const off = (s - set.targetAvg) / 7;
  let g = d * Math.max(0.1, 1 - 0.6 * off * off);
  for (const [bit, p] of Object.entries(PENALTY)) if (flag & +bit) g -= d * p;
  return g;
}

/**
 * The runs: [{ cells, runout, points: [[lat, lon]], stats }], best first.
 * grid: { nx, ny, ele, cellM, toLatLon(i, j) }.
 */
export function findRuns(grid, terrain, settings = {}) {
  const set = { ...RUN_DEFAULTS, ...settings };
  const { nx, ny, ele, cellM } = grid;
  const { slope, aspect } = terrain;
  const N = nx * ny;
  const rules = cellRules(grid, terrain, set);
  const { cap, blocked, flags } = rules;
  const valid = (k, excluded) => !blocked[k] && !excluded[k] && slope[k] >= set.minSlope && slope[k] <= cap[k];

  const order = [];
  for (let k = 0; k < N; k++) if (Number.isFinite(ele[k])) order.push(k);
  order.sort((a, b) => ele[b] - ele[a]);

  const excluded = new Uint8Array(N);
  const best = new Float64Array(N), from = new Int32Array(N), start = new Int32Array(N);
  const cosT = Math.cos(set.traverseDeg * R);
  const runs = [];

  for (let r = 0; r < set.count; r++) {
    best.fill(-Infinity);
    from.fill(-1);
    for (const k of order) {
      if (!valid(k, excluded)) continue;
      // A run may start here: when nothing reaches it, or what reaches it scores below nothing.
      if (!(best[k] > 0)) { best[k] = 0; start[k] = k; from[k] = -1; }
      const i = k % nx, j = (k - i) / nx, a = aspect[k];
      if (!Number.isFinite(a)) continue;
      const fx = Math.sin(a * R), fy = -Math.cos(a * R);
      for (const [di, dj] of NB) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const n = nj * nx + ni;
        if (!(ele[n] < ele[k]) || !valid(n, excluded)) continue;
        const len = Math.hypot(di, dj);
        if ((di * fx + dj * fy) / len < cosT) continue; // too far off the fall line
        const d = len * cellM;
        const g = best[k] + stepGain(slope[n], Math.hypot(d, ele[k] - ele[n]), set, flags[n]);
        if (g > best[n]) { best[n] = g; from[n] = k; start[n] = start[k]; }
      }
    }
    // The best end with enough vertical.
    let end = -1;
    for (let k = 0; k < N; k++) {
      if (!(best[k] > 0) || from[k] < 0) continue;
      if (ele[start[k]] - ele[k] < set.minVerticalM) continue;
      if (end < 0 || best[k] > best[end]) end = k;
    }
    if (end < 0) break;
    const cells = [];
    for (let k = end; k >= 0; k = from[k]) { cells.push(k); if (k === start[end]) break; }
    cells.reverse();
    const runout = runOut(grid, slope, blocked, end, set);
    const run = describe(grid, terrain, rules, cells, runout, set);
    run.score = best[end];
    runs.push(run);
    setAside(grid, aspect, excluded, [...cells, ...runout], run.stats.aspect, set);
  }
  return runs;
}

/** On from the end: the gentlest way down, while it stays under the minimum angle. */
function runOut(grid, slope, blocked, end, set) {
  const { nx, ny, ele, cellM } = grid;
  const out = [];
  let k = end, dist = 0;
  const seen = new Set([end]);
  while (dist < set.runoutM) {
    const i = k % nx, j = (k - i) / nx;
    let next = -1;
    for (const [di, dj] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const n = nj * nx + ni;
      if (seen.has(n) || blocked[n] || !(ele[n] < ele[k])) continue;
      if (next < 0 || ele[n] < ele[next]) next = n;
    }
    if (next < 0 || !(slope[next] < set.minSlope) || slope[next] < 1.5) break;
    const ni = next % nx, nj = (next - ni) / nx;
    dist += Math.hypot(ni - i, nj - j) * cellM;
    seen.add(next);
    out.push(next);
    k = next;
  }
  return out;
}

/** Set aside the ground near a found run that faces the same way. */
function setAside(grid, aspect, excluded, cells, runAspect, set) {
  const { nx, ny, cellM } = grid;
  const rad = Math.ceil(set.separationM / cellM);
  const own = Math.ceil(60 / cellM); // never overlap, whatever the aspect
  for (let c = 0; c < cells.length; c += 2) {
    const ci = cells[c] % nx, cj = (cells[c] - ci) / nx;
    for (let dj = -rad; dj <= rad; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= ny) continue;
      for (let di = -rad; di <= rad; di++) {
        const i = ci + di;
        if (i < 0 || i >= nx) continue;
        const r2 = di * di + dj * dj;
        if (r2 > rad * rad) continue;
        const k = j * nx + i;
        if (r2 <= own * own) { excluded[k] = 1; continue; }
        const a = aspect[k];
        if (runAspect === null || !Number.isFinite(a) || angleDiff(a, runAspect) < set.aspectDiff) excluded[k] = 1;
      }
    }
  }
}

function describe(grid, { slope, aspect }, { flags }, cells, runout, set) {
  const { nx, ele, cellM } = grid;
  let lengthM = 0, sw = 0, maxS = 0;
  const asp = [];
  const flagM = { convex: 0, runoutZone: 0, trap: 0, narrow: 0, capped: 0 };
  for (let c = 1; c < cells.length; c++) {
    const a = cells[c - 1], b = cells[c];
    const ai = a % nx, aj = (a - ai) / nx, bi = b % nx, bj = (b - bi) / nx;
    const d = Math.hypot(Math.hypot(bi - ai, bj - aj) * cellM, ele[a] - ele[b]);
    lengthM += d;
    sw += slope[b] * d;
    maxS = Math.max(maxS, slope[b]);
    if (Number.isFinite(aspect[b])) asp.push([aspect[b], d]);
    const f = flags[b];
    if (f & 1) flagM.convex += d;
    if (f & 2) flagM.runoutZone += d;
    if (f & 4) flagM.trap += d;
    if (f & 8) flagM.narrow += d;
    if (f & 16) flagM.capped += d;
  }
  let runoutLen = 0;
  const rc = [cells[cells.length - 1], ...runout];
  for (let c = 1; c < rc.length; c++) {
    const a = rc[c - 1], b = rc[c];
    const ai = a % nx, aj = (a - ai) / nx, bi = b % nx, bj = (b - bi) / nx;
    runoutLen += Math.hypot(bi - ai, bj - aj) * cellM;
  }
  const top = cells[0], bottom = rc[rc.length - 1];
  const meanA = meanAspect(asp);
  const stats = {
    lengthM: Math.round(lengthM),
    runoutM: Math.round(runoutLen),
    verticalM: Math.round(ele[top] - ele[bottom]),
    topEle: Math.round(ele[top]),
    bottomEle: Math.round(ele[bottom]),
    avgSlope: lengthM ? Math.round((sw / lengthM) * 10) / 10 : null,
    maxSlope: Math.round(maxS * 10) / 10,
    aspect: meanA === null ? null : Math.round(meanA),
    octant: octantOf(meanA),
    flagM: Object.fromEntries(Object.entries(flagM).map(([k, v]) => [k, Math.round(v)])),
  };
  // The line as drawn: grid steps thinned to the shape (within ~¾ of a cell), then eased once.
  const line = (list) => smooth(thin(list.map((k) => [k % nx, Math.floor(k / nx)]), 0.75)).map(([i, j]) => { const p = grid.toLatLon(i, j); return [+p.lat.toFixed(6), +p.lon.toFixed(6)]; });
  const main = line(cells);
  const tail = runout.length ? line([cells[cells.length - 1], ...runout]).slice(1) : [];
  return { cells, runout, points: main, runoutPoints: tail, stats, notes: runNotes(stats, set) };
}

/** Douglas–Peucker on [x, y] points. */
function thin(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1, fd = tol;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L;
      if (d > fd) { fd = d; far = k; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, k) => keep[k]);
}
/** One round of Chaikin corner cutting, ends kept. */
function smooth(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    if (k > 0) out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by]);
    if (k < pts.length - 2) out.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Plain words on what shaped a run and what to look at. */
export function runNotes(st, set = RUN_DEFAULTS) {
  const n = [];
  if (st.avgSlope !== null && Math.abs(st.avgSlope - set.targetAvg) > 3) n.push(`averages ${st.avgSlope}°, ${st.avgSlope < set.targetAvg ? 'gentler' : 'steeper'} than the ${set.targetAvg}° asked for: nothing closer here`);
  if (st.flagM.capped > 0) n.push(`${st.flagM.capped} m on a slope facing today's problems, kept under ${set.hazardMax}°`);
  if (st.flagM.convex > 0) n.push(`crosses a convex roll (${st.flagM.convex} m): look at it before committing`);
  if (st.flagM.runoutZone > 0) n.push(`${st.flagM.runoutZone} m in an avalanche runout zone`);
  if (st.flagM.trap > 0) n.push(`${st.flagM.trap} m in a gully (terrain trap)`);
  if (st.flagM.narrow > 0) n.push(`${st.flagM.narrow} m narrower than ${set.minWidthM} m`);
  return n;
}
