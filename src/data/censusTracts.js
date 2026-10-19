/**
 * Personal fork: the Census tracts layer's values drawn by the local tile
 * server (server/providers/census.js, built by `npm run census:build`), and
 * their colours. Shared by the server's renderer and the layer's legend.
 */

export const CENSUS_ENDPOINT = '/api/census';

/**
 * Median household income (ACS 5-year 2020–2024, 2024 dollars) in seven
 * classes, the ColorBrewer YlGnBu ramp at 78% so the ground shows through.
 * A tract with no estimate (no households, or too few) is drawn faint grey.
 */
export const INCOME_CLASSES = Object.freeze([
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  Object.freeze({ below: 30_000, color: 'ffffcc', label: 'Under $30k' }),
  Object.freeze({ below: 50_000, color: 'c7e9b4', label: '$30k' }),
  Object.freeze({ below: 70_000, color: '7fcdbb', label: '$50k' }),
  Object.freeze({ below: 90_000, color: '41b6c4', label: '$70k' }),
  Object.freeze({ below: 120_000, color: '1d91c0', label: '$90k' }),
  Object.freeze({ below: 160_000, color: '225ea8', label: '$120k' }),
  Object.freeze({ below: Infinity, color: '0c2c84', label: '$160k+' }),
]);
export const INCOME_ALPHA = 'c8';
export const NO_ESTIMATE_COLOR = '9aa4ad55';

/** The fill (RRGGBBAA) of a tract's income, or the no-estimate grey. */
export function incomeColor(value) {
  if (!Number.isFinite(value)) return NO_ESTIMATE_COLOR;
  const entry = INCOME_CLASSES.find((c) => value < c.below);
  return `${entry.color}${INCOME_ALPHA}`;
}

export const INCOME_LEGEND = Object.freeze(
  INCOME_CLASSES.map((entry) =>
    Object.freeze({ label: entry.label, color: `#${entry.color}` }),
  ),
);

/**
 * Land surface temperature (the June–August 2018–2023 Landsat 8/9 mean,
 * °C, per tract: scripts/census/lst.mjs) in seven classes, ColorBrewer
 * RdYlBu reversed at 78%. Surfaces, not air: a summer roof or road is
 * often 50 °C and more.
 */
export const LST_CLASSES = Object.freeze([
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  Object.freeze({ below: 25, color: '4575b4', label: 'Under 25 °C' }),
  Object.freeze({ below: 30, color: '91bfdb', label: '25 °C' }),
  Object.freeze({ below: 35, color: 'e0f3f8', label: '30 °C' }),
  Object.freeze({ below: 40, color: 'ffffbf', label: '35 °C' }),
  Object.freeze({ below: 45, color: 'fee090', label: '40 °C' }),
  Object.freeze({ below: 50, color: 'fc8d59', label: '45 °C' }),
  Object.freeze({ below: Infinity, color: 'd73027', label: '50 °C+' }),
]);

/** The fill of a tract's summer surface temperature, or the no-value grey. */
export function lstColor(value) {
  if (!Number.isFinite(value)) return NO_ESTIMATE_COLOR;
  const entry = LST_CLASSES.find((c) => value < c.below);
  return `${entry.color}${INCOME_ALPHA}`;
}

export const LST_LEGEND = Object.freeze(
  LST_CLASSES.map((entry) =>
    Object.freeze({ label: entry.label, color: `#${entry.color}` }),
  ),
);

/** A local mode's classes and colour function, by mode. */
export const CENSUS_MODE_STYLES = Object.freeze({
  income: Object.freeze({ classes: INCOME_CLASSES, color: incomeColor }),
  lst: Object.freeze({ classes: LST_CLASSES, color: lstColor }),
});

/** The modes the local server draws (the rest are Earth Engine's). */
export const CENSUS_LOCAL_MODES = Object.freeze(['income', 'lst']);
