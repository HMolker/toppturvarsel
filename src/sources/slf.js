import { getJSON } from '../util/http.js';
import { log } from '../util/log.js';

/**
 * Swiss avalanche bulletins from the WSL Institute for Snow and Avalanche
 * Research SLF (v6), in the EAWS CAAMLv6 JSON format:
 *
 *   https://aws.slf.ch/api/bulletin/caaml/{de,fr,it,en}/json
 *   -> { bulletins: [ { bulletinID, publicationTime, validTime{startTime,endTime},
 *        nextUpdate, lang, unscheduled, regions[{regionID, name}],
 *        dangerRatings[{mainValue, validTimePeriod, elevation?, customData.CH.subdivision}],
 *        avalancheProblems[{problemType, dangerRatingValue, elevation{lowerBound, upperBound},
 *          aspects[], validTimePeriod, comment, customData.CH.coreZoneText}], … } ] }
 *
 * Shape checked against the live API on 30 Sep 2026 (a February 2026
 * bulletin via ?activeAt=): one bulletin covers many of SLF's ~150 micro-
 * regions ("CH-4222" Zermatt), and the list is empty out of season.
 *
 * A region in data/regions.json names its micro-region in `slfRegion`.
 * Data © SLF, CC BY 4.0 — credit "WSL Institute for Snow and Avalanche
 * Research SLF" and link slf.ch; do not strip it from the page.
 */

const BASE = process.env.SLF_BULLETIN_URL || 'https://aws.slf.ch/api/bulletin/caaml';
export const SLF_PAGE = 'https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/';

const LEVEL = { low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5 };
const SUB = { plus: '+', minus: '−', neutral: '=' };

/** CAAML problem types, in the words the page's problem icons know (public/avalanche.js). */
const PROBLEM_NAME = {
  new_snow: 'New snow',
  wind_slab: 'Wind slab',
  persistent_weak_layers: 'Persistent weak layers',
  wet_snow: 'Wet snow',
  gliding_snow: 'Gliding snow',
  cornices: 'Cornices',
  no_distinct_avalanche_problem: 'No distinct avalanche problem',
  favourable_situation: 'No distinct avalanche problem (favourable situation)',
};
const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export async function fetchSwissBulletins(regions, { lang = 'en' } = {}) {
  const targets = regions.filter((r) => r.country === 'CH' && r.slfRegion);
  if (!targets.length) return {};
  let body;
  try {
    body = await getJSON(`${BASE}/${lang}/json`, { timeoutMs: 20000 });
  } catch (err) {
    log.warn(`slf: bulletin failed: ${err.message}`);
    return Object.fromEntries(targets.map((r) => [r.id, { source: 'slf', error: err.message, danger: null }]));
  }
  return shapeSwiss(body, targets);
}

/** Pure: the API's body and our regions in, one bulletin per region out. */
export function shapeSwiss(body, targets) {
  const list = Array.isArray(body?.bulletins) ? body.bulletins : null;
  if (!list) throw new Error('slf: unexpected response shape (no bulletins array)');
  const byMicro = new Map();
  for (const b of list) for (const r of b.regions ?? []) if (r?.regionID) byMicro.set(r.regionID, b);
  const out = {};
  for (const region of targets) {
    const b = byMicro.get(region.slfRegion);
    out[region.id] = b
      ? shapeBulletin(b)
      : {
          source: 'slf',
          assessed: false,
          danger: null,
          // Out of season SLF publishes nothing at all; in season every micro-region is covered.
          outOfSeason: list.length === 0,
          headline: list.length === 0 ? 'SLF publishes no bulletin at the moment (outside the winter season).' : null,
          problems: [],
        };
  }
  return out;
}

const level = (v) => LEVEL[String(v ?? '').toLowerCase()] ?? null;
const bound = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; // "treeline" -> null
};
const clean = (s) =>
  typeof s === 'string'
    ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim() || null
    : null;

/** CAAML aspects (["N","NE"…]) -> the 8-digit string the page draws ("11000000"). */
export function aspectBits(list) {
  if (!Array.isArray(list) || !list.length) return '11111111';
  const on = new Set(list.map((a) => String(a).toUpperCase()));
  return ASPECTS.map((a) => (on.has(a) ? '1' : '0')).join('');
}

/**
 * CAAML elevation -> Varsom's height code (public/planner.js problemBands):
 * 1 = above h1, 2 = below h1, 4 = between h1 and h2, null = all elevations.
 */
export function heightBand(el) {
  const lo = bound(el?.lowerBound), hi = bound(el?.upperBound);
  if (lo !== null && hi !== null) return { fill: 4, h1: lo, h2: hi };
  if (lo !== null) return { fill: 1, h1: lo, h2: lo };
  if (hi !== null) return { fill: 2, h1: hi, h2: hi };
  return null;
}

export function shapeBulletin(b) {
  const ratings = (b.dangerRatings ?? []).map((r) => ({
    danger: level(r.mainValue),
    sub: SUB[r.customData?.CH?.subdivision] ?? null,
    period: r.validTimePeriod ?? 'all_day',
    heights: heightBand(r.elevation),
  }));
  // The headline level is the highest the bulletin gives anywhere or at any
  // time of day (spring bulletins give a lower morning and a higher afternoon).
  const top = ratings.filter((r) => r.danger).sort((a, c) => c.danger - a.danger)[0] ?? null;
  const problems = (b.avalancheProblems ?? []).map((p) => {
    const name = PROBLEM_NAME[p.problemType] ?? String(p.problemType ?? 'avalanche problem').replace(/_/g, ' ');
    return {
      type: name,
      problemType: name,
      probability: p.frequency ? String(p.frequency) : null,
      size: Number.isFinite(Number(p.avalancheSize)) ? `size ${p.avalancheSize}` : null,
      danger: level(p.dangerRatingValue),
      aspects: aspectBits(p.aspects),
      heights: heightBand(p.elevation),
      period: p.validTimePeriod ?? 'all_day',
    };
  });
  const core = (b.avalancheProblems ?? []).map((p) => p.customData?.CH?.coreZoneText).find(Boolean) ?? null;
  // SLF repeats one danger description under every problem; show it once.
  const described = [...new Set((b.avalancheProblems ?? []).map((p) => clean(p.comment)).filter(Boolean))];
  return {
    source: 'slf',
    assessed: top !== null,
    danger: top?.danger ?? null,
    dangerSub: top?.sub ?? null,
    dangerRatings: ratings,
    validFrom: b.validTime?.startTime ?? null,
    validTo: b.validTime?.endTime ?? null,
    publishTime: b.publicationTime ?? null,
    nextWarning: b.nextUpdate ?? null,
    unscheduled: !!b.unscheduled,
    headline: clean(b.avalancheActivity?.highlights) ?? clean(b.highlights) ?? clean(core),
    description: described.join('\n\n') || clean(b.avalancheActivity?.comment),
    weakLayers: clean(b.snowpackStructure?.comment),
    advice: [clean(b.travelAdvisory?.comment)].filter(Boolean),
    problems,
    outlook: [],
  };
}
