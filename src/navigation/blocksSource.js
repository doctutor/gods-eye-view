/**
 * Personal fork: where navigation finds the live Blocks world. The Blocks
 * controller (src/layers/blocks/index.js) provides a getter answering, while
 * Blocks is drawn, {region, chunkAt(ci, cj) → chunk|null, geoidM,
 * sourceName} (the region of src/layers/blocks/grid.js, the loaded chunks
 * of store.js, the geoid undulation the renderer lifted the region by, and
 * the elevation source's name), else null.
 */
let provider = null;

/** Provide the Blocks world; returns the undo. */
export function provideBlocksWorld(getter) {
  provider = typeof getter === 'function' ? getter : null;
  const mine = provider;
  return () => {
    if (provider === mine) provider = null;
  };
}

/** The Blocks world now, or null (Blocks off, or no provider). */
export function blocksWorldNow() {
  try {
    const world = provider?.() ?? null;
    return world?.region && typeof world.chunkAt === 'function' ? world : null;
  } catch {
    return null;
  }
}
