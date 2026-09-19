/**
 * Trip planner: which tours look best on each of the coming days.
 *
 * Three steps, in this order, and deliberately not blended into one number:
 *
 *  1. Avalanche filter. Danger level against the tour's steepness (its
 *     difficulty), and whether the tour's aspect and elevation fall inside
 *     an avalanche problem the bulletin names. A tour that fails is
 *     excluded, not marked down: 40 cm of powder must never "outweigh"
 *     danger 4.
 *  2. Conditions score 0-100 for what passes:
 *       fresh snow and surface 25 %, base 20 %, weather that day 25 %,
 *       tour quality 20 %, fit 10 %.
 *     Base counts in full from 100 cm; 20 cm or less counts nothing.
 *  3. Confidence: a bulletin for that day plus a near forecast is "high";
 *     days after the last bulletin reuse it and say so; beyond three days
 *     it is weather only.
 *
 * Pure functions, no DOM: app.js renders, the tests run this in Node.
 * This sorts what the bulletin says. It is not a substitute for reading it.
 */

export const WEIGHTS = { fresh: 0.25, base: 0.2, weather: 0.25, quality: 0.2, fit: 0.1 };

const OCT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "N–E" -> [N, NE, E] (shortest way round), "NW" -> [NW], "varied" -> all. */
export function parseAspect(s) {
  const t = String(s ?? '').toUpperCase().replace(/\s/g, '');
  if (!t || /VARIED|ALL|ANY/.test(t)) return [...OCT];
  const out = new Set();
  for (const part of t.split(/[,/]/)) {
    const [a, b] = part.split(/[–—-]/);
    const i = OCT.indexOf(a), j = OCT.indexOf(b ?? a);
    if (i < 0 || j < 0) continue;
    const fwd = (j - i + 8) % 8, back = (i - j + 8) % 8;
    const [start, n, dir] = fwd <= back ? [i, fwd, 1] : [i, back, -1];
    for (let k = 0; k <= n; k++) out.add(OCT[(start + dir * k + 8) % 8]);
  }
  return out.size ? [...out] : [...OCT];
}

/** Varsom's "11100011" -> [N, NE, E, W, NW]. */
export const problemAspects = (bits) => (bits && /^[01]{8}$/.test(bits) ? OCT.filter((_, i) => bits[i] === '1') : [...OCT]);

/** Elevation band [lo, hi] in metres where a problem applies. */
export function problemBands(h) {
  if (!h) return [[-Infinity, Infinity]];
  const lo = Math.min(h.h1, h.h2), hi = Math.max(h.h1, h.h2);
  switch (h.fill) {
    case 1: return [[h.h1, Infinity]];
    case 2: return [[-Infinity, h.h1]];
    case 3: return [[-Infinity, lo], [hi, Infinity]];
    case 4: return [[lo, hi]];
    default: return [[-Infinity, Infinity]];
  }
}

export const tourBand = (t) => [Math.max(0, (t.summit_m ?? 0) - (t.vertical_m ?? 0)), t.summit_m ?? Infinity];

/** Problems whose aspects and elevations the tour's skiing overlaps. */
export function problemsHit(tour, problems) {
  const asp = parseAspect(tour.aspect);
  const [lo, hi] = tourBand(tour);
  return (problems ?? []).filter((p) => {
    const pa = problemAspects(p.aspects);
    if (!asp.some((a) => pa.includes(a))) return false;
    return problemBands(p.heights).some(([a, b]) => lo <= b && hi >= a);
  });
}

const describeProblem = (p) => {
  const pa = problemAspects(p.aspects);
  const where = pa.length === 8 ? 'all aspects' : pa.join('/');
  const h = p.heights;
  const band = !h ? '' : h.fill === 1 ? ` above ${h.h1} m` : h.fill === 2 ? ` below ${h.h1} m` : h.fill === 4 ? ` ${Math.min(h.h1, h.h2)}–${Math.max(h.h1, h.h2)} m` : '';
  return `${(p.type ?? p.problemType ?? 'avalanche problem').toLowerCase()} (${where}${band})`;
};

/**
 * Step 1. Returns { status: 'ok'|'caution'|'excluded'|'unassessed', why }.
 * Difficulty stands in for steepness: 1 rolling fjäll, 2 25-30°, 3 30-35°,
 * 4 35-45°, 5 ski mountaineering.
 */
