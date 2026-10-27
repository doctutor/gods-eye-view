/**
 * Personal fork: the navigation mode (src/navigation/), shared by its
 * drop-down beside the ANALYSIS heading, the Cesium binding and the share
 * link: 'spectator' (GEV's own camera, the default), 'walk' or 'fly'. A
 * link carries `nav=walk` or `nav=fly` (none for Spectator), read once from
 * the page's hash, as the photoreal store's `lp` is.
 */
import { NAV_MODES } from './movement.js';

export const NAV_PARAM = 'nav';

/** A link's `nav` value as a mode; Spectator for none or anything else. */
export function decodeNavParam(value) {
  const mode = String(value ?? '').toLowerCase();
  return mode === 'walk' || mode === 'fly' ? mode : 'spectator';
}

/** A mode as a link's `nav` value; null for Spectator (left out). */
export const encodeNavParam = (mode) =>
  mode === 'walk' || mode === 'fly' ? mode : null;

function hashModeNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodeNavParam(new URLSearchParams(hash).get(NAV_PARAM));
  } catch {
    return 'spectator';
  }
}

export function createNavigationStore({ initial = hashModeNow() } = {}) {
  let mode = NAV_MODES.includes(initial) ? initial : 'spectator';
  const listeners = new Set();
  const entryListeners = new Set();
  return {
    get: () => mode,
    set(next) {
      if (!NAV_MODES.includes(next) || next === mode) return false;
      mode = next;
      for (const listener of [...listeners]) {
        try {
          listener(mode);
        } catch (error) {
          console.warn('[Navigation] mode listener failed:', error);
        }
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    param: () => encodeNavParam(mode),
    /**
     * "Walk here" / "Fly here": ask the binding to stand the walker on
     * the targeted block (the G key, the button beside Move); it sets the
     * mode itself once the camera is placed.
     */
    requestEntry(next) {
      if (next !== 'walk' && next !== 'fly') return false;
      for (const listener of [...entryListeners]) {
        try {
          listener(next);
        } catch (error) {
          console.warn('[Navigation] entry listener failed:', error);
        }
      }
      return entryListeners.size > 0;
    },
    onEntry(listener) {
      entryListeners.add(listener);
      return () => entryListeners.delete(listener);
    },
  };
}

let shared = null;
/** The page's store, made from its hash the first time it is asked for. */
export function navigationStore() {
  shared ||= createNavigationStore();
  return shared;
}
