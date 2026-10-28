/**
 * Personal fork: the Walk and Fly controls the user sets (the Controls
 * card beside Move): mouse sensitivity, invert Y, the vertical field of
 * view, the walk, sprint and fly speeds, sneak as hold or toggle, the
 * sprint FOV widening, view bobbing, and the key bindings. Kept in this
 * browser (localStorage, gev.nav.settings), never in the share link.
 */
import { DEFAULT_KEYS } from './inputs.js';
import {
  FLY_SPEED_M_S,
  SPRINT_SPEED_M_S,
  VERTICAL_FOV_DEG,
  WALK_SPEED_M_S,
} from './movement.js';

export const SETTINGS_KEY = 'gev.nav.settings';

/**
 * What the bindings bind: the held intents and five actions (view cycles
 * the third-person view; home sets home, with Shift goes there:
 * src/navigation/waypoints.js).
 */
export const ACTIONS = Object.freeze([
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sneak',
  'sprint',
  'up',
  'down',
  'walkHere',
  'flyHere',
  'release',
  'view',
  'home',
]);
/** The actions that are held intents (inputs.js); the rest fire once. */
const HELD = new Set(ACTIONS.slice(0, 9));

/** The fired actions' default keys. */
const FIRED_DEFAULTS = Object.freeze({
  walkHere: ['KeyG'],
  flyHere: [],
  release: ['Escape'],
  view: ['KeyT'],
  home: ['KeyB'],
});

/** Minecraft's defaults: codes per action (sprint, up and down unbound). */
export const DEFAULT_BINDINGS = Object.freeze(
  Object.fromEntries(
    ACTIONS.map((action) => [
      action,
      Object.freeze(
        action in FIRED_DEFAULTS
          ? FIRED_DEFAULTS[action]
          : Object.entries(DEFAULT_KEYS)
              .filter(([, intent]) => intent === action)
              .map(([code]) => code),
      ),
    ]),
  ),
);

/**
 * The app's own shortcuts (src/ui/applicationShortcuts.js: 1–7, h, o, v,
 * f, d, c and Esc; the frame-rate monitor's `): a binding there is
 * refused, but for an action's own default (D is Walk's right, and the
 * walker takes it first while a mode is on).
 */
export const APP_SHORTCUT_CODES = Object.freeze([
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'KeyH',
  'KeyO',
  'KeyV',
  'KeyF',
  'KeyD',
  'KeyC',
  'Escape',
  'Backquote',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1,
  invertY: false,
  fovDeg: VERTICAL_FOV_DEG,
  walk: WALK_SPEED_M_S,
  sprint: SPRINT_SPEED_M_S,
  fly: FLY_SPEED_M_S,
  sneakMode: 'hold',
  sprintFov: true,
  bobbing: false,
});

/** The numbers' ranges. */
export const BOUNDS = Object.freeze({
  sensitivity: [0.1, 2],
  fovDeg: [30, 110],
  walk: [0.5, 20],
  sprint: [0.5, 30],
  fly: [1, 50],
});

/**
 * Keys the browser keeps (Ctrl+W closes the tab, a page cannot stop it;
 * the system key; F1–F12 reload, fill the screen, open the tools): never
 * bound.
 */
const BROWSER_CODE = /^(Control|Meta|OS)(Left|Right)$|^F\d{1,2}$/;

const clamp = (value, [lo, hi]) => Math.max(lo, Math.min(hi, value));

/** A settings patch checked: numbers within their bounds, the rest typed. */
function cleanSettings(raw, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  for (const [key, bounds] of Object.entries(BOUNDS)) {
    const value = Number(raw?.[key]);
    if (raw && key in raw && Number.isFinite(value))
      out[key] = clamp(value, bounds);
  }
  for (const key of ['invertY', 'sprintFov', 'bobbing'])
    if (raw && typeof raw[key] === 'boolean') out[key] = raw[key];
  if (raw?.sneakMode === 'hold' || raw?.sneakMode === 'toggle')
    out.sneakMode = raw.sneakMode;
  return out;
}

