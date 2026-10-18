// Personal fork: the Wikipedia coverage layer's Hexes mode. Instead of the
// raster, H3 cells coloured by the chosen variant on the same inferno ramp,
// drawn as ground-clamped polygons (GroundPrimitive, classification BOTH)
// so they drape on terrain and on the photoreal tileset alike. The cells
// and their values come from the server's /api/wikipedia-coverage/h3
// endpoint for the view window (maps/h3Cells.js) at the resolution the
// camera height picks (maps/h3Resolution.js).

import * as Cesium from 'cesium';
import { cellRing } from '../../maps/h3Cells.js';
import { rampColor, rampPosition } from './ramp.js';

/** The most cells one request draws; the server refuses more with a 413. */
export const HEX_MAX_CELLS = 20_000;

/**
 * The ramp colour of a value as a Cesium colour at an opacity, or null when
 * the value draws nothing.
 */
export function cellColor(value, domain, opacity, cesium = Cesium) {
  const position = rampPosition(value, domain);
  if (!Number.isFinite(position)) return null;
  const [r, g, b, a] = rampColor(position);
  return new cesium.Color(r / 255, g / 255, b / 255, (a / 255) * opacity);
}

/**
 * One drawn hex surface: a GroundPrimitive of the cells, recoloured in
 * place for a new opacity once it is ready.
 * @param {{ cells: Array<[string, number]>, domain: {min: number, max: number}, opacity: number, cesium?: object }} options
 */
export function createHexSurface({ cells, domain, opacity, cesium = Cesium }) {
  const colours = new Map();
  const instances = [];
  for (const [cell, value] of cells) {
    const colour = cellColor(value, domain, opacity, cesium);
    if (!colour) continue;
    const ring = cellRing(cell);
    if (ring.length < 3) continue;
    colours.set(cell, colour.withAlpha(colour.alpha / opacity || 0));
    instances.push(
      new cesium.GeometryInstance({
        id: cell,
        geometry: new cesium.PolygonGeometry({
          polygonHierarchy: new cesium.PolygonHierarchy(
            cesium.Cartesian3.fromDegreesArray(ring.flat()),
          ),
          vertexFormat: cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: cesium.ColorGeometryInstanceAttribute.fromColor(colour),
        },
      }),
    );
  }
  const primitive = instances.length
    ? new cesium.GroundPrimitive({
        geometryInstances: instances,
        appearance: new cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        classificationType: cesium.ClassificationType.BOTH,
        allowPicking: false,
        asynchronous: true,
        // Kept: the instances' attributes are updated for a new opacity.
        releaseGeometryInstances: false,
      })
    : null;
  let _opacity = opacity;
  return {
    primitive,
    count: instances.length,
    /**
     * Repaint for a new opacity. Returns false when the primitive is not
     * ready yet (the caller rebuilds instead).
     */
    setOpacity(value) {
      _opacity = value;
      if (!primitive) return true;
      if (!primitive.ready) return false;
      for (const [cell, base] of colours) {
        const attributes = primitive.getGeometryInstanceAttributes(cell);
        if (!attributes) return false;
        attributes.color = cesium.ColorGeometryInstanceAttribute.toValue(
          base.withAlpha(base.alpha * value),
        );
      }
      return true;
    },
    getOpacity: () => _opacity,
  };
}

/** The resolution to ask for after a 413: one step down, or none at 0. */
export function fallbackResolution(res) {
  return res > 0 ? res - 1 : null;
}
