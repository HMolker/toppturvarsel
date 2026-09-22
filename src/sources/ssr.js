import { UA } from '../util/ua.js';
import { haversineKm } from '../util/utm.js';

/**
 * Kartverket's place-name register (SSR), the official Norwegian one:
 *
 *   https://ws.geonorge.no/stedsnavn/v1/punkt?nord=..&ost=..&koordsys=4258&radius=..
 *
 * It has no lift geometry, but it does have every lift's official NAME and
 * position — navneobjekttype "Skiheis" (drag lifts and chairlifts),
 * "Fjellheis" (gondolas and cable cars) and "Alpinanlegg" (the ski area).
 * That makes it a second opinion on OpenStreetMap: a lift named here with
 * nothing mapped near it is a lift OpenStreetMap is missing.
 *
 * Open data, no key, CC BY 4.0 — © Kartverket.
 */

const URL_BASE = 'https://ws.geonorge.no/stedsnavn/v1/punkt';
const LIFT_TYPES = new Set(['skiheis', 'fjellheis', 'taubane', 'kabelbane']);
const AREA_TYPES = new Set(['alpinanlegg']);

/** The API's answer -> { lifts: [{name, lat, lon, type}], areas: [...] } (pure). */
export function shapeSsr(body) {
  const out = { lifts: [], areas: [] };
  for (const n of body?.navn ?? []) {
    const type = String(n.navneobjekttype ?? '').toLowerCase();
    const lat = n.representasjonspunkt?.nord, lon = n.representasjonspunkt?.['øst'] ?? n.representasjonspunkt?.ost;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = n.stedsnavn?.[0]?.['skrivemåte'] ?? n.stedsnavn?.[0]?.skrivemate ?? n.skrivemåte ?? null;
    if (!name) continue;
    const place = { name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), type: n.navneobjekttype, id: n.stedsnummer ?? null };
    if (LIFT_TYPES.has(type)) out.lifts.push(place);
    else if (AREA_TYPES.has(type)) out.areas.push(place);
  }
  // One entry per name (a lift often has several spellings registered).
  const once = (list) => list.filter((p, i) => list.findIndex((q) => q.name === p.name) === i);
  return { lifts: once(out.lifts), areas: once(out.areas) };
}

/** Lift names registered within `radiusM` of a point. Norway only. */
export async function ssrLifts(lat, lon, { radiusM = 5000, timeoutMs = 20000 } = {}) {
  const url = `${URL_BASE}?nord=${lat.toFixed(5)}&ost=${lon.toFixed(5)}&koordsys=4258&utkoordsys=4258&radius=${Math.round(radiusM)}&treffPerSide=500`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return shapeSsr(await res.json());
}

/**
 * Which registered lift names have nothing mapped near them (pure).
 * A name counts as matched when a mapped lift passes within `withinM`.
 */
export function matchToLifts(places, lifts, { withinM = 350 } = {}) {
  const near = (p) => lifts.some((l) => l.points.some((q) => haversineKm(p.lat, p.lon, q.lat, q.lon) * 1000 < withinM));
  const matched = [], missing = [];
  for (const p of places) (near(p) ? matched : missing).push(p);
  return { matched, missing };
}
