import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This build's version, from package.json. Read once. */
let memo;
export async function appVersion() {
  if (memo === undefined) {
    try {
      memo = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version ?? null;
    } catch {
      memo = null;
    }
  }
  return memo;
}
