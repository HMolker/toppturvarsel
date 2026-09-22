import { UA } from './util/ua.js';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, loadTours, loadRegions } from './config.js';
import { discoverRoute } from './sources/osm.js';
import { overpassCooling } from './util/overpass.js';
import { withProfile } from './sources/elevation.js';
import { fetchForecast } from './sources/forecast.js';
import { parseGpx, toGpx, slugify } from './util/gpx.js';
import { log } from './util/log.js';
import { sleep } from './util/http.js';

/**
 * Per-tour route + elevation profile, and per-tour forecasts.
 *
 * Precedence for a route:
 *   1. data/tracks/<slug>.gpx — your own file, always wins
 *   2. cached derivation      — 30 days for a found route, 7 for "none found"
 *   3. OpenStreetMap          — derived on demand, then cached
 *
 * Routes are looked up only for tours in data/tours.json, by name. There is
 * no "route for arbitrary coordinates" endpoint: on a server exposed to the
 * internet that would be a free Overpass/elevation relay for anyone.
 */

const ROUTE_TTL = 30 * 86400e3;
const NONE_TTL = 7 * 86400e3;
const FORECAST_TTL = 2 * 3600e3;

const cacheDir = (...p) => path.resolve(config.dataDir, 'cache', ...p);
const userTrackDir = () => path.resolve(config.dataDir, 'tracks');

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, file);
}

export async function countryOf(tour) {
  const regions = await loadRegions();
  return regions.find((r) => r.id === tour.region)?.country ?? null;
}

export async function findTour(name) {
  const tours = await loadTours();
  return tours.find((t) => t.name === name || slugify(t.name) === name) ?? null;
}

const inflight = new Map();

export async function getRoute(tour, { refresh = false, priority = 'normal' } = {}) {
  const slug = slugify(tour.name);
  if (inflight.has(slug)) return inflight.get(slug);
  const job = (async () => {
    // 1. the user's own GPX
    const own = path.join(userTrackDir(), `${slug}.gpx`);
    try {
      const xml = await readFile(own, 'utf8');
      const pts = parseGpx(xml);
      if (pts.length >= 2) {
        const info = await stat(own);
        const cached = await readJson(cacheDir('tracks', `${slug}.json`));
        if (!refresh && cached?.source === 'gpx' && cached.gpxMtime === info.mtimeMs) return cached;
        const profile = await withProfile(pts, { country: await countryOf(tour) }).catch((e) => ({ error: e.message }));
        const route = {
          found: true, source: 'gpx', kind: 'own-gpx', tour: tour.name, slug,
          gpxMtime: info.mtimeMs, points: pts.map(({ lat, lon }) => ({ lat, lon })),
          lengthM: profile?.stats?.distanceM ?? null, profile,
          summit: { lat: tour.lat, lon: tour.lon, name: tour.name, ele: tour.summit_m ?? null, source: 'tour-coordinates' },
          fetchedAt: new Date().toISOString(),
        };
        await writeJson(cacheDir('tracks', `${slug}.json`), route);
        return route;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`tracks: could not read ${own}: ${err.message}`);
    }

    // Area tours have no single line by definition.
    if (tour.kind === 'area') {
      return {
        found: false, tour: tour.name, slug, kind: 'area',
        reason: 'This is a touring area with many lines, not a single route.',
        summit: { lat: tour.lat, lon: tour.lon, name: tour.name, ele: tour.summit_m ?? null, source: 'tour-coordinates' },
      };
    }

    // 2. cache
    const cached = await readJson(cacheDir('tracks', `${slug}.json`));
    if (!refresh && cached && cached.source !== 'gpx') {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < (cached.found ? ROUTE_TTL : NONE_TTL)) return cached;
    }

    // 3. derive
    const route = await discoverRoute(tour, { priority });
    route.tour = tour.name;
    route.slug = slug;
    route.fetchedAt = new Date().toISOString();
    if (route.found) {
      route.profile = await withProfile(route.points, { country: await countryOf(tour) }).catch((e) => ({ error: e.message }));
    }
    await writeJson(cacheDir('tracks', `${slug}.json`), route);
    return route;
  })();
  inflight.set(slug, job);
  try {
    return await job;
  } finally {
    inflight.delete(slug);
  }
}

