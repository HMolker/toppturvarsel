/**
 * Sunrise, sunset and civil twilight for a date and place, in local
 * (Norway/Sweden) clock hours.
 *
 * NOAA's general solar position equations (the "fractional year" form from
 * NOAA's Global Monitoring Laboratory). Good to a minute or two, which is more
 * than enough to say whether a four-hour tour fits the light in January.
 *
 * Civil twilight (sun 6° below the horizon) is used as "usable light": in the
 * north in midwinter the sun never rises, but there are a few hours of skiable
 * twilight around noon, and that is what a tour has to fit into.
 */

const RAD = Math.PI / 180;

/** Europe/Oslo and Europe/Stockholm: CET, CEST from the last Sunday of March to the last Sunday of October. */
export function osloOffset(iso) {
  const y = Number(iso.slice(0, 4));
  const lastSunday = (m) => {
    const d = new Date(Date.UTC(y, m + 1, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10);
  };
  return iso >= lastSunday(2) && iso < lastSunday(9) ? 2 : 1;
}

function solar(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const n = Math.floor((d - start) / 864e5) + 1;
  const g = ((2 * Math.PI) / 365) * (n - 1);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  return { eqtime, decl };
}

/**
 * Hour angle (degrees) at which the sun crosses a given zenith angle.
 * null + flag when it never gets that high ('below') or never that low ('above').
 */
function hourAngle(lat, decl, zenith) {
  const x = Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (x > 1) return { ha: null, state: 'below' };
  if (x < -1) return { ha: null, state: 'above' };
  return { ha: Math.acos(x) / RAD, state: 'crosses' };
}

const round2 = (h) => Math.round(h * 100) / 100;

/**
 * { sunrise, sunset, dawn, dusk, noon } as local decimal hours (8.5 = 08:30),
 * plus polarNight / midnightSun flags and the usable light span.
 */
export function sunTimes(iso, lat, lon) {
  const { eqtime, decl } = solar(iso);
  const off = osloOffset(iso) * 60;
  const noonMin = 720 - 4 * lon - eqtime + off;
  const at = (ha) => round2((noonMin + 4 * ha) / 60);
  const before = (ha) => round2((noonMin - 4 * ha) / 60);

  const sun = hourAngle(lat, decl, 90.833);
  const civil = hourAngle(lat, decl, 96);
  const out = {
    date: iso,
    noon: round2(noonMin / 60),
    sunrise: sun.ha == null ? null : before(sun.ha),
    sunset: sun.ha == null ? null : at(sun.ha),
    dawn: civil.ha == null ? null : before(civil.ha),
    dusk: civil.ha == null ? null : at(civil.ha),
    polarNight: sun.state === 'below',
    midnightSun: sun.state === 'above',
  };
  // Usable light: civil dawn to civil dusk; all day when it never gets dark.
  if (civil.state === 'above') out.light = { start: 0, end: 24 };
  else if (civil.state === 'below') out.light = null;
  else out.light = { start: Math.max(0, out.dawn), end: Math.min(24, out.dusk) };
  out.lightH = out.light ? round2(out.light.end - out.light.start) : 0;
  out.sunH = out.midnightSun ? 24 : out.sunrise == null ? 0 : round2(out.sunset - out.sunrise);
  return out;
}

/** 7.25 -> "07:15" */
export function hhmm(h) {
  if (!Number.isFinite(h)) return '—';
  let m = Math.round(h * 60);
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** One line for a table cell. */
export function daylightText(s) {
  if (!s) return '—';
  if (s.midnightSun) return 'midnight sun';
  if (s.polarNight) return s.light ? `polar night · twilight ${hhmm(s.light.start)}–${hhmm(s.light.end)}` : 'polar night, no daylight';
  return `${hhmm(s.sunrise)}–${hhmm(s.sunset)}`;
}
