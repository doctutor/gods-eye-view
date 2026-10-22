// Personal fork: what the Overture country lines build
// (scripts/overture/boundaries.mjs), their tile server
// (server/providers/overtureBoundaries.js) and the Administrative
// boundaries layer share. Not part of upstream God's Eye View.

export const OVERTURE_BOUNDARIES_ENDPOINT = '/api/boundaries/countries';
/**
 * Overture's divisions theme is ODbL; every country line of the
 * 2026-09-23.1 release names OpenStreetMap as its only source.
 */
export const OVERTURE_BOUNDARIES_ATTRIBUTION =
  'Country lines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL)';
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
