/**
 * Where draped imagery can go on the current map stack. A globe stack drapes
 * on `viewer.imageryLayers`; a 3D-tiles stack hides the globe, and Cesium
 * 1.138 drapes imagery onto the tileset's own `imageryLayers` instead. When
 * neither exists there is nowhere to drape and the caller says so.
 */

import { msg } from '../i18n/marker.js';

/** Guidance shown when the active map stack cannot host draped imagery. */
export const NO_IMAGERY_HOST = msg(
  'Hidden by this map source · choose a globe map',
);

/**
 * Resolve the imagery layer collection for the active map stack.
 * @param {{ viewer?: object, tileset?: object }} scene
 * @returns {{ collection: object | null, kind: 'globe' | 'tileset' | 'none' }}
 */
export function resolveImageryHost({ viewer, tileset } = {}) {
  if (viewer?.scene?.globe?.show === true && viewer.imageryLayers) {
    return { collection: viewer.imageryLayers, kind: 'globe' };
  }
  if (tileset?.imageryLayers && !tileset.isDestroyed?.()) {
    return { collection: tileset.imageryLayers, kind: 'tileset' };
  }
  return { collection: null, kind: 'none' };
}

/** Web Mercator's latitude limit (degrees). */
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

/**
 * Personal fork: the union of [west, south, east, north] boxes (degrees),
 * clipped to Web Mercator, as an imagery provider's `rectangle`; null when
 * nothing finite is left. Cesium intersects a provider's rectangle with its
 * tiling scheme's and keeps undefined when they miss, and an ImageryLayer
 * over such a provider throws "Expected rectangle to be typeof object" in
 * every frame, so a layer is never built from one.
 * @param {Array<number[]>} boxes
 * @returns {number[]|null}
 */
export function imageryRectangleDegrees(boxes) {
  const ok = (boxes || []).filter(
    (box) =>
      Array.isArray(box) &&
      box.length === 4 &&
      box.every(Number.isFinite) &&
      box[0] < box[2] &&
      box[1] < box[3],
  );
  if (!ok.length) return null;
  const west = Math.max(-180, Math.min(...ok.map((b) => b[0])));
  const south = Math.max(
    -WEB_MERCATOR_MAX_LAT,
    Math.min(...ok.map((b) => b[1])),
  );
  const east = Math.min(180, Math.max(...ok.map((b) => b[2])));
  const north = Math.min(
    WEB_MERCATOR_MAX_LAT,
    Math.max(...ok.map((b) => b[3])),
  );
  return west < east && south < north ? [west, south, east, north] : null;
}
