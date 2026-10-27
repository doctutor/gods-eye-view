/**
 * Personal fork: the gamepad for Walk and Fly (docs/BLOCKS-PLAN.md,
 * milestone 2), Minecraft Bedrock's controller layout on the standard
 * mapping, as an input source for the navigation binding (inputs.js:
 * `addInputSource({id, read(dt), reset()})`). Spectator keeps GEV's own
 * controls: nothing is polled there.
 *
 * - Left stick: move (forward, back, left, right).
 * - Right stick: look, at a settable rate with an acceleration curve, in
 *   the pointer-lock pixels the mouse turns by.
 * - A: jump (Walk), up (Fly). B: sneak (Walk), down (Fly).
 * - LT / RT: down / up (Fly).
 * - Right-stick click (and the left's, as Bedrock has it): sprint, until
 *   the left stick comes back to rest.
 * - Start: release. Back / Select: Walk ↔ Fly. D-pad left / right: fly
 *   speed down / up. These are one-shot intents (release, toggleMode,
 *   flySpeedStep), true on the frame of the press only; the binding acts
 *   on them.
 *
 * `gamepadIntents` is the pure part, a snapshot of a pad to the intents
 * for one frame: the held booleans, the stick's `analog` tilt (which
 * scales speed), the look and the one-shot presses. `createGamepadSource`
 * polls navigator.getGamepads() only while a mode is on and a pad is
 * connected, and keeps the settings (dead zone, sensitivity, inversion)
 * in this browser under gev.nav.gamepad.*.
 */
import { msg, t } from '../i18n/index.js';

/** The standard mapping's buttons (https://w3c.github.io/gamepad/#remapping). */
export const BUTTONS = Object.freeze({
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
});

/** The settings a viewer can change, and their defaults. */
export const GAMEPAD_DEFAULTS = Object.freeze({
  deadZone: 0.15,
  sensitivity: 1,
  invertX: false,
  invertY: false,
});
export const DEAD_ZONE_RANGE = Object.freeze([0, 0.5]);
export const SENSITIVITY_RANGE = Object.freeze([0.5, 3]);
/**
 * The right stick fully over turns this many pointer-lock pixels a second
 * at sensitivity 1 (the binding turns 0.0025 rad a pixel: about 86° a
 * second).
 */
export const LOOK_PX_PER_S = 600;
/** The look curve: a stick's tilt (past the dead zone) to this power, so a small tilt aims finely. */
export const LOOK_EXPONENT = 2;
/** A trigger counts as pressed past this. */
export const TRIGGER_THRESHOLD = 0.5;
/** A stick's direction counts as a key (forward, left …) past this share. */
export const KEY_THRESHOLD = 0.3;
/** The localStorage keys' prefix. */
export const STORAGE_PREFIX = 'gev.nav.gamepad.';
/** How long the "controller connected" line stays in the keys hint, ms. */
export const CONNECTED_HINT_MS = 3000;

/** The keys hint's lines for a pad, per mode. */
export const GAMEPAD_HINTS = Object.freeze({
  walk: msg(
    'Left stick move · Right stick look · A jump · B sneak · R3 sprint · Start release',
  ),
  fly: msg(
    'Left stick move · Right stick look · RT/LT or A/B up/down · D-pad speed · Start release',
  ),
});
export const CONNECTED_HINT = msg('🎮 controller connected');

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

/** Settings made whole and in range. */
export function gamepadSettings(given = {}) {
  const number = (value, fallback) =>
    value !== null && value !== '' && Number.isFinite(+value)
      ? +value
      : fallback;
  return {
    deadZone: clamp(
      number(given.deadZone, GAMEPAD_DEFAULTS.deadZone),
      DEAD_ZONE_RANGE,
    ),
    sensitivity: clamp(
      number(given.sensitivity, GAMEPAD_DEFAULTS.sensitivity),
      SENSITIVITY_RANGE,
    ),
    invertX: given.invertX === true || given.invertX === 'true',
    invertY: given.invertY === true || given.invertY === 'true',
  };
}

/**
 * A stick past a radial dead zone, rescaled so its tilt runs 0 … 1 from
 * the dead zone's edge: {x, y, magnitude}.
 */