/** Bindings checked: known actions, arrays of code strings, no code twice. */
function cleanBindings(raw) {
  const out = {};
  const seen = new Set();
  for (const action of ACTIONS) {
    const codes = Array.isArray(raw?.[action])
      ? raw[action]
      : DEFAULT_BINDINGS[action];
    out[action] = codes.filter(
      (code) => typeof code === 'string' && code && !seen.has(code),
    );
    for (const code of out[action]) seen.add(code);
  }
  return out;
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The store: `get()` the settings and their `bindings`; `set(patch)`;
 * `bind(action, code)` → {ok} or {ok: false, reason: 'browser' | 'app' |
 * 'taken', by?}; `unbind(action)`; `reset()`; `keyMap()` code → held intent;
 * `codesFor(action)`; `subscribe`.
 */
export function createNavSettings({ storage } = {}) {
  const store = storageOf(storage);
  let settings = { ...DEFAULT_SETTINGS };
  let bindings = cleanBindings(null);
  try {
    const saved = JSON.parse(store?.getItem(SETTINGS_KEY) || 'null');
    if (saved) {
      settings = cleanSettings(saved);
      bindings = cleanBindings(saved.bindings);
    }
  } catch {
    /* nothing kept, or unreadable: the defaults */
  }
  const listeners = new Set();
  const save = () => {
    try {
      store?.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, bindings }));
    } catch {
      /* not kept this time */
    }
  };
  const changed = () => {
    save();
    for (const listener of [...listeners]) {
      try {
        listener(api.get());
      } catch (error) {
        console.warn('[Navigation] settings listener failed:', error);
      }
    }
  };
  // Sections other sources add to the card (a gamepad's), each kept
  // under gev.nav.<id> beside these settings.
  const sections = new Map();
  /** Who has a code now: the action, or null. */
  const holder = (code) =>
    ACTIONS.find((action) => bindings[action].includes(code)) ?? null;

  const api = {
    get: () => ({
      ...settings,
      bindings: Object.fromEntries(
        ACTIONS.map((action) => [action, [...bindings[action]]]),
      ),
    }),
    set(patch) {
      const next = cleanSettings(patch, settings);
      if (Object.keys(next).every((key) => next[key] === settings[key]))
        return false;
      settings = next;
      changed();
      return true;
    },
    /**
     * Whether a code may be bound to an action: not the browser's, not
     * one of the app's shortcuts (unless it is that action's default),
     * not another action's. {ok: true} or {ok: false, reason, by}.
     */
    check(action, code) {
      if (!ACTIONS.includes(action) || typeof code !== 'string' || !code)
        return { ok: false, reason: 'invalid' };
      if (BROWSER_CODE.test(code)) return { ok: false, reason: 'browser' };
      const own = DEFAULT_BINDINGS[action].includes(code);
      if (APP_SHORTCUT_CODES.includes(code) && !own)
        return { ok: false, reason: 'app' };
      const by = holder(code);
      if (by && by !== action) return { ok: false, reason: 'taken', by };
      return { ok: true };
    },
    /** Bind one key to an action (its only key from then on). */
    bind(action, code) {
      const verdict = api.check(action, code);
      if (!verdict.ok) return verdict;
      bindings = { ...bindings, [action]: [code] };
      changed();
      return { ok: true };
    },
    /** No key for an action (Backspace in the capture). */
    unbind(action) {
      if (!ACTIONS.includes(action) || !bindings[action].length) return false;
      bindings = { ...bindings, [action]: [] };
      changed();
      return true;
    },
    /** Everything back to the defaults, the bindings and sections too. */
    reset() {
      settings = { ...DEFAULT_SETTINGS };
      bindings = cleanBindings(null);
      for (const section of sections.values()) section.reset({ quiet: true });
      changed();
    },
    /**
     * A section of the card for another input source: {id, title, rows:
     * [{key, label, type: 'range' | 'toggle', min, max, step, default}]}
     * (title and labels as msg() strings, the card translates them). Its
     * values are kept under gev.nav.<id> (ranges within min…max, toggles
     * booleans) and reset with the rest. Returns {id, title, rows, get(),
     * set(patch), reset(), subscribe(listener), unregister()}; registering
     * an id again replaces the section.
     */
    registerSection(spec) {
      const section = createSection(spec, store, changed);
      sections.get(section.id)?.unregister();
      sections.set(section.id, section);
      section.unregister = () => {
        if (sections.get(section.id) !== section) return;
        sections.delete(section.id);
        changed();
      };
      changed();
      return section;
    },
    /** The registered sections, in the order registered. */
    sections: () => [...sections.values()],
    /** code → held intent, for the keyboard source (inputs.js). */
    keyMap() {
      const map = {};
      for (const action of ACTIONS)
        if (HELD.has(action))
          for (const code of bindings[action]) map[code] = action;
      return map;
    },
    codesFor: (action) => [...(bindings[action] || [])],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

const SECTION_ID = /^[a-z][a-zA-Z0-9]{0,31}$/;

/** A row's value checked: ranges clamped (and finite), toggles booleans. */
function cleanRow(row, value, fallback) {
  if (row.type === 'toggle')
    return typeof value === 'boolean' ? value : fallback;
  const number = Number(value);
  if (value === null || value === '' || !Number.isFinite(number))
    return fallback;
  return clamp(number, [row.min, row.max]);
}

function createSection({ id, title, rows } = {}, store, notifyStore) {
  if (!SECTION_ID.test(String(id)) || id === 'settings')
    throw new TypeError(`a settings section needs an id like "gamepad": ${id}`);
  const clean = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.key !== 'string' || !row.key) continue;
    if (row.type === 'toggle')
      clean.push(
        Object.freeze({
          key: row.key,
          label: String(row.label ?? row.key),
          type: 'toggle',
          default: row.default === true,
        }),
      );
    else if (row.type === 'range') {
      const min = Number(row.min);
      const max = Number(row.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) continue;
      const step = Number(row.step) > 0 ? Number(row.step) : (max - min) / 100;
      const range = { type: 'range', min, max };
      clean.push(
        Object.freeze({
          key: row.key,
          label: String(row.label ?? row.key),
          ...range,
          step,
          default: cleanRow(range, row.default, min),
        }),
      );
    }
  }
  const storageKey = `gev.nav.${id}`;
  const defaults = () =>
    Object.fromEntries(clean.map((row) => [row.key, row.default]));
  let values = defaults();
  try {
    const saved = JSON.parse(store?.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object')
      for (const row of clean)
        values[row.key] = cleanRow(row, saved[row.key], row.default);
  } catch {
    /* nothing kept, or unreadable: the defaults */
  }
  const listeners = new Set();
  const changed = ({ quiet = false } = {}) => {
    try {
      store?.setItem(storageKey, JSON.stringify(values));
    } catch {
      /* not kept this time */
    }
    for (const listener of [...listeners]) {
      try {
        listener({ ...values });
      } catch (error) {
        console.warn('[Navigation] section listener failed:', error);
      }
    }
    if (!quiet) notifyStore();
  };
  return {
    id,
    title: String(title ?? id),
    rows: Object.freeze(clean),
    get: () => ({ ...values }),
    set(patch) {
      let any = false;
      for (const row of clean) {
        if (!patch || !(row.key in patch)) continue;
        const next = cleanRow(row, patch[row.key], values[row.key]);
        if (next === values[row.key]) continue;
        values = { ...values, [row.key]: next };
        any = true;
      }
      if (any) changed();
      return any;
    },
    reset(options) {
      values = defaults();
      changed(options);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unregister() {},
  };
}

let shared = null;
/** The page's settings, read from this browser the first time asked. */
export function navSettings() {
  shared ||= createNavSettings();
  return shared;
}

// ── The fly-speed wheel and the sprint FOV ────────────────────────────

/** Fly speed's range on the wheel, m/s, and the factor a notch makes. */
export const FLY_SPEED_RANGE = Object.freeze([1, 50]);
export const WHEEL_NOTCH_FACTOR = 1.25;
/** A wheel notch's deltaY in pixels (deltaMode 0), as browsers report it. */
const NOTCH_PX = 100;

/**
 * Fly speed after a wheel event (Minecraft spectator's wheel): wheel up
 * (negative deltaY) faster, down slower, WHEEL_NOTCH_FACTOR a notch, on a
 * log scale within FLY_SPEED_RANGE. Lines (deltaMode 1) count 3 a notch.
 */
export function flySpeedAfterWheel(speed, deltaY, deltaMode = 0) {
  const notches =
    (deltaMode === 1
      ? deltaY / 3
      : deltaMode === 2
        ? deltaY
        : deltaY / NOTCH_PX) || 0;
  return flySpeedAfterSteps(speed, -notches);
}

/** Fly speed `steps` notches faster (negative: slower), within the range. */
export function flySpeedAfterSteps(speed, steps) {
  const next = speed * WHEEL_NOTCH_FACTOR ** (Number(steps) || 0);
  return clamp(next, FLY_SPEED_RANGE);
}

/** Minecraft's dynamic FOV: this much wider while sprinting, eased this long. */
export const SPRINT_FOV_DEG = 10;
export const SPRINT_FOV_RAMP_S = 0.2;

/**
 * The sprint FOV widening: `update(sprinting, dt)` → the degrees to add,
 * eased linearly to SPRINT_FOV_DEG over SPRINT_FOV_RAMP_S and back.
 */
export function createFovEaser({
  boostDeg = SPRINT_FOV_DEG,
  rampS = SPRINT_FOV_RAMP_S,
} = {}) {
  let boost = 0;
  return {
    update(sprinting, dt) {
      const target = sprinting ? boostDeg : 0;
      const stepDeg = (boostDeg / rampS) * Math.max(0, Number(dt) || 0);
      boost =
        Math.abs(target - boost) <= stepDeg
          ? target
          : boost + Math.sign(target - boost) * stepDeg;
      return boost;
    },
    get boost() {
      return boost;
    },
    reset() {
      boost = 0;
    },
  };
}

// ── Sneak as a toggle, and view bobbing ───────────────────────────────

/**
 * Sneak toggled (the Controls' "Toggle"): `update(held)` → whether
 * sneaking, flipped on each press of the sneak key.
 */
export function createSneakToggle() {
  let held = false;
  let on = false;
  return {
    update(pressed) {
      if (pressed && !held) on = !on;
      held = Boolean(pressed);
      return on;
    },
    get on() {
      return on;
    },
    reset() {
      held = false;
      on = false;
    },
  };
}

/** View bobbing: the eye's dip at a footfall, metres. */
export const BOB_M = 0.05;
/**
 * A step's length, metres: Minecraft's bob runs a cycle every 3.3 blocks
 * walked, two footfalls to it (2.6 a second at the walk's 4.3 m/s).
 */
export const BOB_STEP_M = 1 / 0.6;
/** How long the bob takes to come in on starting and go on stopping. */
export const BOB_FADE_S = 0.15;

/**
 * View bobbing: `update(movedM, walking, dt)` → the eye's offset, metres
 * (0 mid-stride, -BOB_M at each footfall), fading in and out with walking.
 */
export function createBobber({
  amplitudeM = BOB_M,
  stepM = BOB_STEP_M,
  fadeS = BOB_FADE_S,
} = {}) {
  let distance = 0;
  let weight = 0;
  let offset = 0;
  return {
    update(movedM, walking, dt) {
      if (walking) distance += Math.max(0, Number(movedM) || 0);
      const target = walking ? 1 : 0;
      const stepW = Math.max(0, Number(dt) || 0) / fadeS;
      weight =
        Math.abs(target - weight) <= stepW
          ? target
          : weight + Math.sign(target - weight) * stepW;
      // (+ 0: no −0 when still.)
      offset =
        -amplitudeM *
          weight *
          (1 - Math.abs(Math.sin((Math.PI * distance) / stepM))) +
        0;
      return offset;
    },
    get offset() {
      return offset;
    },
    reset() {
      distance = 0;
      weight = 0;
      offset = 0;
    },
  };
}
