import { getJSON, mapLimit } from '../util/http.js';
import { log } from '../util/log.js';

/**
 * Norwegian avalanche bulletins from NVE's Varsom API.
 *
 * Verified against the live API (v6.2.1):
 *   .../api/AvalancheWarningByRegion/Simple/{regionId}/{langKey}/{from}/{to}
 *   .../api/AvalancheWarningByRegion/Detail/{regionId}/{langKey}/{from}/{to}
 * langKey 1 = Norwegian, 2 = English.
 *
 * Simple returns: RegId, RegionId, RegionName, DangerLevel ("0".."5"),
 * ValidFrom, ValidTo, PublishTime, NextWarningTime, MainText.
 * Detail adds: AvalancheProblems[], MountainWeather, SnowSurface,
 * CurrentWeaklayers, LatestAvalancheActivity, LatestObservations,
 * AvalancheAdvices[], DangerLevelName, Author.
 *
 * Data is CC-licensed but NVE/Varsom must be credited - see the footer of
 * the frontend, and do not strip it.
 */

const BASE = 'https://api01.nve.no/hydrology/forecast/avalanche/v6.2.1/api';

const ymd = (d) => d.toISOString().slice(0, 10);

/** Danger level comes back as a string; "0" means "not assessed", not "safe". */
function parseDanger(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

export async function fetchNorwegianBulletins(regions, { date = new Date(), langKey = 2 } = {}) {
  const from = ymd(date);
  const to = ymd(new Date(date.getTime() + 2 * 86400000)); // today + 2 forecast days
  const targets = regions.filter((r) => r.country === 'NO' && r.varsomId);

  const results = await mapLimit(targets, 4, async (region) => {
    const url = `${BASE}/AvalancheWarningByRegion/Detail/${region.varsomId}/${langKey}/${from}/${to}`;
    const rows = await getJSON(url);
    return { region, rows: Array.isArray(rows) ? rows : [] };
  });

  const out = {};
  results.forEach((res, i) => {
    const region = targets[i];
    if (!res.ok) {
      log.warn(`varsom: ${region.id} failed: ${res.error}`);
      out[region.id] = { error: res.error, source: 'varsom' };
      return;
    }
    out[region.id] = shapeNorwegian(res.value.rows);
  });
  return out;
}

export function shapeNorwegian(rows) {
  const today = rows[0];
  if (!today) return { danger: null, source: 'varsom', assessed: false };

  return {
    source: 'varsom',
    assessed: parseDanger(today.DangerLevel) !== null,
    danger: parseDanger(today.DangerLevel),
    dangerName: today.DangerLevelName ?? null,
    validFrom: today.ValidFrom ?? null,
    publishTime: today.PublishTime ?? null,
    nextWarning: today.NextWarningTime ?? null,
    headline: today.MainText ?? null,
    emergencyWarning:
      today.EmergencyWarning && today.EmergencyWarning !== 'Not given'
        ? today.EmergencyWarning
        : null,
    snowSurface: today.SnowSurface ?? null,
    weakLayers: today.CurrentWeaklayers ?? null,
    // These two are the forecaster's own summary of what observers saw.
    latestAvalancheActivity: today.LatestAvalancheActivity ?? null,
    latestObservations: today.LatestObservations ?? null,
    problems: (today.AvalancheProblems ?? []).map((p) => ({
      type: p.AvalancheExtName ?? null,
      probability: p.AvalProbabilityName ?? null,
      size: p.DestructiveSizeExtName ?? null,
      danger: p.DangerLevelName ?? null,
    })),
    advice: (today.AvalancheAdvices ?? []).map((a) => a.Text ?? a.Advice ?? null).filter(Boolean),
    mountainWeather: shapeWeather(today.MountainWeather),
    // Forward look: the API returns today + the next two days.
    outlook: rows.slice(1).map((r) => ({
      validFrom: r.ValidFrom ?? null,
      danger: parseDanger(r.DangerLevel),
    })),
  };
}

function shapeWeather(mw) {
  if (!mw || typeof mw !== 'object') return null;
  const byName = {};
  for (const m of mw.MeasurementTypes ?? []) {
    const sub = (m.MeasurementSubTypes ?? [])
      .map((s) => [s.Name, s.Value].filter(Boolean).join(' '))
      .filter(Boolean);
    if (m.Name) byName[m.Name] = sub.join(', ') || null;
  }
  return {
    cloudCover: mw.CloudCoverName ?? null,
    comment: mw.Comment ?? null,
    measurements: byName,
  };
}
