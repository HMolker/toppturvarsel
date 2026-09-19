/**
 * Ski resort layer for the overview map: a slope icon and a lift icon per
 * resort, each shaded by the share that is open, with the resort's name
 * underneath linking to its home page.
 *
 * Pure functions (no DOM) so the tests run them in Node; app.js projects
 * the resorts and inserts the SVG this returns.
 *
 * Colour follows the graphical profile: open share is carried by the
 * paper -> steel -> ink scale, darker = more open. Red stays reserved for
 * alerts, and the EAWS colours for danger. "No status published" is a
 * dashed outline and never a shade, so it cannot be read as "closed".
 */

// Colours are CSS variables (styles.css) so the dark theme can flip the
// scale: "more open" is always "more contrast against the map".
export const OPEN_BANDS = [
  // [upper bound (exclusive), background, glyph, label]
  [1e-9, 'var(--paper)', 'var(--steel)', 'closed'],
  [0.34, 'var(--ro1)', 'var(--rg1)', '1–33 %'],
  [0.67, 'var(--ro2)', 'var(--rg2)', '34–66 %'],
  [0.999, 'var(--ro3)', 'var(--rg3)', '67–99 %'],
  [Infinity, 'var(--ro4)', 'var(--rg4)', 'all open'],
];

export const share = (c) => (c && c.count > 0 ? c.open / c.count : null);

export function shade(c) {
  const s = share(c);
  if (s == null) return { bg: 'var(--paper)', fg: 'var(--steel)', unknown: true, closed: false };
  const [, bg, fg] = OPEN_BANDS.find(([max]) => s < max);
  return { bg, fg, unknown: false, closed: s === 0 };
}

/** The one number for a zoomed-out dot: lifts decide whether you can ski. */
export const mainCount = (r) => r.lifts ?? r.slopes ?? null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 16 × 16 glyphs, stroked in the icon's glyph colour.
const GLYPH = {
  // a slope: hillside with a ski track down it
  slope: (fg) =>
    `<path d="M2.5 13 L13.5 13 L2.5 3.5 Z" fill="none" stroke="${fg}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<path d="M4.6 7.4 q2.2 1.1 1.6 2.4 q-.6 1.3 2.2 2.4" fill="none" stroke="${fg}" stroke-width="1.1" stroke-linecap="round"/>`,
  // a lift: cable with a chair hanging from it
  lift: (fg) =>
    `<path d="M1.5 4.8 L14.5 2.6" stroke="${fg}" stroke-width="1.4" stroke-linecap="round"/>` +
    `<path d="M8 3.8 V8.2 M5 8.2 H11 V12.2 M5 8.2 V10.6" fill="none" stroke="${fg}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
};

function icon(kind, counts, x, y) {
  const sh = shade(counts);
  const border = sh.unknown ? `stroke="var(--steel)" stroke-dasharray="2 1.6"` : sh.closed ? `stroke="var(--steel)"` : `stroke="var(--marker-edge)"`;
  return (
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
    `<rect width="16" height="16" rx="3.5" fill="${sh.bg}" ${border} stroke-width="1"/>` +
    GLYPH[kind](sh.fg) +
    `</g>`
  );
}

export function tooltip(r) {
  const part = (label, c) => (c ? `${label} ${c.open}/${c.count} open` : null);
  const status = r.live
    ? [part('lifts', r.lifts), part('slopes', r.slopes)].filter(Boolean).join(' · ')
    : `status not published${r.mappedLifts ? ` · ${r.mappedLifts} lifts mapped` : ''}`;
  return `${r.name} · ${status} · ${r.source === 'fnugg' ? 'Fnugg' : 'OpenStreetMap'}`;
}

const BADGE_W = 36, BADGE_H = 18;
const nameWidth = (s) => s.length * 5.1 + 4;
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Lay out resorts on screen. `pts` are [{ r, x, y }] already projected.
 * Zoomed out (`detail` false): one small square per resort. Zoomed in:
 * the two icons and the name, placed greedily biggest resort first; a
 * resort whose icons would overlap a neighbour's falls back to the square,
 * and a name that would collide is left to the tooltip.
 */
export function layoutResorts(pts, { detail, width, height, blocked = [] }) {
  const taken = [...blocked];
  const dots = [];
  const badges = [];
  const order = [...pts].sort((a, b) => size(b.r) - size(a.r));
  for (const p of order) {
    if (p.x < -40 || p.y < -40 || p.x > width + 40 || p.y > height + 40) continue;
    if (!detail) {
      dots.push(p);
      continue;
    }
    const box = [p.x - BADGE_W / 2 - 1, p.y - BADGE_H - 5, p.x + BADGE_W / 2 + 1, p.y + 2];
    if (taken.some((t) => overlaps(t, box))) {
      dots.push(p);
      continue;
    }
    taken.push(box);
    const w = nameWidth(p.r.name) + (p.r.url ? 8 : 0);
    // Near the map edge the name slides inward rather than being dropped.
    let nx = p.x;
    if (nx - w / 2 < 3) nx = 3 + w / 2;
    if (nx + w / 2 > width - 3) nx = width - 3 - w / 2;
    const nbox = [nx - w / 2, p.y + 3, nx + w / 2, p.y + 14];
    const named = !taken.some((t) => overlaps(t, nbox));
    if (named) taken.push(nbox);
    badges.push({ ...p, named, nameDx: nx - p.x });
  }
  return { dots, badges };
}

const size = (r) => (r.lifts?.count ?? r.mappedLifts ?? 0) * 2 + (r.slopes?.count ?? 0);

export function resortSvg({ dots, badges }) {
  const out = [];
  for (const { r, x, y } of dots) {
    const sh = shade(mainCount(r));
    out.push(
      `<rect class="resortdot" x="${(x - 3).toFixed(1)}" y="${(y - 3).toFixed(1)}" width="6" height="6" rx="1" ` +
        `fill="${sh.bg}" stroke="${sh.unknown || sh.closed ? 'var(--steel)' : 'var(--marker-edge)'}" stroke-width=".9"` +
        `${sh.unknown ? ' stroke-dasharray="1.6 1.2"' : ''}><title>${esc(tooltip(r))}</title></rect>`
    );
  }
  for (const { r, x, y, named, nameDx = 0 } of badges) {
    const tx = nameDx.toFixed(1);
    const name = named
      ? r.url
        ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" class="resortlink">` +
          `<text x="${tx}" y="12" text-anchor="middle" class="resortname">${esc(r.name)} ↗</text></a>`
        : `<text x="${tx}" y="12" text-anchor="middle" class="resortname nolink">${esc(r.name)}</text>`
      : '';
    out.push(
      `<g class="resort" data-resort="${esc(r.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        `<title>${esc(tooltip(r))}</title>` +
        `<path d="M0 0 L-3 -4 H3 Z" fill="var(--ink)"/>` +
        icon('slope', r.slopes, -BADGE_W / 2, -BADGE_H - 4) +
        icon('lift', r.lifts, 2, -BADGE_H - 4) +
        name +
        `</g>`
    );
  }
  return out.join('');
}
