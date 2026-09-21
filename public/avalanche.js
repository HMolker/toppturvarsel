import { problemAspects, problemBands } from './planner.js';

/**
 * Avalanche problems and danger levels, drawn and explained.
 *
 * The problem types and the danger scale follow the European Avalanche
 * Warning Services (EAWS): avalanches.org/standards/avalanche-problems and
 * the European Avalanche Danger Scale. The descriptions here are short
 * paraphrases of those texts, not copies, and the pictograms are this tool's
 * own drawings in the spirit of the EAWS set: the official icons carry no
 * stated licence for reuse, so they are not shipped here.
 *
 * Icons are black and white by default; at danger 3 and above they switch
 * to colour, so a raised level is visible before any text is read.
 */

export const DANGER = {
  1: { name: 'Low', colour: '#CCFF66',
    text: 'The snowpack is generally well bonded and stable. Triggering needs a large load, and only in isolated spots of extreme terrain; only small to medium avalanches are expected.' },
  2: { name: 'Moderate', colour: '#FFFF00',
    text: 'Mostly stable, but only moderately bonded on some steep slopes. Triggering usually needs a large load, mainly on steep slopes; large natural avalanches are not expected. Common, and where many accidents still happen.' },
  3: { name: 'Considerable', colour: '#FF9900',
    text: 'Moderately to poorly bonded on many steep slopes. A single skier can trigger avalanches, and some can be large. The critical level: careful route choice and experience are needed.' },
  4: { name: 'High', colour: '#FF0000',
    text: 'Poorly bonded on most steep slopes. Triggering is likely even by one skier on many steep slopes, and many large natural avalanches are expected. Stay out of avalanche terrain.' },
  5: { name: 'Very high', colour: '#1A1A1A',
    text: 'The snowpack is largely unstable. Numerous very large, often extremely large, natural avalanches, reaching roads and valley floors. Avoid all avalanche terrain.' },
};

export const PROBLEMS = {
  newSnow: {
    name: 'New snow',
    test: /new snow|nysn|nysnö|nysnø/i,
    text: 'Fresh snowfall loads the snowpack faster than it can bond. Most likely during snowfall and for a few days after, on all aspects. Look for recent avalanches and let it settle before steep terrain.',
  },
  windSlab: {
    name: 'Wind slab',
    test: /wind|fokk|drift|vindpåverk/i,
    text: 'Wind has packed snow into slabs on lee slopes, in gullies and bowls, mostly above the treeline. Watch for drifted pillows, shooting cracks and "whumpf" sounds, and keep off drifted steep terrain. Usually settles within days.',
  },
  persistent: {
    name: 'Persistent weak layer',
    test: /persistent|vedvarende|ihållande|svakt lag|svaga skikt|weak layer/i,
    text: 'A weak layer buried in the old snowpack — facets, depth hoar or surface hoar — that can last weeks or months, most often on shady, sheltered slopes. Hard to see, can release far above you: keep to conservative terrain.',
  },
  wetSnow: {
    name: 'Wet snow',
    test: /wet|våt|blöt/i,
    text: 'Meltwater or rain weakens the snowpack within hours. Snowballs, pinwheels and boots sinking deep give it away. Go early while the crust holds, and stay out of runout zones as it warms.',
  },
  gliding: {
    name: 'Gliding snow',
    test: /glid/i,
    text: 'The whole snowpack slides on smooth ground such as grass or rock slabs, usually on sunny slopes. Glide cracks show where it may go, not when: do not linger below them.',
  },
  cornices: {
    name: 'Cornices',
    test: /cornice|skavl|hengeskavl|snögång/i,
    text: 'Overhanging lips of wind-drifted snow on ridges. They break further back than they look and can trigger the slope below: keep well back from the edge, and out from under them in wind or warmth.',
  },
  noDistinct: {
    name: 'No distinct problem',
    test: /no distinct|ingen tydelig|inget tydligt/i,
    text: 'No clear pattern, but avalanches are still possible. This is not the same as safe: normal caution applies.',
  },
};

/** Varsom's or Naturvårdsverket's problem name -> one of the EAWS types. */
export function problemKey(name) {
  const s = String(name ?? '');
  // Order matters: "wet snow (slab)" must not read as "new snow".
  for (const k of ['wetSnow', 'gliding', 'cornices', 'persistent', 'windSlab', 'newSnow', 'noDistinct']) {
    if (PROBLEMS[k].test.test(s)) return k;
  }
  return null;
}

const INK = 'var(--ink)', PAPER = 'var(--paper)';
// Colour variant: snow in blue, wind in teal, the weak layer in amber, water
// in blue, ground in brown. Only used at danger 3 and above.
const TINT = { snow: '#6B9BC8', wind: '#4A9A9A', weak: '#E08A1E', water: '#3F7FC0', ground: '#8A6A48', lip: '#6B9BC8' };

