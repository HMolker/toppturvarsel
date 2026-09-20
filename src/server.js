import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadRegions, loadTours, inSeason } from './config.js';
import { store } from './store.js';
import { refresh } from './refresh.js';
import { evaluateAlerts, runAlerts } from './alerts.js';
import { startScheduler } from './scheduler.js';
import { findTour, getRoute, routeGpx, getForecast, warmRoutes, getPhotos, getPhotoThumb, trackStatuses } from './tracks.js';
import { getTerrain } from './terrain.js';
import { getResorts } from './resorts.js';
import { getOutlook } from './outlook.js';
import { serveTile } from './tiles.js';
import { slugify } from './util/gpx.js';
import { log } from './util/log.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

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
    const body = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

let refreshing = null;

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
      return json(res, 200, await getOutlook(), { 'Cache-Control': 'public, max-age=300' });
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

  if (route === '/api/meta') {
    const [regions, tours] = await Promise.all([loadRegions(), loadTours()]);
    return json(res, 200, { regions, tours: tours.map((t) => ({ ...t, slug: slugify(t.name) })) });
  }

  // Per-tour routes and forecasts. Only tours from data/tours.json, by name
  // or slug: never arbitrary coordinates (see src/tracks.js for why).
  if (['/api/track', '/api/track.gpx', '/api/forecast', '/api/terrain', '/api/photos', '/api/photo'].includes(route)) {
    const tour = await findTour(url.searchParams.get('tour') ?? '');
    if (!tour) return json(res, 404, { error: 'unknown tour' });

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
      const tile = url.pathname.match(/^\/tiles\/([a-z]{2})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
      if (tile && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveTile(res, tile[1], +tile[2], +tile[3], +tile[4]);
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
