/**
 * Personal fork: the gamepad for Walk and Fly (docs/BLOCKS-PLAN.md,
 * milestone 2), Minecraft Bedrock's controller layout on the standard
 * mapping, as an input source for the navigation binding (inputs.js:
 * `addInputSource({id, read(dt), reset()})`).
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
 * In Spectator the pad moves Cesium's camera itself, beside GEV's mouse
 * and keys (untouched, and nothing happens while the pad rests): the left
 * stick pans the view over the ground, about a screen a second; the right
 * stick orbits the ground point under the crosshair (pitch kept above the
 * surface); RT / LT zoom in / out; A walks here. Its `spectator` block
 * {panX, panY, orbitYaw, orbitPitch, zoom} is what the binding's
 * Spectator poll hands to `applySpectatorPad`.
 *
 * `gamepadIntents` is the pure part, a snapshot of a pad to the intents
 * for one frame: the held booleans, the stick's `analog` tilt (which
 * scales speed), the look and the one-shot presses. `createGamepadSource`
 * polls navigator.getGamepads() only while a pad is connected; its settings (dead zone, sensitivity, inversion) are the
 * navigation card's Gamepad section (settings.js, kept under
 * gev.nav.gamepad).
 */
import * as Cesium from 'cesium';
import { msg, t } from '../i18n/index.js';
import { surfaceAt } from '../surfaceTrust.js';
import { addInputSource, showInputHint } from './inputs.js';
import { navSettings } from './settings.js';

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
/** Spectator: a full left stick pans this many screen widths a second. */
export const PAN_SCREENS_PER_S = 1;
/** Spectator: a full right stick orbits this fast, rad/s, at sensitivity 1. */
export const ORBIT_RAD_PER_S = Math.PI / 2;
/** Spectator: a full trigger zooms this share of the height a second. */
export const ZOOM_HEIGHTS_PER_S = 1;
/** Spectator: the camera stays this far above the surface, m. */
export const MIN_CLEARANCE_M = 2;
/** Spectator: an orbit keeps the camera's pitch in this range, degrees. */
export const ORBIT_PITCH_RANGE_DEG = Object.freeze([-89.5, -1]);

/** The navigation card's section for the settings (settings.js registerSection). */
export const GAMEPAD_SECTION = Object.freeze({
  id: 'gamepad',
  title: msg('Gamepad'),
  rows: Object.freeze([
    {
      key: 'deadZone',
      label: msg('Dead zone'),
      type: 'range',
      min: DEAD_ZONE_RANGE[0],
      max: DEAD_ZONE_RANGE[1],
      step: 0.01,
      default: GAMEPAD_DEFAULTS.deadZone,
    },
    {
      key: 'sensitivity',
      label: msg('Sensitivity'),
      type: 'range',
      min: SENSITIVITY_RANGE[0],
      max: SENSITIVITY_RANGE[1],
      step: 0.1,
      default: GAMEPAD_DEFAULTS.sensitivity,
    },
    { key: 'invertX', label: msg('Invert X'), type: 'toggle' },
    { key: 'invertY', label: msg('Invert Y'), type: 'toggle' },
  ]),
});
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

/** A fresh mapper state: nothing held, no sprint, nothing latched. */
export const idleState = () => ({ pressed: [], sprinting: false, latched: [] });
/**
 * The buttons a mode's entry latches (A, and RT for Fly's up): held as
 * Walk or Fly begins (A walked here), they do nothing until let go once.
 */
export const ENTRY_LATCHED = Object.freeze([BUTTONS.A, BUTTONS.RT]);

