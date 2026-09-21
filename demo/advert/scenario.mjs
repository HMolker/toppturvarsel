/**
 * The advert's week, Monday 15 – Sunday 21 February 2027, made up.
 *
 * The story, in Hallingdal (and fading with distance from it):
 *   Mon  fine and cold: a planning day
 *   Tue  calm, clear morning; wind and cloud from the south-west after lunch;
 *        snow from the evening
 *   Wed  storm: ~25 cm, 15–19 m/s, gusts near 30. Not a touring day.
 *   Thu  clears before dawn, calm and −14°: 30+ cm of cold powder
 *   Fri–Sun settled, some cloud
 * Elsewhere: a grey, breezy week with a little snow, so nothing competes.
 *
 * Structure (regions, tours, bulletins) comes from the app's own simulate(),
 * so the page gets exactly what simulated mode gives it; this file only
 * replaces the weather, snow, danger and resort numbers with the story.
 */
import { simulate } from '../../public/simulate.js';
import { shapeFnugg } from '../../src/sources/fnugg.js';

const DAY0 = Date.UTC(2027, 1, 15); // Monday 15 Feb 2027
export const DATES = Array.from({ length: 12 }, (_, i) => new Date(DAY0 + (i - 2) * 864e5).toISOString().slice(0, 10)); // Sat 13 … Wed 24
export const dateOf = (a) => new Date(DAY0 + a * 864e5).toISOString().slice(0, 10); // a = 0 (Mon) … 6 (Sun)

const HALL = { lat: 60.83, lon: 8.45 };
const toRad = Math.PI / 180;
const km = (a, b) => {
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};
/** 1 in Hallingdal, 0 some 220 km away. */
export const storyWeight = (p) => Math.max(0, Math.min(1, 1 - (km(p, HALL) - 40) / 180));

