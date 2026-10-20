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

/** The stored exaggeration (1 to 5), else 1. */
export function readExaggeration(storage) {
  try {
    const value = Number(storage?.getItem(EXAGGERATION_STORAGE_KEY));
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 1;
  } catch {
    return 1;
  }
}

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
    getExaggeration: () => exaggeration,
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
