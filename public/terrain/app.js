/**
 * Fjällskred v5 — terrain & routes (/terrain).
 *
 * One page, like the tour editor: a pannable topo map with NVE's slope and
 * runout map (Norway) and shading worked out here from the terrain model
 * (slope, aspect, today's avalanche problems); a route you draw, measured by
 * the server every 25 m (/api/terrain/profile) and analysed in analysis.js;
 * a suggested way up (suggest.js) and a 3D view (view3d.js).
 */

import { SlippyMap } from './map.js';
import { DemStore, tileCells, tileRange, tileCount, mosaic, slopeAspect, mx, my, DEM_MIN_Z, DEM_MAX_Z, plan3d, combine3d, DETAIL_3D } from './dem.js';
import { analyse, slopeRgb, ASPECT_COLOURS, SLOPE_CLASSES, SLOPE_COLOURS, OCT8, octant, fmtKm, fmtHours } from './analysis.js';
import { renderProfile } from './profile.js';
import { suggestPath, simplify, snapNode } from './suggest.js';
import { classifyPoints } from './nve.js';
import { Terrain3D } from './view3d.js';
import { readHash, writeHash, savedRoutes, saveRoute, deleteRoute, FEATURES } from './routeio.js';
import { parseGpx, thinTrack, toGpx, gpxFileName } from './gpx.js';
import { renderWeather } from './weather.js';
import { dangerChip, problemIcons, initAvalancheTips } from '../avalanche.js';
import { problemAspects, problemBands } from '../planner.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slugify = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/å/gi, 'a').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const R = Math.PI / 180;
const MARGIN_KM = 12;

const S = {
  tours: [], regionsMeta: {}, resorts: [], zone: [], bulletins: {},
  route: [], undo: [], sel: -1, drawing: false,
  profile: null, profileKey: null, analysis: null, profileErr: null, pendingKey: null, runout: null, where: null,
  suggestion: null, picking: null, picks: [],
  ref: null, hover: null,
  shade: 'off', nve: true, opacity: 0.7,
  budget: null,
  fine: [],
  detail3d: (() => { try { return localStorage.getItem('fjallskred.detail3d') || 'normal'; } catch { return 'normal'; } })(),
};

const dem = new DemStore();
const protect = new Set();

/* ------------------------------------------------------------------ *
 * the service area and countries
 * ------------------------------------------------------------------ */

function inZone(lat, lon) {
  return S.zone.some((t) => Math.abs(t.lat - lat) <= MARGIN_KM / 111 && Math.abs(t.lon - lon) <= MARGIN_KM / (111 * Math.cos(t.lat * R)));
}
function tileInZone(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180, east = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / R, south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) / R;
  return S.zone.some((t) => {
    const dLat = MARGIN_KM / 111, dLon = MARGIN_KM / (111 * Math.cos(t.lat * R));
    return t.lat + dLat >= south && t.lat - dLat <= north && t.lon + dLon >= west && t.lon - dLon <= east;
  });
}
function nearest(lat, lon, list = S.zone) {
  let best = null, bd = Infinity;
  for (const t of list) {
    const d = (t.lat - lat) ** 2 + ((t.lon - lon) * Math.cos(lat * R)) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best ? { item: best, km: Math.sqrt(bd) * 111 } : null;
}
const countryMemo = new Map();
function tileCountry(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!countryMemo.has(k)) {
    const n = 2 ** z;
    const lon = ((x + 0.5) / n) * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) / R;
    countryMemo.set(k, nearest(lat, lon)?.item.country ?? 'NO');
  }
  return countryMemo.get(k);
}
const topoUrl = (z, x, y) => (tileInZone(z, x, y) ? `/tiles/${tileCountry(z, x, y) === 'SE' ? 'se' : 'no'}/${z}/${x}/${y}.png` : null);
const nveUrl = (z, x, y) => (tileInZone(z, x, y) && tileCountry(z, x, y) === 'NO' ? `/tiles/nve/${z}/${x}/${y}.png` : null);

/** The avalanche region for a point: the region of the nearest tour. */
function regionAt(lat, lon) {
  const n = nearest(lat, lon, S.tours);
  if (!n) return null;
  const meta = S.regionsMeta[n.item.region];
  const live = S.bulletins[n.item.region];
  return { id: n.item.region, name: meta?.name ?? n.item.region, country: meta?.country, bulletin: live?.bulletin ?? null, bulletinUrl: live?.bulletinUrl ?? meta?.bulletinUrl ?? null, tour: n.item.name, km: n.km };
}

/* ------------------------------------------------------------------ *
 * map
 * ------------------------------------------------------------------ */

const map = new SlippyMap($('#tmap'), {
  center: { lat: 61.6, lon: 8.3 },
  zoom: 11,
  layers: [
    { id: 'topo', url: topoUrl, minZ: 9, maxZ: 16 },
    { id: 'nve', url: nveUrl, minZ: 9, maxZ: 16, opacity: 0.7 },
  ],
});
dem.onTile(() => { map.requestRender(); updateStatus(); });

/* shading canvases, one 16 × 16 image per DEM tile and mode */
const shadeCache = new Map();
let problemSig = '';
function shadeImage(tile, mode, problems) {
  const k = `${tile.z}/${tile.x}/${tile.y}|${mode}|${mode === 'problems' ? problemSig : ''}`;
  if (shadeCache.has(k)) return shadeCache.get(k);
  const { slope, aspect, elev } = tileCells(tile);
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(16, 16);
  const probs = (problems ?? []).map((p) => ({ aspects: new Set(problemAspects(p.aspects)), bands: problemBands(p.heights) }));
  for (let k2 = 0; k2 < 256; k2++) {
    const s = slope[k2];
    let col = null, a = 0;
    if (mode === 'slope') {
      col = slopeRgb(s);
      a = col ? 235 : 0;
    } else if (mode === 'aspect') {
      const o = octant(aspect[k2]);
      if (o && s >= 10) { col = ASPECT_COLOURS[o]; a = s >= 25 ? 235 : 110; }
    } else if (mode === 'problems') {
      const o = octant(aspect[k2]);
      if (o && s >= 25 && probs.some((p) => p.aspects.has(o) && p.bands.some(([lo, hi]) => elev[k2] >= lo && elev[k2] <= hi))) {
        col = [192, 57, 43];
        a = s >= 30 ? 225 : 150;
      }
    }
    if (col) im.data.set([col[0], col[1], col[2], a], k2 * 4);
  }
  ctx.putImageData(im, 0, 0);
  shadeCache.set(k, c);
  if (shadeCache.size > 800) shadeCache.delete(shadeCache.keys().next().value);
  return c;
}

let shadeNote = '';
map.addCanvasPainter((ctx, m) => {
  shadeNote = '';
  if (S.shade === 'off') return;
  // One zoom coarser than the map (32 screen pixels per terrain cell, drawn
  // smoothly): a quarter of the heights per screenful, which is what used up
  // the daily budget. Still 37 m cells at the closest zoom.
  const z = Math.round(m.zoom) - 1;
  if (z < DEM_MIN_Z) { shadeNote = 'zoom in to see the shading'; return; }
  const dz = Math.min(DEM_MAX_Z, z);
  const tiles = m.visibleTiles(dz, dz).filter((t) => tileInZone(t.z, t.x, t.y));
  if (tiles.length > 24) { shadeNote = 'zoom in to see the shading'; return; }
  const problems = regionAt(m.center().lat, m.center().lon)?.bulletin?.problems ?? [];
  problemSig = JSON.stringify(problems.map((p) => [p.aspects, p.heights]));
  const want = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
  dem.cancelQueued((k) => want.has(k) || protect.has(k));
  ctx.save();
  ctx.globalAlpha = S.opacity;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const t of tiles) {
    const tile = dem.get(t.z, t.x, t.y);
    if (!tile) { dem.load(t.z, t.x, t.y); continue; }
    if (tile.error || !tile.ele) continue;
    ctx.drawImage(shadeImage(tile, S.shade, problems), t.sx, t.sy, t.size, t.size);
  }
  ctx.restore();
});

