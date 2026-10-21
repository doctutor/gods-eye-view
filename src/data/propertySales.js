// Personal fork: what the property build (`npm run property:build`), its
// server (/api/property) and the Property sales layer share: the metrics
// the hexagons carry, the property types, the answers' limits and the
// source's words. Not part of upstream God's Eye View.

export const PROPERTY_ENDPOINT = '/api/property';
export const PROPERTY_LAYER_ID = 'property-sales';

/**
 * The hexagons' metrics (the layer's chips, the Lego mode's modes): each
 * with the scale its ramp is drawn on. Prices count sales from
 * PRICE_SINCE_YEAR on, at PRICE_FLOOR_USD or more; the counts count every
 * record.
 */
export const PROPERTY_METRICS = Object.freeze([
  Object.freeze({ key: 'price', scale: 'log', units: 'USD' }),
  Object.freeze({ key: 'ppsf', scale: 'log', units: 'USD/sqft' }),
  Object.freeze({ key: 'year', scale: 'linear', units: 'year' }),
  Object.freeze({ key: 'sales', scale: 'log', units: 'sales' }),
  Object.freeze({ key: 'properties', scale: 'log', units: 'properties' }),
]);
export const PROPERTY_METRIC_KEYS = Object.freeze(
  PROPERTY_METRICS.map((metric) => metric.key),
);
export const DEFAULT_PROPERTY_METRIC = 'price';
export const propertyMetric = (key) =>
  PROPERTY_METRICS.find((metric) => metric.key === key) || null;

/** Sales before this year are left out of the price medians. */
export const PRICE_SINCE_YEAR = 2015;
/** Sales under this price (nominal transfers) are left out of the medians. */
export const PRICE_FLOOR_USD = 10_000;
/** A median needs this many values in its hexagon, else the cell is empty. */
export const MEDIAN_MIN_VALUES = 3;
/** The H3 resolutions the build keeps (the app's hex surfaces' 0–7). */
export const PROPERTY_RESOLUTIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);

/** Property types, each with its code in the index (0: not given). */
export const PROPERTY_TYPES = Object.freeze([
  Object.freeze({ code: 1, key: 'single_family' }),
  Object.freeze({ code: 2, key: 'condo' }),
  Object.freeze({ code: 3, key: 'townhouse' }),
  Object.freeze({ code: 4, key: 'apartment' }),
  Object.freeze({ code: 5, key: 'multi_family' }),
  Object.freeze({ code: 6, key: 'manufactured' }),
  Object.freeze({ code: 7, key: 'land' }),
  Object.freeze({ code: 8, key: 'other' }),
]);
const TYPE_BY_KEY = new Map(PROPERTY_TYPES.map((type) => [type.key, type]));
export const propertyTypeCode = (key) => TYPE_BY_KEY.get(key)?.code || 0;
export const propertyTypeKey = (code) =>
  PROPERTY_TYPES.find((type) => type.code === code)?.key || '';

/** Below this camera height the buildings as points, above it hexagons. */
export const PROPERTY_POINTS_BELOW_M = 6_000;
/** The most buildings one points answer holds. */
export const PROPERTY_POINT_LIMIT = 3_000;
/** A points box is at most this many degrees a side. */
export const PROPERTY_MAX_SPAN_DEGREES = 0.3;
/** The most hexagons one answer holds (the hex surfaces' limit). */
export const PROPERTY_MAX_CELLS = 20_000;
/** The most unit records a building's answer lists. */
export const PROPERTY_UNIT_LIMIT = 500;

export const PROPERTY_SOURCE = 'realestatedataset.com (Straply)';
export const PROPERTY_LICENSE = 'CC0 1.0';
export const PROPERTY_CREDIT_TEXT =
  'realestatedataset.com (Straply), CC0; public-record fields only';
