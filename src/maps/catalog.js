import * as Cesium from 'cesium';
// Personal fork: keyless raster basemaps (blank, CARTO, OpenTopoMap, NASA
// GIBS, Stamen via Stadia) follow the five upstream sources.
import {
  KEYLESS_BASEMAPS,
  keylessBasemapDescriptor,
} from './keylessBasemapCatalog.js';
import {
  COUNTRIES_BASEMAPS,
  countriesBasemapDescriptor,
} from './countries/catalog.js';
export const MAP_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D', // i18n-ignore: imagery product name
    shortLabel: '3D',
    kind: 'photoreal',
    requiresIon: false,
    luminance: 'dark', // Personal fork: overlays pick their ink from this (src/maps/ink.js)
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial', // i18n-ignore: imagery product name
    shortLabel: 'Aerial',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
    luminance: 'dark',
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels', // i18n-ignore: imagery product name
    shortLabel: 'Labels',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
    luminance: 'dark',
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite', // i18n-ignore: imagery product name
    shortLabel: 'SAT',
    kind: 'esri-imagery',
    requiresIon: false,
    luminance: 'dark',
  },
  {
    id: 'osm',
    label: 'OSM', // i18n-ignore: imagery product name
    shortLabel: 'OSM',
    kind: 'osm',
    requiresIon: false,
    luminance: 'light',
  },
  // Personal fork: the keyless styles, then the Countries basemap styles.
  ...KEYLESS_BASEMAPS.map((record) => keylessBasemapDescriptor(record)),
  ...COUNTRIES_BASEMAPS.map(countriesBasemapDescriptor),
];