/* vectors: pins, reference route, suggestion, the route, handles */
const poly = (m, pts) => pts.map((p) => m.project(p[0], p[1]).map((v) => v.toFixed(1)).join(',')).join(' ');

map.addSvgPainter((m) => {
  const out = [];
  const b = m.bounds();
  const inView = (lat, lon) => lat <= b.north + 0.05 && lat >= b.south - 0.05 && lon >= b.west - 0.1 && lon <= b.east + 0.1;

  if (m.zoom >= 9.5) {
    for (const t of S.zone) {
      if (!inView(t.lat, t.lon)) continue;
      const [x, y] = m.project(t.lat, t.lon);
      out.push(t.kind === 'resort'
        ? `<rect x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="8" height="8" class="tpin resort"/>`
        : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="tpin"/>`);
      if (m.zoom >= 11.5) out.push(`<text x="${(x + 7).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="tpinlabel">${esc(t.name)}</text>`);
    }
  }
  if (S.ref?.points?.length) {
    out.push(`<polyline points="${poly(m, S.ref.points)}" class="refline"><title>${esc(S.ref.name)}</title></polyline>`);
  }
  if (S.suggestion?.points?.length) {
    const p = poly(m, S.suggestion.points);
    out.push(`<polyline points="${p}" class="shalo"/><polyline points="${p}" class="sline"/>`);
  }
  for (const pk of S.picks) {
    const [x, y] = m.project(pk[0], pk[1]);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="pickpt"/>`);
  }

  const r = S.route;
  if (r.length) {
    const fresh = S.profile && S.profileKey === routeKey();
    if (r.length > 1) out.push(`<polyline points="${poly(m, r)}" class="rhalo"/>`);
    if (fresh) {
      // Coloured by the slope of the ground under each 25 m step.
      const smp = S.profile.samples;
      let run = [], col = null;
      const flush = () => {
        if (run.length > 1) out.push(`<polyline points="${run.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}" class="rline" style="stroke:${col}"/>`);
      };
      for (let i = 0; i < smp.length; i++) {
        const c = slopeRgb(Math.max(smp[i].slope ?? 0, smp[i + 1]?.slope ?? 0));
        const cc = c ? `rgb(${c.join(',')})` : 'var(--ink)';
        const pt = m.project(smp[i].lat, smp[i].lon);
        if (cc !== col) { if (run.length) { run.push(pt); flush(); } run = [pt]; col = cc; }
        else run.push(pt);
      }
      flush();
    } else if (r.length > 1) {
      out.push(`<polyline points="${poly(m, r)}" class="rline pending"/>`);
    }
    const handles = S.drawing || S.sel >= 0;
    r.forEach((p, i) => {
      const [x, y] = m.project(p[0], p[1]);
      if (handles || i === 0 || i === r.length - 1) {
        out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === S.sel ? 7 : 6}" class="rvert${i === S.sel ? ' sel' : ''}${i === 0 ? ' first' : ''}" data-grab="v" data-i="${i}"><title>${i === 0 ? 'Start' : i === r.length - 1 ? 'End' : `Point ${i + 1}`} — drag to move</title></circle>`);
      }
      if (handles && i < r.length - 1) {
        const [x2, y2] = m.project(r[i + 1][0], r[i + 1][1]);
        if (Math.hypot(x2 - x, y2 - y) > 28) out.push(`<circle cx="${((x + x2) / 2).toFixed(1)}" cy="${((y + y2) / 2).toFixed(1)}" r="4.5" class="rmid" data-grab="mid" data-i="${i}"><title>Drag to add a point</title></circle>`);
      }
    });
  }
  if (S.hover && Number.isFinite(S.hover.lat)) {
    const [x, y] = m.project(S.hover.lat, S.hover.lon);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="hovermk"/>`);
  }
  return out.join('');
});

/* ------------------------------------------------------------------ *
 * editing the route
 * ------------------------------------------------------------------ */

const routeKey = () => JSON.stringify(S.route.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]));
function pushUndo() {
  S.undo.push(S.route.map((p) => p.slice()));
  if (S.undo.length > 100) S.undo.shift();
}
function changed({ analyseNow = false } = {}) {
  S.sel = Math.min(S.sel, S.route.length - 1);
  writeHash({ points: S.route, name: $('#rname').value.trim() || undefined });
  updateButtons();
  map.render();
  clearTimeout(changed.t);
  changed.t = setTimeout(runAnalysis, analyseNow ? 0 : 600);
  if (S.route.length < 2) renderPanel();
}

function setDrawing(on) {
  S.drawing = on;
  $('#drawBtn').setAttribute('aria-pressed', String(on));
  $('#drawBtn').textContent = on ? 'Done drawing' : S.route.length ? 'Edit route' : 'Draw route';
  $('#tmap').classList.toggle('drawing', on || !!S.picking);
  if (!on) S.sel = -1;
  if (on) { S.picking = null; S.picks = []; }
  map.render();
  message(on ? 'Click to add points. Drag a point to move it, drag a small ring to add one between. Delete removes the selected point.' : '');
}

function updateButtons() {
  const n = S.route.length;
  $('#undoBtn').disabled = !S.undo.length;
  $('#delBtn').disabled = S.sel < 0;
  $('#revBtn').disabled = n < 2;
  $('#clearBtn').disabled = !n;
  $('#saveBtn').disabled = n < 2;
  if (!S.drawing) $('#drawBtn').textContent = n ? 'Edit route' : 'Draw route';
  $('#gpxInBtn').disabled = !FEATURES.gpxImport;
  $('#gpxOutBtn').disabled = !FEATURES.gpxExport || n < 2;
}

function hitVertex(x, y) {
  let best = -1, bd = 12;
  S.route.forEach((p, i) => {
    const [px, py] = map.project(p[0], p[1]);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
function hitPin(x, y) {
  let best = null, bd = 10;
  for (const t of S.zone) {
    const [px, py] = map.project(t.lat, t.lon);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

map.on('click', (e) => {
  if (S.picking) {
    S.picks.push([e.lat, e.lon]);
    if (S.picks.length === 1) message('Now click where you want to get to.');
    if (S.picks.length === 2) {
      const [a, b] = S.picks;
      S.picking = null;
      $('#tmap').classList.remove('drawing');
      runSuggestion(a, b);
    }
    map.render();
    return;
  }
  if (S.drawing) {
    const v = hitVertex(e.x, e.y);
    if (v >= 0) { S.sel = v; updateButtons(); map.render(); return; }
    pushUndo();
    S.route.push([e.lat, e.lon]);
    S.sel = S.route.length - 1;
    changed();
    return;
  }
  const v = hitVertex(e.x, e.y);
  if (v >= 0) { S.sel = v; updateButtons(); map.render(); return; }
  if (S.sel >= 0) { S.sel = -1; updateButtons(); map.render(); }
  const pin = hitPin(e.x, e.y);
  if (pin?.kind === 'tour') loadTourRef(pin.slug, { fit: false });
});

// Dragging a point or a between-points ring. Handled before the map sees
// the pointer, so the map does not pan underneath.
let vdrag = null;
map.el.addEventListener('pointerdown', (e) => {
  const g = e.target.closest?.('[data-grab]');
  if (!g) return;
  e.stopPropagation();
  e.preventDefault();
  map.el.setPointerCapture(e.pointerId);
  vdrag = { id: e.pointerId, kind: g.dataset.grab, i: +g.dataset.i, x: e.clientX, y: e.clientY, moved: false };
}, true);
map.el.addEventListener('pointermove', (e) => {
  if (!vdrag || e.pointerId !== vdrag.id) return;
  if (!vdrag.moved && Math.hypot(e.clientX - vdrag.x, e.clientY - vdrag.y) < 4) return;
  const r = map.el.getBoundingClientRect();
  const p = map.unproject(e.clientX - r.left, e.clientY - r.top);
  if (!vdrag.moved) {
    pushUndo();
    if (vdrag.kind === 'mid') { S.route.splice(vdrag.i + 1, 0, [p.lat, p.lon]); vdrag.i += 1; }
    vdrag.moved = true;
  }
  S.route[vdrag.i] = [p.lat, p.lon];
  S.sel = vdrag.i;
  map.requestRender();
});
const endDrag = (e) => {
  if (!vdrag || e.pointerId !== vdrag.id) return;
  if (vdrag.moved) changed();
  else if (vdrag.kind === 'v') { S.sel = vdrag.i; updateButtons(); map.render(); }
  vdrag = null;
};
map.el.addEventListener('pointerup', endDrag);
map.el.addEventListener('pointercancel', endDrag);

map.on('move', () => {
  clearTimeout(map._t);
  map._t = setTimeout(() => {
    const c = map.center();
    if (!S.route.length && !S.ref) writeHash({ at: { ...c, zoom: map.zoom } });
    try { localStorage.setItem('fjallskred.terrain.view', JSON.stringify({ ...c, zoom: map.zoom })); } catch { /* private mode */ }
    const out = S.zone.length && !inZone(c.lat, c.lon);
    if (out) message('Outside the service area: maps and terrain cover 12 km around the tours and ski resorts in Fjällskred.', 'zone');
    else if (message.kind === 'zone') message('');
    updateStatus();
    renderLegend();
  }, 200);
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel >= 0) { e.preventDefault(); removeSelected(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Escape') { if (S.picking) { S.picking = null; S.picks = []; $('#tmap').classList.remove('drawing'); message(''); map.render(); } else if (S.drawing) setDrawing(false); }
});

function removeSelected() {
  if (S.sel < 0) return;
  pushUndo();
  S.route.splice(S.sel, 1);
  S.sel = S.route.length ? Math.min(S.sel, S.route.length - 1) : -1;
  changed();
}
function undo() {
  if (!S.undo.length) return;
  S.route = S.undo.pop();
  S.sel = -1;
  changed();
}

$('#drawBtn').onclick = () => setDrawing(!S.drawing);
$('#undoBtn').onclick = undo;
$('#delBtn').onclick = removeSelected;
$('#revBtn').onclick = () => { pushUndo(); S.route.reverse(); changed({ analyseNow: true }); };
$('#clearBtn').onclick = () => { pushUndo(); S.route = []; S.sel = -1; S.profile = null; S.analysis = null; changed(); };
$('.zoomctl').onclick = (e) => {
  const z = e.target.closest('[data-zoom]')?.dataset.zoom;
  if (z) map.zoomAt(z === 'in' ? 1 : -1);
};

/* ------------------------------------------------------------------ *
 * analysis
 * ------------------------------------------------------------------ */

async function postProfile(points) {
  const res = await fetch('/api/terrain/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (body.budget) S.budget = body.budget;
  return body;
}

/** Runout flags along the samples (Norway): read from NVE's map. */
async function runoutFor(profile) {
  if (profile.country !== 'NO' || !S.nveReadable) return null;
  try {
    const cls = await classifyPoints(profile.samples.map((s) => ({ lat: s.lat, lon: s.lon })), 15);
    return cls.map((c) => !!c?.runout);
  } catch {
    return null;
  }
}

async function runAnalysis() {
  if (S.route.length < 2) { S.profile = null; S.analysis = null; renderPanel(); return; }
  const key = routeKey();
  if (key === S.profileKey && S.analysis) return;
  S.pendingKey = key;
  S.profileErr = null;
  renderPanel({ loading: true });
  try {
    const prof = await postProfile(S.route);
    if (S.pendingKey !== key) return;
    const mid = prof.samples[Math.floor(prof.samples.length / 2)];
    S.where = regionAt(mid.lat, mid.lon);
    S.runout = await runoutFor(prof);
    if (S.pendingKey !== key) return;
    S.profile = prof;
    S.profileKey = key;
    S.analysis = analyse(prof, { problems: S.where?.bulletin?.problems ?? [], runout: S.runout });
  } catch (err) {
    if (S.pendingKey !== key) return;
    S.profileErr = err.message;
  }
  renderPanel();
  map.render();
  updateStatus();
}

function classBar(a) {
  const total = a.classes.reduce((s, c) => s + c.m, 0) || 1;
  const col = (k) => (SLOPE_COLOURS[k] ? `rgb(${SLOPE_COLOURS[k].join(',')})` : 'var(--line)');
  return `<div class="sbar" role="img" aria-label="Metres of the route in each slope class">` +
    a.classes.filter((c) => c.m > 0).map((c) => `<i style="width:${((100 * c.m) / total).toFixed(2)}%;background:${col(c.key)}" title="${esc(c.label)}: ${fmtKm(c.m)}"></i>`).join('') +
    `</div><div class="skeys">` +
    a.classes.filter((c) => c.m > 0).map((c) => `<span><i class="swc" style="background:${col(c.key)}"></i>${esc(c.label)} ${fmtKm(c.m)}</span>`).join('') +
    `</div>`;
}

function aspectRose(counts, size = 92) {
  const max = Math.max(...Object.values(counts), 1);
  const c = size / 2, rMax = size / 2 - 12;
  const petals = OCT8.map((o, k) => {
    const r = (rMax * Math.sqrt(counts[o] / max)) || 0;
    if (r < 0.5) return '';
    const a0 = (k * 45 - 22.5 - 90) * R, a1 = (k * 45 + 22.5 - 90) * R;
    return `<path class="petal" d="M${c},${c} L${(c + r * Math.cos(a0)).toFixed(1)},${(c + r * Math.sin(a0)).toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${(c + r * Math.cos(a1)).toFixed(1)},${(c + r * Math.sin(a1)).toFixed(1)} Z"><title>${o}: ${fmtKm(counts[o])}</title></path>`;
  }).join('');
  return `<svg class="rrose" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Which way the steep parts face">` +
    `<circle class="ring" cx="${c}" cy="${c}" r="${rMax}"/>${petals}` +
    `<text x="${c}" y="9" text-anchor="middle">N</text><text x="${size - 4}" y="${c + 3}" text-anchor="end">E</text><text x="${c}" y="${size - 2}" text-anchor="middle">S</text><text x="4" y="${c + 3}">W</text></svg>`;
}

