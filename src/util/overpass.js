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
// After every instance has failed, background work (route warm-up, huts,
// the Swedish resort list) waits this long before asking again. A click
// in the app still tries at once.
const COOL_MS = Number(process.env.OVERPASS_COOL_MS ?? 10 * 60e3);

/**
 * Priorities: 'high' = someone is waiting in the app (a ski-area map);
 * 'normal' = a click that can wait a little (a tour's route);
 * 'low' = background (warm-up, huts list, resort list).
 * Higher goes first; equal priorities keep their order.
 */
const RANK = { high: 2, normal: 1, low: 0 };

const restUntil = new Map(); // host -> timestamp
const jobs = [];
let running = null; // the job in progress
let lastAt = 0;
let coolUntil = 0;
let lastError = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the queue is doing, for /api/overpass and error messages. */
export function overpassStatus() {
  const now = Date.now();
  return {
    queued: jobs.length,
    queue: jobs.map((j) => ({ what: j.what, priority: j.priority, waitingS: Math.round((now - j.at) / 1000) })),
    running: running ? { what: running.what, priority: running.priority, forS: Math.round((now - running.startedAt) / 1000) } : null,
    coolingS: coolUntil > now ? Math.round((coolUntil - now) / 1000) : 0,
    resting: [...restUntil].filter(([, t]) => t > now).map(([h, t]) => ({ host: h, forS: Math.round((t - now) / 1000) })),
    lastError,
  };
}

export const overpassCooling = () => coolUntil > Date.now();

function enqueue(job) {
  return new Promise((resolve, reject) => {
    Object.assign(job, { resolve, reject, at: Date.now() });
    const i = jobs.findIndex((j) => RANK[j.priority] < RANK[job.priority]);
    if (i < 0) jobs.push(job);
    else jobs.splice(i, 0, job);
    if (job.deadline) {
      job.timer = setTimeout(() => {
        const k = jobs.indexOf(job);
        if (k < 0) return; // already running; its attempts watch the deadline
        jobs.splice(k, 1);
        const ahead = running ? ` (busy with ${running.what} for ${Math.round((Date.now() - running.startedAt) / 1000)} s)` : '';
        reject(new Error(`OpenStreetMap (Overpass) is busy: waited ${Math.round((Date.now() - job.at) / 1000)} s in line${ahead}`));
      }, Math.max(0, job.deadline - Date.now()));
      job.timer.unref?.();
    }
    pump();
  });
}

async function pump() {
  if (running || !jobs.length) return;
  const job = jobs.shift();
  running = job;
  clearTimeout(job.timer);
  try {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    job.startedAt = Date.now();
    job.resolve(await job.run(job));
  } catch (err) {
    job.reject(err);
  } finally {
    lastAt = Date.now();
    running = null;
    pump();
  }
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

/**
 * Run an Overpass query. `priority` as above; `deadlineMs` bounds the whole
 * thing, waiting in line included (for requests someone is watching).
 */
export function overpass(query, { timeoutMs = 120000, what = 'overpass', priority = 'normal', deadlineMs = null } = {}) {
  if (priority === 'low' && overpassCooling()) {
    return Promise.reject(new Error(`OpenStreetMap (Overpass) is resting after failures for ${Math.round((coolUntil - Date.now()) / 1000)} s more (last: ${lastError ?? 'unknown'})`));
  }
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;
  const left = () => (deadline ? deadline - Date.now() : Infinity);
  return enqueue({
    what,
    priority,
    deadline,
    run: async () => {
      let last = null;
      const now = Date.now();
      // Rested instances go last rather than being skipped: better a slow answer than none.
      const order = [...OVERPASS_URLS].sort((a, b) => (restUntil.get(new URL(a).host) > now) - (restUntil.get(new URL(b).host) > now));
      for (const url of order) {
        const host = new URL(url).host;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (left() < 3000) {
            last = last ?? new Error('no time left');
            throw new Error(`OpenStreetMap (Overpass) did not answer in time: ${last.message}`);
          }
          try {
            const res = await once(url, query, Math.min(timeoutMs, left()));
            if ([429, 503, 504].includes(res.status) && attempt === 0) {
              const ra = Number(res.headers.get('retry-after'));
              const wait = Math.min(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : RETRY_MS, left() - 5000);
              if (wait <= 0) throw new Error(`HTTP ${res.status}`);
              log.warn(`${what}: ${host} answered ${res.status}; waiting ${Math.round(wait / 1000)} s`);
              await sleep(wait);
              continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (!Array.isArray(body?.elements)) throw new Error('no elements array');
            if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(body.remark.slice(0, 120));
            restUntil.delete(host);
            coolUntil = 0;
            return body.elements;
          } catch (err) {
            // Node's fetch says only "fetch failed"; the reason is in err.cause.
            const why = err.cause ? `${err.cause.code ?? ''} ${err.cause.message ?? ''}`.trim() : '';
            const msg = err.name === 'TimeoutError' ? `no answer in ${Math.round(Math.min(timeoutMs, left()) / 1000)} s` : err.message;
            last = new Error(`${host}: ${msg}${why ? ` (${why})` : ''}`);
            restUntil.set(host, Date.now() + REST_MS);
            log.warn(`${what}: ${last.message}; trying the next Overpass instance`);
            break;
          }
        }
        if (!last) last = new Error(`${host}: still busy after waiting`);
        restUntil.set(host, Date.now() + REST_MS);
      }
      lastError = last?.message ?? 'no instance answered';
      coolUntil = Date.now() + COOL_MS;
      throw new Error(`OpenStreetMap (Overpass) unavailable: ${lastError}`);
    },
  });
}

/** For tests. */
export function _resetOverpass() {
  restUntil.clear();
  jobs.length = 0;
  running = null;
  lastAt = 0;
  coolUntil = 0;
  lastError = null;
}
