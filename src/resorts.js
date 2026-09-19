import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fetchFnugg } from './sources/fnugg.js';
import { fetchOsmResorts } from './sources/osm-resorts.js';
import { log } from './util/log.js';

/**
 * Ski resorts layer: Norway live from Fnugg, Sweden from OpenStreetMap
 * (location, name, website; no live status exists to fetch).
 *
 * Each source is cached on disk on its own schedule and fails on its own:
 * if Fnugg is down, the last good Norwegian list is served, marked stale,
 * and Sweden is unaffected. The endpoint takes no parameters, so it cannot
 * be used to make this box query anything on anyone's behalf.
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

const inflight = new Map();

async function getSource(key) {
  const src = SOURCES[key];
  const cached = await readCache(key);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < src.ttl()) return { ...cached, stale: false };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const resorts = await src.fetch();
      const value = { source: src.name, fetchedAt: new Date().toISOString(), resorts };
      await writeCache(key, value);
      return { ...value, stale: false };
    } catch (err) {
      log.warn(`resorts: ${src.name} failed: ${err.message}`);
      if (cached) return { ...cached, stale: true, error: err.message };
      return { source: src.name, fetchedAt: null, resorts: [], stale: true, error: err.message };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

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
