import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromOsm, snapSummit, nameCandidates, overpassQuery } from '../src/sources/osm.js';
import { resample, profileStats } from '../src/sources/elevation.js';
import { shapeForecast, describeCode, compass, forecastUrl } from '../src/sources/forecast.js';
import { parseGpx, toGpx, slugify } from '../src/util/gpx.js';
import { tileAllowed, tileBounds } from '../src/tiles.js';

/* A small synthetic Overpass response, shaped like `out geom` JSON:
 *
 *   road ── A ── B ── C ── D (path ends 150 m below summit)      peak "Rørnestinden"
 *                 \__ E ── F  (skitour way, slightly longer)
 *   plus a disconnected path near a decoy peak, and a car park.
 */
const P = (lat, lon) => ({ lat, lon });
const road = { type: 'way', id: 1, tags: { highway: 'unclassified' }, geometry: [P(69.6400, 20.0000), P(69.6400, 20.0100)] };
const path1 = { type: 'way', id: 2, tags: { highway: 'path' }, geometry: [P(69.6400, 20.0100), P(69.6440, 20.0150), P(69.6480, 20.0200), P(69.6520, 20.0250)] };
const ski = { type: 'way', id: 3, tags: { highway: 'path', 'piste:type': 'skitour' }, geometry: [P(69.6440, 20.0150), P(69.6470, 20.0230), P(69.6520, 20.0250)] };
const decoyPath = { type: 'way', id: 4, tags: { highway: 'path' }, geometry: [P(69.7000, 20.1000), P(69.7010, 20.1010)] };
const peak = { type: 'node', id: 10, lat: 69.6533, lon: 20.0252, tags: { natural: 'peak', name: 'Rørnestinden', ele: '1035' } };
const decoy = { type: 'node', id: 11, lat: 69.6600, lon: 20.0300, tags: { natural: 'peak', name: 'Litletind', ele: '900' } };
const parking = { type: 'node', id: 12, lat: 69.6401, lon: 20.0101, tags: { amenity: 'parking' } };
const elements = [road, path1, ski, decoyPath, peak, decoy, parking];
const tour = { name: 'Rørnestinden', lat: 69.66, lon: 20.05, summit_m: 1035 };

test('derives a route from road to summit along mapped paths only', () => {
  const r = routeFromOsm(elements, tour);
  assert.equal(r.found, true);
  assert.equal(r.summit.name, 'Rørnestinden');
  assert.equal(r.summit.source, 'osm-peak-name');
  assert.equal(r.summit.ele, 1035);
  assert.ok(['road', 'parking'].includes(r.startType));

  const first = r.points[0], last = r.points[r.points.length - 1];
  assert.deepEqual([first.lat, first.lon], [69.64, 20.01], 'starts where the path meets the road');
  assert.deepEqual([last.lat, last.lon], [69.652, 20.025], 'ends at the last mapped point, not at the summit');

  // Every point must be a real OSM vertex — nothing interpolated or invented.
  const vertices = new Set(elements.filter((e) => e.type === 'way').flatMap((w) => w.geometry.map((g) => `${g.lat},${g.lon}`)));
  for (const p of r.points) assert.ok(vertices.has(`${p.lat},${p.lon}`), `invented point ${p.lat},${p.lon}`);

  assert.ok(r.endGapM > 100 && r.endGapM < 200, `gap to summit reported (${r.endGapM} m)`);
});

test('prefers a mapped ski route when it is not much longer', () => {
  const r = routeFromOsm(elements, tour);
  assert.ok(r.composition.skitour > 0, 'the skitour way should be used');
  assert.equal(r.kind, 'ski-route');
});

test('labels a route built from summer paths as a summer path', () => {
  const r = routeFromOsm([road, path1, peak, parking], tour);
  assert.equal(r.found, true);
  assert.equal(r.kind, 'summer-path');
});

