/**
 * Made-up winter, for looking at the tool out of season.
 *
 * This invents a storm week and fills every panel from it: snow depth, new
 * snow, avalanche bulletins with problems, a five-day forecast per tour,
 * powder alerts and lift status. It runs entirely in the browser, asks the
 * service for nothing and writes nothing: pressing "Refresh now" puts the
 * real data back.
 *
 * It is deliberately plausible rather than random noise — depth grows with
 * latitude and height, the storm has a centre and fades away from it, and
 * danger follows the load — because the point is to see what a real winter
 * day looks like in the layout. It is not a forecast, and every bulletin it
 * writes says so.
 */

/** Small deterministic generator, so the same seed always draws the same winter. */
function rng(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);

const DANGER_TEXT = {
  1: 'Generally stable snow. Small avalanches possible in extreme terrain.',
  2: 'Mostly stable, but wind slabs in lee terrain can be triggered by one skier. Avoid steep, loaded pockets.',
  3: 'Slabs from the storm are still reactive, especially on lee slopes above the treeline. Careful route choice is needed.',
  4: 'Large, easily triggered slabs after heavy loading. Natural avalanches are likely. Stay out of avalanche terrain.',
  5: 'Extraordinary conditions. Avoid all avalanche terrain and run-out zones.',
};
const SURFACE = [
  'Wind-packed snow above the treeline, soft and settled in the forest.',
  'Fresh snow over a hard old surface; drifted in the usual lee spots.',
  'Cold new snow on a thin melt-freeze crust from last week.',
];
const WEAK = [
  'The interface between the new snow and the old hard surface is the weak layer.',
  'Faceted snow around a buried crust is still reactive in cold, shaded terrain.',
  'The new snow is bonding slowly to the wind-affected surface beneath.',
];

/** Fall-line aspects, as Varsom's bit string (N NE E SE S SW W NW). */
const ASPECT_BITS = { lee: '11100011', sun: '00011100', all: '11111111' };

/**
 * Hour by hour for the two days before today and the five forecast days, so
 * the daylight window and snow-surface rules have something to work on.
 * The storm in the past two days blows from the south-west (loading the
 * north-east, as the wind-slab problem says); after that each day follows its
 * daily numbers: coldest at dawn, warmest mid-afternoon, and the wind easing
 * or rising through the day so the best window moves.
 */
function simulateHourly(days, tour, fr) {
  const d0 = new Date(`${days[0].date}T00:00:00Z`);
  const out = { time: [], temp: [], wind: [], gust: [], dir: [], cloud: [], snow: [], precip: [], fl: [] };
  const CLOUD = { 73: 100, 85: 85, 3: 90, 1: 20, 0: 5 };
  const storm = Math.max(0.2, (tour.snow?.new48 ?? 10) / 48);
  for (let k = -2; k < days.length; k++) {
    const date = iso(addDays(d0, k));
    const day = k >= 0 ? days[k] : null;
    for (let h = 0; h < 24; h++) {
      out.time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      if (!day) {
        // The storm: snowing, windy from the south-west, cold.
        out.temp.push(r1(-6 + 2 * Math.sin(((h - 8) / 24) * 2 * Math.PI)));
        const w = r1(9 + 5 * fr());
        out.wind.push(w);
        out.gust.push(Math.round(w * 1.6));
        out.dir.push(Math.round(200 + (fr() - 0.5) * 30));
        out.cloud.push(100);
        out.snow.push(r1(storm * (0.4 + fr() * 0.8)));
        out.precip.push(r1(storm * 0.6));
        out.fl.push(0);
        continue;
      }
      // Diurnal temperature: tMin near 05, tMax near 14.
      const phase = Math.cos(((h - 14) / 24) * 2 * Math.PI);
      out.temp.push(r1(day.tMin + (day.tMax - day.tMin) * (phase + 1) / 2));
      // Day 0 eases through the day; day 1 picks up in the afternoon; the rest are gentle.
      const shape = k === 0 ? 1 - h / 30 : k === 1 ? 0.45 + 0.55 * Math.max(0, (h - 10) / 14) : 0.6 + 0.4 * Math.sin((h / 24) * Math.PI);
      const w = r1(Math.max(1, day.windMax * shape));
      out.wind.push(w);
      out.gust.push(Math.round(w * 1.7));
      out.dir.push(day.windDeg ?? 270);
      out.cloud.push(clamp(Math.round((CLOUD[day.code] ?? 60) + (fr() - 0.5) * 20), 0, 100));
      const sn = day.snowCm > 0 && (k > 0 || h < 12) ? r1((day.snowCm / (k === 0 ? 12 : 24)) * (0.5 + fr())) : 0;
      out.snow.push(sn);
      out.precip.push(r1(sn / 1.2));
      out.fl.push(day.freezingLevel ?? 0);
    }
  }
  return out;
}

