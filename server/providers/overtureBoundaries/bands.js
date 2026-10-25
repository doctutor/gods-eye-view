// Personal fork: the level of detail and the style of the self-hosted
// Overture country lines (server/providers/overtureBoundaries.js). Not part
// of upstream God's Eye View.
import crypto from 'node:crypto';
import {
  BOUNDARY_INKS,
  BOUNDARY_SETS,
} from '../../../src/data/overtureBoundaries.js';

/**
 * Zoom bands: each zoom draws from a level simplified to half a pixel at
 * `toleranceZoom` and cut into cells of zoom `gridZoom`, as the HydroSHEDS
 * v2 rivers are (riversV2/bands.js). Every band holds every line (557 in
 * the 2026-09-23.1 release, 2.6 million points); only the simplification
 * differs. The last is simplified for zoom 13 (half a pixel is 10 m at the
 * equator) and drawn as is to zoom 14.
 */
export const BANDS = Object.freeze(
  [
    { level: 'z0', minZoom: 0, maxZoom: 3, gridZoom: 1, width: 1 },
    { level: 'z4', minZoom: 4, maxZoom: 6, gridZoom: 4, width: 1.25 },
    { level: 'z7', minZoom: 7, maxZoom: 9, gridZoom: 6, width: 1.5 },
    {
      level: 'z10',
      minZoom: 10,
      maxZoom: 14,
      gridZoom: 8,
      toleranceZoom: 13,
      width: 1.5,
    },
  ].map((band) =>
    Object.freeze({
      ...band,
      toleranceZoom: band.toleranceZoom ?? band.maxZoom,
    }),
  ),
);

export const MIN_ZOOM = 0;
export const MAX_ZOOM = BANDS[BANDS.length - 1].maxZoom;

/** The band a zoom draws from, or null past the last. */
export function bandForZoom(z) {
  return BANDS.find((band) => z >= band.minZoom && z <= band.maxZoom) || null;
}

/** Simplification tolerance: half a pixel at the band's tolerance zoom. */
export const TOLERANCE_PX = 0.5;

/**
 * Quantization bits of a level's coordinates (world units per side): a
 * quarter of a pixel at the deepest zoom it serves.
 */
export const quantBitsFor = (band) => Math.min(28, band.maxZoom + 8 + 2);

/** The widest line, for the margin a cell takes in. */
export const MAX_WIDTH_PX = Math.max(...BANDS.map((band) => band.width));

/**
 * Disputed lines are dashed: DASH_ON px drawn, DASH_OFF px left, counted
 * along each segment's longer axis in world pixels, so a dash falls in the
 * same place whichever tile or cell draws it.
 */
export const DASH_ON = 4;
export const DASH_OFF = 3;

/** The inks: the Administrative boundaries layer's light and dark. */
export const INKS = BOUNDARY_INKS;
/** The tile sets and the subtypes each draws. */
export const SETS = BOUNDARY_SETS;

/** Bump to invalidate every rendered tile when the renderer changes. */
export const RENDERER_VERSION = 1;

/** What a tile in an ink and of a set looks like, as data (hashed into its version). */
export function styleSpec(ink, set = 'countries') {
  return {
    renderer: RENDERER_VERSION,
    ink: INKS[ink],
    tileSize: 256,
    bands: BANDS,
    dash: [DASH_ON, DASH_OFF],
    // The country set's style is as it was: its tiles keep their version.
    ...(set === 'countries' ? {} : { subtypes: SETS[set] }),
  };
}

/**
 * A tile version: the hash of the style in an ink (and set) and of the
 * data build, so neither a style change nor a rebuild serves an old tile.
 */
export function tileVersion(ink, buildId, set = 'countries') {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({ style: styleSpec(ink, set), build: String(buildId) }),
    )
    .digest('hex')
    .slice(0, 12);
}
