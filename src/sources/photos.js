import { haversineKm } from '../util/utm.js';

/**
 * Photos taken near a summit, from Wikimedia Commons.
 *
 * Why Commons and not an image search engine: Commons photos are geotagged,
 * openly licensed and carry their author and licence in machine-readable
 * form, so they can be shown with proper credit. Image search results carry
 * none of that, and scraping them is against the search engines' terms.
 *
 * One request: generator=geosearch (files within `radius` m of the summit)
 * with prop=imageinfo|coordinates. Response per the MediaWiki docs:
 *   query.pages[] -> { pageid, title, coordinates:[{lat,lon}],
 *     imageinfo:[{ thumburl, descriptionurl, url,
 *       extmetadata:{ Artist:{value}, LicenseShortName:{value},
 *                     LicenseUrl:{value}, DateTimeOriginal:{value} } }] }
 * `pages` is an array with formatversion=2 and an object keyed by page id
 * without it; both are accepted.
 *
 * This could not be exercised against the live API from the build
 * environment (Commons was unreachable there); it is written against the
 * documented shape and degrades to "no photos" rather than failing.
 */

const API = process.env.COMMONS_API_URL || 'https://commons.wikimedia.org/w/api.php';
const THUMB_HOST = 'upload.wikimedia.org';

export function commonsUrl(lat, lon, radius = 5000) {
  const q = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'geosearch',
    ggscoord: `${lat.toFixed(5)}|${lon.toFixed(5)}`,
    ggsradius: String(Math.min(10000, radius)),
    ggsnamespace: '6',
    ggslimit: '40',
    prop: 'imageinfo|coordinates',
    iiprop: 'url|extmetadata',
    iiurlwidth: '480',
    origin: '*',
  });
  return `${API}?${q}`;
}

/**
 * The second way in: files whose name or description mentions the summit.
 * Many Norwegian and Swedish mountain photos are named or categorised but
 * never geotagged, so a search by coordinates alone misses them.
 */
export function commonsSearchUrl(name, limit = 12) {
  const q = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${name} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo|coordinates',
    iiprop: 'url|extmetadata',
    iiurlwidth: '480',
    origin: '*',
  });
  return `${API}?${q}`;
}

const get = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'toppturvarsel/1.0 (self-hosted ski touring dashboard)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`commons HTTP ${res.status}`);
  return res.json();
};

/**
 * Photos near the summit, and — when that is thin, which it often is — photos
 * that carry the summit's name. Named photos have no coordinates, so they are
 * listed after the geotagged ones and labelled as named rather than located.
 */
export async function fetchPhotos(summit, { radius = 10000, limit = 8, name = summit.name } = {}) {
  const near = shapePhotos(await get(commonsUrl(summit.lat, summit.lon, radius)), summit, { limit });
  if (near.length >= limit || !name) return near;

  const byName = shapePhotos(await get(commonsSearchUrl(name)).catch(() => null), summit, { limit, named: name })
    .filter((p) => !near.some((q) => q.pageUrl === p.pageUrl));
  return [...near, ...byName].slice(0, limit);
}

const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Commons geosearch also returns maps, diagrams and logos placed at a spot.
const NOT_A_PHOTO = /\b(map|kart|karte|diagram|logo|profile|profil|plan|chart|sign|skilt)\b|\.(svg|pdf|tiff?|gif)$/i;

const BEARINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(from, to) {
  const φ1 = (from.lat * Math.PI) / 180, φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return BEARINGS[Math.round(deg / 45) % 8];
}

export function shapePhotos(body, summit, { limit = 8, named = null } = {}) {
  const raw = body?.query?.pages;
  const pages = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];

  const photos = [];
  for (const p of pages) {
    const ii = p?.imageinfo?.[0];
    const c = p?.coordinates?.[0];
    const located = c && Number.isFinite(c.lat) && Number.isFinite(c.lon);
    // A geotagged file must be near the summit; a file found by name may have
    // no coordinates at all, and is then shown for what it is.
    if (!ii?.thumburl || (!located && !named)) continue;
    // Commons titles use underscores for spaces, and \b treats _ as a word char.
    if (NOT_A_PHOTO.test(String(p.title ?? '').replace(/_/g, ' '))) continue;
    let thumbHost;
    try {
      thumbHost = new URL(ii.thumburl).hostname;
    } catch {
      continue;
    }
    if (thumbHost !== THUMB_HOST) continue;

    const md = ii.extmetadata ?? {};
    const license = stripHtml(md.LicenseShortName?.value);
    // No licence, no photo: we only show what we can credit correctly.
    if (!license) continue;

    const distM = located ? Math.round(haversineKm(summit.lat, summit.lon, c.lat, c.lon) * 1000) : null;
    photos.push({
      source: 'commons',
      title: stripHtml(String(p.title).replace(/^File:/, '').replace(/\.[a-z]{3,4}$/i, '').replace(/_/g, ' ')).slice(0, 90),
      author: stripHtml(md.Artist?.value).slice(0, 60) || 'Unknown author',
      license,
      licenseUrl: md.LicenseUrl?.value ?? null,
      date: stripHtml(md.DateTimeOriginal?.value).slice(0, 10) || null,
      pageUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      thumbUrl: ii.thumburl,
      lat: located ? +c.lat.toFixed(5) : null,
      lon: located ? +c.lon.toFixed(5) : null,
      distM,
      from: !located
        ? `named after ${named}`
        : distM < 150 ? 'at the summit'
        : `${distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${distM} m`} ${bearing(summit, c)} of the summit`,
    });
  }
  // Geotagged first, nearest first; named-only photos after them.
  photos.sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));
  return photos.slice(0, limit);
}

export const isCommonsThumb = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === THUMB_HOST;
  } catch {
    return false;
  }
};
