/**
 * Made-up terrain around Harahorn (Hemsedal) for the weekend film.
 *
 * Every Hallingdal tour is a mountain at its own summit, with its own
 * height, rising out of a high plateau (about 1000 m around the Harahorn
 * lodge, falling away to the valleys). The north-east faces are steeper —
 * the lee in the story's westerly storm, where the wind slab problem sits.
 * Gentle long waves give the plateau some shape. Not the real Harahorn.
 */

const toRad = Math.PI / 180;
const HARA = { lat: 60.9394, lon: 8.4945 };

export function makeTerrain(tours) {
  const peaks = tours.map((t) => ({
    lat: t.lat, lon: t.lon, top: t.summit_m,
    R: t.name === 'Harahorn' ? 820 : 950 + ((t.vertical_m ?? 700) - 600) * 0.6,
  }));
  const metres = (lat, lon, p) => {
    const dN = (lat - p.lat) * 111320;
    const dE = (lon - p.lon) * 111320 * Math.cos(p.lat * toRad);
    return { d: Math.hypot(dE, dN), bearing: Math.atan2(dE, dN) };
  };
  return function z(lat, lon) {
    const h0 = metres(lat, lon, HARA).d;
    // The plateau: ~1000 m within a few km of Harahorn, down to ~650 m far out.
    const plateau = 650 + 380 * Math.exp(-((h0 / 6500) ** 2));
    let best = plateau;
    for (const p of peaks) {
      const { d, bearing } = metres(lat, lon, p);
      if (d > 7000) continue;
      const s = 1.2 + 0.4 * Math.cos(bearing - Math.PI / 4); // steeper towards the north-east
      const h = plateau + (p.top - plateau) * Math.exp(-(((d * s) / p.R) ** 1.45));
      if (h > best) best = h;
    }
    const wave = 22 * Math.sin(lat * 260 + lon * 40) + 16 * Math.cos(lon * 170 - lat * 90) + 8 * Math.sin(lat * 900 + lon * 350);
    return Math.round(best + wave);
  };
}

/** A point `km` from (lat, lon) towards compass `deg`. */
export function offset(lat, lon, deg, km) {
  const dN = Math.cos(deg * toRad) * km, dE = Math.sin(deg * toRad) * km;
  return [+(lat + dN / 111.32).toFixed(6), +(lon + dE / (111.32 * Math.cos(lat * toRad))).toFixed(6)];
}
