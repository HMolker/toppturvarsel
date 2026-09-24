/**
 * "Weather on the route" (v5.1): MET Norway's hourly forecast at the start
 * and at the highest point, side by side, every two hours for the next day
 * and a half, in Norwegian local time. Strong wind and snowfall stand out.
 */

import { sunTimes } from '../daylight.js';
import { hourScore } from '../daywindow.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TZ = 'Europe/Oslo';
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const fromDir = (d) => (Number.isFinite(d) ? COMPASS[Math.round(d / 45) % 8] : '');

/** MET's symbol codes in words: "lightsnowshowers_day" -> "light snow showers". */
export function symbolText(code) {
  if (!code) return '';
  const base = code.replace(/_(day|night|polartwilight)$/, '');
  const words = {
    clearsky: 'clear', fair: 'fair', partlycloudy: 'partly cloudy', cloudy: 'cloudy', fog: 'fog',
  };
  if (words[base]) return words[base];
  return base
    .replace(/andthunder/, ' and thunder')
    .replace(/^(light|heavy)/, '$1 ')
    .replace(/showers/, ' showers')
    .replace(/sleet|snow|rain/, (m) => m)
    .replace(/\s+/g, ' ')
    .trim();
}

const fmtHour = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const fmtDay = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(iso));
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const isSnow = (h) => /snow|sleet/.test(h.symbol ?? '') || (Number.isFinite(h.temp) && h.temp <= 0.5);

/** Totals and extremes over the hours shown, per point. */
export function summarise(hours) {
  const t = hours.map((h) => h.temp).filter(Number.isFinite);
  const w = hours.map((h) => h.wind).filter(Number.isFinite);
  const g = hours.map((h) => h.gust).filter(Number.isFinite);
  const snow = hours.filter(isSnow).reduce((s, h) => s + (h.precip ?? 0), 0);
  const rain = hours.filter((h) => !isSnow(h)).reduce((s, h) => s + (h.precip ?? 0), 0);
  return {
    tMin: t.length ? Math.min(...t) : null, tMax: t.length ? Math.max(...t) : null,
    windMax: w.length ? Math.max(...w) : null, gustMax: g.length ? Math.max(...g) : null,
    snowMm: Math.round(snow * 10) / 10, rainMm: Math.round(rain * 10) / 10,
  };
}

function cell(h) {
  if (!h) return '<td></td><td></td><td></td>';
  const windy = (h.gust ?? h.wind ?? 0) >= 15;
  const p = h.precip ?? 0;
  return `<td class="wt">${Number.isFinite(h.temp) ? `${Math.round(h.temp)}°` : '–'}</td>` +
    `<td class="${windy ? 'hot' : ''}">${Number.isFinite(h.wind) ? Math.round(h.wind) : '–'}${Number.isFinite(h.gust) ? `<span class="note">(${Math.round(h.gust)})</span>` : ''} <span class="note">${fromDir(h.dir)}</span></td>` +
    `<td title="${esc(symbolText(h.symbol))}">${p >= 0.1 ? `<b>${p.toFixed(1)}</b>${isSnow(h) ? ' snow' : ''}` : `<span class="note">${esc(symbolText(h.symbol))}</span>`}</td>`;
}

/** Hour of day (decimal) in Norwegian time. */
const localHour = (iso) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  return +p.find((x) => x.type === 'hour').value + +p.find((x) => x.type === 'minute').value / 60;
};
const BAND = ['poor', 'fair', 'good', 'very good'];
/** The planner's hour score (wind, sky, snow or rain), banded as on the conditions page. */
function band(h) {
  if (!h) return null;
  const snow = isSnow(h) ? h.precip ?? 0 : 0;
  const s = hourScore({ wind: [h.wind], gust: [h.gust], cloud: [h.cloud], snow: [snow], precip: [h.precip ?? 0], temp: [h.temp] }, 0);
  return s >= 0.75 ? 4 : s >= 0.6 ? 3 : s >= 0.45 ? 2 : 1;
}

/**
 * The table: daylight hours only, hour by hour for the next two days; each
 * hour marked poor → very good as on the conditions page (from the higher
 * point, where the weather is worse); the best hours for the tour boxed —
 * the planned departure to return when a tour is built (`plan`: { iso,
 * from, to }), else the best block of `needH` hours in each day's light.
 */
