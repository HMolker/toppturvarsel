import { COAST, BORDER } from './geo.js';
import { esc } from './esc.js';

/**
 * The forecast-accuracy tool (/skill): how well the forecast has done, by
 * how far ahead it was made and by where.
 *
 * Everything on the page comes from /api/skill, which is built from the
 * forecasts the server has kept and the days it has since observed (see
 * src/verify.js). Until a winter of those exist there is nothing to show,
 * so "Sample data" fills the page with made-up figures of a realistic
 * shape — clearly marked — to show what it will look like.
 */

const $ = (s, el = document) => el.querySelector(s);
const LEADS = [1, 3, 5, 10, 15];
const RAMP = ['--hs1', '--hs2', '--hs3', '--hs4', '--hs5', '--hs6'];
const STEPS = [0.06, 0.15, 0.28, 0.42, 0.6];
const PARAM_ORDER = ['snow', 'temp', 'cloud', 'wind', 'all'];
const NOTE = {
  snow: 'New snow in the day, and whether 5 cm of it fell.',
  temp: "The day's highest temperature.",
  cloud: 'Mean cloud cover — a bluebird day is under 30 %.',
  wind: "The day's strongest wind.",
  all: 'All four together, weighted: snow 40 %, temperature 25 %, wind 20 %, cloud 15 %.',
};

const state = { data: null, sample: false, param: 'snow', leadIdx: 2, cell: null };

/* ------------------------------------------------------------------ *
 * drawing helpers
 * ------------------------------------------------------------------ */

const KX = Math.cos((63 * Math.PI) / 180);
const rampColor = (v) => {
  let i = 0;
  while (i < STEPS.length && v >= STEPS[i]) i++;
  return `var(${RAMP[i]})`;
};
const pct = (v) => `${Math.round(v * 100)} %`;
const fx = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function frameOf(cells, W, H, pad = 12) {
  const lats = [...cells.map((c) => c.lat + c.dLat), ...cells.map((c) => c.lat - c.dLat)];
  const lons = [...cells.map((c) => c.lon + c.dLon), ...cells.map((c) => c.lon - c.dLon)];
  const la0 = Math.min(...lats) - 0.4, la1 = Math.max(...lats) + 0.4;
  const lo0 = Math.min(...lons) - 0.6, lo1 = Math.max(...lons) + 0.6;
  const s = Math.min((W - 2 * pad) / ((lo1 - lo0) * KX), (H - 2 * pad) / (la1 - la0));
  const offX = pad + ((W - 2 * pad) - (lo1 - lo0) * KX * s) / 2;
  const offY = pad + ((H - 2 * pad) - (la1 - la0) * s) / 2;
  return {
    x: (lon) => offX + (lon - lo0) * KX * s,
    y: (lat) => offY + (la1 - lat) * s,
  };
}

const svg = (viewBox, body, label) =>
  `<svg class="routesvg" viewBox="${viewBox}" role="img" aria-label="${esc(label)}">${body}</svg>`;

/* ------------------------------------------------------------------ *
 * the map
 * ------------------------------------------------------------------ */

