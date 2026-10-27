/**
 * Personal fork: Blocks lighting (docs/BLOCKS-PLAN.md, "Mesh"). Light is
 * the shape channel: a fixed shade per face (top brightest, north and south
 * next, east and west darkest), ambient occlusion at block edges, and a sun
 * term that never goes black on the shadow side; all baked into vertex
 * colours with the material's colour.
 */
import { MATERIALS } from './store.js';

/** The fixed shade of a face by the way it faces. */
export const FACE_SHADE = Object.freeze({
  up: 1.0,
  down: 0.5,
  north: 0.8,
  south: 0.8,
  east: 0.6,
  west: 0.6,
});

/** Ambient occlusion by how many neighbours occlude a vertex (0 … 3). */
export const AO = Object.freeze([1.0, 0.8, 0.6, 0.5]);

/**
 * How many neighbours occlude a face's vertex: the two beside it and the
 * one at the corner, in the layer the face looks into; both sides occlude
 * the corner whatever it holds (Minecraft's smooth lighting).
 */
export function aoCount(side1, side2, corner) {
  if (side1 && side2) return 3;
  return (
    Number(Boolean(side1)) + Number(Boolean(side2)) + Number(Boolean(corner))
  );
}

/** The sun term's floor: the side away from the sun is never black. */
export const SUN_FLOOR = 0.6;

/**
 * A unit vector toward the sun, {east, north, up} in the region's frame,
 * from its azimuth (degrees clockwise from north) and elevation (degrees
 * above the horizon).
 */
export function sunDirection(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return {
    east: Math.sin(az) * Math.cos(el),
    north: Math.cos(az) * Math.cos(el),
    up: Math.sin(el),
  };
}

/** An {east, north, up} vector (or an [e, n, u] array) as an array. */
const enuArray = (vector) =>
  Array.isArray(vector) || ArrayBuffer.isView(vector)
    ? vector
    : [vector.east, vector.north, vector.up];

/**
 * The fixed study sun, from the north-west 45° up (the cartographer's
 * hillshade light), for when the real sun is low.
 */
export const STUDY_SUN = Object.freeze({ azimuthDeg: 315, elevationDeg: 45 });
export const STUDY_SUN_DIR = Object.freeze(
  sunDirection(STUDY_SUN.azimuthDeg, STUDY_SUN.elevationDeg),
);

/**
 * The sun's share of a face's light: SUN_FLOOR on faces turned away from
 * the sun, up to 1.0 facing it. `normal` and `sunDir` are {east, north,
 * up} unit vectors in the region's frame (an [e, n, u] array is taken
 * too); the study sun when none is given.
 */
export function sunTerm(normal, sunDir = STUDY_SUN_DIR) {
  const sun = enuArray(sunDir || STUDY_SUN_DIR);
  normal = enuArray(normal);
  const length = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  const facing =
    (normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2]) / length;
  return SUN_FLOOR + (1 - SUN_FLOOR) * Math.max(0, Math.min(1, facing));
}

/**
 * Material colours, RGBA bytes. Milestone 1 has one terrain material, a
 * light neutral so the light carries the shape, and translucent water.
 */
export const MATERIAL_COLORS = Object.freeze({
  [MATERIALS.TERRAIN]: Object.freeze([200, 194, 176, 255]),
  [MATERIALS.WATER]: Object.freeze([58, 112, 190, 170]),
});
const UNKNOWN_COLOR = Object.freeze([255, 0, 255, 255]);

/** A material's colour (magenta for one without a colour yet). */
export const materialColor = (material) =>
  MATERIAL_COLORS[material] ?? UNKNOWN_COLOR;

/**
 * A vertex colour: the material's colour × the light (shade × AO × sun),
 * RGB rounded to bytes, the material's alpha kept.
 */
export function litColor(material, light, out = new Array(4)) {
  const color = materialColor(material);
  for (let k = 0; k < 3; k += 1)
    out[k] = Math.max(0, Math.min(255, Math.round(color[k] * light)));
  out[3] = color[3];
  return out;
}