function renderPanel({ loading = false } = {}) {
  const n = S.route.length;
  $('#rempty').hidden = n >= 2;
  const st = $('#rstats'), det = $('#rdetail');
  if (n < 2) {
    st.hidden = true;
    $('#rprofile').innerHTML = '';
    det.innerHTML = n === 1 ? '<p class="note">One point down. Add another to see the profile.</p>' : '';
    return;
  }
  if (S.profileErr) {
    st.hidden = false;
    st.innerHTML = `<p class="warnline">Could not measure the route: ${esc(S.profileErr)}</p>`;
    return;
  }
  const a = S.analysis;
  if (!a || S.profileKey !== routeKey()) {
    st.hidden = false;
    if (loading) st.innerHTML = `<p class="note">Measuring the ground under the route…</p>`;
    return;
  }
  st.hidden = false;
  st.innerHTML =
    `<div class="rgrid">` +
    `<div><b>${fmtKm(a.distanceM)}</b><span>distance</span></div>` +
    `<div><b>↑ ${a.ascentM} m</b><span>climb</span></div>` +
    `<div><b>↓ ${a.descentM} m</b><span>descent</span></div>` +
    `<div><b>${fmtHours(a.hours)}</b><span>on skins, about</span></div>` +
    `<div><b>${a.maxEle ?? '–'} m</b><span>highest</span></div>` +
    `<div><b>${a.steepest ? `${Math.round(a.steepest.slope)}°` : '–'}</b><span>steepest ground</span></div>` +
    `</div>`;

  renderProfile($('#rprofile'), S.profile, a, {
    onHover: (s) => { S.hover = s; map.requestRender(); },
  });

  const w = S.where;
  const sec = [];
  sec.push(`<div class="rsec"><h4>Slope under the route</h4>${classBar(a)}` +
    (a.steepest ? `<p class="note">Steepest: ${Math.round(a.steepest.slope)}° at ${fmtKm(a.steepest.d)}, ${a.steepest.ele} m, facing ${octant(a.steepest.aspect) ?? '–'}.</p>` : '') + `</div>`);

  if (a.steepSections.length) {
    sec.push(`<div class="rsec"><h4>30° and steeper</h4><div class="rflex">${aspectRose(a.steepAspects)}<ul class="rlist" style="flex:1;min-width:200px">` +
      a.steepSections.map((s, k) => `<li><span>${fmtKm(s.d0)}–${fmtKm(s.d1)}</span><span class="note">${fmtKm(s.lengthM)}, up to ${Math.round(s.maxSlope)}°, ${s.aspects.join(' ') || '–'}, ${s.eleMin}–${s.eleMax} m</span><button class="btn small" data-zoomsec="${k}">Show</button></li>`).join('') +
      `</ul></div></div>`);
  } else {
    sec.push(`<div class="rsec"><h4>30° and steeper</h4><p class="okline">None measured under the route. Steep ground above it can still reach it; look at the runout.</p></div>`);
  }

  // Today's avalanche problems where the route is.
  let prob = `<div class="rsec"><h4>Today's avalanche problems</h4>`;
  if (!w) prob += `<p class="note">No avalanche region known here.</p>`;
  else {
    const b = w.bulletin;
    prob += `<p>${esc(w.name)}${b?.danger ? ` — ${dangerChip(b.danger)}` : ''} ${b?.problems?.length ? problemIcons(b.problems, { danger: b.danger, size: 22 }) : ''}<br><span class="note">region of the nearest tour, ${esc(w.tour)} (${w.km.toFixed(0)} km)</span></p>`;
    if (!b) prob += `<p class="note">No bulletin today${w.country === 'SE' ? ' (Swedish forecasts run from 11 December)' : ' (out of season, or not yet loaded)'} — nothing to test the route against.</p>`;
    else if (!b.problems?.length) prob += `<p class="okline">The bulletin names no avalanche problems.</p>`;
    else if (!a.problemSections.length) prob += `<p class="okline">No 30°+ ground on the route faces today's problem aspects at their heights.</p>`;
    else {
      prob += `<ul class="rlist">` + a.problemSections.map((s) => `<li><span class="hot">${fmtKm(s.d0)}–${fmtKm(s.d1)}</span><span class="note">${fmtKm(s.lengthM)} at up to ${Math.round(s.maxSlope)}°, ${s.aspects.join(' ')}, ${s.eleMin}–${s.eleMax} m — ${esc(s.problems.join(', ') || 'in a problem')}</span></li>`).join('') + `</ul>`;
    }
    if (w.bulletinUrl) prob += `<p><a href="${esc(w.bulletinUrl)}" target="_blank" rel="noopener">Read the bulletin</a></p>`;
  }
  sec.push(prob + `</div>`);

  if (S.profile.country === 'NO') {
    sec.push(`<div class="rsec"><h4>Runout zones (NVE)</h4>` +
      (S.runout === null ? `<p class="note">Could not read NVE's map here.</p>`
        : a.runoutM ? `<p class="warnline">Crosses NVE runout zones for about ${fmtKm(a.runoutM)}, in ${a.runoutSections.length} place${a.runoutSections.length > 1 ? 's' : ''}: avalanches from the slopes above can reach these parts.</p>` +
          `<p class="note">${a.runoutSections.slice(0, 6).map((s) => (s.d1 - s.d0 < 50 ? fmtKm(s.d0) : `${fmtKm(s.d0)}–${fmtKm(s.d1)}`)).join(' · ')}${a.runoutSections.length > 6 ? ' · …' : ''} (blue under the profile)</p>`
          : `<p class="okline">Does not cross a runout zone on NVE's map.</p>`) +
      `<p class="note">Read from the map's colours along the route; a heuristic, so look at the map.</p></div>`);
  }

  // Weather at the start and the highest point (v5.1), filled in below.
  sec.push(`<div class="rsec"><h4>Weather on the route</h4><div id="rweather"></div></div>`);

  sec.push(`<p class="attrib">Heights: ${sourceName([S.profile.source], true)}, a point every ${S.profile.spacingM} m, slope from a ${S.profile.crossM * 2} m cross. Time: 400 m climb and 1500 m descent an hour, 4 km/h on the flat.</p>`);
  det.innerHTML = sec.join('');
  loadWeather(a.weatherPoints);
  det.querySelectorAll('[data-zoomsec]').forEach((b) => {
    b.onclick = () => {
      const s = a.steepSections[+b.dataset.zoomsec];
      map.fit(S.profile.samples.slice(Math.max(0, s.from - 2), s.to + 3), 80, 16);
    };
  });
}

