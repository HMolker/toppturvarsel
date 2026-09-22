/**
 * The route's elevation profile, SVG: the ground line coloured by the slope
 * of the terrain under it, red ticks where it meets today's avalanche
 * problems, blue where it crosses an NVE runout zone. Hovering reports the
 * sample under the cursor, so the map can show where it is.
 */

import { slopeRgb, fmtKm } from './analysis.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rgb = (c) => (c ? `rgb(${c.join(',')})` : 'var(--steel)');

export function renderProfile(el, profile, analysis, { onHover = () => {} } = {}) {
  const S = profile?.samples ?? [];
  if (S.length < 2 || !S.some((s) => Number.isFinite(s.ele))) {
    el.innerHTML = '';
    return;
  }
  const W = 640, H = 190, L = 44, Rp = 10, T = 12, B = 26;
  const d1 = S[S.length - 1].d || 1;
  const eles = S.map((s) => s.ele).filter(Number.isFinite);
  let lo = Math.min(...eles), hi = Math.max(...eles);
  const padZ = Math.max(20, (hi - lo) * 0.08);
  lo = Math.floor((lo - padZ) / 50) * 50;
  hi = Math.ceil((hi + padZ) / 50) * 50;
  const X = (d) => L + ((W - L - Rp) * d) / d1;
  const Y = (z) => T + ((H - T - B) * (hi - z)) / (hi - lo || 1);

  const pts = S.filter((s) => Number.isFinite(s.ele));
  const area = `M${X(pts[0].d).toFixed(1)},${(H - B).toFixed(1)} ` + pts.map((s) => `L${X(s.d).toFixed(1)},${Y(s.ele).toFixed(1)}`).join(' ') + ` L${X(pts[pts.length - 1].d).toFixed(1)},${(H - B).toFixed(1)} Z`;

  // Coloured ground line, one short segment per sample pair.
  const segs = [];
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    if (!Number.isFinite(a.ele) || !Number.isFinite(b.ele)) continue;
    const s = Math.max(a.slope ?? 0, b.slope ?? 0);
    segs.push(`<line x1="${X(a.d).toFixed(1)}" y1="${Y(a.ele).toFixed(1)}" x2="${X(b.d).toFixed(1)}" y2="${Y(b.ele).toFixed(1)}" stroke="${rgb(slopeRgb(s))}" stroke-width="${s >= 25 ? 3.2 : 2}" stroke-linecap="round"/>`);
  }

  // Grid: heights every 100/200/500 m, distance every 0.5/1/2/5 km.
  const zStep = [50, 100, 200, 250, 500, 1000].find((s) => (hi - lo) / s <= 5) ?? 1000;
  const grid = [];
  for (let z = Math.ceil(lo / zStep) * zStep; z <= hi; z += zStep) {
    grid.push(`<line x1="${L}" x2="${W - Rp}" y1="${Y(z).toFixed(1)}" y2="${Y(z).toFixed(1)}" class="pgrid"/><text x="${L - 6}" y="${(Y(z) + 4).toFixed(1)}" text-anchor="end" class="plabel">${z}</text>`);
  }
  const dStep = [250, 500, 1000, 2000, 5000, 10000].find((s) => d1 / s <= 7) ?? 10000;
  for (let d = 0; d <= d1; d += dStep) {
    grid.push(`<text x="${X(d).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="plabel">${d === 0 ? '0' : fmtKm(d)}</text>`);
  }

  const bands = [];
  for (const sec of analysis?.runoutSections ?? []) {
    bands.push(`<rect x="${X(sec.d0).toFixed(1)}" y="${H - B}" width="${Math.max(2, X(sec.d1) - X(sec.d0)).toFixed(1)}" height="5" class="prunout"><title>NVE runout zone</title></rect>`);
  }
  for (const sec of analysis?.problemSections ?? []) {
    bands.push(`<rect x="${X(sec.d0).toFixed(1)}" y="${T - 8}" width="${Math.max(3, X(sec.d1) - X(sec.d0)).toFixed(1)}" height="6" class="pproblem"><title>${esc(`${fmtKm(sec.lengthM)} at up to ${Math.round(sec.maxSlope)}° facing ${sec.aspects.join(', ')} — ${sec.problems.join(', ') || "today's problems"}`)}</title></rect>`);
  }
  const verts = S.filter((s) => s.v !== undefined).map((s) => `<line x1="${X(s.d).toFixed(1)}" x2="${X(s.d).toFixed(1)}" y1="${(H - B).toFixed(1)}" y2="${(H - B + 4).toFixed(1)}" class="pvert"/>`);

  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="tprofile" role="img" aria-label="Elevation profile of the route, coloured by slope angle">` +
    grid.join('') +
    `<path d="${area}" class="parea"/>` +
    segs.join('') + bands.join('') + verts.join('') +
    `<g class="pcursor" hidden><line y1="${T}" y2="${H - B}"/><circle r="4"/><text class="plabel pcurlabel" y="${T + 10}"></text></g>` +
    `<rect x="${L}" y="${T}" width="${W - L - Rp}" height="${H - T - B}" fill="transparent" class="phit"/>` +
    `</svg>`;

  const svg = el.querySelector('svg');
  const cur = svg.querySelector('.pcursor');
  const hit = svg.querySelector('.phit');
  const nearest = (d) => S.reduce((m, s) => (Math.abs(s.d - d) < Math.abs(m.d - d) ? s : m), S[0]);
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const d = ((x - L) / (W - L - Rp)) * d1;
    const s = nearest(Math.max(0, Math.min(d1, d)));
    showAt(s);
    onHover(s);
  };
  const showAt = (s) => {
    if (!s || !Number.isFinite(s.ele)) { cur.setAttribute('hidden', ''); return; }
    cur.removeAttribute('hidden');
    const x = X(s.d), y = Y(s.ele);
    cur.querySelector('line').setAttribute('x1', x);
    cur.querySelector('line').setAttribute('x2', x);
    cur.querySelector('circle').setAttribute('cx', x);
    cur.querySelector('circle').setAttribute('cy', y);
    const t = cur.querySelector('text');
    t.setAttribute('x', Math.min(W - 150, Math.max(L + 4, x + 6)));
    t.textContent = `${fmtKm(s.d)} · ${s.ele} m · ${Number.isFinite(s.slope) ? `${Math.round(s.slope)}°` : '–'}`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cur.setAttribute('hidden', ''); onHover(null); });
  el.showAt = showAt;
}
