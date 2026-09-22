/**
 * Tour detail views: topo route map, elevation sketch, 5-day forecast.
 * Rendered as plain SVG/HTML, no map or chart library.
 */

import { contours, smooth } from './contours.js';
import { reliefSvg } from './relief.js';
import { hazardCells } from './avalanche.js';
import { dayWindow, windowText } from './daywindow.js';
import { daylightText } from './daylight.js';
import { snowQuality } from './snowquality.js';
import { parseAspect } from './planner.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NEW_BANDS = [
  [5, '#FDF1ED'], [10, '#FBD6CB'], [20, '#F4A891'], [30, '#E8734F'], [50, '#C2402A'], [Infinity, '#6E1E15'],
];
const newCol = (v) => NEW_BANDS.find(([m]) => v < m)[1];

/* ------------------------------------------------------------------ *
 * web mercator
 * ------------------------------------------------------------------ */

const TILE = 256;
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

function frame(points, W, H, pad = 36) {
  const xs = points.map((p) => mx(p.lon));
  const ys = points.map((p) => my(p.lat));
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // A lone summit still needs some terrain around it: ~3 km on the ground.
  // Mercator units stretch by 1/cos(lat), so the span must too: at 69°N a
  // plain 3/40075 would show barely 1 km.
  const lat = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const minSpan = 3 / (40075 * Math.cos((lat * Math.PI) / 180));
  if (maxX - minX < minSpan) { minX -= minSpan / 2; maxX += minSpan / 2; }
  if (maxY - minY < minSpan) { minY -= minSpan / 2; maxY += minSpan / 2; }
  const zx = Math.log2((W - 2 * pad) / ((maxX - minX) * TILE));
  const zy = Math.log2((H - 2 * pad) / ((maxY - minY) * TILE));
  const z = Math.max(9, Math.min(15, Math.floor(Math.min(zx, zy))));
  const scale = TILE * 2 ** z;
  const cx = ((minX + maxX) / 2) * scale, cy = ((minY + maxY) / 2) * scale;
  return { z, scale, x0: cx - W / 2, y0: cy - H / 2, W, H };
}

const px = (f, p) => [mx(p.lon) * f.scale - f.x0, my(p.lat) * f.scale - f.y0];

