import { COAST, BORDER } from './geo.js';
import { planTrip } from './areaplan.js';
import { snowHistoryModel, snowHistorySvg, linkSnowHistoryHover } from './snowhistory.js';
import { renderRouteMap, renderProfile, routeSummary, renderForecast, renderPhotos, renderOwnPhotos, renderResortMap } from './route.js';
import { layoutResorts, resortSvg, OPEN_BANDS } from './resorts.js';
import { plan, haversineKm as haversine } from './planner.js';
import { explainHtml } from './explain.js';
import { aspectRose } from './aspect.js';
import { factsHtml, DIFF_NAMES } from './resortfacts.js';
import { simulate, simulateResorts, simulateHuts } from './simulate.js';
import { dangerChip, problemIcons, problemIcon, problemRose, elevationDiagram, elevationText, initAvalancheTips, problemKey, PROBLEMS } from './avalanche.js';
import { COUNTRIES, GROUPS, countryName, joinNames, normaliseSelection, fitFrame } from './countries.js';

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = {
  snapshot: null,
  alerts: null,
  layer: 'depth',
  showTours: true,
  showResorts: false,
  showHuts: false,
  huts: null,
  outlook: null,
  planDay: 0,
  resorts: null,
  // Map zoom: scale k about the centre (cx, cy) in unzoomed map units.
  view: { k: 1, cx: 280, cy: 380 },
  sel: null,
  selRegion: null,
  q: '',
  simulated: false,
  // Selected countries: the first filter for the whole page.

  countries: [],
  track: '',
  region: '',
  grade: '',
  sort: 'quality',
};

const FAV_KEY = 'toppturvarsel.favs.v1';
let FAVS = readStore(FAV_KEY, {});

function readStore(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode; favourites are a convenience, not state we depend on */
  }
}

/**
 * Snow is shown in whole centimetres. The model reports tenths, but a tenth
 * of a centimetre of modelled snow in a 1 km cell is precision the data does
 * not have; the raw values stay in the API for anyone who wants them.
 */
const cm = (v) => (v == null ? v : Math.round(v));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const regionById = () => Object.fromEntries((state.snapshot?.regions ?? []).map((r) => [r.id, r]));

/* ------------------------------------------------------------------ *
 * data
 * ------------------------------------------------------------------ */

async function load() {
  const [condRes, alertRes] = await Promise.allSettled([
    fetch('/api/conditions').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch('/api/alerts').then((r) => (r.ok ? r.json() : null)),
  ]);

  if (condRes.status === 'rejected') {
    $('#freshTxt').textContent = 'no data yet';
    $('#freshDot').className = 'dot bad';
    $('#tourlist').innerHTML =
      '<div class="skeleton">No snapshot yet. The first refresh may still be running — ' +
      'press “Refresh now”, or check <code>/api/health</code>.</div>';
    $('#alerts').innerHTML = '<p class="quiet">Waiting for the first data refresh.</p>';
    return;
  }

  state.snapshot = condRes.value;
  state.alerts = alertRes.status === 'fulfilled' ? alertRes.value : null;
  initCountries();
  loadTracks();
  // A refresh refreshes the resort status too, when it has been loaded
  // (for the layer, or for the trip planner's resort-day hint).
  if (state.showResorts || state.resorts) loadResorts();
  loadOutlook();

  renderFreshness();
  renderCountryBar();
  fillRegionSelect();
  renderAlerts();
  renderList();
  renderSources();
  drawMap();
}

function renderFreshness() {
  const snap = state.snapshot;
  if (state.simulated) {
    $('#freshDot').className = 'dot warn';
    $('#freshTxt').textContent = 'simulated data — not a forecast';
    return;
  }
  const ageMin = Math.round((Date.now() - new Date(snap.fetchedAt).getTime()) / 60000);
  const dot = $('#freshDot');
  const txt = $('#freshTxt');

  if (snap.status === 'out-of-season') {
    dot.className = 'dot';
    txt.textContent = 'out of season — no bulletins published';
  } else if (ageMin < 240) {
    dot.className = 'dot ok';
    txt.textContent = `updated ${ageMin < 2 ? 'just now' : `${ageMin} min ago`}`;
  } else {
    dot.className = 'dot warn';
    txt.textContent = `data is ${Math.round(ageMin / 60)} h old`;
  }
}

/* ------------------------------------------------------------------ *
 * map
 * ------------------------------------------------------------------ */

// The frame follows the country selection (see countries.js); the width is
// fixed and the height follows the shape of what is selected.
const MAP_W = 560;
let MAP_H = 760;
let frame = fitFrame([COUNTRIES.NO.frame, COUNTRIES.SE.frame], { width: MAP_W });
const baseProj = (lat, lon) => ({
  x: frame.ox + (lon - frame.lon0) * Math.cos((lat * Math.PI) / 180) * frame.s,
  y: frame.oy - lat * frame.s,
});

/** Re-frame the map to the selected countries and reset the zoom. */
function reframe() {
  const boxes = state.countries.map((c) => COUNTRIES[c]?.frame).filter(Boolean);
  frame = fitFrame(boxes, { width: MAP_W });
  MAP_H = frame.height;
  state.view = { k: 1, cx: MAP_W / 2, cy: MAP_H / 2 };
  $('#map').setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);
}
const inSel = (country) => state.countries.includes(country);
// Zoom moves the geography, not the markers: positions scale, marker and
// text sizes stay the same, so zooming in separates crowded resorts.
const proj = (lat, lon) => {
  const b = baseProj(lat, lon), v = state.view;
  return { x: (b.x - v.cx) * v.k + MAP_W / 2, y: (b.y - v.cy) * v.k + MAP_H / 2 };
};
// Resorts get their icons and names from this zoom on.
const DETAIL_K = 3;

