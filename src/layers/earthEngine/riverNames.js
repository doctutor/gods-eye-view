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
/** The label colour per ink: the rivers' own inks (RIVER_INKS), opaque. */
export const NAME_COLORS = Object.freeze({
  light: '#ffffff',
  dark: '#1a1a1a',
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

/** Personal fork: OSM's names for the large rivers once zoomed in. */
export const OSM_NAMES_SOURCE = 'ee-rivers-osm-names';
export const OSM_NAMES_ENDPOINT = '/api/rivers/names/labels';
/** OSM's names show below the Natural Earth names' floor… */
export const OSM_NAMES_MAX_HEIGHT_M = NAMES_MIN_HEIGHT_M;
/** …the nearest this many to the middle of the view. */
export const OSM_NAME_LIMIT = 12;

/** An OSM label's text: the English name for English, else the local one. */
export function osmNameText(label, locale = 'en') {
  const english =
    String(locale || 'en')
      .slice(0, 2)
      .toLowerCase() === 'en';
  return (english && label?.nameEn) || label?.name || '';
}

/**
 * The large named rivers (Strahler 5 and up) from the river names sidecar
 * (/api/rivers/names/labels, `npm run rivers:names`) below
 * OSM_NAMES_MAX_HEIGHT_M, where Natural Earth's names stop: the view
 * window's labels, the nearest OSM_NAME_LIMIT to its middle. A missing
 * sidecar (503) draws nothing and is not asked again this session.
 */
export function createOsmRiverNames({
  overlayHost = null,
  cesium = Cesium,
  fetchImpl = (...args) => globalThis.fetch(...args),
  locale = getLocale,
} = {}) {
  let enabled = false;
  let unavailable = false;
  let held = null; // {key, labels}
  let request = 0;
  let count = 0;

  function clear() {
    count = 0;
    overlayHost?.clearSource?.(OSM_NAMES_SOURCE);
  }

  function publish(labels, view, ink) {
    const accent = NAME_COLORS[ink] || NAME_COLORS.light;
    const language = locale();
    const nearest = labels
      .map((label) => ({
        label,
        angle: centralAngle(view.lat, view.lon, label.at[1], label.at[0]),
      }))
      .sort((a, b) => a.angle - b.angle)
      .slice(0, OSM_NAME_LIMIT);
    count = nearest.length;
    overlayHost?.setEntries?.(
      OSM_NAMES_SOURCE,
      nearest.map(({ label }, i) => ({
        id: `${label.at[0]},${label.at[1]}`,
        variant: 'label',
        position: cesium.Cartesian3.fromDegrees(label.at[0], label.at[1], 0),
        title: osmNameText(label, language),
        details: [],
        accent,
        priority: label.strahler * 10 - i / 100,
        collisionGroup: 'river-name',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 2,
        placement: 'above',
      })),
      { moving: false },
    );
  }

  return {
    enable() {
      enabled = true;
      overlayHost?.setVisible?.(OSM_NAMES_SOURCE, true);
    },
    update(view, ink = 'light') {
      if (!enabled || unavailable) return;
      if (!(view?.height < OSM_NAMES_MAX_HEIGHT_M)) {
        if (count) clear();
        return;
      }
      const window = viewWindow(view.lat, view.lon, view.height);
      if (!window || window.west > window.east) return clear();
      const round = (v) => Math.round(v * 100) / 100;
      const box = {
        west: round(window.west),
        south: round(window.south),
        east: round(window.east),
        north: round(window.north),
      };
      const key = JSON.stringify(box);
      if (held?.key === key) return publish(held.labels, view, ink);
      const mine = ++request;
      const params = new URLSearchParams(
        Object.entries(box).map(([k, v]) => [k, String(v)]),
      );
      fetchImpl(`${OSM_NAMES_ENDPOINT}?${params}`, {
        credentials: 'same-origin',
      })
        .then(async (response) => {
          if (response.status === 503) {
            unavailable = true;
            return null;
          }
          if (!response.ok) return null;
          return response.json();
        })
        .then((body) => {
          if (!enabled || mine !== request || !body) return;
          const labels = (Array.isArray(body.labels) ? body.labels : []).filter(
            (label) =>
              Array.isArray(label?.at) &&
              label.at.every(Number.isFinite) &&
              typeof label.name === 'string',
          );
          held = { key, labels };
          publish(labels, view, ink);
        })
        .catch(() => {});
    },
    disable() {
      enabled = false;
      request += 1;
      held = null;
      clear();
      overlayHost?.setVisible?.(OSM_NAMES_SOURCE, false);
    },
    count: () => count,
  };
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
  fetchImpl,
} = {}) {
  // Personal fork: OSM's names close in, beside Natural Earth's from afar.
  const osm = createOsmRiverNames({
    overlayHost,
    cesium,
    locale,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
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
      osm.enable();
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
      osm.update(view, ink);
      draw();
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      osm.disable();
      last = null;
      count = 0;
      overlayHost?.clearSource(RIVER_NAMES_SOURCE);
      overlayHost?.setVisible(RIVER_NAMES_SOURCE, false);
    },
    /** How many names are published (Natural Earth's; OSM's: osmCount). */
    count: () => count,
    osmCount: () => osm.count(),
  };
}
