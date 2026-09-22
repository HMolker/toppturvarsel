/**
 * GPX in and out for the terrain page (v5.1). Everything happens in the
 * browser: an imported file is never uploaded.
 *
 * Reading follows the server's parser (src/util/gpx.js): no XML library,
 * a careful regex over the flat, attribute-carrying point elements. Tracks
 * first, then routes, then waypoints. Garmin Connect, Suunto, Strava,
 * OsmAnd and Fatmap exports all come out this way.
 */

import { simplify } from './suggest.js';
import { mx, my } from './dem.js';

const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const unxml = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/** -> { name, kind: 'track'|'route'|'waypoints', points: [{lat, lon, ele}] } */
export function parseGpx(xml) {
  if (typeof xml !== 'string' || !/<gpx\b/i.test(xml)) throw new Error('not a GPX file');
  const grab = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
    let m;
    while ((m = re.exec(xml))) {
      const lat = num(m[1].match(/\blat\s*=\s*["']([^"']+)["']/i)?.[1]);
      const lon = num(m[1].match(/\blon\s*=\s*["']([^"']+)["']/i)?.[1]);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.push({ lat, lon, ele: num(m[2]?.match(/<ele>\s*([^<]+?)\s*<\/ele>/i)?.[1]) });
    }
    return out;
  };
  const nameIn = (tag) => {
    const block = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? '';
    // The block's own <name>, not one inside a point.
    const head = block.split(/<(?:trkseg|trkpt|rtept)\b/i)[0];
    return unxml(head.match(/<name>([\s\S]*?)<\/name>/i)?.[1] ?? '');
  };
  const trk = grab('trkpt');
  if (trk.length >= 2) return { name: nameIn('trk') || nameIn('metadata'), kind: 'track', points: trk };
  const rte = grab('rtept');
  if (rte.length >= 2) return { name: nameIn('rte') || nameIn('metadata'), kind: 'route', points: rte };
  const wpt = grab('wpt');
  if (wpt.length >= 2) return { name: nameIn('metadata'), kind: 'waypoints', points: wpt };
  throw new Error('no track, route or waypoints with two or more points in this file');
}

/**
 * Thin a track to at most `max` points, the way a hand-drawn route looks:
 * Douglas–Peucker on Web Mercator pixels at zoom 16 (~2 m at 60°N), with
 * the tolerance raised until it fits.
 */
export function thinTrack(points, max = 150) {
  if (points.length <= max) return points.map((p) => [p.lat ?? p[0], p.lon ?? p[1]]);
  const z16 = 256 * 2 ** 16;
  const ll = points.map((p) => [p.lat ?? p[0], p.lon ?? p[1]]);
  const proj = ll.map(([la, lo], i) => [mx(lo) * z16, my(la) * z16, i]);
  let tol = 2, keep;
  do {
    keep = simplify(proj, tol);
    tol *= 1.5;
  } while (keep.length > max);
  return keep.map((p) => ll[p[2]]);
}

const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/**
 * GPX 1.1 with the route both as a track (for maps and logs) and as a route
 * (for watches that navigate routes). Heights from the measured profile at
 * each point where known. No timestamps.
 */
export function toGpx({ name, points, eles = [] }) {
  const pt = (tag, [lat, lon], i, ind) =>
    `${ind}<${tag} lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${Number.isFinite(eles[i]) ? `<ele>${Math.round(eles[i])}</ele>` : ''}</${tag}>`;
  const nm = xmlEsc(name || 'Fjällskred route');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fjällskred" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${nm}</name>
    <desc>Drawn on Fjällskred's terrain page. Heights: Kartverket / Copernicus. Not for navigation on its own.</desc>
  </metadata>
  <trk>
    <name>${nm}</name>
    <trkseg>
${points.map((p, i) => pt('trkpt', p, i, '      ')).join('\n')}
    </trkseg>
  </trk>
  <rte>
    <name>${nm}</name>
${points.map((p, i) => pt('rtept', p, i, '    ')).join('\n')}
  </rte>
</gpx>
`;
}

/** A safe file name: "Høgeloft NE" -> "hogeloft-ne.gpx". */
export function gpxFileName(name) {
  const s = String(name || 'route').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${s || 'route'}.gpx`;
}
