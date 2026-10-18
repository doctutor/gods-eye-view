// Personal fork: colours for the Countries basemap. Two themes, a single
// country fill for the simple and subdivisions styles, a varied palette for
// the hex style, and a hook to colour individual countries by hand or from
// data (`setCountryFill`).

export const COUNTRY_THEMES = Object.freeze({
  dark: Object.freeze({
    ocean: '#0b1016',
    fill: '#2f3a47',
    outline: '#8a98a8',
    outlineWidth: 1.2,
    admin1Outline: '#55636f',
    admin1OutlineWidth: 0.8,
    hexOutline: '#0b1016',
    hexOutlineWidth: 1,
    varied: Object.freeze([
      '#3b4f6b',
      '#4f6b3b',
      '#6b3b4f',
      '#6b5a3b',
      '#3b6b66',
      '#5a3b6b',
      '#6b3b3b',
      '#3b6b4a',
      '#4a4a6b',
      '#6b663b',
    ]),
  }),
  light: Object.freeze({
    ocean: '#dde6ee',
    fill: '#e8e8e8',
    outline: '#333333',
    outlineWidth: 1.2,
    admin1Outline: '#8c8c8c',
    admin1OutlineWidth: 0.8,
    hexOutline: '#ffffff',
    hexOutlineWidth: 1,
    varied: Object.freeze([
      '#b7c7e2',
      '#c7e2b7',
      '#e2b7c7',
      '#e2d4b7',
      '#b7e2dd',
      '#d4b7e2',
      '#e2b7b7',
      '#b7e2c4',
      '#c4c4e2',
      '#e2dfb7',
    ]),
  }),
});

/** Per-country fills, by ISO 3166-1 alpha-2 (upper case): the owner's hook. */
export const COUNTRY_FILL_OVERRIDES = new Map();

const listeners = new Set();

/**
 * Colour one country by hand or from data; null removes the override. Every
 * listener (the renderer) hears about it and repaints.
 * @param {string} iso2
 * @param {string | null} color CSS colour.
 */
export function setCountryFill(iso2, color) {
  const key = String(iso2 || '').toUpperCase();
  if (!key) return;
  if (color) COUNTRY_FILL_OVERRIDES.set(key, String(color));
  else COUNTRY_FILL_OVERRIDES.delete(key);
  for (const listener of [...listeners]) {
    try {
      listener(key);
    } catch {
      /* a repaint that fails is its own problem */
    }
  }
}

/** Replace every override at once (e.g. from a data join). */
export function setCountryFills(entries) {
  COUNTRY_FILL_OVERRIDES.clear();
  for (const [iso2, color] of Object.entries(entries || {}))
    if (color)
      COUNTRY_FILL_OVERRIDES.set(String(iso2).toUpperCase(), String(color));
  for (const listener of [...listeners]) {
    try {
      listener(null);
    } catch {
      /* as above */
    }
  }
}

/** Hear override changes. @returns {() => void} unsubscribe */
export function onCountryFillChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A stable index for a feature, so a country keeps its varied colour. */
export function featurePaletteIndex(feature) {
  const text = String(feature?.id || feature?.name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++)
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

/**
 * The fill colour for a feature.
 * @param {{ iso2?: string, id?: string, name?: string }} feature
 * @param {{ theme: 'dark' | 'light', style: 'simple' | 'subdivisions' | 'hex' }} options
 * @returns {string} CSS colour.
 */
export function fillFor(feature, { theme, style }) {
  const colours = COUNTRY_THEMES[theme] || COUNTRY_THEMES.dark;
  const override = COUNTRY_FILL_OVERRIDES.get(
    String(feature?.iso2 || '').toUpperCase(),
  );
  if (override) return override;
  if (style === 'hex')
    return colours.varied[featurePaletteIndex(feature) % colours.varied.length];
  return colours.fill;
}