export function deadZoned(x = 0, y = 0, deadZone = GAMEPAD_DEFAULTS.deadZone) {
  const raw = Math.hypot(x, y);
  if (!(raw > deadZone)) return { x: 0, y: 0, magnitude: 0 };
  const magnitude = Math.min(1, (raw - deadZone) / (1 - deadZone));
  return { x: (x / raw) * magnitude, y: (y / raw) * magnitude, magnitude };
}

/** A pad as plain data: its axes, and each button's pressed and value. */
export function snapshotOf(gamepad) {
  return {
    id: gamepad?.id ?? '',
    mapping: gamepad?.mapping ?? '',
    axes: Array.from(gamepad?.axes ?? [], Number),
    buttons: Array.from(gamepad?.buttons ?? [], (button) =>
      typeof button === 'object'
        ? { pressed: Boolean(button.pressed), value: Number(button.value) || 0 }
        : { pressed: button > 0.5, value: Number(button) || 0 },
    ),
  };
}

/** A fresh mapper state: nothing held, no sprint. */
export const idleState = () => ({ pressed: [], sprinting: false });

/**
 * A pad's snapshot to one frame of `dt` seconds in a mode ('walk' or
 * 'fly'). `state` is what the last call handed back (the buttons held
 * then, for presses that act once, and the sprint latch).
 * @returns {{intents: object, state: object}} intents: the binding's
 *   partial intents (inputs.js) — held booleans forward, back, left,
 *   right, sprint, jump/sneak (Walk) or up/down (Fly); `analog` {forward,
 *   right}, −1 … 1, the left stick past its dead zone; lookDx, lookDy in
 *   pointer-lock pixels for this frame (+x right, +y down), the gamepad's
 *   own sensitivity in them (the binding adds the mouse's); and the
 *   one-shot presses release, toggleMode (booleans) and flySpeedStep
 *   (−1, 0, +1).
 */
export function gamepadIntents(
  snapshot,
  {
    state = idleState(),
    settings = GAMEPAD_DEFAULTS,
    mode = 'walk',
    dt = 0,
  } = {},
) {
  const { deadZone, sensitivity, invertX, invertY } = gamepadSettings(settings);
  const axes = snapshot?.axes ?? [];
  const buttons = snapshot?.buttons ?? [];
  const held = (index) => Boolean(buttons[index]?.pressed);
  const value = (index) => Number(buttons[index]?.value) || 0;
  const fresh = (index) => held(index) && !state.pressed[index];

  // Move: the left stick (up is −y on the standard mapping).
  const stick = deadZoned(axes[0], axes[1], deadZone);
  const forward = stick.y ? -stick.y : 0; // no −0 at rest
  const right = stick.x;
  // Look: the right stick, curved, at the settable rate, in pixels.
  const aim = deadZoned(axes[2], axes[3], deadZone);
  const curve = (component) =>
    aim.magnitude
      ? (component / aim.magnitude) * aim.magnitude ** LOOK_EXPONENT
      : 0;
  const pixels = LOOK_PX_PER_S * sensitivity * dt;

  // Sprint: a stick click starts it; it lasts until the left stick rests.
  let sprinting = state.sprinting;
  if (fresh(BUTTONS.RS) || fresh(BUTTONS.LS)) sprinting = true;
  if (!stick.magnitude) sprinting = false;

  const intents = {
    forward: forward > KEY_THRESHOLD,
    back: forward < -KEY_THRESHOLD,
    right: right > KEY_THRESHOLD,
    left: right < -KEY_THRESHOLD,
    sprint: sprinting,
    analog: { forward, right },
    lookDx: curve(aim.x) * pixels * (invertX ? -1 : 1),
    lookDy: curve(aim.y) * pixels * (invertY ? -1 : 1),
    release: fresh(BUTTONS.START),
    toggleMode: fresh(BUTTONS.BACK),
    flySpeedStep:
      (fresh(BUTTONS.RIGHT) ? 1 : 0) - (fresh(BUTTONS.LEFT) ? 1 : 0),
  };
  if (mode === 'fly') {
    intents.up = held(BUTTONS.A) || value(BUTTONS.RT) > TRIGGER_THRESHOLD;
    intents.down = held(BUTTONS.B) || value(BUTTONS.LT) > TRIGGER_THRESHOLD;
  } else {
    intents.jump = held(BUTTONS.A);
    intents.sneak = held(BUTTONS.B);
  }
  return {
    intents,
    state: {
      pressed: buttons.map((button) => Boolean(button?.pressed)),
      sprinting,
    },
  };
}

