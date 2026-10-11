import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loginPage } from '../src/authpages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');

test('every page loads the shared Molker Digital stylesheet and uses no hard-coded colours', () => {
  const out = execFileSync('node', [path.join(root, 'scripts/check-design.mjs'), pub], { encoding: 'utf8' });
  assert.match(out, /^ok:/);
});

test('the vendored copy comes first, then /shared/, then the tool stylesheet', () => {
  assert.ok(existsSync(path.join(pub, 'vendor/molker.css')), 'vendor/molker.css is shipped with the app');
  for (const f of readdirSync(pub).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(path.join(pub, f), 'utf8');
    const i = html.indexOf('href="vendor/molker.css"');
    const j = html.indexOf('href="/shared/molker.css"');
    const k = html.indexOf('href="styles.css"');
    assert.ok(i > 0 && i < j && j < k, `${f}: vendor, then /shared/, then styles.css`);
  }
  const login = loginPage();
  assert.ok(login.includes('href="vendor/molker.css"') && login.includes('href="/shared/molker.css"'));
});

test('every page has the same nav bar, with the current page marked', () => {
  for (const [f, cur] of [['index.html', 'Conditions'], ['skill.html', 'Forecast accuracy'], ['terrain.html', 'Plan a tour']]) {
    const html = readFileSync(path.join(pub, f), 'utf8');
    const nav = /<nav class="subnav"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '';
    for (const label of ['Conditions', 'Plan a tour', 'Forecast accuracy', 'Tour editor']) assert.ok(nav.includes(`>${label}</a>`), `${f} links ${label}`);
    assert.match(nav, new RegExp(`aria-current="page">${cur}</a>`), `${f} marks ${cur}`);
  }
});

test('the tool stylesheet no longer redefines the shared frame', () => {
  const css = readFileSync(path.join(pub, 'styles.css'), 'utf8');
  for (const sel of ['header.top {', '.card {', '.btn {', 'footer {', '.wrap {']) assert.ok(!css.includes('\n' + sel), `${sel} is shared`);
});

test('the links to the other pages live in the top nav only, not in the Tours card', () => {
  const html = readFileSync(path.join(pub, 'index.html'), 'utf8');
  const card = /<h2>Tours<\/h2>.*?<div class="controls">/s.exec(html)?.[0] ?? '';
  assert.ok(card.length > 0, 'found the Tours card header');
  for (const href of ['href="terrain"', 'href="skill"', 'href="editor"']) assert.ok(!card.includes(href), `no ${href} in the Tours card`);
});

test('the tour editor page carries the same nav when the service serves it', () => {
  const html = readFileSync(path.join(root, 'editor/tour-editor.html'), 'utf8');
  const nav = /<nav class="subnav" id="siteNav"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '';
  for (const label of ['Conditions', 'Plan a tour', 'Forecast accuracy', 'Tour editor']) assert.ok(nav.includes(`>${label}</a>`), `editor links ${label}`);
  assert.match(nav, /aria-current="page">Tour editor</);
  assert.match(html, /siteNav'\)\.hidden = false/, 'shown only in the service copy (preview mode)');
});
