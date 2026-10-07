import { getJSON } from '../util/http.js';
import { log } from '../util/log.js';
import { shapeBulletin } from './slf.js';
import { alpineMicroRegionAt } from './eawsregions.js';

/**
 * Avalanche bulletins for Austria and Euregio (v6.2), from the European
 * Avalanche Warning Services' daily CAAMLv6 files, the same format as SLF's:
 *
 *   https://static.avalanche.report/eaws_bulletins/{YYYY-MM-DD}/{YYYY-MM-DD}-{AT-07}.json
 *   -> { bulletins: [ { bulletinID, publicationTime, validTime, lang: "en", regions[{regionID
 *        "AT-07-14", name}], dangerRatings[{mainValue, elevation, validTimePeriod}],
 *        avalancheProblems[…], avalancheActivity, snowpackStructure, tendency[], source.provider.name } ] }
 *
 * One file per state or province (AT-02 Carinthia … AT-08 Vorarlberg, IT-32-BZ
 * South Tyrol, IT-32-TN Trentino; AT-07 Tyrol); the folder listing and the
 * file contents were read on 7 Oct 2026 (a 1 March 2026 folder: 191 files,
 * `.json` is English, `.de.json` German …). Euregio's bulletin is made by
 * the three services of Tyrol, South Tyrol and Trentino; the files carry each
 * provider's name, which the page shows. A day's folder holds the bulletin
 * valid from 17:00 the evening before, so after 17:00 Vienna time tomorrow's
 * is tried first. No folder or file = no bulletin that day (outside the
 * season); other errors are shown as errors.
 *
 * A region in data/regions.json names its state in `eawsState`; the
 * micro-region is found from the region's point in the EAWS outlines
 * (eawsregions.js), or named outright in `eawsRegion`.
 */

const BASE = (process.env.EAWS_BULLETINS_URL || 'https://static.avalanche.report/eaws_bulletins').replace(/\/$/, '');
export const EUREGIO_PAGE = 'https://avalanche.report/';
// Tyrol, South Tyrol and Trentino make one bulletin and share border regions, so a point near
// the borders can lie in a neighbour's micro-region: the three files are always read together.
const EUREGIO = ['AT-07', 'IT-32-BZ', 'IT-32-TN'];

/** Local calendar date in Vienna, plus the hour. */
function viennaNow(now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/** The folders to look in, best first. */
export function candidateDays(now = new Date()) {
  const { day, hour } = viennaNow(now);
  return hour >= 17 ? [addDays(day, 1), day] : [day];
}

export const stateUrl = (day, state) => `${BASE}/${day}/${day}-${state}.json`;

/** One state's bulletins: { day, bulletins } with day null when there is none; throws on errors. */
async function fetchState(state, now) {
  for (const day of candidateDays(now)) {
    const body = await getJSON(stateUrl(day, state), { timeoutMs: 20000 });
    if (body === null) continue;
    if (!Array.isArray(body?.bulletins)) throw new Error(`eaws ${state}: unexpected response shape (no bulletins array)`);
    return { day, bulletins: body.bulletins };
  }
  return { day: null, bulletins: [] };
}

/**
 * The bulletins of several states as one set: { bulletins: [shaped], byMicro, names }.
 * A micro-region listed in more than one file belongs to the file of its own state.
 */
export function mergeStates(files) {
  const out = { bulletins: [], byMicro: {}, names: {} };
  const seen = new Map(); // bulletinID -> index
  for (const { state, bulletins } of files) {
    for (const b of bulletins) {
      const key = b.bulletinID ?? JSON.stringify(b.regions?.map((r) => r.regionID));
      let k = seen.get(key);
      if (k === undefined) k = seen.set(key, out.bulletins.push(shapeBulletin(b, 'eaws')) - 1).get(key);
      for (const r of b.regions ?? []) {
        if (!r?.regionID) continue;
        if (r.name && !out.names[r.regionID]) out.names[r.regionID] = r.name;
        if (out.byMicro[r.regionID] === undefined || r.regionID.startsWith(`${state}-`)) out.byMicro[r.regionID] = k;
      }
    }
  }
  return out;
}

/**
 * The bulletin for each Austrian or Euregio region, and every micro-region in the files:
 * { byRegion, all, states }.
 */
export async function fetchEawsFeed(regions, { now = new Date() } = {}) {
  const targets = regions.filter((r) => (r.country === 'AT' || r.country === 'IT') && r.eawsState);
  if (!targets.length) return { byRegion: {}, all: null, states: {} };
  let states = [...new Set(targets.map((r) => r.eawsState))];
  if (states.some((x) => EUREGIO.includes(x))) states = [...new Set([...states, ...EUREGIO])];
  const files = [];
  const status = {};
  await Promise.all(states.map(async (state) => {
    try {
      const f = await fetchState(state, now);
      files.push({ state, bulletins: f.bulletins });
      status[state] = { ok: true, day: f.day, bulletins: f.bulletins.length };
    } catch (err) {
      log.warn(`eaws bulletin ${state}: ${err.message}`);
      status[state] = { ok: false, error: err.message };
    }
  }));
  files.sort((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  const all = mergeStates(files);
  const byRegion = {};
  for (const region of targets) {
    const st = status[region.eawsState];
    if (!st.ok) {
      byRegion[region.id] = { source: 'eaws', error: st.error, danger: null };
      continue;
    }
    let micro = region.eawsRegion ?? null;
    if (!micro) micro = (await alpineMicroRegionAt(region.lat, region.lon, [region.eawsState]).catch(() => null))?.id ?? null;
    if (!micro) {
      byRegion[region.id] = { source: 'eaws', error: 'the micro-region outlines are not available, so the region at this point is not known yet', danger: null };
      continue;
    }
    const k = all.byMicro[micro];
    byRegion[region.id] = k !== undefined
      ? { ...all.bulletins[k], microRegion: micro, microName: all.names[micro] ?? null }
      : {
          source: 'eaws',
          assessed: false,
          danger: null,
          microRegion: micro,
          microName: all.names[micro] ?? null,
          // Outside the season the folders are empty; in season every micro-region is covered.
          outOfSeason: st.bulletins === 0,
          headline: st.bulletins === 0 ? 'No bulletin is published at the moment (outside the winter season).' : null,
          problems: [],
        };
  }
  return { byRegion, all: all.bulletins.length ? all : null, states: status };
}
