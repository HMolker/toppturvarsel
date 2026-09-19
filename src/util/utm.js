/**
 * WGS84 lat/lon -> UTM zone 33N, which is what NVE's seNorge grid API
 * (gts.nve.no) takes for its x/y coordinates.
 *
 * Standard Karney/Snyder transverse Mercator series, truncated to the
 * 4th-order terms. Accurate to well under a metre across Norway, which is
 * far tighter than we need: the seNorge grid cells are 1 km square, so
 * anything under a few hundred metres lands in the same cell.
 */

const A = 6378137.0;            // WGS84 semi-major axis
const F = 1 / 298.257223563;    // WGS84 flattening
const K0 = 0.9996;              // UTM scale factor
const E2 = F * (2 - F);         // first eccentricity squared
const EP2 = E2 / (1 - E2);      // second eccentricity squared
const FALSE_EASTING = 500000;

const rad = (d) => (d * Math.PI) / 180;

/**
 * @param {number} lat  latitude in degrees
 * @param {number} lon  longitude in degrees
 * @param {number} zone UTM zone number (default 33)
 * @returns {{x:number, y:number, zone:number}} easting/northing in whole metres
 */
export function latLonToUTM(lat, lon, zone = 33) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError('latLonToUTM: lat and lon must be finite numbers');
  }
  if (lat < -80 || lat > 84) {
    throw new RangeError(`latLonToUTM: latitude ${lat} outside UTM range`);
  }

  const centralMeridian = (zone - 1) * 6 - 180 + 3;
  const phi = rad(lat);
  const dLon = rad(lon - centralMeridian);

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = EP2 * cosPhi * cosPhi;
  const AA = cosPhi * dLon;

  // Meridional arc
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));

  const x =
    K0 *
      N *
      (AA +
        ((1 - T + C) * AA ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * AA ** 5) / 120) +
    FALSE_EASTING;

  let y =
    K0 *
    (M +
      N *
        tanPhi *
        ((AA * AA) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * AA ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * AA ** 6) / 720));

  if (lat < 0) y += 10000000; // southern hemisphere false northing

  return { x: Math.round(x), y: Math.round(y), zone };
}

/**
 * Great-circle distance in kilometres. Used to match SMHI weather stations
 * to forecast regions.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