function pathFrom(pts, close) {
  const d = pts
    .map((p, i) => {
      const q = proj(p[0], p[1]);
      return `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    })
    .join(' ');
  return close ? `${d} Z` : d;
}

/* ------------------------------------------------------------------ *
 * colour — Molker graphical profile
 *
 * The profile's grammar, applied literally:
 *  - bulk data in grayscale ink            -> snow depth ramp
 *  - one single-hue white->maroon ramp     -> new snow (the loading signal)
 *  - signal red for the critical point     -> powder alerts only
 * The one deliberate exception is avalanche danger, which keeps the EAWS
 * standard colours: every tourer in Europe reads green/yellow/orange/red/black
 * the same way, and a safety scale is not the place for a house style.
 * ------------------------------------------------------------------ */

const RED = '#C0392B';

// EAWS standard danger-scale colours. Level 5 is officially black/red
// chequered; we draw it black with a red rim.
const DANGER_COL = [null, '#CCFF66', '#FFFF00', '#FF9900', '#FF0000', '#1A1A1A'];

// Grayscale depth ramp built only from the profile's neutrals
// (paper -> line -> steel -> ink).
const DEPTH_BANDS = [
  [30, '#F4F3EF', '<30 cm'],
  [60, '#E3E0D8', '30–60'],
  [100, '#B5B1A8', '60–100'],
  [160, '#8C8880', '100–160'],
  [250, '#4A473F', '160–250'],
  [Infinity, '#1A1A1A', '250+'],
];

// The thesis's Fig. 26 ramp, all six steps. The alert threshold (30 cm)
// lands on #C2402A, so "red on the map" and "red alert" mean the same thing.
const NEW_BANDS = [
  [5, '#FDF1ED', '<5 cm'],
  [10, '#FBD6CB', '5–10'],
  [20, '#F4A891', '10–20'],
  [30, '#E8734F', '20–30'],
  [50, '#C2402A', '30–50'],
  [Infinity, '#6E1E15', '50+'],
];

const band = (bands, v) => (v == null ? null : bands.find(([max]) => v < max)[1]);
const depthCol = (cm) => band(DEPTH_BANDS, cm);
const newCol = (cm) => band(NEW_BANDS, cm);

/** Ink or paper text, whichever reads on the given fill. */
function textOn(hex) {
  if (!hex || hex[0] !== '#') return 'var(--ink)';
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.28 ? '#1A1A1A' : '#FFFFFF';
}

const regionValue = (r) => {
  if (state.layer === 'danger') return r.bulletin?.danger ?? null;
  if (state.layer === 'new48') return r.snow?.new48 ?? null;
  return r.snow?.depthCm ?? null;
};

function fillFor(r) {
  const v = regionValue(r);
  if (state.layer === 'danger') return v ? DANGER_COL[v] : null;
  if (state.layer === 'new48') return newCol(v);
  return depthCol(v);
}

/**
 * Region markers are kept deliberately small. The Troms/Lofoten regions sit
 * within ~60 km of each other, so a scale generous enough to look good in
 * the south turns the north into one unreadable blob exactly when it matters
 * most - a big northern storm is when every circle is at maximum size.
 */
function radiusFor(r) {
  const v = regionValue(r);
  if (state.layer === 'danger') return v == null ? 6 : 7.5 + v * 1.1;
  if (v == null) return 6;
  return state.layer === 'new48'
    ? Math.min(14, 7 + v * 0.14)
    : Math.min(14.5, 6.5 + Math.sqrt(v) * 0.62);
}

function drawMap() {
  const map = $('#map');
  if (!state.snapshot) return;
  const firing = new Set((state.alerts?.firing ?? []).map((a) => a.regionId));
  const parts = [];
  const labels = [];

  // White ground, thin grey lines: the profile's plot background.
  parts.push(
    `<path d="${pathFrom(COAST, true)}" fill="var(--land)" stroke="var(--coast)" stroke-width=".9" stroke-linejoin="round"/>`,
    `<path d="${pathFrom(BORDER, false)}" fill="none" stroke="var(--coast)" stroke-width=".8" stroke-dasharray="3 3"/>`
  );

  // Latitude ticks on the right edge, every 5° (every 2° in a small frame).
  const latStep = frame.s > 70 ? 2 : 5;
  for (let la = -90; la <= 90; la += latStep) {
    const y = proj(la, frame.lon0).y;
    if (y < 40 || y > MAP_H - 12) continue;
    parts.push(`<text x="${MAP_W - 34}" y="${(y + 4).toFixed(1)}" class="mono" font-size="9" fill="var(--muted)">${la}°N</text>`);
  }

  // Biggest first, so a small marker inside a crowded cluster stays clickable
  // and its label is not buried under a neighbour.
  const ordered = state.snapshot.regions
    .filter((r) => !r.offMap && inSel(r.country))
    .map((r) => ({ r, rad: radiusFor(r) }))
    .sort((a, b) => b.rad - a.rad);

  for (const { r, rad } of ordered) {
    const p = proj(r.lat, r.lon);
    const v = regionValue(r);
    const fill = fillFor(r);
    const isSel = state.selRegion === r.id;
    // Alert rings are a snow signal; on the danger layer they would sit next
    // to EAWS red and blur two different meanings of red.
    const isFiring = firing.has(r.id) && state.layer !== 'danger';
    const label = v == null ? '' : String(Math.round(v));
    const cx = p.x.toFixed(1);
    const cy = p.y.toFixed(1);

    const tip = [
      r.name,
      r.snow?.depthCm != null ? `${cm(r.snow.depthCm)} cm base` : null,
      r.snow?.new48 != null ? `+${cm(r.snow.new48)} cm/48h` : null,
      r.bulletin?.danger ? `danger ${r.bulletin.danger}` : 'danger not assessed',
    ].filter(Boolean).join(' · ');

    // No data: an empty dashed ring, never a colour that could be read as a value.
    const noData = fill == null;
    const isFive = state.layer === 'danger' && v === 5;
    const stroke = isSel ? 'var(--ink)' : isFive ? RED : noData ? 'var(--steel)' : 'var(--marker-edge)';
    const sw = isSel ? 2.2 : isFive ? 1.8 : 0.9;

    parts.push(
      `<g class="reg" data-region="${esc(r.id)}" style="cursor:pointer">` +
        // Signal red is reserved for this: a region over the alert threshold.
        (isFiring
          ? `<circle cx="${cx}" cy="${cy}" r="${(rad + 4.5).toFixed(1)}" fill="none" stroke="${RED}" stroke-width="1.6"/>` +
            `<circle cx="${cx}" cy="${cy}" r="${(rad + 8).toFixed(1)}" fill="none" stroke="${RED}" stroke-width=".7" opacity=".6"/>`
          : '') +
        `<circle cx="${cx}" cy="${cy}" r="${rad.toFixed(1)}" fill="${noData ? 'var(--paper)' : fill}" ` +
        `stroke="${stroke}" stroke-width="${sw}"${noData ? ' stroke-dasharray="2 2"' : ''}/>` +
        `<title>${esc(tip)}</title></g>`
    );

    // Labels go into a separate pass appended after the tour pins, so a pin
    // can never bury the number it sits on. Only label a marker big enough
    // to hold the text: a 1-char danger level fits, a 3-digit depth needs room.
    if (label && rad >= (label.length > 2 ? 10 : 7)) {
      labels.push(
        `<text x="${cx}" y="${(p.y + 3.1).toFixed(1)}" text-anchor="middle" class="mono" ` +
          `font-size="${label.length > 2 ? 8 : 9}" font-weight="600" fill="${textOn(fill)}" ` +
          `pointer-events="none">${esc(label)}</text>`
      );
    }
  }

  // Tours are the primary series: ink markers, as in the thesis plots.
  if (state.showTours) {
    for (const t of visibleTours()) {
      const p = proj(t.lat, t.lon);
      const sel = state.sel === t.name;
      parts.push(
        `<g class="tourpin" data-tour="${esc(t.name)}" style="cursor:pointer">` +
          `<path d="M${p.x.toFixed(1)} ${(p.y - 5.5).toFixed(1)} l4 7.2 h-8 Z" fill="var(--ink)" stroke="var(--paper)" stroke-width=".8"/>` +
          (sel
            ? `<circle cx="${p.x.toFixed(1)}" cy="${(p.y - 1).toFixed(1)}" r="10" fill="none" stroke="var(--ink)" stroke-width="1.6"/>` +
              `<circle cx="${p.x.toFixed(1)}" cy="${(p.y - 1).toFixed(1)}" r="15" fill="none" stroke="var(--ink)" stroke-width=".7"/>`
            : '') +
          `<title>${esc(t.name)} · ${t.summit_m} m${t.snow?.depthCm != null ? ` · ${cm(t.snow.depthCm)} cm` : ''}</title></g>`
      );
    }
  }

  // Ski resorts: under the tour pins, over the regions.
  if (state.showResorts && state.resorts?.resorts) {
    const pts = state.resorts.resorts.filter((r) => inSel(r.country)).map((r) => ({ r, ...proj(r.lat, r.lon) }));
    // Keep icons and names clear of the zoom buttons and the map note.
    const blocked = [[0, 0, 46, 116], [MAP_W - 210, 0, MAP_W, 34]];
    const layout = layoutResorts(pts, { detail: state.view.k >= DETAIL_K, width: MAP_W, height: MAP_H, blocked });
    parts.push(`<g class="resorts">${resortSvg(layout)}</g>`);
  }

  // Huts, lodges and remote cafés: only zoomed in, where they can be told apart.
  if (state.showHuts && state.huts?.places && state.view.k >= DETAIL_K) {
    const named = state.view.k >= 6;
    const marks = state.huts.places
      .map((h) => ({ h, ...proj(h.lat, h.lon) }))
      .filter((p) => p.x > -10 && p.y > -10 && p.x < MAP_W + 10 && p.y < MAP_H + 10);
    // Names only where they fit: open-in-winter places first, then the rest.
    const boxes = [];
    const rank = { open: 0, unknown: 1, closed: 2 };
    marks.sort((a, b) => rank[hutWinter(a.h)] - rank[hutWinter(b.h)]);
    const svg = marks.map(({ h, x, y }) => {
      let label = null;
      if (named && h.name) {
        const w = h.name.length * 5.6;
        const nx = Math.max(w / 2 + 3, Math.min(MAP_W - w / 2 - 3, x));
        const box = [nx - w / 2, y + 9, nx + w / 2, y + 21];
        if (!boxes.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) {
          boxes.push(box);
          label = nx - x;
        }
      }
      return hutMark(h, x, y, label);
    });
    // Drawn in reverse so the open-in-winter places sit on top.
    parts.push(`<g class="huts">${svg.reverse().join('')}</g>`);
  } else if (state.showHuts) {
    parts.push(`<text x="${MAP_W / 2}" y="${MAP_H - 14}" text-anchor="middle" class="maphint">${state.huts?.error ? 'Huts and cafés could not be loaded' : 'Zoom in to see huts and cafés'}</text>`);
  }

  // The selected tour gets a name callout, drawn last so nothing covers it.
  const selTour = state.showTours && state.sel ? visibleTours().find((t) => t.name === state.sel) : null;
  if (selTour) {
    const p = proj(selTour.lat, selTour.lon);
    const left = p.x > MAP_W * 0.59;
    labels.push(
      `<text x="${(p.x + (left ? -20 : 20)).toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}" ` +
        `class="callout" pointer-events="none">${esc(selTour.name)}</text>`
    );
  }

  map.innerHTML = parts.concat(labels).join('');
  // Zoomed in, one-finger drags pan the map; zoomed out they scroll the page.
  map.style.touchAction = state.view.k > 1 ? 'none' : 'pan-y';
  map.dataset.view = `${state.view.k.toFixed(2)} ${state.view.cx.toFixed(1)} ${state.view.cy.toFixed(1)}`;
  drawLegend();
}

function drawLegend() {
  const bands =
    state.layer === 'danger'
      ? [1, 2, 3, 4, 5].map((i) => [String(i), DANGER_COL[i]])
      : (state.layer === 'new48' ? NEW_BANDS : DEPTH_BANDS).map(([, c, l]) => [l, c]);

  const title =
    state.layer === 'danger' ? 'EAWS danger' : state.layer === 'new48' ? 'New snow / 48 h' : 'Snow depth';

  $('#legend').innerHTML =
    `<span class="eyebrow">${title}</span>` +
    bands
      .map(
        ([l, c]) =>
          `<span><i class="sw" style="background:${c}${state.layer === 'danger' && c === DANGER_COL[5] ? `;border-color:${RED}` : ''}"></i>${l}</span>`
      )
      .join('') +
    `<span><i class="sw sw-none"></i>${state.layer === 'danger' ? 'not assessed' : 'no data'}</span>` +
    (state.layer !== 'danger'
      ? `<span><i class="sw sw-alert"></i>over alert threshold</span>`
      : '') +
    `<span class="legend-key">▲ tour · ● forecast region${state.showResorts ? ' · ■ resort' : ''}</span>` +
    (state.showResorts ? resortLegend() : '') +
    (state.showHuts ? hutLegend() : '');
}

function hutLegend() {
  const icon = (w, k) => `<svg width="16" height="16" viewBox="-9 -9 18 18" class="hut ${w}" aria-hidden="true"><circle r="8"/>${HUT_GLYPH[k]}</svg>`;
  const n = state.huts?.places?.length;
  return (
    `<div class="legend-row"><span class="eyebrow">Huts &amp; cafés</span>` +
    `<span>${icon('open', 'hut')}open in winter</span><span>${icon('unknown', 'hut')}not known, check</span><span>${icon('closed', 'hut')}summer only</span>` +
    `<span>${icon('unknown', 'hut')}cabin</span><span>${icon('unknown', 'shelter')}open hut</span><span>${icon('unknown', 'lodge')}lodge</span><span>${icon('unknown', 'cafe')}café</span><span>${icon('unknown', 'restaurant')}restaurant</span></div>` +
    `<div class="legend-row note">${state.huts ? (state.huts.simulated ? `${n} simulated places (the real list from OpenStreetMap could not be loaded)` : state.huts.error && !n ? `could not be loaded right now (${esc(state.huts.error)})` : `${n} places within 15 km of the tours, from OpenStreetMap`) : 'loading…'}${state.view.k < DETAIL_K ? ' · zoom in to see them' : ''}</div>`
  );
}

function resortLegend() {
  const src = state.resorts?.sources;
  const when = (x) => (x?.fetchedAt ? new Date(x.fetchedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not loaded');
  const status = !state.resorts
    ? 'loading resorts…'
    : [
        inSel('NO') && `Norway: live, Fnugg, ${when(src?.no)}${src?.no?.stale ? ' (stale)' : ''}`,
        inSel('SE') && 'Sweden: location only, OpenStreetMap — no live status is published',
      ].filter(Boolean).join(' · ');
  return (
    `<div class="legend-row"><span class="eyebrow">Resorts — share open</span>` +
    OPEN_BANDS.map(([, bg, , l], i) => `<span><i class="sw"${i === 0 ? ' style="border-color:var(--steel)"' : ` style="background:${bg}"`}></i>${l}</span>`).join('') +
    `<span><i class="sw sw-none"></i>no status</span>` +
    `<span class="legend-key">left icon slopes · right icon lifts · click for the resort's map and facts</span></div>` +
    `<div class="legend-row note">${status}${state.view.k < DETAIL_K ? ' · zoom in for icons and names' : ''}</div>`
  );
}

/* ------------------------------------------------------------------ *
 * zoom and pan
 * ------------------------------------------------------------------ */

function svgPoint(e) {
  const svg = $('#map');
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function zoomAt(factor, sx = MAP_W / 2, sy = MAP_H / 2) {
  const v = state.view;
  const k = Math.max(1, Math.min(40, v.k * factor));
  // Keep the map point under (sx, sy) where it is.
  const bx = (sx - MAP_W / 2) / v.k + v.cx;
  const by = (sy - MAP_H / 2) / v.k + v.cy;
  v.cx = bx - (sx - MAP_W / 2) / k;
  v.cy = by - (sy - MAP_H / 2) / k;
  v.k = k;
  if (k === 1) Object.assign(v, { cx: MAP_W / 2, cy: MAP_H / 2 });
  drawMap();
}

let drag = null;
let dragged = false;
const pointers = new Map();
$('#map').addEventListener('pointerdown', (e) => {
  if (e.target.closest('a')) return;
  const pt = svgPoint(e);
  pointers.set(e.pointerId, pt);
  // DOMPoint's x/y are prototype getters, so copy them (spreading gives {}).
  if (pointers.size === 1) drag = { x: pt.x, y: pt.y };
  dragged = false;
});
$('#map').addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const now = svgPoint(e);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const other = a === prev ? b : a;
    const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
    const d1 = Math.hypot(now.x - other.x, now.y - other.y);
    pointers.set(e.pointerId, now);
    if (d0 > 0) zoomAt(d1 / d0, (now.x + other.x) / 2, (now.y + other.y) / 2);
    dragged = true;
    return;
  }
  pointers.set(e.pointerId, now);
  if (!drag || state.view.k === 1) return;
  const dx = now.x - drag.x, dy = now.y - drag.y;
  if (Math.hypot(dx, dy) > 4) dragged = true;
  if (dragged) {
    // svgPoint is in screen units of the current view; convert to map units.
    state.view.cx -= dx / state.view.k;
    state.view.cy -= dy / state.view.k;
    drag.x = now.x;
    drag.y = now.y;
    drawMap();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) drag = null;
};
$('#map').addEventListener('pointerup', endPointer);
$('#map').addEventListener('pointercancel', endPointer);
$('#map').addEventListener('pointerleave', endPointer);
// Plain scrolling keeps scrolling the page; Ctrl/⌘ + scroll (and trackpad
// pinch, which the browser reports the same way) zooms the map.
$('#map').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = svgPoint(e);
    zoomAt(Math.exp(-e.deltaY * 0.004), p.x, p.y);
  },
  { passive: false }
);
$('#map').addEventListener('dblclick', (e) => {
  e.preventDefault();
  const p = svgPoint(e);
  zoomAt(2, p.x, p.y);
});
$$('.zoombtn').forEach((b) =>
  b.addEventListener('click', () => (b.dataset.zoom === 'reset' ? zoomAt(1 / 1e9) : zoomAt(b.dataset.zoom === 'in' ? 2 : 0.5)))
);

async function loadResorts() {
  try {
    const r = await fetch('/api/resorts');
    state.resorts = r.ok ? await r.json() : { resorts: [], sources: {}, error: `HTTP ${r.status}` };
  } catch (err) {
    state.resorts = { resorts: [], sources: {}, error: err.message };
  }
  // In a simulated winter the real list is kept (the resorts exist) but the
  // open counts are invented, so the layer is not a row of closed resorts.
  if (state.simulated) state.resorts = simulateResorts(state.resorts) ?? state.resorts;
  state.resortsLoading = false;
  drawMap();
  if (state.lastPlan) renderPlanner();
}

