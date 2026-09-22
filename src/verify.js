import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { config, loadTours } from './config.js';
import { getResorts } from './resorts.js';
import { UA } from './util/ua.js';
import { log } from './util/log.js';

/**
 * Did the forecast come true?
 *
 * Every day the tool asks Open-Meteo for 16 days ahead at each 25 km cell
 * that holds a tour or a resort, and keeps what it said. The same request
 * brings back the last five days as analysed — what actually happened — so
 * yesterday's answer scores the forecast made 1, 3, 5, 10 and 15 days ago.
 *
 * Four things are checked, because they are the four a ski tourer decides on:
 *   temp   the day's highest temperature      (°C, mean absolute error)
 *   snow   new snow, and whether 5 cm fell    (cm, and a yes/no event)
 *   cloud  mean cloud cover                   (%, a bluebird day is < 30)
 *   wind   the day's strongest wind           (m/s)
 *
 * A raw error means nothing on its own, so every score is against
 * CLIMATOLOGY — the average of what this cell has actually seen on dates
 * like this, built from the observations as they accumulate:
 *
 *   skill = 1 − (the forecast's error) / (the error of just saying "normal")
 *
 * 0 means the forecast was no better than knowing the season; 1 means it was
 * perfect. Cells with fewer than MIN_CASES scored days, or without enough
 * observations for a climatology, report nothing rather than a number built
 * on a handful of days.
 *
 * On disk, all in data/cache/verify (so it survives upgrades):
 *   pending.json   forecasts waiting for their day to arrive
 *   obs.json       what happened, per cell and day (the climatology)
 *   scores.json    running error totals per cell, parameter and lead time
 *
 * Data: Open-Meteo, CC BY 4.0.
 */

export const LEADS = [1, 3, 5, 10, 15];
export const PARAMS = {
  temp: { label: 'Temperature', unit: '°C', daily: 'temperature_2m_max', weight: 0.25 },
  snow: { label: 'New snow', unit: 'cm', daily: 'snowfall_sum', weight: 0.4, event: 5 },
  cloud: { label: 'Sun and cloud', unit: '%', daily: 'cloud_cover_mean', weight: 0.15, event: 30, below: true },
  wind: { label: 'Wind', unit: 'm/s', daily: 'wind_speed_10m_max', weight: 0.2 },
};
export const PARAM_KEYS = Object.keys(PARAMS);

const API = process.env.FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';
const CELL_KM = 25;
const CHUNK = 20;              // points per Open-Meteo request
const GAP_MS = 1200;           // between requests
const FORECAST_DAYS = 16;
const PAST_DAYS = 5;           // how far back the analysis is read
const MIN_CASES = Number(process.env.SKILL_MIN_CASES ?? 30);
const MIN_CLIM = 20;           // observations before a climatology is trusted
const KEEP_OBS_DAYS = 800;

const dir = () => path.resolve(config.dataDir, 'cache', 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * cells (pure)
 * ------------------------------------------------------------------ */

/** The 25 km cell a point falls in: key, and the cell's centre. */
export function cellOf(lat, lon, km = CELL_KM) {
  const dLat = km / 111;
  const row = Math.floor(lat / dLat);
  const cLat = (row + 0.5) * dLat;
  const dLon = km / (111 * Math.cos((cLat * Math.PI) / 180));
  const col = Math.floor(lon / dLon);
  return {
    key: `${row}_${col}`,
    lat: +cLat.toFixed(4),
    lon: +((col + 0.5) * dLon).toFixed(4),
    dLat,
    dLon,
  };
}

/** One cell per 25 km square that holds a tour or a resort, named after what is in it. */
export function cellsFor(places) {
  const out = new Map();
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const c = cellOf(p.lat, p.lon);
    const hit = out.get(c.key) ?? { ...c, names: [], tours: 0, resorts: 0, elevation: null };
    if (hit.names.length < 3) hit.names.push(p.name);
    if (p.kind === 'resort') hit.resorts++;
    else hit.tours++;
    if (Number.isFinite(p.elevation)) hit.elevation = Math.max(hit.elevation ?? 0, p.elevation);
    out.set(c.key, hit);
  }
  return [...out.values()].map((c) => ({ ...c, label: c.names[0] ?? `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}` }));
}