/* ------------------------------------------------------------------ *
 * weather on the route (v5.1)
 * ------------------------------------------------------------------ */

const weatherMemo = new Map();
async function loadWeather(wp) {
  const el = $('#rweather');
  if (!el || !FEATURES.weather) return;
  // The start and the highest point, or only the start if they are the same place.
  const pts = [wp.start];
  if (wp.summit && (Math.abs(wp.summit.lat - wp.start.lat) > 0.002 || Math.abs(wp.summit.lon - wp.start.lon) > 0.002)) pts.push(wp.summit);
  const labels = pts.length > 1 ? ['Start', 'Highest point'] : ['Start'];
  const key = pts.map((p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)},${Math.round((p.ele ?? 0) / 10)}`).join('|');
  const hit = weatherMemo.get(key);
  if (hit && Date.now() - hit.at < 20 * 60e3) { renderWeather(el, hit.data, { labels }); return; }
  renderWeather(el, null);
  let data;
  try {
    const res = await fetch('/api/terrain/weather', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: pts.map((p) => [p.lat, p.lon, p.ele]) }) });
    data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) data = { error: data.error ?? `HTTP ${res.status}` };
    else weatherMemo.set(key, { at: Date.now(), data });
  } catch (err) {
    data = { error: err.message };
  }
  const now = $('#rweather');
  if (now) renderWeather(now, data, { labels });
}

/* ------------------------------------------------------------------ *
 * GPX in and out (v5.1)
 * ------------------------------------------------------------------ */

const gpxInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.gpx,application/gpx+xml,application/xml,text/xml', hidden: true });
document.body.appendChild(gpxInput);
$('#gpxInBtn').onclick = () => gpxInput.click();
gpxInput.onchange = async () => {
  const file = gpxInput.files?.[0];
  gpxInput.value = '';
  if (!file) return;
  try {
    if (file.size > 20e6) throw new Error('the file is over 20 MB');
    const g = parseGpx(await file.text());
    const pts = thinTrack(g.points, 150);
    pushUndo();
    S.route = pts;
    S.sel = -1;
    $('#rname').value = g.name || file.name.replace(/\.gpx$/i, '');
    map.fit(pts.map(([lat, lon]) => ({ lat, lon })), 60, 15);
    const outside = pts.some(([lat, lon]) => !inZone(lat, lon));
    message(`${g.kind === 'track' ? 'Track' : g.kind === 'route' ? 'Route' : 'Waypoints'} loaded: ${g.points.length} points${g.points.length > pts.length ? `, thinned to ${pts.length}` : ''}.` +
      (outside ? ' Part of it is outside the service area, so it cannot be measured.' : ''));
    setTimeout(() => message(''), 6000);
    changed({ analyseNow: true });
  } catch (err) {
    message(`Could not read ${file.name}: ${err.message}`);
  }
};
$('#gpxOutBtn').onclick = () => {
  if (S.route.length < 2) return;
  // Heights at the route's own points, where the profile has measured them.
  const eles = S.route.map(() => null);
  if (S.profile && S.profileKey === routeKey()) for (const smp of S.profile.samples) if (smp.v !== undefined) eles[smp.v] = smp.ele;
  const name = $('#rname').value.trim() || 'Fjällskred route';
  const blob = new Blob([toGpx({ name, points: S.route, eles })], { type: 'application/gpx+xml' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: gpxFileName(name) });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

/** Where the heights came from, in words. */
function sourceName(list, long = false) {
  const names = {
    'kartverket-dtm': long ? 'Kartverket DTM 1 m / 10 m' : 'Kartverket DTM',
    'lantmateriet-mhm': long ? 'Lantmäteriet Markhöjdmodell 1 m' : 'Lantmäteriet 1 m',
    'copernicus-glo90': long ? 'Copernicus GLO-90 via Open-Meteo (90 m cells: short steep faces read flatter)' : 'Copernicus GLO-90',
    mixed: 'several terrain models',
  };
  const l = (list ?? []).filter(Boolean);
  return l.length ? [...new Set(l.map((x) => names[x] ?? x))].join(' + ') : 'unknown';
}

/* ------------------------------------------------------------------ *
 * suggested way up
 * ------------------------------------------------------------------ */

function paddedBox(pts, padFrac = 0.35, minKm = 1.2) {
  let s = Math.min(...pts.map((p) => p[0])), n = Math.max(...pts.map((p) => p[0]));
  let w = Math.min(...pts.map((p) => p[1])), e = Math.max(...pts.map((p) => p[1]));
  const lat = (s + n) / 2;
  const pLat = Math.max((n - s) * padFrac, minKm / 111), pLon = Math.max((e - w) * padFrac, minKm / (111 * Math.cos(lat * R)));
  return { south: s - pLat, north: n + pLat, west: w - pLon, east: e + pLon };
}

async function loadRange(r, onProgress) {
  const keys = [];
  if (Array.isArray(r)) keys.push(...r);
  else for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) keys.push([r.z, x, y]);
  keys.forEach(([z, x, y]) => protect.add(`${z}/${x}/${y}`));
  let done = 0;
  try {
    await Promise.all(keys.map(([z, x, y]) => dem.load(z, x, y).then(() => onProgress?.(++done, keys.length))));
  } finally {
    keys.forEach(([z, x, y]) => protect.delete(`${z}/${x}/${y}`));
  }
  const missing = keys.filter(([z, x, y]) => !dem.get(z, x, y)?.ele).length;
  return { total: keys.length, missing };
}

$('#suggestBtn').onclick = () => {
  if (S.route.length >= 2) {
    runSuggestion(S.route[0], S.route[S.route.length - 1]);
    return;
  }
  setDrawing(false);
  S.picking = 'start';
  S.picks = [];
  $('#tmap').classList.add('drawing');
  message('Click where you start, then where you want to get to. Esc cancels.');
};

async function runSuggestion(a, b) {
  const box = $('#rsuggest');
  const say = (html) => { box.innerHTML = `<div class="sugbox">${html}</div>`; };
  if (!inZone(a[0], a[1]) || !inZone(b[0], b[1])) {
    say(`<p class="warnline">Both points must be inside the service area (12 km around a tour or ski resort).</p>`);
    S.picks = [];
    map.render();
    return;
  }
  const bbox = paddedBox([a, b]);
  let r = null;
  for (let z = DEM_MAX_Z; z >= 12; z--) {
    r = tileRange(bbox, z);
    if (tileCount(r) <= 30) break;
  }
  if (tileCount(r) > 30) { say(`<p class="warnline">Too far apart for a suggestion; try points within about 10 km.</p>`); return; }
  say(`<p class="note">Loading the terrain model… 0/${tileCount(r)}</p>`);
  message('Finding a way up…');
  const got = await loadRange(r, (d, t) => say(`<p class="note">Loading the terrain model… ${d}/${t}</p>`));
  if (got.missing > got.total / 3) {
    say(`<p class="warnline">Could not load enough of the terrain model (${got.missing} of ${got.total} tiles missing). ${esc(dem.lastError ?? '')}</p>`);
    message('');
    S.picks = [];
    map.render();
    return;
  }
  const g = mosaic(r, (z, x, y) => dem.get(z, x, y));
  const { slope, aspect } = slopeAspect(g.ele, g.nx, g.ny, g.cellM);
  const where = regionAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  const problems = where?.bulletin?.problems ?? [];
  const probs = problems.map((p) => ({ aspects: new Set(problemAspects(p.aspects)), bands: problemBands(p.heights) }));
  const N = g.nx * g.ny;
  const problem = new Uint8Array(N), runout = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const o = octant(aspect[k]);
    if (o && slope[k] >= 25 && probs.some((p) => p.aspects.has(o) && p.bands.some(([lo, hi]) => g.ele[k] >= lo && g.ele[k] <= hi))) problem[k] = 1;
  }
  const country = nearest(a[0], a[1])?.item.country;
  let usedNve = false;
  if (country === 'NO' && S.nveReadable) {
    // NVE's finer slope map raises the slope where it shows 27°+ and marks runout.
    const nodes = [];
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) nodes.push(g.toLatLon(i, j));
    const cls = await classifyPoints(nodes, Math.min(16, r.z + 1)).catch(() => null);
    if (cls) {
      usedNve = true;
      cls.forEach((c, k) => {
        if (!c) return;
        if (c.runout) runout[k] = 1;
        if (c.slope === 'steep') slope[k] = Math.max(slope[k] || 0, 27);
        if (c.slope === 'steeper') slope[k] = Math.max(slope[k] || 0, 32);
      });
    }
  }
  const sN = snapNode(g, ...g.fromLatLon(a[0], a[1])), gN = snapNode(g, ...g.fromLatLon(b[0], b[1]));
  if (!sN || !gN) { say(`<p class="warnline">No terrain heights at one of the points.</p>`); message(''); return; }
  const cautious = S.sugProfile === 'cautious';
  const res = suggestPath({ ...g, slope, runout, problem }, sN, gN, { profile: cautious ? 'cautious' : 'normal' });
  S.picks = [];
  message('');
  if (!res) { say(`<p class="warnline">No way found between the two points.</p>`); map.render(); return; }
  const simple = simplify(res.path, 0.9);
  const pts = simple.map(([i, j]) => { const p = g.toLatLon(i, j); return [p.lat, p.lon]; });
  pts[0] = a.slice();
  pts[pts.length - 1] = b.slice();
  S.suggestion = { points: pts, cellM: g.cellM, z: r.z, usedNve, problems: problems.length, where };
  map.render();
  say(`<p class="note">Measuring the suggestion…</p>`);
  try {
    const prof = await postProfile(pts);
    const ro = await runoutFor(prof);
    S.suggestion.analysis = analyse(prof, { problems, runout: ro });
  } catch (err) {
    S.suggestion.error = err.message;
  }
  renderSuggestion();
}

function renderSuggestion() {
  const sg = S.suggestion, box = $('#rsuggest');
  if (!sg) { box.innerHTML = ''; return; }
  const a = sg.analysis;
  const steep = a ? a.classes.filter((c) => c.lo >= 30).reduce((s, c) => s + c.m, 0) : null;
  box.innerHTML = `<div class="sugbox">` +
    `<div class="unv">Suggestion — unverified</div>` +
    `<h4 style="margin:4px 0 6px">A way up that keeps off steep ground</h4>` +
    (a ? `<p>${fmtKm(a.distanceM)} · ↑ ${a.ascentM} m · ${fmtHours(a.hours)} · steepest ${a.steepest ? Math.round(a.steepest.slope) : '–'}° · ${steep ? `${fmtKm(steep)} at 30°+` : 'nothing measured at 30°+'}` +
      `${a.problemSections.length ? ` · <span class="hot">${a.problemSections.length} stretch${a.problemSections.length > 1 ? 'es' : ''} in today's problems</span>` : ''}${a.runoutM ? ` · ${fmtKm(a.runoutM)} in runout zones` : ''}</p>` : sg.error ? `<p class="warnline">${esc(sg.error)}</p>` : '') +
    `<p class="note">Worked out on a ${Math.round(sg.cellM)} m grid${sg.usedNve ? ' with NVE’s slope and runout map' : ''}${sg.problems ? ", avoiding today's problem slopes" : ''}. It knows nothing about cornices, glaciers, small cliffs, forest, water or the snow.</p>` +
    `<div class="linkrow">` +
    `<button class="btn primary" id="sugUse">Use as my route</button>` +
    `<label class="note"><input type="checkbox" id="sugCautious" ${S.sugProfile === 'cautious' ? 'checked' : ''}> more cautious</label>` +
    `<button class="btn" id="sugDrop">Discard</button></div></div>`;
  $('#sugUse').onclick = () => {
    pushUndo();
    S.route = sg.points.map((p) => p.slice());
    S.suggestion = null;
    renderSuggestion();
    changed({ analyseNow: true });
  };
  $('#sugDrop').onclick = () => { S.suggestion = null; renderSuggestion(); map.render(); };
  $('#sugCautious').onchange = (e) => {
    S.sugProfile = e.target.checked ? 'cautious' : 'normal';
    const p = sg.points;
    runSuggestion(p[0], p[p.length - 1]);
  };
}

/* ------------------------------------------------------------------ *
 * 3D view
 * ------------------------------------------------------------------ */

let viewer = null;
function loadImg(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

async function open3d() {
  const dlg = $('#t3d');
  const note = (t) => { $('#t3dNote').textContent = t; };
  const pts = S.route.length >= 2 ? S.route : S.suggestion?.points ?? null;
  const vb = map.bounds();
  const box = pts ? paddedBox(pts, 0.2, 1) : vb;
  // Where the terrain comes from files (Sweden with Lantmäteriet's 1 m model),
  // heights cost no budget: each detail level may use three times the tiles.
  const fineHere = S.fine.includes(nearest((box.north + box.south) / 2, (box.east + box.west) / 2)?.item.country);
  const cached = (z, x, y) => Boolean(dem.get(z, x, y)?.ele);
  const plans = Object.fromEntries(Object.keys(DETAIL_3D).map((d) => [d, plan3d({ box, route: pts, detail: d, fine: fineHere, cached })]));
  // The choice shows what each level would cost now (cached tiles are free).
  const sel = $('#detail3d');
  sel.innerHTML = Object.entries(DETAIL_3D).map(([d, v]) => {
    const pl = plans[d];
    const cell = Math.round(cellAt(pl.corridor?.range ?? pl.surround, box));
    const cost = fineHere ? 'from Lantmäteriet' : pl.newHeights ? `${pl.newHeights.toLocaleString('en')} new heights` : 'cached';
    return `<option value="${d}"${d === S.detail3d ? ' selected' : ''}>${v.label} — ${cell} m${pl.corridor ? ' along the route' : ''} · ${cost}</option>`;
  }).join('');
  const plan = plans[S.detail3d] ?? plans.normal;
  const c = { lat: (box.north + box.south) / 2, lon: (box.east + box.west) / 2 };
  if (!inZone(c.lat, c.lon)) { message('The 3D view needs the area to be inside the service area.'); return; }
  if (!fineHere && S.budget && plan.newHeights > S.budget.left) {
    if (!dlg.open) dlg.showModal();
    note(`this detail needs ${plan.newHeights.toLocaleString('en')} new heights, and ${S.budget.left.toLocaleString('en')} are left today: choose a lower detail`);
    return;
  }
  if (!dlg.open) dlg.showModal();
  $('#t3dTitle').textContent = pts ? '3D — your route' : '3D — this view';
  note(`loading the terrain model… 0/${plan.tiles.length}`);
  const got = await loadRange(plan.tiles, (d, t) => note(`loading the terrain model… ${d}/${t}`));
  if (got.missing === got.total) { note(`no terrain here: ${dem.lastError ?? 'nothing loaded'}`); return; }
  const g = combine3d(plan, (z, x, y) => dem.get(z, x, y));
  const r = plan.corridor?.range ?? plan.surround;

  // The texture: topo tiles at up to two levels finer, then overlays and the route.
  const tx = r.x1 - r.x0 + 1, ty = r.y1 - r.y0 + 1;
  let k = 2;
  while (k > 0 && (Math.max(tx, ty) * 256 * 2 ** k > 4096 || r.z + k > 16)) k--;
  const zt = r.z + k, f = 2 ** k;
  const W = tx * 256 * f, H = ty * 256 * f;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#EDEBE5';
  ctx.fillRect(0, 0, W, H);
  note('loading the map…');
  const jobs = [];
  for (let x = r.x0 * f; x < (r.x1 + 1) * f; x++) {
    for (let y = r.y0 * f; y < (r.y1 + 1) * f; y++) {
      const url = topoUrl(zt, x, y);
      if (url) jobs.push(loadImg(url).then((im) => im && ctx.drawImage(im, (x - r.x0 * f) * 256, (y - r.y0 * f) * 256)));
    }
  }
  await Promise.all(jobs);
  if (S.nve) {
    ctx.save();
    ctx.globalAlpha = S.opacity;
    ctx.globalCompositeOperation = 'multiply';
    const nj = [];
    for (let x = r.x0 * f; x < (r.x1 + 1) * f; x++) {
      for (let y = r.y0 * f; y < (r.y1 + 1) * f; y++) {
        const url = nveUrl(zt, x, y);
        if (url) nj.push(loadImg(url).then((im) => im && ctx.drawImage(im, (x - r.x0 * f) * 256, (y - r.y0 * f) * 256)));
      }
    }
    await Promise.all(nj);
    ctx.restore();
  }
  if (S.shade !== 'off') {
    const { slope, aspect } = slopeAspect(g.ele, g.nx, g.ny, g.cellM);
    const small = document.createElement('canvas');
    small.width = g.nx; small.height = g.ny;
    const sctx = small.getContext('2d');
    const im = sctx.createImageData(g.nx, g.ny);
    const where = regionAt(c.lat, c.lon);
    const probs = (where?.bulletin?.problems ?? []).map((p) => ({ aspects: new Set(problemAspects(p.aspects)), bands: problemBands(p.heights) }));
    for (let q = 0; q < g.nx * g.ny; q++) {
      let col = null, al = 0;
      const s = slope[q], o = octant(aspect[q]);
      if (S.shade === 'slope') { col = slopeRgb(s); al = 235; }
      else if (S.shade === 'aspect' && o && s >= 10) { col = ASPECT_COLOURS[o]; al = s >= 25 ? 235 : 110; }
      else if (S.shade === 'problems' && o && s >= 25 && probs.some((p) => p.aspects.has(o) && p.bands.some(([lo, hi]) => g.ele[q] >= lo && g.ele[q] <= hi))) { col = [192, 57, 43]; al = 220; }
      if (col) im.data.set([col[0], col[1], col[2], al], q * 4);
    }
    sctx.putImageData(im, 0, 0);
    ctx.save();
    ctx.globalAlpha = S.opacity;
    ctx.imageSmoothingEnabled = true;
    // Grid nodes sit on the tile edges: node i is at x = i / (nx - 1) of the width.
    const cw = W / (g.nx - 1), ch = H / (g.ny - 1);
    ctx.drawImage(small, -cw / 2, -ch / 2, W + cw, H + ch);
    ctx.restore();
  }
  const toPx = (lat, lon) => [(mx(lon) * 2 ** r.z - r.x0) / tx * W, (my(lat) * 2 ** r.z - r.y0) / ty * H];
  const line = (p, stroke, width, dash = []) => {
    ctx.save();
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    p.forEach(([la, lo], i) => { const [x, y] = toPx(la, lo); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.restore();
  };
  const lw = Math.max(5, W / 320);
  if (S.suggestion?.points) { line(S.suggestion.points, '#FFFFFF', lw * 2); line(S.suggestion.points, '#1A1A1A', lw, [lw * 2.5, lw * 2]); }
  if (S.route.length >= 2) {
    line(S.route, '#FFFFFF', lw * 2.2);
    line(S.route, '#C0392B', lw);
  }
  viewer ??= (() => { try { return new Terrain3D($('#t3dCanvas')); } catch (e) { note(e.message); return null; } })();
  if (!viewer) return;
  viewer.exag = +$('#exag').value / 10;
  viewer.setScene(g, cv);
  note(`${g.surroundCellM ? `${Math.round(g.cellM)} m along the route, ${Math.round(g.surroundCellM)} m around` : `${Math.round(g.cellM)} m grid`} · ${sourceName(g.sources)} · drag to turn, scroll to zoom`);
  refreshBudget();
}
/** Metres per terrain cell of a tile range, at the box's latitude. */
function cellAt(range, box) {
  return (40075016.686 * Math.cos((((box.north + box.south) / 2) * Math.PI) / 180)) / 2 ** range.z / 16;
}
/** The height budget, re-read after heavy work so the status line is true. */
async function refreshBudget() {
  try {
    const z = await fetch('/api/terrain/zone').then((r) => r.json());
    if (z?.budget) { S.budget = z.budget; updateStatus(); }
  } catch { /* not important */ }
}
$('#view3dBtn').onclick = open3d;
$('#detail3d').onchange = (e) => {
  S.detail3d = e.target.value;
  try { localStorage.setItem('fjallskred.detail3d', S.detail3d); } catch { /* private mode */ }
  open3d();
};
$('#t3dClose').onclick = () => $('#t3d').close();
$('#exag').oninput = (e) => {
  $('#exagVal').textContent = (e.target.value / 10).toFixed(1);
  if (viewer) { viewer.exag = e.target.value / 10; viewer.draw(); }
};
new ResizeObserver(() => viewer?.draw()).observe($('#t3dCanvas'));

/* ------------------------------------------------------------------ *
 * layers, legend, status
 * ------------------------------------------------------------------ */

function renderLegend() {
  const parts = [];
  const sw = (rgb, label) => `<span><i class="swc" style="background:rgb(${rgb.join(',')})"></i>${label}</span>`;
  const c = map.center();
  const country = nearest(c.lat, c.lon)?.item.country;
  if (S.nve && country === 'NO') {
    parts.push(`<div class="legend-row"><span class="eyebrow">NVE</span><span>slope from 27° in green, then yellow → red → purple → black to 50°+; avalanche runout zones in three blues (short, medium, long)</span></div>`);
  }
  if (S.shade === 'slope') {
    parts.push(`<div class="legend-row"><span class="eyebrow">Slope</span>${SLOPE_CLASSES.filter((k) => SLOPE_COLOURS[k.key]).map((k) => sw(SLOPE_COLOURS[k.key], k.label)).join('')}${sw([30, 30, 30], '50°+')}</div>`);
  } else if (S.shade === 'aspect') {
    parts.push(`<div class="legend-row"><span class="eyebrow">Aspect</span>${OCT8.map((o) => sw(ASPECT_COLOURS[o], o)).join('')}<span class="note">faint under 25°</span></div>`);
  } else if (S.shade === 'problems') {
    const w = regionAt(c.lat, c.lon);
    const pr = w?.bulletin?.problems ?? [];
    parts.push(`<div class="legend-row"><span class="eyebrow">Today</span>${sw([192, 57, 43], '25°+ facing today’s problems, at their heights')}<span class="note">${esc(w?.name ?? '')}${pr.length ? '' : ' — no problems in a bulletin today'}</span></div>`);
  }
  parts.push(`<div class="legend-row"><span><i class="swc" style="background:var(--ink)"></i>route under 25°</span><span class="note">steeper parts of the route in the slope colours</span></div>`);
  $('#tlegend').innerHTML = parts.join('');
  $('#tattrib').innerHTML = `Map © ${country === 'SE' ? 'OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors' : 'Kartverket'} · Slope &amp; runout © NVE (CC BY 4.0) · Heights: Kartverket DTM (Norway), ${S.fine.includes('SE') ? 'Lantmäteriet Markhöjdmodell 1 m, CC BY 4.0' : 'Copernicus GLO-90 via Open-Meteo'} (Sweden) · Not for navigation`;
}

function updateStatus() {
  const bits = [];
  if (dem.busy) bits.push(`terrain model: ${dem.busy} tile${dem.busy > 1 ? 's' : ''} loading`);
  if (shadeNote) bits.push(shadeNote);
  if (S.budget && S.budget.left < S.budget.limit * 0.5) bits.push(`${S.budget.left.toLocaleString('en')} of ${S.budget.limit.toLocaleString('en')} heights left today`);
  $('#tstatus').textContent = bits.join(' · ');
}

let msgKind = '';
function message(text, kind = '') {
  const el = $('#tmsg');
  el.hidden = !text;
  el.textContent = text;
  message.kind = text ? kind : '';
  msgKind = message.kind;
}

$('#lyrNve').onchange = (e) => { S.nve = e.target.checked; map.setLayer('nve', { visible: S.nve }); renderLegend(); };
$('#lyrShade').onchange = (e) => { S.shade = e.target.value; map.render(); renderLegend(); };
$('#lyrOpacity').oninput = (e) => {
  S.opacity = e.target.value / 100;
  map.setLayer('nve', { opacity: S.opacity });
  map.render();
};

/* ------------------------------------------------------------------ *
 * places, tours, saved routes
 * ------------------------------------------------------------------ */

$('#goto').onchange = (e) => {
  const v = e.target.value.trim().toLowerCase();
  const hit = S.zone.find((t) => t.name.toLowerCase() === v) ?? S.zone.find((t) => t.name.toLowerCase().startsWith(v));
  if (!hit) return;
  e.target.value = '';
  if (hit.kind === 'tour') loadTourRef(hit.slug, { fit: true });
  else map.setView({ lat: hit.lat, lon: hit.lon }, 13.5);
};

/** A tour's own route (OSM or your GPX), dotted, to trace or take over. */
async function loadTourRef(which, { fit = true } = {}) {
  const t = S.tours.find((x) => x.slug === which || x.name === which);
  if (!t) return;
  const slug = t.slug;
  if (fit) map.setView({ lat: t.lat, lon: t.lon }, 13.5);
  S.ref = { name: t.name, slug, points: [], tour: t };
  renderRef();
  try {
    const r = await fetch(`/api/track?tour=${encodeURIComponent(slug)}`).then((x) => x.json());
    if (S.ref?.slug !== slug) return;
    if (r.found && r.points?.length) {
      S.ref.points = r.points.map((p) => [p.lat, p.lon]);
      S.ref.kind = r.kind ?? r.source;
      if (fit) map.fit(r.points.concat([{ lat: t.lat, lon: t.lon }]), 60, 15);
    } else {
      S.ref.reason = r.reason ?? 'no route known';
    }
  } catch (err) {
    S.ref.reason = err.message;
  }
  renderRef();
  map.render();
}

function renderRef() {
  let el = $('#rref');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rref';
    $('#rpanel').prepend(el);
  }
  const ref = S.ref;
  if (!ref) { el.innerHTML = ''; return; }
  const t = ref.tour;
  el.innerHTML = `<div class="sugbox" style="margin:0 0 14px"><div class="eyebrow">Tour</div><strong>${esc(ref.name)}</strong> <span class="note">${t.summit_m} m · ${t.vertical_m} m vertical · difficulty ${t.difficulty}/5 · ${esc(t.aspect)}</span>` +
    (ref.points.length ? `<p class="note">Its route (${ref.kind === 'own-gpx' || ref.kind === 'gpx' ? 'your GPX' : 'from OpenStreetMap'}) is dotted on the map.</p><div class="linkrow"><button class="btn" id="refUse">Use as my route</button><button class="btn" id="refDrop">Hide</button></div>`
      : `<p class="note">${ref.reason ? esc(ref.reason) : 'Looking for its route…'}</p><div class="linkrow"><button class="btn" id="refDrop">Hide</button></div>`) + `</div>`;
  const use = $('#refUse');
  if (use) use.onclick = () => {
    // Thin the track to what a hand-drawn route would have.
    const simp = thinTrack(ref.points, 150);
    pushUndo();
    S.route = simp.map((p) => p.slice());
    if (!$('#rname').value) $('#rname').value = ref.name;
    changed({ analyseNow: true });
  };
  $('#refDrop').onclick = () => { S.ref = null; renderRef(); map.render(); writeHash({ points: S.route }); };
}

function renderSaved() {
  const list = savedRoutes();
  const el = $('#saved');
  if (!list.length) { el.innerHTML = '<p class="note">Nothing saved yet. Routes are kept in this browser only.</p>'; return; }
  el.innerHTML = `<ul class="savedlist">` + list.map((r, i) => `<li><span title="${esc(r.name)}">${esc(r.name)}</span><span class="note" style="flex:none">${new Date(r.saved).toLocaleDateString('en-GB')}</span><button class="btn small" data-open="${i}">Open</button><button class="btn small" data-del="${i}" aria-label="Delete ${esc(r.name)}">✕</button></li>`).join('') + `</ul>`;
  el.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => {
      const r = list[+b.dataset.open];
      pushUndo();
      S.route = r.points.map((p) => p.slice());
      $('#rname').value = r.name;
      map.fit(S.route.map(([lat, lon]) => ({ lat, lon })), 60, 15);
      changed({ analyseNow: true });
    };
  });
  el.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => { deleteRoute(list[+b.dataset.del].name); renderSaved(); };
  });
}
$('#saveBtn').onclick = () => {
  const name = $('#rname').value.trim() || `Route ${new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
  $('#rname').value = name;
  if (!saveRoute({ name, points: S.route })) message('This browser would not store the route (private mode?). The link in the address bar still holds it.');
  renderSaved();
  writeHash({ points: S.route, name });
};
$('#rname').onchange = () => writeHash({ points: S.route, name: $('#rname').value.trim() || undefined });

/* ------------------------------------------------------------------ *
 * start
 * ------------------------------------------------------------------ */

// For the browser checks in demo/terrain-check.mjs, and for poking around in devtools.
window.fjallskredTerrain = { map, state: S, dem };

async function init() {
  initAvalancheTips?.();
  const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [meta, resorts, conditions] = await Promise.all([getJson('/api/meta'), getJson('/api/resorts'), getJson('/api/conditions')]);
  S.regionsMeta = Object.fromEntries((meta?.regions ?? []).map((r) => [r.id, r]));
  S.tours = (meta?.tours ?? []).map((t) => ({ ...t, slug: t.slug ?? slugify(t.name) }));
  S.resorts = resorts?.resorts ?? [];
  S.bulletins = Object.fromEntries((conditions?.regions ?? []).map((r) => [r.id, r]));
  S.zone = [
    ...S.tours.map((t) => ({ kind: 'tour', name: t.name, slug: t.slug, lat: t.lat, lon: t.lon, country: S.regionsMeta[t.region]?.country, region: t.region })),
    ...S.resorts.filter((r) => Number.isFinite(r.lat)).map((r) => ({ kind: 'resort', name: r.name, lat: r.lat, lon: r.lon, country: r.country })),
  ];
  countryMemo.clear();
  // NVE tiles come through this service, so their pixels can be read.
  S.nveReadable = true;
  $('#places').innerHTML = S.zone.map((t) => `<option value="${esc(t.name)}">${t.kind === 'resort' ? 'ski resort' : 'tour'}</option>`).join('');

  const h = readHash();
  let view = null;
  try { view = JSON.parse(localStorage.getItem('fjallskred.terrain.view') ?? 'null'); } catch { /* none */ }
  if (h.name) $('#rname').value = h.name;
  if (h.points?.length) {
    S.route = h.points;
    map.fit(h.points.map(([lat, lon]) => ({ lat, lon })), 60, 15);
  } else if (h.at) map.setView(h.at, h.at.zoom);
  else if (view && Number.isFinite(view.lat)) map.setView(view, view.zoom);
  else if (S.tours.length) map.setView({ lat: S.tours[0].lat, lon: S.tours[0].lon }, 12);
  if (h.tour) loadTourRef(h.tour, { fit: !h.points?.length });

  const c = map.center();
  S.shade = nearest(c.lat, c.lon)?.item.country === 'SE' ? 'slope' : 'off';
  $('#lyrShade').value = S.shade;
  map.setLayer('nve', { opacity: S.opacity });

  const zone = await getJson('/api/terrain/zone');
  if (zone?.budget) S.budget = zone.budget;
  S.fine = zone?.fine ?? [];
  if (zone?.lantmateriet?.lastError) message(`Lantmäteriet's terrain model is not being used: ${zone.lantmateriet.lastError}`);
  renderLegend();
  renderSaved();
  updateButtons();
  map.render();
  if (S.route.length >= 2) runAnalysis();
  else renderPanel();
}
init();
