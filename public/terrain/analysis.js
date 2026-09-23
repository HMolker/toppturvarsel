/**
 * What a drawn route crosses: distance, climb, time, how steep the ground
 * under it is, which way the steep parts face, and where they meet today's
 * avalanche problems. Pure functions over the server's route profile
 * (/api/terrain/profile), so they run the same in the browser and in tests.
 *
 * "Slope" here is always the slope of the TERRAIN under the route (the fall
 * line), not the route's own gradient: a skin track traversing a 38° face
 * climbs gently but is still on a 38° face.
 */

import { problemAspects, problemBands } from '../planner.js';

export const OCT8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const octant = (deg) => (deg === null || deg === undefined || !Number.isFinite(deg) ? null : OCT8[Math.round(deg / 45) % 8]);

/** Slope classes, as on Norwegian slope maps: under 25 is rarely avalanche terrain. */
export const SLOPE_CLASSES = [
  { lo: 0, hi: 25, label: 'under 25°', key: 'flat' },
  { lo: 25, hi: 30, label: '25–29°', key: 's25' },
  { lo: 30, hi: 35, label: '30–34°', key: 's30' },
  { lo: 35, hi: 40, label: '35–39°', key: 's35' },
  { lo: 40, hi: 45, label: '40–44°', key: 's40' },
  { lo: 45, hi: 91, label: '45° and steeper', key: 's45' },
];
export const slopeClass = (s) => (Number.isFinite(s) ? SLOPE_CLASSES.find((c) => s >= c.lo && s < c.hi) ?? SLOPE_CLASSES[5] : null);

/**
 * Colours for the slope classes: the usual slope-map convention (green,
 * yellow, orange, red, purple, black), so a skier reads it without a legend.
 * This is the one place the tool leaves the Molker palette on purpose.
 */
export const SLOPE_COLOURS = {
  flat: null,
  s25: [140, 190, 60],
  s30: [245, 215, 40],
  s35: [240, 140, 30],
  s40: [215, 40, 30],
  s45: [130, 40, 150],
};
export const slopeRgb = (s) => {
  if (!Number.isFinite(s) || s < 25) return null;
  if (s >= 50) return [30, 30, 30];
  return SLOPE_COLOURS[slopeClass(s).key];
};

/** Aspect colours: eight steps round a wheel, north a cold blue, south warm. */
export const ASPECT_COLOURS = {
  N: [40, 80, 160], NE: [70, 150, 190], E: [120, 180, 90], SE: [220, 200, 60],
  S: [230, 120, 40], SW: [200, 60, 50], W: [160, 60, 140], NW: [90, 70, 170],
};

const median3 = (a, b, c) => [a, b, c].sort((x, y) => x - y)[1];

/** Is a sample inside one of the bulletin's problems (aspect and height)? */
export function problemsAt(sample, problems) {
  const asp = octant(sample.aspect);
  if (!asp || !Number.isFinite(sample.ele) || !problems?.length) return [];
  return problems.filter((p) => problemAspects(p.aspects).includes(asp) && problemBands(p.heights).some(([lo, hi]) => sample.ele >= lo && sample.ele <= hi));
}

/**
 * Hours on the route by the Munter method (v5.4): one unit is 1 km of
 * distance or 100 m of height difference; skinning and flat travel at 4
 * units an hour, skiing downhill at 10. Summed step by step along the
 * (lightly smoothed) profile.
 */
export function munterRouteHours(samples, ele) {
  let h = 0;
  for (let i = 1; i < samples.length; i++) {
    const dd = samples[i].d - samples[i - 1].d, dz = ele[i] - ele[i - 1];
    h += dz < -0.05 * dd ? (dd / 1000 - dz / 100) / 10 : (dd / 1000 + Math.max(0, dz) / 100) / 4;
  }
  return h;
}

/**
 * Contiguous stretches where the terrain is at least `min` degrees.
 * Gaps of one sample are bridged, so a single flatter reading does not
 * split one steep face in two.
 */
export function steepSections(samples, min = 30, test = null) {
  const hit = samples.map((s) => Number.isFinite(s.slope) && s.slope >= min && (!test || test(s)));
  for (let i = 1; i < hit.length - 1; i++) if (!hit[i] && hit[i - 1] && hit[i + 1]) hit[i] = true;
  const out = [];
  let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    if (i < samples.length && hit[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const part = samples.slice(start, i);
      const d0 = start === 0 ? samples[0].d : (samples[start - 1].d + samples[start].d) / 2;
      const d1 = i < samples.length ? (samples[i - 1].d + samples[i].d) / 2 : samples[i - 1].d;
      const steep = part.reduce((m, s) => (Number.isFinite(s.slope) && s.slope > (m?.slope ?? -1) ? s : m), null);
      const aspects = [...new Set(part.map((s) => octant(s.aspect)).filter(Boolean))];
      const eles = part.map((s) => s.ele).filter(Number.isFinite);
      out.push({
        from: start, to: i - 1,
        d0: Math.round(d0), d1: Math.round(d1),
        lengthM: Math.max(Math.round(d1 - d0), 1),
        maxSlope: steep?.slope ?? null, at: steep,
        aspects,
        eleMin: eles.length ? Math.min(...eles) : null, eleMax: eles.length ? Math.max(...eles) : null,
      });
      start = -1;
    }
  }
  return out;
}

