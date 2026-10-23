/**
 * Personal fork: Maryland's property parcels as a Custom cutouts source
 * (MD iMAP "Parcel Boundaries", statewide polygons from MDP and SDAT). Pure,
 * shared by the server route (server/providers/mdParcels.js) and the
 * cutouts' client source: the upstream query, its parsing into rings, the
 * state's box, and the cutout source key `mdp:<JURSCODE>-<ACCTID>`.
 *
 * Privacy: the layer also carries owners' names and mailing addresses.
 * Only MD_PARCEL_FIELDS are ever asked for, and only they are kept.
 */

/** The ArcGIS MapServer layer, on the host that answers (the usual one second). */
export const MD_PARCELS_HOSTS = Object.freeze([
  'mdgeodata.md.gov',
  'geodata.md.gov',
]);
export const MD_PARCELS_PATH =
  '/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer/0/query';
/** The fields asked for: never owners' names or mailing addresses. */
export const MD_PARCEL_FIELDS = Object.freeze([
  'ACCTID',
  'ADDRESS',
  'ACRES',
  'JURSCODE',
]);
/** The credit line the service names. */
export const MD_PARCELS_CREDIT_TEXT = 'MD iMAP, MDP, SDAT';
/** The app's route. */
export const MD_PARCELS_ROUTE = '/api/parcels/md';

/**
 * Maryland's box with a little margin (the state spans 37.89–39.72° N,
 * 79.49–75.05° W); points outside are refused without asking upstream.
 */
export const MARYLAND_BOX = Object.freeze({
  west: -79.55,
  south: 37.85,
  east: -74.98,
  north: 39.76,
});

export const inMaryland = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= MARYLAND_BOX.south &&
  lat <= MARYLAND_BOX.north &&
  lon >= MARYLAND_BOX.west &&
  lon <= MARYLAND_BOX.east;

/** A jurisdiction code (BACI, BACO, MONT…) and an account id as SDAT writes them. */
const JURSCODE = /^[A-Z]{2,6}$/;
const ACCTID = /^[A-Za-z0-9 ]{1,40}$/;
export const validJurscode = (value) => JURSCODE.test(String(value ?? ''));
export const validAcctid = (value) => ACCTID.test(String(value ?? ''));

const common = () => ({
  outFields: MD_PARCEL_FIELDS.join(','),
  returnGeometry: 'true',
  outSR: '4326',
  f: 'geojson',
});

/** The query string for the parcels under a point (lon, lat in WGS 84). */
export function parcelPointQuery(lat, lon) {
  return new URLSearchParams({
    geometry: `${Number(lon)},${Number(lat)}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    ...common(),
  }).toString();
}

/** The query string for one parcel by its jurisdiction and account id. */
export function parcelKeyQuery(jurscode, acctid) {
  if (!validJurscode(jurscode) || !validAcctid(acctid))
    throw new TypeError('A parcel key is a jurisdiction code and account id');
  return new URLSearchParams({
    where: `JURSCODE='${jurscode}' AND ACCTID='${acctid}'`,
    ...common(),
  }).toString();
}

const ringOf = (coordinates) =>
  Array.isArray(coordinates)
    ? coordinates
        .filter(
          (p) =>
            Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
        )
        .map((p) => [p[0], p[1]])
    : [];

/** A geometry's outer rings ([lon, lat] each): one per polygon part. */
function outerRings(geometry) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  return (polygons || [])
    .map((polygon) => ringOf(polygon?.[0]))
    .filter((ring) => ring.length >= 4);
}

/**
 * The parcels of an upstream GeoJSON answer: [{acctid, jurscode, address,
 * acres, rings}], inner rings (holes) left out like the admin cutouts', and
 * nothing but those fields kept. An ArcGIS error ({error: {code,
 * message}}, sent with 200) throws.
 */
export function parcelsFromGeoJson(json) {
  if (json?.error)
    throw new Error(
      `MD iMAP answered ${json.error.code ?? 'an error'}: ${String(json.error.message || '').slice(0, 120)}`,
    );
  if (!Array.isArray(json?.features))
    throw new Error('MD iMAP answered something other than GeoJSON');
  const out = [];
  for (const feature of json.features) {
    const p = feature?.properties || {};
    const acctid = String(p.ACCTID ?? '').trim();
    const jurscode = String(p.JURSCODE ?? '').trim();
    const rings = outerRings(feature?.geometry);
    if (!validAcctid(acctid) || !validJurscode(jurscode) || !rings.length)
      continue;
    const acres =
      p.ACRES === null || p.ACRES === undefined || p.ACRES === ''
        ? NaN
        : Number(p.ACRES);
    out.push({
      acctid,
      jurscode,
      address: String(p.ADDRESS ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      acres: Number.isFinite(acres) ? Math.round(acres * 1000) / 1000 : null,
      rings,
    });
  }
  return out;
}

// ── The cutout source key ───────────────────────────────────────────────

/** The source pattern customCutouts.js accepts (`mdp:BACI-0327665082_008A`). */
export const MD_PARCEL_SOURCE_PATTERN = 'mdp:[A-Z]{2,6}-[A-Za-z0-9_]{1,40}';

/** A parcel's cutout source key: spaces in the account id become `_`. */
export const parcelSourceKey = ({ jurscode, acctid }) =>
  `mdp:${jurscode}-${String(acctid).replace(/ /g, '_')}`;

/** A source key back to {jurscode, acctid}, or null. */
export function parseParcelSourceKey(source) {
  const match = /^mdp:([A-Z]{2,6})-([A-Za-z0-9_]{1,40})$/.exec(
    String(source ?? ''),
  );
  if (!match) return null;
  return { jurscode: match[1], acctid: match[2].replace(/_/g, ' ') };
}

/** A parcel's cutout name: its street address in title case, else its account id. */
export function parcelName({ address, acctid }) {
  const text = String(address || '').trim();
  if (!text) return `Parcel ${acctid}`;
  return text
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .slice(0, 80);
}
