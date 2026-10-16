// Personal fork: a screenshot-safe mode that hides Windy webcams.

/**
 * Windy's terms forbid publishing graphics that show its webcam images, and
 * screenshots of the app get shared. While this mode is on, Windy cameras'
 * pins, cards and panel still are hidden; their records stay loaded, so
 * turning it off shows them again without a reload.
 */
export const HIDE_WINDY_STORAGE_KEY = 'gev.cctv.hideWindy';

/** A camera from the Windy pack (server cctv/windy.js tags them 'windy'). */
export function isWindyCamera(camera) {
  return String(camera?.sourceKind || '').toLowerCase() === 'windy';
}

/** True when the mode is on and the camera is one it hides. */
export function hiddenForScreenshots(camera, hideWindy) {
  return hideWindy === true && isWindyCamera(camera);
}

/** The saved choice; off when storage is missing or unreadable. */
export function readHideWindy(storage = globalThis.localStorage) {
  try {
    return storage?.getItem?.(HIDE_WINDY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Save the choice; a failing storage (private window) only loses persistence. */
export function writeHideWindy(on, storage = globalThis.localStorage) {
  try {
    if (on) storage?.setItem?.(HIDE_WINDY_STORAGE_KEY, '1');
    else storage?.removeItem?.(HIDE_WINDY_STORAGE_KEY);
  } catch {
    /* persistence is best effort */
  }
}

/**
 * The layer method: switch the mode, save it, and redraw what it touches
 * (pins through horizon culling, cards, the hover card, listeners).
 */
export function createScreenshotSafe({ state: layerState, parts }) {
  function setHideWindy(on, { storage } = {}) {
    const next = on === true;
    writeHideWindy(next, storage);
    if (layerState._hideWindy === next) return next;
    layerState._hideWindy = next;
    if (
      next &&
      layerState._hoverCardId &&
      hiddenForScreenshots(
        layerState._recordById.get(layerState._hoverCardId)?.camera,
        true,
      )
    )
      layerState._hoverCardId = null;
    parts.rendering?.refreshHorizonCulling?.();
    parts.cards?.refreshAmbientCards?.();
    parts.cards?.pushAmbientCardEntries?.();
    parts.presentation?.notifyListeners?.();
    return next;
  }
  return { setHideWindy };
}
