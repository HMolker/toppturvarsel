import { esc } from './esc.js';

/**
 * The "fun facts" under a ski resort's map: the resort's own lift and slope
 * counts first (from Fnugg, which is the accurate source), then what
 * OpenStreetMap has — lifts one by one, runs, capacity, vertical, and the
 * places to eat — all of it an estimate of what volunteers have drawn.
 */
export const DIFF_NAMES = { novice: 'novice', easy: 'easy', intermediate: 'intermediate', advanced: 'advanced', expert: 'expert', freeride: 'freeride / off-piste', unknown: 'not graded' };
const LIFT_PLURAL = { cable_car: 'cable cars', gondola: 'gondolas', mixed_lift: 'mixed lifts', chair_lift: 'chairlifts', drag_lift: 'drag lifts', 't-bar': 'T-bars', 'j-bar': 'J-bars', platter: 'platter lifts', rope_tow: 'rope tows', magic_carpet: 'magic carpets' };

/** A resort's figures from OpenStreetMap: cards, then every lift and every run. */
export function factsHtml(x, r = null) {
  if (!x || (!x.runCount && !x.liftCount)) return '<p class="note">No lifts are mapped in OpenStreetMap here yet.</p>';
  const nf = (n) => Math.round(n).toLocaleString('en-GB');
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const cards = [];
  if (x.runCount) {
    const chips = Object.entries(x.runsByDifficulty).filter(([, n]) => n).map(([d, n]) => `<span class="rschip"><i style="background:var(--pd-${d})"></i>${n} ${DIFF_NAMES[d]}</span>`).join('');
    const extras = [x.litKm ? `${x.litKm} km floodlit` : null, x.snowmakingKm ? `${x.snowmakingKm} km with snowmaking` : null, x.offPiste ? `${x.offPiste} off-piste line${x.offPiste > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
    cards.push(`<li class="wide"><b>≈ ${x.runCount} runs · ${x.runKm} km</b><span>mapped piste in OpenStreetMap, an estimate${extras ? ` · ${extras}` : ''}</span><div class="rschips">${chips}</div></li>`);
  }
  if (x.liftCount) {
    const kinds = Object.entries(x.liftsByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${n === 1 ? (LIFT_PLURAL[k] ?? k).replace(/s$/, '') : LIFT_PLURAL[k] ?? k}`).join(', ');
    cards.push(`<li><b>≈ ${x.liftCount} lifts · ${x.liftKm} km</b><span>${esc(kinds)}${x.pylons ? ` · ${x.pylons} pylons mapped` : ''}</span></li>`);
  }
  if (x.capacity) cards.push(`<li><b>${nf(x.capacity)} per hour</b><span>uphill capacity${x.capacityFrom < x.liftCount ? `, from the ${x.capacityFrom} of ${x.liftCount} lifts that have it mapped` : ''}${x.seats ? ` · ${x.seats} seats and hangers per cycle` : ''}</span></li>`);
  if (x.vertical) cards.push(`<li><b>${nf(x.vertical)} m vertical</b><span>${nf(x.bottom)} m at the lowest lift station to ${nf(x.top)} m at the highest</span></li>`);
  if (x.longestRun) cards.push(`<li><b>${km(x.longestRun.lengthM)}</b><span>longest run: ${esc(x.longestRun.name)}${x.longestRun.difficulty ? ` (${DIFF_NAMES[x.longestRun.difficulty]})` : ''}</span></li>`);
  if (x.longestLift) cards.push(`<li><b>${km(x.longestLift.lengthM)}</b><span>longest lift: ${esc(x.longestLift.name ?? 'unnamed')} (${esc(x.longestLift.kind)})</span></li>`);
  if (x.biggestLift?.rise) cards.push(`<li><b>${nf(x.biggestLift.rise)} m up</b><span>biggest climb in one lift: ${esc(x.biggestLift.name ?? 'unnamed')}</span></li>`);
  if (x.nordicKm) cards.push(`<li><b>${x.nordicKm} km</b><span>cross-country trails nearby${x.nordicLitKm ? `, ${x.nordicLitKm} km floodlit` : ''}</span></li>`);
  const around = [x.parks ? `${x.parks} snow park${x.parks > 1 ? 's' : ''}` : null, x.sledKm ? `${x.sledKm} km of sledging` : null,
    ...Object.entries(x.poiCounts ?? {}).map(([k, n]) => `${n} ${k}${n > 1 && !/s$/.test(k) ? (k.endsWith('y') ? '' : 's') : ''}`)].filter(Boolean);
  if (around.length) cards.push(`<li><b>Around the slopes</b><span>${esc(around.join(' · '))}</span></li>`);

  // The resort's own counts (Fnugg) are the ones to trust; OpenStreetMap is
  // what volunteers have drawn, and it is usually short of a few lifts.
  const own = { lifts: r?.lifts?.count ?? null, slopes: r?.slopes?.count ?? null };
  if (own.lifts || own.slopes) {
    const line = (label, mine, theirs) => {
      if (!theirs) return null;
      const d = mine ? theirs - mine : null;
      return `${theirs} ${label}${mine ? ` reported, ${mine} mapped${d ? ` (${d > 0 ? `${d} missing from OpenStreetMap` : `${-d} more in OpenStreetMap`})` : ' (they agree)'}` : ' reported'}`;
    };
    const rows = [line('lifts', x.liftCount, own.lifts), line('slopes', x.runCount, own.slopes)].filter(Boolean).join(' · ');
    cards.unshift(`<li class="wide"><b>The resort's own count</b><span>${esc(rows)}<br>Fnugg, from the resort itself — use these numbers; the OpenStreetMap figures below are an estimate from what volunteers have drawn.</span></li>`);
  }

  // A second opinion from the national map agency.
  const c = x.cross ?? {};
  const crossLine = (k) => {
    const v = c[k];
    if (!v || v.error || !v.total) return null;
    const miss = v.missing?.length ? ` · missing from OpenStreetMap: ${v.missing.join(', ')}` : ' · all of them are mapped';
    return `${v.total} lift${v.total === 1 ? '' : 's'} registered with ${v.source}, ${v.matched} matched${miss}`;
  };
  const crossRows = [crossLine('ssr'), crossLine('file')].filter(Boolean);
  if (crossRows.length) {
    cards.push(`<li class="wide"><b>Checked against the national map</b><span>${esc(crossRows.join(' · '))}<br>Official data (Kartverket's place-name register in Norway, your Lantmäteriet export in Sweden). A lift it knows and OpenStreetMap does not is ringed on the map.</span></li>`);
  }

  const yesno = (v, label) => (v ? label : null);
  const liftRows = (x.lifts ?? []).map((l) => {
    const notes = [yesno(l.bubble, 'bubble'), yesno(l.heating, 'heated'), yesno(l.detachable, 'detachable'), l.pylons ? `${l.pylons} pylons` : null].filter(Boolean).join(', ');
    const route = l.from || l.to ? `${esc(l.from ?? '…')} → ${esc(l.to ?? '…')}` : '';
    return `<tr><td><strong>${l.ref ? `${esc(l.ref)} ` : ''}${esc(l.name ?? 'unnamed')}</strong>${route ? `<br><span class="note">${route}</span>` : ''}</td>` +
      `<td>${esc(l.kindName)}${l.occupancy ? `<br><span class="note">${l.occupancy} ${l.kind === 'gondola' || l.kind === 'cable_car' ? 'per cabin' : /lift|bar|platter|tow|carpet/.test(l.kind) && l.kind !== 'chair_lift' ? 'per hanger' : 'seats'}</span>` : ''}</td>` +
      `<td class="num">${km(l.lengthM)}</td><td class="num">${l.rise != null ? `${nf(l.rise)} m` : '—'}${l.top != null ? `<br><span class="note">to ${nf(l.top)} m</span>` : ''}</td>` +
      `<td class="num">${l.capacity ? nf(l.capacity) : '—'}</td><td class="num">${l.duration ? `${l.duration} min` : '—'}</td><td>${esc(notes) || '<span class="note">—</span>'}</td></tr>`;
  }).join('');
  const liftTable = liftRows
    ? `<details class="rsdetails" open><summary>Every lift (${x.lifts.length})</summary><div class="rstablewrap"><table class="rstable"><thead><tr><th>Lift</th><th>Type</th><th class="num">Length</th><th class="num">Rise</th><th class="num">People/h</th><th class="num">Ride</th><th>Notes</th></tr></thead><tbody>${liftRows}</tbody></table></div></details>`
    : '';
  const GROOM = { classic: 'groomed', mogul: 'moguls', backcountry: 'not groomed' };
  const runRows = (x.runs ?? []).map((r) =>
    `<li><i style="background:var(--pd-${r.difficulty ?? 'unknown'})"></i><span class="rsrname">${r.ref ? `<b>${esc(r.ref)}</b> ` : ''}${esc(r.name ?? 'unnamed')}</span>` +
    `<span class="note">${[DIFF_NAMES[r.difficulty ?? 'unknown'], km(r.lengthM), r.grooming ? GROOM[r.grooming] ?? r.grooming : null, r.lit ? 'floodlit' : null, r.snowmaking ? 'snowmaking' : null].filter(Boolean).map(esc).join(' · ')}</span></li>`).join('');
  const runList = runRows ? `<details class="rsdetails"><summary>Every run (${x.runs.length})</summary><ul class="rsruns">${runRows}</ul></details>` : '';
  const eat = Object.entries(x.pois ?? {}).filter(([, names]) => names.length).map(([k, names]) => `<li><span class="note">${esc(k)}</span> ${names.map(esc).join(', ')}</li>`).join('');
  const eatList = eat ? `<details class="rsdetails"><summary>Places on the mountain</summary><ul class="rsplaces">${eat}</ul></details>` : '';
  return `<ul class="rsfacts">${cards.join('')}</ul>${liftTable}${runList}${eatList}` +
    `<p class="note">Everything below the first card is from OpenStreetMap (© OpenStreetMap contributors) and is an estimate: it is what volunteers have drawn, ` +
    `so lifts and especially runs can be missing, split or graded differently${own.lifts || own.slopes ? ', which is why the resort\u2019s own counts are shown first' : ''}. ` +
    `Lift heights come from the terrain model at the stations. Runs mapped in pieces count once by name and number.</p>`;
}