/**
 * @param regions  from /api/meta (or the current snapshot): id, name, country, lat, lon
 * @param tours    from /api/meta: name, region, lat, lon, summit_m, …
 * @param resorts  the real resort list, if it has been loaded; open counts are invented
 */
export function simulate({ regions = [], tours = [], resorts = null, now = new Date(), seed = 'storm', threshold = 30 } = {}) {
  const rand = rng(seed);
  const today = new Date(`${iso(now)}T06:00:00Z`);
  // The storm sits over one band of the mountains and fades north and south of it.
  const lats = regions.filter((r) => !r.offMap).map((r) => r.lat);
  const stormLat = lats.length ? clamp((Math.min(...lats) + Math.max(...lats)) / 2 + (rand() - 0.5) * 4, 59, 69) : 67;

  const regionRows = regions.map((region) => {
    const rr = rng(`${seed}:${region.id}`);
    // 1 at the centre of the storm, 0 about 500 km away.
    const load = clamp(1 - Math.abs(region.lat - stormLat) / 4.5, 0, 1) * (0.75 + rr() * 0.45);
    const base = Math.round(clamp(45 + (region.lat - 57) * 13 + rr() * 60, 25, 285));
    const new48 = Math.round(load * (26 + rr() * 26));
    const new24 = Math.round(new48 * (0.35 + rr() * 0.2));
    const danger = region.noForecast ? null : new48 >= 34 ? 4 : new48 >= 20 ? 3 : new48 >= 8 ? (rr() > 0.5 ? 3 : 2) : rr() > 0.75 ? 2 : 1;

    const problems = [];
    if (danger >= 2) {
      problems.push({
        type: 'Dry slab avalanche', problemType: 'Wind slab', probability: danger >= 4 ? 'Very likely' : danger === 3 ? 'Likely' : 'Possible',
        size: danger >= 4 ? '3 - Large' : '2 - Medium', danger,
        aspects: ASPECT_BITS.lee, heights: { fill: 1, h1: Math.round((600 + rr() * 300) / 50) * 50, h2: 0 },
      });
    }
    if (danger >= 3) {
      problems.push({
        type: 'Dry slab avalanche', problemType: 'New snow', probability: 'Likely', size: '2 - Medium', danger,
        aspects: ASPECT_BITS.all, heights: { fill: 1, h1: 400, h2: 0 },
      });
    }
    if (danger >= 2 && rr() > 0.6) {
      problems.push({
        type: 'Dry slab avalanche', problemType: 'Persistent weak layers', probability: 'Possible', size: '3 - Large', danger,
        aspects: ASPECT_BITS.lee, heights: { fill: 1, h1: 900, h2: 0 },
      });
    }

    const bulletin = region.noForecast
      ? { source: 'none', noForecast: true, assessed: false, danger: null, headline: 'No avalanche forecast is issued for this area.' }
      : {
          source: 'simulated',
          simulated: true,
          danger,
          validFrom: `${iso(today)}T00:00:00`,
          publishTime: `${iso(addDays(today, -1))}T16:00:00`,
          headline: `Simulated conditions, not a forecast. ${DANGER_TEXT[danger]}`,
          snowSurface: SURFACE[Math.floor(rr() * SURFACE.length)],
          weakLayers: danger >= 2 ? WEAK[Math.floor(rr() * WEAK.length)] : 'No significant weak layers reported.',
          latestAvalancheActivity: danger >= 3
            ? `Several natural slab avalanches up to size ${danger >= 4 ? 3 : 2} on lee slopes during the storm.`
            : 'No avalanche activity reported.',
          latestObservations: `Observers report ${Math.max(2, new48)} cm of new snow in 48 h and moderate drifting.`,
          problems,
          // Two days ahead, easing as the storm moves off.
          outlook: [1, 2].map((k) => ({
            validFrom: `${iso(addDays(today, k))}T00:00:00`,
            danger: region.noForecast ? null : Math.max(1, danger - k),
            problems: problems.slice(0, Math.max(0, problems.length - k)),
          })),
        };

    const inRegion = tours.filter((t) => t.region === region.id);
    return {
      id: region.id, name: region.name, country: region.country, lat: region.lat, lon: region.lon,
      offMap: region.offMap ?? false,
      bulletinUrl: region.noForecast ? null : region.country === 'NO' ? 'https://www.varsom.no/snoskredvarsling/' : 'https://lavinprognoser.se/',
      bulletin,
      snow: {
        depthCm: base, new24, new48, new72: Math.round(new48 * 1.3), depthMaxCm: base + 40,
        gridAltitude: Math.round((600 + rr() * 700) / 10) * 10,
        sampleCount: inRegion.length || 1,
        fallback: inRegion.length === 0,
        topTour: inRegion.length ? inRegion[Math.floor(rr() * inRegion.length)].name : null,
        observedAt: `${iso(today)}T06:00:00Z`,
        simulated: true,
      },
      observations: null,
      observationSummary: null,
    };
  });

  const byId = Object.fromEntries(regionRows.map((r) => [r.id, r]));

  const tourRows = tours.map((t) => {
    const reg = byId[t.region];
    const tr = rng(`${seed}:${t.name}`);
    // Height matters more than anything else for how much lies there.
    const hFactor = clamp(0.55 + (t.summit_m ?? 1200) / 2600, 0.6, 1.5);
    const depth = Math.round(clamp((reg?.snow?.depthCm ?? 100) * hFactor * (0.9 + tr() * 0.25), 15, 380));
    const new48 = Math.round(clamp((reg?.snow?.new48 ?? 0) * (0.85 + tr() * 0.4) * hFactor, 0, 70));
    return {
      ...t,
      snow: {
        depthCm: depth, new24: Math.round(new48 * 0.45), new48, new72: Math.round(new48 * 1.25),
        gridAltitude: Math.round(((t.summit_m ?? 1200) * 0.75) / 10) * 10, observedAt: `${iso(today)}T06:00:00Z`, simulated: true,
      },
      snowStart: { depthCm: Math.round(depth * 0.45), gridAltitude: Math.round(((t.summit_m ?? 1200) * 0.35) / 10) * 10 },
    };
  });

  const snapshot = {
    fetchedAt: new Date(now).toISOString(),
    status: 'ok',
    simulated: true,
    regions: regionRows,
    tours: tourRows,
    sources: {
      varsom: { ok: true, regions: regionRows.filter((r) => r.country === 'NO').length, simulated: true },
      lavinprognoser: { ok: true, regions: regionRows.filter((r) => r.country === 'SE').length, simulated: true },
      senorge: { ok: true, points: tourRows.length, simulated: true },
      regobs: { enabled: false },
    },
  };

  const firing = regionRows
    .filter((r) => !r.offMap && (r.snow?.new48 ?? 0) >= threshold)
    .sort((a, b) => b.snow.new48 - a.snow.new48)
    .map((r) => ({
      regionId: r.id, regionName: r.name, country: r.country,
      new48: r.snow.new48, new24: r.snow.new24, depthCm: r.snow.depthCm,
      topTour: r.snow.topTour, indicative: false,
      danger: r.bulletin.danger, dangerKnown: r.bulletin.danger != null,
      problems: (r.bulletin.problems ?? []).map((p) => p.problemType ?? p.type),
      bulletinUrl: r.bulletinUrl, observedAt: r.snow.observedAt, day: iso(today), simulated: true,
    }));

  const alerts = {
    threshold, quietHours: { from: 22, to: 6 }, channels: { email: false, ntfy: false },
    firing, pending: [], recent: [], simulated: true,
  };

  // Five days per tour: the storm clears, then colds and settles.
  const WEATHER = [
    { code: 73, label: 'Snow', icon: 'snow' },
    { code: 85, label: 'Snow showers', icon: 'snow' },
    { code: 3, label: 'Overcast', icon: 'cloud' },
    { code: 1, label: 'Mainly clear', icon: 'partly' },
    { code: 0, label: 'Clear', icon: 'sun' },
  ];
  const forecasts = {};
  for (const t of tourRows) {
    const fr = rng(`${seed}:fc:${t.name}`);
    forecasts[t.name] = {
      elevation: t.summit_m ?? null,
      days: [0, 1, 2, 3, 4].map((k) => {
        const w = WEATHER[Math.min(4, k + (fr() > 0.6 ? 1 : 0))];
        const snowCm = r1(Math.max(0, (t.snow.new48 / 3) * (1 - k / 3) * (0.5 + fr())));
        const wind = Math.round(clamp(16 - k * 3 + fr() * 6, 2, 26));
        return {
          date: iso(addDays(today, k)),
          label: w.label, icon: w.icon, code: w.code,
          tMax: Math.round(-3 - k * 1.5 - fr() * 4), tMin: Math.round(-8 - k * 2 - fr() * 5),
          precipMm: r1(snowCm / 1.2), snowCm,
          windMax: wind, gustMax: Math.round(wind * 1.8),
          windDir: ['W', 'NW', 'N', 'NE', 'SE'][k], windDeg: [270, 315, 0, 45, 135][k],
          freezingLevel: Math.max(0, Math.round((350 - k * 120) / 50) * 50),
        };
      }),
    };
    forecasts[t.name].hourly = simulateHourly(forecasts[t.name].days, t, fr);
  }

  const bulletins = {};
  for (const r of regionRows) {
    bulletins[r.id] = [
      { date: iso(today), danger: r.bulletin.danger, problems: r.bulletin.problems ?? [], source: r.bulletin.source, assessed: r.bulletin.danger != null, ...(r.bulletin.noForecast ? { noForecast: true } : {}) },
      ...(r.bulletin.outlook ?? []).map((o) => ({ date: o.validFrom.slice(0, 10), danger: o.danger, problems: o.problems, source: r.bulletin.source, assessed: o.danger != null })),
    ];
  }
  const outlook = { generatedAt: new Date(now).toISOString(), snapshotAt: snapshot.fetchedAt, bulletins, forecasts, failed: 0, simulated: true };

  return { snapshot, alerts, outlook, resorts: simulateResorts(resorts, seed) };
}

/**
 * Invented lift and slope status over a real resort list: most resorts open
 * in midwinter, a few partly, a couple closed. Returns null without a list,
 * so the caller can fetch one first.
 */
export function simulateResorts(resorts, seed = 'storm') {
  if (!resorts?.resorts) return null;
  return {
    ...resorts,
    simulated: true,
    resorts: resorts.resorts.map((res) => {
      const sr = rng(`${seed}:res:${res.id}`);
      const luck = sr();
      const lifts = res.lifts?.count ?? Math.round(3 + sr() * 12);
      const slopes = res.slopes?.count ?? Math.round(5 + sr() * 25);
      const share = luck < 0.15 ? 0 : luck < 0.4 ? 0.4 + sr() * 0.2 : 0.75 + sr() * 0.25;
      return {
        ...res, live: true, open: share > 0,
        lifts: { count: lifts, open: Math.round(lifts * share) },
        slopes: { count: slopes, open: Math.round(slopes * share) },
        simulated: true,
      };
    }),
  };
}
