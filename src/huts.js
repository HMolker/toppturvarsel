import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config, loadTours } from './config.js';
import { haversineKm } from './util/utm.js';
import { log } from './util/log.js';

/**
 * Huts, mountain lodges and remote cafés near the tours, from OpenStreetMap:
 * the places a ski tour can start from, pass or end at. Not bars in town.
 *
 *   GET /api/huts  -> { places: [...], fetchedAt, source }
 *
 * What is included, within 15 km of a listed tour:
 *   - tourism=alpine_hut        staffed and self-service cabins (DNT, STF and others)
 *   - tourism=wilderness_hut    open shelters and unstaffed huts
 *   - hotels / guest houses / hostels named like mountain lodges
 *     (fjellstue, fjellstove, fjellhotell, turisthytte, fjällstation, fjällstuga, seter …)
 *   - amenity=cafe|restaurant only when REMOTE: at least 3 km from any
 *     village, town or city, so the café at the summit station or the
 *     valley-end farm counts and the high street does not.
 * Bars, pubs and fast food are never included.
 *
 * "Open in winter" comes from OSM's opening_hours and seasonal tags when
 * they say so; most places do not, and are shown as "check" with a link.
 * Each place links to its own website when OSM has one; DNT and STF places
 * without one link to a search of ut.no or svenskaturistforeningen.se.
 *
 * One Overpass request (batched by tour clusters), cached for 30 days.
 * Data © OpenStreetMap contributors, ODbL.
 */

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const TTL = 30 * 86400e3;
const RADIUS_M = 15000;
const REMOTE_KM = 3;
const LODGE = /fjell(stue|stove|hotell|hotel|gard|gård)|turisthytte|fjäll(station|stuga|hotell|gård)|seter|säter|stølen|stølsstue|hytte|stugby/i;

export function hutsQuery(points, r = RADIUS_M) {
  const around = (p) => `(around:${r},${p.lat.toFixed(4)},${p.lon.toFixed(4)})`;
  const lines = points.flatMap((p) => [
    `nwr${around(p)}[tourism~"^(alpine_hut|wilderness_hut)$"];`,
    `nwr${around(p)}[tourism~"^(hotel|guest_house|hostel|chalet)$"][name];`,
    `nwr${around(p)}[amenity~"^(cafe|restaurant)$"];`,
    `node(around:${r + 5000},${p.lat.toFixed(4)},${p.lon.toFixed(4)})[place~"^(village|town|city)$"];`,
  ]);
  return `[out:json][timeout:180];\n(\n  ${lines.join('\n  ')}\n);\nout center tags;`;
}

/** Tours within ~8 km of each other share one search circle. */
export function clusterPoints(tours, km = 8) {
  const out = [];
  for (const t of tours) {
    if (!out.some((c) => haversineKm(c.lat, c.lon, t.lat, t.lon) < km)) out.push({ lat: t.lat, lon: t.lon });
  }
  return out;
}

