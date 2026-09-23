/**
 * Reading NVE's slope and runout map (Norway) by its colours.
 *
 * NVE publishes the map as pictures only: six slope classes from 27°
 * (green, then yellow through red and purple to black) and three runout
 * zones in shades of blue. The tiles come through this service's own tile
 * proxy, so the page may read their pixels. Classifying by colour is a
 * heuristic — good for "is this point in a runout zone" along a route and
 * for steering route suggestions, not a substitute for looking at the map.
 */

const cache = new Map(); // "z/x/y" -> Promise<ImageData|null>

function loadTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!cache.has(k)) {
    cache.set(k, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 256, 256);
          resolve(ctx.getImageData(0, 0, 256, 256));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null); // 404: nothing drawn here
      img.src = `/tiles/nve/${z}/${x}/${y}.png`;
    }));
  }
  return cache.get(k);
}

/**
 * 'runout' | 'steep' (27–29°, green) | 'steeper' (30° and up) | null.
 */
export function classifyPixel(r, g, b, a) {
  if (a < 40) return null;
  if (b > 110 && b > r + 35 && b >= g) return 'runout';
  if (g > r + 20 && g > b + 20) return 'steep';
  return 'steeper';
}

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

/**
 * Classes at many points, reading tiles at zoom z (max 16). A point takes the
 * "worst" class within `radius` pixels, so a thin zone is not missed.
 */
export async function classifyPoints(points, z = 15, radius = 1) {
  const n = 2 ** z;
  const need = new Map();
  const where = points.map((p) => {
    const fx = mercX(p.lon) * n, fy = mercY(p.lat) * n;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const k = `${tx}/${ty}`;
    if (!need.has(k)) need.set(k, loadTile(z, tx, ty));
    return { k, px: Math.floor((fx - tx) * 256), py: Math.floor((fy - ty) * 256) };
  });
  const data = new Map();
  await Promise.all([...need].map(async ([k, p]) => data.set(k, await p)));
  const rank = { runout: 1, steep: 2, steeper: 3 };
  return where.map(({ k, px, py }) => {
    const im = data.get(k);
    if (!im) return null;
    let best = null, runout = false;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.min(255, Math.max(0, px + dx)), y = Math.min(255, Math.max(0, py + dy));
        const o = (y * 256 + x) * 4;
        const c = classifyPixel(im.data[o], im.data[o + 1], im.data[o + 2], im.data[o + 3]);
        if (c === 'runout') runout = true;
        else if (c && (!best || rank[c] > rank[best])) best = c;
      }
    }
    return { runout, slope: best };
  });
}
