/**
 * Personal fork: the Custom cutouts layer's state, shared by the layer, its
 * panel and the share link: on or off, the plate colour, and the cutouts.
 * The layer is local-only (never in `l=`), so all of it rides in a hash
 * parameter of its own, `cc` (read once, at creation, as the colour scales'
 * `cs` is). Rings are not in the URL: they are fetched again from each
 * cutout's source.
 */
import {
  addCutout,
  decodeCutouts,
  encodeCutouts,
  removeCutout,
  updateCutout,
  PLATES,
} from '../../data/customCutouts.js';

export const CUTOUTS_PARAM = 'cc';

/** `cc`'s value: `1.` (on) or `0.` (off), then encodeCutouts' token. */
export function encodeCutoutsParam({ enabled, plate, cutouts }) {
  if (!enabled && !cutouts.length) return '';
  return `${enabled ? 1 : 0}.${encodeCutouts({ plate, cutouts })}`;
}

/** `cc`'s value back: {enabled, plate, cutouts}. */
export function decodeCutoutsParam(value) {
  const text = String(value || '');
  const match = /^([01])\.(.*)$/.exec(text);
  if (!match) return { enabled: false, plate: 'black', cutouts: [] };
  return { enabled: match[1] === '1', ...decodeCutouts(match[2]) };
}

function hashStateNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodeCutoutsParam(new URLSearchParams(hash).get(CUTOUTS_PARAM));
  } catch {
    return decodeCutoutsParam('');
  }
}

/**
 * @param {{initial?: {enabled: boolean, plate: string, cutouts: object[]}}} [options]
 *   `initial` (tests) in place of the page's hash.
 */
export function createCutoutStore({ initial = hashStateNow() } = {}) {
  let state = {
    enabled: initial.enabled === true,
    plate: PLATES.includes(initial.plate) ? initial.plate : 'black',
    cutouts: initial.cutouts || [],
  };
  const listeners = new Set();
  const set = (next) => {
    if (
      next.enabled === state.enabled &&
      next.plate === state.plate &&
      next.cutouts === state.cutouts
    )
      return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[Custom cutouts] listener failed:', error);
      }
    }
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled: (enabled) => set({ ...state, enabled: enabled === true }),
    setPlate: (plate) => PLATES.includes(plate) && set({ ...state, plate }),
    add: (cutout) =>
      set({ ...state, cutouts: addCutout(state.cutouts, cutout) }),
    update: (source, patch) =>
      set({ ...state, cutouts: updateCutout(state.cutouts, source, patch) }),
    remove: (source) =>
      set({ ...state, cutouts: removeCutout(state.cutouts, source) }),
    /** The list emptied (the plate and the toggle kept). */
    reset: () => state.cutouts.length && set({ ...state, cutouts: [] }),
    /** The `cc` value for the share link ('' to leave it out). */
    param: () => encodeCutoutsParam(state),
  };
}

let shared = null;
/** The page's store, made from its hash the first time it is asked for. */
export function cutoutStore() {
  shared ||= createCutoutStore();
  return shared;
}
