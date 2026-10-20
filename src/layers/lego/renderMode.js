// Personal fork: the render mode the ANALYSIS heading's drop-down picks
// ('colour', the default, or 'lego'), and the Lego elevation exaggeration,
// both kept in this browser. One store, shared by the panel and the Lego
// controller (index.js).

export const RENDER_MODE_STORAGE_KEY = 'gev.render.mode';
export const EXAGGERATION_STORAGE_KEY = 'gev.render.legoExaggeration';
export const RENDER_MODES = Object.freeze(['colour', 'lego']);

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored mode, else colour. */
export function readRenderMode(storage) {
  try {
    const value = storage?.getItem(RENDER_MODE_STORAGE_KEY);
    return RENDER_MODES.includes(value) ? value : 'colour';
  } catch {
    return 'colour';
  }
}

/** The stored exaggeration (1 to 5), else null (never chosen). */
export function readExaggeration(storage) {
  try {
    const raw = storage?.getItem(EXAGGERATION_STORAGE_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The exaggeration when none was chosen: 2× on a flat basemap (columns on
 * the ellipsoid, where low country barely rises), 1× on terrain or the
 * photoreal tiles (the columns stand on the ground's own relief).
 */
export const defaultExaggeration = (flat) => (flat ? 2 : 1);

/** @param {{storage?: Storage|null}} [options] */
export function createRenderModeStore({ storage } = {}) {
  const store = storageOf(storage);
  let mode = readRenderMode(store);
  let exaggeration = readExaggeration(store);
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener({ mode, exaggeration });
      } catch (error) {
        console.warn('[Lego] render mode listener failed:', error);
      }
    }
  };
  const save = (key, value) => {
    try {
      store?.setItem(key, String(value));
    } catch {
      /* private mode: kept for this page only */
    }
  };
  return {
    getMode: () => mode,
    /** The chosen exaggeration, else the default for the ground (flat or not). */
    getExaggeration: (flat = true) => exaggeration ?? defaultExaggeration(flat),
    /** Whether the user chose one (gev.render.legoExaggeration). */
    isExaggerationSet: () => exaggeration !== null,
    setMode(next) {
      if (!RENDER_MODES.includes(next) || next === mode) return;
      mode = next;
      save(RENDER_MODE_STORAGE_KEY, mode);
      emit();
    },
    setExaggeration(next) {
      const value = Math.round(Number(next));
      if (!(value >= 1 && value <= 5) || value === exaggeration) return;
      exaggeration = value;
      save(EXAGGERATION_STORAGE_KEY, exaggeration);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
