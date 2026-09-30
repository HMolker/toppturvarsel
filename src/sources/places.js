import { UA } from '../util/ua.js';

/**
 * Place names (v5.6): a search box that finds mountains, valleys and
 * villages anywhere in Norway and Sweden, not only the listed tours.
 *
 * Norway: Kartverket's place-name register (Sentralt stedsnavnregister),
 *   GET https://ws.geonorge.no/stedsnavn/v1/navn?sok=…&fuzzy=true&utkoordsys=4258
 *   -> { navn: [{ skrivemåte, navneobjekttype, stedsnummer,
 *                 representasjonspunkt: { øst, nord }, kommuner: [{ kommunenavn }], fylker: [{ fylkesnavn }] }] }
 *   Open, no key. © Kartverket, CC BY 4.0.
 * Sweden and Switzerland (v6): OpenStreetMap's Nominatim, limited to them.
 *   GET https://nominatim.openstreetmap.org/search?q=…&format=jsonv2&countrycodes=se,ch&addressdetails=1
 *   -> [{ place_id, lat, lon, name, display_name, type, address: { country_code } }]
 *   Its usage policy: at most one request a second, an identifying
 *   User-Agent, and no search-as-you-type. The page searches on Enter only,
 *   the server spaces requests and keeps every answer.
 *   © OpenStreetMap contributors, ODbL.
 */

const KV = process.env.KARTVERKET_PLACES_URL || 'https://ws.geonorge.no/stedsnavn/v1/navn';
const NOM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';

export function kartverketPlacesUrl(q) {
  return `${KV}?sok=${encodeURIComponent(q)}&fuzzy=true&utkoordsys=4258&treffPerSide=10&side=1`;
}

export async function searchKartverket(q) {
  const res = await fetch(kartverketPlacesUrl(q), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Kartverket place names HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.navn)) throw new Error('Kartverket place names: unexpected response shape');
  return body.navn
    .map((n) => {
      const p = n.representasjonspunkt ?? {};
      const lat = Number(p.nord ?? p.lat), lon = Number(p['øst'] ?? p.ost ?? p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const area = [n.kommuner?.[0]?.kommunenavn, n.fylker?.[0]?.fylkesnavn].filter(Boolean).join(', ');
      return {
        id: `kv:${n.stedsnummer ?? `${lat.toFixed(4)},${lon.toFixed(4)}`}`,
        name: String(n['skrivemåte'] ?? n.skrivemate ?? '').trim(),
        kind: n.navneobjekttype ?? null,
        area,
        country: 'NO',
        lat: +lat.toFixed(5),
        lon: +lon.toFixed(5),
      };
    })
    .filter((p) => p && p.name);
}

// One Nominatim request at a time, at least 1.1 s apart.
let nomChain = Promise.resolve();
let nomLast = 0;
const NOM_GAP_MS = Number(process.env.NOMINATIM_GAP_MS ?? 1100);
function nomQueued(fn) {
  const run = nomChain.then(async () => {
    const wait = nomLast + NOM_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      nomLast = Date.now();
    }
  });
  nomChain = run.catch(() => {});
  return run;
}

// v6: Switzerland too. addressdetails gives each answer's country code.
export const NOMINATIM_COUNTRIES = ['se', 'ch'];
export function nominatimUrl(q) {
  return `${NOM}?q=${encodeURIComponent(q)}&format=jsonv2&countrycodes=${NOMINATIM_COUNTRIES.join(',')}&addressdetails=1&limit=8&accept-language=sv,de,fr,it`;
}
const COUNTRY_WORDS = /^(Sverige|Schweiz|Suisse|Svizzera|Svizra|Switzerland)$/i;
// Swedish postcodes ("123 45") and Swiss ones ("3920") are not places.
const POSTCODE = /^(\d{3} ?\d{2}|\d{4})$/;

export async function searchNominatim(q) {
  return nomQueued(async () => {
    const res = await fetch(nominatimUrl(q), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('Nominatim: unexpected response shape');
    return body
      .map((x) => {
        const lat = Number(x.lat), lon = Number(x.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const parts = String(x.display_name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const name = (x.name || parts[0] || '').trim();
        return {
          id: `osm:${x.osm_type ?? 'x'}${x.osm_id ?? x.place_id}`,
          name,
          kind: x.type ?? x.category ?? null,
          area: parts.filter((s) => s !== name && !COUNTRY_WORDS.test(s) && !POSTCODE.test(s)).slice(0, 2).join(', '),
          country: String(x.address?.country_code ?? 'se').toUpperCase(),
          lat: +lat.toFixed(5),
          lon: +lon.toFixed(5),
        };
      })
      .filter((p) => p && p.name);
  });
}
