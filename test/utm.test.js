import test from 'node:test';
import assert from 'node:assert/strict';
import { latLonToUTM, haversineKm } from '../src/util/utm.js';

test('a point on the zone-33 central meridian has easting exactly 500000', () => {
  // Strongest closed-form invariant available without a reference library:
  // by definition the central meridian (15E for zone 33) is the false easting.
  for (const lat of [58, 62, 65, 69, 71]) {
    const { x } = latLonToUTM(lat, 15);
    assert.equal(x, 500000, `easting at ${lat}N on 15E should be 500000, got ${x}`);
  }
});

test('converts Oslo to the UTM33 coordinates seNorge expects', () => {
  // Verified end-to-end: feeding our conversion of a known summit into
  // gts.nve.no returns a grid-cell altitude consistent with that summit
  // (Galdhoppigen 61.6363/8.3125 -> 146001/6851874 -> Altitude 2178 m for a
  // 2469 m peak, i.e. the right 1 km cell). These are our own regression values.
  const { x, y, zone } = latLonToUTM(59.9139, 10.7522);
  assert.equal(zone, 33);
  assert.equal(x, 262560);
  assert.equal(y, 6649444);
});

test('Galdhøpiggen maps to the grid cell seNorge reported at 2178 m', () => {
  const { x, y } = latLonToUTM(61.6363, 8.3125);
  assert.equal(x, 146001);
  assert.equal(y, 6851874);
});

test('converts a Sunnmøre point close to the UTM33 coords Varsom reports', () => {
  // Varsom's Detail response for region Sunnmøre (3024) carries
  // UtmEast 62473 / UtmNorth 6916553 in zone 33 for its representative point.
  // Our region centroid is not exactly that point, so allow ~25 km.
  const { x, y } = latLonToUTM(62.2, 6.8);
  assert.ok(Math.abs(x - 62473) < 25000, `easting ${x} implausible for Sunnmøre`);
  assert.ok(Math.abs(y - 6916553) < 25000, `northing ${y} implausible for Sunnmøre`);
});

test('northings increase with latitude and eastings with longitude', () => {
  const south = latLonToUTM(60, 10);
  const north = latLonToUTM(69, 10);
  assert.ok(north.y > south.y);
  const west = latLonToUTM(65, 12);
  const east = latLonToUTM(65, 18);
  assert.ok(east.x > west.x);
});

test('stays inside the plausible seNorge grid envelope for every tour', async () => {
  const tours = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../data/tours.json', import.meta.url),
      'utf8'
    )
  );
  for (const t of tours) {
    const { x, y } = latLonToUTM(t.lat, t.lon);
    // seNorge covers mainland Norway plus a margin; Swedish tours sit east of it.
    assert.ok(x > -200000 && x < 1200000, `${t.name}: easting ${x} out of range`);
    assert.ok(y > 6400000 && y < 8000000, `${t.name}: northing ${y} out of range`);
  }
});

test('rejects nonsense input rather than returning NaN', () => {
  assert.throws(() => latLonToUTM(NaN, 10), TypeError);
  assert.throws(() => latLonToUTM(95, 10), RangeError);
});

test('haversine matches a known distance', () => {
  // Tromsø to Narvik: ~148 km great-circle (the ~250 km people quote is the road).
  const d = haversineKm(69.6492, 18.9553, 68.4385, 17.4272);
  assert.ok(d > 143 && d < 153, `got ${d} km`);
});

test('haversine is zero for identical points and symmetric', () => {
  assert.equal(haversineKm(63, 12, 63, 12), 0);
  const a = haversineKm(63, 12, 65, 15);
  const b = haversineKm(65, 15, 63, 12);
  assert.ok(Math.abs(a - b) < 1e-9);
});
