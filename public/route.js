/**
 * Tour detail views: topo route map, elevation sketch, 5-day forecast.
 * Rendered as plain SVG/HTML, no map or chart library.
 */

import { contours, smooth } from './contours.js';

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

export function renderRouteMap(el, { route, tour, country, terrain = null, photos = [] }) {
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
      const [x, y] = px(f, ph);
      if (x < 8 || y < 8 || x > W - 8 || y > H - 8) return '';
      return (
        `<g class="photomk" data-photo="${k}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        `<rect x="-8" y="-8" width="16" height="16" rx="3" fill="var(--paper)" stroke="var(--ink)" stroke-width="1.5"/>` +
        `<text y="4" text-anchor="middle" class="photonum">${k + 1}</text></g>`
      );
    })
    .join('');

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

export function renderForecast(el, fc) {
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

  el.innerHTML =
    `<table class="fc">` +
    `<caption class="note">Daily forecast at the summit (${esc(fc.elevation ?? fc.requestedElevation ?? '?')} m), from Open-Meteo (MET Nordic / ECMWF).</caption>` +
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
    `</tbody></table>` +
    `<p class="note">Wind in m/s. 0° level is the daytime maximum; above your summit means rain or wet snow on the whole tour.</p>`;
}

/* ------------------------------------------------------------------ *
 * photos near the summit
 * ------------------------------------------------------------------ */

export function renderPhotos(el, data, tour, mapEl) {
  if (!data) {
    el.innerHTML = '<p class="note">Looking for photos near the summit…</p>';
    return;
  }
  const photos = data.photos ?? [];
  if (data.error || !photos.length) {
    el.innerHTML =
      `<p class="note">${data.error ? 'Photos could not be loaded right now.' : 'No openly licensed, geotagged photos near this summit on Wikimedia Commons yet.'}` +
      ` <a href="https://commons.wikimedia.org/wiki/Special:Nearby#/coord/${tour.lat},${tour.lon}" target="_blank" rel="noopener">Browse Commons nearby</a>.</p>`;
    return;
  }
  const q = encodeURIComponent(tour.name);
  el.innerHTML =
    `<div class="photogrid">` +
    photos
      .map(
        (p, k) =>
          `<a class="photo" data-photo="${k}" href="${esc(p.pageUrl)}" target="_blank" rel="noopener" title="Open on Wikimedia Commons">` +
          `<span class="photonumtag">${k + 1}</span>` +
          `<img src="/api/photo?tour=${q}&i=${p.i ?? k}" alt="${esc(p.title)}" loading="lazy" onerror="this.closest('.photo').classList.add('noimg')">` +
          `<span class="photocap"><strong>${esc(p.from)}</strong>` +
          `<span>© ${esc(p.author)} · ${esc(p.license)}${p.date ? ` · ${esc(p.date)}` : ''}</span></span></a>`
      )
      .join('') +
    `</div><p class="note">Openly licensed photos within 5 km of the summit, from Wikimedia Commons. ` +
    `Numbers match the markers on the map. Photos show the place, not today's conditions.</p>`;

  // Hover a card: highlight its marker on the map, and the reverse.
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
