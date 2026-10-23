/**
 * Personal fork: the Custom cutouts layer's work on the scene. The Google 3D
 * tileset gets a ClippingPolygonCollection of the visible cutouts' rings with
 * `inverse: true`, which keeps only what is inside any of them (Cesium unions
 * a collection's polygons). The globe, shown as the plate beneath
 * (MapSourceController.setPlate), gets the same polygons the other way round
 * (`inverse: false`): it is cut away inside the cutouts, so where the city's
 * ground lies below the bare ellipsoid (the geoid is some 33 m under it at
 * Baltimore) the plate never covers it. A clipped tileset has no side walls,
 * so each ring also gets a thin outline on the ground, which makes the rim
 * read as a cut. Cesium is injected, so tests run it against stubs.
 */
import * as Cesium from 'cesium';

/** The outline's width (px) and its colours on a black and a white plate. */
const OUTLINE_WIDTH = 2;
const OUTLINE_COLORS = Object.freeze({
  black: [1, 1, 1, 0.85],
  white: [0, 0, 0, 0.85],
});

/**
 * @param {{cesium?: object}} [options]
 * @returns {{
 *   supported(scene: object): boolean,
 *   apply(scene: object, tileset: object|null, rings: number[][][], plate: string): void,
 *   clear(): void,
 *   state(): {tileset: object|null, globe: object|null, polygons: number, outlines: number},
 * }}
 */
export function createCutoutClipping({ cesium = Cesium } = {}) {
  let clippedTileset = null;
  let clippedGlobe = null;
  let outlineScene = null;
  let outlines = null;
  let polygonCount = 0;
  let key = '';

  const supported = (scene) => {
    try {
      return Boolean(cesium.ClippingPolygonCollection.isSupported(scene));
    } catch {
      return false;
    }
  };

  function unclip() {
    if (clippedTileset && !clippedTileset.isDestroyed?.())
      // Setting it away destroys the collection (Cesium's setOwner).
      clippedTileset.clippingPolygons = undefined;
    clippedTileset = null;
    if (clippedGlobe && !clippedGlobe.isDestroyed?.())
      clippedGlobe.clippingPolygons = undefined;
    clippedGlobe = null;
    polygonCount = 0;
  }

  function unoutline() {
    if (outlines && outlineScene && !outlines.isDestroyed?.())
      outlineScene.primitives.remove(outlines);
    outlines = null;
    outlineScene = null;
  }

  return {
    supported,

    /**
     * Clip `tileset` to the rings ([lon, lat] each) and outline them, or
     * undo both when there are no rings or no tileset. Calling it again with
     * the same tileset, rings and plate does nothing.
     */
    apply(scene, tileset, rings, plate = 'black') {
      const next = JSON.stringify([plate, rings]);
      if (tileset === clippedTileset && next === key && scene === outlineScene)
        return;
      unclip();
      unoutline();
      key = '';
      if (!tileset || !rings.length || !supported(scene)) return;
      const toPositions = (ring) =>
        cesium.Cartesian3.fromDegreesArray(
          ring.flatMap(([lon, lat]) => [lon, lat]),
        );
      // A collection has one owner: the tileset and the globe get their own.
      const collection = (inverse) =>
        new cesium.ClippingPolygonCollection({
          polygons: rings.map(
            (ring) =>
              new cesium.ClippingPolygon({ positions: toPositions(ring) }),
          ),
          inverse,
        });
      tileset.clippingPolygons = collection(true);
      clippedTileset = tileset;
      if (scene.globe) {
        scene.globe.clippingPolygons = collection(false);
        clippedGlobe = scene.globe;
      }
      polygonCount = rings.length;
      const color = new cesium.Color(
        ...(OUTLINE_COLORS[plate] || OUTLINE_COLORS.black),
      );
      const closed = rings.map((ring) => toPositions([...ring, ring[0]]));
      // On the ground (the plate's terrain, and the cut piece's edge), where
      // the scene can drape lines; else plain lines at the ellipsoid.
      if (cesium.GroundPolylinePrimitive?.isSupported?.(scene)) {
        outlines = new cesium.GroundPolylinePrimitive({
          geometryInstances: closed.map(
            (positions) =>
              new cesium.GeometryInstance({
                geometry: new cesium.GroundPolylineGeometry({
                  positions,
                  width: OUTLINE_WIDTH,
                }),
                attributes: {
                  color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
                },
              }),
          ),
          appearance: new cesium.PolylineColorAppearance(),
        });
        outlines.lineCount = closed.length;
      } else {
        outlines = new cesium.PolylineCollection();
        for (const positions of closed)
          outlines.add({
            positions,
            width: OUTLINE_WIDTH,
            material: cesium.Material.fromType('Color', { color }),
          });
      }
      scene.primitives.add(outlines);
      outlineScene = scene;
      key = next;
    },

    /** Take the clipping and the outlines away (the layer off). */
    clear() {
      unclip();
      unoutline();
      key = '';
    },

    state: () => ({
      tileset: clippedTileset,
      globe: clippedGlobe,
      polygons: polygonCount,
      outlines: outlines ? lineCount(outlines) : 0,
    }),
  };
}

/** Outlines drawn: a PolylineCollection's length, or the ground lines counted. */
const lineCount = (outlines) =>
  typeof outlines.length === 'number'
    ? outlines.length
    : Number(outlines.lineCount) || 0;
