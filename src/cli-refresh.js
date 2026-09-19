#!/usr/bin/env node
/**
 * One-shot refresh from the command line:  npm run refresh
 * Useful for a first fill, for cron on a host that would rather drive the
 * schedule itself, and for checking upstream health after a deploy.
 */
import { refresh } from './refresh.js';
import { runAlerts } from './alerts.js';
import { log } from './util/log.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

try {
  const snapshot = await refresh({ force });
  const withDanger = snapshot.regions.filter((r) => r.bulletin?.danger).length;
  const withSnow = snapshot.tours.filter((t) => t.snow?.depthCm != null).length;
  log.info(`regions with a danger level: ${withDanger}/${snapshot.regions.length}`);
  log.info(`tours with snow data: ${withSnow}/${snapshot.tours.length}`);

  const result = await runAlerts(snapshot, { dryRun });
  log.info(`alerts: ${result.sent} sent, ${result.held} held${dryRun ? ' (dry run)' : ''}`);
  if (result.alerts?.length) {
    for (const a of result.alerts) log.info(`  ${a.regionName}: +${a.new48} cm/48h`);
  }
  process.exit(0);
} catch (err) {
  log.error(`refresh failed: ${err.message}`);
  process.exit(1);
}
