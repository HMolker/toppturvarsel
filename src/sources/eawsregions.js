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
 */

const URL_CH = process.env.EAWS_REGIONS_CH_URL || 'https://regions.avalanches.org/micro-regions/CH_micro-regions.geojson.json';
const TTL = 30 * 86400e3;
const RETRY_MS = 30 * 60e3;
const file = () => path.resolve(config.dataDir, 'cache', 'eaws', 'CH_micro-regions.json');

let memo = null; // { at, regions }
let failedAt = 0;
let inflight = null;

/** GeoJSON -> [{ id, bbox: [w, s, e, n], polygons: [[outer, ...holes]] }] with rings of [lon, lat]. */
export function parseRegions(body) {
  if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) throw new Error('EAWS regions: not a FeatureCollection');
  const out = [];
  for (const f of body.features) {
    const id = f?.properties?.id;
    const g = f?.geometry;
    if (!id || !g) continue;
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

async function readStored() {
  try {
    const st = await stat(file());
    return { age: Date.now() - st.mtimeMs, body: JSON.parse(await readFile(file(), 'utf8')) };
  } catch {
    return null;
  }
}

/** The Swiss micro-regions, or null when none have ever been loaded. */
export async function swissMicroRegions() {
  if (memo && Date.now() - memo.at < TTL) return memo.regions;
  if (inflight) return inflight;
  inflight = (async () => {
    const stored = await readStored();
    if (stored && stored.age < TTL) {
      memo = { at: Date.now() - stored.age, regions: parseRegions(stored.body) };
      return memo.regions;
    }
    if (Date.now() - failedAt > RETRY_MS) {
      try {
        const res = await fetch(URL_CH, { headers: { 'User-Agent': UA, Accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const regions = parseRegions(body);
        await mkdir(path.dirname(file()), { recursive: true });
        await writeFile(`${file()}.tmp`, JSON.stringify(body));
        await rename(`${file()}.tmp`, file());
        memo = { at: Date.now(), regions };
        return regions;
      } catch (err) {
        failedAt = Date.now();
        log.warn(`eaws regions: ${err.message}${stored ? '; using the stored copy' : ''}`);
      }
    }
    if (stored) {
      memo = { at: Date.now() - TTL + RETRY_MS, regions: parseRegions(stored.body) };
      return memo.regions;
    }
    return null;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** The Swiss micro-region at a point: "CH-4222", or null. */
export async function swissMicroRegionAt(lat, lon) {
  const regions = await swissMicroRegions();
  return regions ? regionIn(regions, lat, lon) : null;
}

export function _resetEaws() {
  memo = null;
  failedAt = 0;
  inflight = null;
}
