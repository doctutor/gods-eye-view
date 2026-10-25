// Personal fork: what the Overture boundary lines build
// (scripts/overture/boundaries.mjs), their tile server
// (server/providers/overtureBoundaries.js) and the Administrative
// boundaries layer share. Not part of upstream God's Eye View.

export const OVERTURE_BOUNDARIES_ENDPOINT = '/api/boundaries/countries';
/**
 * The tile sets the build draws: COUNTRIES' country lines, REGIONS' those
 * and the region lines, DISTRICTS' all three. A tile of a set draws only
 * its subtypes.
 */
export const BOUNDARY_SETS = Object.freeze({
  countries: Object.freeze(['country']),
  regions: Object.freeze(['country', 'region']),
  districts: Object.freeze(['country', 'region', 'county']),
  // The division areas' country outlines (their coasts), drawn by the
  // areas server from its own level files.
  coasts: Object.freeze(['coast']),
});
/** The Overture division areas: identify, fills, coasts. */
export const OVERTURE_AREAS_ENDPOINT = '/api/boundaries/areas';
/**
 * The fills' colours: twelve mid-tone categorical colours that read on a
 * black and on a white plate alike (the World history layer's), as [r, g,
 * b]; a unit's is picked by its id.
 */
export const AREA_FILL_PALETTE = Object.freeze([
  [230, 159, 0],
  [86, 180, 233],
  [0, 158, 115],
  [213, 94, 0],
  [204, 121, 167],
  [0, 114, 178],
  [181, 160, 52],
  [148, 103, 189],
  [102, 166, 30],
  [217, 95, 2],
  [27, 158, 119],
  [231, 41, 138],
]);
/** The fills' own alpha (the layer's opacity multiplies it). */
export const AREA_FILL_ALPHA = 0.35;
/** The set a level of detail of the region and county lines needs: its own subtype. */
export const SET_LEVEL = Object.freeze({
  regions: 'region',
  districts: 'county',
});
/**
 * Overture's divisions theme is ODbL; every country line of the
 * 2026-09-23.1 release names OpenStreetMap as its only source, as do its
 * region and county lines.
 */
export const OVERTURE_BOUNDARIES_ATTRIBUTION =
  'Boundary lines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL)';
export const OVERTURE_BOUNDARIES_LICENSE = Object.freeze({
  name: 'ODbL 1.0',
  url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  source: 'https://docs.overturemaps.org/guides/divisions/',
  attribution: 'https://docs.overturemaps.org/attribution/',
});
/**
 * The Administrative boundaries layer's inks ('rrggbbaa'): white on
 * imagery and dark styles; near-black on the white globe, Positron, the
 * light Stamen styles and the light Countries maps.
 */
export const BOUNDARY_INKS = Object.freeze({
  light: 'ffffffcc',
  dark: '1a1a1acc',
});
