// Personal fork: one drawer for H3 cell surfaces. Cells with a colour each
// become ground-clamped polygons in one GroundPrimitive (classification
// BOTH), so they drape on terrain and on the photoreal tileset alike. The
// Wikipedia coverage layer's Hexes mode and the point rollups draw with it.

import * as Cesium from 'cesium';
import { cellRing } from './h3Cells.js';

/**
 * @param {object} options
 * @param {Iterable<[string, object]>} options.cells H3 index → Cesium colour
 *   (its alpha is the cell's own; the surface opacity multiplies it).
 * @param {number} [options.opacity=1]
 * @param {object} [options.cesium]
 * @param {boolean} [options.allowPicking=false] Pickable, with instance ids
 *   `idPrefix + cell`.
 * @param {string} [options.idPrefix='']
 * @returns {{ primitive: object | null, count: number, setOpacity: (value: number) => boolean, getOpacity: () => number }}
 */
export function createHexSurface({
  cells,
  opacity = 1,
  cesium = Cesium,
  allowPicking = false,
  idPrefix = '',
}) {
  const colours = new Map();
  const instances = [];
  for (const [cell, colour] of cells) {
    if (!colour) continue;
    const ring = cellRing(cell);
    if (ring.length < 3) continue;
    const id = `${idPrefix}${cell}`;
    colours.set(id, colour);
    instances.push(
      new cesium.GeometryInstance({
        id,
        geometry: new cesium.PolygonGeometry({
          polygonHierarchy: new cesium.PolygonHierarchy(
            cesium.Cartesian3.fromDegreesArray(ring.flat()),
          ),
          vertexFormat: cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: cesium.ColorGeometryInstanceAttribute.fromColor(
            colour.withAlpha(colour.alpha * opacity),
          ),
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
        allowPicking,
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
     * ready yet (the caller draws again instead).
     */
    setOpacity(value) {
      _opacity = value;
      if (!primitive) return true;
      if (!primitive.ready) return false;
      for (const [id, base] of colours) {
        const attributes = primitive.getGeometryInstanceAttributes(id);
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