/** One problem as a small pictogram (this tool's own drawing). */
export function problemIcon(key, { colour = false, size = 28, title = true } = {}) {
  const c = (part) => (colour ? TINT[part] : INK);
  const bg = colour ? '#F3F7FB' : PAPER;
  const slope = `<path d="M3 28 L29 10" stroke="${INK}" stroke-width="1.6" fill="none"/>`;
  const body = {
    newSnow:
      slope +
      [0, 60, 120].map((a) => `<path d="M16 3 V13" transform="rotate(${a} 16 8)" stroke="${c('snow')}" stroke-width="1.6"/>`).join('') +
      `<path d="M8 22 L29 12 L29 29 L3 29 Z" fill="${colour ? '#DCE8F4' : 'var(--line)'}" stroke="none" opacity=".8"/>`,
    windSlab:
      `<path d="M3 28 L14 10 L29 28 Z" fill="none" stroke="${INK}" stroke-width="1.6"/>` +
      `<path d="M14 10 Q20 12 22 18 L18 18 Q17 13 14 10 Z" fill="${c('snow')}" stroke="none"/>` +
      `<path d="M2 7 H10 M4 11 H11 M1 15 H8" stroke="${c('wind')}" stroke-width="1.5" stroke-linecap="round"/>`,
    persistent:
      `<rect x="5" y="6" width="22" height="22" rx="2" fill="none" stroke="${INK}" stroke-width="1.6"/>` +
      `<path d="M5 12 H27 M5 24 H27" stroke="${INK}" stroke-width="1"/>` +
      `<path d="M5 18 H27" stroke="${c('weak')}" stroke-width="2.2" stroke-dasharray="2.2 1.8"/>`,
    wetSnow:
      slope +
      `<path d="M16 4 C12 10 11 12 11 14 A5 5 0 0 0 21 14 C21 12 20 10 16 4 Z" fill="${colour ? TINT.water : 'none'}" stroke="${colour ? TINT.water : INK}" stroke-width="1.6"/>`,
    gliding:
      `<path d="M3 29 L29 11" stroke="${c('ground')}" stroke-width="2.4"/>` +
      `<path d="M3 24 L13 17 M17 14 L29 6" stroke="${INK}" stroke-width="1.6"/>` +
      `<path d="M13 17 L15 19.5 L17 14" stroke="${INK}" stroke-width="1.4" fill="none"/>`,
    cornices:
      `<path d="M2 26 L12 14 H22 Q28 14 27 18 Q25 16 21 17 L20 28" fill="none" stroke="${INK}" stroke-width="1.6"/>` +
      `<path d="M12 14 H22 Q28 14 27 18 Q25 16 21 17 Z" fill="${c('lip')}" stroke="none"/>`,
    noDistinct:
      slope + `<text x="12" y="17" font-size="13" font-weight="700" fill="${INK}" font-family="var(--sans)">?</text>`,
  }[key];
  if (!body) return '';
  const label = PROBLEMS[key].name;
  return (
    `<svg class="avicon" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="${label}">` +
    (title ? `<title>${label}</title>` : '') +
    `<rect x=".5" y=".5" width="31" height="31" rx="5" fill="${bg}" stroke="var(--line-2)"/>${body}</svg>`
  );
}

/** Which aspects a problem applies to, as a rose: filled = in play. */
export function problemRose(bits, { size = 56, colour = false } = {}) {
  const on = new Set(problemAspects(bits));
  const OCT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const R = Math.PI / 180, r0 = 7, r1 = 24;
  const pt = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  const fill = colour ? '#E0701E' : INK;
  const segs = OCT.map((d, i) => {
    const a0 = (i * 45 - 22.5 - 90) * R, a1 = (i * 45 + 22.5 - 90) * R;
    return `<path d="M${pt(r0, a0)} L${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z" ` +
      `fill="${on.has(d) ? fill : PAPER}" stroke="var(--steel)" stroke-width=".6"/>`;
  }).join('');
  const labels = ['N', 'E', 'S', 'W'].map((d, i) => {
    const a = (i * 90 - 90) * R;
    return `<text x="${(30 * Math.cos(a)).toFixed(1)}" y="${(30 * Math.sin(a) + 3).toFixed(1)}" text-anchor="middle" class="avl">${d}</text>`;
  }).join('');
  const list = OCT.filter((d) => on.has(d));
  const label = list.length === 8 ? 'all aspects' : list.join(', ');
  return `<svg class="avrose" viewBox="-36 -36 72 72" width="${size}" height="${size}" role="img" aria-label="Aspects: ${label}"><title>Aspects: ${label}</title>${segs}${labels}</svg>`;
}

