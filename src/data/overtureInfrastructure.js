// Personal fork: what the Overture infrastructure build, its server and the
// Street assets layer share: the classes kept, their keys (the Street assets
// types') and the answers' limits. Not part of upstream God's Eye View.

export const OVERTURE_INFRASTRUCTURE_ENDPOINT = '/api/overture/infrastructure';

/**
 * The classes of Overture's base theme, type=infrastructure (schema v2.0.0,
 * from OpenStreetMap tags), that the build keeps, each with its code in the
 * index and the Street assets type it serves. Charging stations
 * (amenity=charging_station) are kept too: OpenStreetMap's, beside the
 * places theme's.
 */
export const INFRASTRUCTURE_CLASSES = Object.freeze([
  Object.freeze({
    code: 1,
    key: 'hydrant',
    subtype: 'emergency',
    class: 'fire_hydrant',
  }),
  Object.freeze({
    code: 2,
    key: 'lamp',
    subtype: 'transportation',
    class: 'street_lamp',
  }),
  Object.freeze({
    code: 3,
    key: 'signals',
    subtype: 'transportation',
    class: 'traffic_signals',
  }),
  Object.freeze({
    code: 4,
    key: 'charging',
    subtype: 'transportation',
    class: 'charging_station',
  }),
]);
const BY_CLASS = new Map(INFRASTRUCTURE_CLASSES.map((c) => [c.class, c]));
const BY_KEY = new Map(INFRASTRUCTURE_CLASSES.map((c) => [c.key, c]));

/** A class's record by key ('all' and unknown keys give null). */
export const infrastructureClass = (key) => BY_KEY.get(key) || null;
export const infrastructureClassOfCode = (code) =>
  INFRASTRUCTURE_CLASSES.find((c) => c.code === code) || null;
/** The code of an Overture class name, or 0 when the build does not keep it. */
export const infrastructureCode = (className) =>
  BY_CLASS.get(String(className || ''))?.code || 0;

/** The most pins one answer brings. */
export const INFRASTRUCTURE_PIN_LIMIT = 2_000;
/** The widest box the pins route answers, in degrees. */
export const INFRASTRUCTURE_MAX_SPAN_DEGREES = 1;
