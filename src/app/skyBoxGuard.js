// Personal fork: Cesium's sky box (the stars behind the globe) keeps an
// error from loading its six face images and throws it from its next
// update(), "so they aren't ignored" (SkyBox.js, CesiumGS/cesium#12307).
// That throw is inside Scene.render: Cesium shows "An error occurred while
// rendering. Rendering has stopped." and the page is frozen for good. One
// star image that fails to decode was enough: a link opening into Walk at a
// Baltimore harbour stayed at the opening orbit, its flight never advanced
// (no frames), and Blocks waited for "the camera to land" for 3 minutes
// ("InvalidStateError: The source image could not be decoded.", 1 page
// load in about 55 under load, 2026-11-11). The stars are decoration: a
// failed load is logged, asked again a couple of times, then the stars are
// left off; the page keeps rendering.

/** Loads of the six faces asked again after a failure before the stars go. */
export const SKY_BOX_RETRIES = 2;

/**
 * Guard a scene's sky box: a failed face load (SkyBox's _hasError, set
 * asynchronously by its loadCubeMap) is taken before update() can throw
 * it; that frame draws no stars, the faces are asked again (the next
 * update loads them anew) up to `retries` times, then the sky box is
 * hidden. Every other update runs as Cesium's. Returns the undo.
 * @param {object} scene a Cesium Scene
 * @param {{retries?: number, warn?: (...args: unknown[]) => void}} [options]
 * @returns {() => void}
 */
export function guardSkyBox(
  scene,
  { retries = SKY_BOX_RETRIES, warn = (...args) => console.warn(...args) } = {},
) {
  const skyBox = scene?.skyBox;
  if (!skyBox || typeof skyBox.update !== 'function') return () => {};
  const update = skyBox.update;
  let failures = 0;
  const guarded = function (frameState, ...rest) {
    if (this._hasError) {
      const error = this._error;
      this._hasError = false;
      this._error = undefined;
      failures += 1;
      if (failures <= retries) {
        // The next update sees new sources and loads all six again.
        this._sources = undefined;
        warn(
          `[Sky] the stars' images did not load (${error?.message || error}); asking again (${failures} of ${retries})`,
        );
      } else {
        this.show = false;
        warn(
          `[Sky] the stars' images did not load (${error?.message || error}); the stars are left off`,
        );
      }
      scene.requestRender?.();
      return undefined;
    }
    return update.call(this, frameState, ...rest);
  };
  skyBox.update = guarded;
  return () => {
    if (skyBox.update === guarded) delete skyBox.update;
  };
}
