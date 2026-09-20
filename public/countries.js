/**
 * Countries the service can show, and how the overview map frames them.
 *
 * The country selection is the first filter on the page: it decides what the
 * map shows and what the tour list, planner, resorts and alerts consider.
 * A country appears in the picker only when data/regions.json has regions
 * for it, so adding a country is a data change, not a UI change.
 *
 * `frame` is a coarse outline of the mainland, [lat, lon] points, used only
 * to frame the map: a bounding box would not do, since Norway's box is
 * mostly Sweden and Finland. Svalbard is left out on purpose: it is listed
 * as an off-map region.
 */
export const COUNTRIES = {
  NO: {
    name: 'Norway',
    frame: [[57.98, 7.05], [59.0, 5.0], [62.0, 4.8], [65.0, 11.0], [68.5, 13.0], [70.2, 19.0], [71.2, 25.8],
      [70.0, 31.1], [69.0, 29.0], [68.5, 20.0], [66.0, 14.5], [63.0, 12.0], [60.0, 12.5], [59.0, 11.5]],
  },
  SE: {
    name: 'Sweden',
    frame: [[55.3, 13.0], [56.5, 16.5], [59.0, 19.0], [60.5, 18.6], [62.5, 17.8], [65.8, 24.2], [68.5, 23.5],
      [69.1, 20.5], [68.0, 17.0], [63.0, 12.0], [59.0, 11.0], [57.5, 11.8]],
  },
};

/** Named groups of countries offered as one click, e.g. a mountain range. */
export const GROUPS = [
  // { id: 'pyrenees', name: 'Pyrenees', countries: ['FR', 'ES', 'AD'] },
];

export const countryName = (code) => COUNTRIES[code]?.name ?? code;

/** "Norway", "Norway & Sweden", "Norway, Sweden & France". */
export function joinNames(codes) {
  const n = codes.map(countryName);
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} & ${n[n.length - 1]}`;
}

/**
 * Keep a saved selection only where it still makes sense: unknown codes are
 * dropped, and an empty result means "everything available".
 */
export function normaliseSelection(saved, available) {
  const keep = (Array.isArray(saved) ? saved : []).filter((c) => available.includes(c));
  return keep.length ? keep : [...available];
}

/**
 * Frame for the overview map: a sinusoidal projection centred on the
 * selection, scaled so the selected countries fill the width, with the height
 * following the shape (portrait for Norway, landscape for the Pyrenees).
 *
 * Returns { lon0, s, ox, oy, height } for
 *   x = ox + (lon - lon0) * cos(lat) * s,  y = oy - lat * s
 */
export function fitFrame(outlines, { width = 560, minH = 360, maxH = 760, pad = 26 } = {}) {
  const pts = outlines.flat();
  if (!pts.length) return fitFrame([COUNTRIES.NO.frame, COUNTRIES.SE.frame], { width, minH, maxH, pad });
  const lons = pts.map((p) => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const raw = pts.map(([lat, lon]) => ({ x: (lon - lon0) * Math.cos((lat * Math.PI) / 180), y: -lat }));
  const xs = raw.map((p) => p.x), ys = raw.map((p) => p.y);
  const bw = Math.max(...xs) - Math.min(...xs) || 1;
  const bh = Math.max(...ys) - Math.min(...ys) || 1;
  const s = Math.min((width - 2 * pad) / bw, (maxH - 2 * pad) / bh);
  const height = Math.round(Math.max(minH, Math.min(maxH, bh * s + 2 * pad)));
  const ox = width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * s;
  const oy = height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * s;
  return { lon0, s, ox, oy, height };
}
