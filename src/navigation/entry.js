/**
 * Personal fork: the way into Walk or Fly and back out (pure). "Walk here"
 * stands the walker on the targeted block (target.js facts): at the top of
 * the solid run it belongs to, the column's centre, facing the camera's
 * heading with its pitch kept. Leaving lifts the camera to a view
 * EXIT_UP_M above and EXIT_BACK_M behind the walker, looking at where it
 * stood, so the user keeps their place.
 */
import { EYE_HEIGHT_M, PITCH_LIMIT_RAD } from './movement.js';
import { isSolid } from '../layers/blocks/store.js';
import { msg } from '../i18n/index.js';

/** The view leaving Walk or Fly flies to: this far back and up. */
export const EXIT_BACK_M = 60;
export const EXIT_UP_M = 60;
/** The lift's flight, seconds. */
export const EXIT_FLIGHT_S = 1.2;
/** The most levels climbed from a targeted block to its run's top. */
const MAX_RUN_LEVELS = 4096;

/**
 * The level the walker stands on for a targeted block: the top of the
 * solid run it is in (a wall's face targets a block below the top; the
 * walker stands on the wall).
 */
export function standingLevel(occupancy, facts) {
  let y = facts.y;
  for (let k = 0; k < MAX_RUN_LEVELS; k += 1) {
    const above = occupancy(facts.i, facts.j, y + 1);
    if (above === null || !isSolid(above)) break;
    y += 1;
  }
  return y;
}

/**
 * The walker's pose on a targeted block, in the Blocks region's frame
 * (metres, z above sea level): the column's centre, the eye EYE_HEIGHT_M
 * above the run's top, facing `headingRad`, `pitchRad` kept (inside the
 * model's pitch limit). `occupancy(i, j, y)` is the world's.
 */
export function entryPose({ facts, occupancy, headingRad = 0, pitchRad = 0 }) {
  const b = facts.blockM;
  const top = standingLevel(occupancy, facts);
  return {
    x: (facts.i + 0.5) * b,
    y: (facts.j + 0.5) * b,
    z: (top + 1) * b + EYE_HEIGHT_M,
    yaw: headingRad,
    pitch: Math.max(-PITCH_LIMIT_RAD, Math.min(PITCH_LIMIT_RAD, pitchRad)),
    level: top,
  };
}

/**
 * The view leaving lifts to, east-north-up metres from the walker's eye:
 * `backM` behind it along its heading and `upM` above, the same heading,
 * pitched down at where its feet stood.
 */
export function exitView({ yaw, backM = EXIT_BACK_M, upM = EXIT_UP_M }) {
  return {
    east: -backM * Math.sin(yaw),
    north: -backM * Math.cos(yaw),
    up: upM,
    heading: yaw,
    pitch: -Math.atan2(upM + EYE_HEIGHT_M, backM),
  };
}

/** The keys a mode uses, for the hint over the crosshair. */
export const MODE_HINTS = Object.freeze({
  walk: msg('WASD move · Space jump · Shift sprint · Esc release'),
  fly: msg('WASD move · Space/Shift up/down · W twice faster · Esc release'),
});
