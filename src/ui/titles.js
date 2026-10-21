// Personal fork: the DATA LAYERS panel's Titles toggle: whether the world
// overlay draws its 'label' entries (names on markers) at all. Kept in this
// browser (localStorage) and in the share link (the `ui` param's `tl.v.0`
// when off); a link's setting wins on load. The overlay host is handed in
// (src/app/data.js: setOverlayTitlesVisible). Not part of upstream.
import { decodeTitlesParam } from './titlesShare.js';

export {
  SHARE_UI_PARAM,
  TITLES_SHARE_PREFIX,
  decodeTitlesParam,
  encodeTitlesParam,
} from './titlesShare.js';
export const TITLES_STORAGE_KEY = 'gev.panel.titles';

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored setting: true, false, or null (never chosen). */
export function readStoredTitles(storage) {
  try {
    const raw = storageOf(storage)?.getItem(TITLES_STORAGE_KEY);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

/** The link's setting from a location's hash, or null. */
export function titlesFromHash(hash) {
  const text = String(hash || '').replace(/^#/, '');
  return text ? decodeTitlesParam(new URLSearchParams(text)) : null;
}

/**
 * The Titles setting: the link's on load, else this browser's, else on;
 * applied to the overlay host (`host`, or the one attached later) at once
 * and on every change.
 * @param {{storage?: Storage|null, hash?: string,
 *   host?: {set: (visible: boolean) => void}|null}} [options]
 */
export function createTitlesPreference({
  storage,
  hash = globalThis.location?.hash || '',
  host = null,
} = {}) {
  const store = storageOf(storage);
  const listeners = new Set();
  let visible = titlesFromHash(hash) ?? readStoredTitles(store) ?? true;
  let target = host;
  target?.set(visible);
  return {
    /** Hand over the overlay host: it takes the setting now and on change. */
    attachHost(next) {
      target = next || null;
      target?.set(visible);
    },
    get: () => visible,
    /** Turn titles on or off; kept in this browser, the listeners told. */
    set(next) {
      const value = next !== false;
      if (value === visible) return;
      visible = value;
      target?.set(value);
      try {
        store?.setItem(TITLES_STORAGE_KEY, value ? '1' : '0');
      } catch {
        /* private mode: kept for this page */
      }
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          console.warn('[Titles] listener failed:', error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;
/** The application's one Titles setting (the panel and the share link). */
export function titlesPreference() {
  shared ||= createTitlesPreference();
  return shared;
}
