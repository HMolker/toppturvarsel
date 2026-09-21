/**
 * The "how was this scored?" box for the trip planner: the day's working
 * for one tour (filter, the five parts with their weights and points,
 * confidence) and, underneath, the method in general.
 *
 * Pure: returns an HTML string. app.js positions it.
 */
import { WEIGHTS, FRESH_CURVE } from './planner.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const pts = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');

const PARTS = [
  ['fresh', 'Fresh snow & surface'],
  ['base', 'Base'],
  ['weather', 'Weather that day'],
  ['quality', 'Tour quality'],
  ['fit', 'Fit'],
];
// One shade per part, from the profile's greys, so the stacked bar reads
// as five pieces without borrowing alert or danger colours.
const SHADE = { fresh: 'var(--ro4)', base: 'var(--ro3)', weather: 'var(--ro2)', quality: 'var(--ro1)', fit: 'var(--line-2)' };

const STATUS = {
  ok: 'Passes',
  caution: 'Passes with caution',
  excluded: 'Excluded',
  unassessed: 'Not assessed',
};
const CONF = {
  high: "High: that day's bulletin and a forecast one to three days out.",
  medium: "Medium: this day's bulletin is not out yet, so the last one is reused.",
  low: 'Weather only: four or more days out, forecast only.',
  none: 'No bulletin: the avalanche filter could not be applied, so it is not ranked.',
  noforecast: 'No avalanche forecast exists for this area. It is ranked because the terrain is gentle, but the avalanche judgement is yours alone.',
};

/** A tiny curve with a marker at x, e.g. the fresh-snow or base rule. */
function miniCurve(points, x, { xmax, label }) {
  // Curve on top, its label under the axis so the two never overlap.
  const W = 132, H = 48, AX = H - 14, px = (v) => 4 + (Math.min(v, xmax) / xmax) * (W - 8), py = (v) => AX - v * (AX - 6);
  const d = points.map(([a, b], i) => `${i ? 'L' : 'M'}${px(a).toFixed(1)} ${py(b).toFixed(1)}`).join(' ');
  const y = (() => {
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  })();
  return (
    `<svg class="xcurve" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">` +
    `<line x1="4" x2="${W - 4}" y1="${AX}" y2="${AX}" stroke="var(--line-2)"/>` +
    `<path d="${d}" fill="none" stroke="var(--steel)" stroke-width="1.5"/>` +
    (Number.isFinite(x) ? `<circle cx="${px(Math.max(0, x)).toFixed(1)}" cy="${py(y).toFixed(1)}" r="3.5" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.2"/>` : '') +
    `<text x="4" y="${H - 2}" class="xcl">${esc(label)}</text></svg>`
  );
}

const BASE_CURVE = [[0, 0], [20, 0], [100, 1], [150, 1]];

function partDetail(key, r) {
  const e = r.explain ?? {};
  switch (key) {
    case 'fresh': {
      const x = e.fresh;
      if (!x) return '';
      const lines = [
        ...(x.surface ? [`surface: <b>${esc(x.surface.label)}</b>${x.surface.windFrom ? ` (wind from ${esc(x.surface.windFrom)}, ${x.surface.windMean} m/s)` : ''}`] : []),
        `${x.observedNew72 != null ? `${Math.round(x.observedNew72)} cm new in the last 72 h (seNorge), weighted ${x.age} for its age` : 'no observed new snow'}` +
          `${x.forecastCm ? ` + ${x.forecastCm} cm forecast` : ''} = <b>${x.cm} cm</b> → ${f2(x.curve)} on the curve`,
        ...x.mods.map(([what, how]) => `${esc(what)} ${esc(how)}`),
      ];
      return `<div class="xrow2">${miniCurve(FRESH_CURVE, x.cm, { xmax: 90, label: 'best 20–40 cm' })}<div>${lines.join('<br>')}</div></div>`;
    }
    case 'base': {
      const x = e.base;
      if (!x) return '';
      const d = Number.isFinite(x.depth) ? Math.round(x.depth) : null;
      const txt = d == null
        ? 'no modelled depth for this tour; counted as 0.40'
        : `<b>${d} cm</b> modelled at the tour (1 km grid). 0 at 20 cm or less, full marks from 100 cm.` +
          (d < x.minBase ? ` Thin for this terrain, which wants ~${x.minBase} cm.` : '');
      return `<div class="xrow2">${miniCurve(BASE_CURVE, d ?? NaN, { xmax: 150, label: 'full from 100 cm' })}<div>${txt}</div></div>`;
    }
    case 'weather': {
      const x = e.weather;
      if (!x) return '<div>no forecast for this day; counted as 0.50</div>';
      if (x.window !== undefined) {
        const fit = { fits: 'fits the light', tight: 'tight on the light', no: 'does not fit the light', dark: 'no usable light', wet: 'does not fit before the wet snow' }[x.fit] ?? '';
        const wetLine = x.wetFrom != null
          ? `<div>Wet snow from <b>${String(x.wetFrom).padStart(2, '0')}:00</b>: ${x.wetReason === 'sun' ? 'spring sun on the descent aspect' : 'above freezing at the tour\'s mid-height'}` +
            `${x.wetBulletin ? ', and the bulletin names a wet-snow problem, so the window must end before it' : '; later hours count as poor'}.</div>`
          : '';
        return (
          `<div>Daylight ${esc(x.daylight)}. Tour ~${x.needH} h, ${x.lightH} h usable light: ${fit}.</div>` +
          (x.window ? `<div>Best window <b>${esc(x.window)}</b>: hourly wind, gusts, cloud and snowfall average ${f2(x.windowScore)}.</div>` : '') +
          wetLine +
          `<div class="xmuted">each hour: wind × 0.45 + cloud × 0.35 + snow/rain × 0.20; gusts ≥ 17 m/s cap the hour at 0.30; wet-snow hours at 0.25</div>` +
          (x.caps?.length ? `<div>${x.caps.map(esc).join('<br>')}</div>` : '')
        );
      }
      return (
        `<div>${esc(x.label ?? '')}, wind ${Math.round(x.windMax ?? 0)} m/s (gusts ${Math.round(x.gustMax ?? 0)}), ${x.precipMm ?? 0} mm.</div>` +
        `<div class="xmuted">wind ${f2(x.wind)} × 0.40 + sky ${f2(x.sky)} × 0.35 + precipitation ${f2(x.precip)} × 0.25</div>` +
        (x.caps?.length ? `<div>${x.caps.map(esc).join('<br>')}</div>` : '')
      );
    }
    case 'quality': {
      const s = e.quality?.stars ?? 3;
      return `<div>${'★'.repeat(s)}${'☆'.repeat(5 - s)} editorial rating: (${s} − 1) / 4</div>`;
    }
    case 'fit': {
      const x = e.fit;
      if (!x) return '';
      return (
        `<div>difficulty ${x.difficulty} against your max ${x.maxDifficulty} → ${f2(x.level)}` +
        (x.dist != null ? `; ${x.km} km from your start → ${f2(x.dist)}, averaged` : '; no start set, so distance does not count') +
        `</div>`
      );
    }
    default:
      return '';
  }
}

