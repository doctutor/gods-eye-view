// Personal fork: keyless raster basemaps beyond the five upstream sources.
//
// Pure data, no Cesium: the MAP SOURCE tray, the share-link codec and the
// voice vocabulary read it without constructing a provider. The factory that
// turns a record into an imagery provider is keylessBasemaps.js.
//
// Record fields:
//   id          MAP_STACKS id, also the share link's `map=` value
//   label       product name, shown as-is in every language
//   shortLabel  the status chip's text (upstream: '3D', 'SAT', 'OSM')
//   group       KEYLESS_BASEMAP_GROUPS id, how the "More styles" picker groups it
//   note        a short remark the picker shows when the style is active
//   tiles       how to draw it (see the `type` values below)
//   credit      attribution the provider carries, and the static credit line
//   luminance   'dark' | 'light': how the style reads, so overlays pick an ink
//               that shows on it (src/maps/ink.js)
//
// `tiles.type`:
//   'blank'    no imagery; the bare globe painted `baseColor` (r, g, b, 0..1)
//   'bundled'  a tile set shipped inside CesiumJS, by module-relative path
//   'xyz'      a {z}/{x}/{y} template on a public host, with `subdomains`
//   'gibs'     a static NASA GIBS WMTS layer (EPSG:3857, y before x)
//   'stadia'   a Stadia Maps style, keyless on localhost, with an optional key

import { msg } from '../i18n/marker.js';

/** Where the voice/tray tiles come from, for the data attribution popover. */
const OSM_CREDIT =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';
const CARTO_CREDIT = `${OSM_CREDIT} <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a>`;
const OPENTOPOMAP_CREDIT =
  'Map data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>, SRTM | Map style: <a href="https://opentopomap.org" target="_blank" rel="noopener">© OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>)';
const STADIA_CREDIT =
  '<a href="https://www.stadiamaps.com/" target="_blank" rel="noopener">© Stadia Maps</a> <a href="https://www.stamen.com/" target="_blank" rel="noopener">© Stamen Design</a> <a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';
const GIBS_CREDIT =
  'Imagery: <a href="https://gibs.earthdata.nasa.gov" target="_blank" rel="noopener">NASA GIBS</a> (ESDIS)';
const NATURAL_EARTH_CREDIT =
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth II</a> (public domain), bundled with CesiumJS';

/**
 * The picker's groups, in display order. A group with a `label` is a product
 * or agency name shown as-is; the others are translated by the picker
 * (src/mapStackMore.js) under the "map style" context.
 */
export const KEYLESS_BASEMAP_GROUPS = Object.freeze([
  Object.freeze({ id: 'blank' }),
  Object.freeze({ id: 'light' }),
  Object.freeze({ id: 'dark' }),
  Object.freeze({ id: 'terrain' }),
  Object.freeze({ id: 'nasa', label: 'NASA' }), // i18n-ignore: agency name
  Object.freeze({ id: 'stamen', label: 'Stamen' }), // i18n-ignore: product name
  Object.freeze({ id: 'countries' }), // the Countries basemap (countries/catalog.js)
]);

const CARTO_MAX_LEVEL = 20;
/** The bundled Natural Earth II tile set has levels 0 to 2 only. */
export const NATURAL_EARTH_II_MAX_LEVEL = 2;
/** OpenTopoMap serves nothing deeper, and asks hobby use to stay gentle. */
export const OPENTOPOMAP_MAX_LEVEL = 17;
/** GIBS `GoogleMapsCompatible_Level8`: a z=9 tile is a 400. */
export const GIBS_MAX_LEVEL = 8;

