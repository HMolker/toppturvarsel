import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { bestElevations } from './sources/elevation.js';
import { getRoute, countryOf } from './tracks.js';
import { slugify } from './util/gpx.js';

/**
 * A regular elevation grid around a tour, for drawing contour lines.
 *
 * The grid covers the same area the route map shows (the route plus its
 * summit, padded), so the contours line up with what is on screen. Norway
 * comes from Kartverket's 1 m/10 m terrain model, Sweden from Copernicus
 * GLO-90. The browser turns the grid into contour lines (public/contours.js).
 *
 * 24 × 20 points = 480 elevations: ten Kartverket requests or five
 * Open-Meteo ones, once per tour, cached for 30 days.
 */

const TTL = 30 * 86400e3;
const NX = 24, NY = 20;

export function gridBox(points, summit) {
  const all = [...points, summit].filter(Boolean);
  let s = Math.min(...all.map((p) => p.lat)), n = Math.max(...all.map((p) => p.lat));
  let w = Math.min(...all.map((p) => p.lon)), e = Math.max(...all.map((p) => p.lon));
  // At least ~3 km across, and 30% padding so contours reach the map edges.
  const minLat = 3 / 111, minLon = 3 / (111 * Math.cos((summit.lat * Math.PI) / 180));
  if (n - s < minLat) { const c = (n + s) / 2; s = c - minLat / 2; n = c + minLat / 2; }
  if (e - w < minLon) { const c = (e + w) / 2; w = c - minLon / 2; e = c + minLon / 2; }
  const pl = (n - s) * 0.3, pw = (e - w) * 0.3;
  return { south: s - pl, north: n + pl, west: w - pw, east: e + pw };
}

export function gridPoints(box, nx = NX, ny = NY) {
  const pts = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pts.push({
        lat: box.north - ((box.north - box.south) * j) / (ny - 1),
        lon: box.west + ((box.east - box.west) * i) / (nx - 1),
      });
    }
  }
  return pts;
}

export async function getTerrain(tour) {
  const slug = slugify(tour.name);
  const file = path.resolve(config.dataDir, 'cache', 'terrain', `${slug}.json`);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL) return cached;
  } catch {
    /* not cached */
  }

  const route = await getRoute(tour);
  const summit = route?.summit ?? { lat: tour.lat, lon: tour.lon };
  const box = gridBox(route?.found ? route.points : [], summit);
  const pts = gridPoints(box);
  const { values, source } = await bestElevations(pts, await countryOf(tour));

  const terrain = {
    tour: tour.name,
    box,
    nx: NX,
    ny: NY,
    // Row-major from the north-west corner, metres, null where unknown.
    z: values.map((v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)),
    source,
    fetchedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(terrain));
  await rename(`${file}.tmp`, file);
  return terrain;
}