export function routeGpx(route) {
  const points = route.points;
  const osm = route.source === 'osm';
  return toGpx({
    name: route.tour,
    desc: osm
      ? `${route.kind === 'ski-route' ? 'Ski-touring route' : 'Summer path to the summit — the ski line may differ'}. ` +
        `Derived from OpenStreetMap by Fjällskred. Not a recommendation: check the avalanche bulletin and terrain.`
      : 'Your own track.',
    points,
    source: osm ? 'OpenStreetMap contributors' : 'user',
    license: osm ? 'https://opendatacommons.org/licenses/odbl/1-0/' : null,
  });
}

/* ------------------------------------------------------------------ *
 * forecasts
 * ------------------------------------------------------------------ */

const fcMemo = new Map();

export async function getForecast(tour) {
  const slug = slugify(tour.name);
  const hit = fcMemo.get(slug);
  if (hit && Date.now() - hit.at < FORECAST_TTL) return hit.value;

  // Prefer the OSM-snapped summit if we already know it.
  const route = await readJson(cacheDir('tracks', `${slug}.json`));
  const s = route?.summit?.source?.startsWith('osm') ? route.summit : null;
  const where = {
    lat: s?.lat ?? tour.lat,
    lon: s?.lon ?? tour.lon,
    elevation: s?.ele ?? tour.summit_m ?? null,
  };
  const value = { tour: tour.name, where, ...(await fetchForecast(where)), fetchedAt: new Date().toISOString() };
  fcMemo.set(slug, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ *
 * background warm-up
 * ------------------------------------------------------------------ */

/**
 * Derive missing routes one at a time, a few seconds apart, so the first
 * click on a tour is instant and Overpass never sees a burst from us.
 */
export async function warmRoutes({ delayMs = 5000, retryMs = 30 * 60e3 } = {}) {
  const tours = await loadTours();
  let done = 0;
  for (const tour of tours) {
    if (tour.kind === 'area') continue;
    const cached = await readJson(cacheDir('tracks', `${slugify(tour.name)}.json`));
    if (cached) continue;
    if (overpassCooling()) {
      // OpenStreetMap is failing: stop hammering it and come back later.
      log.info(`tracks: warm-up paused (OpenStreetMap unavailable); trying again in ${Math.round(retryMs / 60000)} min`);
      setTimeout(() => warmRoutes({ delayMs, retryMs }).catch(() => {}), retryMs).unref?.();
      break;
    }
    try {
      await getRoute(tour, { priority: 'low' });
      done++;
    } catch (err) {
      log.warn(`tracks: warm-up ${tour.name} failed: ${err.message}`);
    }
    await sleep(delayMs);
  }
  if (done) log.info(`tracks: warm-up derived ${done} route(s)`);
}

export async function tourBoxes() {
  const [tours, regions] = await Promise.all([loadTours(), loadRegions()]);
  const country = Object.fromEntries(regions.map((r) => [r.id, r.country]));
  return tours.map((t) => ({ lat: t.lat, lon: t.lon, country: country[t.region] }));
}

/* ------------------------------------------------------------------ *
 * photos near the summit (Wikimedia Commons)
 * ------------------------------------------------------------------ */

const PHOTO_TTL = 7 * 86400e3;

export async function getPhotos(tour) {
  const { fetchPhotos } = await import('./sources/photos.js');
  const { fetchFlickr } = await import('./sources/flickr.js');
  const slug = slugify(tour.name);
  const file = cacheDir('photos', `${slug}.json`);
  const cached = await readJson(file);
  // A list with photos keeps for a week. An empty one, or one where an archive
  // could not be reached, is looked at again after a few hours: an outage (or
  // a refused request) must not leave every tour without photos for a week.
  const ttl = cached?.photos?.length && !cached.errors ? PHOTO_TTL : 6 * 3600e3;
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttl) return cached;

  const route = await readJson(cacheDir('tracks', `${slug}.json`));
  const s = route?.summit?.source?.startsWith('osm') ? route.summit : { lat: tour.lat, lon: tour.lon };
  // Two archives, one list: Commons first (best credited), then Flickr, which
  // has far more of the smaller summits. Either failing leaves the other.
  const errors = {};
  const [commons, flickr] = await Promise.all([
    fetchPhotos({ ...s, name: tour.name }).catch((e) => {
      log.warn(`photos: Commons failed for ${tour.name}: ${e.message}`);
      errors.commons = e.message;
      return [];
    }),
    fetchFlickr(s).catch((e) => {
      log.warn(`photos: Flickr failed for ${tour.name}: ${e.message}`);
      errors.flickr = e.message;
      return [];
    }),
  ]);
  const photos = [...commons, ...flickr]
    .sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity))
    .slice(0, 10);
  const value = {
    tour: tour.name, summit: { lat: s.lat, lon: s.lon }, photos, fetchedAt: new Date().toISOString(),
    flickr: Boolean(config.flickrApiKey),
    ...(Object.keys(errors).length ? { errors } : {}),
  };
  await writeJson(file, value);
  return value;
}

