/**
 * Personal fork: UTM and MGRS arithmetic for the Grid layer's MGRS mode.
 *
 * Transverse Mercator on WGS84 by Krüger's series to sixth order in n
 * (Karney 2011), which is good to well under a millimetre within a zone,
 * and the MGRS grid-zone and 100 km square lettering (the "AA" scheme
 * WGS84 uses). No Cesium here, and no dependency.
 */

const A_WGS84 = 6378137;
const F_WGS84 = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

const n = F_WGS84 / (2 - F_WGS84);
const E = Math.sqrt(F_WGS84 * (2 - F_WGS84));
const n2 = n * n;
const n3 = n2 * n;
const n4 = n3 * n;
const n5 = n4 * n;
const n6 = n5 * n;
const RECTIFYING = (A_WGS84 / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  n / 2 -
    (2 / 3) * n2 +
    (5 / 16) * n3 +
    (41 / 180) * n4 -
    (127 / 288) * n5 +
    (7891 / 37800) * n6,
  (13 / 48) * n2 -
    (3 / 5) * n3 +
    (557 / 1440) * n4 +
    (281 / 630) * n5 -
    (1983433 / 1935360) * n6,
  (61 / 240) * n3 -
    (103 / 140) * n4 +
    (15061 / 26880) * n5 +
    (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];
const BETA = [
  n / 2 -
    (2 / 3) * n2 +
    (37 / 96) * n3 -
    (1 / 360) * n4 -
    (81 / 512) * n5 +
    (96199 / 604800) * n6,
  (1 / 48) * n2 +
    (1 / 15) * n3 -
    (437 / 1440) * n4 +
    (46 / 105) * n5 -
    (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6,
];

const RAD = Math.PI / 180;

/** The central meridian of a UTM zone, in degrees. */
export function centralMeridian(zone) {
  return (zone - 1) * 6 - 180 + 3;
}

/**
 * Latitude and longitude to a zone's grid: easting in metres (with the
 * 500 km false easting) and a signed northing, negative south of the
 * equator (no false northing, so lines stay continuous across it).
 * @returns {{easting: number, northing: number}}
 */
export function toUtm(lat, lon, zone) {
  let dLon = lon - centralMeridian(zone);
  dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
  const phi = lat * RAD;
  const lambda = dLon * RAD;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
  const tauP =
    tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const cosL = Math.cos(lambda);
  const xiP = Math.atan2(tauP, cosL);
  const etaP = Math.asinh(
    Math.sin(lambda) / Math.sqrt(tauP * tauP + cosL * cosL),
  );
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j += 1) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return {
    easting: K0 * RECTIFYING * eta + FALSE_EASTING,
    northing: K0 * RECTIFYING * xi,
  };
}

/**
 * A zone's grid back to latitude and longitude (degrees), the inverse of
 * {@link toUtm}: the same signed northing.
 */
export function fromUtm(easting, northing, zone) {
  const eta = (easting - FALSE_EASTING) / (K0 * RECTIFYING);
  const xi = northing / (K0 * RECTIFYING);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j += 1) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta = Math.sinh(etaP);
  const sinXi = Math.sin(xiP);
  const cosXi = Math.cos(xiP);
  const tauP = sinXi / Math.sqrt(sinhEta * sinhEta + cosXi * cosXi);
  let tau = tauP;
  for (let i = 0; i < 8; i += 1) {
    const sigma = Math.sinh(
      E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)),
    );
    const tauI =
      tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const delta =
      ((tauP - tauI) / Math.sqrt(1 + tauI * tauI)) *
      ((1 + (1 - E * E) * tau * tau) /
        ((1 - E * E) * Math.sqrt(1 + tau * tau)));
    tau += delta;
    if (Math.abs(delta) < 1e-14) break;
  }
  return {
    lat: Math.atan(tau) / RAD,
    lon: centralMeridian(zone) + Math.atan2(sinhEta, cosXi) / RAD,
  };
}

/** MGRS covers 80°S to 84°N; the polar caps are UPS, not drawn here. */
export const MGRS_SOUTH = -80;
export const MGRS_NORTH = 84;
const BAND_LETTERS = 'CDEFGHJKLMNPQRSTUVWX';
const COLUMN_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

/** The latitude band's index (0 for C at 80°S … 19 for X, 72–84°N). */
export function bandIndex(lat) {
  return Math.max(0, Math.min(19, Math.floor((lat - MGRS_SOUTH) / 8)));
}

export function bandLetter(lat) {
  return BAND_LETTERS[bandIndex(lat)];
}

/** A band's southern and northern edges (X is 12° tall). */
export function bandRange(index) {
  const south = MGRS_SOUTH + index * 8;
  return { south, north: index === 19 ? MGRS_NORTH : south + 8 };
}

/**
 * The grid zones of one latitude band as {zone, west, east}, west to east
 * from 180°W, with the Norway (32V) and Svalbard (31X–37X) exceptions.
 */
export function bandZones(index) {
  const zones = [];
  for (let zone = 1; zone <= 60; zone += 1) {
    const west = centralMeridian(zone) - 3;
    zones.push({ zone, west, east: west + 6 });
  }
  if (BAND_LETTERS[index] === 'V') {
    zones[30].east = 3; // 31V: 0°–3°E
    zones[31].west = 3; // 32V: 3°–12°E
  }
  if (BAND_LETTERS[index] === 'X') {
    const edges = { 31: [0, 9], 33: [9, 21], 35: [21, 33], 37: [33, 42] };
    return zones
      .filter((z) => ![32, 34, 36].includes(z.zone))
      .map((z) =>
        edges[z.zone]
          ? { zone: z.zone, west: edges[z.zone][0], east: edges[z.zone][1] }
          : z,
      );
  }
  return zones;
}

/** The UTM zone that holds a point, exceptions included. */
export function zoneOf(lat, lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const lonIn = wrapped === 180 ? -180 : wrapped;
  const found = bandZones(bandIndex(lat)).find(
    (z) => lonIn >= z.west && lonIn < z.east,
  );
  return found ? found.zone : 60;
}

/** The two letters of the 100 km square holding a grid position. */
export function squareLetters(zone, easting, northing) {
  const set = (zone - 1) % 6;
  const column = COLUMN_SETS[set % 3][Math.floor(easting / 100000) - 1] ?? '?';
  const trueNorthing =
    northing < 0 ? northing + FALSE_NORTHING_SOUTH : northing;
  const offset = set % 2 === 1 ? 5 : 0;
  const row = ROW_LETTERS[(Math.floor(trueNorthing / 100000) + offset) % 20];
  return column + row;
}

/**
 * A point's MGRS reference at a precision in metres (100000 gives the
 * square alone, 1 the full ten digits): "18S UJ 23487 06479". Null
 * outside 80°S–84°N.
 */
export function toMgrs(lat, lon, precisionM = 1) {
  if (!(lat >= MGRS_SOUTH && lat <= MGRS_NORTH) || !Number.isFinite(lon))
    return null;
  const zone = zoneOf(lat, lon);
  const { easting, northing } = toUtm(lat, lon, zone);
  const gzd = `${zone}${bandLetter(lat)}`;
  const square = `${gzd} ${squareLetters(zone, easting, northing)}`;
  const digits = Math.round(Math.log10(100000 / precisionM));
  if (digits <= 0) return square;
  const trueNorthing =
    northing < 0 ? northing + FALSE_NORTHING_SOUTH : northing;
  const part = (value) =>
    String(Math.floor((value % 100000) / precisionM)).padStart(digits, '0');
  return `${square} ${part(easting)} ${part(trueNorthing)}`;
}
