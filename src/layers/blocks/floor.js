// Personal fork: what Blocks is doing now, for those that show it without
// loading the controller (index.js), which sets it:
// - the block size drawn, the HUD's data floor (src/hud/precision.js
//   dataFloor: "· Blocks 1 m"), null when Blocks shows nothing;
// - whether Blocks is on with the Elevation layer, and whether it hid the
//   globe: the Earth Engine layers re-drape when the globe comes and goes
//   (src/layers/earthEngine/index.js), and the Elevation row says "Shown
//   as blocks" rather than that the map hides it.

let floorM = null;
let scene = Object.freeze({ active: false, globeHidden: false });
const listeners = new Set();

/** The block size drawn now (m), or null when Blocks shows nothing. */
export const blocksFloorM = () => floorM;

/** @param {number|null} blockM */
export function setBlocksFloorM(blockM) {
  floorM = Number(blockM) > 0 ? Number(blockM) : null;
}

/** {active, globeHidden}: Blocks on with Elevation; the globe hidden by it. */
export const blocksScene = () => scene;

/** Set by the controller; listeners hear a change, after the globe is set. */
export function setBlocksScene({ active = false, globeHidden = false } = {}) {
  const next = { active: Boolean(active), globeHidden: Boolean(globeHidden) };
  if (next.active === scene.active && next.globeHidden === scene.globeHidden)
    return;
  scene = Object.freeze(next);
  for (const listener of [...listeners]) {
    try {
      listener(scene);
    } catch (error) {
      console.warn('[Blocks] scene listener failed:', error);
    }
  }
}

/** @returns {() => void} unsubscribe */
export function subscribeBlocksScene(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
