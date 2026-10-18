import { msg, t, tn } from '../../i18n/index.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { legendStops } from './ramp.js';

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
]);

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
}) {
  const chosen = catalog?.variants?.get?.(variant) || null;
  return {
    chips: VARIANTS.map((record) => {
      const available =
        catalog?.variants?.get?.(record.key)?.available === true;
      return {
        id: record.key,
        label: t(record.label),
        title: t(record.title),
        active: record.key === variant,
        // Chips stay clickable while the catalog loads; an unbuilt variant
        // is shown greyed, and choosing it says what to run.
        state: catalog?.configured && !available ? 'error' : undefined,
        onClick: () => onVariant(record.key),
      };
    }),
    legend: chosen?.available
      ? legendStops(chosen.domain, { bytes: variant === 'text' })
      : [],
    slider: {
      label: t('Opacity {value}%', { value: Math.round(opacity * 100) }),
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(opacity * 100),
      onInput: (value) => onOpacity(value / 100),
    },
    info: statusText({ catalog, variant, loading, failure, hostless }),
    infoTitle: catalog?.attribution || attribution || '',
  };
}
