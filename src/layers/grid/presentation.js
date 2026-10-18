import { t } from '../../i18n/index.js';
import { labelText } from './model.js';

/**
 * Personal fork: the Grid row in the DATA LAYERS panel (REFERENCE): the
 * opacity slider (the same row control the Earth Engine rows use), a style
 * switch (latitude–longitude now; MGRS to come, shown disabled), and a line
 * saying the spacing drawn.
 */

/** The spacing as the row says it: "Every 10°", "Every 30'". */
export function spacingText(step) {
  // A step's own label, without the hemisphere letter: 10° or 30'.
  const text = labelText(step, 'lat', step).replace(/[NS]$/, '');
  // 0°30' → 30', 0°05' → 5': minutes alone under a degree.
  const short = step < 1 ? text.replace(/^0°0?/, '') : text;
  return t('Lines every {spacing}', { spacing: short });
}

/**
 * @param {{mode?: string, onMode?: (mode: string) => void, opacity: number,
 *   onOpacity: (value: number) => void, step: number|null,
 *   groundless?: boolean}} input - `groundless`: the scene cannot clamp
 *   lines to the ground (no depth textures).
 */
export function rowControls({
  mode = 'latlon',
  onMode = () => {},
  opacity,
  onOpacity,
  step,
  groundless = false,
}) {
  const parts = [];
  if (Number.isFinite(step)) parts.push(spacingText(step));
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
        label: t('MGRS · SOON'),
        active: false,
        disabled: true,
        title: t(
          'The Military Grid Reference System, coming in a later version',
        ),
      },
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
