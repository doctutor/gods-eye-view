/**
 * Personal fork: embodied navigation's movement model (docs/BLOCKS-PLAN.md,
 * milestone 2, lessons 8–10): Walk (an eye 1.62 m above the surface,
 * gravity, collision, a step up, jump, swim) and Fly (creative flight that
 * still collides). Pure: a state, the keys held, a time step and a world
 * give the next state. Spectator is GEV's own camera and has no model.
 *
 * Positions are metres in a local frame: x east, y north, z up, in the
 * world's vertical datum (the binding converts to and from the camera).
 * The body is a column at (x, y) from the feet to BODY_HEIGHT_M; the eye
 * is EYE_HEIGHT_M above the feet. `yaw` is a heading (radians clockwise
 * from north) and `pitch` radians above the horizon; there is no roll.
 *
 * A world answers three questions (src/navigation/worlds.js):
 *   surfaceBelow(x, y, z) → the top of the solid at or below z in that
 *     column (the top of the block holding z when z is inside one), NaN
 *     when nothing is known there;
 *   blocked(x, y, z0, z1) → whether anything solid lies in [z0, z1);
 *   waterAt(x, y, z) → whether z is in water;
 * and gives `stepUpM`, the rise a walker climbs without jumping.
 */

export const NAV_MODES = Object.freeze(['spectator', 'walk', 'fly']);

/** Minecraft's player, in metres and seconds. */
export const EYE_HEIGHT_M = 1.62;
export const BODY_HEIGHT_M = 1.8;
export const WALK_SPEED_M_S = 4.3;
export const SPRINT_SPEED_M_S = 5.6;
export const FLY_SPEED_M_S = 10.8;
/** Fly's sprint (a double-tap of forward) doubles the speed. */
export const FLY_SPRINT_FACTOR = 2;
export const FLY_VERTICAL_M_S = 7.5;
export const SWIM_SPEED_M_S = 2.2;
export const SWIM_UP_M_S = 2.0;
export const SINK_M_S = 1.0;
/** Gravity that makes a 1.25 m jump take Minecraft's ~0.6 s. */
export const GRAVITY_M_S2 = 32;
export const JUMP_HEIGHT_M = 1.25;
export const JUMP_SPEED_M_S = Math.sqrt(2 * GRAVITY_M_S2 * JUMP_HEIGHT_M);
export const TERMINAL_SPEED_M_S = 78.4;
/** A step up off the blocks (a kerb); under Blocks it is one block. */
export const DEFAULT_STEP_UP_M = 0.6;
/** Drops this small are followed, not fallen (a slope walked down). */
export const SNAP_DOWN_M = 0.3;
/** The longest time step taken: a stalled frame does not tunnel. */
export const MAX_DT_S = 0.1;
/** Mouse look, radians per pixel of pointer-lock movement. */
export const LOOK_RAD_PER_PX = 0.0025;
export const PITCH_LIMIT_RAD = (89.5 * Math.PI) / 180;
/** The vertical field of view while walking or flying (Minecraft's 70°). */
export const VERTICAL_FOV_DEG = 70;

const EPS = 1e-6;
const TWO_PI = 2 * Math.PI;

/** A navigation state at an eye position and a look. */
export function createNavState({ x = 0, y = 0, z = 0, yaw = 0, pitch = 0 }) {
  return {
    x,
    y,
    z,
    yaw: wrapYaw(yaw),
    pitch: clampPitch(pitch),
    vz: 0,
    onGround: false,
    inWater: false,
    hovering: false,
  };
}

const wrapYaw = (yaw) => ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
const clampPitch = (pitch) =>
  Math.max(-PITCH_LIMIT_RAD, Math.min(PITCH_LIMIT_RAD, pitch));

/**
 * Mouse look: pointer-lock movement (CSS pixels) turns the yaw right for
 * +dx and the pitch down for +dy; the pitch stops short of straight up and
 * down, and there is never roll.
 */
export function look(state, dx, dy, radPerPx = LOOK_RAD_PER_PX) {
  return {
    ...state,
    yaw: wrapYaw(state.yaw + (Number(dx) || 0) * radPerPx),
    pitch: clampPitch(state.pitch - (Number(dy) || 0) * radPerPx),
  };
}

/**
 * Cesium's field of view (radians, across the wider side of the canvas)
 * that gives `verticalDeg` from top to bottom.
 */
export function cesiumFovRad(verticalDeg, width, height) {
  const vertical = (verticalDeg * Math.PI) / 180;
  if (!(width > 0) || !(height > 0) || height >= width) return vertical;
  return 2 * Math.atan(Math.tan(vertical / 2) * (width / height));
}

/**
 * The horizontal unit direction the movement keys ask for, east and north,
 * in the yaw's frame; zero when none (or opposite ones) are held.
 */
