import { config } from './config.js';
import { store } from './store.js';
import { sendEmail } from './notify/email.js';
import { sendNtfy } from './notify/ntfy.js';
import { log } from './util/log.js';

/**
 * Powder alerts: fire when modelled new snow over 48 h reaches the threshold
 * in a watched region.
 *
 * Three rules that matter more than the threshold itself:
 *
 * 1. DEDUPE. An alert is keyed on region + the UTC day of the snapshot's
 *    observation, so a 3-hourly refresh cannot send the same storm six times.
 *    A genuinely new load on a later day alerts again.
 *
 * 2. QUIET HOURS. Alerts found overnight are held, not dropped, and go out
 *    when the window ends. Nobody needs a push at 04:00 about snow that will
 *    still be there at 07:00.
 *
 * 3. THE AVALANCHE LINE IS NOT DECORATION. A big load is exactly when the
 *    bulletin matters most, so every alert carries the current danger level
 *    and problems, and says to read the bulletin. When we could not read a
 *    danger level, the alert says so explicitly rather than omitting it -
 *    a missing number must never read as a low one.
 */

/** Whole centimetres in messages; see the note on precision in public/app.js. */
const cm = (v) => Math.round(v);

export function evaluateAlerts(snapshot, { threshold = config.alertThresholdCm, watch = config.alertRegions } = {}) {
  if (!snapshot?.regions) return [];
  const watched = parseWatch(watch);

  return snapshot.regions
    .filter((r) => !r.offMap)
    .filter((r) => watched === 'all' || watched.has(r.id))
    .map((r) => {
      const new48 = r.snow?.new48 ?? null;
      if (new48 === null || new48 < threshold) return null;
      return {
        regionId: r.id,
        regionName: r.name,
        country: r.country,
        new48,
        new24: r.snow?.new24 ?? null,
        depthCm: r.snow?.depthCm ?? null,
        topTour: r.snow?.topTour ?? null,
        // True when the region has no tours and this came from one sample at
        // the region marker - a weaker basis, and the alert says so.
        indicative: Boolean(r.snow?.fallback),
        danger: r.bulletin?.danger ?? null,
        dangerKnown: r.bulletin?.danger !== null && r.bulletin?.danger !== undefined,
        problems: (r.bulletin?.problems ?? []).map((p) => p.type).filter(Boolean),
        bulletinUrl: r.bulletinUrl,
        observedAt: r.snow?.observedAt ?? null,
        day: (snapshot.fetchedAt ?? new Date().toISOString()).slice(0, 10),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.new48 - a.new48);
}

export const alertKey = (a) => `${a.regionId}:${a.day}`;

export function isQuietHour(date = new Date(), from = config.quietFrom, to = config.quietTo) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const h = date.getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Decide what to send: new alerts not already sent, plus anything held
 * during quiet hours that is now releasable.
 */
export function selectSendable(candidates, ledger, now = new Date()) {
  const sent = ledger.sent ?? {};
  const pending = ledger.pending ?? [];

  const fresh = candidates.filter((a) => !sent[alertKey(a)]);
  const held = pending.filter((a) => !sent[alertKey(a)]);

  // A held alert may have been superseded by a bigger reading the same day.
  const merged = new Map();
  for (const a of [...held, ...fresh]) {
    const k = alertKey(a);
    const prev = merged.get(k);
    if (!prev || a.new48 > prev.new48) merged.set(k, a);
  }
  const all = [...merged.values()];

  if (isQuietHour(now)) return { send: [], hold: all };
  return { send: all.sort((a, b) => b.new48 - a.new48), hold: [] };
}

export async function runAlerts(snapshot, { now = new Date(), dryRun = false } = {}) {
  const candidates = evaluateAlerts(snapshot);
  const ledger = (await store.getAlertLedger()) ?? { sent: {}, pending: [] };
  const { send, hold } = selectSendable(candidates, ledger, now);

  if (hold.length) {
    log.info(`alerts: holding ${hold.length} until quiet hours end`);
  }
  if (!send.length) {
    ledger.pending = hold;
    if (!dryRun) await store.saveAlertLedger(ledger);
    return { sent: 0, held: hold.length, delivered: [] };
  }

  const delivered = [];
  if (!dryRun) {
    const results = await Promise.allSettled([
      sendEmail(buildEmail(send)),
      sendNtfy(buildPush(send)),
    ]);
    results.forEach((r, i) => {
      const channel = i === 0 ? 'email' : 'ntfy';
      if (r.status === 'fulfilled' && r.value?.sent) delivered.push(channel);
      else if (r.status === 'rejected') log.warn(`alerts: ${channel} failed: ${r.reason?.message}`);
      else if (r.value?.reason) log.debug(`alerts: ${channel} skipped (${r.value.reason})`);
    });

    // Only mark as sent if at least one channel actually delivered, so a
    // misconfigured mailer does not silently swallow the whole storm.
    if (delivered.length) {
      for (const a of send) ledger.sent[alertKey(a)] = new Date().toISOString();
      ledger.pending = [];
    } else {
      ledger.pending = send;
      log.warn('alerts: no channel delivered; keeping alerts pending for the next run');
    }
    ledger.sent = pruneLedger(ledger.sent);
    await store.saveAlertLedger(ledger);
  }

  return { sent: delivered.length ? send.length : 0, held: hold.length, delivered, alerts: send };
}

function pruneLedger(sent, keepDays = 30) {
  const cutoff = Date.now() - keepDays * 86400000;
  return Object.fromEntries(
    Object.entries(sent).filter(([, iso]) => new Date(iso).getTime() > cutoff)
  );
}

function parseWatch(watch) {
  if (!watch || watch === 'all') return 'all';
  const set = new Set(
    String(watch)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.size ? set : 'all';
}

function dangerPhrase(a) {
  if (!a.dangerKnown) return 'danger level not available - read the bulletin';
  const names = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Very high' };
  return `danger ${a.danger} (${names[a.danger] ?? '?'})`;
}

export function buildPush(alerts) {
  const top = alerts[0];
  const more = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : '';
  return {
    title: `${cm(top.new48)} cm — ${top.regionName}${more}`,
    body: alerts
      .slice(0, 5)
      .map((a) => `${a.regionName}: +${cm(a.new48)} cm/48h, ${dangerPhrase(a)}`)
      .join('\n'),
    tags: ['snowflake'],
    priority: 4,
    click: top.bulletinUrl,
  };
}

export function buildEmail(alerts) {
  const subject =
    alerts.length === 1
      ? `Powder alert: ${cm(alerts[0].new48)} cm in ${alerts[0].regionName}`
      : `Powder alert: ${alerts.length} regions over threshold`;

  const lines = alerts.map((a) => {
    const bits = [
      `+${cm(a.new48)} cm new snow over 48 h` + (a.new24 !== null ? ` (${cm(a.new24)} cm in 24 h)` : ''),
      a.depthCm !== null ? `${cm(a.depthCm)} cm base` : null,
      dangerPhrase(a),
      a.problems.length ? `problems: ${a.problems.join(', ')}` : null,
      a.topTour ? `biggest load near: ${a.topTour}` : null,
      a.indicative ? 'NOTE: single indicative sample, no tours listed in this region' : null,
    ].filter(Boolean);
    return `${a.regionName}\n  ${bits.join('\n  ')}\n  Bulletin: ${a.bulletinUrl}`;
  });

  const text = [
    subject,
    '',
    ...lines,
    '',
    'New-snow figures are modelled (NVE seNorge, 1 km grid) and read as the rise',
    'in snow depth, so settlement means they under-report what actually fell.',
    '',
    'A big load is when the bulletin matters most. Read it before you commit,',
    'and remember a regional forecast describes a region, not your slope.',
    '',
    '— Fjällskred · Molker Digital free-touring monitor',
  ].join('\n');

  return { subject, text };
}
