import * as Cesium from 'cesium';
import { paintTile } from './ramp.js';
import { decodeTile, tileUrl } from './source.js';

/**
 * Personal fork: a Cesium imagery provider that paints the Wikipedia
 * coverage tiles itself. Each tile's bytes are the server's Float32 cell
 * values; they are coloured on a 256 × 256 canvas with the variant's log
 * ramp (ramp.js) and handed to Cesium as the tile image, so the same
 * values can be drawn with another ramp or domain without another request.
 *
 * It implements what ImageryLayer reads of a provider in Cesium 1.138:
 * tilingScheme, rectangle, tileWidth/Height, minimum/maximumLevel,
 * errorEvent, credit, hasAlphaChannel, tileDiscardPolicy, getTileCredits
 * and requestImage. Requests go through Cesium's Resource so its scheduler
 * can throttle them: an undefined return means "ask again later".
 */

export const TILE_SIZE = 256;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The default tile fetch: Cesium's Resource, so the request can be throttled. */
function cesiumFetch(cesium) {
  return (url, request) => {
    const resource = new cesium.Resource({ url, request });
    return resource.fetchArrayBuffer();
  };
}

/** The default canvas, from the page's document. */
function documentCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {{variant: string, domain: {min: number, max: number},
 *   maximumLevel?: number, credit?: string, cesium?: object,
 *   paintValues?: (values: Float32Array, out: Uint8ClampedArray) => number,
 *   fetchTile?: (url: string, request?: object) => Promise<ArrayBuffer>|undefined,
 *   createCanvas?: (width: number, height: number) => object}} options
 */
export function createCoverageImageryProvider({
  variant,
  domain,
  maximumLevel = 9,
  credit = '',
  cesium = Cesium,
  fetchTile = cesiumFetch(cesium),
  createCanvas = documentCanvas,
  // The colour scale's painter (scale.js); by default the variant's ramp.
  paintValues = (values, out) => paintTile(values, domain, out),
}) {
  const tilingScheme = new cesium.WebMercatorTilingScheme();
  const stats = { requested: 0, painted: 0, empty: 0, failed: 0 };

  /** A tile's values painted on a canvas (the image Cesium textures). */
  function paint(buffer) {
    const { width, height, values } = decodeTile(buffer);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const painted = paintValues(values, image.data);
    context.putImageData(image, 0, 0);
    if (painted) stats.painted += 1;
    else stats.empty += 1;
    return canvas;
  }

  return {
    variant,
    domain,
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    credit: credit ? new cesium.Credit(escapeHtml(credit), false) : undefined,
    hasAlphaChannel: true,
    errorEvent: new cesium.Event(),
    proxy: undefined,
    tileDiscardPolicy: undefined,
    stats,

    getTileCredits() {
      return undefined;
    },

    /**
     * @returns {Promise<object>|undefined} the painted canvas; undefined when
     *   the request was throttled (Cesium asks again).
     */
    requestImage(x, y, level, request) {
      const pending = fetchTile(tileUrl(variant, level, x, y), request);
      if (!pending) return undefined;
      stats.requested += 1;
      return pending.then(paint, (error) => {
        stats.failed += 1;
        throw error;
      });
    },

    pickFeatures() {
      return undefined;
    },
  };
}
