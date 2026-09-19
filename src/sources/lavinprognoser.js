import { getText, mapLimit } from '../util/http.js';
import { log } from '../util/log.js';

/**
 * Swedish avalanche bulletins from Naturvårdsverket's lavinprognoser.se.
 *
 * IMPORTANT, READ BEFORE TRUSTING THIS MODULE
 * -------------------------------------------
 * Sweden publishes no API. There is no JSON endpoint, no CAAML feed and no
 * embedded JSON on the page - only server-rendered HTML. So this is a
 * scraper, and scrapers rot.
 *
 * It was written out of season (September), when every Swedish region reads
 * "Ej bedömd / Risk 0" and the next season does not open until 11 December
 * 2026. That means the in-season markup - an actual danger level, the
 * problem list, the observation summary - has NOT been observed. The
 * selectors below are derived from the out-of-season page plus the
 * documented structure, and they are deliberately loose.
 *
 * Consequences, by design:
 *  - Every field is optional. A parse miss yields null, never a guess.
 *  - `confidence` is reported alongside the value so the UI can say
 *    "couldn't read this" instead of quietly showing a wrong number.
 *  - A null Swedish danger level NEVER suppresses or downgrades an alert.
 *    The UI links to the bulletin and says to read it.
 *
 * First run of the Swedish season, check one region against the website and
 * fix the patterns here if they have drifted. That is a five-minute job and
 * it is the price of a country without an API.
 */

const BASE = 'https://www.lavinprognoser.se/oversikt-alla-omraden';

/** Swedish danger names on the EAWS 1-5 scale, lowercase for matching. */
const DANGER_WORDS = [
  [1, 'liten'],
  [2, 'måttlig'],
  [3, 'betydande'],
  [4, 'stor'],
  [5, 'mycket stor'],
];

export function regionUrl(region) {
  return `${BASE}/${region.slug}/`;
}

export async function fetchSwedishBulletins(regions) {
  const targets = regions.filter((r) => r.country === 'SE' && r.slug);

  const results = await mapLimit(targets, 2, async (region) => {
    const html = await getText(regionUrl(region));
    return { region, html };
  });

  const out = {};
  results.forEach((res, i) => {
    const region = targets[i];
    if (!res.ok || !res.value?.html) {
      log.warn(`lavinprognoser: ${region.id} failed: ${res.error ?? 'empty'}`);
      out[region.id] = {
        source: 'lavinprognoser',
        error: res.error ?? 'no response',
        confidence: 'none',
        danger: null,
      };
      return;
    }
    out[region.id] = parseSwedishPage(res.value.html, region);
  });
  return out;
}

/**
 * Exported for testing. Pure function: HTML in, shaped bulletin out.
 */
export function parseSwedishPage(html, region = {}) {
  const text = stripTags(html);
  const lower = text.toLowerCase();

  const seasonOver =
    /prognossäsongen är avslutad/i.test(text) || /säsongen är slut/i.test(text);
  const notAssessed = /ej bedömd/i.test(text);

  const danger = readDanger(html, lower);

  // Confidence is about whether we could READ the page, not about the snowpack.
  let confidence = 'none';
  if (danger !== null) confidence = 'parsed';
  else if (seasonOver || notAssessed) confidence = 'explicit-none';

  return {
    source: 'lavinprognoser',
    scraped: true,
    url: regionUrl(region),
    assessed: danger !== null,
    danger,
    seasonOver,
    notAssessed,
    confidence,
    headline: readHeadline(text),
    publishedText: readPublished(text),
    // Deliberately NOT parsed: avalanche problems and observation summaries.
    // Their in-season markup is unknown, and half-read safety information is
    // worse than a link to the real thing.
    problems: [],
    note:
      confidence === 'parsed'
        ? null
        : 'Swedish bulletins are read from the public web page; open the bulletin for the full picture.',
  };
}

function readDanger(html, lowerText) {
  // The page renders the level as an icon with an accessible label such as
  // "Risk 3" / alt="...lavinskalan...3..." plus the Swedish danger word.
  const iconMatch = html.match(/Risk\s*([0-5])\b/i);
  if (iconMatch) {
    const n = Number(iconMatch[1]);
    if (n >= 1 && n <= 5) return n;
    if (n === 0) return null; // 0 = not assessed
  }

  // Fall back to the written danger name, longest first so "mycket stor"
  // is not matched as "stor".
  for (const [level, word] of [...DANGER_WORDS].sort((a, b) => b[1].length - a[1].length)) {
    const re = new RegExp(`\\b${word}\\s+lavinfara\\b`, 'i');
    if (re.test(lowerText)) return level;
  }
  return null;
}

function readHeadline(text) {
  const m = text.match(/Huvudbudskap[:\s]+([^\n]{10,400})/i);
  return m ? collapse(m[1]) : null;
}

function readPublished(text) {
  const m = text.match(/Publicerad[:\s]+([^\n]{4,60})/i);
  return m ? collapse(m[1]) : null;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&aring;/g, 'å')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
