/**
 * Who is logged in, and what a sneaky login may do (v5.8). Loaded by every
 * page. With logins off everyone is premium and nothing here shows.
 *
 *   me()            -> { auth, user, role, sneaky, demo }
 *   slopeClosed(what)  the "Slope closed — open for premium skiers only" popup
 *
 * For a sneaky login it also:
 *   - puts the user and "Log out" in the page header;
 *   - stops the premium things (GPX in and out, the tour editor, forecast
 *     accuracy, Plan a tour outside the demo) with the popup;
 *   - shows the popup when the server answers { closed: true }.
 */

import { esc } from './esc.js';

let mePromise = null;
export function me() {
  mePromise ??= fetch('api/me', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((m) => ({ auth: !!m.auth, user: m.user ?? null, role: m.role ?? 'premium', demo: m.demo ?? null, sneaky: m.role === 'sneaky' }));
  return mePromise;
}

/* ---------- the popup ---------- */
let dlg = null;
let lastShown = 0;
export function slopeClosed(what = 'This') {
  if (dlg?.open) return;
  lastShown = Date.now();
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'slopeclosed';
    dlg.innerHTML =
      `<div class="sc-sign" aria-hidden="true"><span>Slope closed</span></div>` +
      `<h2>Slope closed — open for premium skiers only</h2>` +
      `<p class="sc-what"></p>` +
      `<p class="sc-note"></p>` +
      `<form method="dialog"><button class="btn primary" value="ok">OK, back to the open slopes</button></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  dlg.querySelector('.sc-what').textContent = `${what} — only in the premium version of Fjällskred.`;
  me().then((m) => {
    dlg.querySelector('.sc-note').textContent = m.demo
      ? `With your login you have the conditions, the trip planner and a demo of Plan a tour within ${m.demo.radiusKm} km of ${m.demo.name}.`
      : 'With your login you have the conditions, the trip planner and a demo of Plan a tour.';
  });
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

/* ---------- the server said "closed" ---------- */
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await realFetch(...args);
  if (res.status === 403 || res.status === 401) {
    res.clone().json().then((b) => {
      // One popup for a burst of refused requests, not ten.
      if (b?.closed && Date.now() - lastShown > 1500) slopeClosed(closedWhat(b.error));
      else if (b?.login) location.href = loginUrl();
    }).catch(() => {});
  }
  return res;
};
function closedWhat(error) {
  const m = /Slope closed: (.*?) (?:is|are) open for premium/i.exec(error ?? '');
  if (!m) return 'This';
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}
// Every page sits at the top of the app (./, terrain, skill, editor), so "login" is next to it.
const loginUrl = () => 'login';

/* ---------- what a sneaky click may not do ---------- */
const BLOCK = [
  ['a[href^="api/track.gpx"], a[href*="/api/track.gpx"]', 'GPX export'],
  ['#gpxOutBtn', 'GPX export'],
  ['#gpxInBtn', 'GPX import'],
  ['a[href="skill"], a[href="./skill"], a[href$="/skill"]', 'Forecast accuracy'],
  ['a[href="editor"], a[href="./editor"], a[href$="/editor"]', 'The tour editor'],
  ['#refreshBtn', 'Refreshing the data by hand'],
  ['[data-premium]', 'This'],
];

export async function applyAccess() {
  const m = await me();
  if (!m.auth) return m;
  document.documentElement.dataset.role = m.role;
  addUserChip(m);
  if (!m.sneaky) return m;
  document.addEventListener('click', (e) => {
    for (const [sel, what] of BLOCK) {
      const el = e.target.closest?.(sel);
      if (el) { e.preventDefault(); e.stopImmediatePropagation(); slopeClosed(el.dataset.premium || what); return; }
    }
    // Plan a tour: only the demo tour.
    const a = e.target.closest?.('a[href^="terrain"]');
    if (a && m.demo) {
      const tour = /[#&]tour=([^&]*)/.exec(a.getAttribute('href'))?.[1];
      if (tour && decodeURIComponent(tour) !== m.demo.name) {
        e.preventDefault();
        e.stopImmediatePropagation();
        slopeClosed(`Plan a tour for ${decodeURIComponent(tour)}`);
      }
    }
    if (e.target.closest?.('#pinPlan')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      slopeClosed('Plan a tour outside the demo area');
    }
  }, true);
  return m;
}

function addUserChip(m) {
  const status = document.querySelector('header.top .status');
  if (!status || status.querySelector('.userchip')) return;
  const el = document.createElement('span');
  el.className = `chip userchip ${m.role}`;
  el.innerHTML = `<span class="who" title="Logged in">${esc(m.user ?? '')}</span>` +
    `<span class="role">${m.role === 'premium' ? 'premium' : 'sneaky'}</span>` +
    `<a href="logout" class="out">Log out</a>`;
  status.prepend(el);
}

applyAccess();