/**
 * The full analysis. `runout` is an optional array of booleans, one per
 * sample: inside an NVE runout zone (Norway only).
 */
export function analyse(profile, { problems = [], runout = null } = {}) {
  const S = profile?.samples ?? [];
  if (S.length < 2) return null;
  const ele = S.map((s) => s.ele);
  const known = ele.every(Number.isFinite);

  // Metres of route per sample: half the gap to each neighbour.
  const w = S.map((s, i) => ((S[i + 1]?.d ?? s.d) - (S[i - 1]?.d ?? s.d)) / 2);

  let ascentM = 0, descentM = 0, flatM = 0, hours = null;
  if (known) {
    const sm = ele.map((e, i) => (i === 0 || i === ele.length - 1 ? e : median3(ele[i - 1], e, ele[i + 1])));
    hours = munterRouteHours(S, sm);
    for (let i = 1; i < sm.length; i++) {
      const dz = sm[i] - sm[i - 1];
      const dd = S[i].d - S[i - 1].d || 1;
      if (dz > 0) ascentM += dz;
      else descentM -= dz;
      if (Math.abs(dz / dd) < 0.05) flatM += dd;
    }
  }

  const classes = SLOPE_CLASSES.map((c) => ({ ...c, m: 0 }));
  let unknownM = 0;
  const steepAspects = Object.fromEntries(OCT8.map((o) => [o, 0]));
  S.forEach((s, i) => {
    const c = slopeClass(s.slope);
    if (!c) { unknownM += w[i]; return; }
    classes.find((k) => k.key === c.key).m += w[i];
    const o = octant(s.aspect);
    if (s.slope >= 30 && o) steepAspects[o] += w[i];
  });

  const steepest = S.reduce((m, s) => (Number.isFinite(s.slope) && s.slope > (m?.slope ?? -1) ? s : m), null);
  const highest = known ? S.reduce((m, s) => (s.ele > m.ele ? s : m), S[0]) : null;
  const lowest = known ? S.reduce((m, s) => (s.ele < m.ele ? s : m), S[0]) : null;

  // Today's problems: steep ground (30°+) facing a problem aspect, in its band.
  const hitKeys = S.map((s) => (Number.isFinite(s.slope) && s.slope >= 30 ? problemsAt(s, problems) : []));
  const index = new Map(S.map((s, i) => [s, i]));
  const problemSections = steepSections(S, 30, (s) => hitKeys[index.get(s)].length > 0).map((sec) => ({
    ...sec,
    problems: [...new Set(hitKeys.slice(sec.from, sec.to + 1).flat().map((p) => p.problemType ?? p.type))].filter(Boolean),
  }));

  let runoutM = 0;
  const runoutSections = [];
  if (Array.isArray(runout) && runout.length === S.length) {
    S.forEach((s, i) => { if (runout[i]) runoutM += w[i]; });
    let st = -1;
    for (let i = 0; i <= S.length; i++) {
      if (i < S.length && runout[i]) { if (st < 0) st = i; }
      else if (st >= 0) {
        const sec = { from: st, to: i - 1, d0: S[st].d, d1: S[i - 1].d };
        // Stretches less than 100 m apart are one crossing.
        const prev = runoutSections[runoutSections.length - 1];
        if (prev && sec.d0 - prev.d1 < 100) Object.assign(prev, { to: sec.to, d1: sec.d1 });
        else runoutSections.push(sec);
        st = -1;
      }
    }
  }

  const distanceM = S[S.length - 1].d;
  return {
    distanceM,
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    flatM: Math.round(flatM),
    hours,
    minEle: lowest?.ele ?? null,
    maxEle: highest?.ele ?? null,
    classes: classes.map((c) => ({ ...c, m: Math.round(c.m) })),
    unknownM: Math.round(unknownM),
    steepest,
    steepSections: steepSections(S, 30),
    steepAspects,
    problemSections,
    runoutM: Math.round(runoutM),
    runoutSections,
    // Where v5.1 will ask MET Norway for the weather: the start of the route
    // and its highest point, each with its own height.
    weatherPoints: {
      start: { lat: S[0].lat, lon: S[0].lon, ele: S[0].ele, label: 'Start' },
      summit: highest ? { lat: highest.lat, lon: highest.lon, ele: highest.ele, label: 'Highest point' } : null,
    },
  };
}

export const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
export function fmtHours(h) {
  if (!Number.isFinite(h)) return '–';
  const q = Math.round(h * 4) / 4;
  const hh = Math.floor(q), mm = Math.round((q - hh) * 60);
  return hh ? `${hh} h${mm ? ` ${mm} min` : ''}` : `${mm} min`;
}