test('refuses to draw a line when no mapped path comes near the summit', () => {
  const r = routeFromOsm([road, decoyPath, peak], tour);
  assert.equal(r.found, false);
  assert.match(r.reason, /within 600 m/);
  assert.equal(r.points, undefined);
});

test('refuses when paths near the summit never reach a road, car park or hut', () => {
  const island = { type: 'way', id: 9, tags: { highway: 'path' }, geometry: [P(69.6500, 20.0240), P(69.6520, 20.0250)] };
  const r = routeFromOsm([island, peak], tour);
  assert.equal(r.found, false);
  assert.match(r.reason, /do not connect/);
});

test('a mountain hut counts as a start (Kebnekaise-style approaches)', () => {
  const hut = { type: 'node', id: 20, lat: 69.6440, lon: 20.0150, tags: { tourism: 'alpine_hut', name: 'Hytta' } };
  const r = routeFromOsm([path1, peak, hut], tour);
  assert.equal(r.found, true);
  assert.equal(r.startType, 'hut');
});

test('summit snapping: name beats proximity, and alternate names count', () => {
  const peaks = [
    { lat: 68.36, lon: 18.70, tags: { natural: 'peak', name: 'Some knoll' } },
    { lat: 68.35, lon: 18.72, tags: { natural: 'peak', name: 'Nuolja', 'name:se': 'Njulla', ele: '1169' } },
  ];
  const s = snapSummit({ name: 'Njulla (Nuolja)', lat: 68.36, lon: 18.70 }, peaks);
  assert.equal(s.name, 'Nuolja');
  assert.equal(s.ele, 1169);
  assert.deepEqual(nameCandidates('Njulla (Nuolja)').slice(-2).sort(), ['njulla', 'nuolja']);
});

test('summit snapping falls back to tour coordinates rather than a far, unrelated peak', () => {
  const s = snapSummit({ name: 'Nowhere', lat: 62, lon: 7, summit_m: 1200 }, [{ lat: 62.03, lon: 7, tags: { name: 'Other' } }]);
  assert.equal(s.source, 'tour-coordinates');
});

test('the Overpass query asks for paths, ski routes, roads, parking, huts and peaks', () => {
  const q = overpassQuery(69.66, 20.05);
  for (const s of ['piste:type', 'highway~"^(path', 'amenity=parking', 'alpine_hut', 'natural=peak', 'out geom']) {
    assert.ok(q.includes(s), `query missing ${s}`);
  }
});

test('resample spaces points evenly and keeps the ends', () => {
  const s = resample([P(60, 10), P(60.01, 10)], 11);
  assert.equal(s.length, 11);
  assert.equal(s[0].d, 0);
  assert.ok(Math.abs(s[10].d - 1112) < 5, `length ${s[10].d}`);
  assert.ok(Math.abs(s[5].lat - 60.005) < 1e-9);
});

test('profile stats ignore single-sample DEM spikes', () => {
  const samples = [100, 110, 400, 130, 140, 900].map((ele, i) => ({ ele, d: i * 100 }));
  const st = profileStats(samples);
  assert.equal(st.maxEle, 900);
  assert.equal(st.ascentM, 800, 'the 400 m spike is filtered, the real climb is kept');
  assert.equal(profileStats([{ ele: null, d: 0 }, { ele: 5, d: 10 }]), null);
});

test('GPX round-trips and parses real-world variants', () => {
  const xml = toGpx({ name: 'Test & <tour>', desc: 'd', points: [{ lat: 69.1, lon: 20.2, ele: 10 }, { lat: 69.2, lon: 20.3 }], source: 's', license: 'l' });
  assert.match(xml, /Test &amp; &lt;tour&gt;/);
  const back = parseGpx(xml);
  assert.deepEqual(back, [{ lat: 69.1, lon: 20.2, ele: 10 }, { lat: 69.2, lon: 20.3, ele: null }]);

  const garmin = `<gpx><trk><trkseg><trkpt lon="7.1" lat="62.2"><ele>55.4</ele><time>x</time></trkpt>
    <trkpt lat='62.3' lon='7.2'/></trkseg></trk></gpx>`;
  assert.deepEqual(parseGpx(garmin), [{ lat: 62.2, lon: 7.1, ele: 55.4 }, { lat: 62.3, lon: 7.2, ele: null }]);
  assert.deepEqual(parseGpx('<gpx><rte><rtept lat="1" lon="2"/></rte></gpx>'), [{ lat: 1, lon: 2, ele: null }]);
  assert.deepEqual(parseGpx('<gpx><trkpt lat="999" lon="2"/></gpx>'), []);
});