function scaleBar(f, lat) {
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** f.z;
  const nice = [250, 500, 1000, 2000, 5000].find((m) => m / mPerPx >= 70) ?? 5000;
  return { px: nice / mPerPx, label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m` };
}

/* ------------------------------------------------------------------ *
 * route map
 * ------------------------------------------------------------------ */

export function renderRouteMap(el, { route, tour, country, terrain = null, photos = [], problems = [], danger = null, slopes = null }) {
  const W = 560, H = 380;
  const pts = route?.found ? route.points : [];
  const summit = route?.summit ?? { lat: tour.lat, lon: tour.lon, name: tour.name };
  const f = frame([...pts, summit], W, H);
  const src = country === 'SE' ? 'se' : 'no';

  const t0x = Math.floor(f.x0 / TILE), t1x = Math.floor((f.x0 + W) / TILE);
  const t0y = Math.floor(f.y0 / TILE), t1y = Math.floor((f.y0 + H) / TILE);
  const tiles = [];
  for (let tx = t0x; tx <= t1x; tx++) {
    for (let ty = t0y; ty <= t1y; ty++) {
      tiles.push(
        `<image href="/tiles/${src}/${f.z}/${tx}/${ty}.png" x="${(tx * TILE - f.x0).toFixed(1)}" y="${(ty * TILE - f.y0).toFixed(1)}" ` +
          `width="${TILE}" height="${TILE}" preserveAspectRatio="none" onerror="this.remove()"/>`
      );
    }
  }

  // Contour lines from the terrain grid, UNDER the tiles: the topo tiles are
  // opaque and carry their own (finer) contours, so these show only where a
  // tile is missing, e.g. when a tile server is down or unreachable.
  const contourSvg = [];
  const contourLabels = [];
  if (terrain?.z?.length) {
    for (const c of contours(terrain)) {
      for (const lineGeo of c.lines) {
        const pix = smooth(lineGeo.map((g) => px(f, g)));
        if (pix.length < 2) continue;
        contourSvg.push(
          `<polyline points="${pix.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" ` +
            `stroke="var(--coast)" stroke-width="${c.index ? 1.3 : 0.7}" opacity="${c.index ? 0.9 : 0.6}"/>`
        );
        // Label index contours once, at the middle of a line long enough to hold it.
        if (c.index && pix.length > 8) {
          const m = pix[Math.floor(pix.length / 2)];
          if (m[0] > 30 && m[0] < W - 30 && m[1] > 20 && m[1] < H - 40) {
            contourLabels.push(`<text x="${m[0].toFixed(1)}" y="${(m[1] + 3).toFixed(1)}" text-anchor="middle" class="contourlabel">${c.level}</text>`);
          }
        }
      }
    }
  }

  // Numbered photo markers, for photos that fall inside the map.
  const photoSvg = (photos ?? [])
    .map((ph, k) => {
      // Your own photos without a position have no marker, but keep their number.
      if (!Number.isFinite(ph.lat) || !Number.isFinite(ph.lon)) return '';
      const [x, y] = px(f, ph);
      if (x < 8 || y < 8 || x > W - 8 || y > H - 8) return '';
      return (
        `<g class="photomk${ph.own ? ' own' : ''}" data-photo="${k}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        // Your own photo: a pointer showing which way the camera faced, when known.
        (ph.own && Number.isFinite(ph.direction)
          ? `<path d="M0 0 L-5 -17 A18 18 0 0 1 5 -17 Z" transform="rotate(${ph.direction.toFixed(0)})" class="photodir"/>`
          : '') +
        `<rect x="-8" y="-8" width="16" height="16" rx="3" fill="var(--paper)" stroke="${ph.own ? 'var(--own)' : 'var(--ink)'}" stroke-width="1.5"/>` +
        `<text y="4" text-anchor="middle" class="photonum">${k + 1}</text></g>`
      );
    })
    .join('');

  // Slopes over 25° that face the way today's avalanche problems face, at
  // their heights: shaded red over the map. Drawn from the terrain grid,
  // so it follows the bulletin, not a slope-angle survey.
  // The fine slope grid when it has arrived; the coarse contour grid meanwhile
  // (which rarely shows anything over 25°, since its cells average the slope).
  const hazard = hazardCells(slopes ?? terrain, problems, { minAngle: 25 });
  // One path for all cells: painted once, so neighbouring cells merge into
  // one area instead of showing the grid's seams.
  const hazardPath = hazard
    .map((c) => {
      const q = c.corners.map((g) => px(f, g));
      return `M${q.map((v) => v.map((n) => n.toFixed(1)).join(' ')).join(' L')} Z`;
    })
    .join(' ');
  const steepest = hazard.reduce((m, c) => Math.max(m, c.angle), 0);
  const hazardSvg = hazardPath
    ? `<path d="${hazardPath}" class="hazarea"><title>Steeper than 25° (up to about ${steepest}°), facing where today’s avalanche problems are, at their heights</title></path>`
    : '';
  el.dataset.hazard = String(hazard.length);

  const line = pts.map((p) => px(f, p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const [sx, sy] = px(f, summit);
  const start = pts.length ? px(f, pts[0]) : null;
  const end = pts.length ? px(f, pts[pts.length - 1]) : null;
  const sb = scaleBar(f, summit.lat);

  el.innerHTML =
    `<svg class="routesvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Topographic map of ${esc(tour.name)}${pts.length ? ' with the route' : ''}">` +
    `<rect width="${W}" height="${H}" fill="var(--page)"/>` +
    `<g class="contours">${contourSvg.join('')}${contourLabels.join('')}</g>` +
    `<g class="tiles">${tiles.join('')}</g>` +
    (hazardSvg ? `<g class="hazard">${hazardSvg}</g>` : '') +
    (pts.length
      ? `<polyline points="${line}" fill="none" stroke="var(--paper)" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>` +
        `<polyline points="${line}" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<circle cx="${start[0].toFixed(1)}" cy="${start[1].toFixed(1)}" r="6" fill="var(--paper)" stroke="var(--ink)" stroke-width="2.5"/>` +
        (route.endGapM > 40
          ? `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="3.5" fill="var(--ink)"/>`
          : '')
      : '') +
    `<path d="M${sx.toFixed(1)} ${(sy - 9).toFixed(1)} l7.5 12.5 h-15 Z" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.5"/>` +
    // Label above the summit (routes arrive from the side, so beside it the
    // label would sit on the line), clamped so it never runs off the map.
    `<text x="${sx.toFixed(1)}" y="${(sy < 44 ? sy + 22 : sy - 15).toFixed(1)}" ` +
    `text-anchor="${sx < 110 ? 'start' : sx > W - 110 ? 'end' : 'middle'}" class="maplabel">` +
    `${esc(summit.name ?? tour.name)}${summit.ele ? ` ${Math.round(summit.ele)} m` : ''}</text>` +
    (start ? `<text x="${(start[0] + 10).toFixed(1)}" y="${(start[1] + 4).toFixed(1)}" class="maplabel">Start</text>` : '') +
    photoSvg +
    `<circle id="routeCursor" r="5.5" fill="var(--ink)" stroke="var(--paper)" stroke-width="2" style="display:none"/>` +
    `<g transform="translate(14 ${H - 18})"><rect x="-6" y="-16" width="${(sb.px + 58).toFixed(0)}" height="26" rx="4" fill="var(--paper)" opacity=".92"/>` +
    `<line x1="0" x2="${sb.px.toFixed(1)}" y1="0" y2="0" stroke="var(--ink)" stroke-width="2"/>` +
    `<line x1="0" x2="0" y1="-4" y2="4" stroke="var(--ink)" stroke-width="2"/><line x1="${sb.px.toFixed(1)}" x2="${sb.px.toFixed(1)}" y1="-4" y2="4" stroke="var(--ink)" stroke-width="2"/>` +
    `<text x="${(sb.px + 8).toFixed(1)}" y="4" class="maplabel">${sb.label}</text></g>` +
    `<g transform="translate(${W - 24} 28)"><path d="M0 -12 L6 4 L0 0 L-6 4 Z" fill="var(--ink)"/><text y="18" text-anchor="middle" class="maplabel">N</text></g>` +
    (hazard.length
      ? `<g transform="translate(${W - 10} ${H - 18})"><rect x="-276" y="-16" width="272" height="26" rx="4" fill="var(--paper)" opacity=".92"/>` +
        `<rect x="-268" y="-9" width="12" height="12" class="hazarea"/>` +
        `<text x="-250" y="1" class="maplabel">over 25° where today’s problems are</text></g>`
      : '') +
    `</svg>`;

  el._frame = f;
}

/** Move the map cursor to a profile sample (hover sync). */
export function moveCursor(mapEl, sample) {
  const c = mapEl.querySelector('#routeCursor');
  if (!c || !mapEl._frame) return;
  if (!sample) return (c.style.display = 'none');
  const [x, y] = px(mapEl._frame, sample);
  c.setAttribute('cx', x.toFixed(1));
  c.setAttribute('cy', y.toFixed(1));
  c.style.display = '';
}

/* ------------------------------------------------------------------ *
 * elevation sketch
 * ------------------------------------------------------------------ */

const niceStep = (range, target) => {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
};

export function renderProfile(el, route, mapEl) {
  const samples = route?.profile?.samples?.filter((s) => Number.isFinite(s.ele)) ?? [];
  if (samples.length < 2) {
    el.innerHTML = route?.found
      ? `<p class="note">Elevation profile unavailable${route?.profile?.error ? ` (${esc(route.profile.error)})` : ''}.</p>`
      : '';
    return;
  }

  const W = 560, H = 190, L = 46, R = 14, T = 14, B = 28;
  const D = samples[samples.length - 1].d;
  const eMin = Math.min(...samples.map((s) => s.ele));
  const eMax = Math.max(...samples.map((s) => s.ele));
  const yStep = niceStep(Math.max(100, eMax - eMin), 4);
  const y0 = Math.floor(eMin / yStep) * yStep;
  const y1 = Math.ceil(eMax / yStep) * yStep;
  const xStep = niceStep(Math.max(500, D), 5);
  const X = (d) => L + (d / D) * (W - L - R);
  const Y = (e) => T + (1 - (e - y0) / (y1 - y0)) * (H - T - B);

  const grid = [];
  for (let e = y0; e <= y1 + 1e-6; e += yStep) {
    grid.push(
      `<line x1="${L}" x2="${W - R}" y1="${Y(e).toFixed(1)}" y2="${Y(e).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${(Y(e) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${e}</text>`
    );
  }
  for (let d = 0; d <= D + 1e-6; d += xStep) {
    // Leave room for the "km" unit label at the right end of the axis.
    if (X(d) > W - R - 28) continue;
    grid.push(
      `<text x="${X(d).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${(d / 1000).toFixed(xStep < 1000 ? 1 : 0)}</text>`
    );
  }

  const linePts = samples.map((s) => `${X(s.d).toFixed(1)},${Y(s.ele).toFixed(1)}`).join(' ');
  const area = `M${X(0)},${Y(y0)} L${linePts.split(' ').join(' L')} L${X(D)},${Y(y0)} Z`;
  const top = samples.reduce((a, b) => (b.ele > a.ele ? b : a));

  el.innerHTML =
    `<svg class="profilesvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile: ${Math.round(D / 100) / 10} km, from ${samples[0].ele} m to ${top.ele} m">` +
    grid.join('') +
    `<path d="${area}" fill="var(--line)" opacity=".75"/>` +
    `<polyline points="${linePts}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="${X(top.d).toFixed(1)}" cy="${Y(top.ele).toFixed(1)}" r="3.5" fill="var(--ink)"/>` +
    `<text x="${Math.min(X(top.d), W - R - 60).toFixed(1)}" y="${(Y(top.ele) - 8).toFixed(1)}" class="axis strong">${top.ele} m</text>` +
    `<text x="${L}" y="${T - 2}" class="axis">m</text><text x="${W - R}" y="${H - 8}" text-anchor="end" class="axis">km</text>` +
    `<g class="hover" style="display:none"><line y1="${T}" y2="${H - B}" stroke="var(--ink)" stroke-width="1"/>` +
    `<circle r="4" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.5"/></g>` +
    `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>` +
    `</svg><div class="profiletip" hidden></div>`;

  const svg = el.querySelector('svg');
  const hover = svg.querySelector('.hover');
  const tip = el.querySelector('.profiletip');
  const hit = svg.querySelector('.hit');
  const move = (evt) => {
    const r = svg.getBoundingClientRect();
    const vx = ((evt.clientX - r.left) / r.width) * W;
    const d = ((vx - L) / (W - L - R)) * D;
    const s = samples.reduce((a, b) => (Math.abs(b.d - d) < Math.abs(a.d - d) ? b : a));
    hover.style.display = '';
    hover.querySelector('line').setAttribute('x1', X(s.d));
    hover.querySelector('line').setAttribute('x2', X(s.d));
    hover.querySelector('circle').setAttribute('cx', X(s.d));
    hover.querySelector('circle').setAttribute('cy', Y(s.ele));
    tip.hidden = false;
    tip.textContent = `${(s.d / 1000).toFixed(1)} km · ${s.ele} m`;
    tip.style.left = `${((X(s.d) / W) * 100).toFixed(1)}%`;
    if (mapEl) moveCursor(mapEl, s);
  };
  const leave = () => {
    hover.style.display = 'none';
    tip.hidden = true;
    if (mapEl) moveCursor(mapEl, null);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', leave);
}

export function routeSummary(route, tour) {
  if (!route) return '<p class="note">Looking up a route…</p>';
  if (!route.found) {
    return (
      `<p class="note"><strong>No route line shown.</strong> ${esc(route.reason ?? '')} ` +
      (route.kind === 'area'
        ? ''
        : `Rather than draw a guessed line into mountain terrain, the map shows the summit only. ` +
          `To add your own track, save a GPX as <code>data/tracks/${esc(route.slug ?? '')}.gpx</code>.`) +
      `</p>`
    );
  }
  const st = route.profile?.stats;
  const kind = {
    'ski-route': ['Ski-touring route', 'mapped as a ski route in OpenStreetMap'],
    'summer-path': ['Summer path to the summit', 'from OpenStreetMap; the ski line may differ, especially near the top'],
    'own-gpx': ['Your own track', 'from data/tracks'],
  }[route.kind] ?? ['Route', ''];
  const facts = [
    st ? `<strong>${(st.distanceM / 1000).toFixed(1)} km</strong>` : `${(route.lengthM / 1000).toFixed(1)} km`,
    st ? `<strong>${st.ascentM} m</strong> ascent` : null,
    st ? `${st.startEle} → ${st.maxEle} m` : null,
    route.startType ? `from ${{ road: 'the road', parking: 'a car park', hut: 'a hut' }[route.startType]}` : null,
  ].filter(Boolean);
  return (
    `<div class="routehead"><span class="eyebrow">${kind[0]}</span><span class="note">${kind[1]}</span></div>` +
    `<p class="routefacts">${facts.join(' · ')}</p>` +
    (route.endGapM > 40
      ? `<p class="note">The mapped path ends ${route.endGapM} m from the summit. That last stretch is not drawn.</p>`
      : '') +
    (route.profile?.source === 'kartverket-dtm'
      ? `<p class="note">Profile from Kartverket's terrain model (1 m where available, else 10 m). ` +
        `Still not a slope-angle map: for that, see the Varsom slope-angle layer.</p>`
      : route.profile?.source === 'gpx'
        ? `<p class="note">Profile from the elevations in your GPX file.</p>`
        : `<p class="note">Profile is a sketch from a 90 m terrain model, so summits and ridges are rounded off. ` +
          `Use it for distance and climb, not for slope angles; for those, see the Varsom slope-angle map.</p>`) +
    `<div class="linkrow"><a class="btn" href="/api/track.gpx?tour=${encodeURIComponent(tour.name)}" download>Download GPX</a></div>`
  );
}

/* ------------------------------------------------------------------ *
 * forecast
 * ------------------------------------------------------------------ */

const ICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  partly: '<path d="M8 3v1.5M3.8 5.8l1 1M2 10h1.5M12.2 5.8l-1 1"/><path d="M5.5 11a3.5 3.5 0 0 1 6-2.5"/><path d="M8 20h9.5a3.5 3.5 0 0 0 0-7h-.2A5 5 0 0 0 7.6 14 3 3 0 0 0 8 20z"/>',
  cloud: '<path d="M7 18h10.5a4 4 0 0 0 0-8h-.3A6 6 0 0 0 5.6 12 3 3 0 0 0 7 18z"/>',
  fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
  rain: '<path d="M7 14h10.5a4 4 0 0 0 0-8h-.3A6 6 0 0 0 5.6 8 3 3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
  snow: '<path d="M7 13h10.5a4 4 0 0 0 0-8h-.3A6 6 0 0 0 5.6 7 3 3 0 0 0 7 13z"/><path d="M8 16.5v4M6 18.5h4M15 16.5v4M13 18.5h4"/>',
  storm: '<path d="M7 13h10.5a4 4 0 0 0 0-8h-.3A6 6 0 0 0 5.6 7 3 3 0 0 0 7 13z"/><path d="M12 14l-2 4h4l-2 4"/>',
};
const icon = (k) =>
  `<svg class="wx" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON[k] ?? ICON.cloud}</svg>`;

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (iso, i) => (i === 0 ? 'Today' : WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]);
const deg = (v) => (v == null ? '–' : `${v > 0 ? '' : v < 0 ? '−' : ''}${Math.abs(v)}°`);

