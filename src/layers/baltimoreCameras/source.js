/**
 * Baltimore City camera LOCATIONS from the city's public ArcGIS services.
 * Locations only: none of these publish imagery. Each set is fetched once per
 * session as GeoJSON (every layer is well under the services' 2,000-record
 * page) and normalized to plain records the layer renders.
 *
 * Personal-fork layer; not part of upstream God's Eye View.
 */

const ATVES_ROOT =
  'https://services3.arcgis.com/ZTvQ9NuONePFYofE/arcgis/rest/services';

/** Enforcement camera kinds, keyed by the service's CamType. */
export const ENFORCEMENT_KINDS = Object.freeze({
  'Red Light Camera': Object.freeze({
    // i18n-ignore: personal fork, English-only UI
    label: 'Red-light camera',
    color: '#ff4d4d',
  }),
  'Speed Camera Fixed': Object.freeze({
    // i18n-ignore: personal fork, English-only UI
    label: 'Speed camera (fixed)',
    color: '#ff9f1a',
  }),
  'Speed Camera Portable': Object.freeze({
    // i18n-ignore: personal fork, English-only UI
    label: 'Speed camera (portable)',
    color: '#ffd84d',
  }),
  'Commercial Vehicles Height Camera': Object.freeze({
    // i18n-ignore: personal fork, English-only UI
    label: 'Truck height camera',
    color: '#c77dff',
  }),
});

export const CITIWATCH_KIND = Object.freeze({
  // i18n-ignore: personal fork, English-only UI
  label: 'CitiWatch police camera',
  color: '#4dd2ff',
});

/** The two camera sets, each one or more ArcGIS point layers. */
export const BALTIMORE_CAMERA_SETS = Object.freeze({
  enforcement: Object.freeze({
    id: 'baltimore-enforcement-cameras',
    name: 'Enforcement Cameras (Baltimore)',
    icon: '📸',
    sourceLabel: 'Open Baltimore · ATVES locations',
    credit:
      'Enforcement camera locations: <a href="https://data.baltimorecity.gov" target="_blank" rel="noopener">Open Baltimore</a> (Baltimore City ATVES)',
    urls: Object.freeze([
      `${ATVES_ROOT}/Baltimore_ATVES_Red_Light_Camera/FeatureServer/0`,
      `${ATVES_ROOT}/ATVES_Speed_Cameras_Fixed/FeatureServer/3`,
      `${ATVES_ROOT}/ATVES_Speed_Cameras_Portable/FeatureServer/1`,
      `${ATVES_ROOT}/Baltimore_ATVES_Commercial_Cameras/FeatureServer/2`,
    ]),
  }),
  citiwatch: Object.freeze({
    id: 'baltimore-citiwatch-cameras',
    name: 'CitiWatch Cameras (Baltimore)',
    icon: '👁',
    sourceLabel: 'Baltimore City · CitiWatch locations',
    credit:
      'CitiWatch camera locations: <a href="https://baltegis.baltimorecity.gov" target="_blank" rel="noopener">Baltimore City GIS</a> (CC BY 3.0)',
    urls: Object.freeze([
      'https://baltegis.baltimorecity.gov/mapping/rest/services/CityView/CitiWatchCamera/FeatureServer/0',
    ]),
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
        // i18n-ignore: personal fork, English-only UI
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

/**
 * Fetch every ArcGIS layer in a set and return the merged, de-duplicated
 * records. One failing layer fails the set, so a partial map is never shown
 * as complete.
 * @param {'enforcement'|'citiwatch'} setKey
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 */
export async function fetchCameraSet(
  setKey,
  { fetchImpl = (...args) => fetch(...args), signal } = {},
) {
  const set = BALTIMORE_CAMERA_SETS[setKey];
  if (!set) throw new TypeError(`Unknown Baltimore camera set: ${setKey}`);
  const pages = await Promise.all(
    set.urls.map(async (url) => {
      const query = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        outSR: '4326',
        f: 'geojson',
      });
      const response = await fetchImpl(`${url}/query?${query}`, {
        signal,
        headers: { Accept: 'application/geo+json,application/json' },
      });
      if (!response.ok)
        throw new Error(`Baltimore camera service returned ${response.status}`);
      const body = await response.json();
      if (body?.error)
        throw new Error(body.error.message || 'Baltimore camera service error');
      return parseCameraCollection(body, setKey);
    }),
  );
  const unique = new Map();
  for (const record of pages.flat()) unique.set(record.id, record);
  return [...unique.values()];
}
