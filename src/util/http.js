import { UA } from './ua.js';
import { log } from './log.js';


/**
 * fetch with a timeout, bounded retries and a polite user agent.
 *
 * Upstream here is a handful of small public services run by public agencies
 * (NVE, SMHI). They owe us nothing, so: identify ourselves, back off on
 * failure, never hammer, and treat every response as untrusted.
 */
export async function getJSON(url, { timeoutMs = 15000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 800 * 2 ** (attempt - 1) + Math.random() * 400;
      await sleep(backoff);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      });
      if (res.status === 404) return null; // a missing forecast is not an error
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      log.debug(`getJSON attempt ${attempt + 1} failed for ${url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`getJSON failed for ${url}: ${lastErr?.message ?? 'unknown'}`);
}

export async function getText(url, { timeoutMs = 15000, retries = 1, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html', ...headers },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`getText failed for ${url}: ${lastErr?.message ?? 'unknown'}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run tasks with a concurrency cap and never reject: every task resolves to
 * {ok, value} or {ok:false, error}. One dead upstream must not take down the
 * whole refresh.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: error.message ?? String(error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
