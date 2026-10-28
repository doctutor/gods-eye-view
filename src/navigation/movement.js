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
/** Sneaking (Shift, Minecraft's default): slower, the eye lower, edges held. */
export const SNEAK_SPEED_M_S = 1.3;
export const SNEAK_EYE_DROP_M = 0.3;
/** How fast the eye moves to a new height (sneaking or not), m/s. */
export const EYE_EASE_M_S = 3;
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

/** A stick's axis, −1…1 (0 for none). */
const axisOf = (value) => Math.max(-1, Math.min(1, Number(value) || 0));

/**
 * The horizontal direction the movement keys (or a stick) ask for, east
 * and north, in the yaw's frame: a unit vector for keys, shorter for a
 * stick pushed part way (its magnitude scales the speed); zero when
 * nothing (or opposite keys) is held. Per axis the larger of the keys' ±1
 * and `input.analog` ({forward, right}) wins.
 */
export function wishDirection(input, yaw) {
  let forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  let strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const stickForward = axisOf(input.analog?.forward);
  const stickRight = axisOf(input.analog?.right);
  if (Math.abs(stickForward) > Math.abs(forward)) forward = stickForward;
  if (Math.abs(stickRight) > Math.abs(strafe)) strafe = stickRight;
  if (!forward && !strafe) return { x: 0, y: 0 };
  // Forward is the heading; right is the heading + 90°.
  const x = forward * Math.sin(yaw) + strafe * Math.cos(yaw);
  const y = forward * Math.cos(yaw) - strafe * Math.sin(yaw);
  const length = Math.hypot(x, y);
  const scale = length > 1 ? 1 / length : 1;
  return { x: x * scale, y: y * scale };
}

/**
 * Whether the body can stand at (x, y) with its feet at `feet`, rising at
 * most `rise` onto the surface there: the feet height it would stand at,
 * or NaN when a wall or a ceiling is in the way. An unknown column lets
 * the body through at its height.
 */
function standAt(world, x, y, feet, rise, hold = -Infinity) {
  const ground = world.surfaceBelow(x, y, feet + rise + EPS);
  // Sneaking on the ground (`hold` finite): never off an edge, nor into
  // the unknown.
  if (!Number.isFinite(ground)) return hold > -Infinity ? Number.NaN : feet;
  if (ground < hold - EPS) return Number.NaN;
  if (ground > feet + rise + EPS) return Number.NaN;
  const standing = Math.max(feet, ground);
  if (world.blocked(x, y, standing + EPS, standing + BODY_HEIGHT_M))
    return Number.NaN;
  return standing;
}

/** Bisections that close a blocked step on a wall (to 1/256 of the step). */
const CONTACT_STEPS = 8;

/**
 * Move horizontally by (dx, dy), sliding along a wall: the whole step if
 * it is clear; else the clear part (east or north) whole and the blocked
 * part as far as it goes, so the body comes to the wall rather than
 * stopping a frame's travel short of it (18 cm at Fly's 10.8 m/s).
 */
function slide(world, state, dx, dy, feet, rise, hold = -Infinity) {
  const at = (x, y) => standAt(world, x, y, feet, rise, hold);
  const whole = at(state.x + dx, state.y + dy);
  if (Number.isFinite(whole))
    return { x: state.x + dx, y: state.y + dy, feet: whole };
  let x = state.x;
  let y = state.y;
  let standing = feet;
  /** As far along (mx, my) from (x, y) as stands, by bisection. */
  const approach = (mx, my) => {
    if (!mx && !my) return;
    const full = at(x + mx, y + my);
    if (Number.isFinite(full)) {
      x += mx;
      y += my;
      standing = full;
      return;
    }
    let lo = 0;
    let hi = 1;
    let best = Number.NaN;
    for (let k = 0; k < CONTACT_STEPS; k += 1) {
      const mid = (lo + hi) / 2;
      const there = at(x + mx * mid, y + my * mid);
      if (Number.isFinite(there)) {
        lo = mid;
        best = there;
      } else hi = mid;
    }
    if (lo > 0) {
      x += mx * lo;
      y += my * lo;
      standing = best;
    }
  };
  // The free part first, whole, then the blocked part up to the wall.
  if (Number.isFinite(at(state.x + dx, state.y))) {
    approach(dx, 0);
    approach(0, dy);
  } else {
    approach(0, dy);
    approach(dx, 0);
  }
  return { x, y, feet: standing };
}

