/**
 * Personal fork: wayfinding for Walk and Fly (docs/BLOCKS-PLAN.md lesson
 * 12): a home and a list of waypoints, kept in this browser (never in a
 * link), and the keys that go with them and with the third-person view.
 *
 * A place is where the walker stood: {lon, lat, heightM (the eye's, the
 * camera's datum), level (the block under the feet, under Blocks), blockM,
 * headingDeg}. Places are absolute, so they outlive the Blocks region they
 * were set in (a region is anchored at the camera and changes as one goes).
 * Going to one asks the navigation store for an entry with a pose
 * (store.requestEntry(mode, pose)): Walk from Spectator, the mode kept from
 * Walk or Fly.
 */
import { formatNumber, t } from '../i18n/index.js';
import { navSettings } from './settings.js';
import { navigationStore } from './store.js';

export const HOME_STORAGE_KEY = 'gev.nav.home';
export const WAYPOINTS_STORAGE_KEY = 'gev.nav.waypoints';
/** Waypoints kept at most (the oldest go). */
export const MAX_WAYPOINTS = 50;
/**
 * The default keys (KeyboardEvent.code): T cycles the view, B sets home,
 * Shift+B goes home. The page's come from the Controls' bindings
 * (settings.js 'view' and 'home'), rebindable there.
 */
export const WAYFINDING_KEYS = Object.freeze({
  view: 'KeyT',
  home: 'KeyB',
});

const finite = (value) => Number.isFinite(Number(value));

/** A stored place checked: the fields it must have, rounded; null when not one. */
export function normalizePlace(place) {
  if (!place || !finite(place.lon) || !finite(place.lat)) return null;
  const lon = Number(place.lon);
  const lat = Number(place.lat);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lon: Math.round(lon * 1e7) / 1e7,
    lat: Math.round(lat * 1e7) / 1e7,
    heightM: finite(place.heightM)
      ? Math.round(Number(place.heightM) * 100) / 100
      : null,
    level: Number.isInteger(place.level) ? place.level : null,
    blockM: finite(place.blockM) ? Number(place.blockM) : null,
    headingDeg: finite(place.headingDeg)
      ? ((Number(place.headingDeg) % 360) + 360) % 360
      : 0,
  };
}

/** A place's line: "39.32140, −76.62920 · level 37" (or the height). */
export function placeText(place) {
  const lat = formatNumber(place.lat, {
    maximumFractionDigits: 5,
    minimumFractionDigits: 5,
  });
  const lon = formatNumber(place.lon, {
    maximumFractionDigits: 5,
    minimumFractionDigits: 5,
  });
  const where = `${lat}, ${lon}`;
  if (Number.isInteger(place.level))
    return t('{where} · level {level}', {
      where,
      level: formatNumber(place.level),
    });
  if (Number.isFinite(place.heightM))
    return t('{where} · {height} m', {
      where,
      height: formatNumber(Math.round(place.heightM)),
    });
  return where;
}

/**
 * The home and the waypoints, kept in `storage` (localStorage unless
 * given). Waypoints are {id, name, ...place}.
 */
