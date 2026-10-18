/**
 * Personal fork: the ink an overlay draws its lines in, from the basemap's
 * luminance. Every map stack record names its `luminance` ('dark' for
 * imagery and dark styles, 'light' for the white globe, Positron, Natural
 * Earth, OpenTopoMap and the light Stamen and Countries styles); the
 * controller exposes the active one, and a layer on AUTO draws light ink
 * on a dark map and dark ink on a light one. Pure: no DOM, no Cesium.
 */

export const INK_SETTINGS = Object.freeze(['auto', 'light', 'dark']);
export const INKS = Object.freeze(['light', 'dark']);

/** The ink that reads on a basemap of a luminance. */
export function inkForLuminance(luminance) {
  return luminance === 'light' ? 'dark' : 'light';
}

/** The ink to draw: the setting, or on AUTO the one the basemap wants. */
export function resolveInk(setting, luminance) {
  return INKS.includes(setting) ? setting : inkForLuminance(luminance);
}

/** A stored ink setting, else 'auto'. */
export function readInkSetting(storage, key) {
  try {
    const value = storage?.getItem(key);
    return INK_SETTINGS.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** A controller's active luminance, 'dark' when it says nothing. */
export function activeLuminance(controller) {
  const value = controller?.getActiveLuminance?.();
  return value === 'light' ? 'light' : 'dark';
}
