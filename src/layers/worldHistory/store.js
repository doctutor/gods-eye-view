/**
 * Personal fork: the World history layer's state, shared by the layer, its
 * panel and the share link: on or off, the year, the year view's mode (and
 * whether place-only matches show), the list fills' opacity, and the
 * comparison list. The layer is local-only (never in `l=`), so all of it
 * rides in a hash parameter of its own, `wh` (read once, at creation, as
 * `cc` and `cs` are). Polygons are never in the URL: the list holds
 * Cliopatria names.
 *
 * The private Cottereau borders overlay's state is kept too, but written
 * to `wh` only once its route is known to answer (`bordersAvailable`
 * true). While that is unknown a state the hash brought rides on (so a
 * share link survives the page's first writes); once the route is known
 * absent, nothing of it is written.
 */
import {
  WORLD_HISTORY_MODES,
  WORLD_HISTORY_PARAM,
  addListEntry,
  clampYear,
  cleanBordersState,
  decodeWorldHistoryParam,
  defaultWorldHistoryState,
  encodeWorldHistoryParam,
  removeListEntry,
  updateListEntry,
} from '../../data/worldHistory.js';

export { WORLD_HISTORY_PARAM };

function hashStateNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodeWorldHistoryParam(
      new URLSearchParams(hash).get(WORLD_HISTORY_PARAM),
    );
  } catch {
    return defaultWorldHistoryState();
  }
}

/**
 * @param {{initial?: object}} [options] `initial` (tests) in place of the
 *   page's hash.
 */
export function createWorldHistoryStore({ initial = hashStateNow() } = {}) {
  let state = { ...defaultWorldHistoryState(), ...initial };
  /** Whether the borders route answers: null until asked. */
  let bordersAvailable = null;
  const listeners = new Set();
  const tell = () => {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[World history] listener failed:', error);
      }
    }
  };
  const set = (patch) => {
    const next = { ...state, ...patch };
    if (Object.keys(next).every((key) => next[key] === state[key])) return;
    state = next;
    tell();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled: (enabled) => set({ enabled: enabled === true }),
    setYear: (year) => set({ year: clampYear(year) }),
    setMode: (mode) => WORLD_HISTORY_MODES.includes(mode) && set({ mode }),
    setPlaces: (places) => set({ places: places === true }),
    setOpacity: (opacity) =>
      set({
        opacity:
          Math.round(Math.min(1, Math.max(0, Number(opacity) || 0)) * 100) /
          100,
      }),
    add: (name, options) =>
      set({ list: addListEntry(state.list, name, options) }),
    update: (name, patch) =>
      set({ list: updateListEntry(state.list, name, patch) }),
    remove: (name) => set({ list: removeListEntry(state.list, name) }),
    /** The list emptied (the year, mode and toggle kept). */
    clear: () => state.list.length && set({ list: [] }),
    /** The borders overlay changed: any of on, mode, labels, opacity. */
    setBorders(patch) {
      const next = cleanBordersState({ ...state.borders, ...patch });
      const now = state.borders;
      if (Object.keys(next).every((key) => next[key] === now[key])) return;
      set({ borders: next });
    },
    bordersAvailable: () => bordersAvailable,
    /** The route answered (true) or did not (false). */
    setBordersAvailable(available) {
      const next = available === true;
      if (bordersAvailable === next) return;
      bordersAvailable = next;
      tell();
    },
    /** The `wh` value for the share link ('' to leave it out). */
    param: () =>
      encodeWorldHistoryParam(state, { borders: bordersAvailable !== false }),
  };
}

let shared = null;
/** The page's store, made from its hash the first time it is asked for. */
export function worldHistoryStore() {
  shared ||= createWorldHistoryStore();
  return shared;
}
