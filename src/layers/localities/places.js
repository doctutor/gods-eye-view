// Personal fork: the pure parts of the Localities layer (index.js): which
// places to name at a camera height, the Overpass query for OpenStreetMap's
// places close in, and the overlay entries for a label and a card. No
// Cesium here but the Cartesian3 factory a caller hands in.

import { viewWindow } from '../../maps/h3Cells.js';
import { riverZoomForHeight } from '../../data/earthEngineLayers.js';

/**
 * Level of detail.
 *
 * - Orbit to regional: Natural Earth's populated places (the bundled pack),
 *   each named from the zoom Natural Earth itself gives it (`z`, its
 *   min_zoom: derived from scalerank and population) once the imagery
 *   level the camera height drapes at the middle of the view
 *   (riverZoomForHeight, a 1,600 px canvas) reaches it. Within that, the
 *   most prominent first (national capitals, then lower z, scalerank and
 *   larger population), at most MAX_PLACE_LABELS, in the view window; the
 *   overlay's collision solver drops what overlaps.
 * - Close in, below OSM_MAX_HEIGHT_M: the local Overture divisions index
 *   when it is built (`npm run overture:build`): the places of the view
 *   whose zoom (from Overture's prominence and the kind,
 *   src/data/overtureDivisions.js) the view's zoom reaches, the most
 *   prominent first, at most OVERTURE_PLACE_LIMIT, thinned by the server.
 *   Without the build, OpenStreetMap's place nodes from Overpass, the kinds
 *   widening as the camera comes in (OSM_PLACE_BANDS). Either way Natural
 *   Earth's place drops where the close-in source has one of the same name
 *   within SAME_PLACE_KM.
 */
export const MAX_PLACE_LABELS = 180;
/** Below this camera height OpenStreetMap's places join in. */
export const OSM_MAX_HEIGHT_M = 60_000;
/** Below each height, the OpenStreetMap place kinds asked for. */
export const OSM_PLACE_BANDS = Object.freeze([
  Object.freeze({
    maxHeightM: 6_000,
    kinds: Object.freeze([
      'city',
      'town',
      'village',
      'suburb',
      'hamlet',
      'neighbourhood',
    ]),
  }),
  Object.freeze({
    maxHeightM: 20_000,
    kinds: Object.freeze(['city', 'town', 'village', 'suburb']),
  }),
  Object.freeze({
    maxHeightM: OSM_MAX_HEIGHT_M,
    kinds: Object.freeze(['city', 'town']),
  }),
]);
/** The most places one Overpass answer brings. */
export const OSM_QUERY_LIMIT = 800;
/** The query box's half-side in camera heights (the ground a nadir view sees)… */
export const OSM_BOX_HALF_FACTOR = 1;
/** …at least this many metres… */
export const OSM_BOX_MIN_HALF_M = 3_000;
/** …and snapped outward to this grid, so a small pan reuses the answer. */
export const OSM_BOX_SNAP_DEGREES = 0.05;
/** A Natural Earth place drops within this distance of an OSM place of its name. */
export const SAME_PLACE_KM = 5;