/** Where in height a problem applies: a mountain with the band shaded. */
let clipSeq = 0;
export function elevationDiagram(h, { size = 56, colour = false } = {}) {
  const W = 64, H = 56, top = 6, base = 50;
  const bands = problemBands(h);
  // 0 m at the foot; the top sits a good way above the highest height given.
  const peak = Math.max(1500, (h?.h1 ?? 0) * 1.5, (h?.h2 ?? 0) * 1.3);
  const y = (m) => base - (Math.max(0, Math.min(peak, m)) / peak) * (base - top);
  const fill = colour ? '#E0701E' : INK;
  const mountain = `M4 ${base} L32 ${top} L60 ${base} Z`;
  const id = `avclip${++clipSeq}`;
  const shaded = bands.map(([lo, hi]) => {
    const y1 = y(Number.isFinite(hi) ? hi : peak), y2 = y(Number.isFinite(lo) ? lo : 0);
    return `<rect x="0" y="${y1.toFixed(1)}" width="${W}" height="${Math.max(0, y2 - y1).toFixed(1)}" fill="${fill}"/>`;
  }).join('');
  const marks = [h?.h1, h?.fill >= 3 ? h?.h2 : null].filter((v) => Number.isFinite(v) && v > 0);
  const lines = marks.map((m) =>
    `<line x1="2" x2="${W - 2}" y1="${y(m).toFixed(1)}" y2="${y(m).toFixed(1)}" stroke="var(--steel)" stroke-dasharray="2 2"/>` +
    `<text x="${W - 2}" y="${(y(m) - 2).toFixed(1)}" text-anchor="end" class="avl">${m}</text>`).join('');
  const label = !h ? 'all elevations' : h.fill === 1 ? `above ${h.h1} m` : h.fill === 2 ? `below ${h.h1} m`
    : h.fill === 4 ? `${Math.min(h.h1, h.h2)}–${Math.max(h.h1, h.h2)} m`
    : h.fill === 3 ? `below ${Math.min(h.h1, h.h2)} m and above ${Math.max(h.h1, h.h2)} m` : 'all elevations';
  return (
    `<svg class="avelev" viewBox="0 0 ${W} ${H}" width="${size}" height="${Math.round((size * H) / W)}" role="img" aria-label="Elevation: ${label}">` +
    `<title>Elevation: ${label}</title>` +
    `<defs><clipPath id="${id}"><path d="${mountain}"/></clipPath></defs>` +
    `<path d="${mountain}" fill="${PAPER}"/>` +
    `<g clip-path="url(#${id})">${shaded}</g>` +
    `<path d="${mountain}" fill="none" stroke="${INK}" stroke-width="1.4"/>${lines}</svg>`
  );
}

/** The same height band in words, for next to the diagram. */
export function elevationText(h) {
  if (!h) return 'all elevations';
  if (h.fill === 1) return `above ${h.h1} m`;
  if (h.fill === 2) return `below ${h.h1} m`;
  if (h.fill === 4) return `${Math.min(h.h1, h.h2)}–${Math.max(h.h1, h.h2)} m`;
  if (h.fill === 3) return `below ${Math.min(h.h1, h.h2)} and above ${Math.max(h.h1, h.h2)} m`;
  return 'all elevations';
}

/** Danger level chip, EAWS colour, with its explanation on hover. */
export function dangerChip(d, { small = false } = {}) {
  if (!DANGER[d]) return '';
  const ink = d >= 4 ? '#FFFFFF' : '#1A1A1A';
  return `<span class="avdanger${small ? ' sm' : ''}" data-av="danger" data-level="${d}" tabindex="0" ` +
    `style="background:${DANGER[d].colour};color:${ink}${d === 5 ? ';box-shadow:inset 0 0 0 1.5px #C0392B' : ''}">${d}` +
    `${small ? '' : ` <span class="avdname">${DANGER[d].name}</span>`}</span>`;
}

/** A row of problem icons, each explaining itself on hover. */
export function problemIcons(problems, { danger = null, size = 22 } = {}) {
  const colour = (danger ?? 0) >= 3;
  const seen = new Set();
  return (problems ?? [])
    .map((p) => (typeof p === 'string' ? { type: p } : p))
    .map((p) => ({ ...p, key: (problemKey(p.problemType) ?? problemKey(p.type)) }))
    .filter((p) => p.key && !seen.has(p.key) && seen.add(p.key))
    .map((p) => `<span class="avprob" data-av="problem" data-key="${p.key}" tabindex="0"` +
      `${p.probability ? ` data-extra="${escAttr([p.probability, p.size].filter(Boolean).join(' · '))}"` : ''}>` +
      `${problemIcon(p.key, { colour, size, title: false })}</span>`)
    .join('');
}
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ------------------------------------------------------------------ *
 * the explanation box
 * ------------------------------------------------------------------ */

