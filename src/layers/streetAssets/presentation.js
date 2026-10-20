import { msg, t, tn } from '../../i18n/index.js';
import { ASSET_TYPES } from './assets.js';

/**
 * Personal fork: the Street assets row in the DATA LAYERS panel
 * (ANALYSIS): a chip per asset type (one drawn at a time), its legend
 * swatch, and a line saying what is drawn at this height (pins, counts per
 * hexagon, or how low to go) and the state of Overpass.
 */

export const ASSET_WORDS = Object.freeze({
  charging: Object.freeze({
    chip: msg('EV CHARGING'),
    title: msg('Electric vehicle charging stations (OpenStreetMap)'),
    overtureTitle: msg('Electric vehicle charging stations (Overture Maps)'),
  }),
  bike: Object.freeze({
    chip: msg('BIKE LANES'),
    title: msg('Cycleways and roads with a bike lane or track (OpenStreetMap)'),
  }),
  hydrant: Object.freeze({
    chip: msg('HYDRANTS'),
    title: msg('Fire hydrants (OpenStreetMap)'),
    overtureTitle: msg('Fire hydrants (Overture Maps)'),
  }),
  lamp: Object.freeze({
    chip: msg('STREET LIGHTS'),
    title: msg('Street lamps (OpenStreetMap)'),
    overtureTitle: msg('Street lamps (Overture Maps)'),
  }),
  signals: Object.freeze({
    chip: msg('SIGNALS'),
    title: msg('Traffic signals (OpenStreetMap)'),
    overtureTitle: msg('Traffic signals (Overture Maps)'),
  }),
});

/** How many of a type, in words. */
export function assetCountText(key, count) {
  switch (key) {
    case 'charging':
      return tn(count, '{count} charging station', '{count} charging stations');
    case 'bike':
      return tn(
        count,
        '{count} bike lane segment',
        '{count} bike lane segments',
      );
    case 'hydrant':
      return tn(count, '{count} fire hydrant', '{count} fire hydrants');
    case 'lamp':
      return tn(count, '{count} street light', '{count} street lights');
    case 'signals':
      return tn(count, '{count} traffic signal', '{count} traffic signals');
    default:
      return String(count);
  }
}

/**
 * The status line.
 * @param {{type: object, mode: string, state: string, count: number,
 *   saturated?: boolean, source?: string}} status - `mode` 'pins' |
 *   'counts' | 'none'; `state` 'idle' | 'loading' | 'ready' |
 *   'unconfigured' | 'limited' | 'failed'; `source` who answered:
 *   'overture', 'sparse' (OpenStreetMap, Overture having few here) or
 *   'osm'.
 */
export function statusText({
  type,
  mode,
  state,
  count = 0,
  saturated = false,
  source = 'osm',
}) {
  if (mode === 'none')
    return t('Zoom in below {height} km to draw them', {
      height: Math.round(type.countsBelowM / 1000),
    });
  if (state === 'unconfigured')
    return t('Street assets need OVERPASS_UPSTREAMS in .env');
  if (state === 'limited')
    return t('OpenStreetMap is busy; trying again shortly');
  if (state === 'failed') return t('Street assets unavailable');
  if (state === 'loading')
    return source === 'overture'
      ? type.overture?.source === 'infrastructure'
        ? t('Reading the Overture infrastructure…')
        : t('Reading the Overture places…')
      : t('Asking OpenStreetMap…');
  if (state !== 'ready') return '';
  const parts = [assetCountText(type.key, count)];
  if (saturated) parts.push(t('more than the view can show; zoom in for all'));
  parts.push(
    mode === 'counts'
      ? t('Counts per hexagon; pins below {height} km', {
          height:
            type.pinsBelowM >= 1000
              ? Math.round(type.pinsBelowM / 1000)
              : (type.pinsBelowM / 1000).toFixed(1),
        })
      : t('Pins'),
  );
  return parts.join(' · ');
}

/** Who answered, when it is not OpenStreetMap alone. */
function sourceWords(source) {
  if (source === 'overture') return [t('from Overture Maps')];
  if (source === 'sparse')
    return [t('from OpenStreetMap (Overture sparse here)')];
  return [];
}

/**
 * @param {{asset: string, onAsset: (key: string) => void, inkColor: string,
 *   status: object|null, enabled: boolean}} input
 */
export function rowControls({
  asset,
  onAsset,
  inkColor,
  status,
  enabled,
  overture = false,
}) {
  const type =
    ASSET_TYPES.find((entry) => entry.key === asset) || ASSET_TYPES[0];
  return {
    chips: ASSET_TYPES.map((entry) => ({
      id: `asset-${entry.key}`,
      label: t(ASSET_WORDS[entry.key].chip),
      title:
        overture && entry.key === asset && ASSET_WORDS[entry.key].overtureTitle
          ? t(ASSET_WORDS[entry.key].overtureTitle)
          : t(ASSET_WORDS[entry.key].title),
      active: asset === entry.key,
      onClick: () => onAsset(entry.key),
    })),
    legend: [
      {
        label: t(ASSET_WORDS[type.key].chip),
        color: type.color || inkColor,
      },
    ],
    info:
      enabled && status
        ? [
            statusText({ type, ...status }),
            ...(status.state === 'ready' ? sourceWords(status.source) : []),
          ].join(' · ')
        : '',
  };
}
