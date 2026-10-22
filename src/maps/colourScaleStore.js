/**
 * Personal fork: the colour scales of every ramp layer (the model and its
 * serialisation: colourScale.js), kept per layer and mode in this browser
 * (localStorage gev.colourScale.<key>) and read from the share hash (`cs`)
 * once, at creation, the hash winning. One store for the app: the layers,
 * the panel's Scale controls and the share link share it.
 */

import {
  COLOUR_SCALE_PARAM,
  COLOUR_SCALE_STORAGE_PREFIX,
  decodeColourScaleParam,
  isDefaultScale,
  normalizeScale,
  scaleKey,
} from './colourScale.js';

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function hashScalesNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodeColourScaleParam(
      new URLSearchParams(hash).get(COLOUR_SCALE_PARAM),
    );
  } catch {
    return {};
  }
}

/**
 * The colour scales of every layer: read from storage when first asked
 * for, the share hash's (read once, at creation) winning; written to
 * storage on change (removed at the default); listeners told of every
 * change (the share link, the layers).
 * @param {{storage?: Storage|null, hashScales?: object}} [options]
 */
export function createColourScaleStore({
  storage,
  hashScales = hashScalesNow(),
} = {}) {
  const store = storageOf(storage);
  const defaultsByKey = new Map();
  const models = new Map();
  const listeners = new Set();
  const fromHash = { ...hashScales };

  const emit = (key) => {
    for (const listener of listeners) {
      try {
        listener(key);
      } catch (error) {
        console.warn('[ColourScale] listener failed:', error);
      }
    }
  };
  const readStored = (key) => {
    try {
      const raw = store?.getItem(`${COLOUR_SCALE_STORAGE_PREFIX}${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const writeStored = (key, model, defaults) => {
    try {
      if (isDefaultScale(model, defaults))
        store?.removeItem(`${COLOUR_SCALE_STORAGE_PREFIX}${key}`);
      else
        store?.setItem(
          `${COLOUR_SCALE_STORAGE_PREFIX}${key}`,
          JSON.stringify(model),
        );
    } catch {
      /* private mode: kept for this page */
    }
  };

  return {
    /**
     * A layer's scale for a key, its defaults registered on first use
     * (a layer calls this whenever it paints or builds its row).
     */
    get(key, defaults) {
      if (!defaultsByKey.has(key)) defaultsByKey.set(key, defaults);
      if (!models.has(key)) {
        const raw = Object.hasOwn(fromHash, key)
          ? fromHash[key]
          : readStored(key);
        models.set(key, normalizeScale(raw || defaults.model, defaults));
      }
      return models.get(key);
    },
    /** Set a key's scale (normalised against its defaults); stored and told. */
    set(key, input) {
      const defaults = defaultsByKey.get(key);
      if (!defaults) throw new Error(`No colour scale defaults for ${key}`);
      const model = normalizeScale(
        { ...this.get(key, defaults), ...input },
        defaults,
      );
      if (JSON.stringify(model) === JSON.stringify(models.get(key)))
        return model;
      models.set(key, model);
      writeStored(key, model, defaults);
      emit(key);
      return model;
    },
    /** Back to the layer's default (auto window, its own ramp). */
    reset(key) {
      const defaults = defaultsByKey.get(key);
      if (!defaults) return null;
      models.set(key, defaults.model);
      writeStored(key, defaults.model, defaults);
      emit(key);
      return defaults.model;
    },
    /**
     * A layer and mode's scale when a user has changed it, else null (the
     * layer draws as it always did). Its defaults must have been
     * registered through get().
     */
    getScale(layerId, mode = '') {
      const key = scaleKey(layerId, mode);
      const defaults = defaultsByKey.get(key);
      if (!defaults) return null;
      const model = this.get(key, defaults);
      return isDefaultScale(model, defaults) ? null : model;
    },
    /** Whether a key's scale is its layer's default. */
    isDefault(key) {
      const defaults = defaultsByKey.get(key);
      return !defaults || isDefaultScale(this.get(key, defaults), defaults);
    },
    /** A key's registered defaults, or null. */
    defaultsOf: (key) => defaultsByKey.get(key) || null,
    /** Every scale that is not its layer's default, for the share hash: {key: model}. */
    snapshot() {
      const out = {};
      for (const [key, model] of models)
        if (!isDefaultScale(model, defaultsByKey.get(key))) out[key] = model;
      // Hash scales of layers not yet built still travel on.
      for (const [key, raw] of Object.entries(fromHash))
        if (!models.has(key)) out[key] = raw;
      return out;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;
/** The app's one store (layers, the panel and the share link share it). */
export function colourScales() {
  shared ||= createColourScaleStore();
  return shared;
}
