#!/usr/bin/env node
/**
 * The users list from the command line (v5.8), for the admin on the Pi:
 *
 *   docker compose exec toppturvarsel node src/users-cli.js <command>
 *
 *   list                          who is on the list, and their kind
 *   add <premium|sneaky> <name>…  add one or more users with new random passwords (printed once)
 *   passwd <name> [password]      a new password (random if left out, printed once); ends their sessions
 *   role <name> <premium|sneaky>  change what they may use
 *   remove <name>…                take them off the list; their sessions end at once
 *
 * It edits data/auth/users.csv, the same file you can edit by hand; the
 * server picks up the change within half a minute.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword, ROLES } from './auth.js';

const file = path.resolve(config.dataDir, 'auth', 'users.csv');
const NAME = /^[a-z0-9._@-]{2,64}$/;
// Easy to read out and type on a phone: no 0/O, 1/l/I.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const newPassword = () => {
  const b = randomBytes(14);
  let s = '';
  for (let i = 0; i < 14; i++) s += ALPHA[b[i] % ALPHA.length];
  return `${s.slice(0, 4)}-${s.slice(4, 9)}-${s.slice(9)}`;
};

async function readLines() {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/);
  } catch {
    return ['# username,role,password  (passwords are replaced by their hash)'];
  }
}
async function writeLines(lines) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = lines.filter((l) => l.trim()).join('\n').replace(/\n*$/, '\n');
  await writeFile(`${file}.tmp`, text, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
const parse = (line) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const [name, role] = t.split(',').map((x) => x.trim().toLowerCase());
  return { name, role };
};
const find = (lines, name) => lines.findIndex((l) => parse(l)?.name === name);
const fail = (msg) => { console.error(msg); process.exit(1); };
const want = (name) => {
  const n = String(name ?? '').trim().toLowerCase();
  if (!NAME.test(n)) fail(`"${name}" is not a username: 2–64 of a–z, 0–9 and . _ @ -`);
  return n;
};
const wantRole = (role) => (ROLES.includes(role) ? role : fail(`the kind is premium or sneaky, not "${role}"`));

const [cmd, ...args] = process.argv.slice(2);
const lines = await readLines();

switch (cmd) {
  case 'list': {
    const users = lines.map(parse).filter(Boolean);
    for (const r of ROLES) {
      const names = users.filter((u) => u.role === r).map((u) => u.name).sort();
      console.log(`${r} (${names.length}): ${names.join(', ') || '—'}`);
    }
    break;
  }
  case 'add': {
    const role = wantRole(args[0]);
    const names = args.slice(1).map(want);
    if (!names.length) fail('add <premium|sneaky> <name> [<name>…]');
    const out = [];
    for (const name of names) {
      if (find(lines, name) >= 0) { console.error(`${name} is already on the list (use passwd or role)`); continue; }
      const pw = newPassword();
      lines.push(`${name},${role},${await hashPassword(pw)}`);
      out.push(`${name},${role},${pw}`);
    }
    await writeLines(lines);
    if (out.length) console.log(`# Give each their password; it is not stored and will not be shown again.\n${out.join('\n')}`);
    break;
  }
  case 'passwd': {
    const name = want(args[0]);
    const i = find(lines, name);
    if (i < 0) fail(`${name} is not on the list`);
    const pw = args[1] ?? newPassword();
    if (pw.length < 8) fail('at least 8 characters');
    lines[i] = `${name},${parse(lines[i]).role},${await hashPassword(pw)}`;
    await writeLines(lines);
    console.log(args[1] ? `${name}: new password set` : `${name}: ${pw}`);
    break;
  }
  case 'role': {
    const name = want(args[0]);
    const role = wantRole(args[1]);
    const i = find(lines, name);
    if (i < 0) fail(`${name} is not on the list`);
    const parts = lines[i].split(',');
    lines[i] = [name, role, ...parts.slice(2)].join(',');
    await writeLines(lines);
    console.log(`${name} is now ${role}`);
    break;
  }
  case 'remove': {
    let n = 0;
    for (const name of args.map(want)) {
      const i = find(lines, name);
      if (i < 0) { console.error(`${name} is not on the list`); continue; }
      lines.splice(i, 1);
      n++;
    }
    await writeLines(lines);
    console.log(`${n} removed`);
    break;
  }
  default:
    console.log('list | add <premium|sneaky> <name>… | passwd <name> [password] | role <name> <premium|sneaky> | remove <name>…');
}
