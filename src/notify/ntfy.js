import { config } from '../config.js';
import { log } from '../util/log.js';

/**
 * Push via ntfy (https://ntfy.sh or a self-hosted instance).
 *
 * Note on privacy: on the public ntfy.sh, a topic name is the only secret.
 * Anyone who guesses it can read your alerts and publish to them. Use a long
 * random topic, or self-host. The README says this too.
 */
export async function sendNtfy({ title, body, tags = [], priority = 3, click } = {}) {
  if (!config.ntfyTopic) return { sent: false, reason: 'NTFY_TOPIC not set' };

  const url = `${config.ntfyServer}/${encodeURIComponent(config.ntfyTopic)}`;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: asciiHeader(title),
    Priority: String(priority),
  };
  if (tags.length) headers.Tags = tags.join(',');
  if (click) headers.Click = click;
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    log.info(`ntfy: pushed to ${config.ntfyTopic}`);
    return { sent: true };
  } catch (err) {
    log.warn(`ntfy: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/**
 * ntfy sends headers as latin-1; Norwegian and Swedish place names break it.
 * Transliterate rather than mangle - "Sunnmore" beats "Sunnm?re".
 */
export function asciiHeader(s = '') {
  const map = {
    æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', å: 'a', Å: 'A',
    ä: 'a', Ä: 'A', ö: 'o', Ö: 'O', é: 'e', É: 'E',
    è: 'e', ê: 'e', ü: 'u', Ü: 'U',
    '—': '-', '–': '-', '·': '-', '’': "'", '“': '"', '”': '"',
  };
  return s
    .replace(/[æÆøØåÅäÄöÖéÉèêüÜ—–·’“”]/g, (c) => map[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