export function explainHtml(r, { dayLabel = '', tourName = r.tour } = {}) {
  const contributions = PARTS.map(([k]) => [k, WEIGHTS[k] * (r.parts?.[k] ?? 0) * 100]);
  const ranked = r.status === 'ok' || r.status === 'caution';

  const bar =
    `<div class="xbar" role="img" aria-label="Score ${r.score} out of 100">` +
    contributions.map(([k, v]) => `<i style="width:${v}%;background:${SHADE[k]}" title="${PARTS.find((p) => p[0] === k)[1]}: ${pts(v)}"></i>`).join('') +
    `</div>`;

  const rows = PARTS.map(([k, name]) => {
    const part = r.parts?.[k];
    const v = WEIGHTS[k] * (part ?? 0) * 100;
    return (
      `<div class="xpart"><div class="xhead"><i class="xsw" style="background:${SHADE[k]}"></i>` +
      `<span class="xname">${name}</span><span class="xw">${Math.round(WEIGHTS[k] * 100)} %</span>` +
      `<span class="xval">${f2(part)}</span><span class="xpts">${pts(v)} pts</span></div>` +
      `<div class="xdet">${partDetail(k, r)}</div></div>`
    );
  }).join('');

  return (
    `<div class="xtop"><div><div class="xeb">${esc(dayLabel)}</div><div class="xtitle">${esc(tourName)}</div></div>` +
    `<div class="xscore${ranked ? '' : ' off'}">${r.score}<small>/100</small></div></div>` +

    `<div class="xstep"><span class="xn">1</span><div><b>Avalanche filter: ${STATUS[r.status]}.</b> ${esc(r.avalanche)}.` +
    `${r.status === 'excluded' ? ' <span class="xmuted">It would score the number above, but excluded tours are never ranked. Powder does not outweigh danger.</span>' : ''}</div></div>` +

    `<div class="xstep"><span class="xn">2</span><div><b>Conditions score</b> = the weighted parts, out of 100.${bar}</div></div>` +
    rows +
    `<div class="xsum">${contributions.map(([, v]) => pts(v)).join(' + ')} = <b>${r.score}</b></div>` +

    `<div class="xstep"><span class="xn">3</span><div><b>Confidence.</b> ${CONF[r.confidence] ?? ''}</div></div>` +

    `<div class="xgeneral"><b>In general.</b> The avalanche filter comes first and is never averaged in. Danger level is weighed against steepness (difficulty) and against the bulletin's problem aspects and elevations. ` +
    `Tours that pass get 25 % fresh snow and surface, 20 % base, 25 % weather, 20 % quality and 10 % fit. With an hourly forecast, weather is the best window inside the daylight for as long as the tour takes, and the surface is judged by the descent aspect: wind while it snowed, warming, corn. ` +
    `Base counts nothing at 20 cm or less and in full from 100 cm, so 100 and 300 cm are equal. Each part is 0–1, times its weight.</div>`
  );
}
