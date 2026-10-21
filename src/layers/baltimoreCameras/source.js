/**
 * Baltimore City camera LOCATIONS from the city's public ArcGIS services.
 * Locations only: none of these publish imagery. Each set is fetched once per
 * session as GeoJSON (every layer is well under the services' 2,000-record
 * page) and normalized to plain records the layer renders.
 *
 * Personal-fork layer; not part of upstream God's Eye View.
 */

import { msg } from '../../i18n/marker.js';
const ATVES_ROOT =
  'https://services3.arcgis.com/ZTvQ9NuONePFYofE/arcgis/rest/services';

/** Enforcement camera kinds, keyed by the service's CamType. */
export const ENFORCEMENT_KINDS = Object.freeze({
  'Red Light Camera': Object.freeze({
    label: msg('Red-light camera'),
    color: '#ff4d4d',
  }),
  'Speed Camera Fixed': Object.freeze({
    label: msg('Speed camera (fixed)'),
    color: '#ff9f1a',
  }),
  'Speed Camera Portable': Object.freeze({
    label: msg('Speed camera (portable)'),
    color: '#ffd84d',
  }),
  'Commercial Vehicles Height Camera': Object.freeze({
    label: msg('Truck height camera'),
    color: '#c77dff',
  }),
});

export const CITIWATCH_KIND = Object.freeze({
  label: msg('CitiWatch police camera'),
  color: '#4dd2ff',
});

/** An ArcGIS point layer of a set, with the words that name it when it fails. */
const layer = (url, label) => Object.freeze({ url, label });

const ENFORCEMENT_LAYERS = Object.freeze([
  layer(
    `${ATVES_ROOT}/Baltimore_ATVES_Red_Light_Camera/FeatureServer/0`,
    msg('red-light cameras'),
  ),
  layer(
    `${ATVES_ROOT}/ATVES_Speed_Cameras_Fixed/FeatureServer/3`,
    msg('fixed speed cameras'),
  ),
  layer(
    `${ATVES_ROOT}/ATVES_Speed_Cameras_Portable/FeatureServer/1`,
    msg('portable speed cameras'),
  ),
  layer(
    `${ATVES_ROOT}/Baltimore_ATVES_Commercial_Cameras/FeatureServer/2`,
    msg('truck height cameras'),
  ),
]);
const CITIWATCH_LAYERS = Object.freeze([
  layer(
    'https://baltegis.baltimorecity.gov/mapping/rest/services/CityView/CitiWatchCamera/FeatureServer/0',
    msg('CitiWatch cameras'),
  ),
]);
const urlsOf = (layers) => Object.freeze(layers.map((entry) => entry.url));

/**
 * The two camera sets, each one or more ArcGIS point layers (`layers`;
 * `urls` the same layers' URLs).
 */
export const BALTIMORE_CAMERA_SETS = Object.freeze({
  enforcement: Object.freeze({
    id: 'baltimore-enforcement-cameras',
    name: 'Enforcement Cameras (Baltimore)',
    icon: '📸',
    sourceLabel: 'Open Baltimore · ATVES locations',
    credit:
      'Enforcement camera locations: <a href="https://data.baltimorecity.gov" target="_blank" rel="noopener">Open Baltimore</a> (Baltimore City ATVES)',
    layers: ENFORCEMENT_LAYERS,
    urls: urlsOf(ENFORCEMENT_LAYERS),
  }),
  citiwatch: Object.freeze({
    id: 'baltimore-citiwatch-cameras',
    name: 'CitiWatch Cameras (Baltimore)',
    icon: '👁',
    sourceLabel: 'Baltimore City · CitiWatch locations',
    credit:
      'CitiWatch camera locations: <a href="https://baltegis.baltimorecity.gov" target="_blank" rel="noopener">Baltimore City GIS</a> (CC BY 3.0)',
    layers: CITIWATCH_LAYERS,
    urls: urlsOf(CITIWATCH_LAYERS),
  }),
});

/** Generous Baltimore metro box; anything outside is a bad coordinate. */
function isBaltimoreCoordinate(lat, lon) {
  return lat >= 39.1 && lat <= 39.5 && lon >= -76.85 && lon <= -76.4;
}

function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize one GeoJSON FeatureCollection into camera records.
 * @param {object} collection - ArcGIS `f=geojson` query response.
 * @param {'enforcement'|'citiwatch'} setKey
 * @returns {Array<{id: string, lat: number, lon: number, title: string,
 *   kind: string, color: string, details: Array<string>}>}
 */
