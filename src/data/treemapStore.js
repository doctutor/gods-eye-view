/**
 * Personal fork: the treemap navigator's state (docs/TREEMAP-PLAN.md),
 * shared by its window and the share link: the address and the path (the
 * node shown), in one hash parameter, `tm` = `<address>` or
 * `<address>|<path>` (the path's keys URI-encoded, `/` between them). Read
 * once, from the page's hash, as `wh` and `nav` are. Whether the window is
 * open rides in the `ui` parameter with the other panels.
 */
import { formatTreemapAddress, parseTreemapAddress } from './treemapAddress.js';

export const TREEMAP_PARAM = 'tm';
/** The address a first look opens on: the administered world by area. */
export const DEFAULT_TREEMAP_ADDRESS =
  'm2/surface-area://admin.continent/admin.country/admin.region/admin.district';

/**
 * A path's keys as the share link writes them: each URI-encoded (a key may
 * hold `/` or `|`), `/` between them.
 */
export const formatTreemapPath = (keys = []) =>
  keys.map((key) => encodeURIComponent(String(key))).join('/');

/** A written path back to its keys ([] for none or a bad one). */
export function parseTreemapPath(text) {
  const value = String(text ?? '');
  if (!value) return [];
  try {
    return value.split('/').map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

/** The address as the parser writes it (spaces gone, × as *); null if bad. */
export function cleanTreemapAddress(text) {
  const parsed = parseTreemapAddress(String(text ?? ''));
  return parsed.ok ? formatTreemapAddress(parsed) : null;
}

/** A `tm` value read back: {address, path}; null for none or a bad one. */
export function decodeTreemapParam(value) {
  const text = String(value ?? '');
  if (!text) return null;
  const bar = text.indexOf('|');
  const address = bar < 0 ? text : text.slice(0, bar);
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok) return null;
  const path = bar < 0 ? [] : parseTreemapPath(text.slice(bar + 1));
  return {
    address: formatTreemapAddress(parsed),
    path: path.slice(0, parsed.groupings.length),
  };
}

/** The `tm` value for a state ('' for the default view at its root). */
export function encodeTreemapParam({ address, path = [] }) {
  if (!address) return '';
  if (address === DEFAULT_TREEMAP_ADDRESS && !path.length) return '';
  return path.length ? `${address}|${formatTreemapPath(path)}` : address;
}

function hashStateNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodeTreemapParam(new URLSearchParams(hash).get(TREEMAP_PARAM));
  } catch {
    return null;
  }
}

/** @param {{initial?: {address: string, path?: string[]}|null}} [options] */
export function createTreemapStore({ initial = hashStateNow() } = {}) {
  let state = {
    address: initial?.address || DEFAULT_TREEMAP_ADDRESS,
    path: [...(initial?.path || [])],
  };
  const listeners = new Set();
  const same = (a, b) =>
    a.address === b.address &&
    a.path.length === b.path.length &&
    a.path.every((key, index) => key === b.path[index]);
  const set = (next) => {
    const clean = {
      address: next.address ?? state.address,
      path: [...(next.path ?? state.path)],
    };
    if (same(clean, state)) return false;
    state = clean;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[Treemap] listener failed:', error);
      }
    }
    return true;
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A new address: its root (the path cut to what it still names). */
    setAddress(address, { keepPath = false } = {}) {
      const parsed = parseTreemapAddress(String(address ?? ''));
      if (!parsed.ok) return false;
      const clean = formatTreemapAddress(parsed);
      return set({
        address: clean,
        path: keepPath ? state.path.slice(0, parsed.groupings.length) : [],
      });
    },
    /** Into a child (its key). */
    enter: (key) => set({ path: [...state.path, String(key)] }),
    /** Out to `depth` keys (0: the root). */
    up: (depth = state.path.length - 1) =>
      set({ path: state.path.slice(0, Math.max(0, depth)) }),
    /** The `tm` value for the share link ('' to leave it out). */
    param: () => encodeTreemapParam(state),
  };
}

let shared = null;
/** The page's store, made from its hash the first time it is asked for. */
export function treemapStore() {
  shared ||= createTreemapStore();
  return shared;
}
