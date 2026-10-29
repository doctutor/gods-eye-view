// Personal fork: the Blocks style of the Elevation layer (docs/BLOCKS-PLAN.md,
// milestone 5, decision 6): the continental picture top-down, computed in
// Earth Engine (server/providers/earthEngine.js blocksStyleExpression) at
// a coarse pyramid level: heights averaged over the level's cells,
// quantised to its level height, each cell flat-shaded by the quantised
// hillshade and edged in a darker tone. One map a level, made when its
// first tile is asked, on the Elevation layer's moded tile route:
//
//   GET /api/earth-engine/tile/ee-elevation/blocks-<cellM>/<variant>/default/<z>/<x>/<y>
//
// The client shows the level whose cell matches the footprint (about 8 px
// a cell: blocksStyleLevelFor). Shared by the server and the client.

/** The coarse pyramid levels the style draws, metres a cell (source.js's). */
export const BLOCKS_STYLE_LEVELS_M = Object.freeze([
  120, 480, 1920, 7680, 30720,
]);

/** The layer the style belongs to. */
export const BLOCKS_STYLE_LAYER = 'ee-elevation';

/** A level's mode key on the tile route: 'blocks-<cellM>'. */
export const blocksStyleMode = (cellM) => `blocks-${cellM}`;

/** A mode key's cell in metres, or null when it is not one of the style's. */
export function blocksStyleCell(mode) {
  const match = /^blocks-(\d+)$/.exec(String(mode ?? ''));
  const cellM = match ? Number(match[1]) : NaN;
  return BLOCKS_STYLE_LEVELS_M.includes(cellM) ? cellM : null;
}

/**
 * The metres a level of a cell (milestone 5, decision 2): a cube at the
 * native cells (30 m and under), above them max(30 m, cell / 32), so a
 * 1,920 m cell stands on 60 m levels and a 30,720 m one on 960 m.
 */
export const blocksLevelM = (cellM) =>
  cellM <= 30 ? cellM : Math.max(30, cellM / 32);

/**
 * The style's footprint rule: a cell is at least this many pixels, so its
 * edge line (an eighth of the cell) is at least one.
 */
export const BLOCKS_STYLE_MIN_PX = 8;

/** The deepest tile zoom the style is drawn at: the Elevation layer's. */
export const BLOCKS_STYLE_MAX_ZOOM = 14;
/** A web-mercator tile pixel at zoom 0 on the equator, metres. */
const TILE0_PIXEL_M = 156_543.03392804097;
/** Zooms below a level's own that still draw it; coarser ones are blank. */
export const BLOCKS_STYLE_ZOOMS_BELOW = 2;

/**
 * A level's own tile zoom: the deepest at which a cell is at most
 * BLOCKS_STYLE_MIN_PX pixels on the equator (more than half that: about
 * 6.3 px; 120 m: 13, 480 m: 11, 1,920 m: 9, 7,680 m: 7, 30,720 m: 5).
 */
export const blocksStyleZoom = (cellM) =>
  Math.floor(Math.log2((TILE0_PIXEL_M * BLOCKS_STYLE_MIN_PX) / cellM));

/**
 * The tile zooms a level is drawn at, {min, max}: from
 * BLOCKS_STYLE_ZOOMS_BELOW under its own zoom (a cell of about 1.6 px on
 * the equator) to the layer's deepest. A coarser tile is answered blank by the server, with
 * no Earth Engine request: Cesium asks for ancestor tiles whatever the
 * view, and a level's mean over a whole continent at a quarter pixel a
 * cell is more than a map tile may take. The client sets its imagery
 * provider's minimumLevel and maximumLevel to these.
 */
export function blocksStyleZoomBand(cellM) {
  return {
    min: Math.max(0, blocksStyleZoom(cellM) - BLOCKS_STYLE_ZOOMS_BELOW),
    max: BLOCKS_STYLE_MAX_ZOOM,
  };
}

/**
 * The level to show for a pixel footprint (metres a screen pixel): the
 * smallest whose cell is at least BLOCKS_STYLE_MIN_PX pixels, else the
 * coarsest (whose cells are then smaller than that, the edges thinner
 * than a pixel).
 */
export function blocksStyleLevelFor(pixelM) {
  const wanted = BLOCKS_STYLE_MIN_PX * (Number(pixelM) || 0);
  return (
    BLOCKS_STYLE_LEVELS_M.find((cellM) => cellM >= wanted) ??
    BLOCKS_STYLE_LEVELS_M[BLOCKS_STYLE_LEVELS_M.length - 1]
  );
}

/**
 * The tile URL template of a level ({variant}, {z}, {x}, {y} left to fill,
 * as the catalog's templates), under `route` (/api/earth-engine).
 */
export const blocksStyleTemplate = (cellM, route = '/api/earth-engine') =>
  `${route}/tile/${BLOCKS_STYLE_LAYER}/${blocksStyleMode(cellM)}/{variant}/default/{z}/{x}/{y}`;
