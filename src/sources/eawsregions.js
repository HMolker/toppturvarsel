import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { UA } from '../util/ua.js';
import { log } from '../util/log.js';

/**
 * The outlines of SLF's avalanche micro-regions (v6.1), from the European
 * Avalanche Warning Services' region set:
 *
 *   https://regions.avalanches.org/micro-regions/CH_micro-regions.geojson.json
 *   -> FeatureCollection; features[].properties.id "CH-4222", geometry MultiPolygon (lon, lat)
 *
 * (checked 1 Oct 2026). With them any point in Switzerland finds the
 * micro-region whose bulletin applies, not just the listed tours' regions.
 * Kept on disk for 30 days; when the download fails an older copy is used,
 * and without any copy the page falls back to the nearest tour's region.
 *
 * v6.2: the same set has a file per Austrian state and per Italian province
 * (AT-07 Tyrol, IT-32-BZ South Tyrol, IT-32-TN Trentino …), same layout;
 * a few features carry an end date when a region was redrawn, and those are
 * left out. `microRegions(code)` loads any one of them, and
 * `alpineMicroRegionAt` finds the region at a point in Austria or Euregio.
 */

const BASE = (process.env.EAWS_REGIONS_URL || 'https://regions.avalanches.org/micro-regions').replace(/\/$/, '');
const URL_CH = process.env.EAWS_REGIONS_CH_URL || `${BASE}/CH_micro-regions.geojson.json`;
const TTL = 30 * 86400e3;
const RETRY_MS = 30 * 60e3;

/** Austria's states and Euregio's two Italian provinces: the files looked in for a point in the eastern Alps. */
export const ALPINE_STATES = ['AT-07', 'AT-08', 'AT-05', 'AT-02', 'AT-06', 'AT-04', 'AT-03', 'IT-32-BZ', 'IT-32-TN'];
const urlFor = (code) => (code === 'CH' ? URL_CH : `${BASE}/${code}_micro-regions.geojson.json`);
const file = (code) => path.resolve(config.dataDir, 'cache', 'eaws', `${code}_micro-regions.json`);

const sets = new Map(); // code -> { memo: { at, regions } | null, failedAt, inflight }
const setOf = (code) => sets.get(code) ?? sets.set(code, { memo: null, failedAt: 0, inflight: null }).get(code);

/** A feature that was retired: some end date (end_date, endDate …) in the past. */
function retired(props, today = new Date().toISOString().slice(0, 10)) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (/end/i.test(k) && /date/i.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && v.slice(0, 10) < today) return true;
  }
  return false;
}

/** GeoJSON -> [{ id, bbox: [w, s, e, n], polygons: [[outer, ...holes]] }] with rings of [lon, lat]. */
export function parseRegions(body) {
  if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) throw new Error('EAWS regions: not a FeatureCollection');
  const out = [];
  for (const f of body.features) {
    const id = f?.properties?.id;
    const g = f?.geometry;
    if (!id || !g || retired(f.properties)) continue;
    const polygons = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    if (!polygons.length) continue;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const poly of polygons) for (const [x, y] of poly[0] ?? []) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    out.push({ id, bbox: [w, s, e, n], polygons });
  }
  if (!out.length) throw new Error('EAWS regions: no regions in the file');
  return out;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The micro-region a point lies in (pure, for a parsed list), or null. */
export function regionIn(regions, lat, lon) {
  for (const r of regions) {
    const [w, s, e, n] = r.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    for (const [outer, ...holes] of r.polygons) {
      if (inRing(outer, lon, lat) && !holes.some((h) => inRing(h, lon, lat))) return r.id;
    }
  }
  return null;
}

async function readStored(code) {
  try {
    const st = await stat(file(code));
    return { age: Date.now() - st.mtimeMs, body: JSON.parse(await readFile(file(code), 'utf8')) };
  } catch {
    return null;
  }
}

/** The micro-regions of one file ("CH", "AT-07", "IT-32-BZ" …), or null when none have ever been loaded. */
export async function microRegions(code) {
  const st = setOf(code);
  if (st.memo && Date.now() - st.memo.at < TTL) return st.memo.regions;
  if (st.inflight) return st.inflight;
  st.inflight = (async () => {
    const stored = await readStored(code);
    if (stored && stored.age < TTL) {
      st.memo = { at: Date.now() - stored.age, regions: parseRegions(stored.body) };
      return st.memo.regions;
    }
    if (Date.now() - st.failedAt > RETRY_MS) {
      try {
        const res = await fetch(urlFor(code), { headers: { 'User-Agent': UA, Accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const regions = parseRegions(body);
        await mkdir(path.dirname(file(code)), { recursive: true });
        await writeFile(`${file(code)}.tmp`, JSON.stringify(body));
        await rename(`${file(code)}.tmp`, file(code));
        st.memo = { at: Date.now(), regions };
        return regions;
      } catch (err) {
        st.failedAt = Date.now();
        log.warn(`eaws regions ${code}: ${err.message}${stored ? '; using the stored copy' : ''}`);
      }
    }
    if (stored) {
      st.memo = { at: Date.now() - TTL + RETRY_MS, regions: parseRegions(stored.body) };
      return st.memo.regions;
    }
    return null;
  })().finally(() => { st.inflight = null; });
  return st.inflight;
}

/** The Swiss micro-regions, or null when none have ever been loaded. */
export const swissMicroRegions = () => microRegions('CH');

/** The Swiss micro-region at a point: "CH-4222", or null. */
export async function swissMicroRegionAt(lat, lon) {
  const regions = await swissMicroRegions();
  return regions ? regionIn(regions, lat, lon) : null;
}

/**
 * The micro-region at a point in Austria or Euregio: { id: "AT-07-14", state: "AT-07" } or null.
 * `states` narrows the files looked in (a listed region knows its state).
 */
export async function alpineMicroRegionAt(lat, lon, states = ALPINE_STATES) {
  for (const code of states) {
    const regions = await microRegions(code).catch(() => null);
    const id = regions ? regionIn(regions, lat, lon) : null;
    if (id) return { id, state: code };
  }
  return null;
}

export function _resetEaws() {
  sets.clear();
}