/**
 * A day's hours as a thin strip: dark outside the usable light, shaded by
 * how good each hour is inside it, the best window outlined.
 */
function hourStrip(w) {
  const W = 96, H = 14, x = (h) => (h / 24) * W;
  const light = w.sun?.light;
  let out = `<svg class="hstrip" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><rect width="${W}" height="${H}" rx="2" fill="var(--night)"/>`;
  if (light) out += `<rect x="${x(light.start).toFixed(1)}" width="${(x(light.end) - x(light.start)).toFixed(1)}" height="${H}" fill="var(--paper)"/>`;
  for (const { h, s } of w.hours ?? []) {
    const b = s >= 0.75 ? 4 : s >= 0.6 ? 3 : s >= 0.45 ? 2 : 1;
    const fill = w.hours.find((q) => q.h === h)?.wet ? 'var(--wet)' : `var(--hw${b})`;
    out += `<rect x="${x(h).toFixed(1)}" y="2" width="${(W / 24 - 0.4).toFixed(1)}" height="${H - 4}" fill="${fill}"/>`;
  }
  if (w.start != null) out += `<rect x="${x(w.start).toFixed(1)}" y="0.5" width="${(x(w.end) - x(w.start)).toFixed(1)}" height="${H - 1}" fill="none" stroke="var(--ink)" stroke-width="1"/>`;
  return `${out}</svg>`;
}

