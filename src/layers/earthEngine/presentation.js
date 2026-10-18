import { msg, t, translateKnown } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';

/**
 * Personal fork: what an Earth Engine overlay's row in the DATA LAYERS panel
 * says: its legend, an opacity slider, and a status line (the server's
 * instructions when no key is set, Earth Engine's own error text when a map
 * could not be made, the day's tiles otherwise).
 */

/** Legend words the data file uses (src/data/earthEngineLayers.js). */
export const LEGEND_WORDS = Object.freeze({
  Shade: msg('Shade'),
  Light: msg('Light'),
  Boundary: msg('Boundary'),
});

/** A compass point's letter in the page language, else null. */
function compassLetter(label) {
  switch (label) {
    case 'N':
      return t('N', { context: 'compass point' });
    case 'E':
      return t('E', { context: 'compass point' });
    case 'S':
      return t('S', { context: 'compass point' });
    case 'W':
      return t('W', { context: 'compass point' });
    default:
      return null;
  }
}

const VARIANT_LABELS = Object.freeze({
  level1: msg('First-level units'),
  level2: msg('Second-level units'),
});

/** A legend label in the page language (numbers and years pass as they are). */
export function legendLabel(label) {
  const key = LEGEND_WORDS[label];
  if (key) return t(key);
  return compassLetter(label) ?? translateKnown(String(label));
}

/**
 * The status line.
 * @param {{catalog?: object|null, layer?: object|null, variant?: string,
 *   loading?: boolean, failure?: string|null, hostless?: boolean}} state
 *   `hostless`: the map stack can drape no imagery.
 */
export function statusText({
  catalog = null,
  layer = null,
  variant = '',
  loading = false,
  failure = null,
  hostless = false,
}) {
  if (failure)
    return t('Earth Engine unavailable: {reason}', { reason: failure });
  // The words Recent Imagery and the weather layers use for this map.
  if (hostless && catalog?.configured && !layer?.error)
    return t(NO_IMAGERY_HOST);
  if (!catalog) return loading ? t('Asking Earth Engine…') : '';
  if (!catalog.configured)
    return t(
      'Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to draw the Earth Engine layers',
    );
  // Earth Engine's own words: the first run is the only validation there is.
  if (layer?.error) return t('Earth Engine: {error}', { error: layer.error });
  const parts = [];
  if (VARIANT_LABELS[variant]) parts.push(t(VARIANT_LABELS[variant]));
  if (catalog.tiles?.budget)
    parts.push(
      t('{used} of {budget} tiles today', {
        used: catalog.tiles.used,
        budget: catalog.tiles.budget,
      }),
    );
  return parts.join(' · ');
}

/**
 * The row's controls for the layer panel (src/ui/layerPanel.js).
 * @param {{record: object, catalog?: object|null, variant?: string,
 *   opacity: number, onOpacity: (value: number) => void, loading?: boolean,
 *   failure?: string|null, hostless?: boolean}} input
 */
export function rowControls({
  record,
  catalog = null,
  variant = '',
  opacity,
  onOpacity,
  loading = false,
  failure = null,
  hostless = false,
}) {
  const layer = catalog?.layers?.get?.(record.id) || null;
  return {
    legend: (layer?.legend?.length ? layer.legend : record.legend || []).map(
      (entry) => ({ label: legendLabel(entry.label), color: entry.color }),
    ),
    slider: {
      label: t('Opacity {value}%', { value: Math.round(opacity * 100) }),
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(opacity * 100),
      onInput: (value) => onOpacity(value / 100),
    },
    info: statusText({
      catalog,
      layer,
      variant,
      loading,
      failure,
      hostless,
    }),
    infoTitle: layer?.attribution || '',
  };
}