/* ------------------------------------------------------------------ *
 * huts, mountain lodges and remote cafés
 * ------------------------------------------------------------------ */

const HUT_KIND = { hut: 'cabin', shelter: 'open hut / shelter', lodge: 'mountain lodge', cafe: 'café', restaurant: 'restaurant' };
const HUT_GLYPH = {
  // a cabin: roof and walls
  hut: '<path d="M-4.2 0.2 L0 -4.2 L4.2 0.2 M-3 -0.9 V4 H3 V-0.9"/>',
  // an open shelter: a lean-to
  shelter: '<path d="M-4.2 4 L0 -4 L4.2 4 M-1.6 4 L0 1 L1.6 4"/>',
  // a lodge: bigger house with a door
  lodge: '<path d="M-4.5 0 L0 -4.5 L4.5 0 M-3.4 -1 V4 H3.4 V-1 M-0.9 4 V1.4 H0.9 V4"/>',
  cafe: '<path d="M-3.4 -1.6 H2 V1.4 C2 3.4 -3.4 3.4 -3.4 1.4 Z M2 -0.8 C3.9 -0.8 3.9 1.5 2 1.5 M-1.7 -4 V-2.6 M0.3 -4 V-2.6"/>',
  restaurant: '<path d="M-2.2 -4 V4 M-3.5 -4 V-0.8 H-0.9 V-4 M2.2 -4 C3.8 -2.8 3.8 -0.1 2.2 0.6 V4"/>',
};
const hutWinter = (h) => (h.winter === true ? 'open' : h.winter === false ? 'closed' : 'unknown');

function hutMark(h, x, y, labelDx = null) {
  const w = hutWinter(h);
  const tip = `${h.name ?? HUT_KIND[h.kind]} · ${HUT_KIND[h.kind]}${h.org ? ` · ${h.org}` : ''}${h.ele ? ` · ${h.ele} m` : ''} · ` +
    (w === 'open' ? 'open in winter' : w === 'closed' ? 'closed in winter' : 'winter opening not known — check');
  return (
    `<g class="hut ${w}" data-hut="${esc(h.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><title>${esc(tip)}</title>` +
    `<circle r="8"/>${HUT_GLYPH[h.kind] ?? ''}` +
    (labelDx !== null && h.name ? `<text x="${labelDx.toFixed(1)}" y="18" text-anchor="middle" class="hutname">${esc(h.name)}</text>` : '') +
    `</g>`
  );
}

async function loadHuts() {
  if (state.hutsLoading) return;
  state.hutsLoading = true;
  try {
    const r = await fetch('/api/huts');
    const b = await r.json();
    state.huts = r.ok ? b : { places: [], error: b.detail ?? b.error ?? `HTTP ${r.status}` };
  } catch (err) {
    state.huts = { places: [], error: err.message };
  }
  // Simulated mode shows the layer even when the real list can't be had.
  if (state.simulated && !state.huts.places?.length) state.huts = simulateHuts(state.snapshot?.tours ?? []);
  state.hutsLoading = false;
  drawMap();
  // A tour panel waiting for its "huts nearby" list gets it now.
  const el = $('#hutsNear');
  if (el && state.sel) el.outerHTML = hutsNearHtml(state.sel);
}

/** Huts and cafés within 8 km of a tour, nearest first. */
function hutsNearHtml(tourName) {
  const t = (state.snapshot?.tours ?? []).find((x) => x.name === tourName);
  if (!t) return '';
  if (!state.huts) return `<div id="hutsNear"><p class="note">Looking for huts and cafés nearby…</p></div>`;
  if (state.huts.error && !state.huts.places?.length) return `<div id="hutsNear"><p class="note">Huts and cafés could not be loaded right now.</p></div>`;
  const near = state.huts.places.map((h) => ({ h, d: haversine(t, h) })).filter((x) => x.d <= 8).sort((a, b) => a.d - b.d).slice(0, 6);
  if (!near.length) return `<div id="hutsNear"><p class="note">No cabins, lodges or remote cafés mapped within 8 km.</p></div>`;
  return `<div id="hutsNear"><ul class="hutlist">${near.map(({ h, d }) => {
    const w = hutWinter(h);
    return `<li data-hut="${esc(h.id)}" tabindex="0"><svg width="18" height="18" viewBox="-9 -9 18 18" class="hut ${w}" aria-hidden="true"><circle r="8"/>${HUT_GLYPH[h.kind] ?? ''}</svg>` +
      `<span class="hutn">${esc(h.name ?? HUT_KIND[h.kind])}<span class="note"> ${esc(HUT_KIND[h.kind])}${h.org ? ` · ${h.org}` : ''} · ${d.toFixed(1)} km</span></span>` +
      `<span class="hutw ${w}">${w === 'open' ? 'winter ✓' : w === 'closed' ? 'summer only' : 'check'}</span></li>`;
  }).join('')}</ul></div>`;
}

function selectHut(id) {
  const h = (state.huts?.places ?? []).find((x) => x.id === id);
  if (!h) return;
  state.sel = null;
  state.selResort = null;
  const w = hutWinter(h);
  const regs = (state.snapshot?.regions ?? []).filter((g) => !g.offMap);
  const nearReg = regs.map((g) => ({ g, d: haversine(h, g) })).sort((a, b) => a.d - b.d)[0]?.g ?? null;
  const tours = (state.snapshot?.tours ?? []).map((t) => ({ t, d: haversine(h, t) })).filter((x) => x.d <= 15).sort((a, b) => a.d - b.d).slice(0, 8);
  const todayRows = new Map((state.lastPlan?.days?.[0]?.rows ?? []).map((row) => [row.tour, row]));
  const country = nearReg?.country ?? 'NO';
  $('#detailTitle').textContent = h.name ?? HUT_KIND[h.kind];
  $('#detail').innerHTML =
    `<div class="tourgrid"><div class="tourcol"><div class="routemap" id="routeMap"></div>` +
    `<h4>Tours from here</h4>` +
    (tours.length
      ? `<ul class="rstours">${tours.map(({ t, d }) => {
          const row = todayRows.get(t.name);
          const score = row && (row.status === 'ok' || row.status === 'caution') ? `<span class="rsscore">${row.score}</span>` : row?.status === 'excluded' ? '<span class="rsscore off">✕</span>' : '';
          return `<li data-tour="${esc(t.name)}" tabindex="0"><span class="rsname">${esc(t.name)}</span><span class="note">${d.toFixed(1)} km · ${t.summit_m} m · diff ${t.difficulty}/5</span>${score}</li>`;
        }).join('')}</ul><p class="note">Distance as the crow flies; today's planner score where the tour passes the avalanche filter.</p>`
      : '<p class="note">No listed tours within 15 km.</p>') +
    `<p class="attrib">Map © ${country === 'SE' ? 'OpenTopoMap, © OpenStreetMap contributors' : 'Kartverket'} · Place: © OpenStreetMap contributors</p>` +
    `</div><div class="tourcol"><dl>` +
    `<dt>Type</dt><dd>${esc(HUT_KIND[h.kind])}${h.staffed ? ', staffed' : ''}</dd>` +
    (h.org || h.operator ? `<dt>Run by</dt><dd>${esc(h.operator ?? (h.org === 'DNT' ? 'Den Norske Turistforening' : 'Svenska Turistföreningen'))}</dd>` : '') +
    `<dt>Winter</dt><dd><span class="hutw ${w}">${w === 'open' ? 'Open in winter' : w === 'closed' ? 'Closed in winter' : 'Not known — check before you go'}</span>` +
    (h.opening ? `<br><span class="note">opening hours: ${esc(h.opening)}</span>` : '') + `</dd>` +
    (h.ele ? `<dt>Height</dt><dd>${h.ele} m</dd>` : '') +
    (h.beds ? `<dt>Beds</dt><dd>${h.beds}</dd>` : '') +
    (h.fee ? `<dt>Fee</dt><dd>${esc(h.fee === 'yes' ? 'yes' : h.fee === 'no' ? 'free' : h.fee)}</dd>` : '') +
    (nearReg ? `<dt>Avalanche region</dt><dd>${esc(nearReg.name)} — ${dangerPill(nearReg)}</dd>` : '') +
    `<dt>Position</dt><dd>${h.lat.toFixed(4)}° N, ${h.lon.toFixed(4)}° E</dd>` +
    `</dl>` +
    (h.simulated ? '<p class="note"><strong>Simulated place</strong>: made up for simulated mode, because the real list could not be loaded.</p>' : '') +
    `<p class="note">From OpenStreetMap. Opening times in the mountains change with the season and the weather: always check with the host before you rely on a bed or a meal.</p>` +
    `<div class="linkrow">` +
    (h.website ? `<a class="btn primary" href="${esc(h.website)}" target="_blank" rel="noopener noreferrer">Website ↗</a>` : '') +
    (h.more ? `<a class="btn${h.website ? '' : ' primary'}" href="${esc(h.more)}" target="_blank" rel="noopener noreferrer">${h.org === 'DNT' ? 'Find on ut.no' : 'Find on STF'} ↗</a>` : '') +
    (h.simulated ? '' : `<a class="btn" href="https://www.openstreetmap.org/${esc(h.id)}" target="_blank" rel="noopener noreferrer">OpenStreetMap ↗</a>`) +
    (nearReg ? `<button class="btn" data-region="${esc(nearReg.id)}">Region overview</button>` : '') +
    `</div></div></div>`;
  renderRouteMap($('#routeMap'), { route: null, tour: { name: h.name ?? HUT_KIND[h.kind], lat: h.lat, lon: h.lon }, country });
  drawMap();
  $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Turn the resort layer on and zoom the map to one resort. */
function focusResort(lat, lon) {
  const cb = $('#showResorts');
  if (!cb.checked) {
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  }
  const b = baseProj(lat, lon);
  Object.assign(state.view, { k: 6, cx: b.x, cy: b.y });
  drawMap();
  $('.mapbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Resorts within reach of a set of tours, nearest first. */
function resortsNear(tourNames, { km = 45, max = 2 } = {}) {
  const list = state.resorts?.resorts;
  if (!list?.length) return [];
  const ts = (state.snapshot?.tours ?? []).filter((t) => tourNames.includes(t.name));
  if (!ts.length) return [];
  const c = { lat: ts.reduce((a, t) => a + t.lat, 0) / ts.length, lon: ts.reduce((a, t) => a + t.lon, 0) / ts.length };
  return list
    .map((r) => ({ r, d: haversine(c, r) }))
    .filter((x) => x.d <= km)
    .sort((a, b) => (b.r.lifts?.count ?? 0) - (a.r.lifts?.count ?? 0) || a.d - b.d)
    .slice(0, max);
}

$('#map').addEventListener('click', (e) => {
  if (dragged) {
    dragged = false;
    return;
  }
  const tour = e.target.closest('g.tourpin');
  if (tour) return selectTour(tour.dataset.tour);
  const resort = e.target.closest('[data-resort]');
  if (resort) return selectResort(resort.dataset.resort);
  const hut = e.target.closest('[data-hut]');
  if (hut) return selectHut(hut.dataset.hut);
  const reg = e.target.closest('g.reg');
  if (reg) selectRegion(reg.dataset.region);
});

/* ------------------------------------------------------------------ *
 * countries: the first filter
 * ------------------------------------------------------------------ */

const COUNTRY_KEY = 'fjallskred.countries.v1';

/** Countries with regions in the data, in the order COUNTRIES lists them. */
function availableCountries() {
  const have = new Set((state.snapshot?.regions ?? []).map((r) => r.country));
  return [...Object.keys(COUNTRIES).filter((c) => have.has(c)), ...[...have].filter((c) => !COUNTRIES[c]).sort()];
}

function initCountries() {
  const avail = availableCountries();
  const saved = state.countries.length ? state.countries : readStore(COUNTRY_KEY, []);
  const next = normaliseSelection(saved, avail);
  const changed = next.join() !== state.countries.join();
  state.countries = next;
  if (changed) reframe();
}

function renderCountryBar() {
  const avail = availableCountries();
  const all = avail.length === state.countries.length;
  const groups = GROUPS.filter((g) => g.countries.some((c) => avail.includes(c)));
  const chip = (attr, label, on, title = '') =>
    `<button class="cchip" ${attr} aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
  $('#countryBar').innerHTML =
    `<span class="eyebrow">Countries</span>` +
    avail.map((c) => chip(`data-country="${esc(c)}"`, countryName(c), inSel(c), `Show or hide ${countryName(c)}`)).join('') +
    groups.map((g) => {
      const on = g.countries.filter((c) => avail.includes(c));
      return chip(`data-group="${esc(g.id)}"`, g.name, on.length === state.countries.length && on.every(inSel), `Only ${joinNames(on)}`);
    }).join('') +
    (avail.length > 1 ? chip('data-all', 'All', all) : '') +
    `<span class="note cnote">${all ? 'everything' : `only ${esc(joinNames(state.countries))}`} on the map, in the tours, planner and alerts</span>`;
  const names = joinNames(state.countries);
  $('#eyebrowCountries').textContent = names;
  $('#map').setAttribute('aria-label', `Map of ${names} showing avalanche forecast regions and ski touring objectives`);
}

function setCountries(next) {
  const avail = availableCountries();
  next = normaliseSelection(next, avail);
  if (next.join() === state.countries.join()) return;
  state.countries = next;
  writeStore(COUNTRY_KEY, next);
  reframe();
  // A selection in a country that is now hidden is dropped, not left dangling.
  const regions = regionById();
  const selTour = (state.snapshot?.tours ?? []).find((t) => t.name === state.sel);
  const selCountry = selTour ? regions[selTour.region]?.country : regions[state.selRegion]?.country;
  if (selCountry && !inSel(selCountry)) {
    state.sel = null;
    state.selRegion = null;
    $('#detailTitle').textContent = 'Select a tour or region';
    $('#detail').innerHTML = '<p class="note">Pick a pin on the map or a tour from the list.</p>';
  }
  renderCountryBar();
  fillRegionSelect();
  renderList();
  renderAlerts();
  renderSources();
  renderPlanner();
  drawMap();
}

$('#countryBar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-all')) return setCountries(availableCountries());
  if (b.dataset.group) return setCountries(GROUPS.find((g) => g.id === b.dataset.group)?.countries ?? []);
  const c = b.dataset.country;
  // Toggle, but never down to nothing: the last country stays on.
  const next = inSel(c) ? state.countries.filter((x) => x !== c) : [...state.countries, c];
  if (next.length) setCountries(availableCountries().filter((x) => next.includes(x)));
});

/* ------------------------------------------------------------------ *
 * track availability
 * ------------------------------------------------------------------ */

// status: gpx (your own file), osm (derived from OpenStreetMap), none,
// area (a touring area, no single line) or pending (not looked up yet).
state.tracks = {};
async function loadTracks() {
  try {
    const r = await fetch('/api/tracks');
    if (!r.ok) return;
    state.tracks = (await r.json()).tours ?? {};
    renderList();
  } catch {
    /* the marker is a convenience; the list works without it */
  }
}

const hasTrack = (name) => ['gpx', 'osm'].includes(state.tracks[name]?.status);
function trackMatches(name, want) {
  if (want === 'gpx') return state.tracks[name]?.status === 'gpx';
  if (want === 'any') return hasTrack(name);
  if (want === 'none') return !hasTrack(name);
  return true;
}

function trackTag(name) {
  const t = state.tracks[name];
  switch (t?.status) {
    case 'gpx':
      return '<span class="trk own" title="GPX track: your own file">GPX</span>';
    case 'osm':
      return t.kind === 'ski-route'
        ? '<span class="trk osm" title="GPX track: ski route from OpenStreetMap">GPX</span>'
        : '<span class="trk osm path" title="GPX track: summer path from OpenStreetMap, the ski line may differ">GPX</span>';
    case 'area':
      return '<span class="trk none" title="Touring area: many lines, no single track">area</span>';
    case 'pending':
      return '<span class="trk none" title="Route not looked up yet">…</span>';
    default:
      return t ? '<span class="trk none" title="No track found yet">no track</span>' : '';
  }
}

/* ------------------------------------------------------------------ *
 * tours
 * ------------------------------------------------------------------ */

function visibleTours() {
  const tours = state.snapshot?.tours ?? [];
  const regions = regionById();
  const q = state.q.toLowerCase();

  const out = tours.filter((t) => {
    const reg = regions[t.region];
    if (!reg) return false;
    if (!inSel(reg.country)) return false;
    if (state.track && !trackMatches(t.name, state.track)) return false;
    if (state.region && t.region !== state.region) return false;
    if (state.grade && t.difficulty > +state.grade) return false;
    if (q) {
      const hay = `${t.name} ${reg.name} ${t.access} ${t.note}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const num = (v) => (v == null ? -1 : v);
  out.sort((a, b) => {
    switch (state.sort) {
      case 'name': return a.name.localeCompare(b.name);
      case 'vert': return b.vertical_m - a.vertical_m;
      case 'grade': return a.difficulty - b.difficulty || b.quality - a.quality;
      case 'new': return num(b.snow?.new48) - num(a.snow?.new48) || b.quality - a.quality;
      case 'depth': return num(b.snow?.depthCm) - num(a.snow?.depthCm) || b.quality - a.quality;
      case 'fav': return (FAVS[b.name] ? 1 : 0) - (FAVS[a.name] ? 1 : 0) || b.quality - a.quality;
      default: return b.quality - a.quality || b.vertical_m - a.vertical_m;
    }
  });
  return out;
}

const stars = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

function renderList() {
  const list = visibleTours();
  const regions = regionById();

  $('#tourlist').innerHTML =
    list
      .map((t) => {
        const reg = regions[t.region];
        const snow = t.snow;
        const badge =
          snow?.depthCm != null
            ? `<span class="snowbadge${snow.new48 != null && snow.new48 >= (state.alerts?.threshold ?? 30) ? ' hot' : ''}">` +
              `${cm(snow.depthCm)} cm${cm(snow.new48) >= 1 ? ` · +${cm(snow.new48)}` : ''}</span>`
            : '';
        return (
          `<div class="trow${state.sel === t.name ? ' sel' : ''}" tabindex="0" data-tour="${esc(t.name)}">` +
          `<div><div class="tname"><button class="fav${FAVS[t.name] ? ' on' : ''}" data-fav="${esc(t.name)}" aria-label="Favourite">${FAVS[t.name] ? '★' : '☆'}</button>${esc(t.name)} ${trackTag(t.name)} ${badge}</div>` +
          `<div class="tmeta">${esc(reg.name)} · ${t.summit_m} m · ${t.vertical_m} m vert · <span class="asp">${aspectRose(t.aspect, { size: 14 })}${esc(t.aspect)}</span></div></div>` +
          `<div style="text-align:right"><div class="stars">${stars(t.quality)}</div><div class="grade">diff ${t.difficulty}/5</div></div></div>`
        );
      })
      .join('') || '<div class="skeleton">Nothing matches those filters.</div>';

  const inCountries = (state.snapshot?.tours ?? []).filter((t) => inSel(regions[t.region]?.country)).length;
  const withTrack = list.filter((t) => hasTrack(t.name)).length;
  $('#tourCount').textContent = `${list.length} of ${inCountries}${Object.keys(state.tracks).length ? ` · ${withTrack} with GPX` : ''}`;
}

$('#tourlist').addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const n = fav.dataset.fav;
    FAVS[n] = !FAVS[n];
    writeStore(FAV_KEY, FAVS);
    return renderList();
  }
  const row = e.target.closest('.trow');
  if (row) selectTour(row.dataset.tour);
});
$('#tourlist').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.trow');
  if (row) {
    e.preventDefault();
    selectTour(row.dataset.tour);
  }
});