const FIT = { fits: 'fits', tight: 'tight', no: 'too long', dark: 'no light', wet: 'too long before thaw' };

export function renderForecast(el, fc, tour = null, bulletins = []) {
  if (!fc) {
    el.innerHTML = '<p class="note">Loading forecast…</p>';
    return;
  }
  if (fc.error) {
    el.innerHTML = `<p class="note">Forecast unavailable right now (${esc(fc.error)}).</p>`;
    return;
  }
  const days = fc.days ?? [];
  const maxSnow = Math.max(10, ...days.map((d) => d.snowCm ?? 0));
  const cell = (fn) => days.map((d, i) => `<td>${fn(d, i)}</td>`).join('');
  const hourly = fc.hourly && tour ? fc.hourly : null;
  const aspects = tour ? parseAspect(tour.aspect) : [];
  const problemsOn = (date) => {
    const exact = (bulletins ?? []).find((b) => b.date === date);
    const earlier = (bulletins ?? []).filter((b) => b.date && b.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return (exact ?? earlier)?.problems ?? [];
  };
  const wins = hourly ? days.map((d) => dayWindow(tour, hourly, d.date, { aspects, problems: problemsOn(d.date) })) : null;
  const surf = hourly ? days.map((d) => snowQuality(parseAspect(tour.aspect), hourly, d.date)) : null;

  el.innerHTML =
    `<table class="fc">` +
    `<caption class="note">Daily forecast at ${esc(fc.place ?? 'the summit')} (${esc(fc.elevation ?? fc.requestedElevation ?? '?')} m), from Open-Meteo (MET Nordic / ECMWF).</caption>` +
    `<thead><tr><th scope="row"><span class="sr">Day</span></th>${days
      .map((d, i) => `<th scope="col"><span class="eyebrow">${dayName(d.date, i)}</span><span class="fcdate">${d.date.slice(8, 10)}.${d.date.slice(5, 7)}</span></th>`)
      .join('')}</tr></thead><tbody>` +
    `<tr><th scope="row">Sky</th>${cell((d) => `${icon(d.icon)}<span class="fcsub">${esc(d.label)}</span>`)}</tr>` +
    `<tr><th scope="row">Temp</th>${cell((d) => `<strong>${deg(d.tMax)}</strong> <span class="fcsub">${deg(d.tMin)}</span>`)}</tr>` +
    `<tr><th scope="row">New snow</th>${cell((d) => {
      const v = d.snowCm ?? 0;
      const h = Math.max(v > 0 ? 3 : 0, Math.round((v / maxSnow) * 34));
      return `<span class="snowbar" style="height:${h}px;background:${newCol(v)}"></span><span class="fcnum">${v >= 0.5 ? `${Math.round(v)} cm` : '–'}</span>`;
    })}</tr>` +
    `<tr><th scope="row">Precip.</th>${cell((d) => `${d.precipMm != null ? `${d.precipMm} mm` : '–'}`)}</tr>` +
    `<tr><th scope="row">Wind</th>${cell((d) =>
      d.windMax == null
        ? '–'
        : `<span class="wind"><svg viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(${(d.windDeg ?? 0) + 180}deg)"><path d="M6 1 L9 9 L6 7 L3 9 Z" fill="currentColor"/></svg>${d.windMax}</span>` +
          `<span class="fcsub">gust ${d.gustMax ?? '–'} · ${esc(d.windDir ?? '')}</span>`
    )}</tr>` +
    `<tr><th scope="row">0° level</th>${cell((d) => (d.freezingLevel != null ? `${d.freezingLevel} m` : '–'))}</tr>` +
    (wins
      ? `<tr><th scope="row">Daylight</th>${cell((d, i) => `<span class="fcsub">${esc(wins[i] ? daylightText(wins[i].sun) : '–')}</span>`)}</tr>` +
        `<tr class="fcwin"><th scope="row">Best window</th>${cell((d, i) => {
          const w = wins[i];
          if (!w) return '–';
          const off = w.wet?.from != null && w.start != null && w.end <= w.wet.from ? ` · <b class="fcwet">off by ${String(w.wet.from).padStart(2, '0')}</b>` : '';
          return `${hourStrip(w)}<strong>${esc(windowText(w) ?? '–')}</strong><span class="fcsub fit-${w.fit}">${FIT[w.fit]} · ~${w.needH} h${off}</span>`;
        })}</tr>` +
        `<tr><th scope="row">Surface</th>${cell((d, i) => {
          const q = surf[i];
          if (!q) return '–';
          return `<span class="fcsub" title="${esc(q.notes.map((n) => n[0]).join(' · '))}">${esc(q.label)}${q.timing ? ` ${q.timing.start}–${q.timing.end}` : ''}</span>`;
        })}</tr>`
      : '') +
    `</tbody></table>` +
    (wins
      ? `<div class="hlegend"><span class="hlk"><svg viewBox="0 0 14 10" width="14" height="10" aria-hidden="true"><rect width="14" height="10" rx="2" fill="var(--night)"/></svg>no usable light</span>` +
        `<span class="hlk">${[1, 2, 3, 4].map((b) => `<i style="background:var(--hw${b})"></i>`).join('')}hours in the light: poor → very good</span>` +
        `<span class="hlk"><i style="background:var(--wet)"></i>wet-snow hours</span>` +
        `<span class="hlk"><svg viewBox="0 0 14 10" width="14" height="10" aria-hidden="true"><rect x=".5" y=".5" width="13" height="9" fill="none" stroke="var(--ink)"/></svg>best window</span>` +
        `<span class="hlnote">Strip = one day, midnight to midnight, noon in the middle. Each hour in the light is scored on wind, cloud and snow/rain; gusts ≥ 17 m/s make it poor. Wet-snow hours start when it goes above freezing at the tour's mid-height, or in spring when the sun reaches the descent aspect; with a wet-snow problem in the bulletin the window must end before them.</span></div>`
      : '') +
    `<p class="note">Wind in m/s. 0° level is the daytime maximum; above your summit means rain or wet snow on the whole tour.` +
    (wins ? ` Best window: the stretch of daylight, as long as the tour takes (~${wins.find(Boolean)?.needH ?? '?'} h at 400 m/h up), with the best hourly wind, cloud and snowfall. Surface is for the descent aspect (${esc(tour.aspect ?? 'all')}), from the wind while it snowed, warming and the corn cycle; hover for why.` : '') +
    `</p>`;
}

