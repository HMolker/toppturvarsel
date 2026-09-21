/**
 * A made-up terrain model for Hallingdal, for the advert only.
 *
 * Every Hallingdal tour gets a mountain at its own summit, with its own height
 * and vertical, the north-east faces a little steeper (the lee in the story's
 * south-westerly storm). The recorder answers the server's elevation requests
 * (Kartverket DTM and Open-Meteo) from this, so contours, profiles, the relief
 * drawing and the red >25° layer are all computed by the real code.
 */

const R = 6371000;
const toRad = Math.PI / 180;

export function makeTerrain(tours) {
  const peaks = tours.map((t) => ({ lat: t.lat, lon: t.lon, top: t.summit_m, v: (t.vertical_m ?? 700) * 1.15 }));
  return function z(lat, lon) {
    let best = 640;
    for (const p of peaks) {
      const dN = (lat - p.lat) * toRad * R;
      const dE = (lon - p.lon) * toRad * R * Math.cos(p.lat * toRad);
      const d = Math.hypot(dE, dN);
      if (d > 9000) continue;
      const bearing = Math.atan2(dE, dN);
      // Steeper towards the north-east.
      const steep = 1 + 0.45 * Math.max(0, Math.cos(bearing - Math.PI / 4));
      const h = p.top - p.v * Math.pow((d * steep) / 3000, 0.62);
      if (h > best) best = h;
    }
    // Some texture, so contours are not perfect circles.
    const tex = 18 * Math.sin(lat * 610) * Math.cos(lon * 330) + 9 * Math.sin(lat * 1900 + lon * 700);
    return Math.round(best + tex);
  };
}

/** A zig-zag skin track from the valley on the south side to the summit. */
export function skinTrack(tour, z, { n = 140 } = {}) {
  const pts = [];
  const start = { lat: tour.lat - 0.028, lon: tour.lon + 0.018 };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = 1 - (1 - t) ** 1.25;
    const wig = Math.sin(t * Math.PI * 9) * 0.0022 * (1 - t) ** 0.6 * Math.min(1, t * 6);
    const lat = start.lat + (tour.lat - start.lat) * e + wig * 0.4;
    const lon = start.lon + (tour.lon - start.lon) * e + wig;
    pts.push({ lat, lon, ele: z(lat, lon) });
  }
  return pts;
}

export function toGpxXml(name, pts, date = '2027-02-13') {
  const t0 = Date.parse(`${date}T08:40:00Z`);
  const trkpts = pts
    .map((p, i) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele}</ele><time>${new Date(t0 + i * 62000).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}