export function parseCameraCollection(collection, setKey) {
  const features = Array.isArray(collection?.features)
    ? collection.features
    : [];
  const records = [];
  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates))
      continue;
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!isBaltimoreCoordinate(lat, lon)) continue;
    const props = feature.properties || {};

    if (setKey === 'citiwatch') {
      const number = clean(props.CAM_NUMBER);
      if (!number) continue;
      records.push({
        id: `citiwatch-${number}`,
        lat,
        lon,
        // i18n-ignore: brand name and camera number
        title: clean(props.CAM_LOCATION) || `CitiWatch ${number}`,
        kind: CITIWATCH_KIND.label,
        color: CITIWATCH_KIND.color,
        details: [
          `${CITIWATCH_KIND.label} #${number}`,
          'Location only · no public video',
        ],
      });
      continue;
    }

    const kind = ENFORCEMENT_KINDS[clean(props.CamType)];
    const gisId = clean(props.GIS_ID);
    if (!kind || !gisId) continue;
    const school = clean(props.SchlLocation);
    records.push({
      id: `atves-${gisId}`,
      lat,
      lon,
      title: clean(props.Location) || kind.label,
      kind: kind.label,
      color: kind.color,
      details: [
        kind.label,
        ...(school ? [`School zone: ${school}`] : []),
        'Location only · no public imagery',
      ],
    });
  }
  return records;
}

/** A failed layer request: `retry` when another try may succeed. */
export class CameraServiceError extends Error {
  constructor(message, { retry = false, status = 0 } = {}) {
    super(message);
    this.name = 'CameraServiceError';
    this.retry = retry;
    this.status = status;
  }
}

/** The wait before the one retry of a layer request. */
export const RETRY_DELAY_MS = 1500;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** One ArcGIS layer's records, one try. */
async function fetchLayerOnce(url, setKey, { fetchImpl, signal }) {
  const query = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
  });
  let response;
  try {
    response = await fetchImpl(`${url}/query?${query}`, {
      signal,
      headers: { Accept: 'application/geo+json,application/json' },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    // The network: worth one more try.
    throw new CameraServiceError(
      error?.message || 'Baltimore camera service did not answer',
      { retry: true },
    );
  }
  if (!response.ok)
    throw new CameraServiceError(
      `Baltimore camera service returned ${response.status}`,
      {
        status: response.status,
        retry: response.status >= 500 || response.status === 429,
      },
    );
  const body = await response.json();
  // ArcGIS answers its own errors with a 200 and an error body.
  if (body?.error)
    throw new CameraServiceError(
      body.error.message || 'Baltimore camera service error',
      { retry: true },
    );
  return parseCameraCollection(body, setKey);
}

/**
 * One ArcGIS layer's records, tried again once after RETRY_DELAY_MS when
 * the failure may pass: no answer, a 5xx or 429, or an ArcGIS error body.
 */
export async function fetchCameraLayer(
  url,
  setKey,
  { fetchImpl, signal, retryDelayMs = RETRY_DELAY_MS } = {},
) {
  try {
    return await fetchLayerOnce(url, setKey, { fetchImpl, signal });
  } catch (error) {
    if (!(error instanceof CameraServiceError) || !error.retry) throw error;
    await sleep(retryDelayMs, signal);
    return fetchLayerOnce(url, setKey, { fetchImpl, signal });
  }
}

/**
 * Fetch every ArcGIS layer in a set, each on its own (fetchCameraLayer:
 * one retry), and merge the records, de-duplicated by id. The set loads
 * with the layers that answered and names the ones that did not
 * (index.js cameraSetNote); it fails only when no layer gave a record.
 * @param {'enforcement'|'citiwatch'} setKey
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal,
 *   retryDelayMs?: number}} [options]
 * @returns {Promise<{records: Array<object>, failed: string[],
 *   loaded: number, total: number}>} `failed`: the missing layers' labels
 */
export async function fetchCameraSet(
  setKey,
  {
    fetchImpl = (...args) => fetch(...args),
    signal,
    retryDelayMs = RETRY_DELAY_MS,
  } = {},
) {
  const set = BALTIMORE_CAMERA_SETS[setKey];
  if (!set) throw new TypeError(`Unknown Baltimore camera set: ${setKey}`);
  const settled = await Promise.allSettled(
    set.layers.map((entry) =>
      fetchCameraLayer(entry.url, setKey, { fetchImpl, signal, retryDelayMs }),
    ),
  );
  if (signal?.aborted) throw signal.reason;
  const unique = new Map();
  const failed = [];
  let firstError = null;
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled')
      for (const record of result.value) unique.set(record.id, record);
    else {
      failed.push(set.layers[i].label);
      firstError ||= result.reason;
    }
  });
  if (failed.length && !unique.size) throw firstError;
  return {
    records: [...unique.values()],
    failed,
    loaded: set.layers.length - failed.length,
    total: set.layers.length,
  };
}
