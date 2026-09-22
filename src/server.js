import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadRegions, loadTours, inSeason } from './config.js';
import { store } from './store.js';
import { refresh } from './refresh.js';
import { evaluateAlerts, runAlerts } from './alerts.js';
import { startScheduler } from './scheduler.js';
import { findTour, getRoute, routeGpx, getForecast, warmRoutes, getPhotos, getPhotoThumb, trackStatuses } from './tracks.js';
import { getTerrain, getSlopeGrid } from './terrain.js';
import { getOwnPhotos, getOwnPhotoFile } from './own-photos.js';
import { getResorts } from './resorts.js';
import { getOutlook } from './outlook.js';
import { getSnowHistory } from './snowhistory.js';
import { getResortMap } from './resortmap.js';
import { getHuts } from './huts.js';
import { overpassStatus } from './util/overpass.js';
import { startNightScan, nightScanStatus } from './nightly.js';
import { getSkill, startVerification } from './verify.js';
import { fetchForecast } from './sources/forecast.js';
import { getDemTile, getRouteProfile, zoneInfo } from './dem.js';

const resortFc = new Map();
import { serveTile } from './tiles.js';
import { slugify } from './util/gpx.js';
import { log } from './util/log.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const EDITOR_FILE = fileURLToPath(new URL('../editor/tour-editor.html', import.meta.url));

/**
 * The tour editor, served at /editor as a PREVIEW: the page is the same
 * single file you can open from your computer, but the copy served here is
 * marked read-only, so loading a track or photos and saving files say "not
 * supported yet" instead of half-working. Writing tours into the running
 * service needs a way to authenticate first; until then the real editing is
 * done with editor/tour-editor.html on your own machine.
 */
