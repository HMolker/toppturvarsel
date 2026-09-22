/**
 * The terrain model in the browser: elevation tiles from /api/dem, stitched
 * into grids, turned into slope angle and aspect.
 *
 * A DEM tile is a 17 × 17 grid over one Web Mercator map tile, its edges
 * shared with the neighbours; Mercator is conformal, so the cells are square
 * on the ground: 40 075 km · cos(lat) / 2^z / 16 on a side.
 */

export const DEM_N = 17;
export const DEM_MIN_Z = 11;
export const DEM_MAX_Z = 15;
const R = Math.PI / 180;
const EARTH = 40075016.686;

export const mx = (lon) => (lon + 180) / 360;
export const my = (lat) => {
  const r = lat * R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};
export const unmx = (x) => x * 360 - 180;
export const unmy = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / R;

/** Metres per DEM cell at a latitude and zoom. */
export const cellMetres = (lat, z) => (EARTH * Math.cos(lat * R)) / 2 ** z / (DEM_N - 1);

/* ------------------------------------------------------------------ *
 * fetching, with a memory cache and a small queue
 * ------------------------------------------------------------------ */

export class DemStore {
  constructor({ fetchJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { status: r.status }))))), limit = 3 } = {}) {
    this.fetchJson = fetchJson;
    this.tiles = new Map(); // key -> tile | {error}
    this.pending = new Map(); // key -> promise
    this.queue = [];
    this.active = 0;
    this.limit = limit;
    this.listeners = new Set();
    this.lastError = null;
  }
  key(z, x, y) { return `${z}/${x}/${y}`; }
  get(z, x, y) { return this.tiles.get(this.key(z, x, y)) ?? null; }
  onTile(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Ask for a tile; resolves to the tile or null (outside the area, budget used, …). */
  load(z, x, y) {
    const k = this.key(z, x, y);
    if (this.tiles.has(k)) return Promise.resolve(this.tiles.get(k).error ? null : this.tiles.get(k));
    if (this.pending.has(k)) return this.pending.get(k);
    const p = new Promise((resolve) => {
      this.queue.push({ k, url: `/api/dem/${z}/${x}/${y}`, resolve });
      this.pump();
    });
    this.pending.set(k, p);
    return p;
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.fetchJson(job.url)
        .then((t) => { this.tiles.set(job.k, t); job.resolve(t); })
        .catch((e) => {
          this.lastError = e.message;
          // 403 (outside) and 429 (budget) are answers; keep them. Others retry later.
          if (e.status === 403 || e.status === 429 || e.status === 400) this.tiles.set(job.k, { error: e.message, status: e.status });
          job.resolve(null);
        })
        .finally(() => {
          this.active--;
          this.pending.delete(job.k);
          for (const fn of this.listeners) fn(job.k);
          this.pump();
        });
    }
  }
  get busy() { return this.active + this.queue.length; }
  /** Drop queued (not started) requests, e.g. after the view moved on. */
  cancelQueued(keep = () => false) {
    const dropped = this.queue.filter((j) => !keep(j.k));
    this.queue = this.queue.filter((j) => keep(j.k));
    for (const j of dropped) { this.pending.delete(j.k); j.resolve(null); }
  }
}

/* ------------------------------------------------------------------ *
 * grids
 * ------------------------------------------------------------------ */

/** Tiles at zoom z covering a lat/lon box, as an x/y range. */
export function tileRange(box, z) {
  const n = 2 ** z;
  const clampT = (v) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  return {
    z,
    x0: clampT(mx(box.west) * n), x1: clampT(mx(box.east) * n),
    y0: clampT(my(box.north) * n), y1: clampT(my(box.south) * n),
  };
}
export const tileCount = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/**
 * Stitch tiles into one grid. Missing tiles leave NaN. Returns
 * { z, nx, ny, ele: Float32Array, x0, y0 (tile coords of the NW corner),
 *   cellM, toLatLon(i, j), fromLatLon(lat, lon) -> [fi, fj] }.
 */
