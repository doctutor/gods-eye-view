import * as Cesium from 'cesium';
import { loadBundledJson } from '../../data/bundledJson.js';
import { getLocale } from '../../i18n/index.js';
import { viewWindow } from '../../maps/h3Cells.js';

/**
 * Personal fork: the Rivers layer's names (src/data/earthEngineLayers.js,
 * `names: 'natural-earth-rivers'`). Earth Engine draws the lines; the
 * names are Natural Earth's 10m rivers and lake centerlines (public
 * domain), bundled as a small pack of names and label points
 * (src/data/local_data/natural_earth/river_names.json, built by
 * scripts/build-river-names-pack.mjs), and painted as world-overlay labels
 * (never Cesium labels: src/noCesiumLabels.test.mjs).
 *
 * Level of detail: thinning by Natural Earth's scalerank (0 to 12, the
 * largest rivers lowest) by camera height, from the largest names at orbit
 * to all of them at regional scale; below NAMES_MIN_HEIGHT_M the pack's
 * label points (about 1 km, from 1:10m lines) are too coarse for the
 * reaches Earth Engine draws there, and the names go. Within a band only
 * the labels in the view window are published (the H3 window rule; for a
 * planet-wide window, the side of the Earth the camera sees), at most
 * MAX_NAME_LABELS, larger rivers first, then nearer the middle of the
 * view; the overlay's collision solver drops the ones that overlap.
 */

export const RIVER_NAMES_SOURCE = 'ee-rivers-names';
export const RIVER_NAMES_PACK_URL = new URL(
  '../../data/local_data/natural_earth/river_names.json',
  import.meta.url,
);
/** Below this camera height no names are drawn. */
export const NAMES_MIN_HEIGHT_M = 150_000;
/** At or above each height, names up to that scalerank. */
export const NAME_BANDS = Object.freeze([
  Object.freeze({ minHeightM: 8_000_000, maxRank: 2 }),
  Object.freeze({ minHeightM: 4_000_000, maxRank: 4 }),
  Object.freeze({ minHeightM: 2_000_000, maxRank: 5 }),
  Object.freeze({ minHeightM: 1_000_000, maxRank: 7 }),
  Object.freeze({ minHeightM: 400_000, maxRank: 9 }),
  Object.freeze({ minHeightM: NAMES_MIN_HEIGHT_M, maxRank: 12 }),
]);
/** The most labels published at once. */
export const MAX_NAME_LABELS = 160;
/** The label colour per ink (the rivers' own blues). */
export const NAME_COLORS = Object.freeze({
  light: '#9fd8ff',
  dark: '#08519c',
});

/** The largest scalerank shown at a camera height, or null for none. */
export function maxRankForHeight(heightM) {
  const height = Number(heightM);
  if (!Number.isFinite(height)) return NAME_BANDS[0].maxRank;
  return NAME_BANDS.find((band) => height >= band.minHeightM)?.maxRank ?? null;
}

/** A river's name in a language (the pack's es and ru), else its English one. */
export function riverNameText(feature, locale = 'en') {
  const language = String(locale || 'en')
    .slice(0, 2)
    .toLowerCase();
  return (language !== 'en' && feature?.[language]) || feature?.name || '';
}

function inWindow(window, lat, lon) {
  if (!window) return true;
  if (lat < window.south || lat > window.north) return false;
  return window.west <= window.east
    ? lon >= window.west && lon <= window.east
    : lon >= window.west || lon <= window.east;
}

/**
 * The names to label for a view: features up to the height's scalerank,
 * their points in the view window, larger rivers first, at most `limit`.
 * @param {Array<{name: string, rank: number, at: number[][]}>} features
 * @param {{lat: number, lon: number, height: number}} view
 * @returns {Array<{id: string, feature: object, lon: number, lat: number}>}
 */
export function pickRiverNames(
  features,
  view,
  { limit = MAX_NAME_LABELS } = {},
) {
  const maxRank = maxRankForHeight(view?.height);
  if (maxRank === null) return [];
  const window = viewWindow(view.lat, view.lon, view.height);
  // A planet-wide window: only the side of the Earth the camera sees (the
  // horizon's central angle, plus 10°).
  const reach = window
    ? Infinity
    : Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + Math.max(0, view.height))) +
      (10 * Math.PI) / 180;
  const picked = [];
  (features || []).forEach((feature, index) => {
    if (!(Number(feature?.rank) <= maxRank)) return;
    (feature.at || []).forEach(([lon, lat], point) => {
      if (!inWindow(window, lat, lon)) return;
      const angle = centralAngle(view.lat, view.lon, lat, lon);
      if (angle <= reach)
        picked.push({ id: `${index}:${point}`, feature, lon, lat, angle });
    });
  });
  // Larger rivers first, then nearer the middle of the view.
  return picked
    .sort((a, b) => a.feature.rank - b.feature.rank || a.angle - b.angle)
    .slice(0, Math.max(0, limit))
    .map(({ angle, ...entry }) => entry);
}

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;
/** The angle (radians) between two points seen from the Earth's centre. */
function centralAngle(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

let packPromise = null;
/** The pack's features, loaded once on first use. */
export function loadRiverNames(load = loadBundledJson) {
  packPromise ||= load(RIVER_NAMES_PACK_URL)
    .then((pack) => (Array.isArray(pack?.features) ? pack.features : []))
    .catch((error) => {
      packPromise = null;
      throw error;
    });
  return packPromise;
}

/**
 * The names companion the Rivers layer drives: enable on, update on every
 * settled view or ink, disable off.
 * @param {{overlayHost?: object|null, cesium?: object,
 *   load?: () => Promise<Array<object>>, locale?: () => string}} [options]
 */
export function createRiverNames({
  overlayHost = null,
  cesium = Cesium,
  load = () => loadRiverNames(),
  locale = getLocale,
} = {}) {
  let features = null;
  let enabled = false;
  let last = null;
  let count = 0;

  function entries(view, ink) {
    const accent = NAME_COLORS[ink] || NAME_COLORS.light;
    const language = locale();
    return pickRiverNames(features, view).map(({ id, feature, lon, lat }) => ({
      id,
      variant: 'label',
      position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
      title: riverNameText(feature, language),
      details: [],
      accent,
      // Larger rivers win the overlay's collisions.
      priority: 20 - Number(feature.rank),
      collisionGroup: 'river-name',
      interactive: false,
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 2,
      placement: 'above',
    }));
  }

  function draw() {
    if (!enabled || !features || !last) return;
    const next = entries(last.view, last.ink);
    count = next.length;
    try {
      overlayHost?.setEntries(RIVER_NAMES_SOURCE, next, { moving: false });
    } catch (error) {
      console.warn('[Rivers] names not drawn:', error?.message);
    }
  }

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      overlayHost?.setVisible(RIVER_NAMES_SOURCE, true);
      if (!features)
        load()
          .then((loaded) => {
            features = loaded;
            draw();
          })
          .catch((error) => {
            console.warn('[Rivers] names not loaded:', error?.message);
          });
    },
    /** A settled view ({lat, lon, height}) and the ink the lines are drawn in. */
    update(view, ink = 'light') {
      last = { view, ink };
      draw();
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      last = null;
      count = 0;
      overlayHost?.clearSource(RIVER_NAMES_SOURCE);
      overlayHost?.setVisible(RIVER_NAMES_SOURCE, false);
    },
    /** How many names are published. */
    count: () => count,
  };
}
