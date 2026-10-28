// Personal fork: the Blocks pyramid of block sizes and its level heights
// (docs/BLOCKS-PLAN.md, milestone 5, decisions 1 and 2). Pure, shared by
// the chunk source (source.js) and the controller (index.js), so neither
// imports the other.

/**
 * The block sizes, metres: the DEM stack's native cells (1, 2, 8, 10,
 * 30 m), then ×4 from 30 m.
 */
export const BLOCK_PYRAMID_M = Object.freeze([
  1, 2, 8, 10, 30, 120, 480, 1920, 7680, 30720,
]);

/**
 * The block size for a native cell and a wanted block: the smallest
 * pyramid level at least the larger of them. A wantedM that is not a
 * finite positive number counts as the native cell; a native cell off the
 * pyramid (231 m at sea) snaps up to the next level; never above the top.
 */
export function pyramidLevelM(nativeM, wantedM) {
  const native = Number(nativeM) > 0 ? Number(nativeM) : BLOCK_PYRAMID_M[0];
  const wanted =
    Number.isFinite(wantedM) && wantedM > 0 ? Number(wantedM) : native;
  const floor = Math.max(native, wanted);
  return (
    BLOCK_PYRAMID_M.find((level) => level >= floor * (1 - 1e-9)) ??
    BLOCK_PYRAMID_M[BLOCK_PYRAMID_M.length - 1]
  );
}

/**
 * The metres a level for a block size: a cube to 30 m, above that
 * max(30 m, blockM / 32), so 1,920 m blocks stand on 60 m levels and
 * 30,720 m ones on 960 m.
 */
export const levelMFor = (blockM) =>
  blockM <= 30 ? blockM : Math.max(30, blockM / 32);