export function mosaic(range, getTile) {
  const S = DEM_N - 1;
  const tx = range.x1 - range.x0 + 1, ty = range.y1 - range.y0 + 1;
  const nx = tx * S + 1, ny = ty * S + 1;
  const ele = new Float32Array(nx * ny).fill(NaN);
  let sources = new Set();
  for (let a = 0; a < tx; a++) {
    for (let b = 0; b < ty; b++) {
      const t = getTile(range.z, range.x0 + a, range.y0 + b);
      if (!t?.ele) continue;
      if (t.source) sources.add(t.source);
      for (let j = 0; j < DEM_N; j++) {
        for (let i = 0; i < DEM_N; i++) {
          const v = t.ele[j * DEM_N + i];
          ele[(b * S + j) * nx + (a * S + i)] = v === null ? NaN : v;
        }
      }
    }
  }
  const n = 2 ** range.z;
  const toLatLon = (i, j) => ({ lat: unmy((range.y0 + j / S) / n), lon: unmx((range.x0 + i / S) / n) });
  const fromLatLon = (lat, lon) => [(mx(lon) * n - range.x0) * S, (my(lat) * n - range.y0) * S];
  const mid = toLatLon(nx / 2, ny / 2);
  return { z: range.z, nx, ny, ele, x0: range.x0, y0: range.y0, cellM: cellMetres(mid.lat, range.z), toLatLon, fromLatLon, sources: [...sources] };
}

/** Bilinear height at fractional grid coordinates; NaN outside or where unknown. */
export function sampleGrid(g, fi, fj, arr = g.ele) {
  if (!(fi >= 0 && fj >= 0 && fi <= g.nx - 1 && fj <= g.ny - 1)) return NaN;
  const i = Math.min(g.nx - 2, Math.floor(fi)), j = Math.min(g.ny - 2, Math.floor(fj));
  const u = fi - i, v = fj - j;
  const a = arr[j * g.nx + i], b = arr[j * g.nx + i + 1], c = arr[(j + 1) * g.nx + i], d = arr[(j + 1) * g.nx + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Slope angle (degrees) and aspect (degrees from north, the way the ground
 * faces) at every grid node, from central differences (one-sided at edges).
 * Rows run north to south.
 */
export function slopeAspect(ele, nx, ny, cellM) {
  const slope = new Float32Array(nx * ny).fill(NaN);
  const aspect = new Float32Array(nx * ny).fill(NaN);
  const at = (i, j) => ele[j * nx + i];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const iw = Math.max(0, i - 1), ie = Math.min(nx - 1, i + 1);
      const jn = Math.max(0, j - 1), js = Math.min(ny - 1, j + 1);
      const gx = (at(ie, j) - at(iw, j)) / ((ie - iw) * cellM);
      const gy = (at(i, jn) - at(i, js)) / ((js - jn) * cellM); // rise towards north
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      const s = Math.atan(Math.hypot(gx, gy)) / R;
      slope[j * nx + i] = s;
      aspect[j * nx + i] = s < 0.5 ? NaN : ((Math.atan2(-gx, -gy) / R) + 360) % 360;
    }
  }
  return { slope, aspect };
}

/** One DEM tile on its own: slope and aspect at the 16 × 16 cell centres. */
export function tileCells(tile) {
  const S = DEM_N - 1;
  const lat = unmy((tile.y + 0.5) / 2 ** tile.z);
  const cell = cellMetres(lat, tile.z);
  const e = (i, j) => { const v = tile.ele[j * DEM_N + i]; return v === null ? NaN : v; };
  const slope = new Float32Array(S * S), aspect = new Float32Array(S * S), elev = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = e(i, j), b = e(i + 1, j), c = e(i, j + 1), d = e(i + 1, j + 1);
      const gx = ((b + d) - (a + c)) / (2 * cell);
      const gy = ((a + b) - (c + d)) / (2 * cell);
      const s = Math.atan(Math.hypot(gx, gy)) / R;
      slope[j * S + i] = s;
      aspect[j * S + i] = s < 0.5 ? NaN : ((Math.atan2(-gx, -gy) / R) + 360) % 360;
      elev[j * S + i] = (a + b + c + d) / 4;
    }
  }
  return { slope, aspect, elev, cellM: cell };
}
