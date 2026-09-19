/**
 * Minimal GPX read/write. No XML dependency: GPX points are flat, attribute-
 * carrying elements, which a careful regex handles fine for the files people
 * actually drop in (Garmin, Suunto, Strava, OsmAnd, Fatmap exports).
 */

const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** -> [{lat, lon, ele|null}] from trkpt, else rtept. */
export function parseGpx(xml) {
  if (typeof xml !== 'string') return [];
  const grab = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const lat = num(attrs.match(/\blat\s*=\s*["']([^"']+)["']/i)?.[1]);
      const lon = num(attrs.match(/\blon\s*=\s*["']([^"']+)["']/i)?.[1]);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const ele = num(m[2]?.match(/<ele>\s*([^<]+?)\s*<\/ele>/i)?.[1]);
      out.push({ lat, lon, ele });
    }
    return out;
  };
  const trk = grab('trkpt');
  return trk.length ? trk : grab('rtept');
}

const xmlEsc = (s) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Build a GPX 1.1 document for a derived track. */
export function toGpx({ name, desc, points, source, license }) {
  const pts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        (Number.isFinite(p.ele) ? `<ele>${Math.round(p.ele)}</ele>` : '') +
        `</trkpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="toppturvarsel" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEsc(name)}</name>
    <desc>${xmlEsc(desc)}</desc>
    ${license ? `<copyright author="${xmlEsc(source)}"><license>${xmlEsc(license)}</license></copyright>` : ''}
  </metadata>
  <trk>
    <name>${xmlEsc(name)}</name>
    <desc>${xmlEsc(desc)}</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Stable, filesystem-safe id for a tour name: "Rørnestinden" -> "rornestinden". */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
