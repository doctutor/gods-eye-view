// Personal fork: paint the bare globe for the blank basemaps, and restore
// Cesium's own colour when another globe source takes over.

/** The globe's colour before the first blank basemap painted it. */
const originals = new WeakMap();

/**
 * Apply a source's globe colour, or restore the original when it has none.
 * @param {object} viewer Cesium viewer (or a test stand-in with scene.globe).
 * @param {object} [color] A Cesium.Color; undefined restores the original.
 */
export function applyGlobeBaseColor(viewer, color) {
  const globe = viewer?.scene?.globe;
  if (!globe) return;
  if (!originals.has(globe)) originals.set(globe, globe.baseColor);
  globe.baseColor = color ?? originals.get(globe);
}
