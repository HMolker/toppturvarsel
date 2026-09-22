import { UA } from '../util/ua.js';
import { haversineKm } from '../util/utm.js';
import { config } from '../config.js';

/**
 * Openly licensed photos near a summit, from Flickr.
 *
 * Commons is thin outside the well-known peaks; Flickr has far more, and its
 * API returns licence and author in machine-readable form, so photos can be
 * credited and linked back as their terms require. Only Creative Commons and
 * public-domain licences are asked for — never "all rights reserved".
 *
 * One request (documented shape, api.flickr.com/services/rest):
 *   method=flickr.photos.search&lat&lon&radius&license&extras=geo,license,…
 *   -> { photos: { photo: [ { id, owner, ownername, title, latitude,
 *        longitude, license, datetaken, pathalias, url_z, width_z, … } ] } }
 *
 * This could not be exercised against the live API from the build
 * environment. It is written against Flickr's documentation, is switched off
 * unless FLICKR_API_KEY is set, and any failure degrades to "no photos"
 * rather than breaking the panel.
 */

const API = process.env.FLICKR_API_URL || 'https://api.flickr.com/services/rest';

/** Flickr's licence ids: the ones that allow showing the photo with credit. */
export const LICENSES = {
  1: { name: 'CC BY-NC-SA 2.0', url: 'https://creativecommons.org/licenses/by-nc-sa/2.0/' },
  2: { name: 'CC BY-NC 2.0', url: 'https://creativecommons.org/licenses/by-nc/2.0/' },
  3: { name: 'CC BY-NC-ND 2.0', url: 'https://creativecommons.org/licenses/by-nc-nd/2.0/' },
  4: { name: 'CC BY 2.0', url: 'https://creativecommons.org/licenses/by/2.0/' },
  5: { name: 'CC BY-SA 2.0', url: 'https://creativecommons.org/licenses/by-sa/2.0/' },
  6: { name: 'CC BY-ND 2.0', url: 'https://creativecommons.org/licenses/by-nd/2.0/' },
  7: { name: 'No known copyright restrictions', url: 'https://www.flickr.com/commons/usage/' },
  9: { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  10: { name: 'Public Domain Mark', url: 'https://creativecommons.org/publicdomain/mark/1.0/' },
};

const THUMB_HOSTS = /^(live|farm\d+)\.staticflickr\.com$/;

export function flickrUrl(lat, lon, { radiusKm = 5, key, perPage = 20 } = {}) {
  const q = new URLSearchParams({
    method: 'flickr.photos.search',
    api_key: key,
    format: 'json',
    nojsoncallback: '1',
    lat: lat.toFixed(5),
    lon: lon.toFixed(5),
    // Flickr caps the radius at 32 km; we never want more than a few.
    radius: String(Math.min(20, radiusKm)),
    radius_units: 'km',
    license: Object.keys(LICENSES).join(','),
    extras: 'geo,license,owner_name,date_taken,path_alias,url_z,url_m',
    content_types: '0',
    media: 'photos',
    safe_search: '1',
    sort: 'interestingness-desc',
    per_page: String(perPage),
  });
  return `${API}?${q}`;
}

export function shapeFlickr(body, summit, { limit = 8 } = {}) {
  const list = body?.photos?.photo;
  if (!Array.isArray(list)) throw new Error('flickr: unexpected response shape');

  const out = [];
  for (const p of list) {
    const lat = Number(p.latitude), lon = Number(p.longitude);
    const thumbUrl = p.url_z || p.url_m;
    const lic = LICENSES[Number(p.license)];
    // No licence we can name, no usable thumbnail, or no position: skip it.
    if (!lic || !thumbUrl || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    let host;
    try {
      host = new URL(thumbUrl).hostname;
    } catch {
      continue;
    }
    if (!THUMB_HOSTS.test(host)) continue;

    const distM = Math.round(haversineKm(summit.lat, summit.lon, lat, lon) * 1000);
    out.push({
      source: 'flickr',
      title: String(p.title ?? '').trim().slice(0, 90) || 'Untitled',
      author: String(p.ownername ?? p.owner ?? '').trim().slice(0, 60) || 'Unknown author',
      license: lic.name,
      licenseUrl: lic.url,
      date: /^\d{4}-\d\d-\d\d/.test(p.datetaken ?? '') ? p.datetaken.slice(0, 10) : null,
      pageUrl: `https://www.flickr.com/photos/${encodeURIComponent(p.pathalias || p.owner)}/${encodeURIComponent(p.id)}`,
      thumbUrl,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      distM,
    });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out.slice(0, limit);
}

export async function fetchFlickr(summit, { radiusKm = 5, limit = 8, key = config.flickrApiKey } = {}) {
  if (!key) return [];
  const res = await fetch(flickrUrl(summit.lat, summit.lon, { radiusKm, key }), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`flickr HTTP ${res.status}`);
  const body = await res.json();
  // Flickr answers 200 with {stat:"fail"} for a bad key or a bad parameter.
  if (body?.stat === 'fail') throw new Error(`flickr: ${body.message ?? 'request failed'}`);
  return shapeFlickr(body, summit, { limit });
}

export const isFlickrThumb = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && THUMB_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
};
