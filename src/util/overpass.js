import { log } from './log.js';

/**
 * POST a query to Overpass, trying the next public instance when one is busy.
 *
 * The main instance (overpass-api.de) answers 429 "too many requests" or 504
 * "gateway timeout" at busy times; a big query from a small box then simply
 * fails. The other public instances run the same software on the same data,
 * so the query is retried there. OVERPASS_URL, if set, is tried first.
 */
export const OVERPASS_URLS = [
  ...(process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter((u, i, a) => a.indexOf(u) === i);

export async function overpass(query, { timeoutMs = 120000, what = 'overpass' } = {}) {
  let last = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'toppturvarsel/1.0 (self-hosted ski touring dashboard)',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      const body = await res.json();
      if (!Array.isArray(body?.elements)) throw new Error(`no elements array from ${new URL(url).host}`);
      // Overpass reports a query that ran out of time as a "remark" with partial data.
      if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(`${new URL(url).host}: ${body.remark.slice(0, 120)}`);
      return body.elements;
    } catch (err) {
      // Node's fetch says only "fetch failed"; the reason (DNS, refused,
      // connect timeout, certificate) is in err.cause.
      const why = err.cause ? `${err.cause.code ?? ''} ${err.cause.message ?? ''}`.trim() : '';
      last = new Error(`${new URL(url).host}: ${err.message}${why ? ` (${why})` : ''}`);
      log.warn(`${what}: ${last.message}; trying the next Overpass instance`);
    }
  }
  throw new Error(`Overpass unavailable: ${last?.message ?? 'no instance answered'}`);
}
