/**
 * Personal fork: Blocks under the Relief control (docs/BLOCKS-PLAN.md
 * milestone 5, decision 2). Cesium draws the globe with
 * scene.verticalExaggeration about its relative height (photoreal.js
 * applyRelief); the blocks are drawn the same way so they stay on that
 * ground: an ellipsoidal height h drawn at (h − relativeM) × factor +
 * relativeM. The walker, its eye, the targeted block and the outline
 * follow the drawn heights; every readout keeps the true ones. One pair
 * of functions both ways, for the controller (index.js) and navigation.
 */

/** No relief: true heights. */
export const NO_RELIEF = Object.freeze({ factor: 1, relativeM: 0 });

/** A relief as given ({factor, relativeM}), checked: factor ≥ 1. */
export function reliefOf(relief) {
  const factor = Number(relief?.factor) > 1 ? Number(relief.factor) : 1;
  const relativeM = Number(relief?.relativeM);
  return factor > 1
    ? { factor, relativeM: Number.isFinite(relativeM) ? relativeM : 0 }
    : NO_RELIEF;
}

/** An ellipsoidal height as drawn under the relief. */
export const drawnHeightM = (heightM, { factor = 1, relativeM = 0 } = {}) =>
  factor > 1 ? (heightM - relativeM) * factor + relativeM : heightM;

/** A drawn ellipsoidal height's true one (drawnHeightM's inverse). */
export const trueHeightM = (drawnM, { factor = 1, relativeM = 0 } = {}) =>
  factor > 1 ? (drawnM - relativeM) / factor + relativeM : drawnM;
