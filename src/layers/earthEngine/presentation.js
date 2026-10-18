import { msg, t, tn, translateKnown } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { inkColor } from '../../data/earthEngineLayers.js';

/**
 * Personal fork: what an Earth Engine overlay's row in the DATA LAYERS panel
 * says: its legend (in the ink it is drawn with), an opacity slider, for a
 * features layer the level and ink chips, and a status line (the server's
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
  level0: msg('Countries'),
  level1: msg('First-level units'),
  level2: msg('Second-level units'),
});

/** The level chips: AUTO (the height rule), then each variant. */
export const LEVEL_CHIPS = Object.freeze([
  Object.freeze({
    key: 'auto',
    label: msg('AUTO'),
    title: msg(
      'The level follows the camera: states and provinces from far out, districts below 800 km',
    ),
  }),
  Object.freeze({
    key: 'level0',
    label: msg('COUNTRIES'),
    title: msg('Country boundaries everywhere (LSIB 2017)'),
  }),
  Object.freeze({
    key: 'level1',
    label: msg('REGIONS'),
    title: msg('States and provinces everywhere'),
  }),
  Object.freeze({
    key: 'level2',
    label: msg('DISTRICTS'),
    title: msg('Districts everywhere; from far out the tiles arrive slowly'),
  }),
]);

/** The ink chips: AUTO follows the basemap. */
export const INK_CHIPS = Object.freeze([
  Object.freeze({
    key: 'auto',
    label: msg('AUTO INK'),
    title: msg(
      'The ink follows the basemap: light lines on dark maps, dark lines on light maps',
    ),
  }),
  Object.freeze({
    key: 'light',
    label: msg('LIGHT INK'),
    title: msg('Light ink: white lines'),
  }),
  Object.freeze({
    key: 'dark',
    label: msg('DARK INK'),
    title: msg('Dark ink: near-black lines'),
  }),
]);

/** Above this, forced districts are a far view: the row says the tiles are slow. */
export const SLOW_DISTRICTS_ABOVE_M = 800_000;

/** A legend label in the page language (numbers and years pass as they are). */
export function legendLabel(label) {
  const key = LEGEND_WORDS[label];
  if (key) return t(key);
  return compassLetter(label) ?? translateKnown(String(label));
}

/** `#rrggbb` of an ink's line colour (RRGGBB[AA] in the record). */
export function inkSwatch(record, ink) {
  return `#${inkColor(record, ink).slice(0, 6)}`;
}

/**
 * The status line.
 * @param {{catalog?: object|null, layer?: object|null, variant?: string,
 *   loading?: boolean, failure?: string|null, hostless?: boolean,
 *   ceilingM?: number|null, slowDistricts?: boolean}} state - `hostless`:
 *   the map stack can drape no imagery; `ceilingM`: the camera is above the
 *   layer's ceiling; `slowDistricts`: districts are forced from far out.
 */
export function statusText({
  catalog = null,
  layer = null,
  variant = '',
  loading = false,
  failure = null,
  hostless = false,
  ceilingM = null,
  slowDistricts = false,
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
  if (Number.isFinite(ceilingM))
    parts.push(
      t('Zoom in below {height} km to draw it', {
        height: Math.round(ceilingM / 1000),
      }),
    );
  else if (VARIANT_LABELS[variant]) parts.push(t(VARIANT_LABELS[variant]));
  if (slowDistricts)
    parts.push(t('Districts from this height: the tiles arrive slowly'));
  if (Number.isFinite(layer?.tilesToday))
    parts.push(
      tn(
        layer.tilesToday,
        '{count} tile today, this layer',
        '{count} tiles today, this layer',
      ),
    );
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
 *   failure?: string|null, hostless?: boolean, ceilingM?: number|null,
 *   level?: string, onLevel?: (key: string) => void, ink?: string,
 *   onInk?: (key: string) => void, inkDrawn?: string,
 *   slowDistricts?: boolean}} input - `level` and `ink` are the settings
 *   ('auto' or a key); `inkDrawn` the ink in use.
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
  ceilingM = null,
  level = 'auto',
  onLevel = () => {},
  ink = 'auto',
  onInk = () => {},
  inkDrawn = 'default',
  slowDistricts = false,
}) {
  const layer = catalog?.layers?.get?.(record.id) || null;
  const variantKeys = new Set((record.variants || []).map((v) => v.key));
  const chips = [];
  // Level chips only for a layer with administrative levels; a layer whose
  // variants are far/near sources has nothing to choose.
  const hasLevels = LEVEL_CHIPS.some(
    (chip) => chip.key !== 'auto' && variantKeys.has(chip.key),
  );
  if (hasLevels)
    for (const chip of LEVEL_CHIPS) {
      if (chip.key !== 'auto' && !variantKeys.has(chip.key)) continue;
      chips.push({
        id: `level-${chip.key}`,
        label: t(chip.label),
        title: t(chip.title),
        active: level === chip.key,
        onClick: () => onLevel(chip.key),
      });
    }
  if (record.inks)
    for (const chip of INK_CHIPS)
      chips.push({
        id: `ink-${chip.key}`,
        label: t(chip.label),
        title: t(chip.title),
        active: ink === chip.key,
        onClick: () => onInk(chip.key),
      });
  const legend = layer?.legend?.length ? layer.legend : record.legend || [];
  return {
    chips,
    legend: legend.map((entry) => ({
      label: legendLabel(entry.label),
      // A features layer's swatch is the ink it is drawn in.
      color:
        record.inks && inkDrawn !== 'default'
          ? inkSwatch(record, inkDrawn)
          : entry.color,
    })),
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
      ceilingM,
      slowDistricts,
    }),
    infoTitle: layer?.attribution || '',
  };
}
