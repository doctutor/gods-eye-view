import { msg, t } from '../../i18n/index.js';
import { labelText } from './model.js';

/**
 * Personal fork: the Grid row in the DATA LAYERS panel (REFERENCE): the
 * opacity slider (the same row control the Earth Engine rows use), a style
 * switch (latitude–longitude, Tissot's indicatrix, MGRS), an ink switch
 * (AUTO follows the basemap; LIGHT and DARK force one), and a line saying
 * the spacing drawn (in MGRS, with the view centre's reference).
 */

/** The ink chips. */
export const INK_CHIPS = Object.freeze([
  Object.freeze({
    key: 'auto',
    label: msg('AUTO INK'),
    title: msg(
      'The ink follows the basemap: cyan and amber on dark maps, blue-grey and brown on light maps',
    ),
  }),
  Object.freeze({
    key: 'light',
    label: msg('LIGHT INK'),
    title: msg('Light ink: cyan and amber lines'),
  }),
  Object.freeze({
    key: 'dark',
    label: msg('DARK INK'),
    title: msg('Dark ink: blue-grey and brown lines'),
  }),
]);

/** The spacing as the row says it: "Every 10°", "Every 30'". */
export function spacingText(step) {
  // A step's own label, without the hemisphere letter: 10° or 30'.
  const text = labelText(step, 'lat', step).replace(/[NS]$/, '');
  // 0°30' → 30', 0°05' → 5': minutes alone under a degree.
  const short = step < 1 ? text.replace(/^0°0?/, '') : text;
  return t('Lines every {spacing}', { spacing: short });
}

/** An MGRS level as the row says it: "Grid zones, 6° by 8°", "Lines every 1 km". */
export function mgrsSpacingText(level) {
  if (!level?.stepM) return t('Grid zones, 6° by 8°');
  return t('Lines every {spacing}', {
    spacing: t('{km} km', { km: level.stepM / 1000 }),
  });
}

/**
 * @param {{mode?: string, onMode?: (mode: string) => void, opacity: number,
 *   onOpacity: (value: number) => void, step: number|null,
 *   groundless?: boolean, mgrs?: {level: object, reference: string|null,
 *   polar: boolean}|null}} input - `groundless`: the scene cannot clamp
 *   lines to the ground (no depth textures); `mgrs`: what the MGRS mode
 *   draws, when it is on.
 */
export function rowControls({
  mode = 'latlon',
  onMode = () => {},
  ink = 'auto',
  onInk = () => {},
  opacity,
  onOpacity,
  step,
  groundless = false,
  mgrs = null,
}) {
  const parts = [];
  if (mode === 'mgrs' && mgrs) {
    parts.push(mgrsSpacingText(mgrs.level));
    if (mgrs.reference)
      parts.push(t('Centre {reference}', { reference: mgrs.reference }));
    if (mgrs.polar)
      parts.push(
        t('MGRS stops at 80°S and 84°N: the polar UPS grid is not drawn'),
      );
  } else if (Number.isFinite(step)) parts.push(spacingText(step));
  if (mode === 'tissot')
    parts.push(
      t('Equal circles on the ground: their shapes show the view’s distortion'),
    );
  if (groundless)
    parts.push(t('Drawn at sea level: this display cannot drape lines'));
  return {
    chips: [
      {
        id: 'latlon',
        label: t('LAT/LON'),
        active: mode === 'latlon',
        title: t('Latitude and longitude, every few degrees or minutes'),
        onClick: () => onMode('latlon'),
      },
      {
        id: 'tissot',
        label: t('TISSOT'),
        active: mode === 'tissot',
        title: t(
          "Tissot's indicatrix: circles of one real size at the grid's crossings",
        ),
        onClick: () => onMode('tissot'),
      },
      {
        id: 'mgrs',
        label: t('MGRS'),
        active: mode === 'mgrs',
        title: t(
          'The Military Grid Reference System: grid zones, then 100 km squares, then 10 km and 1 km lines',
        ),
        onClick: () => onMode('mgrs'),
      },
      ...INK_CHIPS.map((chip) => ({
        id: `ink-${chip.key}`,
        label: t(chip.label),
        active: ink === chip.key,
        title: t(chip.title),
        onClick: () => onInk(chip.key),
      })),
    ],
    slider: {
      label: t('Opacity {value}%', { value: Math.round(opacity * 100) }),
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(opacity * 100),
      onInput: (value) => onOpacity(value / 100),
    },
    info: parts.join(' · '),
  };
}
