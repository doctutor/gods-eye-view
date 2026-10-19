// Personal fork: what the Overture places build, its server and the Places
// layer share: the categories the chips name, how a place's taxonomy picks
// one, the confidence thresholds and the answers' limits. Not part of
// upstream God's Eye View.

export const OVERTURE_PLACES_ENDPOINT = '/api/overture/places';
/**
 * The categories (chips), each with its code in the index. A place's
 * category comes from Overture's taxonomy (schema v2.0.0: `basic_category`
 * and `taxonomy.hierarchy`, top level first): EV charging and places of
 * worship by name anywhere in it, the rest by the hierarchy's top level.
 * What matches none (services and business, lifestyle services, geographic
 * entities) is OTHER: counted in ALL, without a chip of its own.
 */
export const PLACE_CATEGORIES = Object.freeze([
  Object.freeze({ code: 1, key: 'food', tops: ['food_and_drink'] }),
  Object.freeze({ code: 2, key: 'shopping', tops: ['shopping'] }),
  Object.freeze({ code: 3, key: 'health', tops: ['health_care'] }),
  Object.freeze({ code: 4, key: 'education', tops: ['education'] }),
  Object.freeze({
    code: 5,
    key: 'transport',
    tops: ['travel_and_transportation'],
  }),
  Object.freeze({ code: 6, key: 'lodging', tops: ['lodging'] }),
  Object.freeze({ code: 7, key: 'public', tops: ['community_and_government'] }),
  Object.freeze({ code: 8, key: 'religion', tops: ['religious_organization'] }),
  Object.freeze({
    code: 9,
    key: 'recreation',
    tops: [
      'arts_and_entertainment',
      'sports_and_recreation',
      'cultural_and_historic',
    ],
  }),
  Object.freeze({ code: 10, key: 'charging', tops: [] }),
]);
export const OTHER_CATEGORY = 11;
/** Category slots in a count vector: 1–11 (0 unused). */
export const CATEGORY_SLOTS = 12;
const BY_TOP = new Map(
  PLACE_CATEGORIES.flatMap((c) => c.tops.map((top) => [top, c.code])),
);
const BY_KEY = new Map(PLACE_CATEGORIES.map((c) => [c.key, c]));

/** A category's record by key ('all' and unknown keys give null). */
export const placeCategory = (key) => BY_KEY.get(key) || null;
export const placeCategoryOfCode = (code) =>
  PLACE_CATEGORIES.find((c) => c.code === code) || null;

/** The category code of a place from its basic category and taxonomy hierarchy. */
export function categoryCode(basic, hierarchy = []) {
  const names = [String(basic || ''), ...hierarchy.map(String)];
  if (names.some((name) => /charging/.test(name))) return 10;
  if (
    names.some((name) => /place_of_worship|religious_organization/.test(name))
  )
    return 8;
  return BY_TOP.get(String(hierarchy[0] || '')) ?? OTHER_CATEGORY;
}

/** The build keeps places this confident or more… */
export const PLACE_MIN_CONFIDENCE = 0.5;
/** …and the layer's chips choose between these (the first by default). */
export const PLACE_CONFIDENCE_CHOICES = Object.freeze([0.8, 0.5]);
/** The confidence thresholds a count is kept for (index 0: ≥ 0.5, 1: ≥ 0.8). */
export const COUNT_THRESHOLDS = Object.freeze([0.5, 0.8]);

/** The most pins one answer brings. */
export const PLACE_PIN_LIMIT = 1_500;
/** The widest box the pins route answers, in degrees. */
export const PLACE_MAX_SPAN_DEGREES = 1;
/** H3 resolutions the counts are kept for (the rollup's 0 to 7). */
export const PLACE_COUNT_RESOLUTIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
/** Below this camera height pins, above it counts. */
export const PLACE_PINS_BELOW_M = 20_000;