export function createWaypointStore({ storage, now = () => Date.now() } = {}) {
  let store = storage;
  if (store === undefined) {
    try {
      store = globalThis.localStorage ?? null;
    } catch {
      store = null;
    }
  }
  const read = (key, fallback) => {
    try {
      const raw = store?.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      if (value === null) store?.removeItem?.(key);
      else store?.setItem(key, JSON.stringify(value));
    } catch {
      /* kept for this page */
    }
  };
  let home = normalizePlace(read(HOME_STORAGE_KEY, null));
  const saved = read(WAYPOINTS_STORAGE_KEY, []);
  let waypoints = (Array.isArray(saved) ? saved : [])
    .map((entry) => {
      const place = normalizePlace(entry);
      return place && typeof entry.id === 'string'
        ? {
            id: entry.id,
            name: String(entry.name || '').slice(0, 60),
            ...place,
          }
        : null;
    })
    .filter(Boolean);
  let counter = 0;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[Navigation] waypoint listener failed:', error);
      }
    }
  };
  return {
    home: () => home,
    setHome(place) {
      const next = normalizePlace(place);
      if (!next) return false;
      home = next;
      write(HOME_STORAGE_KEY, home);
      emit();
      return true;
    },
    clearHome() {
      home = null;
      write(HOME_STORAGE_KEY, null);
      emit();
    },
    list: () => waypoints,
    add(place, name = '') {
      const next = normalizePlace(place);
      if (!next) return null;
      const id = `w${now().toString(36)}${(counter++).toString(36)}`;
      const label =
        String(name || '')
          .trim()
          .slice(0, 60) ||
        t('Waypoint {n}', { n: formatNumber(waypoints.length + 1) });
      const entry = { id, name: label, ...next };
      waypoints = [...waypoints, entry].slice(-MAX_WAYPOINTS);
      write(WAYPOINTS_STORAGE_KEY, waypoints);
      emit();
      return entry;
    },
    remove(id) {
      const before = waypoints.length;
      waypoints = waypoints.filter((entry) => entry.id !== id);
      if (waypoints.length === before) return false;
      write(WAYPOINTS_STORAGE_KEY, waypoints);
      emit();
      return true;
    },
    get: (id) => waypoints.find((entry) => entry.id === id) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The pose an entry takes to a place: its eye, heading, looking level. */
export function poseFor(place) {
  return {
    lon: place.lon,
    lat: place.lat,
    heightM: place.heightM,
    headingDeg: place.headingDeg ?? 0,
    pitchDeg: 0,
  };
}

/**
 * Wayfinding: the store, the walker's place now (`walker()`: the binding's
 * place, null in Spectator), and going (the navigation store's entry with
 * a pose).
 * @param {{navStore: {get: () => string, requestEntry: Function},
 *   waypoints?: object, walker: () => object|null}} options
 */
export function createWayfinding({
  navStore,
  waypoints = createWaypointStore(),
  walker,
}) {
  const here = () => {
    try {
      return walker?.() ?? null;
    } catch {
      return null;
    }
  };
  /** Go to a place: Walk from Spectator, else the mode in use. */
  const go = (place) => {
    if (!place) return false;
    const mode = navStore.get() === 'fly' ? 'fly' : 'walk';
    return navStore.requestEntry?.(mode, poseFor(place)) ?? false;
  };
  return {
    waypoints,
    here,
    setHome: () => waypoints.setHome(here()),
    goHome: () => go(waypoints.home()),
    addWaypoint: (name) => waypoints.add(here(), name),
    goTo: (id) => go(waypoints.get(id)),
    remove: (id) => waypoints.remove(id),
  };
}

/** Whether a key event belongs to a form field (typing goes there). */
const isFormTarget = (target) =>
  Boolean(
    target?.closest?.('input, textarea, select, [contenteditable="true"]') ||
    target?.isContentEditable,
  );

/**
 * The wayfinding keys, in Walk and Fly only (Spectator keeps GEV's): T
 * cycles first person → behind → in front; B sets home; Shift+B goes home.
 * No Ctrl, Alt or Meta; not in form fields; not repeated. `keys` is
 * {view, home} (a code or codes each), or a function giving it: by
 * default the Controls' bindings, read at each key so a rebinding applies
 * at once.
 * @returns {() => void} detach
 */
export function attachWayfindingKeys({
  documentRef = globalThis.document,
  navStore,
  view,
  wayfinding,
  settings = navSettings(),
  keys = () => ({
    view: settings.codesFor('view'),
    home: settings.codesFor('home'),
  }),
}) {
  const codesOf = (value) => [].concat(value ?? []);
  const onKey = (event) => {
    if (navStore.get() === 'spectator') return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isFormTarget(event.target)) return;
    const map = typeof keys === 'function' ? keys() : keys;
    if (codesOf(map.view).includes(event.code) && !event.shiftKey) {
      view.cycle();
      event.preventDefault();
    } else if (codesOf(map.home).includes(event.code)) {
      if (event.shiftKey) wayfinding.goHome();
      else wayfinding.setHome();
      event.preventDefault();
    }
  };
  documentRef?.addEventListener?.('keydown', onKey);
  return () => documentRef?.removeEventListener?.('keydown', onKey);
}

let shared = null;
/** The page's wayfinding: its store, the walker the shell provides, the navigation store. */
export function pageWayfinding() {
  shared ||= createWayfinding({
    navStore: navigationStore(),
    walker: () => walkerNow(),
  });
  return shared;
}

let walkerGetter = null;
/** The shell registers where the walker stands (the binding's place). */
export function provideWalker(getter) {
  walkerGetter = getter;
  return () => {
    if (walkerGetter === getter) walkerGetter = null;
  };
}
/** Where the walker stands now, or null. */
export const walkerNow = () => walkerGetter?.() ?? null;