function drawMap() {
  const el = $('#skillMap');
  const cells = state.data.cells;
  const lead = LEADS[state.leadIdx];
  const W = 560, H = 620;
  if (!cells.length) {
    el.innerHTML = '<p class="note">No cell has enough scored days yet.</p>';
    $('#skillLegend').innerHTML = '';
    return;
  }
  const f = frameOf(cells, W, H);
  const line = (pts, extra) =>
    `<polyline points="${pts.map(([la, lo]) => `${f.x(lo).toFixed(1)},${f.y(la).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--coast)" ${extra}/>`;

  const tiles = cells.map((c, i) => {
    const sc = c.leads[lead]?.[state.param];
    const x = f.x(c.lon - c.dLon / 2), y = f.y(c.lat + c.dLat / 2);
    const w = Math.max(5, f.x(c.lon + c.dLon / 2) - x) + 0.4;
    const h = Math.max(5, f.y(c.lat - c.dLat / 2) - y) + 0.4;
    const has = sc?.enough && sc.skill != null;
    const title = `${c.label} · ${has ? `${fx(sc.skill)} skill, ${sc.n} days` : `${sc?.n ?? 0} days scored — not enough yet`}`;
    return `<g class="skcell" data-i="${i}" tabindex="0" role="button" aria-label="${esc(title)}">` +
      `<title>${esc(title)}</title>` +
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
      `fill="${has ? rampColor(sc.skill) : 'var(--line)'}" stroke="${has ? 'none' : 'var(--line-2)'}" stroke-width="0.5"/></g>`;
  }).join('');

  const sel = state.cell;
  const ring = sel
    ? `<rect x="${(f.x(sel.lon - sel.dLon / 2) - 2).toFixed(1)}" y="${(f.y(sel.lat + sel.dLat / 2) - 2).toFixed(1)}" ` +
      `width="${(f.x(sel.lon + sel.dLon / 2) - f.x(sel.lon - sel.dLon / 2) + 4).toFixed(1)}" ` +
      `height="${(f.y(sel.lat - sel.dLat / 2) - f.y(sel.lat + sel.dLat / 2) + 4).toFixed(1)}" ` +
      `fill="none" stroke="var(--ink)" stroke-width="1.8"/>`
    : '';

  el.innerHTML = svg(`0 0 ${W} ${H}`,
    `<rect width="${W}" height="${H}" fill="var(--page)"/>` +
    `<polygon points="${COAST.map(([la, lo]) => `${f.x(lo).toFixed(1)},${f.y(la).toFixed(1)}`).join(' ')}" fill="var(--land)" stroke="none"/>` +
    line(COAST, 'stroke-width="1"') + line(BORDER, 'stroke-width="0.8" stroke-dasharray="4 3" opacity="0.8"') +
    tiles + ring,
    `Forecast skill ${lead} days ahead`);

  $('#skillLegend').innerHTML =
    `<span class="note">no skill</span>` +
    RAMP.map((v) => `<span class="skkey" style="background:var(${v})"></span>`).join('') +
    `<span class="note">perfect</span>` +
    `<span><span class="skkey none"></span>too few days</span>`;

  el.querySelectorAll('.skcell').forEach((g) => {
    const pick = () => selectCell(cells[Number(g.dataset.i)]);
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
  $('#mapNote').textContent = `${NOTE[state.param]} ${lead} day${lead > 1 ? 's' : ''} ahead.`;
}

/* ------------------------------------------------------------------ *
 * charts
 * ------------------------------------------------------------------ */

/** Skill against lead time: the chosen parameter in red, the rest behind it. */
function decayChart(leadsOf, highlight) {
  const W = 420, H = 180, l = 38, r = 12, t = 12, b = 28;
  const px = (i) => l + (i / (LEADS.length - 1)) * (W - l - r);
  const py = (v) => t + (1 - v) * (H - t - b);
  let g = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    g += `<line x1="${l}" x2="${W - r}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="${l - 6}" y="${(py(v) + 3.5).toFixed(1)}" text-anchor="end" class="maplabel">${v.toFixed(2)}</text>`;
  }
  for (const p of PARAM_ORDER) {
    const pts = LEADS.map((L, i) => {
      const sc = leadsOf(L, p);
      return sc?.enough && sc.skill != null ? `${px(i).toFixed(1)},${py(sc.skill).toFixed(1)}` : null;
    });
    const runs = [];
    let cur = [];
    for (const p2 of pts) { if (p2) cur.push(p2); else if (cur.length) { runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);
    const on = p === highlight;
    for (const run of runs) {
      if (run.length < 2) {
        const [x, y] = run[0].split(',');
        g += `<circle cx="${x}" cy="${y}" r="${on ? 4 : 2}" fill="${on ? 'var(--own)' : 'var(--steel)'}"/>`;
        continue;
      }
      g += `<polyline points="${run.join(' ')}" fill="none" stroke="${on ? 'var(--own)' : 'var(--steel)'}" ` +
        `stroke-width="${on ? 2.4 : 1}" opacity="${on ? 1 : 0.5}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    if (on) LEADS.forEach((L, i) => {
      const sc = leadsOf(L, p);
      if (!sc?.enough || sc.skill == null) return;
      const big = i === state.leadIdx;
      g += `<circle cx="${px(i).toFixed(1)}" cy="${py(sc.skill).toFixed(1)}" r="${big ? 4.5 : 2.6}" fill="var(--own)"/>`;
      if (big) g += `<text x="${px(i).toFixed(1)}" y="${(py(sc.skill) - 9).toFixed(1)}" text-anchor="middle" class="maplabel strong">${fx(sc.skill)}</text>`;
    });
  }
  LEADS.forEach((L, i) => {
    g += `<text x="${px(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" class="maplabel">${L} d</text>`;
  });
  return svg(`0 0 ${W} ${H}`, g, 'Skill against forecast length');
}

/** All four parameters at the chosen lead time, as bars. */
function barsChart(per) {
  const W = 420, H = 150, l = 96, r = 40, t = 8, b = 18;
  const keys = PARAM_ORDER;
  const bh = (H - t - b) / keys.length;
  let g = '';
  keys.forEach((k, i) => {
    const sc = per[k];
    const y = t + i * bh + 3;
    const h = bh - 8;
    const w = W - l - r;
    g += `<text x="${l - 8}" y="${(y + h / 2 + 4).toFixed(1)}" text-anchor="end" class="maplabel${k === state.param ? ' strong' : ''}">${esc(state.data.params[k]?.label ?? 'All four')}</text>`;
    g += `<rect x="${l}" y="${y.toFixed(1)}" width="${w}" height="${h.toFixed(1)}" fill="var(--line)" opacity="0.5"/>`;
    if (sc?.enough && sc.skill != null) {
      g += `<rect x="${l}" y="${y.toFixed(1)}" width="${(w * sc.skill).toFixed(1)}" height="${h.toFixed(1)}" fill="${rampColor(sc.skill)}"/>`;
      g += `<text x="${W - r + 6}" y="${(y + h / 2 + 4).toFixed(1)}" class="maplabel">${fx(sc.skill)}</text>`;
    } else {
      g += `<text x="${W - r + 6}" y="${(y + h / 2 + 4).toFixed(1)}" class="maplabel">${sc?.n ?? 0} d</text>`;
    }
  });
  return svg(`0 0 ${W} ${H}`, g, 'Every parameter at this lead time');
}

/* ------------------------------------------------------------------ *
 * panels
 * ------------------------------------------------------------------ */

function statsHtml(sc, key) {
  if (!sc) return '';
  const p = state.data.params[key];
  const cards = [];
  if (sc.enough && sc.skill != null) {
    cards.push(`<li><b>${fx(sc.skill)}</b><span>skill against normal for the time of year<br>0 = no better, 1 = perfect</span></li>`);
  } else {
    cards.push(`<li><b>${sc.n ?? 0}</b><span>days scored — ${state.data.minCases} needed before a score is shown</span></li>`);
  }
  if (sc.enough && p) {
    cards.push(`<li><b>${fx(sc.mae, 1)} ${esc(p.unit)}</b><span>average miss${sc.climMae != null ? ` · saying "normal" misses by ${fx(sc.climMae, 1)}` : ''}</span></li>`);
    cards.push(`<li><b>${sc.bias > 0 ? '+' : '−'}${fx(Math.abs(sc.bias), 1)} ${esc(p.unit)}</b><span>bias — the forecast runs ${sc.bias > 0 ? 'high' : 'low'} here</span></li>`);
    if (sc.pod != null) {
      const what = key === 'cloud' ? 'bluebird days' : `days with ${p.event} ${p.unit}`;
      cards.push(`<li><b>${pct(sc.pod)}</b><span>of ${esc(what)} were forecast</span></li>`);
      cards.push(`<li><b>${pct(sc.far)}</b><span>of the ${esc(what)} forecast did not happen</span></li>`);
    }
    cards.push(`<li><b>${sc.n}</b><span>days behind this</span></li>`);
  }
  return `<ul class="rsfacts">${cards.join('')}</ul>`;
}

function selectCell(cell) {
  state.cell = cell;
  const lead = LEADS[state.leadIdx];
  const per = cell.leads[lead] ?? {};
  $('#cellName').textContent = cell.label;
  $('#cellCoord').textContent =
    `${cell.lat.toFixed(2)}° N ${cell.lon.toFixed(2)}° E · 25 km cell` +
    (cell.names?.length > 1 ? ` · ${cell.names.slice(0, 3).map(esc).join(', ')}` : '');
  $('#cellStats').innerHTML = statsHtml(per[state.param], state.param);
  $('#decayChart').innerHTML = decayChart((L, p) => cell.leads[L]?.[p], state.param);
  const sc = per[state.param];
  $('#decayNote').textContent = !sc?.enough || sc.skill == null
    ? 'Not enough scored days in this cell yet at this lead time.'
    : sc.skill > 0.55 ? 'Still worth acting on at this range.'
      : sc.skill > 0.3 ? 'Useful as a lean, not as a plan.'
        : 'At this range, "normal for the time of year" is nearly as good a guess.';
  $('#barsChart').innerHTML = barsChart(per);
  $('#barsNote').textContent = `At ${lead} day${lead > 1 ? 's' : ''} ahead, in this cell. Bars show skill; a cell without enough days shows its day count instead.`;
  drawMap();
}

/** The average across every cell that has a score. */
function overall() {
  const rows = [];
  for (const p of PARAM_ORDER) {
    const vals = LEADS.map((L) => {
      const xs = state.data.cells
        .map((c) => c.leads[L]?.[p])
        .filter((sc) => sc?.enough && sc.skill != null)
        .map((sc) => sc.skill);
      return xs.length ? { skill: xs.reduce((a, b) => a + b, 0) / xs.length, cells: xs.length } : null;
    });
    rows.push({ p, vals });
  }
  $('#overallChart').innerHTML = decayChart((L, p) => {
    const v = rows.find((r) => r.p === p)?.vals[LEADS.indexOf(L)];
    return v ? { enough: true, skill: v.skill } : { enough: false };
  }, state.param);

  $('#overallTable').innerHTML =
    `<thead><tr><th>What</th>${LEADS.map((L) => `<th class="num">${L} d</th>`).join('')}<th class="num">cells</th></tr></thead><tbody>` +
    rows.map(({ p, vals }) =>
      `<tr${p === state.param ? ' class="on"' : ''}><td>${esc(state.data.params[p]?.label ?? 'All four')}</td>` +
      vals.map((v) => `<td class="num">${v ? fx(v.skill) : '—'}</td>`).join('') +
      `<td class="num">${Math.max(0, ...vals.map((v) => v?.cells ?? 0))}</td></tr>`).join('') +
    '</tbody>';
}

function render() {
  drawMap();
  overall();
  if (state.cell) {
    const again = state.data.cells.find((c) => c.key === state.cell.key);
    selectCell(again ?? state.data.cells[0]);
  } else if (state.data.cells.length) {
    const best = state.data.cells.find((c) => c.leads[LEADS[state.leadIdx]]?.[state.param]?.enough) ?? state.data.cells[0];
    selectCell(best);
  }
}

/* ------------------------------------------------------------------ *
 * made-up figures, for a tool that has not collected a winter yet
 * ------------------------------------------------------------------ */

function sampleData(real) {
  const field = (lat, lon, k) =>
    Math.max(0, Math.min(1, 0.52 + 0.26 * Math.sin(lat * (0.9 + k * 0.11) + lon * 0.55 + k) +
      0.15 * Math.sin(lat * 0.42 - lon * 0.78 + k * 1.7) + 0.07 * Math.sin(lat * 2.1 + lon * 1.4 + k * 0.5)));
  const SHAPE = { snow: [0.8, 5.2], temp: [0.93, 15], cloud: [0.82, 7], wind: [0.74, 6.2] };
  const W = { snow: 0.4, temp: 0.25, cloud: 0.15, wind: 0.2 };
  const cells = (real?.cells?.length ? real.cells : sampleCells()).map((c, i) => {
    const leads = {};
    for (const L of LEADS) {
      const per = {};
      let sw = 0, ss = 0;
      Object.entries(SHAPE).forEach(([p, [a, tau]], k) => {
        const ridge = Math.exp(-Math.pow((c.lon - (5.2 + (c.lat - 58) * 0.78)) / 2.6, 2));
        const base = a * Math.exp(-L / tau) * (p === 'snow' || p === 'cloud' ? 1 - 0.3 * ridge : 1 - 0.1 * ridge);
        const skill = Math.max(0, Math.min(0.97, base * (0.85 + 0.3 * field(c.lat, c.lon, k + 1))));
        const n = 40 + Math.round(120 * field(c.lat, c.lon, k + 4));
        const unit = p === 'temp' ? 1 : p === 'snow' ? 3 : p === 'cloud' ? 18 : 2;
        per[p] = {
          enough: true, n, skill: +skill.toFixed(3),
          mae: +(unit * (0.6 + 0.5 * L ** 0.5) * (1 - 0.4 * skill)).toFixed(2),
          climMae: +(unit * 1.8).toFixed(2),
          bias: +((field(c.lat, c.lon, k + 7) - 0.5) * unit).toFixed(2),
          ...(p === 'snow' || p === 'cloud'
            ? { pod: +(0.3 + 0.65 * skill).toFixed(3), far: +(0.46 - 0.38 * skill).toFixed(3), rate: 0.22 }
            : {}),
        };
        sw += W[p];
        ss += W[p] * skill;
      });
      per.all = { enough: true, n: per.snow.n, skill: +(ss / sw).toFixed(3) };
      leads[L] = per;
    }
    return { ...c, key: c.key ?? `s${i}`, leads };
  });
  return {
    cells,
    leads: LEADS,
    params: real?.params ?? {
      snow: { label: 'New snow', unit: 'cm', event: 5 },
      temp: { label: 'Temperature', unit: '°C' },
      cloud: { label: 'Sun and cloud', unit: '%', event: 30, below: true },
      wind: { label: 'Wind', unit: 'm/s' },
    },
    minCases: real?.minCases ?? 30,
    collecting: real?.collecting ?? null,
    sample: true,
    source: 'Made-up figures, to show what the page will look like.',
  };
}

/** Somewhere to put the sample cells when the tour list has not loaded. */
function sampleCells() {
  const out = [];
  const spots = [
    ['Lyngen', 69.6, 20.2], ['Narvik', 68.44, 17.43], ['Riksgränsen', 68.43, 18.13], ['Lofoten', 68.24, 14.0],
    ['Hemavan', 65.82, 15.08], ['Mo i Rana', 66.31, 14.14], ['Åre', 63.4, 13.08], ['Oppdal', 62.59, 9.69],
    ['Sunnmøre', 62.3, 6.7], ['Vemdalen', 62.51, 13.94], ['Sogndal', 61.23, 7.1], ['Jotunheimen', 61.5, 8.3],
    ['Hemsedal', 60.86, 8.51], ['Sälen', 61.17, 13.12], ['Voss', 60.63, 6.42], ['Geilo', 60.53, 8.21],
    ['Trysil', 61.32, 12.27], ['Rjukan', 59.88, 8.59], ['Hovden', 59.57, 7.36], ['Idre', 61.9, 12.78],
  ];
  for (const [name, lat, lon] of spots) {
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        out.push({
          key: `${name}${a}${b}`, label: name, names: [name],
          lat: +(lat + a * 0.225).toFixed(4), lon: +(lon + b * 0.45).toFixed(4),
          dLat: 0.225, dLon: 0.45,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * controls
 * ------------------------------------------------------------------ */

function buildControls() {
  const seg = $('#params');
  seg.innerHTML = PARAM_ORDER.map((p) =>
    `<button type="button" class="btn small" data-p="${p}" aria-pressed="${p === state.param}">` +
    `${esc(p === 'all' ? 'All four' : state.data.params[p]?.label ?? p)}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.param = b.dataset.p;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.p === state.param)));
    $('#paramNote').textContent = NOTE[state.param];
    render();
  }));
  $('#paramNote').textContent = NOTE[state.param];
  $('#ticks').innerHTML = LEADS.map((L) => `<span>${L}</span>`).join('');
  const lead = $('#lead');
  lead.addEventListener('input', () => {
    state.leadIdx = Number(lead.value);
    $('#leadval').innerHTML = `${LEADS[state.leadIdx]}<span> d</span>`;
    render();
  });
  $('#sampleBtn').addEventListener('click', toggleSample);
}