/**
 * Thumbnail proxy. The browser asks for photo #i of a tour; the server
 * looks up that photo's Commons thumbnail URL in its own cache and serves
 * it. There is no way to pass a URL in, so this cannot be used to fetch
 * anything but thumbnails the service itself chose to show.
 */
export async function getPhotoThumb(tour, i) {
  const { isCommonsThumb } = await import('./sources/photos.js');
  const { isFlickrThumb } = await import('./sources/flickr.js');
  const list = await getPhotos(tour);
  const photo = list.photos?.[i];
  // The browser asks for photo #i; only the two archives' own thumbnail hosts
  // are ever fetched, so this cannot be turned into an open proxy.
  if (!photo || !(isCommonsThumb(photo.thumbUrl) || isFlickrThumb(photo.thumbUrl))) return null;

  const file = cacheDir('photos', 'thumbs', `${slugify(tour.name)}-${i}.jpg`);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < PHOTO_TTL) return { body: await readFile(file), type: 'image/jpeg' };
  } catch {
    /* not cached */
  }
  const res = await fetch(photo.thumbUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? 'image/jpeg';
  if (!/^image\/(jpeg|png|webp)$/.test(type.split(';')[0])) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 2_000_000) return null;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return { body, type: type.split(';')[0] };
}

/**
 * Whether each tour has a track, for the marker in the tour list. Reads only
 * what is on disk (your GPX files and the route cache); never looks anything
 * up, so it is cheap and cannot trigger Overpass. Memoised for a minute.
 *
 *   gpx     your own data/tracks/<slug>.gpx
 *   osm     derived from OpenStreetMap (kind: ski-route or summer path)
 *   none    looked up, nothing found
 *   area    a touring area, no single line by design
 *   pending not looked up yet (the background warm-up gets to it)
 */
let statusMemo = null;
export async function trackStatuses() {
  if (statusMemo && Date.now() - statusMemo.at < 60e3) return statusMemo.value;
  const tours = await loadTours();
  const value = {};
  await Promise.all(
    tours.map(async (t) => {
      const slug = slugify(t.name);
      try {
        const own = await stat(path.join(userTrackDir(), `${slug}.gpx`));
        if (own.size > 0) return (value[t.name] = { status: 'gpx' });
      } catch {
        /* no own file */
      }
      if (t.kind === 'area') return (value[t.name] = { status: 'area' });
      const cached = await readJson(cacheDir('tracks', `${slug}.json`));
      if (!cached || cached.source === 'gpx') return (value[t.name] = { status: 'pending' });
      value[t.name] = cached.found ? { status: 'osm', kind: cached.kind ?? null } : { status: 'none' };
    })
  );
  statusMemo = { at: Date.now(), value };
  return value;
}

/** Start of a tour's route, if one has been derived and cached (no network). */
export async function cachedRouteStart(tour) {
  const r = await readJson(cacheDir('tracks', `${slugify(tour.name)}.json`));
  const p = r?.found ? r.points?.[0] : null;
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : null;
}