/** The label colour per ink: white on imagery and dark maps, near-black on light ones. */
export const PLACE_COLORS = Object.freeze({
  light: '#ffffff',
  dark: '#1a1a1a',
});

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** The angle (radians) between two points seen from the Earth's centre. */
export function centralAngle(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function inWindow(window, lat, lon) {
  if (!window) return true;
  if (lat < window.south || lat > window.north) return false;
  return window.west <= window.east
    ? lon >= window.west && lon <= window.east
    : lon >= window.west || lon <= window.east;
}

/** The imagery level a camera height drapes at the middle of the view. */
export function placeZoomForHeight(heightM) {
  return riverZoomForHeight(heightM);
}

/** How prominent a Natural Earth place is: lower sorts first. */
function prominence(place) {
  return [
    place.cap === 'country' ? 0 : 1,
    Number(place.z) || 0,
    Number(place.rank) || 0,
    -(Number(place.pop) || 0),
  ];
}
function compareProminence(a, b) {
  const x = prominence(a);
  const y = prominence(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The Natural Earth places to name for a view: those whose `z` the view's
 * zoom reaches, in the view window (for a planet-wide window, the side of
 * the Earth the camera sees), most prominent first, at most `limit`.
 * @param {Array<object>} places The pack's places.
 * @param {{lat: number, lon: number, height: number}} view
 * @returns {Array<{id: string, place: object, lon: number, lat: number}>}
 */
export function pickNaturalEarthPlaces(
  places,
  view,
  { limit = MAX_PLACE_LABELS } = {},
) {
  const height = Number(view?.height);
  const zoom = placeZoomForHeight(Number.isFinite(height) ? height : 2e7);
  const window = viewWindow(view.lat, view.lon, height);
  const reach = window
    ? Infinity
    : Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + Math.max(0, height))) +
      toRadians(10);
  const picked = [];
  (places || []).forEach((place, index) => {
    if (!(Number(place?.z) <= zoom)) return;
    const [lon, lat] = place.at || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (!inWindow(window, lat, lon)) return;
    if (centralAngle(view.lat, view.lon, lat, lon) > reach) return;
    picked.push({ id: `ne:${index}`, place, lon, lat });
  });
  return picked
    .sort((a, b) => compareProminence(a.place, b.place))
    .slice(0, Math.max(0, limit));
}

/** The OpenStreetMap place kinds asked for at a height, or [] above them. */
export function osmPlaceKindsForHeight(heightM) {
  const height = Number(heightM);
  if (!Number.isFinite(height)) return [];
  return [
    ...(OSM_PLACE_BANDS.find((band) => height < band.maxHeightM)?.kinds || []),
  ];
}

const snapDown = (value) =>
  Number(
    (Math.floor(value / OSM_BOX_SNAP_DEGREES) * OSM_BOX_SNAP_DEGREES).toFixed(
      2,
    ),
  );
const snapUp = (value) =>
  Number(
    (Math.ceil(value / OSM_BOX_SNAP_DEGREES) * OSM_BOX_SNAP_DEGREES).toFixed(2),
  );

/** The box an Overpass query asks for around a view, snapped outward. */
export function osmQueryBox(view) {
  const half = Math.max(
    OSM_BOX_MIN_HALF_M,
    OSM_BOX_HALF_FACTOR * Number(view.height),
  );
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.05, Math.cos(toRadians(view.lat)));
  return {
    south: Math.max(-90, snapDown(view.lat - dLat)),
    west: Math.max(-180, snapDown(view.lon - dLon)),
    north: Math.min(90, snapUp(view.lat + dLat)),
    east: Math.min(180, snapUp(view.lon + dLon)),
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

/** The Overpass query for the named place nodes of some kinds in a box. */
export function buildPlacesQuery(box, kinds, limit = OSM_QUERY_LIMIT) {
  const allowed = kinds.filter((kind) => /^[a-z_]+$/.test(kind));
  if (!allowed.length) throw new TypeError('No place kinds to ask for');
  const bbox = [box.south, box.west, box.north, box.east].join(',');
  return (
    `[out:json][timeout:25];node["place"~"^(${allowed.join('|')})$"]["name"]` +
    `(${bbox});out body qt ${Math.max(1, Math.floor(limit))};`
  );
}

/** OpenStreetMap's population tag as a number ("1 234 567", "12,000"). */
export function parsePopulation(value) {
  const digits = String(value ?? '').replace(/[\s,.'  ]/g, '');
  if (!/^\d{1,10}$/.test(digits)) return 0;
  return Number(digits);
}

/** An Overpass place node as a place, or null. */
export function normalizeOsmPlace(element) {
  const tags = element?.tags || {};
  const lat = Number(element?.lat);
  const lon = Number(element?.lon);
  const name = tags['name:en'] || tags.name;
  if (element?.type !== 'node' || !name || !tags.place) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const pop = parsePopulation(tags.population);
  return {
    id: `osm:${element.id}`,
    name,
    ...(tags['name:es'] && tags['name:es'] !== name
      ? { es: tags['name:es'] }
      : {}),
    ...(tags['name:ru'] && tags['name:ru'] !== name
      ? { ru: tags['name:ru'] }
      : {}),
    ...(tags.name && tags.name !== name ? { local: tags.name } : {}),
    kind: String(tags.place),
    ...(pop ? { pop } : {}),
    at: [lon, lat],
  };
}

const KIND_ORDER = Object.freeze([
  'city',
  'town',
  'village',
  'suburb',
  'hamlet',
  'neighbourhood',
]);
/** OpenStreetMap places, larger kinds and populations first. */
export function sortOsmPlaces(places) {
  const order = (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    return index < 0 ? KIND_ORDER.length : index;
  };
  return [...places].sort(
    (a, b) =>
      order(a.kind) - order(b.kind) ||
      (b.pop || 0) - (a.pop || 0) ||
      a.name.localeCompare(b.name),
  );
}

const sameName = (a, b) =>
  String(a || '')
    .trim()
    .toLowerCase() ===
  String(b || '')
    .trim()
    .toLowerCase();

/**
 * Natural Earth's picks without those the close-in source also has (the
 * same name within SAME_PLACE_KM), then the close-in places: OpenStreetMap's
 * sorted by kind and population, Overture's (`ordered`) as the server
 * ranked them.
 */
export function mergePlaces(naturalEarth, osm, { ordered = false } = {}) {
  const kept = (naturalEarth || []).filter(
    ({ place, lat, lon }) =>
      !(osm || []).some(
        (other) =>
          (sameName(other.name, place.name) ||
            sameName(other.local, place.name)) &&
          (centralAngle(lat, lon, other.at[1], other.at[0]) * EARTH_RADIUS_M) /
            1000 <=
            SAME_PLACE_KM,
      ),
  );
  return {
    naturalEarth: kept,
    osm: (ordered ? osm || [] : sortOsmPlaces(osm || [])).map((place) => ({
      id: place.id,
      place,
      lon: place.at[0],
      lat: place.at[1],
    })),
  };
}

/** A place's name in a language (es, ru), else its English one. */
export function placeName(place, locale = 'en') {
  const language = String(locale || 'en')
    .slice(0, 2)
    .toLowerCase();
  return (language !== 'en' && place?.[language]) || place?.name || '';
}

/** Overture's kinds without prominence, by collision priority. */
const OVERTURE_PRIORITY = Object.freeze({
  localadmin: 24,
  county: 22,
  macrohood: 20,
  neighborhood: 16,
  microhood: 12,
});

/** A label's collision priority: capitals and larger places win. */
export function labelPriority(place) {
  if (place?.source === 'overture')
    return place.prominence > 0
      ? 12 + Math.round(place.prominence * 0.33)
      : OVERTURE_PRIORITY[place.kind] || 14;
  if (place?.kind) {
    const index = KIND_ORDER.indexOf(place.kind);
    return 40 - (index < 0 ? KIND_ORDER.length : index) * 4;
  }
  if (place?.cap === 'country') return 60;
  return 50 - (Number(place?.z) || 0) * 2;
}

/**
 * The overlay label for a place: interactive, so a click on it opens its
 * card (index.js hit-tests the overlay).
 */
export function placeLabelEntry({
  id,
  place,
  lon,
  lat,
  title,
  accent,
  cesium,
}) {
  return {
    id,
    variant: 'label',
    position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
    title,
    details: [],
    accent,
    priority: labelPriority(place),
    collisionGroup: 'locality-name',
    interactive: true,
    accessibilityLabel: title,
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 4,
    placement: 'above',
  };
}

/** The card beside a clicked place. */
export function placeCardEntry({
  place,
  lon,
  lat,
  title,
  details,
  accent,
  cesium,
}) {
  return {
    id: 'card',
    variant: 'card',
    position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
    title,
    details,
    accent,
    priority: 1000,
    protected: true,
    collisionGroup: 'locality-card',
    interactive: false,
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    placement: 'above',
    accessibilityLabel: `${title}${place?.kind ? ` (${place.kind})` : ''}`,
  };
}
