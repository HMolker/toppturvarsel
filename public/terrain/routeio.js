/**
 * A drawn route as data: kept in the page's address (so a link or a
 * bookmark brings it back) and in this browser's own list of saved routes.
 *
 * The route model is the shape a GPX track maps onto — an ordered list of
 * [lat, lon] with a name — so GPX import and export (gpx.js) are a
 * translation of this and nothing else.
 */

export const ROUTE_VERSION = 1;

/** Switches for features added after v5.0 (all on since v5.1). */
export const FEATURES = {
  gpxImport: true, // v5.1
  gpxExport: true, // v5.1
  weather: true, // v5.1: MET Norway at the start and the highest point
};

/* ----------------- encoded polyline (precision 1e-5) ----------------- */

export function encodePolyline(points) {
  let out = '', plat = 0, plon = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - plat) + enc(b - plon);
    plat = a; plon = b;
  }
  return out;
}

export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let r = 0, sh = 0, b;
    do {
      if (i >= str.length) throw new Error('truncated polyline');
      b = str.charCodeAt(i++) - 63;
      r |= (b & 0x1f) << sh;
      sh += 5;
    } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lon += dec();
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

/* ----------------- the address bar ----------------- */

/** #r=<polyline>&n=<name>  or  #tour=<slug>  or  #at=<lat>,<lon>,<zoom> */
export function readHash(hash = location.hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out = {};
  if (q.get('r')) {
    try { out.points = decodePolyline(q.get('r')); } catch { /* ignore a broken link */ }
  }
  if (q.get('n')) out.name = q.get('n');
  if (q.get('tour')) out.tour = q.get('tour');
  const at = q.get('at')?.split(',').map(Number);
  if (at?.length >= 2 && at.every(Number.isFinite)) out.at = { lat: at[0], lon: at[1], zoom: at[2] ?? 13 };
  if (q.get('pin')) out.pin = q.get('pin').slice(0, 80);
  return out;
}

export function writeHash({ points, name, at, tour }) {
  const q = new URLSearchParams();
  if (tour) q.set('tour', tour);
  if (points?.length) q.set('r', encodePolyline(points));
  if (name) q.set('n', name);
  if (at) q.set('at', `${at.lat.toFixed(4)},${at.lon.toFixed(4)},${at.zoom.toFixed(1)}`);
  const h = `#${q.toString()}`;
  if (h !== location.hash) history.replaceState(null, '', h);
}

/* ----------------- saved in this browser ----------------- */

const KEY = 'fjallskred.routes.v1';
function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
function writeAll(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}
export const savedRoutes = () => readAll();
export function saveRoute({ name, points }) {
  const list = readAll().filter((r) => r.name !== name);
  list.unshift({ v: ROUTE_VERSION, name, points: points.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]), saved: new Date().toISOString() });
  return writeAll(list.slice(0, 50));
}
export function deleteRoute(name) {
  return writeAll(readAll().filter((r) => r.name !== name));
}