/**
 * A pad's snapshot to one frame of `dt` seconds in a mode ('walk' or
 * 'fly'; in 'spectator', the `spectator` block and walkHere). `state` is
 * what the last call handed back (the buttons held then, for presses that
 * act once; the sprint latch; and `latched`, buttons ignored until let go,
 * which the source sets to ENTRY_LATCHED as a mode begins).
 * @returns {{intents: object, state: object}} intents: the binding's
 *   partial intents (inputs.js) — held booleans forward, back, left,
 *   right, sprint, jump/sneak (Walk) or up/down (Fly); `analog` {forward,
 *   right}, −1 … 1, the left stick past its dead zone; lookDx, lookDy in
 *   pointer-lock pixels for this frame (+x right, +y down), the gamepad's
 *   own sensitivity and inversion in them (the mouse's don't apply); and the
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
  // Latched buttons stay ignored while held; let go, they act again.
  const down = (index) =>
    index === BUTTONS.RT ? value(index) > TRIGGER_THRESHOLD : held(index);
  const latched = (state.latched ?? []).filter(down);
  const live = (index) => down(index) && !latched.includes(index);

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
  const pressed = buttons.map((button) => Boolean(button?.pressed));

  // Spectator: the camera's own pan, orbit and zoom, and A walks here.
  if (mode === 'spectator') {
    const pull = (index) =>
      value(index) > deadZone ? (value(index) - deadZone) / (1 - deadZone) : 0;
    return {
      intents: {
        walkHere: fresh(BUTTONS.A),
        spectator: {
          panX: right,
          panY: forward,
          orbitYaw: curve(aim.x) * sensitivity * (invertX ? -1 : 1),
          orbitPitch: curve(aim.y) * sensitivity * (invertY ? -1 : 1),
          zoom: pull(BUTTONS.RT) - pull(BUTTONS.LT),
        },
      },
      state: { pressed, sprinting: false, latched },
    };
  }

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
    intents.up = live(BUTTONS.A) || live(BUTTONS.RT);
    intents.down = held(BUTTONS.B) || value(BUTTONS.LT) > TRIGGER_THRESHOLD;
  } else {
    intents.jump = live(BUTTONS.A);
    intents.sneak = held(BUTTONS.B);
  }
  return {
    intents,
    state: { pressed, sprinting, latched },
  };
}

/**
 * The gamepad as an input source: `read(dt)` polls the first connected pad
 * and gives its intents (inputs.js's partial intents) in Walk, Fly or
 * Spectator, or null while no pad is connected (nothing is polled then).
 * Its settings follow `section` (the navigation card's Gamepad section:
 * get(), set(patch), subscribe(fn)); connecting a pad shows
 * CONNECTED_HINT for 3 s through `hint` (the binding's keys hint), and
 * `onConnection(true)` / `(false)` hears the first pad come and the last go.
 * @param {{getMode: () => string, section?: object, hint?: Function,
 *   onConnection?: (connected: boolean) => void,
 *   windowRef?: object, navigatorRef?: object}} options
 */
export function createGamepadSource({
  getMode,
  section = null,
  hint = showInputHint,
  onConnection = () => {},
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
} = {}) {
  let settings = gamepadSettings(section?.get?.() ?? {});
  const unsubscribe = section?.subscribe?.((values) => {
    settings = gamepadSettings(values);
  });
  let state = idleState();
  let lastMode = null;
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
    hint(t(CONNECTED_HINT), CONNECTED_HINT_MS);
    if (connected === 1) onConnection(true);
  };
  const onDisconnected = () => {
    const was = connected;
    connected = Math.max(0, connected - 1);
    state = idleState();
    if (was && !connected) onConnection(false);
  };
  windowRef?.addEventListener?.('gamepadconnected', onConnected);
  windowRef?.addEventListener?.('gamepaddisconnected', onDisconnected);

  const activeMode = () => {
    const mode = getMode?.();
    return mode === 'walk' || mode === 'fly' || mode === 'spectator'
      ? mode
      : null;
  };

  return {
    id: 'gamepad',
    /** This frame's intents from the pad, or null (no pad). */
    read(dt) {
      const mode = activeMode();
      // Walk or Fly begun: A or RT still held (A walked here) waits to be
      // let go before it jumps or rises.
      if (mode !== lastMode && (mode === 'walk' || mode === 'fly'))
        state = { ...state, latched: [...ENTRY_LATCHED] };
      lastMode = mode;
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
    /**
     * Forget what was held (the binding calls it when a mode starts or
     * ends); the entry latch stays until its buttons are let go.
     */
    reset() {
      state = { ...idleState(), latched: state.latched ?? [] };
    },
    /** Whether a pad is connected. */
    connected: () => connected > 0,
    getSettings: () => ({ ...settings }),
    destroy() {
      unsubscribe?.();
      windowRef?.removeEventListener?.('gamepadconnected', onConnected);
      windowRef?.removeEventListener?.('gamepaddisconnected', onDisconnected);
    },
  };
}