/* ------------------------------------------------------------------ *
 * scoring (pure)
 * ------------------------------------------------------------------ */

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** Mean absolute error of "it will be normal for the time of year", and the mean itself. */
export function climatology(values) {
  if (!values.length) return null;
  const m = mean(values);
  return { n: values.length, mean: m, mae: mean(values.map((v) => Math.abs(v - m))) };
}

/** Empty totals for one cell, parameter and lead time. */
export const emptyTally = () => ({ n: 0, sae: 0, se: 0, hit: 0, miss: 0, fa: 0, cn: 0 });

/** Add one scored day to the totals (pure, mutates and returns `t`). */
export function addCase(t, forecast, observed, event = null, below = false) {
  t.n++;
  t.sae += Math.abs(forecast - observed);
  t.se += forecast - observed;
  if (event != null) {
    const f = below ? forecast < event : forecast >= event;
    const o = below ? observed < event : observed >= event;
    if (f && o) t.hit++;
    else if (!f && o) t.miss++;
    else if (f && !o) t.fa++;
    else t.cn++;
  }
  return t;
}

/**
 * Turn the totals into the numbers the page shows. `clim` is the climatology
 * for this cell and parameter; without enough of one there is no skill score,
 * because there is nothing to be better than.
 */
export function scoreOf(tally, clim, { event = null, minCases = MIN_CASES } = {}) {
  if (!tally || tally.n < minCases) return { n: tally?.n ?? 0, enough: false };
  const mae = tally.sae / tally.n;
  const bias = tally.se / tally.n;
  const out = { n: tally.n, enough: true, mae: +mae.toFixed(2), bias: +bias.toFixed(2) };
  if (clim && clim.n >= MIN_CLIM && clim.mae > 0) {
    out.skill = +Math.max(0, Math.min(1, 1 - mae / clim.mae)).toFixed(3);
    out.climMae = +clim.mae.toFixed(2);
  }
  if (event != null) {
    const events = tally.hit + tally.miss;
    const forecasts = tally.hit + tally.fa;
    out.pod = events ? +(tally.hit / events).toFixed(3) : null;      // of the days it happened, how many were forecast
    out.far = forecasts ? +(tally.fa / forecasts).toFixed(3) : null; // of the days forecast, how many did not happen
    out.rate = +(events / tally.n).toFixed(3);
    // Against always saying "the usual chance": a constant-probability forecast
    // scores 2p(1-p) on the same yes/no measure.
    const p = events / tally.n;
    const base = 2 * p * (1 - p);
    const err = (tally.miss + tally.fa) / tally.n;
    if (base > 0) out.eventSkill = +Math.max(0, Math.min(1, 1 - err / base)).toFixed(3);
  }
  return out;
}

/** One number for the cell: the four parameters, weighted, where each has a score. */
export function aggregate(scores) {
  let w = 0, s = 0, n = 0;
  for (const k of PARAM_KEYS) {
    const sc = scores[k];
    if (!sc?.enough || sc.skill == null) continue;
    w += PARAMS[k].weight;
    s += PARAMS[k].weight * sc.skill;
    n = Math.max(n, sc.n);
  }
  if (!w) return { n, enough: false };
  return { n, enough: true, skill: +(s / w).toFixed(3), of: +w.toFixed(2) };
}

/* ------------------------------------------------------------------ *
 * storage
 * ------------------------------------------------------------------ */

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(dir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(name, value) {
  await mkdir(dir(), { recursive: true });
  const f = path.join(dir(), name);
  await writeFile(`${f}.tmp`, JSON.stringify(value));
  await rename(`${f}.tmp`, f);
}

/* ------------------------------------------------------------------ *
 * collecting and scoring a day
 * ------------------------------------------------------------------ */

export function skillUrl(points) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    daily: [...new Set(PARAM_KEYS.map((k) => PARAMS[k].daily))].join(','),
    timezone: 'Europe/Oslo',
    forecast_days: String(FORECAST_DAYS),
    past_days: String(PAST_DAYS),
    wind_speed_unit: 'ms',
  });
  return `${API}?${q}`;
}

