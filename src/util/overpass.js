import { UA } from './ua.js';
import { log } from './log.js';

/**
 * Every Overpass request in the app goes through here: route discovery,
 * ski-area maps, the huts layer and the Swedish resort list.
 *
 * Overpass instances are shared and strict: overpass-api.de allows a couple
 * of requests at a time per address, answers 429 when that is exceeded, and
 * may refuse connections outright for a while from an address that keeps
 * trying. So:
 *   - one request at a time, app-wide, at least MIN_GAP_MS apart;
 *   - 429 / 503 / 504: wait (Retry-After, else RETRY_MS) and try once more,
 *     then move on to the next instance;
 *   - an instance that refuses or keeps failing is rested for REST_MS;
 *   - the other public instances run the same software on the same data.
 * OVERPASS_URL, if set, is tried first.
 */
export const OVERPASS_URLS = [
  ...(process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter((u, i, a) => a.indexOf(u) === i);

// Under the test runner there is nothing to be polite to (every request is stubbed).
const TESTING = Boolean(process.env.NODE_TEST_CONTEXT);
const MIN_GAP_MS = Number(process.env.OVERPASS_GAP_MS ?? (TESTING ? 0 : 3000));
const RETRY_MS = Number(process.env.OVERPASS_RETRY_MS ?? (TESTING ? 10 : 15000));
const REST_MS = 30 * 60e3;

const restUntil = new Map(); // host -> timestamp
let queue = Promise.resolve();
let lastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn with Overpass to ourselves: one at a time, spaced out. */
function serial(fn) {
  const run = queue.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function once(url, query, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export function overpass(query, { timeoutMs = 120000, what = 'overpass' } = {}) {
  return serial(async () => {
    let last = null;
    const now = Date.now();
    // Rested instances go last rather than being skipped: better a slow answer than none.
    const order = [...OVERPASS_URLS].sort((a, b) => (restUntil.get(new URL(a).host) > now) - (restUntil.get(new URL(b).host) > now));
    for (const url of order) {
      const host = new URL(url).host;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await once(url, query, timeoutMs);
          if ([429, 503, 504].includes(res.status) && attempt === 0) {
            const ra = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : RETRY_MS;
            log.warn(`${what}: ${host} answered ${res.status}; waiting ${Math.round(wait / 1000)} s`);
            await sleep(wait);
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body?.elements)) throw new Error('no elements array');
          if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(body.remark.slice(0, 120));
          restUntil.delete(host);
          return body.elements;
        } catch (err) {
          // Node's fetch says only "fetch failed"; the reason is in err.cause.
          const why = err.cause ? `${err.cause.code ?? ''} ${err.cause.message ?? ''}`.trim() : '';
          last = new Error(`${host}: ${err.message}${why ? ` (${why})` : ''}`);
          restUntil.set(host, Date.now() + REST_MS);
          log.warn(`${what}: ${last.message}; trying the next Overpass instance`);
          break;
        }
      }
      if (!last) last = new Error(`${host}: still busy after waiting`);
      restUntil.set(host, Date.now() + REST_MS);
    }
    throw new Error(`OpenStreetMap (Overpass) unavailable: ${last?.message ?? 'no instance answered'}`);
  });
}

/** For tests. */
export function _resetOverpass() {
  restUntil.clear();
  queue = Promise.resolve();
  lastAt = 0;
}