/* ------------------------------------------------------------------ *
 * detail
 * ------------------------------------------------------------------ */

const DANGER_NAME = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Very high' };

/** EAWS-coloured level chip; text colour follows the fill so 2 (yellow) and 5 (black) both read. */
const pill = (d) =>
  `<span class="dangerpill" style="background:${DANGER_COL[d]};color:${textOn(DANGER_COL[d])}` +
  `${d === 5 ? `;box-shadow:inset 0 0 0 1.5px ${RED}` : ''}">${d}</span>`;

function dangerPill(region) {
  const d = region.bulletin?.danger;
  if (!d) {
    const why = region.bulletin?.noForecast
      ? 'no avalanche forecast here'
      : region.bulletin?.seasonOver
      ? 'season over'
      : region.bulletin?.error
        ? 'could not be read'
        : 'not assessed';
    return `<span class="note">danger ${why}</span>`;
  }
  return dangerChip(d);
}

function bulletinBlock(region) {
  const b = region.bulletin ?? {};
  const bits = [];

  if (b.emergencyWarning) {
    bits.push(`<div class="warnbox"><strong>Emergency warning:</strong> ${esc(b.emergencyWarning)}</div>`);
  }
  if (b.headline) bits.push(`<p class="bulletintext">${esc(b.headline)}</p>`);

  if (b.problems?.length) {
    // Colour from danger 3 up, black and white below: a raised level is
    // visible before any text is read.
    const colour = (b.danger ?? 0) >= 3;
    bits.push(
      `<h4>Avalanche problems</h4><div class="avprobs">` +
        b.problems
          .map((p) => {
            const key = (problemKey(p.problemType) ?? problemKey(p.type));
            return (
              `<div class="avrow">` +
              `<span class="avprob big" ${key ? `data-av="problem" data-key="${key}" tabindex="0"` : ''}` +
              `${p.probability ? ` data-extra="${esc([p.probability, p.size].filter(Boolean).join(' · '))}"` : ''}>` +
              `${key ? problemIcon(key, { colour, size: 46, title: false }) : ''}</span>` +
              `<div class="avwhat"><strong>${esc(key ? PROBLEMS[key].name : p.type)}</strong>` +
              `<span class="note">${esc([p.probability, p.size].filter(Boolean).join(' · '))}</span></div>` +
              `<figure class="avfig">${problemRose(p.aspects, { colour })}<figcaption>aspects</figcaption></figure>` +
              `<figure class="avfig">${elevationDiagram(p.heights, { colour })}<figcaption>${esc(elevationText(p.heights))}</figcaption></figure>` +
              `</div>`
            );
          })
          .join('') +
        `</div><p class="note avsrc">Hover or tap a symbol for what it means. Problem types and danger scale after the ` +
        `<a href="https://www.avalanches.org/standards/avalanche-problems/" target="_blank" rel="noopener">EAWS standards</a> and the ` +
        `<a href="https://www.avalanches.org/wp-content/uploads/2022/09/European_Avalanche_Danger_Scale-EAWS.pdf" target="_blank" rel="noopener">European Avalanche Danger Scale</a>, in short.</p>`
    );
  }

  for (const [label, val] of [
    ['Snow surface', b.snowSurface],
    ['Current weak layers', b.weakLayers],
    ['Recent avalanche activity', b.latestAvalancheActivity],
    ['Latest observations', b.latestObservations],
  ]) {
    if (val) bits.push(`<h4>${label}</h4><p class="bulletintext">${esc(val)}</p>`);
  }

  if (b.scraped && b.confidence !== 'parsed') {
    bits.push(
      `<p class="note">${esc(b.note ?? 'Swedish bulletin could not be read automatically.')}</p>`
    );
  }
  if (b.error) bits.push(`<p class="note">Bulletin unavailable: ${esc(b.error)}</p>`);

  return bits.join('') || '<p class="note">No bulletin text available for this region right now.</p>';
}

function snowBlock(snow, label = 'Snow') {
  if (!snow || snow.error || snow.depthCm == null) {
    return `<p class="note">No modelled snow data for this point.</p>`;
  }
  const parts = [
    `<strong>${cm(snow.depthCm)} cm</strong> modelled depth`,
    snow.new24 != null ? `+${cm(snow.new24)} cm/24h` : null,
    snow.new48 != null ? `<strong>+${cm(snow.new48)} cm/48h</strong>` : null,
    snow.new72 != null ? `+${cm(snow.new72)} cm/72h` : null,
    snow.gridAltitude != null ? `grid cell ${snow.gridAltitude} m` : null,
  ].filter(Boolean);

  // A fallback sample is one grid cell at the region marker, which may sit
  // far below the terrain people ski. Say so rather than letting it read as
  // a representative depth.
  const caveat = snow.fallback
    ? `<p class="note">No tours listed in this region, so this is a single sample at the region marker` +
      `${snow.gridAltitude != null ? ` (${snow.gridAltitude} m)` : ''} — treat it as indicative only.</p>`
    : '';

  return `<p class="bulletintext">${label}: ${parts.join(' · ')}</p>${caveat}`;
}

