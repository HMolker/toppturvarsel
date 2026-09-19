import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util/log.js';

/**
 * Flat-file JSON store. Deliberately not a database: this service holds one
 * current snapshot, a short history and a small alert ledger for ~30 regions.
 * A file the operator can cat, diff and delete beats a database they have to
 * back up.
 *
 * Writes go through a temp file + rename so a crash mid-write cannot leave a
 * half-written snapshot that the server then serves as truth.
 */

const dir = () => path.resolve(config.dataDir, 'cache');

async function ensureDir() {
  await mkdir(dir(), { recursive: true });
}

async function writeAtomic(name, value) {
  await ensureDir();
  const target = path.join(dir(), name);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, target);
}

async function readJSON(name, fallback = null) {
  try {
    return JSON.parse(await readFile(path.join(dir(), name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`store: could not read ${name}: ${err.message}`);
    return fallback;
  }
}

export const store = {
  async saveSnapshot(snapshot) {
    await writeAtomic('current.json', snapshot);
    const stamp = snapshot.fetchedAt.replace(/[:.]/g, '-');
    await writeAtomic(path.join(`history-${stamp}.json`), snapshot).catch(() => {});
    await this.pruneHistory();
    return snapshot;
  },

  getSnapshot() {
    return readJSON('current.json', null);
  },

  /** Keep ~30 days of daily snapshots; they are small and make trends possible. */
  async pruneHistory(keep = 120) {
    try {
      const files = (await readdir(dir()))
        .filter((f) => f.startsWith('history-'))
        .sort()
        .reverse();
      const { unlink } = await import('node:fs/promises');
      await Promise.all(files.slice(keep).map((f) => unlink(path.join(dir(), f)).catch(() => {})));
    } catch {
      /* pruning is best effort */
    }
  },

  getAlertLedger() {
    return readJSON('alerts.json', { sent: {}, pending: [] });
  },

  saveAlertLedger(ledger) {
    return writeAtomic('alerts.json', ledger);
  },

  getSettings() {
    return readJSON('settings.json', null);
  },

  saveSettings(settings) {
    return writeAtomic('settings.json', settings);
  },
};