export function gate(tour, day, prefs) {
  const D = day?.danger;
  if (!Number.isFinite(D)) return { status: 'unassessed', why: 'no avalanche bulletin for this day' };
  const hit = problemsHit(tour, day.problems);
  const inside = hit.length > 0;
  const hitTxt = inside ? `inside ${describeProblem(hit[0])}` : day.problems?.length ? 'outside the problem aspects/elevations' : null;
  const diff = tour.difficulty ?? 3;

  if (D > (prefs.maxDanger ?? 3)) return { status: 'excluded', why: `danger ${D}, above your limit of ${prefs.maxDanger}` };
  if (D >= 5) return { status: 'excluded', why: 'danger 5' };
  if (D === 4) {
    if (diff <= 1 && !inside) return { status: 'caution', why: `danger 4: gentle terrain only, ${hitTxt ?? 'check the bulletin'}` };
    return { status: 'excluded', why: `danger 4${inside ? `, ${hitTxt}` : ', terrain too steep'}` };
  }
  if (D === 3) {
    if (diff <= 2) return inside ? { status: 'caution', why: `danger 3, ${hitTxt}` } : { status: 'ok', why: `danger 3, ${hitTxt ?? 'moderate terrain'}` };
    if (diff === 3 && !inside) return { status: 'caution', why: `danger 3 on 30–35° terrain, ${hitTxt ?? 'check the bulletin'}` };
    return { status: 'excluded', why: `danger 3${inside ? `, ${hitTxt}` : ', terrain too steep'}` };
  }
  if (D === 2) {
    if (inside && diff >= 3) return { status: 'caution', why: `danger 2, ${hitTxt}` };
    return { status: 'ok', why: `danger 2${hitTxt ? `, ${hitTxt}` : ''}` };
  }
  return { status: 'ok', why: 'danger 1' };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (pts, x) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
};

/** Base: nothing at 20 cm or less, full marks from 100 cm. */
export const baseScore = (cm) => (Number.isFinite(cm) ? clamp01((cm - 20) / 80) : null);
export const MIN_BASE = { 1: 40, 2: 50, 3: 70, 4: 80, 5: 80 };

/** Fresh snow: most points for a good settled amount, not the biggest dump. */
const freshCurve = (cm) => lerp([[0, 0.15], [5, 0.45], [15, 0.85], [20, 1], [40, 1], [60, 0.85], [90, 0.7]], cm);
const AGE = [1, 0.8, 0.6, 0.45, 0.35, 0.3];

const skyScore = (code) => {
  const c = Number(code);
  if (c === 0 || c === 1) return 1;
  if (c === 2) return 0.9;
  if (c === 3) return 0.7;
  if (c === 45 || c === 48) return 0.3;
  if (c === 71 || c === 85) return 0.6;
  if (c === 73) return 0.45;
  if (c === 75 || c === 77 || c === 86) return 0.25;
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 0.15;
  if (c >= 95) return 0.1;
  return 0.6;
};

const SUNNY = ['E', 'SE', 'S', 'SW', 'W'];

export function haversineKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