export const KEYLESS_BASEMAPS = Object.freeze([
  Object.freeze({
    id: 'blank-black',
    luminance: 'dark',
    label: 'Blank (black)', // i18n-ignore: style name
    shortLabel: 'BLACK',
    group: 'blank',
    note: msg('No imagery: a black globe for overlays'),
    tiles: Object.freeze({ type: 'blank', baseColor: [0, 0, 0] }),
    credit: null,
  }),
  Object.freeze({
    id: 'blank-white',
    luminance: 'light',
    label: 'Blank (white)', // i18n-ignore: style name
    shortLabel: 'WHITE',
    group: 'blank',
    note: msg('No imagery: a white globe for overlays'),
    tiles: Object.freeze({ type: 'blank', baseColor: [1, 1, 1] }),
    credit: null,
  }),
  Object.freeze({
    id: 'natural-earth-ii',
    luminance: 'light',
    label: 'Natural Earth II', // i18n-ignore: product name
    shortLabel: 'NE II',
    group: 'light',
    note: msg('Far-out views only: three zoom levels, bundled with Cesium'),
    tiles: Object.freeze({
      type: 'bundled',
      asset: 'Assets/Textures/NaturalEarthII',
      maximumLevel: NATURAL_EARTH_II_MAX_LEVEL,
    }),
    credit: NATURAL_EARTH_CREDIT,
  }),
  Object.freeze({
    id: 'carto-positron',
    luminance: 'light',
    label: 'CARTO Positron', // i18n-ignore: product name
    shortLabel: 'LIGHT',
    group: 'light',
    note: null,
    tiles: Object.freeze({
      type: 'xyz',
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: CARTO_MAX_LEVEL,
      alpha: false,
    }),
    credit: CARTO_CREDIT,
  }),
  Object.freeze({
    id: 'carto-positron-nolabels',
    luminance: 'light',
    label: 'CARTO Positron (no labels)', // i18n-ignore: product name
    shortLabel: 'LIGHT −',
    group: 'light',
    note: null,
    tiles: Object.freeze({
      type: 'xyz',
      url: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: CARTO_MAX_LEVEL,
      alpha: false,
    }),
    credit: CARTO_CREDIT,
  }),
  Object.freeze({
    id: 'carto-dark-matter',
    luminance: 'dark',
    label: 'CARTO Dark Matter', // i18n-ignore: product name
    shortLabel: 'DARK',
    group: 'dark',
    note: null,
    tiles: Object.freeze({
      type: 'xyz',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: CARTO_MAX_LEVEL,
      alpha: false,
    }),
    credit: CARTO_CREDIT,
  }),
  Object.freeze({
    id: 'carto-dark-matter-nolabels',
    luminance: 'dark',
    label: 'CARTO Dark Matter (no labels)', // i18n-ignore: product name
    shortLabel: 'DARK −',
    group: 'dark',
    note: null,
    tiles: Object.freeze({
      type: 'xyz',
      url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: CARTO_MAX_LEVEL,
      alpha: false,
    }),
    credit: CARTO_CREDIT,
  }),
  Object.freeze({
    id: 'opentopomap',
    luminance: 'light',
    label: 'OpenTopoMap', // i18n-ignore: product name
    shortLabel: 'TOPO',
    group: 'terrain',
    note: msg('A volunteer-run service: fair use, no bulk loading'),
    tiles: Object.freeze({
      type: 'xyz',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      maximumLevel: OPENTOPOMAP_MAX_LEVEL,
      alpha: false,
    }),
    credit: OPENTOPOMAP_CREDIT,
  }),
  Object.freeze({
    id: 'nasa-black-marble',
    luminance: 'dark',
    label: 'NASA Black Marble', // i18n-ignore: product name
    shortLabel: 'NIGHT',
    group: 'nasa',
    note: msg('VIIRS night lights, 2016; eight zoom levels'),
    tiles: Object.freeze({
      type: 'gibs',
      layer: 'VIIRS_Black_Marble',
      format: 'png',
      maximumLevel: GIBS_MAX_LEVEL,
    }),
    credit: GIBS_CREDIT,
  }),
  Object.freeze({
    id: 'nasa-blue-marble',
    luminance: 'dark',
    label: 'NASA Blue Marble', // i18n-ignore: product name
    shortLabel: 'BLUE',
    group: 'nasa',
    note: msg('Blue Marble: Next Generation; eight zoom levels'),
    tiles: Object.freeze({
      type: 'gibs',
      layer: 'BlueMarble_NextGeneration',
      format: 'jpeg',
      maximumLevel: GIBS_MAX_LEVEL,
    }),
    credit: GIBS_CREDIT,
  }),
  Object.freeze({
    id: 'stamen-toner',
    luminance: 'dark',
    label: 'Stamen Toner', // i18n-ignore: product name
    shortLabel: 'TONER',
    group: 'stamen',
    note: null,
    tiles: Object.freeze({
      type: 'stadia',
      style: 'stamen_toner',
      format: 'png',
      maximumLevel: 20,
      alpha: false,
    }),
    credit: STADIA_CREDIT,
  }),
  Object.freeze({
    id: 'stamen-toner-lite',
    luminance: 'light',
    label: 'Stamen Toner Lite', // i18n-ignore: product name
    shortLabel: 'TONER L',
    group: 'stamen',
    note: null,
    tiles: Object.freeze({
      type: 'stadia',
      style: 'stamen_toner_lite',
      format: 'png',
      maximumLevel: 20,
      alpha: false,
    }),
    credit: STADIA_CREDIT,
  }),
  Object.freeze({
    id: 'stamen-terrain',
    luminance: 'light',
    label: 'Stamen Terrain', // i18n-ignore: product name
    shortLabel: 'TERRAIN',
    group: 'stamen',
    note: null,
    tiles: Object.freeze({
      type: 'stadia',
      style: 'stamen_terrain',
      format: 'png',
      maximumLevel: 18,
      alpha: false,
    }),
    credit: STADIA_CREDIT,
  }),
  Object.freeze({
    id: 'stamen-watercolor',
    luminance: 'light',
    label: 'Stamen Watercolor', // i18n-ignore: product name
    shortLabel: 'WATER',
    group: 'stamen',
    note: msg('Sixteen zoom levels'),
    tiles: Object.freeze({
      type: 'stadia',
      style: 'stamen_watercolor',
      format: 'jpg',
      maximumLevel: 16,
      alpha: false,
    }),
    credit: STADIA_CREDIT,
  }),
]);

/** The ids, in catalog order. */
export const KEYLESS_BASEMAP_IDS = Object.freeze(
  KEYLESS_BASEMAPS.map((record) => record.id),
);

const byId = new Map(KEYLESS_BASEMAPS.map((record) => [record.id, record]));

/** The record for a MAP_STACKS id, or null for the upstream sources. */
export function keylessBasemapRecord(id) {
  return byId.get(id) || null;
}

/** The `MAP_STACKS` descriptor for one record (see catalog.js). */
export function keylessBasemapDescriptor(record) {
  return {
    id: record.id,
    label: record.label,
    shortLabel: record.shortLabel,
    kind: 'keyless-basemap',
    requiresIon: false,
    group: record.group,
    note: record.note,
    luminance: record.luminance,
  };
}
