import { readFile } from 'node:fs/promises';

const str = (k, d = '') => (process.env[k] ?? d).trim();
const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d) => {
  const v = str(k, String(d)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};
const list = (k) =>
  str(k)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  refreshMinutes: Math.max(30, num('REFRESH_MINUTES', 180)),
  seasonOnly: bool('SEASON_ONLY', true),

  alertThresholdCm: num('ALERT_THRESHOLD_CM', 30),
  alertRegions: str('ALERT_REGIONS', 'all'),
  quietFrom: num('ALERT_QUIET_FROM', 22),
  quietTo: num('ALERT_QUIET_TO', 6),

  mailProvider: str('MAIL_PROVIDER', 'none').toLowerCase(),
  mailTo: list('MAIL_TO'),
  mailFrom: str('MAIL_FROM', 'toppturvarsel@example.com'),
  resendApiKey: str('RESEND_API_KEY'),
  smtpUrl: str('SMTP_URL'),

  ntfyTopic: str('NTFY_TOPIC'),
  ntfyServer: str('NTFY_SERVER', 'https://ntfy.sh').replace(/\/+$/, ''),
  ntfyToken: str('NTFY_TOKEN'),

  resortsEnabled: bool('RESORTS_ENABLED', true),
  // Minimum minutes between refreshes forced from the page's button.
  refreshCooldownMinutes: Math.max(0, num('REFRESH_COOLDOWN_MINUTES', 10)),
  dataDir: str('DATA_DIR', new URL('../data', import.meta.url).pathname),
};

const here = (p) => new URL(p, import.meta.url);

export async function loadRegions() {
  return JSON.parse(await readFile(here('../data/regions.json'), 'utf8'));
}
export async function loadTours() {
  return JSON.parse(await readFile(here('../data/tours.json'), 'utf8'));
}

/**
 * Both forecast services run roughly December to late May. Outside that we
 * stop hitting upstream entirely - there is nothing to fetch, and a service
 * that politely goes quiet for five months is a better neighbour than one
 * that polls a public agency's API all summer for null.
 */
export function inSeason(date = new Date()) {
  const m = date.getUTCMonth() + 1;
  return m >= 11 || m <= 6;
}
