import { haversineKm } from '../util/utm.js';

/**
 * Swedish ski resorts from OpenStreetMap: where they are, what they are
 * called, their website, and how many lifts are mapped.
 *
 * There is no open live source for lift and slope status in Sweden.
 * Snörapporten (SLAO) has it for ~60 resorts but publishes no feed, so
 * Swedish resorts are shown with status "not published" until one exists.
 *
 * One Overpass query, cached 30 days: ski areas (landuse=winter_sports,
 * or site=piste relations) with a name, plus every lift, as centres with
 * bounds and tags.
 */

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

const LIFTS = 'chair_lift|gondola|cable_car|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet';

export function resortsQuery(iso = 'SE') {
  return `[out:json][timeout:180];
area["ISO3166-1"="${iso}"][admin_level=2]->.c;
(
  way["landuse"="winter_sports"]["name"](area.c);
  relation["landuse"="winter_sports"]["name"](area.c);
  relation["site"="piste"]["name"](area.c);
  way["aerialway"~"^(${LIFTS})$"](area.c);
);
out tags center bb;`;
}

export async function fetchOsmResorts(iso = 'SE') {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'fjallskred/1.0 (self-hosted ski touring dashboard; monthly)',
    },
    body: `data=${encodeURIComponent(resortsQuery(iso))}`,
    signal: AbortSignal.timeout(200000),
  });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  return shapeOsmResorts(await res.json(), iso);
}

const safeUrl = (u) => {
  if (!u) return null;
  let s = String(u).trim().split(';')[0];
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    return url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
};

const centreOf = (e) =>
  e.center ? { lat: e.center.lat, lon: e.center.lon } : Number.isFinite(e.lat) ? { lat: e.lat, lon: e.lon } : null;

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Anything smaller than ~300 m across with no lift is a sledging hill or
// a mapping fragment, not a resort anyone drives to.
const MIN_DIAG_KM = 0.3;

export function shapeOsmResorts(body, iso = 'SE') {
  const els = body?.elements;
  if (!Array.isArray(els)) throw new Error('overpass: unexpected response shape');

  const areas = [];
  const lifts = [];
  for (const e of els) {
    const c = centreOf(e);
    if (!c) continue;
    const t = e.tags ?? {};
    if (t.aerialway) {
      lifts.push(c);
      continue;
    }
    if (!t.name) continue;
    const b = e.bounds;
    const diag = b ? haversineKm(b.minlat, b.minlon, b.maxlat, b.maxlon) : 0;
    areas.push({
      osm: `${e.type}/${e.id}`,
      name: t.name.trim(),
      lat: c.lat,
      lon: c.lon,
      bounds: b ?? null,
      diag,
      url: safeUrl(t.website ?? t['contact:website'] ?? t.url),
      lifts: 0,
    });
  }

  // Each lift belongs to the smallest named area whose bounds (plus 300 m)
  // contain it.
  const pad = 0.003;
  for (const l of lifts) {
    let best = null;
    for (const a of areas) {
      const b = a.bounds;
      if (!b) continue;
      if (l.lat >= b.minlat - pad && l.lat <= b.maxlat + pad && l.lon >= b.minlon - pad * 2 && l.lon <= b.maxlon + pad * 2) {
        if (!best || a.diag < best.diag) best = a;
      }
    }
    if (best) best.lifts++;
  }

  // The same resort is often mapped twice (a landuse area and a piste
  // relation). Merge same-named areas within 5 km, keeping the larger.
  const kept = [];
  for (const a of areas.sort((x, y) => y.diag - x.diag)) {
    const dup = kept.find((k) => norm(k.name) === norm(a.name) && haversineKm(k.lat, k.lon, a.lat, a.lon) < 5);
    if (dup) {
      dup.lifts = Math.max(dup.lifts, a.lifts);
      dup.url ??= a.url;
      continue;
    }
    kept.push(a);
  }

  return kept
    .filter((a) => a.diag >= MIN_DIAG_KM || a.lifts > 0)
    .map((a) => ({
      id: `osm-${a.osm}`,
      name: a.name,
      country: iso,
      lat: +a.lat.toFixed(5),
      lon: +a.lon.toFixed(5),
      url: a.url,
      open: null,
      lifts: null,
      slopes: null,
      mappedLifts: a.lifts || null,
      live: false,
      source: 'osm',
    }));
}
