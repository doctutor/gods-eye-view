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
// The client shows the level whose cell matches the footprint (about 2 px
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

/** Cells a side of the style's footprint rule: a cell is at least this many pixels. */
export const BLOCKS_STYLE_MIN_PX = 2;

/**
 * The level to show for a pixel footprint (metres a screen pixel): the
 * smallest whose cell is at least BLOCKS_STYLE_MIN_PX pixels, else the
 * coarsest.
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
