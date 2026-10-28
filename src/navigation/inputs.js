/**
 * Personal fork: what the walker is asked to do this frame, from any
 * number of input sources (the keyboard and mouse are source one; a
 * gamepad is another). Each source's `read(dt)` returns partial intents;
 * they are merged every frame (held intents OR'd, look deltas added,
 * one-shot events OR'd) and turned into the movement model's input for
 * the mode (inputFromIntents). Pure but for the keyboard source's DOM
 * events, which the binding feeds it.
 *
 * The intents:
 *   forward, back, left, right, jump, sneak, sprint, up, down — held
 *     (booleans; up and down are Fly's, besides jump and sneak);
 *   lookDx, lookDy — look deltas this frame, in pointer-lock pixels at the
 *     source's own sensitivity and inversion (the mouse's from the
 *     Controls, applied as it moves; a gamepad its own): the model turns
 *     LOOK_RAD_PER_PX a pixel, +x right, +y down;
 *   analog — {forward, right}, each −1…1 (a stick): per axis the larger
 *     of it and the keys' ±1 wins, and its magnitude scales the speed up
 *     to the mode's;
 *   walkHere, flyHere — one-shot events (Spectator's "Walk here" / "Fly
 *     here");
 *   release — one-shot: leave the mode (the pointer let go, Spectator);
 *   toggleMode — one-shot: Walk ⇄ Fly;
 *   flySpeedStep — a count this frame, −1 or +1 a press (summed): Fly's
 *     speed a wheel notch slower or faster;
 *   spectator — {panX, panY, orbitYaw, orbitPitch, zoom} (summed): a pad
 *     moving Cesium's camera in Spectator (gamepad.js applySpectatorPad).
 */

/** The held intents. */
export const HELD_INTENTS = Object.freeze([
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sneak',
  'sprint',
  'up',
  'down',
]);
/** The one-shot intents. */
export const EVENT_INTENTS = Object.freeze([
  'walkHere',
  'flyHere',
  'release',
  'toggleMode',
]);

/** The spectator block's axes. */
export const SPECTATOR_AXES = Object.freeze([
  'panX',
  'panY',
  'orbitYaw',
  'orbitPitch',
  'zoom',
]);

const clampUnit = (value) => Math.max(-1, Math.min(1, value));

/** Nothing asked: every intent off, no look. */
export function createIntents() {
  const intents = {
    lookDx: 0,
    lookDy: 0,
    analog: { forward: 0, right: 0 },
    flySpeedStep: 0,
    spectator: Object.fromEntries(SPECTATOR_AXES.map((axis) => [axis, 0])),
  };
  for (const name of HELD_INTENTS) intents[name] = false;
  for (const name of EVENT_INTENTS) intents[name] = false;
  return intents;
}

/** Merge a source's partial intents into `into` (held OR, look +, events OR). */
export function mergeIntents(into, partial) {
  if (!partial || typeof partial !== 'object') return into;
  for (const name of HELD_INTENTS) if (partial[name]) into[name] = true;
  for (const name of EVENT_INTENTS) if (partial[name]) into[name] = true;
  const dx = Number(partial.lookDx);
  const dy = Number(partial.lookDy);
  if (Number.isFinite(dx)) into.lookDx += dx;
  if (Number.isFinite(dy)) into.lookDy += dy;
  // A stick per axis: the larger magnitude wins.
  for (const axis of ['forward', 'right']) {
    const value = Number(partial.analog?.[axis]);
    if (Number.isFinite(value) && Math.abs(value) > Math.abs(into.analog[axis]))
      into.analog[axis] = clampUnit(value);
  }
  const steps = Number(partial.flySpeedStep);
  if (Number.isFinite(steps)) into.flySpeedStep += steps;
  for (const axis of SPECTATOR_AXES) {
    const value = Number(partial.spectator?.[axis]);
    if (Number.isFinite(value)) into.spectator[axis] += value;
  }
  return into;
}

/**
 * The movement model's input (movement.js step) for a mode: in Walk,
 * jump jumps, sneak sneaks, sprint sprints; in Fly, jump or up rises,
 * sneak or down descends, sprint doubles the speed. A stick's `analog`
 * passes through (movement.js wishDirection weighs it against the keys).
 */
export function inputFromIntents(intents, mode) {
  const input = {
    forward: Boolean(intents.forward),
    back: Boolean(intents.back),
    left: Boolean(intents.left),
    right: Boolean(intents.right),
    sprint: Boolean(intents.sprint),
  };
  const forward = Number(intents.analog?.forward) || 0;
  const right = Number(intents.analog?.right) || 0;
  if (forward || right)
    input.analog = { forward: clampUnit(forward), right: clampUnit(right) };
  if (mode === 'fly') {
    input.up = Boolean(intents.jump || intents.up);
    input.down = Boolean(intents.sneak || intents.down);
  } else {
    input.jump = Boolean(intents.jump);
    input.sneak = Boolean(intents.sneak);
  }
  return input;
}

