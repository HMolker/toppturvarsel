import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { searchKartverket, searchNominatim } from './sources/places.js';
import { log } from './util/log.js';

/**
 * Place search (v5.6) and the places it adds to the service area.
 *
 * Searching costs no heights and no map tiles: it only asks the two
 * place-name registers (Norway, Sweden) and keeps their answers 30 days.
 *
 * Choosing a result ("pick") makes the 12 km around it part of the service
 * area, like a listed tour, so Plan a tour can be used there. Only a place
 * this server itself found can be picked, so the area can only grow by
 * named places in Norway and Sweden, never by arbitrary coordinates — the
 * tile and height endpoints stay closed to the rest of the world. At most
 * PLACES_DAILY new places a day and PLACES_MAX in all (oldest dropped).
 */

const TTL = 30 * 86400e3;
const dir = () => path.resolve(config.dataDir, 'cache', 'places');
const zonesFile = () => path.resolve(config.dataDir, 'cache', 'places-zones.json');
const DAILY = () => Math.max(1, Number(process.env.PLACES_DAILY) || 30);
const MAX = () => Math.max(10, Number(process.env.PLACES_MAX) || 300);

/** Places seen in search answers, by id: what may be picked. */
const known = new Map();
const KNOWN_MAX = 5000;
const remember = (list) => {
  for (const p of list) {
    known.delete(p.id);
    known.set(p.id, p);
  }
  while (known.size > KNOWN_MAX) known.delete(known.keys().next().value);
};

export const normQuery = (q) => String(q ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 80);
const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Mountains and the like first: this is a ski touring map.
const TERRAIN_KINDS = /fjell|topp|tind|egg|høgd|hei|nut|bre|dal|fjellområde|peak|mountain|ridge|glacier|valley|fell|hill|saddle|volcano/i;

function rank(q, list) {
  const f = fold(q);
  const score = (p) => {
    const n = fold(p.name);
    return (n === f ? 0 : n.startsWith(f) ? 1 : 2) * 2 + (TERRAIN_KINDS.test(p.kind ?? '') ? 0 : 1);
  };
  const seen = new Set();
  return list
    .map((p, i) => ({ p, s: score(p), i }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.p)
    .filter((p) => {
      // The same name within ~1 km is the same place (a peak listed twice).
      const k = `${fold(p.name)}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 12);
}

const memo = new Map();

/** Search both registers; answers kept 30 days. `country`: 'NO', 'SE' or both. */
export async function searchPlaces(q, { country = null } = {}) {
  const query = normQuery(q);
  if (query.length < 2) {
    const err = new Error('type at least two letters');
    err.status = 400;
    throw err;
  }
  const key = createHash('sha1').update(fold(query)).digest('hex').slice(0, 20);
  let cached = memo.get(key);
  if (!cached) {
    try {
      const body = JSON.parse(await readFile(path.join(dir(), `${key}.json`), 'utf8'));
      if (Date.now() - new Date(body.fetchedAt).getTime() < TTL) cached = body;
    } catch {
      /* not cached */
    }
  }
  if (!cached) {
    const [no, se] = await Promise.allSettled([searchKartverket(query), searchNominatim(query)]);
    const errors = [no, se].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    if (errors.length === 2) {
      const err = new Error(`place search unavailable: ${errors.join('; ')}`);
      err.status = 502;
      throw err;
    }
    const places = rank(query, [...(no.value ?? []), ...(se.value ?? [])]);
    cached = { query, fetchedAt: new Date().toISOString(), places, ...(errors.length ? { partial: errors[0] } : {}) };
    // A partial answer (one register down) is not kept on disk: next time may be whole.
    if (!errors.length) {
      await mkdir(dir(), { recursive: true });
      const f = path.join(dir(), `${key}.json`);
      await writeFile(`${f}.tmp`, JSON.stringify(cached));
      await rename(`${f}.tmp`, f);
    } else log.warn(`places: ${errors[0]}`);
  }
  if (!cached.partial) memo.set(key, cached);
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  remember(cached.places);
  const places = country ? cached.places.filter((p) => p.country === country) : cached.places;
  return { query: cached.query, places, ...(cached.partial ? { partial: cached.partial } : {}) };
}

/* ------------------------------------------------------------------ *
 * picked places: part of the service area
 * ------------------------------------------------------------------ */

let zones = null;
let changed = 0;

async function loadZones() {
  if (zones) return zones;
  try {
    const body = JSON.parse(await readFile(zonesFile(), 'utf8'));
    zones = Array.isArray(body.zones) ? body.zones.filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lon)) : [];
  } catch {
    zones = [];
  }
  return zones;
}

/** The picked places, for the service area: [{ id, name, lat, lon, country, at }]. */
export async function placeZones() {
  return loadZones();
}
/** Bumped whenever the list changes, so the tile check can refresh its boxes. */
export const placeZonesVersion = () => changed;

export async function pickPlace(id) {
  const place = known.get(String(id ?? ''));
  if (!place) {
    const err = new Error('unknown place: search for it first');
    err.status = 404;
    throw err;
  }
  const list = await loadZones();
  const had = list.find((z) => z.id === place.id);
  if (had) {
    had.at = new Date().toISOString();
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const newToday = list.filter((z) => z.added?.slice(0, 10) === today).length;
    if (newToday >= DAILY()) {
      const err = new Error(`${DAILY()} new places have been added today, the most allowed; try again tomorrow`);
      err.status = 429;
      throw err;
    }
    const now = new Date().toISOString();
    list.push({ id: place.id, name: place.name, kind: place.kind, area: place.area, country: place.country, lat: place.lat, lon: place.lon, added: now, at: now });
    // Over the cap: drop the ones used longest ago.
    if (list.length > MAX()) {
      list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      list.length = MAX();
    }
  }
  changed++;
  await mkdir(path.dirname(zonesFile()), { recursive: true });
  await writeFile(`${zonesFile()}.tmp`, JSON.stringify({ zones: list }));
  await rename(`${zonesFile()}.tmp`, zonesFile());
  return list.find((z) => z.id === place.id);
}

/** For tests. */
export function _resetPlaces() {
  known.clear();
  memo.clear();
  zones = null;
  changed++;
}
