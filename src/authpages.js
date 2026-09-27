/**
 * The login page and the "slope closed" page (v5.8), plain HTML in the
 * site's own style. Links are relative, so they work under /fjallskred/.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const head = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Fjällskred</title>
<link rel="stylesheet" href="styles.css">
<link rel="icon" type="image/png" sizes="64x64" href="brand/icon-64.png">
<style>
  .authwrap { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
  .authcard { width: min(420px, 100%); background: var(--paper); border: 1px solid var(--line-2); border-radius: 14px; padding: 28px 26px 24px; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
  .authcard img { display: block; height: 96px; width: auto; margin: 0 auto 10px; }
  .authcard h1 { font-size: 22px; margin: 6px 0 4px; text-align: center; }
  .authcard .sub { text-align: center; color: var(--muted); font-size: 13.5px; margin: 0 0 18px; }
  .authcard label { display: grid; gap: 5px; font-size: 13px; color: var(--ink-2); margin-bottom: 12px; }
  .authcard input { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: var(--r-ctl, 8px); background: var(--paper); color: var(--ink); }
  .authcard button { width: 100%; margin-top: 6px; justify-content: center; }
  .authcard .err { background: #FBD6CB; color: #6E1E15; border-radius: 8px; padding: 8px 10px; font-size: 13.5px; margin-bottom: 12px; }
  .closed .sign { font: 700 13px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: #fff; background: #C0392B; border-radius: 6px; padding: 6px 10px; display: inline-block; }
  .closed { text-align: center; }
  .closed p { color: var(--ink-2); line-height: 1.5; }
</style></head><body>`;

export function loginPage({ next = '', error = '' } = {}) {
  return `${head('Log in')}
<main class="authwrap"><form class="authcard" method="post" action="login">
  <img src="brand/logo-header.png" alt="Fjällskred">
  <h1>Fjällskred</h1>
  <p class="sub">Ski touring conditions for Norway and Sweden</p>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  <label>Username <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <input type="hidden" name="next" value="${esc(next)}">
  <button class="btn primary" type="submit">Log in</button>
</form></main></body></html>`;
}

export function closedPage(what = 'This part of Fjällskred') {
  return `${head('Slope closed')}
<main class="authwrap"><div class="authcard closed">
  <img src="brand/logo-header.png" alt="Fjällskred">
  <div class="sign">Slope closed</div>
  <h1>Open for premium skiers only</h1>
  <p>${esc(what)} is part of the premium version. Your login is a sneaky one: the conditions, the trip planner and the Plan a tour demo around Harahorn are open to you.</p>
  <a class="btn primary" href="./">← Back to the conditions</a>
</div></main></body></html>`;
}
