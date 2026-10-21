import { msg, t, tn } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { legendStops } from './ramp.js';
import { scaleRowLegend } from '../../ui/colourScaleWidget.js';
import { isDefaultScale } from '../../maps/colourScale.js';

/**
 * Personal fork: what the Wikipedia coverage row in the DATA LAYERS panel
 * says: a chip per variant, the colour ramp as a legend with the variant's
 * floor and ceiling, an opacity slider, and a status line (how to build
 * the grid when there is none, the dump's date and article count
 * otherwise).
 */

/** The variants, in the order their chips appear. */
export const VARIANTS = Object.freeze([
  Object.freeze({
    key: 'articles',
    label: msg('Articles per km²'),
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
    key: 'count',
    label: msg('Articles (count)'),
    title: msg(
      'Articles under each pixel, not divided by area, so it changes with the zoom',
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

export const DEFAULT_VARIANT = 'articles';

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
}) {
  if (failure)
    return t('Wikipedia coverage unavailable: {reason}', { reason: failure });
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
  // The colour scale's row descriptor (colourScaleWidget.js), when drawn.
  scale = null,
}) {
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
      ...VARIANTS.map((record) => {
        const available =
          catalog?.variants?.get?.(record.key)?.available === true;
        return {
          id: record.key,
          label: t(record.label),
          title: t(record.title),
          active: record.key === variant,
          // Chips stay clickable while the catalog loads; an unbuilt variant
          // is shown greyed, and choosing it says what to run.
          state:
            (catalog?.configured && !available) ||
            // In Hexes mode a variant the hex grid lacks (404) or an unbuilt
            // grid (503) greys the chip that asked, with the message below.
            (hexes &&
              hexState?.variant === record.key &&
              [404, 503].includes(hexState?.status))
              ? 'error'
              : undefined,
          onClick: () => onVariant(record.key),
        };
      }),
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
