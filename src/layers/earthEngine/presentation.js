import { msg, t, tn, translateKnown } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import {
  POPULATION_MODES,
  inkColor,
  modeRecord,
} from '../../data/earthEngineLayers.js';

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
  // The Rivers modes' legends.
  'Large river': msg('Large river'),
  Stream: msg('Stream'),
  'Free-flowing': msg('Free-flowing'),
  'Good connectivity': msg('Good connectivity'),
  Impacted: msg('Impacted'),
  'Dams (fragmentation)': msg('Dams (fragmentation)'),
  'Flow regulation': msg('Flow regulation'),
  'Sediment trapping': msg('Sediment trapping'),
  'Water consumption': msg('Water consumption'),
  'Road density': msg('Road density'),
  'Urban areas': msg('Urban areas'),
  'No dominant pressure': msg('No dominant pressure'),
  // Surface water's legends.
  'Water lost': msg('Water lost'),
  'Little change': msg('Little change'),
  'Water gained': msg('Water gained'),
  '1 month a year': msg('1 month a year'),
  '6 months a year': msg('6 months a year'),
  'All year': msg('All year'),
  // Land cover's classes (ESA WorldCover).
  'Tree cover': msg('Tree cover'),
  Shrubland: msg('Shrubland'),
  Grassland: msg('Grassland'),
  Cropland: msg('Cropland'),
  'Built-up': msg('Built-up'),
  'Bare / sparse vegetation': msg('Bare / sparse vegetation'),
  'Snow and ice': msg('Snow and ice'),
  'Permanent water bodies': msg('Permanent water bodies'),
  'Herbaceous wetland': msg('Herbaceous wetland'),
  Mangroves: msg('Mangroves'),
  'Moss and lichen': msg('Moss and lichen'),
  // Elevation contours.
  Contour: msg('Contour'),
  'Index contour': msg('Index contour'),
  // Forest types.
  'Naturally regenerating forest': msg('Naturally regenerating forest'),
  'Primary forest': msg('Primary forest'),
  'Planted forest': msg('Planted forest'),
  // Population (people per km²).
  '1,000': msg('1,000'),
  '10,000+ per km²': msg('10,000+ per km²'),
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
  // The Rivers bands (src/data/earthEngineLayers.js RIVER_BANDS).
  all: msg('Rivers of every flow order'),
});

/** A variant's words for the status line, or ''. */
export function variantLabel(variant) {
  const band = /^o(\d{1,2})$/.exec(String(variant || ''));
  if (band)
    return t('Rivers of flow orders 1 to {max}', { max: Number(band[1]) });
  // The elevation contour bands (CONTOUR_BANDS): c500-far, c200-base…, the
  // step and the DEM stack band it is drawn from.
  const contour = /^c(\d{1,4})(?:-[a-z]+)?$/.exec(String(variant || ''));
  if (contour)
    return t('Contours every {step} m', { step: Number(contour[1]) });
  return VARIANT_LABELS[variant] ? t(VARIANT_LABELS[variant]) : '';
}

const POPULATION_TITLE = msg('People per km² in {year} (GHSL)');

/** A mode's words for the status line, or '' (Population's epoch). */
export function modeLabel(mode) {
  const epoch = POPULATION_MODES.find((entry) => entry.key === mode)?.epoch;
  return epoch ? t(POPULATION_TITLE, { year: epoch }) : '';
}

/**
 * The mode chips of a layer with modes (the Rivers, Surface water, Land
 * cover, Population's epochs).
 */
