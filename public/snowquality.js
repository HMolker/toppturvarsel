/**
 * What the snow surface is likely to be on a tour's descent aspect, from the
 * hourly summit forecast (including the two days before today).
 *
 * Deliberately a handful of rules a guide would use, not a snowpack model:
 *   - Wind while and after it snowed moves snow from windward to lee slopes.
 *     Lee: loaded, deeper, denser, slab-prone. Windward: scoured, hard,
 *     sastrugi. Across the wind: in between.
 *   - Above 0° after the snow: it crusts when it refreezes (sun crust on
 *     sunny aspects, melt-freeze crust anywhere).
 *   - Spring corn: a frozen night and a thaw by day on sunny aspects. It is
 *     good in a window that moves with the sun: east first, west last.
 *   - Cold and calm after snow keeps the powder, best on north aspects.
 *
 * It returns a label, a factor for the planner's "fresh snow and surface"
 * part, the reasons, and for corn the best hours.
 */

const OCT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const BEARING = Object.fromEntries(OCT.map((a, i) => [a, i * 45]));
const SUNNY = ['E', 'SE', 'S', 'SW', 'W'];
const NORTHISH = ['N', 'NE', 'NW'];

/** When corn is at its best, by aspect (local clock hours). */
export const CORN_HOURS = { E: [9, 12], SE: [10, 13], S: [11, 14], SW: [12, 15], W: [13, 16] };

