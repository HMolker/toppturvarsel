/**
 * Snow depth at a tour through the winter: this season against the average
 * (and range) of the five winters before it, from NVE's seNorge model.
 *
 *   model = snowHistoryModel({ seasons: { '2020-21': { start, depth[] }, … }, current: '2025-26', today: 'YYYY-MM-DD' })
 *   el.innerHTML = snowHistorySvg(model); linkSnowHistoryHover(el, model)
 *
 * Seasons run 1 October – 30 June and are lined up by calendar day, so 29
 * February is dropped from leap winters. A missing day (seNorge's 65535, or
 * null) is left out of that day's average rather than counted as zero.
 */

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const DAY_MS = 864e5;

/** Day of the season (0 = 1 Oct) for a date, in a non-leap reference winter. */
function seasonDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const refYear = m >= 10 ? 2021 : 2022; // 2021/22 has no 29 February
  return Math.round((Date.UTC(refYear, m - 1, d) - Date.UTC(2021, 9, 1)) / DAY_MS);
}
const REF_DAYS = 273;
const dateOfDay = (i) => new Date(Date.UTC(2021, 9, 1) + i * DAY_MS);

/** One season's depths re-indexed to the reference winter (leap day removed). */
function align(season) {
  const out = new Array(REF_DAYS).fill(null);
  const t0 = Date.parse(`${season.start}T00:00:00Z`);
  season.depth.forEach((v, i) => {
    const d = new Date(t0 + i * DAY_MS);
    if (d.getUTCMonth() === 1 && d.getUTCDate() === 29) return;
    const k = seasonDay(d.toISOString().slice(0, 10));
    if (k >= 0 && k < REF_DAYS) out[k] = Number.isFinite(v) && v !== 65535 ? v : null;
  });
  return out;
}

export function snowHistoryModel({ seasons, current, today, years = 5 }) {
  const keys = Object.keys(seasons).sort();
  const past = keys.filter((k) => k < current).slice(-years);
  const aligned = Object.fromEntries(keys.map((k) => [k, align(seasons[k])]));
  const avg = [], lo = [], hi = [];
  for (let i = 0; i < REF_DAYS; i++) {
    const vals = past.map((k) => aligned[k][i]).filter((v) => v !== null);
    avg.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    lo.push(vals.length ? Math.min(...vals) : null);
    hi.push(vals.length ? Math.max(...vals) : null);
  }
  const todayIdx = Math.min(REF_DAYS - 1, Math.max(0, seasonDay(today)));
  const cur = (aligned[current] ?? []).map((v, i) => (i <= todayIdx ? v : null));
  // Today's value: the last known day up to today.
  let t = todayIdx;
  while (t > 0 && cur[t] === null) t--;
  const now = cur[t];
  const ref = avg[t];
  return {
    past, current, today, todayIdx: t, now, avg, lo, hi, cur,
    pct: Number.isFinite(now) && ref > 0 ? Math.round((100 * (now - ref)) / ref) : null,
    avgNow: ref,
    label: (k) => `${k.slice(0, 4)}/${k.slice(5)}`,
  };
}

const W = 600, H = 250, L = 40, R = 14, T = 16, B = 26;
const x = (i) => L + (i / (REF_DAYS - 1)) * (W - L - R);

function scaleY(m) {
  const top = Math.max(50, ...m.hi.filter(Number.isFinite), ...m.cur.filter(Number.isFinite));
  const step = top > 200 ? 50 : 25;
  const max = Math.ceil(top / step) * step;
  return { max, step, y: (v) => T + (1 - v / max) * (H - T - B) };
}

function path(vals, y) {
  let d = '', pen = false;
  vals.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return (pen = false);
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function band(lo, hi, y) {
  // One closed shape per run of days that have both bounds.
  let out = '';
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      out += `M${run.map((i) => `${x(i).toFixed(1)} ${y(hi[i]).toFixed(1)}`).join(' L')}` +
        ` L${run.slice().reverse().map((i) => `${x(i).toFixed(1)} ${y(lo[i]).toFixed(1)}`).join(' L')} Z`;
    }
    run = [];
  };
  lo.forEach((v, i) => (v !== null && hi[i] !== null ? run.push(i) : flush()));
  flush();
  return out;
}

const fmtDate = (i) => {
  const d = dateOfDay(i);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};

