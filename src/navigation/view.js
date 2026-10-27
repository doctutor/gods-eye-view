/**
 * Personal fork: how Walk and Fly are seen (Minecraft's F5), and the
 * compass's angles. Pure: the binding (binding.js) asks thirdPersonPose
 * where to put the camera each frame, and the HUD asks compassAngles how
 * to turn its rose. The walker (movement.js's state) is what moves and
 * looks; in third person the camera only watches it.
 *
 * - first: the camera is the eye (the default);
 * - back: 4 m behind the eye along the look direction, looking where the
 *   walker looks;
 * - front: 4 m in front, looking back at the walker's face.
 *
 * A block or the surface between the eye and the camera pulls the camera
 * in to just short of it, as Minecraft's does. The choice is kept in this
 * browser (gev.nav.view), not in links.
 */
import { BODY_HEIGHT_M, EYE_HEIGHT_M } from './movement.js';

export const VIEW_MODES = Object.freeze(['first', 'back', 'front']);
export const VIEW_STORAGE_KEY = 'gev.nav.view';
/** How far the third-person camera stands from the eye. */
export const THIRD_PERSON_M = 4;
/** How far short of a block or the surface it stops. */
export const CAMERA_MARGIN_M = 0.2;
/** The nearest it comes (inside a wall: just behind the head). */
export const MIN_CAMERA_M = 0.3;
/** The surface walked in steps of this when the world has no raycast. */
const MARCH_STEP_M = 0.25;
/** The player marker: Minecraft's 0.6 × 1.8 m body. */
export const MARKER_WIDTH_M = 0.6;
export const MARKER_HEIGHT_M = BODY_HEIGHT_M;

/** The mode after `mode`: first → back → front → first. */
export function nextView(mode) {
  const at = VIEW_MODES.indexOf(mode);
  return VIEW_MODES[(at + 1) % VIEW_MODES.length];
}

/** The unit vector the walker looks along (x east, y north, z up). */
export function lookDirection(yaw, pitch) {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.cos(yaw) * Math.cos(pitch),
    z: Math.sin(pitch),
  };
}

/**
 * How far along `direction` from `origin` is clear, up to `maxM`: the
 * world's raycast where it has one (the Blocks occupancy), else the
 * surface walked in steps (a heightfield world).
 */
export function clearanceM(world, origin, direction, maxM) {
  if (typeof world?.raycast === 'function') {
    const hit = world.raycast(origin, direction, maxM);
    return hit ? Math.min(maxM, hit.distanceM) : maxM;
  }
  if (typeof world?.surfaceBelow !== 'function') return maxM;
  for (let d = MARCH_STEP_M; d <= maxM + 1e-9; d += MARCH_STEP_M) {
    const x = origin.x + direction.x * d;
    const y = origin.y + direction.y * d;
    const z = origin.z + direction.z * d;
    const ground = world.surfaceBelow(x, y, z);
    if (Number.isFinite(ground) && ground > z) return d - MARCH_STEP_M;
  }
  return maxM;
}

/**
 * Where the camera goes for a view: {x, y, z, yaw, pitch, distanceM}.
 * First person: the eye. Back: `distanceM` behind it along the look,
 * looking the same way. Front: `distanceM` ahead, turned round to face the
 * walker (yaw + π, pitch negated). Pulled in to just short of whatever
 * stands between, never nearer than MIN_CAMERA_M.
 */
export function thirdPersonPose(
  state,
  view,
  { world = null, distanceM = THIRD_PERSON_M } = {},
) {
  const eye = { x: state.x, y: state.y, z: state.z };
  if (view !== 'back' && view !== 'front')
    return { ...eye, yaw: state.yaw, pitch: state.pitch, distanceM: 0 };
  const look = lookDirection(state.yaw, state.pitch);
  const sign = view === 'back' ? -1 : 1;
  const out = { x: look.x * sign, y: look.y * sign, z: look.z * sign };
  const clear = world ? clearanceM(world, eye, out, distanceM) : distanceM;
  // Short of whatever stands between; the full distance when nothing does.
  const d =
    clear >= distanceM
      ? distanceM
      : Math.max(MIN_CAMERA_M, clear - CAMERA_MARGIN_M);
  return {
    x: eye.x + out.x * d,
    y: eye.y + out.y * d,
    z: eye.z + out.z * d,
    yaw: view === 'back' ? state.yaw : wrapAngle(state.yaw + Math.PI),
    pitch: view === 'back' ? state.pitch : -state.pitch,
    distanceM: d,
  };
}

/**
 * The player marker's pose: the box's centre half its height above the
 * feet (the eye EYE_HEIGHT_M above them), turned to the walker's heading.
 */
export function markerPose(state) {
  return {
    x: state.x,
    y: state.y,
    z: state.z - EYE_HEIGHT_M + MARKER_HEIGHT_M / 2,
    yaw: state.yaw,
  };
}

/** An angle in −π … π. */
export function wrapAngle(rad) {
  return (
    ((((rad + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
    Math.PI
  );
}

/** Degrees in 0 … 360. */
export const wrapDegrees = (deg) => ((deg % 360) + 360) % 360;

/** The initial great-circle bearing from one place to another, degrees from north. */
export function bearingDeg(from, to) {
  const rad = Math.PI / 180;
  const φ1 = from.lat * rad;
  const φ2 = to.lat * rad;
  const Δλ = (to.lon - from.lon) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return wrapDegrees(Math.atan2(y, x) / rad);
}

/**
 * The compass's turns, degrees clockwise on screen: the rose turned by
 * −heading so its N points north; the home tick at the home's bearing less
 * the heading (0: straight ahead), null without a home.
 */
export function compassAngles({ headingDeg, here = null, home = null }) {
  const rose = wrapDegrees(-headingDeg);
  if (!home || !here) return { roseDeg: rose, homeDeg: null };
  return {
    roseDeg: rose,
    homeDeg: wrapDegrees(bearingDeg(here, home) - headingDeg),
  };
}

/** A view store kept in this browser; unknown values read as first person. */
export function createViewStore({ storage } = {}) {
  let store = storage;
  if (store === undefined) {
    try {
      store = globalThis.localStorage ?? null;
    } catch {
      store = null;
    }
  }
  let view = 'first';
  try {
    const saved = store?.getItem(VIEW_STORAGE_KEY);
    if (VIEW_MODES.includes(saved)) view = saved;
  } catch {
    /* no storage */
  }
  const listeners = new Set();
  const set = (next) => {
    if (!VIEW_MODES.includes(next) || next === view) return false;
    view = next;
    try {
      store?.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      /* kept for this page */
    }
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch (error) {
        console.warn('[Navigation] view listener failed:', error);
      }
    }
    return true;
  };
  return {
    get: () => view,
    set,
    cycle: () => set(nextView(view)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;
/** The page's view store. */
export function viewStore() {
  shared ||= createViewStore();
  return shared;
}
