// Personal fork: the pure parts of the Places layer (index.js): the query
// box for pins, a server place checked on the way in, its colour and card.
// No Cesium here but the Cartesian3 factory a caller hands in.

import {
  PLACE_CATEGORIES,
  PLACE_PINS_BELOW_M,
} from '../../data/overturePlaces.js';

/**
 * Level of detail: below PLACE_PINS_BELOW_M the view's places as pins (the
 * most confident first, at most 1,500, from /api/overture/places), above it
 * the same places counted per H3 cell at the resolution the camera height
 * implies (the shared point rollup, fed the server's counts).
 */
export { PLACE_PINS_BELOW_M };
/** The query box's half-side: one camera height, at least this… */
export const PIN_BOX_MIN_HALF_M = 1_500;
/** …snapped outward to this grid, so a small pan reuses the answer. */
export const PIN_BOX_SNAP_DEGREES = 0.02;

/** A colour per category (ALL draws each pin in its own). */
export const CATEGORY_COLORS = Object.freeze({
  food: '#ff7043',
  shopping: '#ab47bc',
  health: '#ef5350',
  education: '#42a5f5',
  transport: '#26c6da',
  lodging: '#a1887f',
  public: '#90a4ae',
  religion: '#ffca28',
  recreation: '#66bb6a',
  charging: '#00c2a8',
  other: '#bdbdbd',
  all: '#39d5ff',
});
export const CATEGORY_KEYS = Object.freeze([
  'all',
  ...PLACE_CATEGORIES.map((c) => c.key),
]);

const EARTH_RADIUS_M = 6_371_000;
const snap = (value, up) =>
  Number(
    (
      (up ? Math.ceil : Math.floor)(value / PIN_BOX_SNAP_DEGREES) *
      PIN_BOX_SNAP_DEGREES
    ).toFixed(2),
  );

/** The box a pins query asks for around a view, snapped outward. */
export function pinQueryBox(view) {
  const half = Math.max(PIN_BOX_MIN_HALF_M, Number(view.height));
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.05, Math.cos((view.lat * Math.PI) / 180));
  return {
    south: Math.max(-85, snap(view.lat - dLat, false)),
    west: Math.max(-180, snap(view.lon - dLon, false)),
    north: Math.min(85, snap(view.lat + dLat, true)),
    east: Math.min(180, snap(view.lon + dLon, true)),
  };
}

/** Whether a box lies inside another. */
export function boxCovers(outer, inner) {
  return Boolean(
    outer &&
    inner &&
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east,
  );
}

const short = (value, max) =>
  typeof value === 'string' && value.length <= max ? value : '';

/** A server place, checked: {id, name, category, basic?, website?, phone?, brand?, source?, confidence, at}, or null. */
export function normalizePlace(raw) {
  const name = short(raw?.name, 200).trim();
  const [lon, lat] = Array.isArray(raw?.at) ? raw.at.map(Number) : [];
  if (
    !name ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const id = short(raw.id, 80);
  if (!/^pl:[\d:]+$/.test(id)) return null;
  const category =
    CATEGORY_KEYS.includes(raw.category) && raw.category !== 'all'
      ? raw.category
      : 'other';
  const confidence = Number(raw.confidence);
  const website = short(raw.website, 200);
  return {
    id,
    name,
    category,
    ...(short(raw.basic, 60) ? { basic: raw.basic } : {}),
    // Text only: a website is shown, never followed by the app.
    ...(website && /^https?:\/\/[^\s]+$/i.test(website) ? { website } : {}),
    ...(short(raw.phone, 40) ? { phone: raw.phone } : {}),
    ...(short(raw.brand, 100) ? { brand: raw.brand } : {}),
    ...(short(raw.source, 40) ? { source: raw.source } : {}),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    at: [lon, lat],
  };
}

/** Overture's basic category in words: "fast_food_restaurant" → "Fast food restaurant". */
export function basicLabel(basic) {
  const text = String(basic || '')
    .replace(/_/g, ' ')
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** The card beside a clicked place. */
export function placeCardEntry({ place, title, details, accent, cesium }) {
  return {
    id: 'card',
    variant: 'card',
    position: cesium.Cartesian3.fromDegrees(place.at[0], place.at[1], 0),
    title,
    details,
    accent,
    priority: 1000,
    protected: true,
    collisionGroup: 'places-card',
    interactive: false,
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    placement: 'above',
    accessibilityLabel: title,
  };
}
