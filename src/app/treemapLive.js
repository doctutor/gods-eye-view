/**
 * Personal fork: the TREEMAP window's page-local source for the live layers
 * (docs/TREEMAP-PLAN.md, "Sources"): the aircraft and vessels already in the
 * browser, cut aircraft by class > type and vessels by family > type, in the
 * same node shape as the service. Each read takes the layer's records as they
 * are now (the layer's own `treemapRecords()`); nothing is kept between reads.
 * A layer that is off answers its variable as unavailable, with the reason.
 */
import { msg } from '../i18n/index.js';
import {
  createRecordSource,
  createServiceSource,
} from '../data/treemapSources.js';
import {
  adminGroupings,
  adminPrepare,
  createAdminNames,
  createPointLabeller,
} from './treemapLabels.js';
import { AIRCRAFT_CLASS_LABELS } from '../data/aircraftClass.js';
import { normalizeVesselType } from '../data/vesselLabels.js';

/** The live layers' ids in the data manager. */
export const LIVE_LAYER_IDS = Object.freeze({
  aircraft: 'flights',
  vessels: 'ais-live-vessels',
});

const TYPE_UNKNOWN = msg('Type not known');
const CLASS_UNKNOWN = msg('Class not known');
const FAMILY_UNKNOWN = msg('Not reported');
const LAYER_OFF = msg('Turn the layer on to count it');
const LIVE_NOTE = msg('Live: what the layer holds now');

/** A small box about a point, for the globe outline of one contact. */
const pointBox = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon)
    ? [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05]
    : null;

/** An aircraft record's class: {key, label}. */
export function aircraftClassOf(record) {
  const key = record?.klass || 'unknown';
  return { key, label: AIRCRAFT_CLASS_LABELS[key] || CLASS_UNKNOWN };
}

/** An aircraft record's type: its ICAO type code, named when known. */
export function aircraftTypeOf(record) {
  const code = String(record?.typeCode || '').trim();
  if (!code) return { key: 'unknown', label: TYPE_UNKNOWN };
  const name = String(record?.typeName || '').trim();
  return { key: code, label: name ? `${code} · ${name}` : code };
}

/** A vessel's family: the AIS type's family token (CARGO, TANKER, FISHING…). */
export function vesselFamilyOf(record) {
  const family = normalizeVesselType(record?.type).toUpperCase();
  if (!family) return { key: 'unknown', label: FAMILY_UNKNOWN };
  // A free-text type names its own family by its first word ("Cargo ship").
  const key = /^\d/.test(String(record?.type || '').trim())
    ? family
    : family.split(/[\s,/]+/)[0] || family;
  return { key, label: key };
}

/** A vessel's type: the AIS code or text as reported. */
export function vesselTypeOf(record) {
  const text = String(record?.type || '').trim();
  if (!text) return { key: 'unknown', label: TYPE_UNKNOWN };
  const family = normalizeVesselType(text);
  return {
    key: text,
    label: /^\d{1,2}$/.test(text) ? `${family} ${text}` : text,
  };
}

/**
 * @param {{layers: () => Map<string, {module?: object, enabled?: boolean}>|
 *   null, service?: object, labeller?: object, names?: object}} options
 *   `layers()`: the data manager's layer map, read each time; `service`
 *   labels the points (POST /api/treemap/label) and names the regions
 */
export function createLiveTreemapSource({
  layers,
  service = createServiceSource(),
  labeller = createPointLabeller({ service }),
  names = createAdminNames({ service }),
}) {
  // Aircraft and vessels share the labeller: their ids are told apart.
  const aircraftId = (record) => `a:${record.icao24}`;
  const vesselId = (record) => `v:${record.mmsi}`;
  const pointOf = (record) => ({ lon: record.lon, lat: record.lat });
  const moduleOf = (id) => {
    const entry = layers?.()?.get?.(id);
    const module = entry?.module ?? entry ?? null;
    return typeof module?.treemapRecords === 'function' ? module : null;
  };
  const isOn = (id) => {
    const entry = layers?.()?.get?.(id);
    if (!entry) return false;
    if (typeof entry.enabled === 'boolean') return entry.enabled;
    if (typeof entry.module?.enabled === 'boolean') return entry.module.enabled;
    return true;
  };
  const read = (id) => {
    try {
      return moduleOf(id)?.treemapRecords() || [];
    } catch (error) {
      console.warn('[Treemap] live records failed:', error);
      return [];
    }
  };
  const live = (id) => ({
    available: () => Boolean(moduleOf(id)) && isOn(id),
    why: () => (Boolean(moduleOf(id)) && isOn(id) ? '' : LAYER_OFF),
  });
  return createRecordSource({
    id: 'live',
    groupingInfo: {
      'admin.continent': { kind: 'hierarchy' },
      'admin.country': { kind: 'hierarchy', parent: 'admin.continent' },
      'admin.region': { kind: 'hierarchy', parent: 'admin.country' },
      'aircraft.class': { kind: 'hierarchy' },
      'aircraft.type': { kind: 'hierarchy', parent: 'aircraft.class' },
      'vessel.family': { kind: 'hierarchy' },
      'vessel.type': { kind: 'hierarchy', parent: 'vessel.family' },
    },
    variables: [
      {
        id: 'count/aircraft',
        mode: 'additive',
        ...live(LIVE_LAYER_IDS.aircraft),
        records: () => read(LIVE_LAYER_IDS.aircraft),
        groupings: {
          ...adminGroupings({ labeller, names, idOf: aircraftId }),
          'aircraft.class': aircraftClassOf,
          'aircraft.type': aircraftTypeOf,
        },
        prepare: adminPrepare({ labeller, names, idOf: aircraftId, pointOf }),
        box: (record) => pointBox(record.lat, record.lon),
        note: LIVE_NOTE,
        attribution: 'OpenSky Network / ADS-B · adsbdb',
      },
      {
        id: 'count/vessels',
        mode: 'additive',
        ...live(LIVE_LAYER_IDS.vessels),
        records: () => read(LIVE_LAYER_IDS.vessels),
        groupings: {
          ...adminGroupings({ labeller, names, idOf: vesselId }),
          'vessel.family': vesselFamilyOf,
          'vessel.type': vesselTypeOf,
        },
        prepare: adminPrepare({ labeller, names, idOf: vesselId, pointOf }),
        box: (record) => pointBox(record.lat, record.lon),
        note: LIVE_NOTE,
        attribution: 'AISStream',
      },
    ],
  });
}