export const MODE_CHIPS = Object.freeze([
  Object.freeze({
    key: 'network',
    label: msg('NETWORK'),
    title: msg(
      'The river network, wider and brighter the larger the flow (HydroRIVERS)',
    ),
  }),
  Object.freeze({
    key: 'free-flowing',
    label: msg('FREE-FLOWING'),
    title: msg(
      'Connectivity status (Grill et al. 2019): free-flowing, good connectivity, impacted',
    ),
  }),
  Object.freeze({
    key: 'pressure',
    label: msg('PRESSURE'),
    title: msg(
      'The pressure that most lowers each reach’s connectivity: dams, flow regulation, sediment trapping, water use, roads, cities',
    ),
  }),
  // Surface water (JRC Global Surface Water 1.4).
  Object.freeze({
    key: 'occurrence',
    label: msg('OCCURRENCE'),
    title: msg('How often water was there, 1984–2021'),
  }),
  Object.freeze({
    key: 'change',
    label: msg('CHANGE'),
    title: msg(
      'Water lost (red) or gained (blue): 1984–1999 against 2000–2021',
    ),
  }),
  Object.freeze({
    key: 'seasonality',
    label: msg('SEASONALITY'),
    title: msg('How many months a year water is there'),
  }),
  // Land cover (ESA WorldCover): the map's year.
  Object.freeze({
    key: 'v200',
    label: msg('2021'),
    title: msg('ESA WorldCover 2021 (v200)'),
  }),
  Object.freeze({
    key: 'v100',
    label: msg('2020'),
    title: msg(
      'ESA WorldCover 2020 (v100), to compare; its method differs, so not every change is real',
    ),
  }),
  // Population: one chip per epoch, its year (a number, the same in every
  // language).
  ...POPULATION_MODES.map((mode) =>
    Object.freeze({
      key: mode.key,
      label: String(mode.epoch),
      title: POPULATION_TITLE,
      values: Object.freeze({ year: mode.epoch }),
    }),
  ),
]);

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
 *   ceilingM?: number|null, slowDistricts?: boolean, americasV2?: boolean,
 *   mode?: string, demSource?: string}}
 *   state - `mode`: the mode drawn (Population's epoch); `americasV2`: the
 *   Rivers draw the Americas from HydroSHEDS v2; `demSource`: a terrain
 *   layer's elevation source under the view; `hostless`:
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
  americasV2 = false,
  mode = '',
  demSource = '',
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
  else if (variantLabel(variant)) parts.push(variantLabel(variant));
  else if (modeLabel(mode)) parts.push(modeLabel(mode));
  // The terrain layers: the DEM drawing under the view (a proper name).
  if (demSource && !Number.isFinite(ceilingM))
    parts.push(t('Elevation: {source}', { source: demSource }));
  if (slowDistricts)
    parts.push(t('Districts from this height: the tiles arrive slowly'));
  if (americasV2) parts.push(t('The Americas from HydroSHEDS v2'));
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
 *   slowDistricts?: boolean, mode?: string,
 *   onMode?: (key: string) => void, americasV2?: boolean,
 *   demSource?: string, creditTitle?: string}} input - `level` and `ink`
 *   are the settings ('auto' or a key); `inkDrawn` the ink in use; `mode`
 *   the mode of a layer with modes; `demSource` and `creditTitle` a terrain
 *   layer's source under the view and the notices of those in it.
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
  mode = '',
  onMode = () => {},
  americasV2 = false,
  demSource = '',
  creditTitle = '',
}) {
  const layer = catalog?.layers?.get?.(record.id) || null;
  const variantKeys = new Set((record.variants || []).map((v) => v.key));
  const chips = [];
  const modeKeys = new Set((record.modes || []).map((entry) => entry.key));
  for (const chip of MODE_CHIPS) {
    if (!modeKeys.has(chip.key)) continue; // hidden modes have no chip
    chips.push({
      id: `mode-${chip.key}`,
      label: t(chip.label),
      title: t(chip.title, chip.values),
      active: mode === chip.key,
      onClick: () => onMode(chip.key),
    });
  }
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
  // A layer with modes: the mode's legend, each swatch its colour in the
  // ink drawn.
  const drawnMode = record.modes?.length ? modeRecord(record, mode) : null;
  const legend = drawnMode
    ? drawnMode.legend.map((entry) => ({
        label: legendLabel(entry.label),
        color: entry.ink
          ? inkSwatch(record, inkDrawn === 'default' ? 'light' : inkDrawn)
          : `#${String(
              drawnMode.colors?.[inkDrawn]?.[entry.value] ||
                entry.color.slice(1),
            ).slice(0, 6)}`,
      }))
    : (layer?.legend?.length ? layer.legend : record.legend || []).map(
        (entry) => ({
          label: legendLabel(entry.label),
          // A features layer's swatch is the ink it is drawn in.
          color:
            record.inks && inkDrawn !== 'default'
              ? inkSwatch(record, inkDrawn)
              : entry.color,
        }),
      );
  return {
    chips,
    legend,
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
      americasV2,
      mode,
      demSource,
    }),
    // A terrain layer: the notices of the sources in view.
    infoTitle: creditTitle || layer?.attribution || '',
  };
}