/** The settings kept in a Storage (gev.nav.gamepad.*), whole and in range. */
export function readGamepadSettings(storage) {
  const given = {};
  for (const key of Object.keys(GAMEPAD_DEFAULTS)) {
    try {
      const raw = storage?.getItem?.(STORAGE_PREFIX + key);
      if (raw !== null && raw !== undefined) given[key] = raw;
    } catch {
      /* no storage: the defaults */
    }
  }
  return gamepadSettings(given);
}

/**
 * The gamepad as an input source: `read(dt)` polls the first connected pad
 * and gives its intents (inputs.js's partial intents), or null while no
 * mode is on (Spectator) or no pad is connected (nothing is polled then).
 * Connecting a pad shows CONNECTED_HINT for 3 s (`onHint`, the binding's
 * hint).
 * @param {{getMode: () => string, onHint?: Function, windowRef?: object,
 *   navigatorRef?: object, storage?: Storage}} options
 */
export function createGamepadSource({
  getMode,
  onHint = () => {},
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  storage = globalThis.localStorage,
} = {}) {
  let settings = readGamepadSettings(storage);
  let state = idleState();
  let connected = 0;
  const padsNow = () => {
    try {
      return Array.from(navigatorRef?.getGamepads?.() ?? []).filter(
        (pad) => pad && pad.connected !== false,
      );
    } catch {
      return [];
    }
  };
  // A pad already connected when the page loaded.
  connected = padsNow().length;

  const onConnected = () => {
    connected++;
    state = idleState();
    onHint(t(CONNECTED_HINT), CONNECTED_HINT_MS);
  };
  const onDisconnected = () => {
    connected = Math.max(0, connected - 1);
    state = idleState();
  };
  windowRef?.addEventListener?.('gamepadconnected', onConnected);
  windowRef?.addEventListener?.('gamepaddisconnected', onDisconnected);

  const activeMode = () => {
    const mode = getMode?.();
    return mode === 'walk' || mode === 'fly' ? mode : null;
  };

  return {
    id: 'gamepad',
    /** This frame's intents from the pad, or null (no mode on, no pad). */
    read(dt) {
      const mode = activeMode();
      if (!mode || !connected) {
        state = idleState();
        return null;
      }
      const pad = padsNow()[0];
      if (!pad) return null;
      const result = gamepadIntents(snapshotOf(pad), {
        state,
        settings,
        mode,
        dt,
      });
      state = result.state;
      return result.intents;
    },
    /** Forget what was held (the binding calls it when a mode starts or ends). */
    reset() {
      state = idleState();
    },
    /** Whether a pad is connected. */
    connected: () => connected > 0,
    getSettings: () => ({ ...settings }),
    /** Change settings (kept in this browser); the whole settings back. */
    setSettings(next = {}) {
      settings = gamepadSettings({ ...settings, ...next });
      for (const [key, value] of Object.entries(settings))
        try {
          storage?.setItem?.(STORAGE_PREFIX + key, String(value));
        } catch {
          /* not kept: this page only */
        }
      return { ...settings };
    },
    destroy() {
      windowRef?.removeEventListener?.('gamepadconnected', onConnected);
      windowRef?.removeEventListener?.('gamepaddisconnected', onDisconnected);
    },
  };
}

/**
 * The gamepad on the navigation: a source registered with
 * `addInputSource` (inputs.js), reading the mode from the store, its
 * "controller connected" line through `onHint` (the binding's hint).
 * @returns {{source: object, detach: () => void}}
 */
export function attachGamepad({ addInputSource, store, onHint, ...options }) {
  const source = createGamepadSource({
    ...options,
    getMode: () => store.get(),
    onHint,
  });
  const remove = addInputSource({
    id: source.id,
    read: (dt) => source.read(dt),
    reset: () => source.reset(),
  });
  return {
    source,
    detach() {
      remove?.();
      source.destroy();
    },
  };
}
