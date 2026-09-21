import { parseAspect } from './planner.js';

/**
 * When no photograph exists, draw the mountain instead.
 *
 * Everything here comes from the elevation grid the contour map already
 * uses (Kartverket's terrain model in Norway, Copernicus GLO-90 in Sweden),
 * so it is free of licence questions and never comes back empty. Two
 * drawings, both down the line you would ski:
 *
 *   1. a shaded relief of the terrain, lit from the north-west, with the
 *      fall line drawn on it;
 *   2. the profile of that line, coloured by slope angle.
 *
 * The direction is the tour's own descent aspect. Where that is unknown
 * ("varied"), the steepest way down from the summit is used instead, and
 * the drawing says which of the two it is.
 *
 * It is a sketch of the shape of the ground, not a slope-angle map and not
 * a photograph: a 24 × 20 grid over a few kilometres smooths away exactly
 * the small steep rolls that matter, so the angles read low.
 */

const OCT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const R = Math.PI / 180;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compass = (deg) => OCT[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

/** Middle of the aspect the tour faces, in degrees, or null for "varied". */
export function aspectBearing(aspect) {
  const on = parseAspect(aspect);
  if (!on.length || on.length === 8) return null;
  // Average as unit vectors, so N and NW average to NNW rather than to S.
  let x = 0, y = 0;
  for (const d of on) {
    const a = OCT.indexOf(d) * 45 * R;
    x += Math.sin(a);
    y += Math.cos(a);
  }
  if (!x && !y) return null;
  return ((Math.atan2(x, y) / R) + 360) % 360;
}

/** Metres per degree at this latitude, north and east. */
const scale = (lat) => ({ mLat: 111320, mLon: 111320 * Math.cos(lat * R) });

/** Bilinear sample of the grid; null outside it or over a hole. */
export function sampleZ(terrain, lat, lon) {
  const { box, nx, ny, z } = terrain ?? {};
  if (!z?.length) return null;
  const fx = ((lon - box.west) / (box.east - box.west)) * (nx - 1);
  const fy = ((box.north - lat) / (box.north - box.south)) * (ny - 1);
  if (!(fx >= 0 && fx <= nx - 1 && fy >= 0 && fy <= ny - 1)) return null;
  const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  const q = [z[j * nx + i], z[j * nx + i + 1], z[(j + 1) * nx + i], z[(j + 1) * nx + i + 1]];
  if (q.some((v) => !Number.isFinite(v))) return null;
  return (q[0] * (1 - tx) + q[1] * tx) * (1 - ty) + (q[2] * (1 - tx) + q[3] * tx) * ty;
}

const move = (p, bearing, distM) => {
  const { mLat, mLon } = scale(p.lat);
  return { lat: p.lat + (Math.cos(bearing * R) * distM) / mLat, lon: p.lon + (Math.sin(bearing * R) * distM) / mLon };
};

/** The way down: the bearing that drops fastest over the first 300 m. */
export function steepestBearing(terrain, summit, { probeM = 300 } = {}) {
  const top = sampleZ(terrain, summit.lat, summit.lon);
  if (top == null) return null;
  let best = null;
  for (let b = 0; b < 360; b += 10) {
    const p = move(summit, b, probeM);
    const z = sampleZ(terrain, p.lat, p.lon);
    if (z == null) continue;
    const drop = top - z;
    if (!best || drop > best.drop) best = { bearing: b, drop };
  }
  return best && best.drop > 0 ? best.bearing : null;
}

/** Points down the fall line: distance, height, and the angle of each step. */
export function fallLine(terrain, summit, bearing, { stepM = 60, maxM = 2400 } = {}) {
  const pts = [];
  let prevZ = sampleZ(terrain, summit.lat, summit.lon);
  if (prevZ == null) return pts;
  pts.push({ distM: 0, z: prevZ, angle: 0, lat: summit.lat, lon: summit.lon });
  for (let d = stepM; d <= maxM; d += stepM) {
    const p = move(summit, bearing, d);
    const z = sampleZ(terrain, p.lat, p.lon);
    if (z == null) break;
    pts.push({ distM: d, z, angle: (Math.atan2(prevZ - z, stepM) / R), lat: p.lat, lon: p.lon });
    prevZ = z;
  }
  return pts;
}

/**
 * Shaded relief of the grid: how much light a north-west sun at 45° throws
 * on each cell, 0 (shadow) to 1 (lit). Returns nx-1 × ny-1 values.
 */
export function hillshade(terrain, { azimuth = 315, altitude = 45 } = {}) {
  const { box, nx, ny, z } = terrain;
  const { mLat, mLon } = scale((box.north + box.south) / 2);
  const dx = ((box.east - box.west) / (nx - 1)) * mLon;
  const dy = ((box.north - box.south) / (ny - 1)) * mLat;
  const az = (360 - azimuth + 90) * R, alt = altitude * R;
  const out = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i], d = z[(j + 1) * nx + i + 1];
      if ([a, b, c, d].some((v) => !Number.isFinite(v))) { out.push(null); continue; }
      const zx = ((b + d) - (a + c)) / (2 * dx);
      const zy = ((a + b) - (c + d)) / (2 * dy);
      const slope = Math.atan(Math.hypot(zx, zy));
      const aspect = Math.atan2(zy, -zx);
      const v = Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect);
      out.push(Math.max(0, Math.min(1, v)));
    }
  }
  return out;
}

