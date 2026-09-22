/**
 * "Weather on the route" (v5.1): MET Norway's hourly forecast at the start
 * and at the highest point, side by side, every two hours for the next day
 * and a half, in Norwegian local time. Strong wind and snowfall stand out.
 */

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

export function renderWeather(el, data, { labels = ['Start', 'Highest point'] } = {}) {
  if (!data) { el.innerHTML = '<p class="note">Asking MET Norway…</p>'; return; }
  if (data.error) { el.innerHTML = `<p class="warnline">No forecast: ${esc(data.error)}</p>`; return; }
  const pts = data.points ?? [];
  if (!pts.length || !pts[0].hours?.length) { el.innerHTML = '<p class="note">MET Norway returned no hourly forecast here.</p>'; return; }
  // Every second hour, from now, 36 hours.
  const now = Date.now() - 3600e3;
  const pick = (hours) => hours.filter((h) => Date.parse(h.time) >= now).slice(0, 37);
  const series = pts.map((p) => pick(p.hours));
  const times = series[0].filter((_, i) => i % 2 === 0).map((h) => h.time);
  const at = (s, t) => s.find((h) => h.time === t);

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
  for (const t of times) {
    const d = dayKey(t);
    if (d !== lastDay) {
      rows += `<tr class="wday"><th colspan="${1 + 3 * pts.length}">${esc(fmtDay(t))}</th></tr>`;
      lastDay = d;
    }
    rows += `<tr><th>${fmtHour(t)}</th>${series.map((s) => cell(at(s, t))).join('')}</tr>`;
  }
  const head = `<tr><th></th>${pts.map((p, k) => `<th colspan="3">${esc(labels[k] ?? '')} ${p.altitude ?? ''} m</th>`).join('')}</tr>` +
    `<tr class="note"><th></th>${pts.map(() => '<th>°C</th><th>m/s (gust)</th><th>mm / sky</th>').join('')}</tr>`;
  const upd = pts[0].updatedAt ? new Date(pts[0].updatedAt).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '';
  el.innerHTML = `<div class="wsums">${summary}</div>` +
    `<div class="wtablewrap"><table class="wtable">${head}${rows}</table></div>` +
    `<p class="attrib">Forecast © MET Norway (yr.no), CC BY 4.0, each point at its own height${upd ? `, updated ${esc(upd)}` : ''}. Wind at 10 m above the ground; ridges can be much windier. Bold red: wind or gusts 15 m/s and over.</p>`;
}
