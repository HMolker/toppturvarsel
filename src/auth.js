import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util/log.js';

/**
 * Logins (v5.8): individual users from a list you keep, two kinds.
 *
 *   premium  everything
 *   sneaky   the conditions page, the trip planner and a demo of Plan a
 *            tour around Harahorn; the rest says "Slope closed"
 *
 * The list is data/auth/users.csv, one user a line:
 *
 *   # username,role,password
 *   anna,premium,a-long-password
 *   olle,sneaky,another-one
 *
 * Write passwords in plain text: the server replaces each with its scrypt
 * hash the next time it reads the file (within a minute, or at start), so
 * the plain text does not stay on disk. To change a password, write the new
 * one over the hash; to remove someone, delete the line — their sessions end
 * at once. Without the file (or with it empty) logins are off, as before.
 *
 * Sessions are a signed cookie (HMAC-SHA256 with a random key kept in
 * data/auth/secret), 30 days, HttpOnly, SameSite=Lax, Secure over HTTPS.
 */

const scrypt = promisify(scryptCb);
const dir = () => path.resolve(config.dataDir, 'auth');
const usersFile = () => path.join(dir(), 'users.csv');
const SESSION_DAYS = 30;
export const ROLES = ['premium', 'sneaky'];

let users = new Map(); // username -> { role, hash }
let loadedMtime = -1;
let lastCheck = 0;
let secret = null;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const [kind, n, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n) || 16384, r: 8, p: 1 });
  return want.length === got.length && timingSafeEqual(want, got);
}
// A hash to compare against when the user does not exist, so both take as long.
let dummyHash = null;

/** Read the list; hash plain-text passwords in place. Checked at most every 30 s. */
export async function loadUsers({ force = false } = {}) {
  if (!force && Date.now() - lastCheck < 30000) return users;
  lastCheck = Date.now();
  let st;
  try {
    st = await stat(usersFile());
  } catch {
    if (users.size) log.info('auth: no users file any more, logins off');
    users = new Map();
    loadedMtime = -1;
    return users;
  }
  if (!force && st.mtimeMs === loadedMtime) return users;
  const text = await readFile(usersFile(), 'utf8');
  const out = new Map();
  let changed = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',');
    const [name, role] = [parts[0]?.trim().toLowerCase(), parts[1]?.trim().toLowerCase()];
    const pw = parts.slice(2).join(',').trim();
    if (!name || !/^[a-z0-9._@-]{2,64}$/.test(name)) { log.warn(`auth: line ${i + 1}: bad username, skipped`); continue; }
    if (!ROLES.includes(role)) { log.warn(`auth: line ${i + 1}: role must be premium or sneaky, skipped`); continue; }
    if (!pw) { log.warn(`auth: line ${i + 1}: no password, skipped`); continue; }
    let hash = pw;
    if (!pw.startsWith('scrypt$')) {
      if (pw.length < 8) { log.warn(`auth: line ${i + 1}: ${name}'s password is shorter than 8 characters, skipped`); continue; }
      hash = await hashPassword(pw);
      lines[i] = `${name},${role},${hash}`;
      changed = true;
    }
    out.set(name, { role, hash });
  }
  if (changed) {
    await writeFile(`${usersFile()}.tmp`, lines.join('\n'), { mode: 0o600 });
    await rename(`${usersFile()}.tmp`, usersFile());
    log.info('auth: plain-text passwords in users.csv replaced by their hashes');
  }
  users = out;
  loadedMtime = (await stat(usersFile())).mtimeMs;
  const n = { premium: 0, sneaky: 0 };
  for (const u of out.values()) n[u.role]++;
  log.info(`auth: ${n.premium} premium and ${n.sneaky} sneaky users`);
  return users;
}

export const authEnabled = () => users.size > 0 || /^(on|true|1|yes)$/i.test(process.env.AUTH ?? '');

async function getSecret() {
  if (secret) return secret;
  const f = path.join(dir(), 'secret');
  try {
    secret = Buffer.from((await readFile(f, 'utf8')).trim(), 'base64');
    if (secret.length >= 32) return secret;
  } catch {
    /* make one */
  }
  secret = randomBytes(32);
  await mkdir(dir(), { recursive: true });
  await writeFile(f, secret.toString('base64'), { mode: 0o600 });
  return secret;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
async function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac('sha256', await getSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
async function unsign(token) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', await getSecret()).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const COOKIE = 'fjs_session';
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};
const secureReq = (req) => /^https$/i.test(String(req.headers['x-forwarded-proto'] ?? '')) || /^(on|true|1)$/i.test(process.env.COOKIE_SECURE ?? '');
// Through Caddy the site lives under BASE_PATH; straight to the port (on the LAN) it is at /.
const cookiePath = (req) => (req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] ? process.env.BASE_PATH || '/' : '/');

/** The signed-in user for a request: { name, role } or null. */
export async function currentUser(req) {
  await loadUsers();
  const p = await unsign(cookieOf(req, COOKIE));
  if (!p || !p.u || p.exp < Date.now()) return null;
  const u = users.get(p.u);
  // A changed password (or a removed user) ends the sessions made before.
  if (!u || u.hash.slice(-12) !== p.h) return null;
  return { name: p.u, role: u.role };
}

/* ---------- attempts: 5 wrong in 15 minutes locks the name and the address for 15 minutes ---------- */
const fails = new Map(); // key -> [times]
const WINDOW = 15 * 60e3;
const tooMany = (key) => (fails.get(key) ?? []).filter((t) => Date.now() - t < WINDOW).length >= 5;
const fail = (key) => fails.set(key, [...(fails.get(key) ?? []).filter((t) => Date.now() - t < WINDOW), Date.now()]);
const clientIp = (req) => (/^(on|true|1)$/i.test(process.env.TRUST_PROXY ?? 'true') ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

/** Check a username and password; returns the Set-Cookie header value, or throws { status, message }. */
export async function login(req, name, password) {
  await loadUsers();
  const who = String(name ?? '').trim().toLowerCase();
  const ip = clientIp(req);
  if (tooMany(`ip:${ip}`) || tooMany(`u:${who}`)) {
    const e = new Error('Too many wrong passwords. Wait 15 minutes and try again.');
    e.status = 429;
    throw e;
  }
  const u = users.get(who);
  dummyHash ??= await hashPassword(randomBytes(12).toString('hex'));
  const ok = await checkPassword(String(password ?? ''), u?.hash ?? dummyHash);
  if (!u || !ok) {
    fail(`ip:${ip}`);
    fail(`u:${who}`);
    const e = new Error('Wrong username or password.');
    e.status = 401;
    throw e;
  }
  fails.delete(`u:${who}`);
  const token = await sign({ u: who, h: u.hash.slice(-12), exp: Date.now() + SESSION_DAYS * 86400e3 });
  return `${COOKIE}=${encodeURIComponent(token)}; Path=${cookiePath(req)}; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secureReq(req) ? '; Secure' : ''}`;
}
export const logoutCookie = (req) => `${COOKIE}=; Path=${cookiePath(req)}; Max-Age=0; HttpOnly; SameSite=Lax${secureReq(req) ? '; Secure' : ''}`;

/** For tests. */
export function _resetAuth() {
  users = new Map();
  loadedMtime = -1;
  lastCheck = 0;
  secret = null;
  fails.clear();
}