test('slugs are stable and filesystem-safe', () => {
  assert.equal(slugify('Rørnestinden'), 'rornestinden');
  assert.equal(slugify('Kårsavagge / Kårsatjåkka'), 'karsavagge-karsatjakka');
  assert.equal(slugify('Store Jægervasstind'), 'store-jaegervasstind');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
});

test('tile proxy only serves tiles near a listed tour', () => {
  const boxes = [{ lat: 69.66, lon: 20.05 }];
  // tile containing the tour at z12
  const z = 12, n = 2 ** z;
  const x = Math.floor(((20.05 + 180) / 360) * n);
  const latR = (69.66 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  const b = tileBounds(z, x, y);
  assert.ok(b.south <= 69.66 && b.north >= 69.66 && b.west <= 20.05 && b.east >= 20.05);
  assert.equal(tileAllowed(z, x, y, boxes), true);
  assert.equal(tileAllowed(z, x + 40, y, boxes), false, 'far away: refused');
  assert.equal(tileAllowed(4, 8, 3, boxes), false, 'too zoomed out: refused');
  assert.equal(tileAllowed(17, x * 32, y * 32, boxes), false, 'too zoomed in: refused');
  assert.equal(tileAllowed(12, -1, y, boxes), false);
  assert.equal(tileAllowed(12.5, x, y, boxes), false);
});

test('forecast shaping: daily rows, daytime freezing level, unknowns stay null', () => {
  const body = {
    elevation: 1035,
    daily: {
      time: ['2027-02-08', '2027-02-09'],
      weather_code: [73, 2],
      temperature_2m_max: [-4.4, -8.9], temperature_2m_min: [-9.1, -14],
      precipitation_sum: [6.2, 0], snowfall_sum: [8.4, 0],
      wind_speed_10m_max: [14.2, 5], wind_gusts_10m_max: [24.9, 9], wind_direction_10m_dominant: [265, 10],
    },
    hourly: {
      time: ['2027-02-08T03:00', '2027-02-08T12:00', '2027-02-08T15:00', '2027-02-09T12:00'],
      freezing_level_height: [900, 420, 610, null],
    },
  };
  const f = shapeForecast(body, { elevation: 1035 });
  assert.equal(f.days.length, 2);
  assert.deepEqual(
    [f.days[0].label, f.days[0].icon, f.days[0].snowCm, f.days[0].windDir, f.days[0].freezingLevel],
    ['Snow', 'snow', 8.4, 'W', 600],
    'night-time 900 m is ignored; daytime max 610 rounds to 600'
  );
  assert.equal(f.days[1].freezingLevel, null);
  assert.equal(f.days[1].windDir, 'N');
  assert.equal(describeCode(95).icon, 'storm');
  assert.equal(compass(null), null);
  assert.throws(() => shapeForecast({}), /no daily block/);
});

test('forecast URL asks for summit-downscaled daily values in m/s', () => {
  const u = new URL(forecastUrl({ lat: 69.66, lon: 20.05, elevation: 1035 }));
  assert.equal(u.searchParams.get('elevation'), '1035');
  assert.equal(u.searchParams.get('forecast_days'), '5');
  assert.equal(u.searchParams.get('wind_speed_unit'), 'ms');
  assert.ok(u.searchParams.get('daily').includes('snowfall_sum'));
  assert.equal(u.searchParams.get('hourly'), 'freezing_level_height');
});
