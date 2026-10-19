// Personal fork: what the Overture buildings build, its tile server and
// the Buildings layer share. Not part of upstream God's Eye View.

export const OVERTURE_BUILDINGS_ENDPOINT = '/api/overture/buildings';
/**
 * Overture's buildings theme is ODbL; its sources, as Overture's
 * attribution page lists them (docs.overturemaps.org/attribution,
 * 2026-10-19).
 */
export const OVERTURE_BUILDINGS_ATTRIBUTION =
  '© OpenStreetMap contributors, Overture Maps Foundation (ODbL). Buildings from OpenStreetMap (ODbL), Esri Community Maps contributors (CC BY 4.0), Microsoft Global ML Building Footprints (ODbL), Google Open Buildings (CC BY 4.0), the USGS 3D Elevation Program, Shi et al. East Asian building data (CC BY 4.0) and work derived from BTN 2024, ign.es (CC BY 4.0)';
/** The modes the server draws, the Buildings layer's own. */
export const OVERTURE_BUILDING_MODES = Object.freeze([
  'count',
  'cover',
  'height',
]);
/** The inks of the footprint outlines, as the Buildings layer's. */
export const OVERTURE_BUILDING_INKS = Object.freeze(['light', 'dark']);
/** From this zoom the footprints are drawn over the density. */
export const OVERTURE_FOOTPRINT_ZOOM = 15;
export const OVERTURE_BUILDINGS_MAX_ZOOM = 17;
/**
 * The density's cells are never finer than this zoom's pixels (76 m at
 * the equator), so a close view reads a density rather than one building
 * a pixel.
 */
export const OVERTURE_DENSITY_CELL_ZOOM = 11;
/** HEIGHT shows where at least this share of the ground is built… */
export const HEIGHT_MIN_COVER = 0.05;
/** …and the height of at least this share of what is built is known. */
export const HEIGHT_MIN_KNOWN = 0.25;
