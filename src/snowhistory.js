import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getJSON } from './util/http.js';
import { latLonToUTM } from './util/utm.js';
import { slugify } from './util/gpx.js';
import { log } from './util/log.js';

/**
 * Snow depth through the winter at a tour: this season plus the five before,
 * 1 October – 30 June each, from NVE's seNorge model (the same grid cell the
 * snapshot samples). The browser draws it (public/snowhistory.js).
 *
 * gts.nve.no takes any date range, so past winters are one request each and
 * never change: they are cached for good. The current winter is refetched
 * after SEASON_TTL.
 *
 *   GET /api/snowhistory?tour=<name or slug>
 *   -> { tour, source, altitude, current: '2025-26', today, seasons: { '2020-21': { start, depth[] }, … } }
 */

const BASE = 'https://gts.nve.no/api/GridTimeSeries';
const NO_DATA = 65535;
const SEASON_TTL = 6 * 3600e3;
const YEARS = 5;

const cacheDir = (...p) => path.resolve(config.dataDir, 'cache', 'snowhist', ...p);

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

/** The winter a date belongs to: from 1 July on, the one that starts that autumn. */
export function seasonOf(date) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1;
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
const startYear = (key) => Number(key.slice(0, 4));

export function seasonUrl(tour, key, { today = new Date() } = {}) {
  const { x, y } = latLonToUTM(tour.lat, tour.lon);
  const from = `${startYear(key)}-10-01`;
  let to = `${startYear(key) + 1}-06-30`;
  const t = today.toISOString().slice(0, 10);
  if (t < to) to = t;
  return { url: `${BASE}/${x}/${y}/${from}/${to}/sd.json`, from, to };
}

export function shapeSeason(raw, from) {
  const noData = Number.isFinite(raw?.NoDataValue) ? raw.NoDataValue : NO_DATA;
  return {
    start: from,
    depth: (raw?.Data ?? []).map((v) => (v === noData || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)),
    altitude: Number.isFinite(raw?.Altitude) ? raw.Altitude : null,
  };
}

async function getSeason(tour, key, { today }) {
  const slug = slugify(tour.name);
  const file = cacheDir(`${slug}-${key}.json`);
  const cached = await readJson(file);
  const isCurrent = key === seasonOf(today);
  if (cached && (!isCurrent || Date.now() - cached.fetchedAt < SEASON_TTL)) return cached;
  const { url, from, to } = seasonUrl(tour, key, { today });
  if (to < from) return { start: from, depth: [], altitude: null, fetchedAt: Date.now() }; // the winter has not begun
  try {
    const value = { ...shapeSeason(await getJSON(url), from), fetchedAt: Date.now() };
    await writeJson(file, value);
    return value;
  } catch (err) {
    log.warn(`snowhistory: ${tour.name} ${key}: ${err.message}`);
    return cached ?? null;
  }
}

export async function getSnowHistory(tour, { today = new Date() } = {}) {
  const current = seasonOf(today);
  const keys = [];
  for (let k = YEARS; k >= 0; k--) {
    const s = startYear(current) - k;
    keys.push(`${s}-${String((s + 1) % 100).padStart(2, '0')}`);
  }
  const seasons = {};
  let altitude = null;
  // One season at a time: at most six small requests, and never a burst.
  for (const key of keys) {
    const s = await getSeason(tour, key, { today });
    if (s) {
      seasons[key] = { start: s.start, depth: s.depth };
      altitude ??= s.altitude;
    }
  }
  return {
    tour: tour.name,
    source: 'NVE seNorge (sd), daily at 06:00',
    altitude,
    current,
    today: today.toISOString().slice(0, 10),
    seasons,
  };
}
