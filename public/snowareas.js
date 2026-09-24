/**
 * The land around each forecast region (v5.6), for colouring the sketch map
 * by snow base: each region's point gets the land that is nearer to it than
 * to any other region's point (a Voronoi cell), but no farther than
 * `radiusKm`, so lowland far from every region stays uncoloured. The page
 * clips the cells to the coastline.
 *
 * Worked in Web Mercator, which is what the map draws in: the cells come out
 * straight-edged on screen. Pure: no DOM.
 */

const R = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * R) / 2)) / R;
const unMercY = (y) => (2 * Math.atan(Math.exp(y * R)) - Math.PI / 2) / R;

/** Keep the part of polygon `poly` ([[x, y]]) where (p - m)·n <= 0. */
function clipHalf(poly, m, n) {
  const out = [];
  const side = (p) => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * sites: [{ id, lat, lon }]. Returns [{ id, ring: [[lat, lon], …] }], one
 * polygon per site (empty rings left out).
 */
export function regionAreas(sites, { radiusKm = 110, sides = 48 } = {}) {
  const pts = sites
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ id: s.id, x: s.lon, y: mercY(s.lat), lat: s.lat }));
  const out = [];
  for (const s of pts) {
    // The radius in Mercator degrees at this latitude.
    const r = radiusKm / (111.32 * Math.cos(s.lat * R));
    let poly = [];
    for (let k = 0; k < sides; k++) {
      const a = (2 * Math.PI * k) / sides;
      poly.push([s.x + r * Math.cos(a), s.y + r * Math.sin(a)]);
    }
    for (const o of pts) {
      if (o === s) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      if (Math.hypot(dx, dy) > 2 * r) continue;
      poly = clipHalf(poly, [(s.x + o.x) / 2, (s.y + o.y) / 2], [dx, dy]);
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) out.push({ id: s.id, ring: poly.map(([x, y]) => [unMercY(y), x]) });
  }
  return out;
}