function toggleSample() {
  state.sample = !state.sample;
  $('#sampleBtn').classList.toggle('on', state.sample);
  $('#sampleBtn').textContent = state.sample ? 'Leave sample data' : 'Sample data';
  state.cell = null;
  state.data = state.sample ? sampleData(state.real) : state.real;
  banner();
  render();
}

function banner() {
  const c = state.real?.collecting;
  const dot = $('#collectDot'), txt = $('#collectTxt');
  if (state.sample) {
    dot.className = 'dot warn';
    txt.textContent = 'Sample data — made-up figures';
  } else if (!c || !c.passes) {
    dot.className = 'dot bad';
    txt.textContent = 'not collecting yet';
  } else {
    const scored = state.real.cells.length;
    dot.className = scored ? 'dot ok' : 'dot warn';
    txt.textContent = scored
      ? `${scored} of ${c.cells} cells scored · collecting since ${c.since}`
      : `collecting since ${c.since} · ${c.observedDays} days observed, none scored yet`;
  }
  $('#sourceNote').textContent = state.data?.source ?? '';
  $('#minCases').textContent = String(state.data?.minCases ?? 30);
}

async function load() {
  let real = null;
  try {
    const res = await fetch('/api/skill');
    real = res.ok ? await res.json() : null;
  } catch {
    /* offline: sample data still works */
  }
  state.real = real;
  const empty = !real || !real.cells.length;
  state.sample = empty;
  state.data = empty ? sampleData(real) : real;
  if (empty) {
    $('#sampleBtn').classList.add('on');
    $('#sampleBtn').textContent = 'Leave sample data';
  }
  buildControls();
  banner();
  if (empty) {
    const c = real?.collecting;
    $('#mapNote').textContent = '';
    $('#controlsCard').insertAdjacentHTML('afterbegin',
      `<p class="note warnline">Nothing has been scored yet${c?.since ? `, collecting since ${esc(c.since)}` : ''}. ` +
      `The first 1-day scores appear after a couple of days, the 15-day ones after a fortnight. ` +
      `Meanwhile this page is showing <b>made-up figures</b> so you can see what it will look like.</p>`);
  }
  render();
}

load();