let tipEl = null;
function tipHtml(el) {
  if (el.dataset.av === 'danger') {
    const d = DANGER[el.dataset.level];
    return d ? `<div class="avt-h"><span class="avdanger sm" style="background:${d.colour};color:${+el.dataset.level >= 4 ? '#fff' : '#1A1A1A'}">${el.dataset.level}</span> ${d.name}</div>` +
      `<p>${d.text}</p><p class="avt-src">European Avalanche Danger Scale (EAWS), in short</p>` : '';
  }
  const p = PROBLEMS[el.dataset.key];
  return p ? `<div class="avt-h">${problemIcon(el.dataset.key, { size: 20, title: false })} ${p.name}</div>` +
    (el.dataset.extra ? `<div class="avt-x">${escAttr(el.dataset.extra)}</div>` : '') +
    `<p>${p.text}</p><p class="avt-src">EAWS avalanche problem, in short</p>` : '';
}
function show(el) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'avTip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.innerHTML = tipHtml(el);
  tipEl.hidden = false;
  const r = el.getBoundingClientRect(), W = tipEl.offsetWidth, H = tipEl.offsetHeight;
  let x = r.left, yy = r.bottom + 8;
  if (x + W > innerWidth - 8) x = innerWidth - W - 8;
  if (yy + H > innerHeight - 8) yy = r.top - H - 8;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, yy)}px`;
  tipEl.dataset.for = el.dataset.av + (el.dataset.key ?? el.dataset.level);
}
const hide = () => { if (tipEl) tipEl.hidden = true; };

/** One set of listeners for the whole page: hover, focus, and tap on phones. */
export function initAvalancheTips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-av]');
    if (el) show(el);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'mouse' && e.target.closest?.('[data-av]') && !e.relatedTarget?.closest?.('[data-av]')) hide();
  });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-av]'); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if (e.target.closest?.('[data-av]')) hide(); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-av]');
    if (!el) return hide();
    const key = el.dataset.av + (el.dataset.key ?? el.dataset.level);
    if (tipEl && !tipEl.hidden && tipEl.dataset.for === key) hide();
    else show(el);
  });
  addEventListener('scroll', hide, { passive: true });
}

/* ------------------------------------------------------------------ *
 * steep slopes where today's problems are
 * ------------------------------------------------------------------ */

const OCT8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Cells of the terrain grid steeper than `minAngle` whose facing direction
 * and height fall inside at least one of the bulletin's problems.
 * Returns [{ corners: [{lat,lon}×4], angle, aspect, keys }].
 */
export function hazardCells(terrain, problems, { minAngle = 25 } = {}) {
  if (!terrain?.z?.length || !problems?.length) return [];
  const { box, nx, ny, z } = terrain;
  const R = Math.PI / 180;
  const lat0 = (box.north + box.south) / 2;
  const dx = ((box.east - box.west) / (nx - 1)) * 111320 * Math.cos(lat0 * R);
  const dy = ((box.north - box.south) / (ny - 1)) * 111320;
  const probs = problems.map((p) => ({ aspects: new Set(problemAspects(p.aspects)), bands: problemBands(p.heights), key: (problemKey(p.problemType) ?? problemKey(p.type)) }));
  const out = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i], d = z[(j + 1) * nx + i + 1];
      if ([a, b, c, d].some((v) => !Number.isFinite(v))) continue;
      // Gradient: east and north components (rows run north to south).
      const gx = ((b + d) - (a + c)) / (2 * dx);
      const gy = ((a + b) - (c + d)) / (2 * dy);
      const angle = Math.atan(Math.hypot(gx, gy)) / R;
      if (angle < minAngle) continue;
      // The slope faces downhill: opposite the gradient.
      const facing = ((Math.atan2(-gx, -gy) / R) + 360) % 360;
      const aspect = OCT8[Math.round(facing / 45) % 8];
      const elev = (a + b + c + d) / 4;
      const keys = probs.filter((p) => p.aspects.has(aspect) && p.bands.some(([lo, hi]) => elev >= lo && elev <= hi)).map((p) => p.key);
      if (!keys.length) continue;
      const lat = (k) => box.north - ((box.north - box.south) * k) / (ny - 1);
      const lon = (k) => box.west + ((box.east - box.west) * k) / (nx - 1);
      out.push({
        corners: [{ lat: lat(j), lon: lon(i) }, { lat: lat(j), lon: lon(i + 1) }, { lat: lat(j + 1), lon: lon(i + 1) }, { lat: lat(j + 1), lon: lon(i) }],
        angle: Math.round(angle), aspect, elev: Math.round(elev), keys,
      });
    }
  }
  return out;
}