/** Route descriptions elsewhere (e.g. Freeride.se), linked, never copied. */
function linksBlock(links) {
  const ok = (links ?? []).filter((l) => /^https:\/\//.test(l.url ?? ''));
  if (!ok.length) return '';
  const bySite = {};
  for (const l of ok) (bySite[l.site ?? 'More'] ??= []).push(l);
  return Object.entries(bySite)
    .map(([site, ls]) =>
      `<div class="morelinks"><span class="eyebrow">Route descriptions on ${esc(site)}</span>` +
      ls.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)} ↗</a>`).join('') +
      `</div>`)
    .join('');
}

function selectTour(name) {
  const t = (state.snapshot?.tours ?? []).find((x) => x.name === name);
  if (!t) return;
  state.sel = name;
  state.selRegion = t.region;
  const reg = regionById()[t.region];

  $('#detailTitle').textContent = t.name;
  $('#detail').innerHTML =
    `<div class="tourgrid">` +
    `<div class="tourcol">` +
    `<div class="routemap" id="routeMap"></div>` +
    `<div class="profile" id="routeProfile"></div>` +
    `<div id="routeMeta">${routeSummary(null, t)}</div>` +
    `<div id="ownPhotosWrap" hidden><h4>Your photos</h4><div id="ownPhotos"></div></div>` +
    `<h4>Photos near the summit</h4><div id="photos"></div>` +
    `<p class="attrib">Map © ${reg.country === 'SE' ? 'OpenTopoMap, © OpenStreetMap contributors' : 'Kartverket'} · ` +
    `Route © OpenStreetMap contributors (ODbL) · Elevation: ${reg.country === 'SE' ? 'Copernicus DEM GLO-90 via Open-Meteo' : 'Kartverket (DTM 1 m / 10 m)'} · ` +
    `Photos: Wikimedia Commons, credited per image</p>` +
    `</div>` +
    `<div class="tourcol">` +
    `<dl>` +
    `<dt>Region</dt><dd>${esc(reg.name)} (${esc(countryName(reg.country))}) — ${dangerPill(reg)}</dd>` +
    `<dt>Summit / vertical</dt><dd>${t.summit_m} m · ≈${t.vertical_m} m of descent</dd>` +
    `<dt>Descent aspect</dt><dd class="aspdd">${aspectRose(t.aspect, { size: 64, labels: true })}<span>${esc(t.aspect)}` +
    `${/varied/i.test(t.aspect) ? '<br><span class="note">not yet known, so the planner tests it against every avalanche problem</span>' : '<br><span class="note">the directions the skiing faces</span>'}</span></dd>` +
    `<dt>Difficulty</dt><dd>${t.difficulty}/5 &nbsp; <span class="stars">${stars(t.quality)}</span></dd>` +
    `<dt>Access</dt><dd>${esc(t.access)}</dd>` +
    `<dt>Usual window</dt><dd>${esc(t.season)}</dd>` +
    `</dl>` +
    `<p class="bulletintext">${esc(t.note)}</p>` +
    linksBlock(t.links) +
    snowBlock(t.snow, 'At this tour') +
    `<h4 id="snowHistH">Snow depth this winter</h4><div class="snowhist" id="snowHist"><p class="note">Loading the last winters…</p></div>` +
    `<h4>Next 5 days</h4><div id="forecast"></div>` +
    `<h4>Huts and cafés nearby</h4>` + hutsNearHtml(t.name) +
    bulletinBlock(reg) +
    `<div class="linkrow">` +
    (reg.bulletinUrl
      ? `<a class="btn primary" href="${esc(reg.bulletinUrl)}" target="_blank" rel="noopener">Bulletin — ${esc(reg.name)}</a>`
      : `<span class="note">No avalanche forecast is issued here. Judge the terrain yourself, and see the nearest bulletin for the weather and snowpack story.</span>`) +
    (reg.country === 'NO'
      ? `<a class="btn" href="https://www.regobs.no/" target="_blank" rel="noopener">Regobs observations</a>`
      : '') +
    (reg.offMap ? '' : `<button class="btn" data-region="${esc(reg.id)}">Region overview</button>`) +
    `<a class="btn" href="/terrain#tour=${encodeURIComponent(t.name)}" title="Slope and runout under the route, 3D, your own line">Plan this tour</a>` + `</div>` +
    `</div></div>`;

  state.tourView = { route: null, terrain: null, photos: null, own: null, slopes: null };
  renderRouteMap($('#routeMap'), { route: null, tour: t, country: reg.country });
  renderForecast($('#forecast'), null);
  renderPhotos($('#photos'), null, t, null);
  loadTourExtras(t, reg);

  drawMap();
  renderList();
  $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Route and forecast load after the panel is on screen. If the user has
 * picked another tour by the time a response lands, it is dropped rather
 * than painted over the wrong tour.
 */
/* ------------------------------------------------------------------ *
 * a ski resort's panel
 * ------------------------------------------------------------------ */

function openBar(c) {
  if (!c) return '<span class="note">not published</span>';
  const f = c.count ? c.open / c.count : 0;
  const band = OPEN_BANDS.find(([max]) => f < max) ?? OPEN_BANDS[OPEN_BANDS.length - 1];
  return (
    `<span class="rsbar"><i style="width:${Math.round(f * 100)}%;background:${band[1]}"></i></span>` +
    `<strong>${c.open}</strong> of ${c.count} open`
  );
}

function selectResort(id) {
  const r = (state.resorts?.resorts ?? []).find((x) => x.id === id);
  if (!r) return;
  state.sel = null;
  state.selResort = id;
  const regs = (state.snapshot?.regions ?? []).filter((g) => !g.offMap);
  const nearReg = regs.map((g) => ({ g, d: haversine(r, g) })).sort((a, b) => a.d - b.d)[0]?.g ?? null;
  const tours = (state.snapshot?.tours ?? [])
    .map((t) => ({ t, d: haversine(r, t) }))
    .filter((x) => x.d <= 40)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  const todayRows = new Map((state.lastPlan?.days?.[0]?.rows ?? []).map((row) => [row.tour, row]));
  const status = r.live
    ? r.open === false || (r.lifts && r.lifts.open === 0)
      ? '<span class="rsstat closed">Closed today</span>'
      : '<span class="rsstat open">Open today</span>'
    : '<span class="rsstat unknown">No live status published</span>';
  const season = r.season?.from || r.season?.to ? `${esc(r.season.from ?? '?')} – ${esc(r.season.to ?? '?')}` : null;
  const src = r.source === 'fnugg' ? 'Fnugg (as reported by the resort)' : 'OpenStreetMap (position and website only)';

  $('#detailTitle').textContent = r.name;
  $('#detail').innerHTML =
    `<div class="tourgrid">` +
    `<div class="tourcol">` +
    `<div class="routemap" id="routeMap"></div>` +
    `<h4>Touring nearby</h4>` +
    (tours.length
      ? `<ul class="rstours">${tours
          .map(({ t, d }) => {
            const row = todayRows.get(t.name);
            const score = row && (row.status === 'ok' || row.status === 'caution') ? `<span class="rsscore">${row.score}</span>` : row?.status === 'excluded' ? '<span class="rsscore off">✕</span>' : '';
            return `<li data-tour="${esc(t.name)}" tabindex="0"><span class="rsname">${esc(t.name)}${trackTag(t.name)}</span>` +
              `<span class="note">${Math.round(d)} km · ${t.summit_m} m · diff ${t.difficulty}/5</span>${score}</li>`;
          })
          .join('')}</ul><p class="note">Today's planner score, where the tour passes the avalanche filter; ✕ where it does not.</p>`
      : '<p class="note">No listed touring objectives within 40 km.</p>') +
    `<p class="attrib">Map © ${r.country === 'SE' ? 'OpenTopoMap, © OpenStreetMap contributors' : 'Kartverket'} · Lift status: ${esc(src)}</p>` +
    `</div>` +
    `<div class="tourcol">` +
    `<dl>` +
    (r.url ? `<dt>Website</dt><dd><a class="rsweb" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))} ↗</a></dd>` : '') +
    `<dt>Status</dt><dd>${status}</dd>` +
    `<dt>Lifts</dt><dd>${openBar(r.lifts)}</dd>` +
    `<dt>Slopes</dt><dd>${openBar(r.slopes)}</dd>` +
    (!r.live && r.mappedLifts ? `<dt>Mapped lifts</dt><dd>${r.mappedLifts} in OpenStreetMap</dd>` : '') +
    (season ? `<dt>Season</dt><dd>${season}</dd>` : '') +
    `<dt>Country</dt><dd>${esc(countryName(r.country))}</dd>` +
    (nearReg ? `<dt>Avalanche region</dt><dd>${esc(nearReg.name)} — ${dangerPill(nearReg)}<br><span class="note">for off-piste and touring from the lifts</span></dd>` : '') +
    (tours[0]?.t?.snow?.depthCm != null ? `<dt>Snow nearby</dt><dd><strong>${Math.round(tours[0].t.snow.depthCm)} cm</strong> modelled at ${esc(tours[0].t.name)} (${Math.round(tours[0].d)} km)</dd>` : '') +
    `<dt>Position</dt><dd>${r.lat.toFixed(4)}° N, ${r.lon.toFixed(4)}° E${r.approx ? '<br><span class="note">approximate — from the built-in list, until OpenStreetMap can be reached</span>' : ''}</dd>` +
    `</dl>` +
    `<h4>Snow depth this winter</h4><div class="snowhist" id="snowHist"><p class="note">Loading the last winters…</p></div>` +
    `<h4>Fun facts</h4><div id="rsFacts"><p class="note">Counting runs and lifts in OpenStreetMap… <span id="rsWait">0 s</span><br>The first time for a resort this can take up to a minute.</p></div>` +
    `<h4>Next 5 days</h4><div id="forecast"></div>` +
    `<div class="linkrow">` +
    (r.url ? `<a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.name)} website ↗</a>` : '') +
    `<a class="btn" href="https://www.openstreetmap.org/?mlat=${r.lat}&amp;mlon=${r.lon}#map=13/${r.lat}/${r.lon}" target="_blank" rel="noopener noreferrer">Map ↗</a>` +
    (nearReg && !nearReg.offMap ? `<button class="btn" data-region="${esc(nearReg.id)}">Region overview</button>` : '') +
    `</div>` +
    `</div></div>`;

  renderResortMap($('#routeMap'), { resort: r, country: r.country });
  renderForecast($('#forecast'), null);
  const still = () => state.selResort === id && !state.sel;
  const getJ = (u) =>
    fetch(u)
      .then((res) => res.json().then((b) => (res.ok ? b : { error: b.detail ?? b.error ?? `HTTP ${res.status}` })))
      .catch((err) => ({ error: err.message }));
  const loadMap = () => {
    // A running count, so a slow OpenStreetMap looks slow rather than stuck.
    const t0 = Date.now();
    const tick = setInterval(() => {
      const n = $('#rsWait');
      if (!still() || !n) return clearInterval(tick);
      n.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
    }, 1000);
    const ctl = new AbortController();
    const stop = setTimeout(() => ctl.abort(), 100000);
    return fetch(`/api/resortmap?resort=${encodeURIComponent(id)}`, { signal: ctl.signal })
      .then((res) => res.json().then((b) => (res.ok ? b : { error: b.detail ?? b.error ?? `HTTP ${res.status}` })))
      .catch((err) => ({ error: err.name === 'AbortError' ? 'no answer in 100 s' : err.message }))
      .then((m) => {
        clearInterval(tick);
        clearTimeout(stop);
        if (!still()) return;
        if (!m.error || m.stale) renderResortMap($('#routeMap'), { resort: r, data: m, country: r.country });
        $('#rsFacts').innerHTML = m.error && !m.stale
          ? `<p class="note">The runs and lifts could not be loaded from OpenStreetMap right now (${esc(m.error)}). ` +
            `Its public servers are sometimes busy.</p><button class="btn" id="rsRetry">Try again</button>`
          : factsHtml(m.facts, r) +
            (m.stale ? `<p class="note">From ${esc(String(m.fetchedAt).slice(0, 10))}: OpenStreetMap could not be reached for a fresh copy (${esc(m.error)}).</p>` : '');
        $('#rsRetry')?.addEventListener('click', () => {
          $('#rsFacts').innerHTML = '<p class="note">Trying OpenStreetMap again… <span id="rsWait">0 s</span></p>';
          loadMap();
        });
      });
  };
  loadMap();
  // Snow at the resort's point, like a tour's; in simulation the nearest tour's depth sets the winter.
  getJ(`/api/snowhistory?resort=${encodeURIComponent(id)}`).then((h) => still() && renderSnowHistory($('#snowHist'), h, tours[0]?.t ?? { snow: null }, 'the resort'));
  if (state.simulated) {
    // The simulation has no resort forecasts; the nearest tour's summit stands in, and says so.
    const near = tours[0]?.t;
    const fc = near ? state.outlook?.forecasts?.[near.name] : null;
    renderForecast($('#forecast'), fc ? { ...fc, place: `${near.name}, the nearest tour summit,` } : { error: 'not part of the simulation' });
  } else {
    fetch(`/api/forecast?resort=${encodeURIComponent(id)}`)
      .then((res) => res.json().then((b) => (res.ok ? b : { error: b.detail ?? b.error ?? `HTTP ${res.status}` })))
      .catch((err) => ({ error: err.message }))
      .then((fc) => still() && renderForecast($('#forecast'), fc.error ? fc : { ...fc, place: 'the resort' }));
  }
  drawMap();
  $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#detail').addEventListener('click', (e) => {
  const li = e.target.closest('.rstours [data-tour]');
  if (li) return selectTour(li.dataset.tour);
  const hut = e.target.closest('.hutlist [data-hut]');
  if (hut) selectHut(hut.dataset.hut);
});