/**
 * The input sources a page's binding reads: `addInputSource(source)` adds
 * one ({id?, read(dt) → partial intents | null, reset?()}) and returns its
 * removal. A source that throws is skipped for that frame.
 */
export function createInputRegistry() {
  const sources = new Set();
  const listeners = new Set();
  /** The binding's keys-hint overlay, while a binding listens. */
  let hinter = null;
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* observer only */
      }
    }
  };
  return {
    add(source) {
      if (!source || typeof source.read !== 'function')
        throw new TypeError('an input source needs read(dt)');
      sources.add(source);
      changed();
      return () => {
        if (sources.delete(source)) changed();
      };
    },
    /** Hear sources come and go; returns the undo. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Every source read once and merged. */
    read(dt) {
      const intents = createIntents();
      for (const source of [...sources]) {
        try {
          mergeIntents(intents, source.read(dt));
        } catch (error) {
          console.warn('[Navigation] input source failed:', error);
        }
      }
      return intents;
    },
    /** Every source told to forget what is held (focus lost, mode left). */
    reset() {
      for (const source of [...sources]) {
        try {
          source.reset?.();
        } catch {
          /* its own business */
        }
      }
    },
    get size() {
      return sources.size;
    },
    /**
     * Say a line in the keys-hint overlay over the crosshair for `ms`
     * ("controller connected"); false when no binding shows hints.
     */
    hint(text, ms) {
      if (!hinter) return false;
      try {
        hinter(text, ms);
        return true;
      } catch {
        return false;
      }
    },
    /** The binding's overlay (binding.js); returns the undo. */
    setHinter(fn) {
      hinter = fn;
      return () => {
        if (hinter === fn) hinter = null;
      };
    },
    /** Whether a source other than `except` is registered. */
    hasOther(except) {
      for (const source of sources) if (source !== except) return true;
      return false;
    },
  };
}

let shared = null;
/** The page's registry, read by the page's binding. */
export function inputRegistry() {
  shared ||= createInputRegistry();
  return shared;
}

/** Add an input source to the page's binding (a gamepad); returns its removal. */
export const addInputSource = (source) => inputRegistry().add(source);

/** A line in the page's keys-hint overlay for `ms` (binding.hint). */
export const showInputHint = (text, ms) => inputRegistry().hint(text, ms);

/** Two presses of forward this close together sprint (Minecraft's double-tap). */
export const DOUBLE_TAP_MS = 300;

/**
 * Forward's double-tap: `press(t)` for each fresh press of forward says
 * whether it was the second of a double-tap (and so starts a sprint that
 * lasts while forward is held).
 */
export function createDoubleTap(windowMs = DOUBLE_TAP_MS) {
  let last = -Infinity;
  return {
    press(t) {
      const double = t - last <= windowMs;
      last = double ? -Infinity : t;
      return double;
    },
  };
}

/**
 * The default key map (KeyboardEvent.code → an intent). No Ctrl anywhere:
 * Ctrl+W closes the browser tab, and a page cannot stop it.
 */
export const DEFAULT_KEYS = Object.freeze({
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak',
  ShiftRight: 'sneak',
});

/**
 * The keyboard and mouse as source one. `keys()` gives the live map
 * (code → intent); the binding feeds it `key(event)` and
 * `look(dx, dy)`; forward pressed twice within DOUBLE_TAP_MS holds
 * `sprint` while forward is held.
 */
export function createKeyboardSource({
  keys = () => DEFAULT_KEYS,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const held = new Set();
  const doubleTap = createDoubleTap();
  let lookDx = 0;
  let lookDy = 0;
  let doubleSprint = false;
  return {
    id: 'keyboard',
    /** A keydown or keyup; true when the key is one of the walker's. */
    key(event) {
      const name = keys()[event.code];
      if (!name) return false;
      if (event.type === 'keydown') {
        if (name === 'forward' && !event.repeat && !held.has(event.code))
          if (doubleTap.press(now())) doubleSprint = true;
        held.add(event.code);
      } else {
        held.delete(event.code);
        const map = keys();
        if (name === 'forward' && ![...held].some((c) => map[c] === 'forward'))
          doubleSprint = false;
      }
      return true;
    },
    look(dx, dy) {
      lookDx += Number(dx) || 0;
      lookDy += Number(dy) || 0;
    },
    read() {
      const map = keys();
      const intents = {};
      for (const code of held) {
        const name = map[code];
        if (name) intents[name] = true;
      }
      if (doubleSprint) intents.sprint = true;
      intents.lookDx = lookDx;
      intents.lookDy = lookDy;
      lookDx = 0;
      lookDy = 0;
      return intents;
    },
    reset() {
      held.clear();
      doubleSprint = false;
      lookDx = 0;
      lookDy = 0;
    },
    /** The intent names held now (tests). */
    heldIntents() {
      const map = keys();
      return new Set([...held].map((code) => map[code]).filter(Boolean));
    },
  };
}