/* ------------------------------------------------------------------ *
 * a ski resort's runs and lifts
 * ------------------------------------------------------------------ */

export const DIFF_LABEL = { novice: 'novice', easy: 'easy', intermediate: 'intermediate', advanced: 'advanced', expert: 'expert', freeride: 'freeride' };
const diffVar = (d) => `var(--pd-${d ?? 'unknown'})`;
// Text on a difficulty badge: dark on the pale steps, light on the dark ones.
const DIFF_TEXT = { novice: 'var(--pd-text-dark)', easy: 'var(--pd-text-dark)', unknown: 'var(--pd-text-dark)' };
const GROOMING = { classic: 'groomed', mogul: 'moguls', backcountry: 'not groomed', 'classic+skating': 'classic and skating', 'classic;skating': 'classic and skating', skating: 'skating', scooter: 'scooter track' };

/**
 * Everything OpenStreetMap has on the ski area, drawn in the tour maps'
 * quiet style: the grey topo map and contours underneath, runs in the
 * profile's ramp by difficulty (pale for novice, through pink and red to
 * maroon and black for expert), floodlit runs dotted, lifts as ink lines
 * with cross ticks, their pylons and named stations with heights, lift and
 * run numbers, cross-country trails, sledging, the snow park, and where to
 * eat, rent and learn. Hover anything for its details.
 */
