import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { WIKIPEDIA_POINT_CLASSES } from '../../data/wikipediaPoints.js';
import { legendStops } from './ramp.js';
import { CLASS_WORDS, SECONDARY_COLOR } from './points.js';
import { scaleRowLegend } from '../../ui/colourScaleWidget.js';
import { isDefaultScale } from '../../maps/colourScale.js';

/**
 * Personal fork: what the Wikipedia row in the DATA LAYERS panel says: a
 * chip per mode (the Articles dots, then the coverage rasters), the type
 * classes or the colour ramp as a legend, an opacity slider for the
 * rasters, and a status line (how to build what is missing, the dump's
 * date and article count otherwise).
 */

/** The modes, in the order their chips appear: the dots, then the rasters. */
export const VARIANTS = Object.freeze([
  Object.freeze({
    key: 'points',
    label: msg('Articles'),
    title: msg(
      'One dot per geotagged English Wikipedia article, coloured by its type; titles close in',
    ),
  }),
  Object.freeze({
    key: 'articles',
    label: msg('Density per km²'),
    title: msg(
      'Primary geotagged English Wikipedia articles per square kilometre',
    ),
  }),
  Object.freeze({
    key: 'text',
    label: msg('Text per km²'),
    title: msg(
      'Bytes of article wikitext per square kilometre: article size, not words',
    ),
  }),
  Object.freeze({
    key: 'capita',
    label: msg('Per 100k people'),
    title: msg(
      'Articles per 100,000 people (GHSL 2020 population against today’s Wikipedia); clear where fewer than 100 people live',
    ),
  }),
  Object.freeze({
    key: 'textcapita',
    label: msg('Text per person'),
    title: msg(
      'Bytes of article wikitext per person (GHSL 2020 population); clear where fewer than 100 people live',
    ),
  }),
]);

/** The per-capita variants (the people come from population.bin). */
const CAPITA_KEYS = Object.freeze(['capita', 'textcapita']);

export const DEFAULT_VARIANT = 'points';
/** The mode whose dots come from the points index, not the grid. */
export const POINTS_VARIANT = 'points';

/** The chips every mode shows: one a mode, the unbuilt ones greyed. */
function modeChips(catalog, variant, onVariant, extra = () => undefined) {
  return VARIANTS.map((record) => {
    const built =
      record.key === POINTS_VARIANT
        ? catalog?.points?.built === true
        : catalog?.variants?.get?.(record.key)?.available === true;
    return {
      id: record.key,
      label: t(record.label),
      title: t(record.title),
      active: record.key === variant,
      // Chips stay clickable while the catalog loads; an unbuilt mode is
      // shown greyed, and choosing it says what to run.
      state:
        (catalog?.configured && !built) || extra(record) ? 'error' : undefined,
      onClick: () => onVariant(record.key),
    };
  });
}

/** The row in the Articles mode: the modes, Secondary, the type classes. */
function pointsRowControls({
  catalog,
  onVariant,
  loading,
  failure,
  points,
  secondary,
  onSecondary,
}) {
  const hasSecondary = (catalog?.points?.secondary || 0) > 0;
  return {
    chips: [
      ...modeChips(catalog, POINTS_VARIANT, onVariant),
      ...(onSecondary
        ? [
            {
              id: 'secondary',
              label: t('Secondary'),
              title: hasSecondary
                ? t(
                    'Also the secondary coordinates: an article’s other places, ranked below every primary one',
                  )
                : t(
                    'The secondary coordinates are not built: run npm run wikipedia:build -- --points --secondary',
                  ),
              active: secondary,
              state: hasSecondary ? undefined : 'error',
              onClick: () => onSecondary(!secondary),
            },
          ]
        : []),
    ],
    legend: pointsLegend({ secondary: secondary && hasSecondary }),
    info: failure
      ? t('Wikipedia coverage unavailable: {reason}', { reason: failure })
      : !catalog && loading
        ? t('Asking the server…')
        : pointsStatusText(catalog, points),
    infoTitle: catalog?.attribution || '',
  };
}

/** The variant record for a key, else the default. */
export function variantRecord(key) {
  return VARIANTS.find((variant) => variant.key === key) || VARIANTS[0];
}

/**
 * The status line.
 * @param {{catalog?: object|null, variant?: string, loading?: boolean,
 *   failure?: string|null, hostless?: boolean}} state
 */
export function statusText({
  catalog = null,
  variant = DEFAULT_VARIANT,
  loading = false,
  failure = null,
  hostless = false,
  points = null,
}) {
  if (failure)
    return t('Wikipedia coverage unavailable: {reason}', { reason: failure });
  if (variant === POINTS_VARIANT)
    return pointsStatusText(catalog, points, { loading });
  if (hostless && catalog?.configured) return t(NO_IMAGERY_HOST);
  if (!catalog) return loading ? t('Asking the server…') : '';
  if (!catalog.configured)
    return (
      catalog.message ||
      t('Run npm run wikipedia:build to build the Wikipedia coverage grid')
    );
  const parts = [];
  if (variant === 'text' && !catalog.variants?.get?.('text')?.available)
    parts.push(
      t('Article sizes are not built: run npm run wikipedia:build -- --text'),
    );
  if (CAPITA_KEYS.includes(variant)) {
    if (!catalog.population?.built)
      parts.push(
        t(
          'Population is not built: run npm run wikipedia:build -- --population',
        ),
      );
    else
      parts.push(
        t('People: {source}, clear under {floor}', {
          source: catalog.population.source || 'GHSL',
          floor: catalog.population.floor,
        }),
      );
  }
  if (catalog.dumpDate)
    parts.push(t('Dump of {date}', { date: catalog.dumpDate }));
  if (catalog.articles)
    parts.push(
      tn(
        catalog.articles,
        '{count} geotagged article',
        '{count} geotagged articles',
      ),
    );
  return parts.join(' · ');
}