/**
 * Snow depth through the winter: this one against the five before.
 * Out of season (July–September) the winter just gone is drawn instead, and
 * in simulated mode a made-up winter so far, ending at the simulated depth.
 */
function renderSnowHistory(el, h, t, place = "the tour's") {
  if (!el) return;
  if (!h || h.error || !h.seasons) {
    el.innerHTML = `<p class="note">Snow history could not be loaded right now${h?.error ? ` (${esc(h.error)})` : ''}.</p>`;
    return;
  }
  const has = (k) => (h.seasons[k]?.depth ?? []).some((v) => Number.isFinite(v));
  let seasons = h.seasons, current = h.current, today = h.today, opts = {};
  const prevKey = (k) => `${Number(k.slice(0, 4)) - 1}-${k.slice(2, 4)}`;
  if (state.simulated) {
    // A made-up winter so far, shaped like the average and ending at the
    // simulated depth, "today" in mid-February.
    const base = snowHistoryModel({ seasons, current, today: `${Number(current.slice(0, 4)) + 1}-02-15` });
    const f = Number.isFinite(base.avgNow) && base.avgNow > 0 ? Math.max(0.4, Math.min(1.8, (t.snow?.depthCm ?? base.avgNow) / base.avgNow)) : 1;
    const fake = base.avg.map((v, i) => (i <= base.todayIdx && Number.isFinite(v) ? Math.round(v * f * (0.93 + 0.07 * Math.sin(i / 6))) : null));
    seasons = { ...seasons, [current]: { start: `${current.slice(0, 4)}-10-01`, depth: fake } };
    today = base.today;
    opts = { note: 'simulated winter' };
  } else if (!has(current) && has(prevKey(current))) {
    current = prevKey(current);
    today = `${Number(current.slice(0, 4)) + 1}-06-30`;
    opts = { lastWinter: true };
  }
  const m = snowHistoryModel({ seasons, current, today });
  if (!m.past.length) {
    el.innerHTML = '<p class="note">No earlier winters to compare with yet.</p>';
    return;
  }
  el.innerHTML = snowHistorySvg(m, opts) +
    `<p class="note">seNorge snow model at ${place === 'the resort' ? "the resort's" : place} 1 km grid cell${h.altitude ? ` (${h.altitude} m)` : ''}, daily at 06:00. ` +
    `Dashed: the average of the ${m.past.length} winters before; shaded: their lowest to highest.` +
    (opts.lastWinter ? ' The new winter starts on 1 October; until then this shows the last one.' : '') +
    (opts.note ? ' This winter is simulated.' : '') + `</p>`;
  linkSnowHistoryHover(el, m, { lastWinter: Boolean(opts.lastWinter) });
}

async function loadTourExtras(t, reg) {
  const q = encodeURIComponent(t.name);
  const still = () => state.sel === t.name;
  const view = state.tourView;
  const getJson = (url) =>
    fetch(url)
      .then((r) => r.json().then((b) => (r.ok ? b : { error: b.detail ?? b.error ?? `HTTP ${r.status}`, ...b })))
      .catch((e) => ({ error: e.message }));

  getJson(`/api/snowhistory?tour=${q}`).then((h) => still() && renderSnowHistory($('#snowHist'), h, t));
  if (!state.huts) loadHuts();

  // Route, terrain and photos all feed the one map; repaint as each arrives.
  const paint = () => {
    if (!still()) return;
    const mapEl = $('#routeMap');
    // Your photos first, then Commons; one numbering, so a number on the
    // map finds its photo in either list.
    const own = (view.own?.photos ?? []).map((p) => ({ ...p, own: true }));
    renderRouteMap(mapEl, {
      route: view.route?.error ? { found: false, reason: view.route.error } : view.route,
      tour: t,
      country: reg.country,
      terrain: view.terrain?.error ? null : view.terrain,
      photos: [...own, ...(view.photos?.photos ?? [])],
      // Today's problems: steep slopes they cover are shaded on the map,
      // from the fine slope grid once it has arrived.
      problems: reg.bulletin?.problems ?? [],
      slopes: view.slopes?.error ? null : view.slopes,
      danger: reg.bulletin?.danger ?? null,
    });
    if (view.route) renderProfile($('#routeProfile'), view.route, mapEl);
    $('#ownPhotosWrap').hidden = !own.length;
    if (own.length) renderOwnPhotos($('#ownPhotos'), own, t, mapEl);
    if (view.photos) {
      // The terrain grid goes along, so an empty result can be drawn instead.
      renderPhotos($('#photos'), { ...view.photos, terrain: view.terrain?.error ? null : view.terrain }, t, mapEl, own.length);
    }
  };

  getJson(`/api/track?tour=${q}`).then((route) => {
    if (!still()) return;
    if (route.error && route.found === undefined) route = { found: false, reason: `Route lookup failed (${route.error}).` };
    view.route = route;
    state.route = route;
    $('#routeMeta').innerHTML = routeSummary(route, t);
    paint();
  });
  getJson(`/api/terrain?tour=${q}`).then((terrain) => {
    view.terrain = terrain;
    paint();
  });
  getJson(`/api/photos?tour=${q}`).then((photos) => {
    view.photos = photos;
    paint();
  });
  // The fine grid for steepness is only worth fetching when there is a
  // bulletin with problems to shade.
  if (reg.bulletin?.problems?.length) {
    getJson(`/api/slopes?tour=${q}`).then((slopes) => {
      view.slopes = slopes;
      paint();
    });
  }
  getJson(`/api/own-photos?tour=${q}`).then((own) => {
    view.own = own?.error ? null : own;
    paint();
  });
  if (state.simulated) {
    const fc = state.outlook?.forecasts?.[t.name];
    renderForecast($('#forecast'), fc ? { ...fc, simulated: true } : { error: 'not part of the simulation' }, t, state.outlook?.bulletins?.[t.region]);
  } else {
    getJson(`/api/forecast?tour=${q}`).then((fc) => {
      if (still()) renderForecast($('#forecast'), fc, t, state.outlook?.bulletins?.[t.region]);
    });
  }
}

function selectRegion(id) {
  const reg = regionById()[id];
  if (!reg) return;
  state.selRegion = id;
  state.sel = null;
  const inReg = (state.snapshot?.tours ?? []).filter((t) => t.region === id);

  $('#detailTitle').textContent = reg.name;
  $('#detail').innerHTML =
    `<p class="bulletintext">${dangerPill(reg)} &nbsp; <span class="note">${
      reg.country === 'NO'
        ? 'Norwegian forecast region (NVE / Varsom)'
        : 'Swedish forecast region (Naturvårdsverket)'
    }${reg.bulletin?.publishTime ? ` · published ${esc(String(reg.bulletin.publishTime).slice(0, 16).replace('T', ' '))}` : ''}</span></p>` +
    snowBlock(reg.snow, `Across ${reg.snow?.sampleCount ?? 0} tour points`) +
    bulletinBlock(reg) +
    `<div class="linkrow">${reg.bulletinUrl ? `<a class="btn primary" href="${esc(reg.bulletinUrl)}" target="_blank" rel="noopener">Open bulletin</a>` : ''}` +
    (reg.country === 'NO'
      ? `<a class="btn" href="https://www.regobs.no/" target="_blank" rel="noopener">Regobs observations</a>`
      : '') +
    `<a class="btn" href="https://www.senorge.no/" target="_blank" rel="noopener">seNorge snow maps</a></div>` +
    (inReg.length
      ? `<p class="note" style="margin:14px 0 4px">Tours in this region</p><div>` +
        inReg
          .sort((a, b) => (b.snow?.new48 ?? -1) - (a.snow?.new48 ?? -1))
          .map(
            (t) =>
              `<button class="btn" data-tour="${esc(t.name)}" style="margin:0 6px 6px 0">${esc(t.name)}${t.snow?.depthCm != null ? ` <span class="grade">${cm(t.snow.depthCm)} cm</span>` : ''}</button>`
          )
          .join('') +
        `</div>`
      : '<p class="note">No tours listed in this region yet.</p>');

  drawMap();
}

$('#detail').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tour]');
  if (t) return selectTour(t.dataset.tour);
  const r = e.target.closest('[data-region]');
  if (r) selectRegion(r.dataset.region);
});

/* ------------------------------------------------------------------ *
 * alerts + sources
 * ------------------------------------------------------------------ */

function renderAlerts() {
  let a = state.alerts;
  const el = $('#alerts');
  if (!a) {
    el.innerHTML = '<p class="quiet">Alert status unavailable.</p>';
    return;
  }

  const channels = [a.channels?.email && 'email', a.channels?.ntfy && 'push'].filter(Boolean);
  $('#alertMeta').textContent =
    `over ${a.threshold} cm / 48 h · ` +
    (channels.length ? `notifying by ${channels.join(' + ')}` : 'no notification channel configured') +
    ` · quiet ${a.quietHours.from}:00–${a.quietHours.to}:00`;

  // Alerts in hidden countries are still sent by the server; the page just
  // says how many it is not showing.
  const hidden = (a.firing ?? []).filter((f) => f.country && !inSel(f.country)).length;
  a = { ...a, firing: (a.firing ?? []).filter((f) => !f.country || inSel(f.country)) };
  const hiddenNote = hidden ? `<p class="note">${hidden} more in countries you have hidden.</p>` : '';
  if (!a.firing?.length) {
    el.innerHTML =
      `<p class="quiet">Nothing over ${a.threshold} cm in the last 48 hours. ` +
      `The server checks on every refresh and will notify you without the page being open.</p>` +
      (a.pending?.length ? `<p class="note">${a.pending.length} alert(s) held until quiet hours end.</p>` : '') + hiddenNote;
    return;
  }

  el.innerHTML =
    `<div class="firedgrid">` +
    a.firing
      .map((f) => {
        const danger = f.dangerKnown
          ? `${dangerChip(f.danger)}<span class="pav">${problemIcons(f.problems, { danger: f.danger, size: 20 })}</span>`
          : '<span class="note">danger level not available — read the bulletin</span>';
        return (
          `<div class="fired"><div class="big">+${cm(f.new48)}<span style="font-size:12px"> cm</span></div>` +
          `<div style="flex:1"><div class="who">${esc(f.regionName)}</div>` +
          `<div class="quiet">${f.depthCm != null ? `${cm(f.depthCm)} cm base · ` : ''}${danger}` +
          `${f.topTour ? ` · biggest load near ${esc(f.topTour)}` : ''}</div>` +
          (f.problems?.length
            ? `<div style="margin-top:4px">${f.problems.map((p) => `<span class="problem">${esc(p)}</span>`).join('')}</div>`
            : '') +
          `<div class="linkrow" style="margin-top:6px">` +
          `<a class="btn primary" href="${esc(f.bulletinUrl)}" target="_blank" rel="noopener">Read the bulletin first</a>` +
          `<button class="btn" data-region="${esc(f.regionId)}">Show region</button></div></div></div>`
        );
      })
      .join('') +
    `</div>` +
    `<p class="quiet">A big load is exactly when the bulletin matters most — these are “go and read”, not “go and ski”.</p>` + hiddenNote;
}