const angleDiff = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};
export const compassOf = (deg) => OCT[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Lee, windward or cross for one aspect, given where the wind came from. */
export function windRelation(aspect, windFromDeg) {
  const lee = (windFromDeg + 180) % 360;
  const d = angleDiff(BEARING[aspect], lee);
  return d <= 45 ? 'lee' : d >= 135 ? 'windward' : 'cross';
}

/**
 * @param aspects  the tour's descent aspects, e.g. ['NE', 'E']
 * @param hourly   columnar hourly forecast (see src/sources/forecast.js)
 * @param iso      the day, "YYYY-MM-DD"
 * @param opts.freshCm  fresh snow the planner already counts (seNorge + forecast)
 * @returns null without hourly data for that day
 */
export function snowQuality(aspects, hourly, iso, { freshCm = 0 } = {}) {
  const time = hourly?.time;
  if (!Array.isArray(time)) return null;
  const target = time.indexOf(`${iso}T12:00`);
  if (target < 0) return null;
  const asp = aspects?.length ? aspects : OCT;
  const at = (k, i) => {
    const v = hourly[k]?.[i];
    return Number.isFinite(v) ? v : null;
  };
  const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, j) => a + j);

  const from = Math.max(0, target - 72);
  const last72 = range(from, target);
  const snowCm = last72.reduce((t, i) => t + (at('snow', i) ?? 0), 0);
  const fresh = Math.max(snowCm, freshCm) >= 3;
  const firstSnow = fresh ? last72.find((i) => (at('snow', i) ?? 0) >= 0.2) ?? from : from;
  const since = range(firstSnow, target);

  // The day itself.
  const dayIdx = time.map((t, i) => (t.startsWith(iso) ? i : -1)).filter((i) => i >= 0);
  const hourOf = (i) => Number(time[i].slice(11, 13));
  const nightMin = Math.min(...dayIdx.filter((i) => hourOf(i) <= 7).map((i) => at('temp', i) ?? Infinity));
  const dayMax = Math.max(...dayIdx.filter((i) => hourOf(i) >= 9 && hourOf(i) <= 16).map((i) => at('temp', i) ?? -Infinity));
  const dayCloud = (() => {
    const v = dayIdx.filter((i) => hourOf(i) >= 9 && hourOf(i) <= 15).map((i) => at('cloud', i)).filter((x) => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 50;
  })();
  const month = Number(iso.slice(5, 7));
  const spring = month >= 3 && month <= 6;

  // Transport wind: hours ≥ 7 m/s since the snow began (or in the last 72 h).
  const windy = since.filter((i) => (at('wind', i) ?? 0) >= 7 && at('dir', i) !== null);
  let windFrom = null;
  let windMean = null;
  if (windy.length >= 3) {
    let x = 0, y = 0, sum = 0;
    for (const i of windy) {
      const w = at('wind', i), r = (at('dir', i) * Math.PI) / 180;
      x += w * Math.sin(r);
      y += w * Math.cos(r);
      sum += w;
    }
    windFrom = Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
    windMean = Math.round((sum / windy.length) * 10) / 10;
  }
  const maxSince = Math.max(...since.map((i) => at('temp', i) ?? -Infinity));

  const notes = [];
  let factor = 1;
  let floor = null;
  let label = fresh ? 'powder' : 'old snow';
  let timing = null;
  const sunnyAsp = asp.filter((a) => SUNNY.includes(a));
  const allNorth = asp.every((a) => NORTHISH.includes(a));

  // Wind.
  if (windFrom !== null) {
    const rel = asp.map((a) => windRelation(a, windFrom));
    const count = (r) => rel.filter((x) => x === r).length;
    const main = count('windward') > rel.length / 2 ? 'windward' : count('lee') >= rel.length / 2 ? 'lee' : 'cross';
    const dir = compassOf(windFrom);
    if (main === 'lee') {
      label = fresh ? 'wind-loaded' : 'wind-packed';
      factor *= fresh ? 0.85 : 0.9;
      notes.push([`lee of ${dir} wind (${windMean} m/s): ${fresh ? 'deeper and denser, slab-prone' : 'packed drifts'}`, fresh ? '× 0.85' : '× 0.90']);
    } else if (main === 'windward') {
      label = 'scoured';
      factor *= fresh ? 0.5 : 0.7;
      notes.push([`facing into ${dir} wind (${windMean} m/s): scoured, hard or sastrugi`, fresh ? '× 0.50' : '× 0.70']);
    } else {
      label = 'wind-affected';
      factor *= fresh ? 0.75 : 0.85;
      notes.push([`${dir} wind across the slope (${windMean} m/s): wind-affected, variable`, fresh ? '× 0.75' : '× 0.85']);
    }
  }

  // Warming after the snow: crust.
  if (fresh && maxSince > 0.5) {
    const sunny = sunnyAsp.length > 0;
    label = sunny ? 'sun crust' : 'crust';
    factor *= 0.55;
    notes.push([`${Math.round(maxSince)}° after the snow: ${sunny ? 'sun or melt-freeze crust' : 'melt-freeze crust'} likely`, '× 0.55']);
  }

  // Spring corn on sunny aspects without new snow.
  const cornDay = spring && !fresh && nightMin <= -1 && dayMax >= 1 && dayCloud < 60;
  if (cornDay && sunnyAsp.length) {
    label = 'corn';
    floor = 0.8;
    const hrs = sunnyAsp.map((a) => CORN_HOURS[a]);
    timing = { start: Math.min(...hrs.map((h) => h[0])), end: Math.max(...hrs.map((h) => h[1])) };
    notes.push([`corn cycle: ${Math.round(nightMin)}° at night, +${Math.round(dayMax)}° by day, best ${timing.start}–${timing.end} on ${sunnyAsp.join('/')}`, 'at least 0.80']);
  } else if (cornDay && allNorth) {
    notes.push(['corn day, but north-facing: expect firm old snow', '']);
  } else if (!cornDay && dayMax > 1) {
    // Warm day without a refreeze, or on new snow: heavy from midday.
    factor *= 0.8;
    if (label === 'powder') label = 'moist';
    notes.push([`+${Math.round(dayMax)}° by day: heavy or wet snow from midday, go early`, '× 0.80']);
  } else if (fresh && spring && dayCloud < 40 && sunnyAsp.length && label !== 'sun crust') {
    // Strong spring sun on new snow, even below zero.
    factor *= 0.9;
    notes.push(['spring sun on new snow: sunny slopes get moist by midday', '× 0.90']);
  }

  // Cold and calm keeps it.
  if (fresh && windFrom === null && maxSince <= 0.5 && dayMax <= 1) {
    notes.push([`cold and calm since the snow: powder holds${allNorth ? ', best on north aspects' : ''}`, '']);
  }

  return {
    label,
    factor: Math.round(factor * 100) / 100,
    floor,
    notes,
    timing,
    windFrom: windFrom === null ? null : compassOf(windFrom),
    windMean,
    snowCm: Math.round(snowCm * 10) / 10,
  };
}
