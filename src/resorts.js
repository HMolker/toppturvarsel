import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fetchFnugg } from './sources/fnugg.js';
import { fetchOsmResorts } from './sources/osm-resorts.js';
import { log } from './util/log.js';
import { fileURLToPath } from 'node:url';

/**
 * Ski resorts layer: Norway live from Fnugg, Sweden from OpenStreetMap
 * (location, name, website; no live status exists to fetch).
 *
 * Each source is cached on disk on its own schedule and fails on its own:
 * if Fnugg is down, the last good Norwegian list is served, marked stale,
 * and Sweden is unaffected. The endpoint takes no parameters, so it cannot
 * be used to make this box query anything on anyone's behalf.
 *
 * Sweden's list is one big Overpass query, and OpenStreetMap's public
 * servers turn it away often enough that it cannot be the only way in. So:
 * the last good list is served however old it is, a failed attempt is not
 * repeated for RETRY_AFTER_FAIL, and if there has never been a good list,
 * data/resorts-se-seed.json — the major Swedish resorts, with approximate
 * positions — stands in until OpenStreetMap answers.
 */

const HOUR = 3600e3;
const inSeason = (d = new Date()) => {
  const m = d.getUTCMonth() + 1;
  return m >= 11 || m <= 5;
};

export const SOURCES = {
  no: { fetch: fetchFnugg, ttl: () => (inSeason() ? HOUR : 24 * HOUR), name: 'Fnugg' },
  se: { fetch: () => fetchOsmResorts('SE'), ttl: () => 30 * 24 * HOUR, name: 'OpenStreetMap' },
};

const fallback = (key) => (key === 'se' ? seedResorts() : Promise.resolve([]));

const fileFor = (key) => path.resolve(config.dataDir, 'cache', 'resorts', `${key}.json`);

async function readCache(key) {
  try {
    return JSON.parse(await readFile(fileFor(key), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  const f = fileFor(key);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(`${f}.tmp`, JSON.stringify(value));
  await rename(`${f}.tmp`, f);
}

const RETRY_AFTER_FAIL = 15 * 60e3;
const failedAt = new Map();
const inflight = new Map();

/** The built-in Swedish list, so the map is never empty. */
let seedMemo = null;
async function seedResorts() {
  if (seedMemo) return seedMemo;
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'resorts-se-seed.json');
    const body = JSON.parse(await readFile(f, 'utf8'));
    seedMemo = (body.resorts ?? []).map((r, i) => ({
      id: `seed-se-${i}`, name: r.name, country: 'SE', lat: r.lat, lon: r.lon,
      url: r.url ?? null, live: false, approx: true, source: 'seed',
    }));
  } catch (err) {
    log.warn(`resorts: built-in Swedish list: ${err.message}`);
    seedMemo = [];
  }
  return seedMemo;
}

async function getSource(key) {
  const src = SOURCES[key];
  const cached = await readCache(key);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < src.ttl()) return { ...cached, stale: false };
  if (inflight.has(key)) return inflight.get(key);
  // A source that just failed is left alone for a while: retrying on every
  // page load only queues more requests at a server that is already saying no.
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed.at < RETRY_AFTER_FAIL) {
    if (cached) return { ...cached, stale: true, error: failed.error };
    return { source: src.name, fetchedAt: null, resorts: await fallback(key), stale: true, error: failed.error };
  }

  const p = (async () => {
    try {
      const resorts = await src.fetch();
      const value = { source: src.name, fetchedAt: new Date().toISOString(), resorts };
      await writeCache(key, value);
      failedAt.delete(key);
      return { ...value, stale: false };
    } catch (err) {
      log.warn(`resorts: ${src.name} failed: ${err.message}`);
      failedAt.set(key, { at: Date.now(), error: err.message });
      if (cached) return { ...cached, stale: true, error: err.message };
      const resorts = await fallback(key);
      return { source: resorts.length ? `${src.name} unavailable — built-in list` : src.name, fetchedAt: null, resorts, stale: true, error: err.message };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** For tests. */
export const _resetResorts = () => {
  failedAt.clear();
  inflight.clear();
  seedMemo = null;
};

export async function getResorts() {
  const keys = Object.keys(SOURCES);
  const parts = await Promise.all(keys.map(getSource));
  const sources = {};
  keys.forEach((k, i) => {
    const p = parts[i];
    sources[k] = { name: p.source, fetchedAt: p.fetchedAt, count: p.resorts.length, stale: p.stale, ...(p.error ? { error: p.error } : {}) };
  });
  return { sources, inSeason: inSeason(), resorts: parts.flatMap((p) => p.resorts) };
}