export function wishDirection(input, yaw) {
  const forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (!forward && !strafe) return { x: 0, y: 0 };
  // Forward is the heading; right is the heading + 90°.
  const x = forward * Math.sin(yaw) + strafe * Math.cos(yaw);
  const y = forward * Math.cos(yaw) - strafe * Math.sin(yaw);
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

/**
 * Whether the body can stand at (x, y) with its feet at `feet`, rising at
 * most `rise` onto the surface there: the feet height it would stand at,
 * or NaN when a wall or a ceiling is in the way. An unknown column lets
 * the body through at its height.
 */
function standAt(world, x, y, feet, rise) {
  const ground = world.surfaceBelow(x, y, feet + rise + EPS);
  if (!Number.isFinite(ground)) return feet;
  if (ground > feet + rise + EPS) return Number.NaN;
  const standing = Math.max(feet, ground);
  if (world.blocked(x, y, standing + EPS, standing + BODY_HEIGHT_M))
    return Number.NaN;
  return standing;
}

/**
 * Move horizontally by (dx, dy), sliding along a wall: the whole step if
 * it is clear, else the east or the north part alone.
 */
function slide(world, state, dx, dy, feet, rise) {
  for (const [mx, my] of [
    [dx, dy],
    [dx, 0],
    [0, dy],
  ]) {
    if (!mx && !my) continue;
    const standing = standAt(world, state.x + mx, state.y + my, feet, rise);
    if (Number.isFinite(standing))
      return { x: state.x + mx, y: state.y + my, feet: standing };
  }
  return { x: state.x, y: state.y, feet };
}

/**
 * The next state after `dt` seconds with `input` held:
 * {forward, back, left, right, jump, sprint, up, down} booleans. In Walk,
 * Space jumps (swims up in water) and `sprint` (Shift, or a double-tap of
 * forward) sprints; in Fly, Space rises, Shift descends and `sprint` (the
 * double-tap) doubles the speed. With nothing known
 * under the body it hovers: no fall, no climb.
 */
export function step(state, input, dt, world, mode = 'walk') {
  const time = Math.max(0, Math.min(MAX_DT_S, Number(dt) || 0));
  if (mode === 'fly') return flyStep(state, input, time, world);
  if (mode !== 'walk') return state;
  const stepUp = world.stepUpM ?? DEFAULT_STEP_UP_M;
  let feet = state.z - EYE_HEIGHT_M;
  const under = world.surfaceBelow(state.x, state.y, feet + EPS);
  const inWater = Boolean(
    world.waterAt(state.x, state.y, feet + BODY_HEIGHT_M / 4),
  );
  const wish = wishDirection(input, state.yaw);
  const speed = inWater
    ? SWIM_SPEED_M_S
    : input.sprint
      ? SPRINT_SPEED_M_S
      : WALK_SPEED_M_S;
  // A walker climbs a step from the ground or out of the water, not in mid-air.
  const rise = state.onGround || inWater ? stepUp : 0;
  const moved = slide(
    world,
    state,
    wish.x * speed * time,
    wish.y * speed * time,
    feet,
    rise,
  );
  feet = moved.feet;
  const ground = world.surfaceBelow(moved.x, moved.y, feet + EPS);
  if (!Number.isFinite(ground) && !Number.isFinite(under))
    return {
      ...state,
      x: moved.x,
      y: moved.y,
      z: feet + EYE_HEIGHT_M,
      vz: 0,
      onGround: false,
      inWater,
      hovering: true,
    };
  const floor = Number.isFinite(ground) ? ground : under;
  let vz = state.vz;
  let onGround = state.onGround && feet - floor <= SNAP_DOWN_M + EPS;
  // The vertical speed at the step's start, and the acceleration over it.
  let gravity = 0;
  if (inWater) {
    vz = input.jump ? SWIM_UP_M_S : -SINK_M_S;
    onGround = false;
  } else if (onGround && input.jump) {
    vz = JUMP_SPEED_M_S;
    onGround = false;
    gravity = GRAVITY_M_S2;
  } else if (onGround) {
    vz = 0;
  } else {
    gravity = vz > -TERMINAL_SPEED_M_S ? GRAVITY_M_S2 : 0;
  }
  // Exact under constant acceleration, so a jump peaks at JUMP_HEIGHT_M
  // whatever the frame rate.
  let next = feet + vz * time - 0.5 * gravity * time * time;
  vz = Math.max(-TERMINAL_SPEED_M_S, vz - gravity * time);
  if (onGround && vz === 0) {
    // On the ground: follow it down a slope or a small drop.
    next = floor;
  } else if (next <= floor) {
    next = floor;
    vz = 0;
    onGround = !inWater || input.jump !== true;
  }
  // A head against a ceiling stops the rise.
  if (
    next > feet &&
    world.blocked(moved.x, moved.y, feet + BODY_HEIGHT_M, next + BODY_HEIGHT_M)
  ) {
    next = feet;
    vz = 0;
  }
  return {
    ...state,
    x: moved.x,
    y: moved.y,
    z: next + EYE_HEIGHT_M,
    vz,
    onGround: onGround && next === floor,
    inWater,
    hovering: false,
  };
}

/** Creative flight: no gravity, the keys move it, the world still stops it. */
function flyStep(state, input, time, world) {
  const wish = wishDirection(input, state.yaw);
  const speed = FLY_SPEED_M_S * (input.sprint ? FLY_SPRINT_FACTOR : 1);
  let feet = state.z - EYE_HEIGHT_M;
  const moved = slide(
    world,
    state,
    wish.x * speed * time,
    wish.y * speed * time,
    feet,
    0,
  );
  feet = moved.feet;
  const climb = (input.up ? 1 : 0) - (input.down ? 1 : 0);
  let next = feet + climb * FLY_VERTICAL_M_S * time;
  const floor = world.surfaceBelow(moved.x, moved.y, feet + EPS);
  if (Number.isFinite(floor) && next < floor) next = floor;
  if (
    next > feet &&
    world.blocked(moved.x, moved.y, feet + BODY_HEIGHT_M, next + BODY_HEIGHT_M)
  )
    next = feet;
  return {
    ...state,
    x: moved.x,
    y: moved.y,
    z: next + EYE_HEIGHT_M,
    vz: 0,
    onGround: Number.isFinite(floor) && next === floor,
    inWater: Boolean(world.waterAt(moved.x, moved.y, next + BODY_HEIGHT_M / 4)),
    hovering: !Number.isFinite(floor),
  };
}