export function snowHistorySvg(m, { lastWinter = false, note = '' } = {}) {
  const { max, step, y } = scaleY(m);
  let grid = '';
  for (let v = 0; v <= max; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="shgrid${v === 0 ? ' base' : ''}"/>` +
      `<text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="shax" text-anchor="end">${v}</text>`;
  }
  let months = '';
  MONTHS.forEach((mo, k) => {
    const i = seasonDay(`${k < 3 ? 2021 : 2022}-${String(((k + 9) % 12) + 1).padStart(2, '0')}-01`);
    months += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${H - B}" y2="${H - B + 4}" class="shtick"/>` +
      `<text x="${(x(i) + 3).toFixed(1)}" y="${H - B + 15}" class="shax">${mo}</text>`;
  });
  const ti = m.todayIdx;
  const tx = x(ti), ty = Number.isFinite(m.now) && !lastWinter ? y(m.now) : null;
  const curName = `${lastWinter ? 'Last winter' : 'This winter'} ${m.label(m.current)}${note ? ` (${note})` : ''}`;
  const first = m.label(m.past[0] ?? m.current), last = m.label(m.past[m.past.length - 1] ?? m.current);
  // Label for today's marker: to the left once past mid-winter, so it stays inside.
  const left = ti > REF_DAYS * 0.6;
  const cmp = m.pct === null ? '' : `${m.pct >= 0 ? '+' : '−'}${Math.abs(m.pct)} % vs average`;
  return (
    `<div class="shlegend">` +
    `<span><svg width="22" height="8" aria-hidden="true"><line x1="1" x2="21" y1="4" y2="4" class="shcur"/></svg>${esc(curName)}</span>` +
    `<span><svg width="22" height="8" aria-hidden="true"><line x1="1" x2="21" y1="4" y2="4" class="shavg"/></svg>Average ${esc(first)}–${esc(last)}</span>` +
    `<span><svg width="14" height="10" aria-hidden="true"><rect width="14" height="10" rx="2" class="shband"/></svg>Range of those ${m.past.length} winters</span>` +
    (ty !== null ? `<span><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" class="shnow"/></svg>Today</span>` : '') +
    `</div>` +
    `<svg class="shsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Snow depth this winter against the ${m.past.length}-winter average">` +
    grid + months +
    `<path d="${band(m.lo, m.hi, y)}" class="shband"/>` +
    `<path d="${path(m.avg, y)}" class="shavg"/>` +
    `<path d="${path(m.cur, y)}" class="shcur"/>` +
    (ty !== null
      ? `<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${T}" y2="${H - B}" class="shtoday"/>` +
        `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5.5" class="shnow"/>` +
        `<text x="${(tx + (left ? -10 : 10)).toFixed(1)}" y="${(ty - 16).toFixed(1)}" class="shval" text-anchor="${left ? 'end' : 'start'}">${Math.round(m.now)} cm today</text>` +
        (cmp ? `<text x="${(tx + (left ? -10 : 10)).toFixed(1)}" y="${(ty - 3).toFixed(1)}" class="shsub" text-anchor="${left ? 'end' : 'start'}">${cmp} (${Math.round(m.avgNow)} cm)</text>` : '')
      : '') +
    `<g class="shhover" visibility="hidden"><line class="shcross" y1="${T}" y2="${H - B}"/><circle class="shdot cur" r="4"/><circle class="shdot avg" r="3.5"/></g>` +
    `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="shhit"/>` +
    `</svg>` +
    `<div class="shtip" hidden></div>`
  );
}

/** Crosshair and tooltip: the day under the pointer, this winter against the average. */
export function linkSnowHistoryHover(el, m, { hoverAt = null, lastWinter = false } = {}) {
  const svg = el.querySelector('.shsvg');
  const hit = el.querySelector('.shhit');
  const g = el.querySelector('.shhover');
  const tip = el.querySelector('.shtip');
  if (!svg || !hit) return;
  const { y } = scaleY(m);
  const show = (i) => {
    i = Math.max(0, Math.min(REF_DAYS - 1, i));
    const cx = x(i).toFixed(1);
    g.setAttribute('visibility', 'visible');
    g.querySelector('.shcross').setAttribute('x1', cx);
    g.querySelector('.shcross').setAttribute('x2', cx);
    const put = (sel, v) => {
      const c = g.querySelector(sel);
      if (Number.isFinite(v)) {
        c.setAttribute('cx', cx);
        c.setAttribute('cy', y(v).toFixed(1));
        c.setAttribute('visibility', 'visible');
      } else c.setAttribute('visibility', 'hidden');
    };
    put('.shdot.cur', m.cur[i]);
    put('.shdot.avg', m.avg[i]);
    const r = (v) => (Number.isFinite(v) ? `${Math.round(v)} cm` : '—');
    tip.innerHTML =
      `<b>${fmtDate(i)}</b>` +
      `<span><i class="k cur"></i>${lastWinter ? 'Last winter' : 'This winter'} <em>${i <= m.todayIdx ? r(m.cur[i]) : 'not yet'}</em></span>` +
      `<span><i class="k avg"></i>Average <em>${r(m.avg[i])}</em></span>` +
      `<span><i class="k band"></i>Range <em>${Number.isFinite(m.lo[i]) ? `${Math.round(m.lo[i])}–${Math.round(m.hi[i])} cm` : '—'}</em></span>`;
    tip.hidden = false;
    const box = svg.getBoundingClientRect(), host = el.getBoundingClientRect();
    const px = box.left - host.left + (x(i) / W) * box.width;
    tip.style.left = `${Math.min(host.width - 170, Math.max(0, px + 12))}px`;
    tip.style.top = `${box.top - host.top + 18}px`;
  };
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    show(Math.round(((sx - L) / (W - L - R)) * (REF_DAYS - 1)));
  });
  hit.addEventListener('pointerleave', () => {
    g.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
  if (hoverAt) show(seasonDay(hoverAt));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
