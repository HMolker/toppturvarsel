import { UA } from './util/ua.js';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { tourBoxes } from './tracks.js';
import { log } from './util/log.js';

/**
 * Topographic map tiles, fetched by the server and cached on disk, so a
 * viewer's browser only ever talks to this service.
 *
 *   no: Kartverket greyscale topo (verified WMTS layer 'topograatone'), © Kartverket, CC BY 4.0
 *       https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png
 *   se: OpenTopoMap, © OpenStreetMap contributors, SRTM; style © OpenTopoMap
 *       (CC-BY-SA). Kartverket's map stops at the border.
 *
 * NOT AN OPEN PROXY. A tile is served only if it lies within ~12 km of a
 * listed tour and between zoom 9 and 16. Anything else is a 403 without
 * touching upstream. This matters on a box that is port-forwarded to the
 * internet: otherwise it would relay tiles for anyone, from our IP.
 */

const SOURCES = {
  // topograatone: Kartverket's greyscale topo (layer listed in the verified
  // WMTS capabilities), with 20 m contour lines at high zoom.
  no: (z, x, y) => `https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/${z}/${y}/${x}.png`,
  se: (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,
  // NVE's slope-angle and avalanche runout map (v5): transparent PNG over
  // the topo, Norway and Svalbard only, 27° and steeper in six classes plus
  // three runout zones (short / medium / long). A cached ArcGIS service in
  // Web Mercator, levels 5-16 (service metadata checked 2026-09-23).
  // © NVE, CC BY 4.0.
  nve: (z, x, y) => `https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer/tile/${z}/${y}/${x}`,
};
const MIN_Z = 9, MAX_Z = 16;
const MARGIN_KM = 12;
const TTL = 30 * 86400e3;

export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lon2 = ((x + 1) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { north: lat, south: lat2, west: lon, east: lon2 };
}

/**
 * The overview map on the conditions page (v5.5): coarse zooms 4-8 over the
 * Nordic mainland only, from OpenTopoMap (which covers both countries). A
 * fixed, small set of tiles (~700), so still not an open proxy.
 */
export const OVERVIEW = { minZ: 4, maxZ: 8, south: 54.5, north: 71.6, west: 3.5, east: 32.5 };
export function overviewAllowed(src, z, x, y) {
  if (src !== 'se' || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < OVERVIEW.minZ || z > OVERVIEW.maxZ) return false;
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return false;
  const b = tileBounds(z, x, y);
  return b.south <= OVERVIEW.north && b.north >= OVERVIEW.south && b.west <= OVERVIEW.east && b.east >= OVERVIEW.west;
}

export function tileAllowed(z, x, y, boxes) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < MIN_Z || z > MAX_Z) return false;
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return false;
  const b = tileBounds(z, x, y);
  return boxes.some((t) => {
    const dLat = MARGIN_KM / 111;
    const dLon = MARGIN_KM / (111 * Math.cos((t.lat * Math.PI) / 180));
    return t.lat + dLat >= b.south && t.lat - dLat <= b.north && t.lon + dLon >= b.west && t.lon - dLon <= b.east;
  });
}

/** Is a point inside the service area (within MARGIN_KM of a tour or resort)? */
export function pointAllowed(lat, lon, list) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return list.some((t) => {
    const dLat = MARGIN_KM / 111;
    const dLon = MARGIN_KM / (111 * Math.cos((t.lat * Math.PI) / 180));
    return Math.abs(t.lat - lat) <= dLat && Math.abs(t.lon - lon) <= dLon;
  });
}
export const ZONE_MARGIN_KM = MARGIN_KM;

let boxesPromise = null;
let resortBoxes = null;
// Tours, plus ski resorts once their list has loaded (the resort view has a
// map too). The resort list is only ever the one from Fnugg / OpenStreetMap.
export const zoneBoxes = () => boxes();
const boxes = async () => {
  const tours = await (boxesPromise ??= tourBoxes());
  if (!resortBoxes) {
    try {
      const { getResorts } = await import('./resorts.js');
      const got = await getResorts();
      const list = got.resorts ?? [];
      const boxesNow = list.map((r) => ({ lat: r.lat, lon: r.lon, country: r.country }));
      // A list served while the real one is still being fetched is used for
      // now and asked for again next time (v5.6.1).
      if (Object.values(got.sources ?? {}).some((x) => x.refreshing)) return [...tours, ...boxesNow, ...(await pickedBoxes())];
      if (list.length) resortBoxes = boxesNow;
    } catch {
      /* not yet: tours only this time */
    }
  }
  return [...tours, ...(resortBoxes ?? []), ...(await pickedBoxes())];
};
// Places picked in the place search (v5.6) count like a tour.
async function pickedBoxes() {
  const { placeZones } = await import('./places.js');
  return (await placeZones()).map((z) => ({ lat: z.lat, lon: z.lon, country: z.country }));
}

export async function serveTile(res, src, z, x, y) {
  const send = (status, body, type = 'text/plain') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': status === 200 ? 'public, max-age=604800' : 'no-store' });
    res.end(body);
  };
  if (!SOURCES[src]) return send(404, 'unknown tile source');
  if (!overviewAllowed(src, z, x, y) && !tileAllowed(z, x, y, await boxes())) return send(403, 'tile outside tour areas');

  const file = path.resolve(config.dataDir, 'cache', 'tiles', src, String(z), String(x), `${y}.png`);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < TTL) return send(200, await readFile(file), 'image/png');
  } catch {
    /* not cached */
  }
  // An overlay (NVE) has no tile where there is nothing to draw and answers
  // 404: remembered, so the same empty tile is not asked for again.
  try {
    const none = await stat(`${file}.none`);
    if (Date.now() - none.mtimeMs < TTL) return send(404, 'no tile here');
  } catch {
    /* not known to be empty */
  }

  try {
    const upstream = await fetch(SOURCES[src](z, x, y), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (upstream.status === 404 && src === 'nve') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.none`, '');
      return send(404, 'no tile here');
    }
    if (!upstream.ok) return send(502, `upstream ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
    return send(200, buf, 'image/png');
  } catch (err) {
    log.debug(`tiles: ${src}/${z}/${x}/${y} failed: ${err.message}`);
    return send(502, 'tile unavailable');
  }
}
