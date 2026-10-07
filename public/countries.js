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
 * as an off-map region. For a small country the frame is also its outline
 * on the sketch map (see geo.js).
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
  // v6: Switzerland, from Natural Earth's 1:110m outline (public domain).
  CH: {
    name: 'Switzerland',
    // Not in the first view of someone new: the page opens on the Nordic
    // countries, and Switzerland is one click away (v6).
    optIn: true,
    frame: [[47.53, 9.59], [47.35, 9.63], [47.1, 9.48], [46.92, 9.93], [46.89, 10.44], [46.48, 10.36], [46.31, 9.92], [46.44, 9.18], [46.04, 8.97], [46.01, 8.49], [46.16, 8.32], [45.82, 7.76], [45.78, 7.27], [45.99, 6.84], [46.43, 6.5], [46.27, 6.02], [46.73, 6.04], [47.29, 6.77], [47.54, 6.74], [47.45, 7.19], [47.62, 7.47], [47.61, 8.32], [47.83, 8.52]],
  },
  // v6.2: Austria, from Natural Earth's 1:110m outline (public domain), simplified.
  AT: {
    name: 'Austria',
    optIn: true,
    frame: [[47.52, 9.6], [47.27, 9.53], [47.05, 9.88], [46.87, 10.14], [46.85, 10.47], [46.78, 10.78], [46.83, 11.15], [47.0, 11.5], [46.98, 12.2], [46.75, 12.42], [46.65, 12.7], [46.62, 13.4], [46.5, 13.7], [46.47, 14.0], [46.5, 14.5], [46.55, 15.0], [46.65, 15.65], [46.85, 16.1], [47.05, 16.5], [47.7, 16.9], [48.0, 17.1], [48.7, 16.95], [48.77, 15.0], [48.98, 14.7], [48.7, 13.8], [48.57, 13.43], [48.2, 12.95], [47.8, 12.95], [47.58, 12.17], [47.55, 11.4], [47.4, 10.95], [47.4, 10.2], [47.55, 9.9]],
  },
  // v6.2: Italy, but only the two Euregio provinces (South Tyrol and Trentino) have a bulletin here.
  IT: {
    name: 'Italy (South Tyrol & Trentino)',
    optIn: true,
    frame: [[46.85, 10.47], [46.78, 11.0], [47.0, 11.5], [47.0, 12.1], [46.75, 12.4], [46.6, 12.1], [46.45, 11.95], [46.3, 11.9], [46.15, 11.8], [46.0, 11.7], [45.85, 11.4], [45.65, 11.0], [45.6, 10.85], [45.9, 10.6], [46.2, 10.3], [46.45, 10.2], [46.6, 10.45]],
  },
};

/** Named groups of countries offered as one click, e.g. a mountain range. */
export const GROUPS = [
  { id: 'nordic', name: 'Nordic', countries: ['NO', 'SE'] },
  { id: 'alps', name: 'Alps', countries: ['CH', 'AT', 'IT'] },
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
 * dropped, and an empty result means everything available except the
 * opt-in countries (or everything, if that leaves nothing).
 */
export function normaliseSelection(saved, available) {
  const keep = (Array.isArray(saved) ? saved : []).filter((c) => available.includes(c));
  if (keep.length) return keep;
  const first = available.filter((c) => !COUNTRIES[c]?.optIn);
  return first.length ? first : [...available];
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
