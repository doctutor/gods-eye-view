// Personal fork: the block size Blocks draws now, for the HUD's data floor
// (src/hud/precision.js dataFloor: "· Blocks 1 m"). Set by the Blocks
// controller (index.js) while it shows chunks, null otherwise. Kept apart
// so the HUD reads it without loading the controller.

let floorM = null;

/** The block size drawn now (m), or null when Blocks shows nothing. */
export const blocksFloorM = () => floorM;

/** @param {number|null} blockM */
export function setBlocksFloorM(blockM) {
  floorM = Number(blockM) > 0 ? Number(blockM) : null;
}