async function fetchChunk(points) {
  const res = await fetch(skillUrl(points), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : [body];
}

/** Pull the daily rows out of one point's answer: { date: {temp, snow, cloud, wind} }. */
export function rowsOf(block) {
  const d = block?.daily ?? {};
  const out = {};
  (d.time ?? []).forEach((date, i) => {
    const row = {};
    for (const k of PARAM_KEYS) {
      const v = d[PARAMS[k].daily]?.[i];
      if (Number.isFinite(v)) row[k] = v;
    }
    if (Object.keys(row).length) out[date] = row;
  });
  return out;
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400e3));
const monthOf = (date) => date.slice(5, 7);

/**
 * One pass: fetch, store today's forecasts for the lead times we score,
 * then score every pending forecast whose day has now been observed.
 */
export async function collectAndScore({ today = iso(new Date()), fetchPoints = fetchChunk, gapMs = GAP_MS } = {}) {
  const cells = await verifyCells();
  if (!cells.length) return { cells: 0, stored: 0, scored: 0 };

  const [pending, obs, scores] = await Promise.all([
    readJson('pending.json', {}),
    readJson('obs.json', { cells: {} }),
    readJson('scores.json', { cells: {}, days: 0, since: today }),
  ]);

  let stored = 0, scored = 0, failed = 0;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const chunk = cells.slice(i, i + CHUNK);
    let blocks;
    try {
      blocks = await fetchPoints(chunk);
    } catch (err) {
      failed++;
      log.warn(`skill: forecast for ${chunk.length} cells failed: ${err.message}`);
      continue;
    }
    chunk.forEach((cell, k) => {
      const rows = rowsOf(blocks[k]);
      // What it says now, for the days we will check later.
      for (const lead of LEADS) {
        const target = addDays(today, lead);
        if (!rows[target]) continue;
        pending[target] ??= {};
        pending[target][cell.key] ??= {};
        pending[target][cell.key][lead] = rows[target];
        stored++;
      }
      // What actually happened, for the days just gone.
      const cellObs = (obs.cells[cell.key] ??= {});
      for (let back = 1; back <= PAST_DAYS; back++) {
        const day = addDays(today, -back);
        if (!rows[day]) continue;
        cellObs[day] = rows[day];
      }
    });
    if (i + CHUNK < cells.length) await sleep(gapMs);
  }

  // Score everything whose day is now known.
  for (const [target, byCell] of Object.entries(pending)) {
    if (target >= today) continue;
    let done = true;
    for (const [key, byLead] of Object.entries(byCell)) {
      const observed = obs.cells[key]?.[target];
      if (!observed) { done = false; continue; }
      const cellScores = (scores.cells[key] ??= {});
      for (const [lead, forecast] of Object.entries(byLead)) {
        for (const p of PARAM_KEYS) {
          if (!Number.isFinite(forecast[p]) || !Number.isFinite(observed[p])) continue;
          const t = ((cellScores[p] ??= {})[lead] ??= emptyTally());
          addCase(t, forecast[p], observed[p], PARAMS[p].event ?? null, Boolean(PARAMS[p].below));
          scored++;
        }
      }
    }
    // Give a day three days to be observed, then let it go.
    if (done || target < addDays(today, -PAST_DAYS - 3)) delete pending[target];
  }

  // Trim the observation archive.
  const cutoff = addDays(today, -KEEP_OBS_DAYS);
  for (const days of Object.values(obs.cells)) {
    for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
  }

  scores.days = (scores.days ?? 0) + 1;
  scores.updatedAt = new Date().toISOString();
  scores.since ??= today;
  await Promise.all([writeJson('pending.json', pending), writeJson('obs.json', obs), writeJson('scores.json', scores)]);
  log.info(`skill: ${cells.length} cells, ${stored} forecasts stored, ${scored} scored${failed ? `, ${failed} chunk(s) failed` : ''}`);
  return { cells: cells.length, stored, scored, failed };
}