/** Step 2 for one tour on forecast day k. */
export function conditions(tour, fc, k, prefs) {
  const days = fc?.days ?? [];
  const today = days[k] ?? null;
  const why = [];

  // Fresh snow: observed (seNorge, as of the snapshot) ages; forecast snow
  // before day k counts in full, snow during day k counts half.
  const observed = (tour.snow?.new72 ?? 0) * (AGE[k] ?? 0.3);
  let forecastCm = 0;
  for (let i = 0; i < k; i++) forecastCm += days[i]?.snowCm ?? 0;
  forecastCm += 0.5 * (today?.snowCm ?? 0);
  const freshCm = Math.max(0, observed + forecastCm);
  let fresh = freshCurve(freshCm);
  if (freshCm >= 5) why.push(`~${Math.round(freshCm)} cm fresh`);

  const upTo = days.slice(0, k + 1);
  const warm = upTo.some((d) => Number.isFinite(d?.tMax) && d.tMax > 0.5);
  if (warm && freshCm >= 3) {
    fresh *= 0.6;
    why.push('warming: crust or wet snow likely');
  }
  const windy = upTo.some((d) => Number.isFinite(d?.windMax) && d.windMax >= 12);
  if (windy && freshCm >= 5) {
    fresh *= 0.7;
    why.push('wind-affected snow');
  }
  const month = today?.date ? Number(today.date.slice(5, 7)) : 0;
  const asp = parseAspect(tour.aspect);
  if (month >= 3 && month <= 6 && freshCm < 5 && today && today.tMin <= -2 && today.tMax >= 1 && asp.some((a) => SUNNY.includes(a))) {
    if (0.8 > fresh) why.push('corn cycle: frozen night, sunny slopes soften');
    fresh = Math.max(fresh, 0.8);
  }

  // Base, capped at 100 cm; thin-cover and start-of-route notes.
  const depth = tour.snow?.depthCm ?? null;
  const base = baseScore(depth);
  const minBase = MIN_BASE[tour.difficulty] ?? 60;
  if (Number.isFinite(depth)) {
    if (depth < minBase) why.push(`thin cover: ${Math.round(depth)} cm where ~${minBase} cm is needed, expect rocks`);
    else if (depth >= 100) why.push(`base ${Math.round(depth)} cm`);
  }
  const startCm = tour.snowStart?.depthCm;
  const startNote = !Number.isFinite(startCm) ? null : startCm < 20 ? `carry skis from the car (≈${Math.round(startCm)} cm at the start)` : startCm >= 40 ? 'skiable from the car' : null;

  // Weather on the day.
  let weather = null;
  if (today) {
    const wind = Number.isFinite(today.windMax) ? clamp01((15 - today.windMax) / 9) : 0.6;
    const sky = skyScore(today.code);
    const precip = Number.isFinite(today.precipMm) ? Math.max(0.2, 1 - today.precipMm / 10) : 0.7;
    weather = 0.4 * wind + 0.35 * sky + 0.25 * precip;
    if (Number.isFinite(today.gustMax) && today.gustMax >= 20) {
      weather = Math.min(weather, 0.3);
      why.push(`gusts ${Math.round(today.gustMax)} m/s`);
    }
    const summit = fc.elevation ?? tour.summit_m;
    if (Number.isFinite(today.freezingLevel) && Number.isFinite(summit) && today.freezingLevel > summit) {
      weather = Math.min(weather, 0.35);
      why.push('0° level above the summit');
    }
    if (weather >= 0.8) why.push(`${(today.label ?? 'good weather').toLowerCase()}, ${Math.round(today.windMax ?? 0)} m/s`);
    else if (weather < 0.45 && !why.some((w) => w.startsWith('gusts'))) why.push(`poor weather: ${(today.label ?? '').toLowerCase()}, ${Math.round(today.windMax ?? 0)} m/s`);
  }

  const quality = clamp01(((tour.quality ?? 3) - 1) / 4);

  // Fit: the closer to your chosen level, the better; distance if a start is set.
  const maxD = prefs.maxDifficulty ?? 5;
  let fit = Math.max(0.5, 1 - 0.15 * Math.max(0, maxD - (tour.difficulty ?? 3)));
  let km = null;
  if (prefs.from && Number.isFinite(prefs.from.lat) && Number.isFinite(prefs.from.lon)) {
    km = haversineKm(prefs.from, tour);
    const dist = Math.max(0.1, Math.min(1, 1 - (km - 80) / 520));
    fit = 0.5 * fit + 0.5 * dist;
  }

  const parts = { fresh, base: base ?? 0.4, weather: weather ?? 0.5, quality, fit };
  const score = Math.round(100 * Object.entries(WEIGHTS).reduce((s, [k2, w]) => s + w * parts[k2], 0));
  return { score, parts, why, freshCm: Math.round(freshCm), depth, startNote, km: km == null ? null : Math.round(km), hasForecast: Boolean(today), hasBase: base != null };
}

/** Bulletin for a date: that day's, else the latest earlier one (marked assumed). */
export function bulletinFor(list, date) {
  if (!Array.isArray(list) || !list.length) return null;
  const exact = list.find((b) => b.date === date);
  if (exact) return { ...exact, assumed: false };
  const earlier = list.filter((b) => b.date && b.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return earlier ? { ...earlier, assumed: true, from: earlier.date } : null;
}

/**
 * The whole plan: for each date, every tour with its filter result, score,
 * reasons and confidence, best first.
 */
export function plan({ tours, outlook, prefs = {} }) {
  const p = { maxDifficulty: 5, maxDanger: 3, ...prefs };
  const fcs = outlook?.forecasts ?? {};
  const anyFc = Object.values(fcs).find((f) => f?.days?.length);
  const dates = (anyFc?.days ?? []).map((d) => d.date).slice(0, 5);

  const eligible = (tours ?? []).filter((t) => (t.difficulty ?? 3) <= p.maxDifficulty);
  const hiddenByDifficulty = (tours ?? []).length - eligible.length;

  const days = dates.map((date, k) => {
    const rows = eligible.map((t) => {
      const fc = fcs[t.name];
      const b = bulletinFor(outlook?.bulletins?.[t.region], date);
      const g = gate(t, b, p);
      const c = conditions(t, fc, k, p);
      let confidence = 'low';
      if (g.status === 'unassessed') confidence = 'none';
      else if (!b.assumed && c.hasForecast && k <= 2) confidence = 'high';
      else if (c.hasForecast && k <= 3) confidence = 'medium';
      // A reused bulletin lowers the confidence and says so; it does not
      // turn every later day into "caution", which would drown that word.
      const status = g.status;
      const avalanche = b?.assumed ? `${g.why} (as of the ${b.from} bulletin; this day's is not out yet)` : g.why;
      return { tour: t.name, region: t.region, status, avalanche, danger: b?.danger ?? null, assumed: Boolean(b?.assumed), confidence, ...c };
    });
    const rank = { ok: 0, caution: 1, unassessed: 2, excluded: 3 };
    rows.sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score);
    return { date, k, rows };
  });

  // Best tour per date among those that pass, and the best day per tour.
  const best = days.map((d) => d.rows.find((r) => r.status === 'ok' || r.status === 'caution') ?? null);
  return { dates, days, best, hiddenByDifficulty, prefs: p };
}