// Slope-angle bands, in the profile's greys: the steeper, the darker.
const BANDS = [
  [25, 'var(--ro1)', 'under 25°'],
  [30, 'var(--ro2)', '25–30°'],
  [35, 'var(--ro3)', '30–35°'],
  [Infinity, 'var(--ro4)', 'over 35°'],
];
const bandOf = (a) => BANDS.find(([max]) => a < max);

/**
 * The whole drawing as one SVG string: relief with the fall line on it, the
 * profile of that line below, and a line saying where the numbers come from.
 */
export function reliefSvg(terrain, tour, { width = 600 } = {}) {
  if (!terrain?.z?.length) return null;
  const summit = { lat: tour.lat, lon: tour.lon };
  const fromAspect = aspectBearing(tour.aspect);
  const bearing = fromAspect ?? steepestBearing(terrain, summit);
  if (bearing == null) return null;
  const line = fallLine(terrain, summit, bearing);
  if (line.length < 3) return null;

  const { box, nx, ny } = terrain;
  const H = 210, PH = 150, pad = 0;
  const shade = hillshade(terrain);
  const cw = width / (nx - 1), ch = H / (ny - 1);
  let cells = '';
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v = shade[j * (nx - 1) + i];
      if (v == null) continue;
      // Paper in the light, ink in the shade — the profile's own greys.
      const g = Math.round(250 - 185 * (1 - v));
      cells += `<rect x="${(i * cw).toFixed(1)}" y="${(j * ch).toFixed(1)}" width="${(cw + 0.6).toFixed(1)}" height="${(ch + 0.6).toFixed(1)}" fill="rgb(${g},${g},${Math.min(255, g + 4)})"/>`;
    }
  }
  const px = (p) => [
    ((p.lon - box.west) / (box.east - box.west)) * width,
    ((box.north - p.lat) / (box.north - box.south)) * H,
  ];
  const [sx, sy] = px(summit);
  const path = line.map((p, k) => { const [x, y] = px(p); return `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  const end = px(line[line.length - 1]);

  const drop = Math.round(line[0].z - line[line.length - 1].z);
  const maxAngle = Math.max(...line.slice(1).map((p) => p.angle));
  const steepest = line.slice(1).reduce((a, b) => (b.angle > a.angle ? b : a));

  // Profile of the same line.
  const zs = line.map((p) => p.z);
  const lo = Math.min(...zs), hi = Math.max(...zs), span = Math.max(30, hi - lo);
  const L = 44, Rt = 12, T = 16, B = 26, total = line[line.length - 1].distM || 1;
  const X = (d) => L + (d / total) * (width - L - Rt);
  const Y = (z) => T + (1 - (z - lo) / span) * (PH - T - B);
  let segs = '';
  for (let k = 1; k < line.length; k++) {
    const [, colour] = bandOf(Math.max(0, line[k].angle));
    segs += `<path d="M${X(line[k - 1].distM).toFixed(1)} ${Y(line[k - 1].z).toFixed(1)} L${X(line[k].distM).toFixed(1)} ${Y(line[k].z).toFixed(1)} ` +
      `L${X(line[k].distM).toFixed(1)} ${(PH - B).toFixed(1)} L${X(line[k - 1].distM).toFixed(1)} ${(PH - B).toFixed(1)} Z" fill="${colour}" stroke="none"/>`;
  }
  const ridge = line.map((p, k) => `${k ? 'L' : 'M'}${X(p.distM).toFixed(1)} ${Y(p.z).toFixed(1)}`).join(' ');

  const legend = BANDS.map(([, colour, label], i) =>
    `<g transform="translate(${(L + i * 92).toFixed(0)}, ${PH - 8})"><rect x="0" y="-8" width="10" height="10" fill="${colour}" stroke="var(--line-2)" stroke-width=".5"/>` +
    `<text x="14" y="0" class="rl">${label}</text></g>`).join('');

  return (
    `<svg class="relief" viewBox="0 0 ${width} ${H}" width="100%" role="img" aria-label="Shaded relief with the fall line down the ${compass(bearing)} side">` +
    // Softened, so a 24 x 20 grid reads as ground rather than as squares.
    `<defs><filter id="rsoft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${(cw * 0.45).toFixed(1)}"/></filter>` +
    `<clipPath id="rclip"><rect width="${width}" height="${H}"/></clipPath></defs>` +
    `<g clip-path="url(#rclip)"><g filter="url(#rsoft)">${cells}</g></g>` +
    `<path d="${path}" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="7 4"/>` +
    `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4.5" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.6"/>` +
    // Label on the far side from the descent, so the line never crosses it.
    `<text x="${(sx + (Math.sin(bearing * R) > 0 ? -9 : 9)).toFixed(1)}" y="${(sy + (Math.cos(bearing * R) > 0 ? 16 : -9)).toFixed(1)}" ` +
    `text-anchor="${Math.sin(bearing * R) > 0 ? 'end' : 'start'}" class="rl lbl">summit ${tour.summit_m} m</text>` +
    `<path d="M${end[0].toFixed(1)} ${end[1].toFixed(1)} l-4 -8 l8 0 Z" transform="rotate(${(bearing + 180).toFixed(0)} ${end[0].toFixed(1)} ${end[1].toFixed(1)})" fill="var(--ink)"/>` +
    `<text x="${(width - 8).toFixed(1)}" y="16" text-anchor="end" class="rl">lit from the north-west</text>` +
    `</svg>` +
    `<svg class="relief prof" viewBox="0 0 ${width} ${PH}" width="100%" role="img" aria-label="Profile of the fall line, coloured by slope angle">` +
    `<line x1="${L}" x2="${width - Rt}" y1="${PH - B}" y2="${PH - B}" stroke="var(--line-2)"/>` +
    segs + `<path d="${ridge}" fill="none" stroke="var(--ink)" stroke-width="1.6"/>` +
    `<text x="${L}" y="${T - 4}" class="rl">${Math.round(hi)} m on the grid</text>` +
    `<text x="${L - 6}" y="${(PH - B).toFixed(0)}" text-anchor="end" class="rl">${Math.round(lo)}</text>` +
    `<text x="${(width - Rt).toFixed(0)}" y="${T - 4}" text-anchor="end" class="rl">${(total / 1000).toFixed(1)} km down the fall line →</text>` +
    legend + `</svg>` +
    `<p class="note">Drawn from the terrain model (${esc(terrain.source ?? 'elevation data')}), not a photograph: no openly licensed photo of this summit was found. ` +
    `The grid is coarse and rounds off the top, so the summit reads ${Math.round(tour.summit_m - line[0].z)} m low. ` +
    `Looking down the <strong>${compass(bearing)}</strong> side${fromAspect == null ? ' — the steepest way down, since this tour’s aspect is not recorded yet' : ', the tour’s descent aspect'}. ` +
    `About ${drop} m of descent in the first ${(total / 1000).toFixed(1)} km; steepest stretch about ${Math.round(maxAngle)}° at ${Math.round(steepest.distM)} m from the top. ` +
    `Real rolls are steeper than this: it shows the shape of the mountain, not the slope angles you will ski.</p>`
  );
}