export function renderResortMap(el, { resort, data = null, country }) {
  const W = 560, H = 400;
  const geo = data ? [...(data.runs ?? []), ...(data.lifts ?? []), ...(data.areas ?? []), ...(data.parks ?? [])].flatMap((x) => x.points) : [];
  const base = { lat: resort.lat, lon: resort.lon };
  const pts = [...geo, base];
  const xs = pts.map((p) => mx(p.lon)), ys = pts.map((p) => my(p.lat));
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const f0 = frame(pts, W, H, 26);
  // Fill the frame with the ski area: a fractional zoom, the tiles of the
  // level below scaled up to it (a tour map snaps to whole levels).
  const zf = geo.length ? Math.max(9, Math.min(16.5, Math.min(Math.log2((W - 60) / (spanX * TILE)), Math.log2((H - 60) / (spanY * TILE))))) : f0.z;
  const z = Math.min(15, Math.floor(zf));
  const scale = TILE * 2 ** zf;
  const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * scale, cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * scale;
  const f = { z: zf, scale, x0: cx - W / 2, y0: cy - H / 2, W, H };
  const TS = TILE * 2 ** (zf - z);
  const src = country === 'SE' ? 'se' : 'no';
  const P = (p) => px(f, p);
  const pl = (list) => list.map((p) => P(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

  const tiles = [];
  for (let tx = Math.floor(f.x0 / TS); tx <= Math.floor((f.x0 + W) / TS); tx++) {
    for (let ty = Math.floor(f.y0 / TS); ty <= Math.floor((f.y0 + H) / TS); ty++) {
      tiles.push(`<image href="/tiles/${src}/${z}/${tx}/${ty}.png" x="${(tx * TS - f.x0).toFixed(1)}" y="${(ty * TS - f.y0).toFixed(1)}" width="${TS.toFixed(1)}" height="${TS.toFixed(1)}" preserveAspectRatio="none" onerror="this.remove()"/>`);
    }
  }
  const contourSvg = [];
  if (data?.terrain?.z?.length) {
    for (const c of contours(data.terrain)) {
      for (const lineGeo of c.lines) {
        const pix = smooth(lineGeo.map((g) => P(g)));
        if (pix.length < 2) continue;
        contourSvg.push(`<polyline points="${pix.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--coast)" stroke-width="${c.index ? 1.1 : 0.55}" opacity="${c.index ? 0.75 : 0.45}"/>`);
      }
    }
  }

  // Labels are placed greedily and skipped when they would collide.
  const taken = [[W - 40, 0, W, 50], [0, H - 34, 150, H]];
  const free = (b) => !taken.some((t) => b[0] < t[2] && t[0] < b[2] && b[1] < t[3] && t[1] < b[3]) && b[0] > 2 && b[1] > 2 && b[2] < W - 2 && b[3] < H - 2;
  const labels = [];

  const d = data ?? {};
  const boundary = d.boundary ? `<polygon points="${pl(d.boundary.points)}" class="rmbound"><title>${esc(d.boundary.name ?? 'Ski area')}</title></polygon>` : '';
  const nordic = (d.nordic ?? []).map((n) =>
    `<g class="rmnordic"><title>${esc(n.name ?? 'Cross-country trail')} · cross-country${n.grooming ? `, ${esc(GROOMING[n.grooming] ?? n.grooming)}` : ''}${n.lit ? ', floodlit' : ''} · ${km(n.lengthM)}</title>` +
    `<polyline points="${pl(n.points)}" class="rmhalo thin"/><polyline points="${pl(n.points)}" class="rmnordicline"/></g>`).join('');
  const sled = (d.sled ?? []).map((n) =>
    `<g><title>${esc(n.name ?? 'Sledging run')} · sledging · ${km(n.lengthM)}</title><polyline points="${pl(n.points)}" class="rmhalo thin"/><polyline points="${pl(n.points)}" class="rmsled"/></g>`).join('');
  const parks = (d.parks ?? []).map((n) => n.area
    ? `<polygon points="${pl(n.points)}" class="rmpark"><title>${esc(n.name ?? 'Snow park')} · snow park</title></polygon>`
    : `<polyline points="${pl(n.points)}" class="rmparkline"><title>${esc(n.name ?? 'Snow park')} · snow park</title></polyline>`).join('');
  const areas = (d.areas ?? []).map((a) => `<polygon points="${pl(a.points)}" fill="${diffVar(a.difficulty)}" fill-opacity=".22" stroke="none"><title>${esc(a.name ?? 'Piste area')}</title></polygon>`).join('');

  // Runs: easiest first, so the harder (darker) lines sit on top where they share a path.
  const order = ['unknown', 'novice', 'easy', 'intermediate', 'advanced', 'expert', 'freeride'];
  const runsSorted = [...(d.runs ?? [])].sort((a, b) => order.indexOf(a.difficulty ?? 'unknown') - order.indexOf(b.difficulty ?? 'unknown'));
  const runs = runsSorted.map((r) => {
    const notes = [r.grooming ? GROOMING[r.grooming] ?? r.grooming : null, r.lit ? 'floodlit' : null, r.snowmaking ? 'snowmaking' : null, r.gladed ? 'in the trees' : null].filter(Boolean).join(', ');
    const title = `<title>${r.ref ? `${esc(r.ref)} ` : ''}${esc(r.name ?? 'Unnamed run')} · ${esc(DIFF_LABEL[r.difficulty] ?? 'difficulty not mapped')} · ${km(r.lengthM)}${notes ? ` · ${esc(notes)}` : ''}</title>`;
    const dash = r.difficulty === 'freeride' || /backcountry/.test(r.grooming ?? '') ? ' stroke-dasharray="5 3.5"' : '';
    return `<g class="rmrun">${title}<polyline points="${pl(r.points)}" class="rmcase"${dash}/>` +
      `<polyline points="${pl(r.points)}" fill="none" stroke="${diffVar(r.difficulty)}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"${dash}/>` +
      (r.lit ? `<polyline points="${pl(r.points)}" class="rmlit"/>` : '') + `</g>`;
  }).join('');

  // Lifts: line, cross ticks along the cable, pylons as dots, stations as squares.
  const lifts = (d.lifts ?? []).map((l) => {
    const pix = l.points.map(P);
    const facts = [l.kindName, l.occupancy ? `${l.occupancy} ${l.kind === 'gondola' || l.kind === 'cable_car' ? 'per cabin' : l.drag ? 'per hanger' : 'seats'}` : null,
      l.capacity ? `${l.capacity.toLocaleString('en-GB')} people/h` : null, km(l.lengthM), l.duration ? `${l.duration} min ride` : null,
      l.bubble ? 'bubble' : null, l.heating ? 'heated seats' : null, l.detachable ? 'detachable' : null,
      l.pylons?.length ? `${l.pylons.length} pylons` : null].filter(Boolean).join(' · ');
    const title = `<title>${l.ref ? `${esc(l.ref)} ` : ''}${esc(l.name ?? 'Lift')} · ${esc(facts)}</title>`;
    let ticks = '';
    if (!l.drag) {
      for (let k = 1; k < pix.length; k++) {
        const [x1, y1] = pix[k - 1], [x2, y2] = pix[k];
        const len = Math.hypot(x2 - x1, y2 - y1);
        const ux = (x2 - x1) / (len || 1), uy = (y2 - y1) / (len || 1);
        for (let j = 1; j * 16 < len - 5; j++) {
          const cx2 = x1 + ux * j * 16, cy2 = y1 + uy * j * 16;
          ticks += `M${(cx2 - uy * 3.2).toFixed(1)} ${(cy2 + ux * 3.2).toFixed(1)}L${(cx2 + uy * 3.2).toFixed(1)} ${(cy2 - ux * 3.2).toFixed(1)}`;
        }
      }
    }
    const pylons = (l.pylons ?? []).map((p) => { const q = P(p); return `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="1.5" class="rmpylon"/>`; }).join('');
    const st = (q) => `<rect x="${(q[0] - 3).toFixed(1)}" y="${(q[1] - 3).toFixed(1)}" width="6" height="6" class="rmstation"/>`;
    return `<g class="rmlift">${title}<polyline points="${pl(l.points)}" class="rmhalo thin"/>` +
      `<polyline points="${pl(l.points)}" fill="none" stroke="var(--ink)" stroke-width="1.3"${l.drag ? ' stroke-dasharray="5 3"' : ''}/>` +
      (ticks ? `<path d="${ticks}" stroke="var(--ink)" stroke-width="1"/>` : '') + pylons + st(pix[0]) + st(pix[pix.length - 1]) + `</g>`;
  }).join('');

  // Lift names along the cable, upright, where there is room.
  for (const l of [...(d.lifts ?? [])].sort((a, b) => b.lengthM - a.lengthM)) {
    if (!l.name && !l.ref) continue;
    const a = P(l.points[0]), b = P(l.points[l.points.length - 1]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const text = `${l.ref ? `${l.ref} ` : ''}${l.name ?? ''}`.trim();
    const tw = text.length * 5.4;
    if (len < tw + 30) continue;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const r = Math.max(Math.abs(Math.cos((ang * Math.PI) / 180)) * tw, 12) / 2, h = Math.max(Math.abs(Math.sin((ang * Math.PI) / 180)) * tw, 10) / 2;
    // Try along the cable and on either side of it; skip if nothing is free.
    let spot = null;
    for (const t of [0.5, 0.35, 0.65, 0.22, 0.78]) {
      for (const side of [1, -1]) {
        const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const nx = -Math.sin((ang * Math.PI) / 180) * 7 * side, ny = Math.cos((ang * Math.PI) / 180) * 7 * side;
        const box = [m[0] + nx - r, m[1] + ny - h, m[0] + nx + r, m[1] + ny + h];
        if (free(box)) { spot = { lx: m[0] + nx, ly: m[1] + ny, box }; break; }
      }
      if (spot) break;
    }
    if (!spot) continue;
    const { lx, ly, box } = spot;
    taken.push(box);
    labels.push(`<text transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(${ang.toFixed(1)})" text-anchor="middle" y="3" class="rmliftname">${esc(text)}</text>`);
  }

  // Run numbers (or names): one badge per named run, on its longest piece.
  const runBadges = new Map();
  for (const r of d.runs ?? []) {
    const key = `${r.ref ?? ''}|${r.name ?? ''}`;
    if (!r.ref && !r.name) continue;
    if (!runBadges.has(key) || runBadges.get(key).lengthM < r.lengthM) runBadges.set(key, r);
  }
  for (const r of runBadges.values()) {
    const pix = r.points.map(P);
    const text = r.ref ?? r.name;
    const w = r.ref ? Math.max(14, text.length * 6.2 + 6) : text.length * 5.6 + 8;
    let m = null, box = null;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const q = pix[Math.round((pix.length - 1) * t)];
      const bx2 = [q[0] - w / 2, q[1] - 7, q[0] + w / 2, q[1] + 7];
      if (free(bx2)) { m = q; box = bx2; break; }
    }
    if (!m) continue;
    taken.push(box);
    labels.push(
      `<g transform="translate(${m[0].toFixed(1)} ${m[1].toFixed(1)})" class="rmbadge"><title>${esc(r.name ?? '')}</title>` +
      `<rect x="${(-w / 2).toFixed(1)}" y="-7" width="${w.toFixed(1)}" height="14" rx="7" fill="${diffVar(r.difficulty)}" stroke="var(--paper)" stroke-width="1.2"/>` +
      `<text y="3.4" text-anchor="middle" fill="${DIFF_TEXT[r.difficulty ?? 'unknown'] ?? 'var(--pd-text-light)'}">${esc(text)}</text></g>`
    );
  }

  // Named stations with their height, highest first.
  const seen = new Set();
  const stationLabels = (d.lifts ?? []).flatMap((l) => [
    { name: l.stationA, p: l.points[0], z: l.za }, { name: l.stationB, p: l.points[l.points.length - 1], z: l.zb },
  ]).filter((s) => s.name && !seen.has(s.name) && seen.add(s.name)).sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  for (const s of stationLabels) {
    const q = P(s.p);
    const text = `${s.name}${Number.isFinite(s.z) ? ` ${s.z} m` : ''}`;
    const w = text.length * 5.6;
    for (const [dx, anchor] of [[7, 'start'], [-7, 'end']]) {
      const box = anchor === 'start' ? [q[0] + dx, q[1] - 12, q[0] + dx + w, q[1] - 1] : [q[0] + dx - w, q[1] - 12, q[0] + dx, q[1] - 1];
      if (!free(box)) continue;
      taken.push(box);
      labels.push(`<text x="${(q[0] + dx).toFixed(1)}" y="${(q[1] - 4).toFixed(1)}" text-anchor="${anchor}" class="rmstationname">${esc(text)}</text>`);
      break;
    }
  }

  // Where to eat, rent and learn: small symbols.
  const POI_GLYPH = {
    restaurant: '<path d="M-2 -3.5 V3.5 M-3.2 -3.5 V-0.5 H-0.8 V-3.5 M2 -3.5 C3.4 -2.5 3.4 0 2 0.6 V3.5" />',
    café: '<path d="M-3 -1.5 H2 V1.5 C2 3 -3 3 -3 1.5 Z M2 -0.8 C3.6 -0.8 3.6 1.2 2 1.2" />',
    bar: '<path d="M-3 -3 H3 L0 0.5 Z M0 0.5 V3.2 M-1.8 3.2 H1.8" />',
    kiosk: '<path d="M-3 -3 H3 V3 H-3 Z" />',
    'ski rental': '<path d="M-2.2 3.5 L-0.8 -3.5 M2.2 3.5 L0.8 -3.5" />',
    'ski school': '<path d="M0 -3.5 L3.5 -1.5 L0 0.5 L-3.5 -1.5 Z M-2 -0.6 V2 C-1 3.3 1 3.3 2 2 V-0.6" />',
    hut: '<path d="M-3.5 0 L0 -3.5 L3.5 0 V3.5 H-3.5 Z" />',
  };
  const pois = (d.pois ?? []).map((p) => {
    const q = P(p);
    if (q[0] < 6 || q[1] < 6 || q[0] > W - 6 || q[1] > H - 6) return '';
    return `<g transform="translate(${q[0].toFixed(1)} ${q[1].toFixed(1)})" class="rmpoi"><title>${esc(p.name ?? p.kind)} · ${esc(p.kind)}</title>` +
      `<circle r="6.2"/>${POI_GLYPH[p.kind] ?? ''}</g>`;
  }).join('');

  // Legend: only what is on the map, under it.
  const present = new Set([...(d.runs ?? []), ...(d.areas ?? [])].map((r) => r.difficulty ?? 'unknown'));
  const legendRuns = ['novice', 'easy', 'intermediate', 'advanced', 'expert', 'freeride', 'unknown'].filter((x) => present.has(x))
    .map((x) => [`<line x1="0" x2="16" y1="0" y2="0" stroke="${diffVar(x)}" stroke-width="3"${x === 'freeride' ? ' stroke-dasharray="5 3.5"' : ''}/>`, x === 'unknown' ? 'run, not graded' : DIFF_LABEL[x]]);
  const extra = [];
  if ((d.runs ?? []).some((r) => r.lit)) extra.push(['<line x1="0" x2="16" y1="0" y2="0" stroke="var(--pd-intermediate)" stroke-width="3"/><line x1="0" x2="16" y1="0" y2="0" class="rmlit"/>', 'floodlit']);
  if ((d.lifts ?? []).some((l) => !l.drag)) extra.push(['<line x1="0" x2="16" y1="0" y2="0" stroke="var(--ink)" stroke-width="1.3"/><path d="M5 -3 V3 M11 -3 V3" stroke="var(--ink)"/><rect x="-2.5" y="-2.5" width="5" height="5" class="rmstation"/>', 'chair, gondola']);
  if ((d.lifts ?? []).some((l) => l.drag)) extra.push(['<line x1="0" x2="16" y1="0" y2="0" stroke="var(--ink)" stroke-width="1.3" stroke-dasharray="5 3"/>', 'drag lift']);
  if ((d.nordic ?? []).length) extra.push(['<line x1="0" x2="16" y1="0" y2="0" class="rmnordicline"/>', 'cross-country']);
  if ((d.sled ?? []).length) extra.push(['<line x1="0" x2="16" y1="0" y2="0" class="rmsled"/>', 'sledging']);
  if ((d.parks ?? []).length) extra.push(['<rect x="0" y="-4" width="16" height="8" class="rmpark"/>', 'snow park']);
  if ((d.pois ?? []).length) extra.push(['<g transform="translate(8 0)" class="rmpoi"><circle r="5"/>' + POI_GLYPH.restaurant + '</g>', 'food, rental, school']);
  const legend = [...legendRuns, ...extra].length
    ? `<div class="rmlegend">${[...legendRuns, ...extra].map(([sym, label]) => `<span><svg width="20" height="10" aria-hidden="true" overflow="visible"><g transform="translate(2 5)">${sym}</g></svg>${esc(label)}</span>`).join('')}</div>`
    : '';

  const [bx, by] = P(base);
  const sb = scaleBar(f, base.lat);
  el.innerHTML =
    `<svg class="routesvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the runs and lifts at ${esc(resort.name)}">` +
    `<rect width="${W}" height="${H}" fill="var(--page)"/>` +
    `<g class="contours">${contourSvg.join('')}</g><g class="tiles">${tiles.join('')}</g>` +
    boundary + nordic + sled + parks + areas + `<g class="rmruns">${runs}</g>` + `<g class="rmlifts">${lifts}</g>` + pois + labels.join('') +
    (geo.length ? '' : `<path d="M${bx.toFixed(1)} ${(by - 9).toFixed(1)} l7.5 12.5 h-15 Z" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.5"/>` +
      `<text x="${bx.toFixed(1)}" y="${(by - 15).toFixed(1)}" text-anchor="middle" class="maplabel">${esc(resort.name)}</text>`) +
    `<g transform="translate(14 ${H - 18})"><rect x="-6" y="-16" width="${(sb.px + 58).toFixed(0)}" height="26" rx="4" fill="var(--paper)" opacity=".92"/>` +
    `<line x1="0" x2="${sb.px.toFixed(1)}" y1="0" y2="0" stroke="var(--ink)" stroke-width="2"/>` +
    `<line x1="0" x2="0" y1="-4" y2="4" stroke="var(--ink)" stroke-width="2"/><line x1="${sb.px.toFixed(1)}" x2="${sb.px.toFixed(1)}" y1="-4" y2="4" stroke="var(--ink)" stroke-width="2"/>` +
    `<text x="${(sb.px + 8).toFixed(1)}" y="4" class="maplabel">${sb.label}</text></g>` +
    `<g transform="translate(${W - 24} 28)"><path d="M0 -12 L6 4 L0 0 L-6 4 Z" fill="var(--ink)"/><text y="18" text-anchor="middle" class="maplabel">N</text></g>` +
    `</svg>` + legend;
}

/* ------------------------------------------------------------------ *
 * photos near the summit
 * ------------------------------------------------------------------ */

export function renderPhotos(el, data, tour, mapEl, offset = 0) {
  if (!data) {
    el.innerHTML = '<p class="note">Looking for photos near the summit…</p>';
    return;
  }
  const photos = data.photos ?? [];
  if (data.error || !photos.length) {
    // Nothing openly licensed for this summit: draw it instead, from the
    // terrain model, looking down the side you would ski.
    const drawn = data.terrain ? reliefSvg(data.terrain, tour) : null;
    // Say why there is no photo, when it's not just that none exist.
    const why = [
      data.errors?.commons ? `Wikimedia Commons could not be reached (${esc(data.errors.commons)}).` : null,
      data.errors?.flickr ? `Flickr could not be reached (${esc(data.errors.flickr)}).` : null,
      data.flickr === false ? 'Flickr is not searched: add a free FLICKR_API_KEY to .env to include it.' : null,
    ].filter(Boolean);
    const whyHtml = why.length ? `<p class="note">${why.join(' ')}</p>` : '';
    el.innerHTML = whyHtml + (drawn
      ? drawn +
        `<p class="note"><a href="https://commons.wikimedia.org/wiki/Special:Nearby#/coord/${tour.lat},${tour.lon}" target="_blank" rel="noopener">Browse Commons near this summit</a>` +
        ` — and your own photos can go in with the tour editor.</p>`
      : `<p class="note">${data.error ? 'Photos could not be loaded right now.' : 'No openly licensed photo of this summit yet, and no terrain grid to draw one from.'}` +
        ` <a href="https://commons.wikimedia.org/wiki/Special:Nearby#/coord/${tour.lat},${tour.lon}" target="_blank" rel="noopener">Browse Commons nearby</a>.</p>`);
    return;
  }
  const q = encodeURIComponent(tour.name);
  el.innerHTML =
    `<div class="photogrid">` +
    photos
      .map(
        (p, k) =>
          `<a class="photo" data-photo="${k + offset}" href="${esc(p.pageUrl)}" target="_blank" rel="noopener" title="Open on ${p.source === 'flickr' ? 'Flickr' : 'Wikimedia Commons'}">` +
          `<span class="photonumtag">${k + offset + 1}</span>` +
          `<img src="/api/photo?tour=${q}&i=${p.i ?? k}" alt="${esc(p.title)}" loading="lazy" onerror="this.closest('.photo').classList.add('noimg')">` +
          `<span class="photocap"><strong>${esc(p.from)}</strong>` +
          `<span>© ${esc(p.author)} · ${esc(p.license)}${p.date ? ` · ${esc(p.date)}` : ''}</span></span></a>`
      )
      .join('') +
    `</div><p class="note">Openly licensed photos from Wikimedia Commons${photos.some((p) => p.source === 'flickr') ? ' and Flickr' : ''}, ` +
    `near the summit or carrying its name. Numbers match the markers on the map; a photo without a position has no marker. ` +
    `Photos show the place, not today's conditions.</p>`;

  linkPhotoHover(el, mapEl);
}

/* ------------------------------------------------------------------ *
 * your own photos (data/photos/<slug>/, made with the tour editor)
 * ------------------------------------------------------------------ */

export function renderOwnPhotos(el, photos, tour, mapEl) {
  const q = encodeURIComponent(tour.name);
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  el.innerHTML =
    `<div class="photogrid">` +
    photos
      .map(
        (p, k) =>
          `<a class="photo own" data-photo="${k}" href="/api/own-photo?tour=${q}&i=${p.i}" target="_blank" rel="noopener" title="Open full size">` +
          `<span class="photonumtag">${k + 1}</span>` +
          `<img src="/api/own-photo?tour=${q}&i=${p.i}" alt="${esc(p.caption || tour.name)}" loading="lazy" onerror="this.closest('.photo').classList.add('noimg')">` +
          `<span class="photocap">${p.caption ? `<strong>${esc(p.caption)}</strong>` : ''}` +
          `<span>${[p.credit && `© ${esc(p.credit)}`, when(p.takenAt), p.located ? 'on the map' : 'no position']
            .filter(Boolean).join(' · ')}</span></span></a>`
      )
      .join('') +
    `</div>`;
  linkPhotoHover(el, mapEl);
}

/** Hover a card: highlight its marker on the map, and the reverse. */
function linkPhotoHover(el, mapEl) {
  const mark = (k, on) => {
    mapEl?.querySelector(`.photomk[data-photo="${k}"]`)?.classList.toggle('on', on);
    el.querySelector(`.photo[data-photo="${k}"]`)?.classList.toggle('on', on);
  };
  el.querySelectorAll('.photo').forEach((a) => {
    a.addEventListener('pointerenter', () => mark(a.dataset.photo, true));
    a.addEventListener('pointerleave', () => mark(a.dataset.photo, false));
  });
  mapEl?.querySelectorAll('.photomk').forEach((g) => {
    g.addEventListener('pointerenter', () => mark(g.dataset.photo, true));
    g.addEventListener('pointerleave', () => mark(g.dataset.photo, false));
    g.addEventListener('click', () => el.querySelector(`.photo[data-photo="${g.dataset.photo}"]`)?.click());
  });
}