/** The cells we verify: every 25 km square with a tour or a resort in it. */
export async function verifyCells() {
  const [tours, resortList] = await Promise.all([
    loadTours().catch(() => []),
    getResorts().then((r) => r.resorts).catch(() => []),
  ]);
  return cellsFor([
    ...tours.filter((t) => Number.isFinite(t.lat)).map((t) => ({ name: t.name, lat: t.lat, lon: t.lon, elevation: t.summit_m, kind: 'tour' })),
    ...resortList.filter((r) => Number.isFinite(r.lat)).map((r) => ({ name: r.name, lat: r.lat, lon: r.lon, kind: 'resort' })),
  ]);
}

/* ------------------------------------------------------------------ *
 * what the page asks for
 * ------------------------------------------------------------------ */

/** Climatology per cell and parameter, from the observations gathered so far. */
export function climatologies(obs, { month = null } = {}) {
  const out = {};
  for (const [key, days] of Object.entries(obs.cells ?? {})) {
    const byParam = {};
    for (const [date, row] of Object.entries(days)) {
      // Same time of year: this month and its neighbours.
      if (month && !nearMonth(monthOf(date), month)) continue;
      for (const p of PARAM_KEYS) if (Number.isFinite(row[p])) (byParam[p] ??= []).push(row[p]);
    }
    out[key] = Object.fromEntries(PARAM_KEYS.map((p) => [p, climatology(byParam[p] ?? [])]));
  }
  return out;
}

function nearMonth(a, b) {
  const x = Number(a), y = Number(b);
  const d = Math.abs(x - y);
  return Math.min(d, 12 - d) <= 1;
}

/**
 * Everything the accuracy page needs: one entry per cell, with a score for
 * each parameter at each lead time, plus the aggregate.
 */
export async function getSkill({ month = null } = {}) {
  const [cells, obs, scores] = await Promise.all([
    verifyCells(),
    readJson('obs.json', { cells: {} }),
    readJson('scores.json', { cells: {}, days: 0 }),
  ]);
  const clim = climatologies(obs, { month });
  const out = [];
  for (const cell of cells) {
    const tallies = scores.cells[cell.key];
    if (!tallies) continue;
    const byLead = {};
    for (const lead of LEADS) {
      const per = {};
      for (const p of PARAM_KEYS) {
        per[p] = scoreOf(tallies[p]?.[lead], clim[cell.key]?.[p], { event: PARAMS[p].event ?? null });
      }
      per.all = aggregate(per);
      byLead[lead] = per;
    }
    out.push({ key: cell.key, label: cell.label, names: cell.names, lat: cell.lat, lon: cell.lon, dLat: cell.dLat, dLon: cell.dLon, leads: byLead });
  }
  const observedDays = new Set();
  for (const days of Object.values(obs.cells ?? {})) for (const d of Object.keys(days)) observedDays.add(d);
  return {
    cells: out,
    leads: LEADS,
    params: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, { label: v.label, unit: v.unit, weight: v.weight, event: v.event ?? null, below: Boolean(v.below) }])),
    minCases: MIN_CASES,
    collecting: { since: scores.since ?? null, passes: scores.days ?? 0, observedDays: observedDays.size, updatedAt: scores.updatedAt ?? null, cells: cells.length },
    source: 'Open-Meteo (CC BY 4.0), verified against its own analysis',
  };
}

/* ------------------------------------------------------------------ *
 * once a day
 * ------------------------------------------------------------------ */

const ON = !/^(off|false|0|no)$/i.test(process.env.SKILL_VERIFY ?? 'on');
let lastRun = null;

export function startVerification({ hour = Number(process.env.SKILL_HOUR ?? 6) } = {}) {
  if (!ON) {
    log.info('skill: verification off (SKILL_VERIFY=off)');
    return () => {};
  }
  const tick = async () => {
    const now = new Date();
    const today = iso(now);
    if (lastRun === today) return;
    const local = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: 'numeric', hourCycle: 'h23' }).format(now));
    if (local < hour) return;
    lastRun = today;
    try {
      await collectAndScore({ today });
    } catch (err) {
      log.warn(`skill: daily pass failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, 30 * 60e3);
  timer.unref?.();
  setTimeout(tick, 120e3).unref?.();
  log.info(`skill: forecast verification daily after ${hour}:00, lead times ${LEADS.join(', ')} days`);
  return () => clearInterval(timer);
}
