// Personal fork: the "Countries" basemap — MapChart-style world maps drawn
// as Cesium geometry on a blank globe, in three styles and two themes. Pure
// data: the tray, the share-link codec and the voice vocabulary read it
// without Cesium. The geometry comes from the bundled Natural Earth packs
// (src/data/local_data/natural_earth/, public domain).
//
// Record fields:
//   id, label, shortLabel, note   as in keylessBasemapCatalog.js
//   style   'simple' (one fill, dark outlines), 'subdivisions' (admin-1
//           outlines below a camera height), 'hex' (a hex tessellation of
//           land at a resolution chosen by altitude)
//   theme   'dark' | 'light' (src/maps/countries/palette.js); also the
//           descriptor's luminance

import { msg } from '../../i18n/marker.js';

/** The picker group every countries style sits in. */
export const COUNTRIES_GROUP = 'countries';

/** Camera height (m) below which the subdivisions style draws admin-1 units. */
export const SUBDIVISIONS_MAX_HEIGHT_M = 5_000_000;

const STYLES = [
  {
    style: 'simple',
    shortLabel: 'SIMPLE',
    note: msg('One fill per country, dark outlines'),
  },
  {
    style: 'subdivisions',
    shortLabel: 'SUBDIV',
    note: msg('States and provinces appear below 5,000 km'),
  },
  {
    style: 'hex',
    shortLabel: 'HEX',
    note: msg('Land as hexes; finer as you zoom in'),
  },
];
const THEMES = ['dark', 'light'];
const STYLE_NAMES = {
  simple: 'Simple',
  subdivisions: 'Subdivisions',
  hex: 'Hex',
}; // i18n-ignore: style names
const THEME_NAMES = { dark: 'Dark', light: 'Light' }; // i18n-ignore: style names

export const COUNTRIES_BASEMAPS = Object.freeze(
  STYLES.flatMap(({ style, shortLabel, note }) =>
    THEMES.map((theme) =>
      Object.freeze({
        id: `countries-${style}-${theme}`,
        label: `Countries · ${STYLE_NAMES[style]} · ${THEME_NAMES[theme]}`, // i18n-ignore: style name
        shortLabel,
        group: COUNTRIES_GROUP,
        note,
        style,
        theme,
      }),
    ),
  ),
);

export const COUNTRIES_BASEMAP_IDS = Object.freeze(
  COUNTRIES_BASEMAPS.map((record) => record.id),
);

const byId = new Map(COUNTRIES_BASEMAPS.map((record) => [record.id, record]));

/** The record for a MAP_STACKS id, or null for any other stack. */
export function countriesBasemapRecord(id) {
  return byId.get(id) || null;
}

/** The `MAP_STACKS` descriptor for one record (see ../catalog.js). */
export function countriesBasemapDescriptor(record) {
  return {
    id: record.id,
    label: record.label,
    shortLabel: record.shortLabel,
    kind: 'countries-basemap',
    requiresIon: false,
    group: record.group,
    note: record.note,
    // Overlays pick their ink from this (src/maps/ink.js): the theme says it.
    luminance: record.theme,
  };
}