/**
 * The gamepad on the navigation: its settings registered as the card's
 * Gamepad section, and, while a pad is connected, a source registered
 * with `addInputSource` (inputs.js) reading the mode from the store (the
 * binding polls Spectator only while such a source is in); its
 * "controller connected" line through `hint` (inputs.js's showInputHint).
 * @returns {{source: object, section: object, detach: () => void}}
 */
export function attachGamepad({
  store,
  addSource = addInputSource,
  settings = navSettings(),
  ...options
}) {
  const section = settings.registerSection(GAMEPAD_SECTION);
  let remove = null;
  const entry = {
    id: 'gamepad',
    read: (dt) => source.read(dt),
    reset: () => source.reset(),
  };
  const onConnection = (connected) => {
    if (connected && !remove) {
      const off = addSource(entry);
      remove = typeof off === 'function' ? off : () => {};
    } else if (!connected && remove) {
      remove();
      remove = null;
    }
  };
  const source = createGamepadSource({
    ...options,
    section,
    onConnection,
    getMode: () => store.get(),
  });
  onConnection(source.connected());
  return {
    source,
    section,
    detach() {
      onConnection(false);
      source.destroy();
      section.unregister();
    },
  };
}

/**
 * The surface's height under a place, m: a trusted hit from above (as the
 * HUD's AGL finds it), else the shown globe's terrain, else NaN.
 */
