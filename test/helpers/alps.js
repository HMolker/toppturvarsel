/**
 * Stand-ins for the Austrian and Euregio services (v6.2), in the shapes read
 * from the live ones on 7 Oct 2026: the EAWS daily files (CAAMLv6, one per
 * state), the micro-region outlines (GeoJSON, MultiPolygon, id "AT-07-03")
 * and GeoSphere's station list and snow-depth series. Every listed Austrian
 * or Italian region gets a micro-region of its own, a box round its point and its tours.
 */

export const microIdOf = (region, i) => `${region.eawsState}-${String(i + 1).padStart(2, '0')}`;

export function alpineStubs({ regions, tours = [], now = new Date(), day = null, danger = () => 3, snowFrom = null, up = true } = {}) {
  const alpine = regions.filter((r) => (r.country === 'AT' || r.country === 'IT') && r.eawsState);
  const micro = alpine.map((r, i) => ({ region: r, id: microIdOf(r, i) }));
  const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const when = day ?? now.toISOString().slice(0, 10);

  const bulletinFor = (m) => ({
    bulletinID: `b-${m.id}`,
    publicationTime: `${when}T15:00:00+00:00`,
    validTime: { startTime: `${when}T16:00:00+00:00`, endTime: `${when}T16:00:00+00:00` },
    lang: 'en',
    unscheduled: false,
    regions: [{ regionID: m.id, name: `${m.region.name} (micro)` }],
    dangerRatings: [
      { mainValue: 'moderate', elevation: { upperBound: 2000 }, validTimePeriod: 'all_day' },
      { mainValue: ['low', 'low', 'moderate', 'considerable', 'high', 'very_high'][danger(m.region)], elevation: { lowerBound: 2000 }, validTimePeriod: 'all_day' },
    ],
    avalancheProblems: [{ problemType: 'persistent_weak_layers', aspects: ['W', 'NW', 'N', 'NE', 'E'], elevation: { lowerBound: 2000 }, avalancheSize: 3, frequency: 'few', snowpackStability: 'poor', validTimePeriod: 'all_day', comment: 'Weak layers in the old snowpack.' }],
    avalancheActivity: { highlights: 'Distinct weak layers in the lower snowpack above 2000 m.', comment: 'Triggering is possible from a distance.' },
    snowpackStructure: { comment: 'Old snow with a weak base.' },
    tendency: [{ tendencyType: 'steady', highlights: 'Little change.' }],
    source: { provider: { name: m.region.country === 'IT' ? 'Provincia autonoma di Bolzano' : 'LWD Tirol', website: 'https://avalanche.report' } },
  });

  // A box round the region's point and all its tours (they lie up to ~15 km apart).
  const box = (r) => {
    const pts = [r, ...tours.filter((t) => t.region === r.id)];
    const w = Math.min(...pts.map((p) => p.lon)) - 0.02, e = Math.max(...pts.map((p) => p.lon)) + 0.02;
    const s = Math.min(...pts.map((p) => p.lat)) - 0.02, n = Math.max(...pts.map((p) => p.lat)) + 0.02;
    return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  };

  const stations = [];
  const series = new Map();
  alpine.filter((r) => r.country === 'AT').forEach((r, i) => {
    const code = String(11000 + i);
    stations.push({ type: 'INDIVIDUAL', id: code, name: `Station ${r.name}`, state: 'Tirol', lat: r.lat + 0.02, lon: r.lon, altitude: 2300, is_active: true });
    series.set(code, snowFrom ?? ((h) => 120 + h * 0.3));
  });

  /** A Response for an Austrian or Euregio URL, or null when it is none of them. */
  return function handle(u) {
    if (!up) return null;
    let m = u.match(/static\.avalanche\.report\/eaws_bulletins\/(\d{4}-\d{2}-\d{2})\/\1-([A-Z0-9-]+)\.json$/);
    if (m) {
      if (day && m[1] !== day) return new Response('missing', { status: 404 });
      const bulletins = micro.filter((x) => x.region.eawsState === m[2]).map(bulletinFor);
      return bulletins.length ? J({ bulletins }) : new Response('missing', { status: 404 });
    }
    m = u.match(/regions\.avalanches\.org\/micro-regions\/([A-Z0-9-]+)_micro-regions\.geojson\.json$/);
    if (m) {
      const features = micro.filter((x) => x.region.eawsState === m[1]).map((x) => ({ type: 'Feature', properties: { id: x.id, start_date: '2022-10-01', end_date: null }, geometry: { type: 'MultiPolygon', coordinates: [box(x.region)] } }));
      return features.length ? J({ type: 'FeatureCollection', name: `${m[1]}_micro-regions`, features }) : new Response('missing', { status: 404 });
    }
    if (u.includes('dataset.api.hub.geosphere.at') && u.includes('/metadata')) {
      return J({ title: 'TAWES', parameters: [{ name: 'SCHNEE', long_name: 'Schneehöhe', unit: 'cm' }], frequency: '10min', stations });
    }
    if (u.includes('dataset.api.hub.geosphere.at') && u.includes('/historical/tawes-v1-10min')) {
      const q = new URL(u).searchParams;
      const ids = q.get('station_ids').split(',');
      const end = Date.parse(`${q.get('end')}:00Z`), start = Date.parse(`${q.get('start')}:00Z`);
      const t = [];
      for (let x = start; x <= end; x += 600e3) t.push(x);
      return J({
        media_type: 'application/json', type: 'FeatureCollection', version: 'v1',
        timestamps: t.map((x) => new Date(x).toISOString().slice(0, 16) + '+00:00'),
        features: ids.filter((id) => series.has(id)).map((id) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [11, 47] },
          properties: { station: id, parameters: { SCHNEE: { name: 'Schneehöhe', unit: 'cm', data: t.map((x) => Math.round(series.get(id)((x - start) / 3600e3) * 10) / 10) } } },
        })),
        datapoints: t.length,
      });
    }
    return null;
  };
}