async function fetchOverpass(points) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'toppturvarsel/1.0 (self-hosted ski touring dashboard)',
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(hutsQuery(points))}`,
    signal: AbortSignal.timeout(200000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.elements)) throw new Error('Overpass: no elements array');
  return body.elements;
}

/* ------------------------------------------------------------------ *
 * pure helpers (tested)
 * ------------------------------------------------------------------ */

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Open at some point in the ski season (December – May)? true / false / null.
 * Reads seasonal=* and month ranges in opening_hours ("Feb-Apr", "Jun 20-Sep 10",
 * "Mar,Apr"); "24/7" counts as open (an unlocked shelter). Anything else: null.
 */
export function winterOpen(tags = {}) {
  const seasonal = String(tags.seasonal ?? '').toLowerCase();
  if (/winter|spring/.test(seasonal)) return true;
  if (/^summer$|^(summer;autumn|autumn;summer)$/.test(seasonal)) return false;
  const oh = String(tags.opening_hours ?? '');
  if (!oh) return null;
  if (/24\/7/.test(oh)) return true;
  if (/^off$|^closed$/i.test(oh.trim())) return false;
  const months = new Set();
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{1,2})?(?:\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{1,2})?)?/gi;
  let m;
  while ((m = re.exec(oh))) {
    const a = MONTH[m[1].toLowerCase()], b = m[2] ? MONTH[m[2].toLowerCase()] : a;
    for (let k = a; ; k = (k % 12) + 1) {
      months.add(k);
      if (k === b) break;
    }
  }
  if (!months.size) return null; // weekday hours only: year-round or unknown, can't tell
  return [12, 1, 2, 3, 4, 5].some((k) => months.has(k));
}

export function orgOf(tags = {}) {
  const op = `${tags.operator ?? ''} ${tags.owner ?? ''} ${tags.brand ?? ''}`;
  if (/den norske turistforening|\bDNT\b|turistforening|turlag/i.test(op)) return 'DNT';
  if (/svenska turistf(ö|o)reningen|\bSTF\b/i.test(op)) return 'STF';
  return null;
}

const num = (v) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const safeUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;
  } catch {
    return null;
  }
};

/** Overpass elements -> places (pure). `near` = tour points the places must be within reach of. */
export function shapeHuts(elements, near = []) {
  const settlements = [];
  const raw = [];
  for (const e of elements ?? []) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (e.type === 'node' && /^(village|town|city)$/.test(t.place ?? '')) {
      settlements.push({ lat, lon });
      continue;
    }
    raw.push({ e, t, lat, lon });
  }
  const remote = (p) => !settlements.some((s) => haversineKm(s.lat, s.lon, p.lat, p.lon) < REMOTE_KM);

  const seen = new Set();
  const out = [];
  for (const { e, t, lat, lon } of raw) {
    let kind = null;
    if (t.tourism === 'alpine_hut') kind = 'hut';
    else if (t.tourism === 'wilderness_hut') kind = 'shelter';
    else if (/^(hotel|guest_house|hostel|chalet)$/.test(t.tourism ?? '') && LODGE.test(t.name ?? '')) kind = 'lodge';
    else if (/^(cafe|restaurant)$/.test(t.amenity ?? '') && remote({ lat, lon })) kind = t.amenity === 'cafe' ? 'cafe' : 'restaurant';
    if (!kind) continue;
    const key = `${e.type}/${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (near.length && !near.some((p) => haversineKm(p.lat, p.lon, lat, lon) <= RADIUS_M / 1000 + 0.5)) continue;
    const org = orgOf(t);
    // Where to read more: the place's own site, else a search on the club's site.
    const more = org === 'DNT' && t.name ? `https://www.google.com/search?q=${encodeURIComponent(`site:ut.no ${t.name}`)}`
      : org === 'STF' && t.name ? `https://www.google.com/search?q=${encodeURIComponent(`site:svenskaturistforeningen.se ${t.name}`)}` : null;
    out.push({
      id: key,
      kind,
      name: t.name ?? null,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      ele: num(t.ele),
      org,
      operator: t.operator ?? null,
      beds: num(t.beds ?? t.capacity),
      staffed: /^(yes|staffed|betjent)$/i.test(t.staffed ?? t['hut:staffed'] ?? '') ? true : null,
      opening: t.opening_hours ?? null,
      winter: winterOpen(t),
      fee: t.fee ?? null,
      website: safeUrl(t.website ?? t['contact:website'] ?? t.url),
      more,
    });
  }
  return out;
}

const file = () => path.resolve(config.dataDir, 'cache', 'huts.json');
let memo = null;

export async function getHuts({ force = false } = {}) {
  if (!force && memo && Date.now() - memo.at < 3600e3) return memo.value;
  try {
    const cached = JSON.parse(await readFile(file(), 'utf8'));
    if (!force && Date.now() - new Date(cached.fetchedAt).getTime() < TTL) {
      memo = { at: Date.now(), value: cached };
      return cached;
    }
  } catch {
    /* not cached */
  }
  const tours = (await loadTours()).filter((t) => Number.isFinite(t.lat));
  const points = clusterPoints(tours);
  let places;
  try {
    places = shapeHuts(await fetchOverpass(points), tours);
  } catch (err) {
    log.warn(`huts: ${err.message}`);
    // Keep serving the last list if there is one.
    const stale = await readFile(file(), 'utf8').then(JSON.parse).catch(() => null);
    if (stale) return { ...stale, stale: true, error: err.message };
    throw err;
  }
  const value = { places, fetchedAt: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL)' };
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(`${file()}.tmp`, JSON.stringify(value));
  await rename(`${file()}.tmp`, file());
  memo = { at: Date.now(), value };
  return value;
}
