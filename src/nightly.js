import { getResorts } from './resorts.js';
import { refreshResortMap, resortMapMeta, storedResortMaps, resortMapKey, RESORT_MAP_MAX_AGE_DAYS } from './resortmap.js';
import { appVersion } from './util/appversion.js';
import { getSnowHistory } from './snowhistory.js';
import { overpassCooling } from './util/overpass.js';
import { log } from './util/log.js';

/**
 * The night scan: while the house sleeps, go through every ski resort and
 * store its ski-area map (lifts, runs, facts, terrain) and its snow history,
 * so a click in the day is instant. A map older than RESORT_MAP_MAX_AGE_DAYS
 * (90) is fetched again; the rest are left alone.
 *
 *   NIGHT_SCAN=off             turn it off
 *   NIGHT_SCAN_HOURS=1-5       the window, Norwegian time (start-end hour)
 *   NIGHT_SCAN_GAP_S=60        pause between resorts, to be kind to OpenStreetMap
 *
 * Missing maps go first, then the oldest. Everything goes to OpenStreetMap
 * at the lowest priority, so a click in the app still goes first. If
 * OpenStreetMap is failing the scan pauses until it recovers or the night ends.
 */

const ON = !/^(off|false|0|no)$/i.test(process.env.NIGHT_SCAN ?? 'on');
const [FROM, TO] = String(process.env.NIGHT_SCAN_HOURS ?? '1-5').split('-').map(Number);
const GAP_MS = Number(process.env.NIGHT_SCAN_GAP_S ?? 60) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: 'numeric', hourCycle: 'h23' });
export const osloHour = (d = new Date()) => Number(hourFmt.format(d));
/** Inside the window [from, to) in Norwegian time; a window may cross midnight (22-4). */
export function inWindow(h, from = FROM, to = TO) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const status = { running: false, lastRun: null, lastDone: 0, lastFailed: 0, lastStoppedBecause: null, current: null };

/**
 * Which resorts need a visit, in order: never fetched first, then the oldest.
 * After an upgrade every map is refetched once, because a new version usually
 * reads OpenStreetMap differently (more lift types, a wider search).
 */
export async function scanOrder(resorts, metaOf, maxAgeDays = RESORT_MAP_MAX_AGE_DAYS, version = null) {
  const due = [];
  for (const r of resorts) {
    const { age, app } = await metaOf(r.id);
    if (age >= maxAgeDays * 86400e3 || (version && app !== version)) due.push({ r, age });
  }
  return due.sort((a, b) => b.age - a.age).map((x) => x.r);
}

/** One pass. `until()` says when to stop (end of the window). */
export async function nightScan({ until = () => !inWindow(osloHour()), gapMs = GAP_MS } = {}) {
  if (status.running) return status;
  status.running = true;
  status.lastRun = new Date().toISOString();
  status.lastDone = status.lastFailed = 0;
  status.lastStoppedBecause = null;
  try {
    const resorts = (await getResorts())?.resorts ?? [];
    const version = await appVersion();
    const todo = await scanOrder(resorts, resortMapMeta, RESORT_MAP_MAX_AGE_DAYS, version);
    log.info(`night scan: ${todo.length} of ${resorts.length} ski-area maps to fetch or refresh`);
    for (const r of todo) {
      if (until()) {
        status.lastStoppedBecause = 'morning';
        break;
      }
      // OpenStreetMap failing: wait for it rather than piling on.
      while (overpassCooling() && !until()) await sleep(Math.min(gapMs * 5, 5 * 60e3) || 10);
      if (until()) {
        status.lastStoppedBecause = 'morning (OpenStreetMap was unavailable)';
        break;
      }
      status.current = r.name;
      try {
        const m = await refreshResortMap(r);
        if (m.stale) throw new Error(m.error);
        status.lastDone++;
        // The snow history of past winters is kept for good once fetched.
        await getSnowHistory({ name: `resort ${r.id}`, lat: r.lat, lon: r.lon }).catch(() => {});
      } catch (err) {
        status.lastFailed++;
        log.warn(`night scan: ${r.name}: ${err.message}`);
      }
      await sleep(gapMs);
    }
    if (!status.lastStoppedBecause) status.lastStoppedBecause = 'all done';
    log.info(`night scan: ${status.lastDone} stored, ${status.lastFailed} failed (${status.lastStoppedBecause})`);
  } catch (err) {
    status.lastStoppedBecause = `error: ${err.message}`;
    log.warn(`night scan: ${err.message}`);
  } finally {
    status.running = false;
    status.current = null;
  }
  return status;
}

/** For /api/version and the Data sources card. */
export async function nightScanStatus() {
  // Never hold up the version card for the resort list.
  const resorts = (await Promise.race([getResorts().catch(() => null), sleep(2000).then(() => null)]))?.resorts ?? [];
  const stored = await storedResortMaps();
  const now = Date.now();
  const ages = resorts.map((r) => stored.get(resortMapKey(r.id))).filter(Boolean).map((t) => (now - t) / 86400e3);
  const version = await appVersion();
  return {
    enabled: ON,
    window: `${String(FROM).padStart(2, '0')}:00–${String(TO).padStart(2, '0')}:00`,
    resorts: resorts.length,
    stored: ages.length,
    due: resorts.length - ages.filter((d) => d < RESORT_MAP_MAX_AGE_DAYS).length,
    oldestDays: ages.length ? Math.floor(Math.max(...ages)) : null,
    maxAgeDays: RESORT_MAP_MAX_AGE_DAYS,
    version,
    ...status,
  };
}

/** Check every 10 minutes whether it is night and there is work. */
export function startNightScan() {
  if (!ON) {
    log.info('night scan: off (NIGHT_SCAN=off)');
    return () => {};
  }
  const check = () => {
    if (inWindow(osloHour()) && !status.running) nightScan().catch(() => {});
  };
  const timer = setInterval(check, 10 * 60e3);
  timer.unref?.();
  setTimeout(check, 90e3).unref?.();
  log.info(`night scan: ski-area maps between ${FROM}:00 and ${TO}:00 Norwegian time, refreshed after ${RESORT_MAP_MAX_AGE_DAYS} days`);
  return () => clearInterval(timer);
}