function surfaceHeightM(viewer, lat, lon) {
  const reading = surfaceAt(viewer, lat, lon);
  if (Number.isFinite(reading.heightM)) return reading.heightM;
  try {
    const globe = viewer.scene?.globe?.getHeight?.(
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    return Number.isFinite(globe) ? globe : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** The ground point under the screen's centre, or null (the sky). */
function groundUnderCrosshair(viewer) {
  const { scene, camera } = viewer;
  const canvas = scene.canvas;
  const centre = new Cesium.Cartesian2(
    (canvas?.clientWidth || canvas?.width || 0) / 2,
    (canvas?.clientHeight || canvas?.height || 0) / 2,
  );
  try {
    if (scene.pickPositionSupported) {
      const picked = scene.pickPosition(centre);
      if (picked) return picked;
    }
    const ray = camera.getPickRay(centre);
    const globe = ray && scene.globe?.pick?.(ray, scene);
    return globe || camera.pickEllipsoid(centre) || null;
  } catch {
    return null;
  }
}

const cameraPose = (camera) => ({
  position: Cesium.Cartesian3.clone(camera.position),
  direction: Cesium.Cartesian3.clone(camera.direction),
  up: Cesium.Cartesian3.clone(camera.up),
  right: Cesium.Cartesian3.clone(camera.right),
});
const restorePose = (camera, pose) => {
  for (const key of ['position', 'direction', 'up', 'right'])
    Cesium.Cartesian3.clone(pose[key], camera[key]);
};

/**
 * One frame of a pad in Spectator: Cesium's camera panned, orbited and
 * zoomed by a `spectator` block (gamepadIntents) over `dt` seconds. The
 * pan runs over the ground (the view's heading, level) at
 * PAN_SCREENS_PER_S screens a second, a screen being the ground the
 * view's width spans at the camera's height above the surface; the orbit
 * turns about the ground point under the crosshair (yaw about its up, the
 * pitch kept within ORBIT_PITCH_RANGE_DEG); the zoom moves a share of the
 * height a second. A step that would take the camera under the surface
 * (MIN_CLEARANCE_M) is undone. Nothing is done for a block at rest.
 * @param {{surfaceHeightM?: (lat: number, lon: number) => number}} [options]
 *   the surface under a place (default: the trusted surface, else the
 *   globe's terrain).
 * @returns {boolean} whether the camera moved.
 */
export function applySpectatorPad(viewer, block, dt, options = {}) {
  const camera = viewer?.camera;
  if (!camera || !block || !(dt > 0)) return false;
  const axis = (name) => {
    const value = Number(block[name]);
    return Number.isFinite(value) ? value : 0;
  };
  const panX = axis('panX');
  const panY = axis('panY');
  const yaw = axis('orbitYaw');
  const pitch = axis('orbitPitch');
  const zoom = axis('zoom');
  if (!panX && !panY && !yaw && !pitch && !zoom) return false;

  const surfaceOf =
    options.surfaceHeightM ?? ((lat, lon) => surfaceHeightM(viewer, lat, lon));
  /** The camera's height above the surface under it (or the ellipsoid). */
  const clearance = () => {
    const carto = Cesium.Cartographic.fromCartesian(camera.position);
    if (!carto) return Number.NaN;
    const ground = surfaceOf(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
    );
    return carto.height - (Number.isFinite(ground) ? ground : 0);
  };
  const heightM = Math.max(MIN_CLEARANCE_M, clearance());
  if (!Number.isFinite(heightM)) return false;
  /** Back to `pose` when a step left the camera under the clearance. */
  const guarded = (pose) => {
    const after = clearance();
    if (Number.isFinite(after) && after < MIN_CLEARANCE_M)
      restorePose(camera, pose);
  };

  // Pan: level, along the heading and across it.
  if (panX || panY) {
    const pose = cameraPose(camera);
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      camera.position,
      new Cesium.Cartesian3(),
    );
    const level = (vector) => {
      const along = Cesium.Cartesian3.multiplyByScalar(
        up,
        Cesium.Cartesian3.dot(vector, up),
        new Cesium.Cartesian3(),
      );
      const flat = Cesium.Cartesian3.subtract(
        vector,
        along,
        new Cesium.Cartesian3(),
      );
      return Cesium.Cartesian3.magnitude(flat) > 1e-6
        ? Cesium.Cartesian3.normalize(flat, flat)
        : null;
    };
    // Looking straight down, the view's up is the heading.
    const forward = level(camera.direction) ?? level(camera.up);
    if (forward) {
      const right = Cesium.Cartesian3.cross(
        forward,
        up,
        new Cesium.Cartesian3(),
      );
      const fov = Number(camera.frustum?.fov) || Math.PI / 3;
      const screenM = 2 * heightM * Math.tan(fov / 2);
      const metres = screenM * PAN_SCREENS_PER_S * dt;
      camera.move(forward, panY * metres);
      camera.move(right, panX * metres);
      guarded(pose);
    }
  }

  // Orbit: about the ground point under the crosshair.
  if (yaw || pitch) {
    const pivot = groundUnderCrosshair(viewer);
    if (pivot) {
      const orbitPose = cameraPose(camera);
      const [lowest, highest] = ORBIT_PITCH_RANGE_DEG.map(
        Cesium.Math.toRadians,
      );
      const step = ORBIT_RAD_PER_S * dt;
      camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(pivot));
      try {
        // A right push turns the view right: the camera goes left round.
        if (yaw) camera.rotateLeft(yaw * step);
        if (pitch) {
          const pose = cameraPose(camera);
          // A push down looks down: the camera rises over the point.
          camera.rotateDown(pitch * step);
          const steep = camera.pitch;
          if (!(steep >= lowest && steep <= highest)) restorePose(camera, pose);
        }
      } finally {
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
      guarded(orbitPose);
    }
  }

  // Zoom: in (RT) or out (LT), a share of the height a second.
  if (zoom) {
    const pose = cameraPose(camera);
    const metres = Math.abs(zoom) * ZOOM_HEIGHTS_PER_S * heightM * dt;
    if (zoom > 0)
      camera.zoomIn(Math.min(metres, Math.max(0, heightM - MIN_CLEARANCE_M)));
    else camera.zoomOut(metres);
    guarded(pose);
  }

  viewer.scene?.requestRender?.();
  return true;
}
