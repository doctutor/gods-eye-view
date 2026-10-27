/**
 * Personal fork: the gamepad for Walk and Fly (docs/BLOCKS-PLAN.md,
 * milestone 2), Minecraft Bedrock's controller layout on the standard
 * mapping. Spectator keeps GEV's own controls: nothing is polled there.
 *
 * - Left stick: move, its tilt the share of the mode's top speed.
 * - Right stick: look, at a settable rate with an acceleration curve.
 * - A: jump (Walk), up (Fly). B: sneak (Walk), down (Fly).
 * - LT / RT: down / up (Fly).
 * - Right-stick click (and the left's, as Bedrock has it): sprint, until
 *   the left stick comes back to rest.
 * - Start: release (as Esc). Back / Select: Walk ↔ Fly.
 * - D-pad left / right: fly speed down / up.
 *
 * `gamepadIntents` is the pure part, a snapshot of a pad to the movement's
 * intents (with the edge-triggered presses in the state it hands back);
 * `createGamepadSource` polls navigator.getGamepads() when asked, only
 * while a mode is on and a pad is connected, and keeps the settings (dead
 * zone, sensitivity, inversion) in this browser.
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
/** The right stick fully over turns this fast at sensitivity 1, degrees a second. */
export const LOOK_DEG_PER_S = 180;
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
    Number.isFinite(+value) ? +value : fallback;
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
 * A pad's snapshot to the movement's intents for one frame of `dt`
 * seconds in a mode ('walk' or 'fly'). `state` is what the last call
 * handed back (the buttons held then, for presses that act once, and the
 * sprint latch).
 * @returns {{intents: object, state: object}} intents: move (analog,
 *   −1 … 1 forward and right, and its magnitude), forward/back/left/right
 *   (past KEY_THRESHOLD), look in degrees this frame (yaw right, pitch
 *   up), jump/sneak (Walk) or up/down (Fly), sprint, and the presses:
 *   release, toggleMode, flySpeedStep (−1, 0, +1).
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
  const pressedNow = buttons.map((button) => Boolean(button?.pressed));
  const fresh = (index) => held(index) && !state.pressed[index];

  // Move: the left stick (up is −y on the standard mapping).
  const move = deadZoned(axes[0], axes[1], deadZone);
  const forward = -move.y;
  const right = move.x;
  // Look: the right stick, curved, at the settable rate.
  const stick = deadZoned(axes[2], axes[3], deadZone);
  const curve = (component) =>
    stick.magnitude
      ? Math.sign(component) *
        Math.abs(component / stick.magnitude) *
        stick.magnitude ** LOOK_EXPONENT
      : 0;
  const rate = LOOK_DEG_PER_S * sensitivity * dt;
  const yawDeg = curve(stick.x) * rate * (invertX ? -1 : 1);
  const pitchDeg = -curve(stick.y) * rate * (invertY ? -1 : 1);

  // Sprint: a stick click starts it; it lasts until the left stick rests.
  let sprinting = state.sprinting;
  if (fresh(BUTTONS.RS) || fresh(BUTTONS.LS)) sprinting = true;
  if (!move.magnitude) sprinting = false;

  const intents = {
    move: { forward, right, magnitude: move.magnitude },
    forward: forward > KEY_THRESHOLD,
    back: forward < -KEY_THRESHOLD,
    right: right > KEY_THRESHOLD,
    left: right < -KEY_THRESHOLD,
    look: { yawDeg, pitchDeg },
    sprint: sprinting,
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
  return { intents, state: { pressed: pressedNow, sprinting } };
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
 * The gamepad as an input source for the navigation binding: `read(dt)`
 * polls the first connected pad and gives its intents, or null while no
 * mode is on (Spectator) or no pad is connected (nothing is polled then).
 * Connecting a pad shows CONNECTED_HINT in the keys hint for 3 s
 * (`onHint`).
 * @param {{windowRef?: object, navigatorRef?: object, storage?: Storage,
 *   getMode: () => string, onHint?: (text: string, ms: number) => void}} options
 */
export function createGamepadSource({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  storage = globalThis.localStorage,
  getMode,
  onHint = () => {},
} = {}) {
  let settings = readGamepadSettings(storage);
  let state = idleState();
  let connected = 0;
  // A page loaded with a pad already in hand: it shows once it is used.
  const padsNow = () => {
    try {
      return Array.from(navigatorRef?.getGamepads?.() ?? []).filter(
        (pad) => pad && pad.connected !== false,
      );
    } catch {
      return [];
    }
  };
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

  const active = () => {
    const mode = getMode?.();
    return mode === 'walk' || mode === 'fly' ? mode : null;
  };

  return {
    /** This frame's intents from the pad, or null (no mode on, no pad). */
    read(dt) {
      const mode = active();
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
