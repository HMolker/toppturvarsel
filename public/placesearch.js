/**
 * A place-name search box (v5.6), shared by the conditions page and Plan a
 * tour. Searches on Enter only — OpenStreetMap's Nominatim, which answers
 * for Sweden, does not allow search-as-you-type — and lists the answers
 * under the box. Norway: Kartverket's place names; Sweden: OpenStreetMap.
 *
 *   attachPlaceSearch(input, {
 *     local(q)  -> [{ name, note, go() }]   instant matches (tours, resorts), shown first
 *     onPick(place)                          a place-name answer was chosen
 *   })
 */

import { esc } from './esc.js';

const KIND = {
  // Kartverket's types, in English, the common ones.
  Fjell: 'mountain', Fjellområde: 'mountain area', Topp: 'summit', Høyde: 'hill', Ås: 'ridge', Egg: 'ridge', Tind: 'peak', Bre: 'glacier',
  Dal: 'valley', Skar: 'pass', Vann: 'lake', Innsjø: 'lake', Tettsted: 'village', Bygd: 'village', By: 'town', Gard: 'farm', Hytte: 'cabin',
  // OpenStreetMap's.
  peak: 'summit', hill: 'hill', ridge: 'ridge', valley: 'valley', glacier: 'glacier', village: 'village', town: 'town', hamlet: 'hamlet',
  city: 'town', lake: 'lake', water: 'lake', mountain_range: 'mountain area', saddle: 'pass', alpine_hut: 'hut', wilderness_hut: 'hut',
};
export const kindName = (k) => (k ? KIND[k] ?? String(k).replace(/_/g, ' ').toLowerCase() : '');

export function attachPlaceSearch(input, { local = () => [], onPick, country = null } = {}) {
  const box = document.createElement('div');
  box.className = 'psbox';
  box.hidden = true;
  box.setAttribute('role', 'listbox');
  input.insertAdjacentElement('afterend', box);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('enterkeyhint', 'search');
  let items = [];
  let seq = 0;

  const close = () => { box.hidden = true; box.innerHTML = ''; items = []; };
  const show = (html) => { box.innerHTML = html; box.hidden = false; };
  const choose = (k) => {
    const it = items[k];
    if (!it) return;
    close();
    input.value = '';
    input.blur();
    it.go();
  };

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const mine = ++seq;
    const near = local(q).slice(0, 5);
    items = near.map((x) => ({ ...x }));
    const listHtml = () =>
      items
        .map((x, k) => `<button type="button" class="psitem${x.place ? '' : ' own'}" data-k="${k}" role="option"><b>${esc(x.name)}</b><span>${esc(x.note ?? '')}</span></button>`)
        .join('');
    show(`${listHtml()}<div class="psnote">Searching Norway and Sweden…</div>`);
    try {
      const r = await fetch(`/api/places?q=${encodeURIComponent(q)}${country ? `&country=${country}` : ''}`);
      const body = await r.json();
      if (mine !== seq) return;
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      for (const p of body.places) {
        items.push({
          name: p.name,
          note: [kindName(p.kind), p.area, p.country === 'SE' ? 'Sweden' : 'Norway'].filter(Boolean).join(' · '),
          place: p,
          go: () => onPick?.(p),
        });
      }
      const note = !items.length
        ? `<div class="psnote">Nothing found for “${esc(q)}”.</div>`
        : body.partial ? `<div class="psnote">Only part of the answer: ${esc(body.partial)}</div>` : '';
      show(listHtml() + note + '<div class="psnote src">Names: Kartverket (Norway), © OpenStreetMap contributors (Sweden)</div>');
    } catch (err) {
      if (mine !== seq) return;
      show(`${listHtml()}<div class="psnote">Place search failed: ${esc(err.message)}</div>`);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' && !box.hidden) { e.preventDefault(); box.querySelector('.psitem')?.focus(); }
  });
  box.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    if (e.key === 'ArrowDown') { e.preventDefault(); el?.nextElementSibling?.classList.contains('psitem') && el.nextElementSibling.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (el?.previousElementSibling?.classList.contains('psitem') ? el.previousElementSibling : input).focus(); }
    else if (e.key === 'Escape') { close(); input.focus(); }
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.psitem');
    if (b) choose(+b.dataset.k);
  });
  document.addEventListener('click', (e) => {
    if (!box.hidden && e.target !== input && !box.contains(e.target)) close();
  });
  return { run, close };
}

/** Make a place part of the service area (Plan a tour can then be used there). */
export async function pickPlace(place) {
  const r = await fetch('/api/places/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: place.id }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.place;
}
