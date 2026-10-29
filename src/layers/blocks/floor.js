// Personal fork: what Blocks is doing now, for those that show it without
// loading the controller (index.js), which sets it:
// - the block size drawn, the HUD's data floor (src/hud/precision.js
//   dataFloor: "· Blocks 1 m", "· Blocks 1.9 km"), null when Blocks shows
//   nothing, and how a block size is written (blockSizeText);
// - whether Blocks is on with the Elevation layer, and whether it hid the
//   globe: the Earth Engine layers re-drape when the globe comes and goes
//   (src/layers/earthEngine/index.js), and the Elevation row says "Shown
//   as blocks" rather than that the map hides it.

import { formatNumber, t } from '../../i18n/index.js';

/**
 * A block size or level height for the status line and the HUD: metres
 * under a kilometre ("30 m", "120 m"), else kilometres to two figures
 * ("1.9 km", "7.7 km", "31 km").
 */
export function blockSizeText(metres) {
  if (!(metres >= 1000))
    return t('{size} m', {
      size: formatNumber(Math.round((Number(metres) || 0) * 10) / 10),
    });
  return t('{size} km', {
    size: formatNumber(metres / 1000, { maximumSignificantDigits: 2 }),
  });
}

let floorM = null;
let scene = Object.freeze({
  active: false,
  globeHidden: false,
  style: null,
});
const listeners = new Set();

/** The block size drawn now (m), or null when Blocks shows nothing. */
export const blocksFloorM = () => floorM;

/** @param {number|null} blockM */
export function setBlocksFloorM(blockM) {
  floorM = Number(blockM) > 0 ? Number(blockM) : null;
}

/**
 * {active, globeHidden, style}: Blocks on with Elevation; the globe hidden
 * by it; the cell of the Elevation layer's Blocks style to drape (metres,
 * src/data/blocksStyle.js), or null: the top-down picture under and beyond
 * coarse blocks, and where they cannot build.
 */
export const blocksScene = () => scene;

/** Set by the controller; listeners hear a change, after the globe is set. */
export function setBlocksScene({
  active = false,
  globeHidden = false,
  style = null,
} = {}) {
  const next = {
    active: Boolean(active),
    globeHidden: Boolean(globeHidden),
    style: Number(style) > 0 ? Number(style) : null,
  };
  if (
    next.active === scene.active &&
    next.globeHidden === scene.globeHidden &&
    next.style === scene.style
  )
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
