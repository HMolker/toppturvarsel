/**
 * 5-day daily forecast from Open-Meteo, downscaled to a given elevation.
 *
 * Open-Meteo's "best match" uses MET Norway's MET Nordic model (the one
 * behind yr.no) where it covers, blended with ECMWF. Passing `elevation`
 * makes it statistically downscale temperature to that height, so a summit
 * forecast is a summit forecast rather than the valley the grid cell sits in.
 *
 * Variable names and response shape per the Open-Meteo docs:
 *   daily.{time, weather_code, temperature_2m_max, temperature_2m_min,
 *          precipitation_sum (mm), snowfall_sum (cm), wind_speed_10m_max,
 *          wind_gusts_10m_max, wind_direction_10m_dominant}
 *   hourly.{time, freezing_level_height (m)}
 *
 * Data: Open-Meteo, CC BY 4.0. Free for non-commercial use.
 */

const API = process.env.FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';

const DAILY = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'snowfall_sum',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
].join(',');

export function forecastUrl({ lat, lon, elevation }) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: DAILY,
    hourly: 'freezing_level_height',
    timezone: 'Europe/Oslo',
    forecast_days: '5',
    wind_speed_unit: 'ms',
  });
  if (Number.isFinite(elevation)) q.set('elevation', String(Math.round(elevation)));
  return `${API}?${q}`;
}

export async function fetchForecast(where) {
  const res = await fetch(forecastUrl(where), {
    headers: { 'User-Agent': 'toppturvarsel/1.0 (self-hosted ski touring dashboard)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  return shapeForecast(await res.json(), where);
}

/** WMO weather code -> short label + icon key. */
export function describeCode(code) {
  const c = Number(code);
  if (c === 0) return { label: 'Clear', icon: 'sun' };
  if (c === 1 || c === 2) return { label: c === 1 ? 'Mainly clear' : 'Partly cloudy', icon: 'partly' };
  if (c === 3) return { label: 'Overcast', icon: 'cloud' };
  if (c === 45 || c === 48) return { label: 'Fog', icon: 'fog' };
  if (c >= 51 && c <= 57) return { label: 'Drizzle', icon: 'rain' };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { label: c >= 80 ? 'Rain showers' : 'Rain', icon: 'rain' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { label: c >= 85 ? 'Snow showers' : 'Snow', icon: 'snow' };
  if (c >= 95) return { label: 'Thunderstorm', icon: 'storm' };
  return { label: '—', icon: 'cloud' };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => (Number.isFinite(deg) ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8] : null);

export function shapeForecast(body, where = {}) {
  const d = body?.daily;
  if (!d || !Array.isArray(d.time)) throw new Error('forecast: no daily block');

  // Freezing level per day: hourly values, reduced to the daytime (08–16) max,
  // since that is when you are on the hill.
  const fl = {};
  const h = body.hourly;
  if (h && Array.isArray(h.time) && Array.isArray(h.freezing_level_height)) {
    h.time.forEach((t, i) => {
      const hour = Number(String(t).slice(11, 13));
      const v = h.freezing_level_height[i];
      if (!Number.isFinite(v) || hour < 8 || hour > 16) return;
      const day = String(t).slice(0, 10);
      fl[day] = Math.max(fl[day] ?? -Infinity, v);
    });
  }

  const val = (k, i) => (Array.isArray(d[k]) && Number.isFinite(d[k][i]) ? d[k][i] : null);
  const round = (v, p = 0) => (v === null ? null : Math.round(v * 10 ** p) / 10 ** p);

  return {
    source: 'open-meteo',
    elevation: Number.isFinite(body.elevation) ? Math.round(body.elevation) : where.elevation ?? null,
    requestedElevation: where.elevation ?? null,
    days: d.time.slice(0, 5).map((date, i) => ({
      date,
      ...describeCode(val('weather_code', i)),
      code: val('weather_code', i),
      tMax: round(val('temperature_2m_max', i)),
      tMin: round(val('temperature_2m_min', i)),
      precipMm: round(val('precipitation_sum', i), 1),
      snowCm: round(val('snowfall_sum', i), 1),
      windMax: round(val('wind_speed_10m_max', i)),
      gustMax: round(val('wind_gusts_10m_max', i)),
      windDir: compass(val('wind_direction_10m_dominant', i)),
      windDeg: val('wind_direction_10m_dominant', i),
      freezingLevel: Number.isFinite(fl[date]) ? Math.round(fl[date] / 50) * 50 : null,
    })),
  };
}