/**
 * The next state after `dt` seconds with `input` held:
 * {forward, back, left, right, jump, sprint, up, down} booleans. In Walk,
 * Space jumps (swims up in water) and `sprint` (Shift, or a double-tap of
 * forward) sprints; in Fly, Space rises, Shift descends and `sprint` (the
 * double-tap) doubles the speed. With nothing known
 * under the body it hovers: no fall, no climb. `sneak` (Walk): 1.3 m/s,
 * the eye 0.3 m lower, and on the ground the body never steps off an
 * edge deeper than it follows a slope (SNAP_DOWN_M), nor into the unknown.
 * `tuning` ({walk, sprint, sneak, fly, eye}: m/s and the standing eye
 * height) overrides the defaults (the Controls settings).
 */
export function step(state, input, dt, world, mode = 'walk', tuning = {}) {
  const time = Math.max(0, Math.min(MAX_DT_S, Number(dt) || 0));
  if (mode === 'fly') return flyStep(state, input, time, world, tuning);
  if (mode !== 'walk') return state;
  const stepUp = world.stepUpM ?? DEFAULT_STEP_UP_M;
  const standing = tuning.eye ?? EYE_HEIGHT_M;
  const eyeNow = state.eyeM ?? standing;
  let feet = state.z - eyeNow;
  const under = world.surfaceBelow(state.x, state.y, feet + EPS);
  const inWater = Boolean(
    world.waterAt(state.x, state.y, feet + BODY_HEIGHT_M / 4),
  );
  const wish = wishDirection(input, state.yaw);
  const sneaking = Boolean(input.sneak) && !inWater;
  const speed = inWater
    ? SWIM_SPEED_M_S
    : sneaking
      ? (tuning.sneak ?? SNEAK_SPEED_M_S)
      : input.sprint
        ? (tuning.sprint ?? SPRINT_SPEED_M_S)
        : (tuning.walk ?? WALK_SPEED_M_S);
  // A walker climbs a step from the ground or out of the water, not in mid-air.
  const rise = state.onGround || inWater ? stepUp : 0;
  // Sneaking on the ground: no lower than a slope it follows.
  const hold = sneaking && state.onGround ? feet - SNAP_DOWN_M : -Infinity;
  const moved = slide(
    world,
    state,
    wish.x * speed * time,
    wish.y * speed * time,
    feet,
    rise,
    hold,
  );
  // The eye moves to its height for sneaking or standing.
  const eyeTarget = sneaking ? standing - SNEAK_EYE_DROP_M : standing;
  const eyeStep = EYE_EASE_M_S * time;
  const eye =
    Math.abs(eyeTarget - eyeNow) <= eyeStep
      ? eyeTarget
      : eyeNow + Math.sign(eyeTarget - eyeNow) * eyeStep;
  feet = moved.feet;
  const ground = world.surfaceBelow(moved.x, moved.y, feet + EPS);
  if (!Number.isFinite(ground) && !Number.isFinite(under))
    return {
      ...state,
      x: moved.x,
      y: moved.y,
      z: feet + eye,
      eyeM: eye,
      vz: 0,
      onGround: false,
      inWater,
      hovering: true,
      sneaking,
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
    z: next + eye,
    eyeM: eye,
    vz,
    onGround: onGround && next === floor,
    inWater,
    hovering: false,
    sneaking,
  };
}

/** Creative flight: no gravity, the keys move it, the world still stops it. */
function flyStep(state, input, time, world, tuning = {}) {
  const wish = wishDirection(input, state.yaw);
  const fly = tuning.fly ?? FLY_SPEED_M_S;
  const speed = fly * (input.sprint ? FLY_SPRINT_FACTOR : 1);
  // Up and down scale with the chosen speed (Minecraft's spectator wheel).
  const vertical = FLY_VERTICAL_M_S * (fly / FLY_SPEED_M_S);
  const standing = tuning.eye ?? EYE_HEIGHT_M;
  const eyeNow = state.eyeM ?? standing;
  const eyeStep = EYE_EASE_M_S * time;
  const eye =
    Math.abs(standing - eyeNow) <= eyeStep
      ? standing
      : eyeNow + Math.sign(standing - eyeNow) * eyeStep;
  let feet = state.z - eyeNow;
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
  let next = feet + climb * vertical * time;
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
    z: next + eye,
    eyeM: eye,
    vz: 0,
    sneaking: false,
    onGround: Number.isFinite(floor) && next === floor,
    inWater: Boolean(world.waterAt(moved.x, moved.y, next + BODY_HEIGHT_M / 4)),
    hovering: !Number.isFinite(floor),
  };
}