const lerp = (a, b, t) => a + (b - a) * t;
const r1 = (v) => Math.round(v * 10) / 10;
function noise(...k) {
  let h = 2166136261;
  for (const c of k.join('|')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** The story's hour, for the Hallingdal core. a = day (0 = Monday), h = hour. */
function storyHour(a, h) {
  const diurnal = (lo, hi) => lo + (hi - lo) * (Math.cos(((h - 14) / 24) * 2 * Math.PI) + 1) / 2;
  if (a <= -1) return { temp: diurnal(-13, -6), wind: 3, gust: 6, dir: 60, cloud: 10, snow: 0 };
  if (a === 0) return { temp: diurnal(-12, -5), wind: 4, gust: 7, dir: 120, cloud: h < 12 ? 15 : 35, snow: 0 };
  if (a === 1) {
    if (h < 12) return { temp: diurnal(-11, -4), wind: 3 + h * 0.12, gust: 7, dir: 200, cloud: 15 + h * 2, snow: 0 };
    const k = Math.min(1, (h - 12) / 6);
    return { temp: diurnal(-9, -4), wind: lerp(5, 14, k), gust: lerp(9, 24, k), dir: 210, cloud: lerp(55, 100, k), snow: h >= 18 ? 0.5 : 0 };
  }
  if (a === 2) return { temp: diurnal(-6, -3), wind: 15 + 3 * Math.sin(h / 3), gust: 26 + 4 * Math.sin(h / 2), dir: 220, cloud: 100, snow: h < 22 ? 1.15 : 0.6 };
  if (a === 3) {
    if (h < 4) return { temp: -9 - h, wind: 9 - h * 1.5, gust: 15 - h * 2, dir: 240, cloud: 80 - h * 18, snow: 0.35 };
    return { temp: diurnal(-15, -7), wind: h < 7 ? 3 : 2, gust: 5, dir: 300, cloud: 5, snow: 0 };
  }
  if (a === 4) return { temp: diurnal(-13, -6), wind: 4, gust: 8, dir: 330, cloud: h < 13 ? 15 : 40, snow: 0 };
  if (a === 5) return { temp: diurnal(-9, -4), wind: 7, gust: 12, dir: 250, cloud: 60, snow: h > 18 ? 0.1 : 0 };
  return { temp: diurnal(-10, -4), wind: 6, gust: 10, dir: 280, cloud: 45, snow: 0 };
}

/** The rest of the mountains: grey and breezy all week. */
function greyHour(a, h, n) {
  return { temp: -5 + 2 * Math.sin(((h - 8) / 24) * 2 * Math.PI) - 2 * n, wind: 11 + 3 * n, gust: 18 + 4 * n, dir: 250, cloud: 92, snow: h % 8 === 0 ? 0.2 : 0 };
}

function hourAt(tour, a, h) {
  const w = storyWeight(tour);
  const n = noise(tour.name, a, h);
  const s = storyHour(a, h), g = greyHour(a, h, n);
  // Heights: a little colder and windier higher up.
  const up = ((tour.summit_m ?? 1500) - 1500) / 1000;
  const mix = (k) => lerp(g[k], s[k], w);
  return {
    temp: r1(mix('temp') - up * 5),
    wind: r1(Math.max(1, mix('wind') + up * 2 + (n - 0.5))),
    gust: Math.round(Math.max(2, mix('gust') + up * 3)),
    dir: Math.round(w > 0.5 ? s.dir : g.dir),
    cloud: Math.round(Math.max(0, Math.min(100, mix('cloud') + (n - 0.5) * 10))),
    snow: r1(Math.max(0, mix('snow'))),
  };
}

const CODE = (snow, cloud) => (snow >= 5 ? 73 : snow >= 1 ? 71 : cloud < 20 ? 0 : cloud < 40 ? 1 : cloud < 65 ? 2 : 3);
const LABEL = { 0: ['Clear', 'sun'], 1: ['Mainly clear', 'partly'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloud'], 71: ['Snow', 'snow'], 73: ['Snow', 'snow'] };

/** Forecast as the app gets it on day `today` (0 = Monday): 5 days, hourly from two days before. */
export function forecastFor(tour, today) {
  const hourly = { time: [], temp: [], wind: [], gust: [], dir: [], cloud: [], snow: [], precip: [], fl: [] };
  const days = [];
  for (let a = today - 2; a < today + 5; a++) {
    const date = dateOf(a);
    const hs = [];
    for (let h = 0; h < 24; h++) {
      const x = hourAt(tour, a, h);
      hs.push(x);
      hourly.time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      hourly.temp.push(x.temp);
      hourly.wind.push(x.wind);
      hourly.gust.push(x.gust);
      hourly.dir.push(x.dir);
      hourly.cloud.push(x.cloud);
      hourly.snow.push(x.snow);
      hourly.precip.push(r1(x.snow / 1.1));
      hourly.fl.push(200);
    }
    if (a < today) continue;
    const day = hs.slice(8, 17);
    const snowCm = r1(hs.reduce((t, x) => t + x.snow, 0));
    const cloud = day.reduce((t, x) => t + x.cloud, 0) / day.length;
    const code = CODE(snowCm, cloud);
    const deg = hs[12].dir;
    days.push({
      date, code, label: LABEL[code][0], icon: LABEL[code][1],
      tMax: Math.round(Math.max(...hs.map((x) => x.temp))), tMin: Math.round(Math.min(...hs.map((x) => x.temp))),
      precipMm: r1(snowCm / 1.1), snowCm,
      windMax: Math.round(Math.max(...day.map((x) => x.wind))), gustMax: Math.round(Math.max(...day.map((x) => x.gust))),
      windDeg: deg, windDir: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8],
      freezingLevel: 200,
    });
  }
  return { source: 'open-meteo', elevation: tour.summit_m, requestedElevation: tour.summit_m, days, hourly };
}

/* ---------- snow and danger by day ---------- */

// Snow at 06:00 on day a (seNorge's 24 h to that morning), Hallingdal core.
const NEW24 = { 0: 0, 1: 0, 2: 9, 3: 25, 4: 1, 5: 0, 6: 1 };
const sumNew = (a, n) => Array.from({ length: n }, (_, i) => NEW24[a - i] ?? 0).reduce((x, y) => x + y, 0);

const BITS_LEE = '11100001'; // N, NE, E, NW
const DANGER = { 0: 2, 1: 2, 2: 3, 3: 2, 4: 2, 5: 2, 6: 1 };

function problemsFor(danger, a, w) {
  const out = [];
  if (a >= 2 && a <= 5 && w > 0.4) {
    out.push({ type: 'Dry slab avalanche', problemType: 'Wind slab', probability: danger >= 3 ? 'Likely' : 'Possible', size: '2 - Medium', danger,
      aspects: BITS_LEE, heights: { fill: 1, h1: 1200, h2: 0 } });
  }
  if (a === 2 && w > 0.4) out.push({ type: 'Dry loose snow avalanche', problemType: 'New snow', probability: 'Likely', size: '1 - Small', danger, aspects: '11111111', heights: { fill: 1, h1: 900, h2: 0 } });
  return out;
}

const HEADLINE = {
  0: 'Stable, cold and settled. Watch old wind slabs in steep lee slopes.',
  1: 'Snow and strong south-westerly wind from the evening build fresh wind slabs.',
  2: 'Storm: new wind slabs on north to east facing slopes above 1200 m. Natural avalanches possible.',
  3: 'Cold after the storm. Fresh wind slabs in lee above 1200 m can be triggered by a skier.',
  4: 'Wind slabs stabilising in the cold. Care in steep lee slopes.',
  5: 'Mostly stable. Isolated wind slabs in steep lee terrain.',
  6: 'Generally stable conditions.',
};

/* ---------- resorts ---------- */

function resortsFor(list, a, at) {
  const hits = list.map(([id, name, lat, lon, url, lc, sc]) => {
    const w = storyWeight({ lat: +lat, lon: +lon });
    let frac = noise(name, a) < 0.06 ? 0.8 : 1;
    // Storm day: the high, exposed lifts on wind hold; the tree runs spin.
    if (a === 2 && w > 0.3) frac = /Hemsedal/.test(name) ? 0.77 : /Geilo/.test(name) ? 0.9 : 0.6 + 0.3 * noise(name, 'storm');
    const L = +lc, S = +sc;
    const lo = Math.round(L * frac);
    const so = Math.min(S, Math.round(S * Math.min(1, frac + 0.08)));
    return { _id: id, _source: { id: +id, name, location: { lat: +lat, lon: +lon }, urls: { homepage: url || null }, resort_open: lo > 0, lifts: { open: lo, count: L }, slopes: { open: so, count: S } } };
  });
  const no = shapeFnugg({ hits: { hits } });
  return { sources: { no: { name: 'Fnugg', fetchedAt: at, count: no.length, stale: false }, se: { name: 'OpenStreetMap', fetchedAt: at, count: 0, stale: false } }, inSeason: true, resorts: no };
}

/* ---------- the week ---------- */

export function buildWeek({ regions, tours, fnugg }) {
  const week = [];
  for (let a = 0; a < 7; a++) {
    const now = new Date(`${dateOf(a)}T06:15:00Z`);
    const sim = simulate({ regions, tours, now, seed: 'advert', threshold: 30 });
    const { snapshot } = sim;

    for (const r of snapshot.regions) {
      const w = storyWeight(r);
      const n = noise(r.id);
      const new24 = Math.round(NEW24[a] * w + (1 - w) * (1 + noise(r.id, a)));
      const new48 = Math.round(sumNew(a, 2) * w + (1 - w) * (1 + 2 * n));
      const new72 = Math.round(sumNew(a, 3) * w + (1 - w) * (2 + 2 * n));
      const base = Math.round(r.snow.depthCm * 0.6 + 70 + (w > 0.8 ? 40 : 0) + sumNew(a, 3) * w);
      Object.assign(r.snow, { new24, new48, new72, depthCm: base, depthMaxCm: base + 40, observedAt: `${dateOf(a)}T06:00:00Z` });
      if (r.bulletin && !r.bulletin.noForecast) {
        const d = w > 0.4 ? DANGER[a] : 2;
        const problems = problemsFor(d, a, w);
        Object.assign(r.bulletin, {
          danger: d, problems,
          validFrom: `${dateOf(a)}T00:00:00`, publishTime: `${dateOf(a - 1)}T16:00:00`,
          headline: `Simulated conditions, not a forecast. ${w > 0.4 ? HEADLINE[a] : 'Moderate: wind slabs in steep lee slopes.'}`,
          latestObservations: `Observers report ${Math.max(0, new48)} cm of new snow in 48 h${a === 3 && w > 0.4 ? ', blowing snow easing overnight and shooting cracks in lee slopes' : ''}.`,
          latestAvalancheActivity: a === 3 && w > 0.4 ? 'Several natural slab avalanches size 2 in north-east facing lee slopes during the storm.' : 'No recent avalanche activity reported.',
          outlook: [1, 2].map((k) => ({
            validFrom: `${dateOf(a + k)}T00:00:00`,
            danger: w > 0.4 ? DANGER[a + k] ?? 2 : 2,
            problems: problemsFor(w > 0.4 ? DANGER[a + k] ?? 2 : 2, a + k, w),
          })),
        });
      }
    }

    const regById = Object.fromEntries(snapshot.regions.map((r) => [r.id, r]));
    for (const t of snapshot.tours) {
      const r = regById[t.region];
      const hF = Math.max(0.8, Math.min(1.3, 0.6 + (t.summit_m ?? 1300) / 3000));
      const depth = Math.round((r?.snow?.depthCm ?? 150) * hF);
      Object.assign(t.snow, {
        depthCm: depth,
        new24: Math.round((r?.snow?.new24 ?? 0) * hF), new48: Math.round((r?.snow?.new48 ?? 0) * hF), new72: Math.round((r?.snow?.new72 ?? 0) * hF),
        observedAt: `${dateOf(a)}T06:00:00Z`,
      });
      t.snowStart = { depthCm: Math.round(depth * 0.5), gridAltitude: 800 };
    }
    for (const r of snapshot.regions) {
      const inRegion = snapshot.tours.filter((t) => t.region === r.id);
      if (inRegion.length) r.snow.topTour = inRegion.sort((x, y) => y.snow.new48 - x.snow.new48)[0].name;
    }

    const firing = snapshot.regions
      .filter((r) => !r.offMap && (r.snow?.new48 ?? 0) >= 30)
      .sort((x, y) => y.snow.new48 - x.snow.new48)
      .map((r) => ({
        regionId: r.id, regionName: r.name, country: r.country, new48: r.snow.new48, new24: r.snow.new24, depthCm: r.snow.depthCm,
        topTour: r.snow.topTour, indicative: false, danger: r.bulletin.danger, dangerKnown: r.bulletin.danger != null,
        problems: (r.bulletin.problems ?? []).map((p) => p.problemType ?? p.type), bulletinUrl: r.bulletinUrl,
        observedAt: r.snow.observedAt, day: dateOf(a), simulated: true,
      }));
    const alerts = { ...sim.alerts, firing };

    const forecasts = {};
    for (const t of snapshot.tours) forecasts[t.name] = forecastFor(t, a);
    const bulletins = {};
    for (const r of snapshot.regions) {
      const b = r.bulletin;
      bulletins[r.id] = [
        { date: dateOf(a), danger: b.danger, problems: b.problems ?? [], source: b.source, assessed: b.danger != null, ...(b.noForecast ? { noForecast: true } : {}) },
        ...(b.outlook ?? []).map((o) => ({ date: o.validFrom.slice(0, 10), danger: o.danger, problems: o.problems, source: b.source, assessed: o.danger != null })),
      ];
    }
    const outlook = { generatedAt: now.toISOString(), snapshotAt: snapshot.fetchedAt, bulletins, forecasts, failed: 0 };
    week.push({ a, date: dateOf(a), snapshot, alerts, outlook, forecasts, resorts: resortsFor(fnugg, a, now.toISOString()) });
  }
  return week;
}
