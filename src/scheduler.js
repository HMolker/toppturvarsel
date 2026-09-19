import { config, inSeason } from './config.js';
import { refresh } from './refresh.js';
import { runAlerts } from './alerts.js';
import { store } from './store.js';
import { log } from './util/log.js';

/**
 * Plain setInterval rather than a cron dependency. The cadence here is
 * "every N minutes", not "at 06:14 on weekdays", so cron syntax would buy
 * nothing and cost a dependency.
 *
 * Two behaviours worth knowing:
 *  - A refresh runs on boot if the stored snapshot is older than one interval,
 *    so a restart does not leave the page blank waiting three hours.
 *  - Held alerts are re-evaluated every interval, which is how a storm found
 *    at 03:00 gets delivered at 06:00 without waiting for new snow to fall.
 */
export function startScheduler() {
  const intervalMs = config.refreshMinutes * 60 * 1000;

  const tick = async (reason) => {
    if (config.seasonOnly && !inSeason()) {
      log.debug('scheduler: out of season, skipping');
      return;
    }
    try {
      log.info(`scheduler: refreshing (${reason})`);
      const snapshot = await refresh();
      const result = await runAlerts(snapshot);
      if (result.sent) log.info(`scheduler: sent ${result.sent} alert(s) via ${result.delivered.join(', ')}`);
    } catch (err) {
      log.error(`scheduler: refresh failed: ${err.message}`);
    }
  };

  (async () => {
    const snapshot = await store.getSnapshot();
    const age = snapshot ? Date.now() - new Date(snapshot.fetchedAt).getTime() : Infinity;
    if (age > intervalMs) await tick('startup, snapshot stale');
    else log.info(`scheduler: snapshot is ${Math.round(age / 60000)} min old, no startup refresh`);
  })();

  const timer = setInterval(() => tick('interval'), intervalMs);
  timer.unref?.();
  log.info(`scheduler: every ${config.refreshMinutes} min`);
  return () => clearInterval(timer);
}