async function serveEditor(res) {
  try {
    const html = await readFile(EDITOR_FILE, 'utf8');
    const body = Buffer.from(`<script>window.FJALLSKRED_PREVIEW = true;</script>\n${html}`, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'editor not installed' });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/** Which version is running: package.json, read once, and when it started. */
const STARTED = new Date().toISOString();
let versionMemo = null;
async function versionInfo() {
  if (!versionMemo) {
    let version = null;
    try {
      version = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? null;
    } catch {
      /* no package.json next to src: leave it unknown */
    }
    versionMemo = { version, image: process.env.FJALLSKRED_VERSION || null, node: process.version, startedAt: STARTED };
  }
  return versionMemo;
}

/** Same as json(), gzipped when the client accepts it (the outlook is big). */
function jsonz(req, res, status, body, extraHeaders = {}) {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return json(res, status, body, extraHeaders);
  const payload = gzipSync(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Encoding': 'gzip',
    Vary: 'Accept-Encoding',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Static files are served only from ./public and only after the resolved
 * path is confirmed to still sit inside it, so "../../etc/passwd" and its
 * encoded variants cannot escape.
 */
async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    // Code and styles are always revalidated: after an update the browser
    // must not run an hour-old app.js against a new route.js (ES modules
    // are fetched one by one, so a stale cache mixes versions). An ETag makes
    // the check cheap: 304 when nothing changed. Images may be cached.
    const ext = path.extname(resolved);
    const code = rel === 'index.html' || ['.js', '.css', '.html', '.json'].includes(ext);
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    if (code && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const body = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': code ? 'no-cache' : 'public, max-age=3600',
      ...(code ? { ETag: etag } : {}),
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

let refreshing = null;

/** A small JSON request body; anything over `max` bytes is refused. */
function readJsonBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (over) return; // drain and drop the rest, so the 413 can be sent
      if (size > max) {
        over = true;
        chunks.length = 0;
        const e = new Error('request body too large');
        e.status = 413;
        reject(e);
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        const e = new Error('body is not JSON');
        e.status = 400;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/conditions') {
    const snapshot = await store.getSnapshot();
    if (!snapshot) {
      return json(res, 503, {
        error: 'no snapshot yet',
        hint: 'the first refresh has not completed; try again shortly or POST /api/refresh',
      });
    }
    return json(res, 200, snapshot);
  }

  if (route === '/api/alerts') {
    const snapshot = await store.getSnapshot();
    const ledger = await store.getAlertLedger();
    return json(res, 200, {
      threshold: config.alertThresholdCm,
      watching: config.alertRegions,
      quietHours: { from: config.quietFrom, to: config.quietTo },
      firing: snapshot ? evaluateAlerts(snapshot) : [],
      pending: ledger?.pending ?? [],
      recentlySent: Object.entries(ledger?.sent ?? {})
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, 20)
        .map(([key, at]) => ({ key, at })),
      channels: {
        email: config.mailProvider !== 'none' && config.mailTo.length > 0,
        ntfy: Boolean(config.ntfyTopic),
      },
    });
  }

  if (route === '/api/health') {
    const snapshot = await store.getSnapshot();
    const ageMin = snapshot
      ? Math.round((Date.now() - new Date(snapshot.fetchedAt).getTime()) / 60000)
      : null;
    const stale = ageMin === null || ageMin > config.refreshMinutes * 2;
    return json(res, stale ? 503 : 200, {
      ok: !stale,
      season: inSeason(),
      snapshotAgeMinutes: ageMin,
      refreshMinutes: config.refreshMinutes,
      sources: snapshot?.sources ?? null,
      channels: {
        email: config.mailProvider !== 'none' && config.mailTo.length > 0,
        ntfy: Boolean(config.ntfyTopic),
      },
      version: 1,
    });
  }

  if (route === '/api/refresh' && req.method === 'POST') {
    // The box is reachable from the internet, so "Refresh now" has a
    // cooldown: within it, the last snapshot is returned instead of asking
    // NVE again. Concurrent refreshes are coalesced as well.
    const last = await store.getSnapshot();
    const age = last?.fetchedAt ? Date.now() - new Date(last.fetchedAt).getTime() : Infinity;
    if (!refreshing && age < config.refreshCooldownMinutes * 60e3) {
      return json(res, 200, { ok: true, fetchedAt: last.fetchedAt, status: last.status, cooldown: true });
    }
    if (!refreshing) {
      refreshing = refresh({ force: true })
        .then(async (snap) => {
          await runAlerts(snap);
          return snap;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    const snapshot = await refreshing;
    return json(res, 200, { ok: true, fetchedAt: snapshot.fetchedAt, status: snapshot.status });
  }

  if (route === '/api/test-alert' && req.method === 'POST') {
    const snapshot = await store.getSnapshot();
    const result = await runAlerts(snapshot ?? { regions: [] }, { dryRun: true });
    return json(res, 200, { dryRun: true, ...result });
  }

  if (route === '/api/outlook') {
    try {
      return jsonz(req, res, 200, await getOutlook(), { 'Cache-Control': 'public, max-age=300' });
    } catch (err) {
      return json(res, 502, { error: 'outlook unavailable', detail: err.message });
    }
  }

  if (route === '/api/resorts') {
    if (!config.resortsEnabled) return json(res, 404, { error: 'resort layer disabled' });
    return json(res, 200, await getResorts(), { 'Cache-Control': 'public, max-age=300' });
  }

  if (route === '/api/tracks') {
    return json(res, 200, { tours: await trackStatuses() }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (route === '/api/version') {
    return json(res, 200, { ...(await versionInfo()), nightScan: await nightScanStatus().catch(() => null) });
  }

  if (route === '/api/meta') {
    const [regions, tours] = await Promise.all([loadRegions(), loadTours()]);
    return json(res, 200, { regions, tours: tours.map((t) => ({ ...t, slug: slugify(t.name) })) });
  }

  // Per-tour routes and forecasts. Only tours from data/tours.json, by name
  // or slug: never arbitrary coordinates (see src/tracks.js for why).
  // A resort's forecast: only resorts from the resort list, by id, never
  // arbitrary coordinates (same reason as for tours).
  if (route === '/api/huts') {
    try {
      return jsonz(req, res, 200, await getHuts(), { 'Cache-Control': 'public, max-age=3600' });
    } catch (err) {
      return json(res, 502, { error: 'huts unavailable', detail: err.message });
    }
  }

  // Snow through the winter at a resort: the same seNorge series, at its point.
  if (route === '/api/snowhistory' && url.searchParams.has('resort')) {
    const list = (await getResorts().catch(() => null))?.resorts ?? [];
    const r = list.find((x) => x.id === url.searchParams.get('resort'));
    if (!r) return json(res, 404, { error: 'unknown resort' });
    try {
      return jsonz(req, res, 200, await getSnowHistory({ name: `resort ${r.id}`, lat: r.lat, lon: r.lon }), { 'Cache-Control': 'public, max-age=3600' });
    } catch (err) {
      return json(res, 502, { error: 'snow history unavailable', detail: err.message });
    }
  }

  if (route === '/api/skill') {
    // How well the forecasts have done, by cell, parameter and lead time.
    try {
      return jsonz(req, res, 200, await getSkill(), { 'Cache-Control': 'public, max-age=900' });
    } catch (err) {
      return json(res, 502, { error: 'skill data unavailable', detail: err.message });
    }
  }

  // v5 terrain page: elevation grids and route profiles, service area only.
  const dem = route.match(/^\/api\/dem\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/);
  if (dem) {
    try {
      return jsonz(req, res, 200, await getDemTile(+dem[1], +dem[2], +dem[3]), { 'Cache-Control': 'public, max-age=604800' });
    } catch (err) {
      return json(res, err.status ?? 502, { error: err.message });
    }
  }
  if (route === '/api/terrain/zone') {
    return json(res, 200, await zoneInfo());
  }
  if (route === '/api/terrain/profile') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST a route: {"points": [[lat, lon], ...]}' });
    try {
      return jsonz(req, res, 200, await getRouteProfile(await readJsonBody(req)));
    } catch (err) {
      return json(res, err.status ?? 502, { error: err.message });
    }
  }

  if (route === '/api/overpass') {
    // What the OpenStreetMap queue is doing: for diagnosing a map that won't load.
    return json(res, 200, overpassStatus());
  }
  if (route === '/api/resortmap') {
    const list = (await getResorts().catch(() => null))?.resorts ?? [];
    const r = list.find((x) => x.id === url.searchParams.get('resort'));
    if (!r) return json(res, 404, { error: 'unknown resort' });
    try {
      return jsonz(req, res, 200, await getResortMap(r), { 'Cache-Control': 'public, max-age=3600' });
    } catch (err) {
      return json(res, 502, { error: 'resort map unavailable', detail: err.message });
    }
  }
  if (route === '/api/forecast' && url.searchParams.has('resort')) {
    const id = url.searchParams.get('resort');
    const list = (await getResorts().catch(() => null))?.resorts ?? [];
    const r = list.find((x) => x.id === id);
    if (!r) return json(res, 404, { error: 'unknown resort' });
    const hit = resortFc.get(id);
    if (hit && Date.now() - hit.at < 2 * 3600e3) return json(res, 200, hit.value);
    try {
      const value = { resort: r.name, where: { lat: r.lat, lon: r.lon }, ...(await fetchForecast({ lat: r.lat, lon: r.lon })), fetchedAt: new Date().toISOString() };
      resortFc.set(id, { at: Date.now(), value });
      return json(res, 200, value);
    } catch (err) {
      return json(res, 502, { error: 'forecast unavailable', detail: err.message });
    }
  }

  if (['/api/track', '/api/track.gpx', '/api/forecast', '/api/terrain', '/api/photos', '/api/photo', '/api/own-photos', '/api/own-photo', '/api/slopes', '/api/snowhistory'].includes(route)) {
    const tour = await findTour(url.searchParams.get('tour') ?? '');
    if (!tour) return json(res, 404, { error: 'unknown tour' });

    if (route === '/api/snowhistory') {
      try {
        return jsonz(req, res, 200, await getSnowHistory(tour), { 'Cache-Control': 'public, max-age=3600' });
      } catch (err) {
        return json(res, 502, { error: 'snow history unavailable', detail: err.message });
      }
    }
    if (route === '/api/slopes') {
      try {
        return json(res, 200, await getSlopeGrid(tour), { 'Cache-Control': 'public, max-age=3600' });
      } catch (err) {
        return json(res, 502, { error: 'slope grid unavailable', detail: err.message });
      }
    }
    if (route === '/api/terrain') {
      try {
        return json(res, 200, await getTerrain(tour));
      } catch (err) {
        return json(res, 502, { error: 'terrain unavailable', detail: err.message });
      }
    }
    if (route === '/api/photos') {
      try {
        const p = await getPhotos(tour);
        // Thumbnails go through /api/photo; the upstream URL never reaches the browser.
        return json(res, 200, { ...p, photos: p.photos.map(({ thumbUrl, ...rest }, i) => ({ ...rest, i })) });
      } catch (err) {
        return json(res, 502, { error: 'photos unavailable', detail: err.message });
      }
    }
    if (route === '/api/photo') {
      const raw = url.searchParams.get('i') ?? '';
      const i = Number(raw);
      if (!/^\d{1,2}$/.test(raw) || i > 20) return json(res, 400, { error: 'bad index' });
      const thumb = await getPhotoThumb(tour, i).catch(() => null);
      if (!thumb) return json(res, 404, { error: 'no such photo' });
      res.writeHead(200, { 'Content-Type': thumb.type, 'Content-Length': thumb.body.length, 'Cache-Control': 'public, max-age=604800' });
      return res.end(thumb.body);
    }

    // Your own photos (data/photos/<slug>/, made with the tour editor).
    if (route === '/api/own-photos') {
      return json(res, 200, await getOwnPhotos(tour), { 'Cache-Control': 'public, max-age=60' });
    }
    if (route === '/api/own-photo') {
      const raw = url.searchParams.get('i') ?? '';
      if (!/^\d{1,2}$/.test(raw)) return json(res, 400, { error: 'bad index' });
      const f = await getOwnPhotoFile(tour, Number(raw)).catch(() => null);
      if (!f) return json(res, 404, { error: 'no such photo' });
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'public, max-age=3600' });
      return res.end(f.body);
    }

    if (route === '/api/forecast') {
      try {
        return json(res, 200, await getForecast(tour));
      } catch (err) {
        return json(res, 502, { error: 'forecast unavailable', detail: err.message });
      }
    }

    let r;
    try {
      r = await getRoute(tour);
    } catch (err) {
      return json(res, 502, { error: 'route lookup failed', detail: err.message, tour: tour.name });
    }
    if (route === '/api/track') return json(res, 200, r);

    if (!r.found) return json(res, 404, { error: 'no route for this tour', reason: r.reason });
    const gpx = routeGpx(r);
    res.writeHead(200, {
      'Content-Type': 'application/gpx+xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slugify(tour.name)}.gpx"`,
      'Content-Length': Buffer.byteLength(gpx),
    });
    return res.end(gpx);
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      const tile = url.pathname.match(/^\/tiles\/([a-z]{2,3})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
      if (tile && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveTile(res, tile[1], +tile[2], +tile[3], +tile[4]);
      } else if (url.pathname === '/editor' || url.pathname === '/editor/') {
        if (req.method === 'GET' || req.method === 'HEAD') await serveEditor(res);
        else json(res, 405, { error: 'method not allowed' });
      } else if (url.pathname === '/skill' || url.pathname === '/skill/') {
        // The forecast-accuracy tool, its own page like the tour editor.
        if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, '/skill.html');
        else json(res, 405, { error: 'method not allowed' });
      } else if (url.pathname === '/terrain' || url.pathname === '/terrain/') {
        // The terrain & route page (v5), a page of its own like the editor.
        if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, '/terrain.html');
        else json(res, 405, { error: 'method not allowed' });
      } else if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        json(res, 405, { error: 'method not allowed' });
      }
    } catch (err) {
      log.error(`request ${req.method} ${url.pathname} failed:`, err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    log.info(`toppturvarsel listening on http://${config.host}:${config.port}`);
    log.info(
      `alerts: ${config.alertThresholdCm} cm / 48 h | ` +
        `email=${config.mailProvider !== 'none' && config.mailTo.length ? 'on' : 'off'} ` +
        `ntfy=${config.ntfyTopic ? 'on' : 'off'}`
    );
    startScheduler();
    // Ski-area maps and snow history for every resort, fetched at night.
    startNightScan();
    // Keep every forecast and check it against what happened.
    startVerification();
    // Derive tour routes quietly in the background, one at a time.
    if ((process.env.TRACKS_WARMUP ?? 'true') !== 'false') {
      setTimeout(() => warmRoutes().catch((e) => log.warn(`tracks: warm-up failed: ${e.message}`)), 60000).unref();
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info(`${sig} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
