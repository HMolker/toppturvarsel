import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';

/**
 * Ski lifts from a national mapping agency, as a GeoJSON file you put in
 * data/ yourself:
 *
 *   data/lifts-SE.geojson   Lantmäteriet, Topografi 50: Byggnadsverk ->
 *                           Byggnadsanläggningslinje, objekttyp "Lintrafik"
 *   data/lifts-NO.geojson   Kartverket, N50 Kartdata: Taubane / Skitrekk
 *
 * Neither agency serves these without an account (Lantmäteriet's Geotorget)
 * or a bulk order (Geonorge's download API), so the app cannot fetch them
 * for you. Export the lift layer to GeoJSON in WGS84 (EPSG:4326) — QGIS
 * does it in two clicks — drop the file in data/, and every resort map
 * checks it: lifts in the file with nothing mapped near them are drawn and
 * listed as missing from OpenStreetMap. See README, "National lift data".
 *
 * Any GeoJSON with LineString or MultiLineString features works; the name
 * is taken from properties.name, .namn, .navn, .tekst or .objekttyp.
 */

const memo = new Map(); // country -> { at, features }
const TTL = 3600e3;

/** GeoJSON -> [{ name, points: [{lat, lon}] }] (pure). */
export function shapeLiftFile(geojson) {
  const out = [];
  const lines = (g) => (g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []);
  for (const f of geojson?.features ?? []) {
    const p = f.properties ?? {};
    const name = p.name ?? p.namn ?? p.navn ?? p.tekst ?? p.NAMN ?? null;
    for (const line of lines(f.geometry)) {
      const points = (line ?? [])
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map(([lon, lat]) => ({ lat: +lat.toFixed(6), lon: +lon.toFixed(6) }));
      if (points.length >= 2) out.push({ name: name ? String(name) : null, kind: p.objekttyp ?? p.objtype ?? null, points });
    }
  }
  return out;
}

/** The lifts in data/lifts-<COUNTRY>.geojson, or [] when there is no such file. */
export async function fileLifts(country) {
  const key = String(country ?? '').toUpperCase();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.features;
  let features = [];
  try {
    const raw = await readFile(path.resolve(config.dataDir, `lifts-${key}.geojson`), 'utf8');
    features = shapeLiftFile(JSON.parse(raw));
    log.info(`liftfile: ${features.length} lift lines from data/lifts-${key}.geojson`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`liftfile: data/lifts-${key}.geojson: ${err.message}`);
  }
  memo.set(key, { at: Date.now(), features });
  return features;
}

export const _resetLiftFile = () => memo.clear();
