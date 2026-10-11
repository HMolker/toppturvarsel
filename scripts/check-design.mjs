#!/usr/bin/env node
// Smoke test for an app that uses the Molker Digital design.
// Usage: node check-app.mjs <public-folder> [--allow-hex-in=js]
// Fails if an .html page does not load /shared/molker.css, or if html/css
// (outside molker.css itself) contains a hard-coded hex colour.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: check-app.mjs <public-folder>'); process.exit(2); }
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n.startsWith('.') || n === 'fonts' || n === 'brand') continue;
    const p = join(d, n); const st = statSync(p);
    if (st.isDirectory()) walk(p); else files.push(p);
  }
})(root);

const problems = [];
const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
for (const f of files) {
  const ext = extname(f).toLowerCase();
  if (basename(f) === 'molker.css') continue;
  if (ext !== '.html' && ext !== '.css') continue;
  const text = readFileSync(f, 'utf8');
  if (ext === '.html' && !/<link[^>]+href=["'](?:\/shared|https?:\/\/[^"']+\/shared)\/molker\.css["']/.test(text))
    problems.push(`${f}: does not link /shared/molker.css`);
  // ignore anchors like href="#top" and ids; look only inside css text and style attributes
  const css = ext === '.css' ? text : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>|style="([^"]*)"/g)].map((m) => m[1] ?? m[2]).join('\n');
  const found = [...new Set(css.replace(/--[a-zA-Z0-9-]+\s*:[^;{}]*;?/g, '').match(hex) ?? [])];
  if (found.length) problems.push(`${f}: hard-coded colour(s) ${found.slice(0, 6).join(', ')}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok: ${files.filter((f) => extname(f) === '.html').length} page(s) use the shared stylesheet, no hard-coded hex`);
