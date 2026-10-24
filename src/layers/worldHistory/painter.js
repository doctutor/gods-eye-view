/**
 * Personal fork: the World history layer's fills as a Cesium imagery
 * provider that paints its own tiles. Each tile is a 256 × 256 canvas on
 * which the shapes crossing it are filled and outlined (holes cut by the
 * even-odd rule), so the fills drape wherever imagery does: the globe's
 * blank and 2D maps, and the Google 3D tiles through the imagery host. The
 * frame costs what any imagery layer costs, however many polygons there
 * are; a polygon costs only when a tile it crosses is painted.
 *
 * Shapes overlapping on one tile are composited there (source-over), each
 * with its own translucent colour, so the comparison list's overlaps read
 * as a mix of the entries' colours; the list's layer alpha is then the
 * panel's opacity.
 *
 * It implements what ImageryLayer reads of a provider in Cesium 1.138 (as
 * the Wikipedia coverage painter does). Cesium and the canvas are injected,
 * so tests paint on a recording context.
 */
import * as Cesium from 'cesium';
import { rgba } from '../../data/worldHistory.js';

export const TILE_SIZE = 256;
export const MAXIMUM_LEVEL = 10;

/** The served level of detail a tile level paints: coarse when far out. */
export const lodForLevel = (level) => (level <= 2 ? 0 : level <= 4 ? 1 : 2);

function documentCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const crosses = (box, rect) =>
  box[0] <= rect.east &&
  box[2] >= rect.west &&
  box[1] <= rect.north &&
  box[3] >= rect.south;

/**
 * Paint shapes on a tile's context. A shape is {polygons (decoded: rings of
 * lon, lat pairs), box [w, s, e, n], fill [r, g, b], fillAlpha, stroke
 * [r, g, b], strokeAlpha, strokeWidth}; `rect` the tile in degrees.
 * @returns {number} the shapes painted
 */
export function paintShapes(context, shapes, rect, size = TILE_SIZE) {
  const sx = size / (rect.east - rect.west);
  const sy = size / (rect.north - rect.south);
  let painted = 0;
  for (const shape of shapes) {
    if (!shape.box || !crosses(shape.box, rect)) continue;
    context.beginPath();
    let any = false;
    for (const rings of shape.polygons)
      for (const ring of rings) {
        let lastX = NaN;
        let lastY = NaN;
        let count = 0;
        for (let i = 0; i + 1 < ring.length; i += 2) {
          const x = (ring[i] - rect.west) * sx;
          const y = (rect.north - ring[i + 1]) * sy;
          // Points under half a pixel apart add nothing.
          if (count && Math.abs(x - lastX) < 0.5 && Math.abs(y - lastY) < 0.5)
            continue;
          if (count) context.lineTo(x, y);
          else context.moveTo(x, y);
          lastX = x;
          lastY = y;
          count++;
        }
        if (count >= 3) {
          context.closePath();
          any = true;
        }
      }
    if (!any) continue;
    if (shape.fillAlpha > 0) {
      context.fillStyle = rgba(shape.fill, shape.fillAlpha);
      context.fill('evenodd');
    }
    if (shape.strokeWidth > 0 && shape.strokeAlpha > 0) {
      context.lineWidth = shape.strokeWidth;
      context.lineJoin = 'round';
      context.strokeStyle = rgba(shape.stroke || shape.fill, shape.strokeAlpha);
      context.stroke();
    }
    painted++;
  }
  return painted;
}

/**
 * @param {{shapes: (lod: number) => Promise<object[]>, cesium?: object,
 *   maximumLevel?: number, createCanvas?: Function}} options
 *   `shapes(lod)` the shapes at a served level of detail.
 */
export function createWorldHistoryImageryProvider({
  shapes,
  cesium = Cesium,
  maximumLevel = MAXIMUM_LEVEL,
  createCanvas = documentCanvas,
}) {
  const tilingScheme = new cesium.GeographicTilingScheme();
  const stats = { requested: 0, painted: 0, empty: 0, failed: 0 };
  let blank = null;
  const toDegrees = (radians) => (radians * 180) / Math.PI;

  return {
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    credit: undefined,
    hasAlphaChannel: true,
    errorEvent: new cesium.Event(),
    proxy: undefined,
    tileDiscardPolicy: undefined,
    stats,

    getTileCredits() {
      return undefined;
    },

    requestImage(x, y, level) {
      stats.requested += 1;
      const r = tilingScheme.tileXYToRectangle(x, y, level);
      const rect = {
        west: toDegrees(r.west),
        south: toDegrees(r.south),
        east: toDegrees(r.east),
        north: toDegrees(r.north),
      };
      return Promise.resolve(shapes(lodForLevel(level))).then(
        (list) => {
          const crossing = (list || []).filter(
            (shape) => shape.box && crosses(shape.box, rect),
          );
          if (!crossing.length) {
            stats.empty += 1;
            blank ||= createCanvas(1, 1);
            return blank;
          }
          const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
          const painted = paintShapes(canvas.getContext('2d'), crossing, rect);
          stats[painted ? 'painted' : 'empty'] += 1;
          return canvas;
        },
        (error) => {
          stats.failed += 1;
          throw error;
        },
      );
    },

    pickFeatures() {
      return undefined;
    },
  };
}