export function renderWeather(el, data, { labels = ['Start', 'Highest point'], lat = null, lon = null, needH = null, plan = null } = {}) {
  if (!data) { el.innerHTML = '<p class="note">Asking MET Norway…</p>'; return; }
  if (data.error) { el.innerHTML = `<p class="warnline">No forecast: ${esc(data.error)}</p>`; return; }
  const pts = data.points ?? [];
  if (!pts.length || !pts[0].hours?.length) { el.innerHTML = '<p class="note">MET Norway returned no hourly forecast here.</p>'; return; }
  const now = Date.now() - 3600e3;
  const pick = (hours) => hours.filter((h) => Date.parse(h.time) >= now && Date.parse(h.time) < now + 50 * 3600e3);
  const series = pts.map((p) => pick(p.hours));
  const at = (s, t) => s.find((h) => h.time === t);
  const top = series[series.length - 1];

  // Daylight per day (civil dawn to dusk), where the point is known.
  const light = new Map();
  const lightOf = (iso) => {
    const d = dayKey(iso);
    if (!light.has(d)) light.set(d, Number.isFinite(lat) && Number.isFinite(lon) ? sunTimes(d, lat, lon).light : { start: 0, end: 24 });
    return light.get(d);
  };
  const times = series[0].map((h) => h.time).filter((t) => {
    const L = lightOf(t);
    const hr = localHour(t);
    return L && hr >= Math.floor(L.start) && hr <= L.end;
  });

  // The boxed hours per day.
  const boxed = new Map(); // day -> [from, to)
  const byDay = new Map();
  for (const t of times) (byDay.get(dayKey(t)) ?? byDay.set(dayKey(t), []).get(dayKey(t))).push(t);
  for (const [d, ts] of byDay) {
    if (plan && plan.iso === d && Number.isFinite(plan.from)) { boxed.set(d, [plan.from, plan.to, 'planned']); continue; }
    const n = Math.max(1, Math.ceil(needH ?? 0));
    if (!needH || ts.length < n) continue;
    let best = null;
    for (let i = 0; i + n <= ts.length; i++) {
      const w = ts.slice(i, i + n).map((t) => band(at(top, t)) ?? 2);
      const m = w.reduce((a, b) => a + b, 0) / n;
      if (!best || m > best.m + 1e-9) best = { m, from: localHour(ts[i]), to: localHour(ts[i + n - 1]) + 1 };
    }
    if (best) boxed.set(d, [best.from, best.to, 'best']);
  }

  const sums = series.map(summarise);
  const summary = pts.map((p, k) => {
    const s = sums[k];
    return `<div class="wsum"><div class="eyebrow">${esc(labels[k] ?? `Point ${k + 1}`)} · ${p.altitude ?? '–'} m</div>` +
      `<b>${s.tMin === null ? '–' : `${Math.round(s.tMin)} to ${Math.round(s.tMax)} °C`}</b>` +
      `<span>wind up to ${s.windMax === null ? '–' : Math.round(s.windMax)} m/s${s.gustMax !== null ? `, gusts ${Math.round(s.gustMax)}` : ''}</span>` +
      `<span>${s.snowMm ? `${s.snowMm} mm as snow` : 'no snow'}${s.rainMm ? `, ${s.rainMm} mm rain` : ''}</span>` +
      `${p.stale ? '<span class="warnline">older forecast: MET could not be reached</span>' : ''}</div>`;
  }).join('');

  let rows = '', lastDay = '';
  const cols = 2 + 3 * pts.length;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const d = dayKey(t);
    if (d !== lastDay) {
      const L = lightOf(t);
      const bx = boxed.get(d);
      const hh = (x) => `${String(Math.floor(x) % 24).padStart(2, '0')}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`;
      rows += `<tr class="wday"><th colspan="${cols}">${esc(fmtDay(t))}${L ? ` <span class="note">· light ${hh(L.start)}–${hh(L.end)}</span>` : ''}${bx ? ` <span class="note">· ${bx[2] === 'planned' ? 'your tour' : 'best hours'} ${hh(bx[0])}–${hh(bx[1])}</span>` : ''}</th></tr>`;
      lastDay = d;
    }
    const hr = localHour(t);
    const bx = boxed.get(d);
    const inBox = bx && hr + 1 > bx[0] + 1e-6 && hr < bx[1] - 1e-6;
    const prevIn = inBox && i > 0 && dayKey(times[i - 1]) === d && (() => { const h0 = localHour(times[i - 1]); return h0 + 1 > bx[0] + 1e-6 && h0 < bx[1] - 1e-6; })();
    const nextIn = inBox && i < times.length - 1 && dayKey(times[i + 1]) === d && (() => { const h1 = localHour(times[i + 1]); return h1 + 1 > bx[0] + 1e-6 && h1 < bx[1] - 1e-6; })();
    const b = band(at(top, t));
    const cls = [inBox ? 'wbox' : '', inBox && !prevIn ? 'wbox-first' : '', inBox && !nextIn ? 'wbox-last' : ''].filter(Boolean).join(' ');
    rows += `<tr class="${cls}"><td class="wband" style="background:${b ? `var(--hw${b})` : 'transparent'}" title="${b ? `${BAND[b - 1]} hour for touring` : ''}"></td><th>${fmtHour(t)}</th>${series.map((s) => cell(at(s, t))).join('')}</tr>`;
  }
  if (!times.length) rows = `<tr><td colspan="${cols}" class="note">No daylight hours in the next two days.</td></tr>`;
  const head = `<tr><th></th><th></th>${pts.map((p, k) => `<th colspan="3">${esc(labels[k] ?? '')} ${p.altitude ?? ''} m</th>`).join('')}</tr>` +
    `<tr class="note"><th></th><th></th>${pts.map(() => '<th>°C</th><th>m/s (gust)</th><th>mm / sky</th>').join('')}</tr>`;
  const upd = pts[0].updatedAt ? new Date(pts[0].updatedAt).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '';
  el.innerHTML = `<div class="wsums">${summary}</div>` +
    `<div class="hlegend"><span class="hlk">${[1, 2, 3, 4].map((k) => `<i style="background:var(--hw${k})"></i>`).join('')}hours in the light: poor → very good</span>` +
    `<span class="hlk"><i class="wboxkey"></i>${plan ? 'your tour, from the plan below' : 'best hours for a tour this long'}</span></div>` +
    `<div class="wtablewrap"><table class="wtable">${head}${rows}</table></div>` +
    `<p class="attrib">Forecast © MET Norway (yr.no), CC BY 4.0, each point at its own height${upd ? `, updated ${esc(upd)}` : ''}. Daylight hours only. The colour is the planner's hour score (wind, cloud, snow or rain) at the ${pts.length > 1 ? 'highest point' : 'start'}. Wind at 10 m above the ground; ridges can be much windier. Bold red: wind or gusts 15 m/s and over.</p>`;
}