/** The Articles mode's status line. */
export function pointsStatusText(catalog, points, { loading = false } = {}) {
  if (!catalog) return loading ? t('Asking the server…') : '';
  if (!catalog.points?.built)
    return t(
      'Run npm run wikipedia:build -- --points for the Wikipedia articles',
    );
  if (points?.state === 'loading') return t('Reading the articles…');
  if (points?.state === 'failed')
    return t('Wikipedia articles unavailable: {reason}', {
      reason: points.message || '?',
    });
  const parts = [];
  if (points?.state === 'ready')
    parts.push(
      tn(points.count, '{count} article in view', '{count} articles in view', {
        count: formatNumber(points.count),
      }),
    );
  if (points?.state === 'ready' && points.zoom < 12)
    parts.push(t('the most notable; zoom in for all'));
  if (catalog.points.dumpDate)
    parts.push(t('Dump of {date}', { date: catalog.points.dumpDate }));
  return parts.join(' · ');
}

/** The Articles mode's legend: a swatch per type class (and secondary). */
export function pointsLegend({ secondary = false } = {}) {
  return [
    ...WIKIPEDIA_POINT_CLASSES.map((c) => ({
      label: t(CLASS_WORDS[c.key]),
      color: c.color,
    })),
    ...(secondary
      ? [{ label: t('Secondary coordinates'), color: SECONDARY_COLOR }]
      : []),
  ];
}

/**
 * The row's controls for the layer panel (src/ui/layerPanel.js).
 * @param {{catalog?: object|null, variant: string, onVariant: (key: string) => void,
 *   opacity: number, onOpacity: (value: number) => void, loading?: boolean,
 *   failure?: string|null, hostless?: boolean, attribution?: string}} input
 */
export function rowControls({
  catalog = null,
  variant,
  onVariant,
  opacity,
  onOpacity,
  loading = false,
  failure = null,
  hostless = false,
  attribution = '',
  // The Hexes mode (hexes.js): on or off, its toggle, and what it drew.
  hexes = false,
  onHexes = null,
  hexState = null,
  // The Articles mode: what it shows, and its secondary coordinates' chip.
  points = null,
  secondary = false,
  onSecondary = null,
  // The colour scale's row descriptor (colourScaleWidget.js), when drawn.
  scale = null,
}) {
  if (variant === POINTS_VARIANT)
    return pointsRowControls({
      catalog,
      onVariant,
      loading,
      failure,
      points,
      secondary,
      onSecondary,
    });
  const chosen = catalog?.variants?.get?.(variant) || null;
  // In Hexes mode the legend follows the resolution's own domain.
  const legendDomain = hexes ? hexState?.domain || null : chosen?.domain;
  const hexInfo =
    hexes && hexState?.res !== undefined && hexState?.res !== null
      ? t('Hexes: resolution {res}, {count} cells', {
          res: hexState.res,
          count: hexState.count ?? 0,
        })
      : '';
  const status = statusText({
    catalog,
    variant,
    loading,
    failure: hexes ? hexState?.failure || failure : failure,
    hostless: hexes ? false : hostless,
  });
  return {
    chips: [
      // In Hexes mode a variant the hex grid lacks (404) or an unbuilt grid
      // (503) greys the chip that asked, with the message below.
      ...modeChips(
        catalog,
        variant,
        onVariant,
        (record) =>
          hexes &&
          hexState?.variant === record.key &&
          [404, 503].includes(hexState?.status),
      ),
      ...(onHexes
        ? [
            {
              id: 'hexes',
              label: t('Hexes'),
              title: t(
                'Draw H3 hexes at a resolution chosen by the camera height instead of the raster',
              ),
              active: hexes,
              onClick: () => onHexes(!hexes),
            },
          ]
        : []),
    ],
    legend:
      legendDomain && (hexes || chosen?.available)
        ? scale && !isDefaultScale(scale.model, scale.defaults)
          ? scaleRowLegend(scale)
          : legendStops(legendDomain, {
              bytes: variant === 'text' || variant === 'textcapita',
            })
        : [],
    ...(scale ? { scale } : {}),
    slider: {
      label: t('Opacity {value}%', { value: Math.round(opacity * 100) }),
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(opacity * 100),
      onInput: (value) => onOpacity(value / 100),
    },
    info: [hexInfo, status].filter(Boolean).join(' · '),
    infoTitle: catalog?.attribution || attribution || '',
  };
}
