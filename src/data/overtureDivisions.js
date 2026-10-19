// Personal fork: what the Overture divisions build, its server and the
// Localities layer share: the release, which division points are kept,
// the zoom each is named from, and the answer's limits. Not part of
// upstream God's Eye View.

/** The Overture Maps release the build reads (schema v2.0.0). */
export const OVERTURE_RELEASE = '2026-09-23.1';
export const OVERTURE_ENDPOINT = '/api/overture';
export const OVERTURE_ATTRIBUTION =
  '© OpenStreetMap contributors, Overture Maps Foundation';
export const OVERTURE_LICENSE = 'ODbL 1.0';

/**
 * The kinds of place kept, each with its code in the index (one byte) and
 * the zoom it is named from at the latest. A locality is named from the
 * zoom its prominence gives (zoomForProminence) or its class's, whichever
 * comes first; the others carry no prominence in this release, so their
 * kind decides (a large population brings a neighbourhood or a
 * municipality in sooner). County and localadmin points are kept only
 * with a population (municipalities, townships); country, dependency and
 * region points are left out: they name areas, which the Boundaries layer
 * draws.
 */
export const OVERTURE_KINDS = Object.freeze([
  Object.freeze({ code: 1, kind: 'city', zoom: 9 }),
  Object.freeze({ code: 2, kind: 'town', zoom: 11 }),
  Object.freeze({ code: 3, kind: 'village', zoom: 13 }),
  Object.freeze({ code: 4, kind: 'hamlet', zoom: 15 }),
  Object.freeze({ code: 5, kind: 'locality', zoom: 14 }),
  Object.freeze({ code: 6, kind: 'localadmin', zoom: 12 }),
  Object.freeze({ code: 7, kind: 'county', zoom: 11 }),
  Object.freeze({ code: 8, kind: 'macrohood', zoom: 12 }),
  Object.freeze({ code: 9, kind: 'neighborhood', zoom: 14 }),
  Object.freeze({ code: 10, kind: 'microhood', zoom: 16 }),
]);
const KIND_BY_NAME = new Map(OVERTURE_KINDS.map((k) => [k.kind, k]));
const KIND_BY_CODE = new Map(OVERTURE_KINDS.map((k) => [k.code, k]));

/** The deepest zoom the index tells apart; a deeper view asks for this one. */
export const OVERTURE_MAX_ZOOM = 16;

/** The kind of a division point (its subtype, a locality's class), or null if not kept. */
export function overtureKind(subtype, klass, population = 0) {
  if (subtype === 'locality')
    return KIND_BY_NAME.get(klass) || KIND_BY_NAME.get('locality');
  if (subtype === 'county' || subtype === 'localadmin')
    return population > 0 ? KIND_BY_NAME.get(subtype) : null;
  if (
    subtype === 'macrohood' ||
    subtype === 'neighborhood' ||
    subtype === 'microhood'
  )
    return KIND_BY_NAME.get(subtype);
  return null;
}

export const overtureKindOfCode = (code) => KIND_BY_CODE.get(code) || null;

/**
 * The zoom Overture's prominence (1–100) names a locality from: 100 (the
 * largest cities) from z 2, 50 from z 9, 30 from z 12, 10 from z 15.
 */
export function zoomForProminence(prominence) {
  const p = Number(prominence);
  if (!(p > 0)) return OVERTURE_MAX_ZOOM;
  return Math.min(OVERTURE_MAX_ZOOM, Math.max(2, Math.round(16 - p * 0.14)));
}

/**
 * The zoom a kept point is named from: its kind's, sooner for a prominent
 * locality, and a zoom sooner for each tenfold of population past 10,000
 * for the kinds without prominence.
 */
export function overtureMinZoom({ kind, prominence = 0, population = 0 }) {
  const record = typeof kind === 'string' ? KIND_BY_NAME.get(kind) : kind;
  if (!record) return OVERTURE_MAX_ZOOM;
  let zoom = record.zoom;
  if (prominence > 0) zoom = Math.min(zoom, zoomForProminence(prominence));
  else if (population >= 10_000)
    zoom -= Math.min(4, Math.floor(Math.log10(population / 10_000)) + 1);
  return Math.max(2, Math.min(OVERTURE_MAX_ZOOM, zoom));
}

/** The most places one answer brings. */
export const OVERTURE_PLACE_LIMIT = 800;
/** Two places of one name within this distance are one (the more prominent stays). */
export const OVERTURE_SAME_PLACE_KM = 5;
/** The widest view the server answers, in degrees of latitude and longitude. */
export const OVERTURE_MAX_SPAN_DEGREES = 12;
