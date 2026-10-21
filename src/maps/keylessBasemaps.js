// Personal fork: imagery providers for the keyless basemap records
// (keylessBasemapCatalog.js), and the registry entries defaultSources.js
// hands the map controller. Every network style falls back to OSM, at
// construction and after two failed tiles, exactly as Esri does upstream.

import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';
import { basemapKeys, keylessBasemapRecord } from './keylessBasemapCatalog.js';

const GIBS_SUBDOMAINS = ['a', 'b', 'c'];
const STADIA_TILES = 'https://tiles.stadiamaps.com/tiles';

/**
 * The optional Stadia Maps key. Stadia serves Stamen tiles to localhost
 * without one; a key (STADIA_MAPS_API_KEY in .env, injected by build/vite.js
 * like MAPILLARY_CLIENT_TOKEN) lets the styles work from any origin. It is
 * read once per call and never logged.
 */
export function stadiaMapsKey(env = import.meta.env) {
  return String(env?.STADIA_MAPS_API_KEY || '').trim();
}

/**
 * The static GIBS WMTS template for a layer without a time dimension; the
 * Recent Imagery layer uses the same host and `{z}/{y}/{x}` order with a day.
 */
export function gibsStaticTemplate(layer, format, maximumLevel) {
  return `https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/GoogleMapsCompatible_Level${maximumLevel}/{z}/{y}/{x}.${format}`;
}

/** A tile template with an optional key appended as ?param= (or &param=). */
export function withTileKey(url, param, key = '') {
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(key)}`;
}

/** The Stadia tile template for a style, with the key appended when set. */
export function stadiaTemplate(style, format, key = '') {
  const base = `${STADIA_TILES}/${style}/{z}/{x}/{y}.${format}`;
  return key ? `${base}?api_key=${encodeURIComponent(key)}` : base;
}

/**
 * Build the imagery provider for one record. Blank styles have none and
 * resolve to null: the controller then paints the globe `globeBaseColor`.
 * @param {object} record A KEYLESS_BASEMAPS entry.
 * @param {{ cesium?: object, stadiaKey?: string, keys?: Record<string, string> }} [options]
 *   `keys`: the optional keys of 'xyz' styles (basemapKeys(): CARTO's).
 * @returns {Promise<object | null>}
 */
export async function createKeylessBasemapImagery(
  record,
  { cesium = Cesium, stadiaKey = stadiaMapsKey(), keys = basemapKeys() } = {},
) {
  const { tiles } = record;
  const credit = record.credit || undefined;
  switch (tiles.type) {
    case 'blank':
      return null;
    case 'bundled':
      return cesium.TileMapServiceImageryProvider.fromUrl(
        cesium.buildModuleUrl(tiles.asset),
        { maximumLevel: tiles.maximumLevel, credit },
      );
    case 'xyz':
      return new cesium.UrlTemplateImageryProvider({
        url: tiles.key
          ? withTileKey(tiles.url, tiles.key.param, keys[tiles.key.name])
          : tiles.url,
        subdomains: tiles.subdomains,
        minimumLevel: 0,
        maximumLevel: tiles.maximumLevel,
        tilingScheme: new cesium.WebMercatorTilingScheme(),
        credit,
        hasAlphaChannel: tiles.alpha !== false,
      });
    case 'gibs':
      return new cesium.UrlTemplateImageryProvider({
        url: gibsStaticTemplate(tiles.layer, tiles.format, tiles.maximumLevel),
        subdomains: GIBS_SUBDOMAINS,
        minimumLevel: 0,
        maximumLevel: tiles.maximumLevel,
        tilingScheme: new cesium.WebMercatorTilingScheme(),
        credit,
        hasAlphaChannel: tiles.format === 'png',
      });
    case 'stadia':
      return new cesium.UrlTemplateImageryProvider({
        url: stadiaTemplate(tiles.style, tiles.format, stadiaKey),
        minimumLevel: 0,
        maximumLevel: tiles.maximumLevel,
        tilingScheme: new cesium.WebMercatorTilingScheme(),
        credit,
        hasAlphaChannel: tiles.alpha !== false,
      });
    default:
      throw new TypeError(`Unknown keyless basemap tiles: ${tiles.type}`);
  }
}

/** Whether a record asks a network host for tiles (blank and bundled do not). */
export function keylessBasemapUsesNetwork(record) {
  return !['blank', 'bundled'].includes(record.tiles.type);
}

/**
 * The map-source registry entry for one keyless descriptor.
 * @param {object} descriptor The MAP_STACKS descriptor (kind 'keyless-basemap').
 * @param {{ terrain: object, cesium?: object }} options The globe terrain
 *   every 2D stack shares, and the Cesium namespace (tests pass a stand-in).
 */
export function keylessBasemapSource(descriptor, { terrain, cesium = Cesium }) {
  const record = keylessBasemapRecord(descriptor.id);
  if (!record) throw new TypeError(`Unknown keyless basemap: ${descriptor.id}`);
  const label = record.label;
  const fallbacks = keylessBasemapUsesNetwork(record)
    ? {
        constructionFallback: {
          id: 'osm',
          message: t('{label} is unavailable; using OSM', { label }),
        },
        tileFailureFallback: {
          id: 'osm',
          threshold: 2,
          message: t('{label} tile requests failed; using OSM', { label }),
        },
      }
    : record.tiles.type === 'bundled'
      ? {
          constructionFallback: {
            id: 'osm',
            message: t('{label} is unavailable; using OSM', { label }),
          },
        }
      : {};
  const blank = record.tiles.type === 'blank';
  return {
    descriptor,
    available: true,
    unavailableReason: null,
    imagery: () => createKeylessBasemapImagery(record, { cesium }),
    terrain,
    credit: record.credit,
    ...(blank
      ? {
          globeBaseColor: new cesium.Color(...record.tiles.baseColor, 1),
        }
      : {}),
    ...fallbacks,
  };
}