$('#alerts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-region]');
  if (b) {
    selectRegion(b.dataset.region);
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

function renderSources() {
  const s = state.snapshot?.sources ?? {};
  const cards = [
    ['Varsom (NO avalanche)', s.varsom?.ok, s.varsom ? `${s.varsom.regions} regions fetched` : 'not run'],
    [
      'lavinprognoser.se (SE avalanche)',
      s.lavinprognoser?.ok,
      s.lavinprognoser ? `${s.lavinprognoser.regions} regions · scraped, best-effort` : 'not run',
    ],
    ['seNorge (snow depth)', s.senorge?.ok, s.senorge ? `${s.senorge.points} tour points sampled` : 'not run'],
    [
      'Regobs (observations)',
      s.regobs?.enabled ? s.regobs.verified : null,
      s.regobs?.enabled
        ? s.regobs.verified
          ? 'enabled and returning data'
          : `enabled but unverified${s.regobs.lastError ? `: ${s.regobs.lastError}` : ''}`
        : 'disabled — using the forecaster’s observation summary instead',
    ],
  ];

  // Which countries each source serves (seNorge's grid covers both).
  const COUNTRY_OF = [['NO'], ['SE'], ['NO', 'SE'], ['NO']];
  const v = state.version;
  const since = v?.startedAt ? new Date(v.startedAt) : null;
  const versionCard =
    `<div class="src version"><h4>Fjällskred version</h4><div class="note">` +
    (v?.version
      ? `<b class="vnum">v${esc(v.version)}</b>` +
        (v.image && v.image !== 'latest' ? ` · image ${esc(v.image)}` : '') +
        (since ? `<br>running since ${esc(since.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : '')
      : v === undefined ? 'checking…' : 'unknown (server older than v4.9)') +
    `</div></div>`;
  // Where the resort lists come from, and whether they are current.
  const rs = state.resorts?.sources ?? null;
  const rsCard = rs
    ? `<div class="src${Object.values(rs).some((x) => x.stale) ? ' bad' : ''}"><h4>Ski resorts</h4><div class="note">` +
      Object.entries(rs)
        .filter(([k]) => inSel(k.toUpperCase()))
        .map(([k, x]) => `${k.toUpperCase()}: ${x.count} from ${esc(x.name)}${x.stale ? ` · not refreshed${x.error ? ` (${esc(String(x.error).slice(0, 80))})` : ''}` : ''}`)
        .join('<br>') +
      `</div></div>`
    : '';

  const ns = v?.nightScan;
  const nightCard = ns
    ? `<div class="src${ns.enabled ? '' : ' bad'}"><h4>Ski-area maps (OpenStreetMap)</h4><div class="note">` +
      `${ns.stored} of ${ns.resorts} resorts stored` +
      (ns.oldestDays != null ? ` · oldest ${ns.oldestDays} days` : '') +
      `<br>` +
      (!ns.enabled
        ? 'night scan off (NIGHT_SCAN=off)'
        : ns.running
          ? `night scan running now${ns.current ? `: ${esc(ns.current)}` : ''}`
          : `night scan ${esc(ns.window)}, refreshes after ${ns.maxAgeDays} days and after every upgrade` +
            (ns.due ? ` · ${ns.due} to do` : ' · all up to date') +
            (ns.lastRun ? `<br>last night: ${ns.lastDone} stored${ns.lastFailed ? `, ${ns.lastFailed} failed` : ''}` : '')) +
      `</div></div>`
    : '';
  $('#sources').innerHTML =
    cards
      .filter((c, i) => COUNTRY_OF[i].some(inSel))
      .map(
        ([name, ok, detail]) =>
          `<div class="src${ok === false ? ' bad' : ''}"><h4>${esc(name)}</h4><div class="note">${esc(detail)}</div></div>`
      )
      .join('') + rsCard + nightCard + versionCard;
}

// The running version, for the sources box: asked once per page load.
fetch('/api/version')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
  .then((v) => {
    state.version = v;
    if (state.snapshot) renderSources();
  });

/* ------------------------------------------------------------------ *
 * controls
 * ------------------------------------------------------------------ */

function fillRegionSelect() {
  const sel = $('#fRegion');
  const cur = state.region;
  const regions = (state.snapshot?.regions ?? []).filter(
    (r) => !r.offMap && inSel(r.country)
  );
  sel.innerHTML =
    '<option value="">All regions</option>' +
    regions.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  if (regions.some((r) => r.id === cur)) sel.value = cur;
  else state.region = '';
}

$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    state.layer = b.dataset.layer;
    drawMap();
  })
);
$('#showTours').addEventListener('change', (e) => {
  state.showTours = e.target.checked;
  drawMap();
});
$('#showHuts').addEventListener('change', (e) => {
  state.showHuts = e.target.checked;
  if (state.showHuts && !state.huts) loadHuts();
  drawMap();
});
$('#showResorts').addEventListener('change', (e) => {
  state.showResorts = e.target.checked;
  if (state.showResorts && !state.resorts) loadResorts();
  drawMap();
});
// Live resort status changes through the day; refresh it while shown.
setInterval(() => state.showResorts && loadResorts(), 30 * 60 * 1000);
$('#q').addEventListener('input', (e) => {
  state.q = e.target.value;
  renderList();
  drawMap();
});
$('#fTrack').addEventListener('change', (e) => {
  state.track = e.target.value;
  renderList();
  drawMap();
});
$('#fRegion').addEventListener('change', (e) => {
  state.region = e.target.value;
  renderList();
  drawMap();
});
$('#fGrade').addEventListener('change', (e) => {
  state.grade = e.target.value;
  renderList();
  drawMap();
});
$('#fSort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderList();
});

/* ------------------------------------------------------------------ *
 * simulated winter
 *
 * Everything is invented in the browser from the real region and tour
 * lists; the service is not asked for anything and is not told anything.
 * "Refresh now" loads the live data again.
 * ------------------------------------------------------------------ */

async function enterSimulation() {
  let regions = state.snapshot?.regions;
  let tours = state.snapshot?.tours;
  if (!regions?.length || !tours?.length) {
    // Nothing loaded yet (out of season, or the first refresh has not run):
    // the static lists are enough to invent a winter over.
    const meta = await fetch('/api/meta').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    regions = meta?.regions ?? [];
    tours = meta?.tours ?? [];
  }
  if (!regions.length) return;
  const sim = simulate({ regions, tours, resorts: state.resorts, threshold: state.alerts?.threshold ?? 30 });
  state.simulated = true;
  state.snapshot = sim.snapshot;
  state.alerts = sim.alerts;
  state.outlook = sim.outlook;
  if (sim.resorts) state.resorts = sim.resorts;
  if (state.huts && !state.huts.places?.length) state.huts = simulateHuts(sim.snapshot.tours);
  state.sel = null;
  state.selRegion = null;
  $('#simBanner').hidden = false;
  $('#simBtn').classList.add('on');
  $('#simBtn').textContent = 'Simulated data · on';
  $('#detailTitle').textContent = 'Select a tour or region';
  $('#detail').innerHTML = '<p class="note">Simulated conditions. Pick a pin on the map or a tour from the list.</p>';
  renderFreshness();
  initCountries();
  renderCountryBar();
  fillRegionSelect();
  renderAlerts();
  renderList();
  renderSources();
  renderPlanner();
  drawMap();
  if (state.showResorts) loadResorts();
}

function leaveSimulation() {
  state.simulated = false;
  state.resorts = null;
  if (state.huts?.simulated) state.huts = null;
  $('#simBanner').hidden = true;
  $('#simBtn').classList.remove('on');
  $('#simBtn').textContent = 'Simulated data';
  // Say so at once: fetching the real snapshot can take a moment.
  $('#freshDot').className = 'dot';
  $('#freshTxt').textContent = 'loading live data…';
}

$('#simBtn').addEventListener('click', async () => {
  if (state.simulated) {
    leaveSimulation();
    await load();
    return;
  }
  await enterSimulation();
});

$('#refreshBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  // Refreshing always ends the simulation: the point of the button is the
  // real data.
  leaveSimulation();
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await load();
  } catch {
    $('#freshTxt').textContent = 'refresh failed';
    $('#freshDot').className = 'dot bad';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
});

initAvalancheTips();
load();
// Pick up server-side refreshes without a reload; cheap, and the server
// coalesces so this cannot stampede upstream.
setInterval(() => !state.simulated && load(), 10 * 60 * 1000);

/* ------------------------------------------------------------------ *
 * trip planner
 * ------------------------------------------------------------------ */

const PLAN_KEY = 'fjallskred.plan.v1';
const PLACES = [
  ['', 'Anywhere (no distance)'],
  ['69.65,18.96', 'Tromsø'], ['68.44,17.43', 'Narvik'], ['67.86,20.23', 'Kiruna'], ['67.28,14.40', 'Bodø'],
  ['63.43,10.39', 'Trondheim'], ['62.47,6.15', 'Ålesund'], ['63.40,13.08', 'Åre'], ['63.18,14.64', 'Östersund'],
  ['60.39,5.32', 'Bergen'], ['59.91,10.75', 'Oslo'], ['63.83,20.26', 'Umeå'], ['59.33,18.07', 'Stockholm'], ['57.71,11.97', 'Göteborg'],
];
const planPrefs = { maxDifficulty: 3, maxDanger: 3, from: '', tripLen: 3, ...readStore(PLAN_KEY, {}) };

function initPlanner() {
  $('#pFrom').innerHTML = PLACES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  $('#pMaxDiff').value = String(planPrefs.maxDifficulty);
  $('#pMaxDanger').value = String(planPrefs.maxDanger);
  $('#pFrom').value = planPrefs.from;
  $('#pTripLen').value = String(planPrefs.tripLen);
  $('#pTripLen').addEventListener('change', () => {
    planPrefs.tripLen = +$('#pTripLen').value;
    writeStore(PLAN_KEY, planPrefs);
    renderPlanner();
  });
  $('#tripAreas').addEventListener('click', (e) => {
    if (e.target.closest('[data-av]')) return;
    const rs = e.target.closest('[data-rlat]');
    if (rs) {
      e.preventDefault();
      return focusResort(+rs.dataset.rlat, +rs.dataset.rlon);
    }
    const r = e.target.closest('[data-tour]');
    if (r) selectTour(r.dataset.tour);
  });
  const save = () => {
    planPrefs.maxDifficulty = +$('#pMaxDiff').value;
    planPrefs.maxDanger = +$('#pMaxDanger').value;
    planPrefs.from = $('#pFrom').value;
    writeStore(PLAN_KEY, planPrefs);
    renderPlanner();
  };
  ['#pMaxDiff', '#pMaxDanger', '#pFrom'].forEach((id) => $(id).addEventListener('change', save));
  $('#planDays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    state.planDay = +b.dataset.k;
    renderPlanner();
  });
  $('#planList').addEventListener('click', (e) => {
    // A tap on a danger or problem symbol explains it; it does not open the tour.
    if (e.target.closest('[data-av]')) return;
    const r = e.target.closest('[data-tour]');
    if (r) selectTour(r.dataset.tour);
  });
  $('#planMatrix').addEventListener('click', (e) => {
    const c = e.target.closest('[data-k]');
    if (c) state.planDay = +c.dataset.k;
    const t = e.target.closest('[data-tour]');
    if (t && !c) return selectTour(t.dataset.tour);
    renderPlanner();
  });
}

async function loadOutlook() {
  try {
    const r = await fetch('/api/outlook');
    state.outlook = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (err) {
    state.outlook = { error: err.message };
  }
  renderPlanner();
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (iso, k) => (k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]);
const shortDate = (iso) => `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}`;
const scoreBand = (v) => (v >= 75 ? 4 : v >= 60 ? 3 : v >= 40 ? 2 : 1);
const CONF = { high: 'high confidence', medium: 'medium confidence', low: 'weather only', none: 'no bulletin', noforecast: 'no avalanche forecast · own judgement' };

function renderPlanner() {
  const tours = state.snapshot?.tours;
  if (!tours) return;
  const o = state.outlook;
  if (!o) return;
  if (o.error) {
    $('#planList').innerHTML = `<p class="pempty">The planner needs the summit forecasts, which could not be loaded right now (${esc(o.error)}).</p>`;
    $('#planMatrix').innerHTML = '';
    return;
  }
  const [la, lo] = planPrefs.from ? planPrefs.from.split(',').map(Number) : [NaN, NaN];
  const regs = regionById();
  const p = plan({
    tours: tours.filter((t) => inSel(regs[t.region]?.country)),
    outlook: o,
    prefs: { maxDifficulty: planPrefs.maxDifficulty, maxDanger: planPrefs.maxDanger, from: Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lon: lo } : null },
  });
  if (!p.dates.length) {
    $('#planList').innerHTML = '<p class="pempty">No forecast days available yet.</p>';
    return;
  }
  state.planDay = Math.min(state.planDay, p.dates.length - 1);
  state.lastPlan = p;
  const k = state.planDay;
  const day = p.days[k];

  $('#planDays').innerHTML = p.dates
    .map((d, i) => {
      const good = p.days[i].rows.filter((r) => r.status === 'ok' || r.status === 'caution').length;
      return `<button class="daychip" data-k="${i}" role="tab" aria-selected="${i === k}">${dayName(d, i)}<small>${shortDate(d)} · ${good} pass</small></button>`;
    })
    .join('');

  const pass = day.rows.filter((r) => r.status === 'ok' || r.status === 'caution');
  const excluded = day.rows.filter((r) => r.status === 'excluded');
  const unassessed = day.rows.filter((r) => r.status === 'unassessed');
  const regionName = (id) => regionById()[id]?.name ?? id;

  // That day's bulletin for a region: danger and problems, no directions.
  const dayBulletin = (regionId) => (o.bulletins?.[regionId] ?? []).find((b) => b.date === day.date) ?? null;
  const avChips = (r) => {
    const b = dayBulletin(r.region);
    const d = b?.danger ?? r.danger;
    if (!d) return '';
    return `<span class="pav">${dangerChip(d, { small: true })}${problemIcons(b?.problems, { danger: d, size: 20 })}</span>`;
  };
  const row = (r, i) => {
    const why = [...r.why];
    if (r.startNote) why.push(r.startNote);
    if (r.km != null) why.push(`${r.km} km away`);
    return (
      `<div class="prow" data-tour="${esc(r.tour)}" data-explain="${k}" tabindex="0">` +
      `<span class="prank">${i + 1}</span>` +
      `<span class="pname">${esc(r.tour)}<span class="preg">${esc(regionName(r.region))}</span>${avChips(r)}</span>` +
      `<span class="pscore" title="How this score is calculated">${r.score}<small>/ 100 ⓘ</small></span>` +
      `<span class="pbar"><i style="width:${r.score}%"></i></span>` +
      `<span class="pwhy"><span class="av">${esc(r.avalanche)}.</span> ${esc(why.join(' · '))}</span>` +
      `<span class="ptags">${r.status === 'caution' ? '<span class="ptag caution">caution</span>' : ''}` +
      `<span class="ptag ${r.confidence === 'high' ? '' : 'low'}">${CONF[r.confidence]}</span></span>` +
      `</div>`
    );
  };

  $('#planMeta').textContent = `${dayName(day.date, k)} ${shortDate(day.date)}: ${pass.length} of ${day.rows.length} tours pass the avalanche filter` +
    (p.hiddenByDifficulty ? ` · ${p.hiddenByDifficulty} hidden above difficulty ${planPrefs.maxDifficulty}` : '');

  $('#planList').innerHTML =
    (pass.length
      ? pass.slice(0, 8).map(row).join('')
      : `<p class="pempty"><strong>Nothing passes the avalanche filter on this day</strong> with your limits. Consider another day, or a resort day: tick “ski resorts” on the map to see what is open.</p>`) +
    (excluded.length
      ? `<details class="pexcl"><summary>${excluded.length} excluded by the avalanche filter</summary><ul>${excluded
          .slice(0, 40)
          .map((r) => `<li><strong>${esc(r.tour)}</strong>: ${esc(r.avalanche)}</li>`)
          .join('')}</ul></details>`
      : '') +
    (unassessed.length
      ? `<details class="pexcl"><summary>${unassessed.length} without a bulletin for this day (not ranked)</summary><ul>${unassessed
          .map((r) => `<li><strong>${esc(r.tour)}</strong>: ${esc(r.avalanche)}</li>`)
          .join('')}</ul></details>`
      : '');

  // Matrix: tours that pass on at least one day, best first.
  const byTour = new Map();
  p.days.forEach((d, i) => d.rows.forEach((r) => {
    if (!byTour.has(r.tour)) byTour.set(r.tour, []);
    byTour.get(r.tour)[i] = r;
  }));
  const ranked = [...byTour.entries()]
    .map(([name, cells]) => ({ name, cells, best: Math.max(...cells.map((c) => (c.status === 'ok' || c.status === 'caution' ? c.score : -1))) }))
    .filter((x) => x.best >= 0)
    .sort((a, b) => b.best - a.best)
    .slice(0, 14);
  const selName = pass[0]?.tour;
  $('#planMatrix').innerHTML =
    `<table class="matrix"><thead><tr><th style="text-align:left">Best tours this week</th>${p.dates
      .map((d, i) => `<th class="${i === k ? 'sel' : ''}">${dayName(d, i).slice(0, 3)}</th>`)
      .join('')}</tr></thead><tbody>` +
    ranked
      .map(
        (x) =>
          `<tr class="${x.name === selName ? 'sel' : ''}"><td class="tn" data-tour="${esc(x.name)}" title="${esc(x.name)}">${esc(x.name)}</td>` +
          x.cells
            .map((c, i) => {
              if (!c) return '<td></td>';
              const ex = `data-k="${i}" data-explain="${i}" data-name="${esc(x.name)}"`;
              if (c.status === 'excluded') return `<td><span class="cell excluded" ${ex}>✕</span></td>`;
              if (c.status === 'unassessed') return `<td><span class="cell unassessed" ${ex}>?</span></td>`;
              const b = scoreBand(c.score);
              return `<td><span class="cell ${c.status}${c.confidence === 'low' ? ' low' : ''}" ${ex} style="background:var(--ro${b});color:var(--rg${b})">${c.score}</span></td>`;
            })
            .join('') +
          `</tr>`
      )
      .join('') +
    `</tbody></table>` +
    `<div class="mlegend"><span><span class="cell" style="background:var(--ro4);color:var(--rg4)">80</span>score (darker = better)</span>` +
    `<span><span class="cell caution" style="background:var(--ro2)">55</span>caution</span>` +
    `<span><span class="cell excluded">✕</span>excluded</span><span><span class="cell low" style="background:var(--ro3);color:var(--rg3)">70</span>weather only</span></div>`;
  renderTrip(p, k, regionName);
}

/** "A few days in one area": the best regions for a trip starting on the selected day. */
function renderTrip(p, k, regionName) {
  const t = planTrip(p, { start: k, length: planPrefs.tripLen, top: 3 });
  if (!state.resorts && !state.resortsLoading) {
    state.resortsLoading = true;
    loadResorts();
  }
  const end = t.dates[t.dates.length - 1];
  $('#tripMeta').textContent = t.length
    ? `${dayName(t.dates[0], k)} ${shortDate(t.dates[0])}${t.length > 1 ? ` – ${shortDate(end)}` : ''}` +
      (t.length < planPrefs.tripLen ? ` (the forecast only reaches ${t.length} day${t.length > 1 ? 's' : ''} from here)` : '') +
      ' · one different tour per day, best area first'
    : '';
  if (!t.areas.length) {
    $('#tripAreas').innerHTML = '<p class="pempty">No area has a tour that passes the avalanche filter in these days.</p>';
    return;
  }
  $('#tripAreas').innerHTML = t.areas
    .map((a, i) => {
      const b = scoreBand(a.mean);
      const days = a.days
        .map((d) => {
          const r = d.row;
          const label = `<span class="tdday">${dayName(d.date, d.k).slice(0, 3)} ${shortDate(d.date)}</span>`;
          // A poor touring day (or none): point to the lifts nearby.
          const poor = !r || r.score < 50 || (r.parts?.weather ?? 1) < 0.4;
          const near = poor ? resortsNear(a.days.map((x) => x.row?.tour).filter(Boolean)) : [];
          const resortHint = near.length
            ? `<span class="tdresort">${!r ? 'Nothing passes' : 'Poor touring weather'}: a resort day? ${near
                .map(({ r: rs, d: km }) => `<a href="#" data-rlat="${rs.lat}" data-rlon="${rs.lon}">${esc(rs.name)}</a> <small>${Math.round(km)} km</small>`)
                .join(' · ')}</span>`
            : '';
          if (!r) return `<li class="tdrest">${label}<span class="tdtour">rest day: nothing passes</span>${resortHint}</li>`;
          const extra = [r.window?.text && r.window.fit !== 'no' ? r.window.text : null, r.surface && r.surface !== 'old snow' ? r.surface : null].filter(Boolean).join(' · ');
          return (
            `<li data-tour="${esc(r.tour)}" tabindex="0">${label}<span class="tdtour">${esc(r.tour)}` +
            `${r.status === 'caution' ? ' <span class="ptag caution">caution</span>' : ''}</span>` +
            `<span class="tdx">${esc(extra)}</span><span class="tdscore">${r.score}</span>${resortHint}</li>`
          );
        })
        .join('');
      return (
        `<div class="tarea"><div class="tahd"><span class="prank">${i + 1}</span><strong>${esc(regionName(a.region))}</strong>` +
        `<span class="cell" style="background:var(--ro${b});color:var(--rg${b})" title="Mean score over the trip, rest days count 0">${a.mean}</span>` +
        `<span class="note">${a.tourDays} of ${a.days.length} days${a.restDays ? `, ${a.restDays} rest` : ''} · ${a.tours} tour${a.tours === 1 ? '' : 's'} in the area</span></div>` +
        `<ol class="tdays">${days}</ol></div>`
      );
    })
    .join('');
}

initPlanner();

/* ------------------------------------------------------------------ *
 * "how was this scored?" box
 * ------------------------------------------------------------------ */

const tip = document.createElement('div');
tip.id = 'planTip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.appendChild(tip);

function explainTarget(el) {
  // The avalanche symbols have their own explanation; don't stack two boxes.
  if (el?.closest?.('[data-av]')) return null;
  const t = el?.closest?.('[data-explain]');
  if (!t || !state.lastPlan) return null;
  const k = +t.dataset.explain;
  const name = t.dataset.name ?? t.dataset.tour;
  const row = state.lastPlan.days[k]?.rows.find((r) => r.tour === name);
  return row ? { t, k, row } : null;
}

function showTip(hit, at) {
  const d = state.lastPlan.days[hit.k];
  tip.innerHTML = explainHtml(hit.row, { dayLabel: `${dayName(d.date, hit.k)} ${shortDate(d.date)}` });
  tip.hidden = false;
  const W = tip.offsetWidth, H = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
  let x, y;
  if (at) {
    x = at.x + 18;
    y = at.y + 14;
    if (x + W > vw - 8) x = at.x - W - 18;
  } else {
    const r = hit.t.getBoundingClientRect();
    x = r.right + 10;
    y = r.top;
    if (x + W > vw - 8) x = r.left - W - 10;
  }
  x = Math.max(8, Math.min(vw - W - 8, x));
  y = Math.max(8, Math.min(vh - H - 8, y));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.dataset.for = `${hit.k}|${hit.row.tour}`;
}
const hideTip = () => {
  tip.hidden = true;
  delete tip.dataset.for;
};

const planCard = $('#planCard');
planCard.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const hit = explainTarget(e.target);
  if (!hit) return hideTip();
  showTip(hit, { x: e.clientX, y: e.clientY });
});
planCard.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hideTip());
planCard.addEventListener('focusin', (e) => {
  const hit = explainTarget(e.target);
  if (hit) showTip(hit);
});
planCard.addEventListener('focusout', hideTip);
// Touch: tap the score to open the explanation; tap anywhere else to close.
planCard.addEventListener('click', (e) => {
  if (!e.target.closest('.pscore')) return;
  const hit = explainTarget(e.target);
  if (!hit) return;
  e.stopPropagation();
  const key = `${hit.k}|${hit.row.tour}`;
  if (tip.dataset.for === key && !tip.hidden) hideTip();
  else showTip(hit);
}, true);
document.addEventListener('click', (e) => {
  if (!tip.hidden && !e.target.closest('#planTip, .pscore')) hideTip();
});
addEventListener('scroll', () => tip.dataset.for && !tip.matches(':hover') && hideTip(), { passive: true });