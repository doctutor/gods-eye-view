/**
 * Personal fork: the walker seen in third person (view.js): a 0.6 × 0.6 ×
 * 1.8 m box in a colour nothing else uses, with a dark outline, standing
 * where the walker stands and turned to its heading. Hidden in first
 * person and outside Walk and Fly.
 *
 * One Primitive built once (synchronously) and moved by its model matrix
 * each frame: an Entity whose position changes every frame has its
 * geometry rebuilt (asynchronously) every frame and is never drawn.
 */
import * as Cesium from 'cesium';
import { MARKER_HEIGHT_M, MARKER_WIDTH_M, markerPose } from './view.js';

export const MARKER_COLOR = '#ff8a1c';
export const MARKER_OUTLINE = '#2a1400';

/** @param {{viewer: object, cesium?: object}} options */
export function createPlayerMarker({ viewer, cesium = Cesium }) {
  const scene = viewer.scene;
  let parts = null;
  const dimensions = () =>
    new cesium.Cartesian3(MARKER_WIDTH_M, MARKER_WIDTH_M, MARKER_HEIGHT_M);
  const make = () => {
    if (parts) return parts;
    const box = new cesium.Primitive({
      geometryInstances: new cesium.GeometryInstance({
        geometry: cesium.BoxGeometry.fromDimensions({
          dimensions: dimensions(),
          vertexFormat: cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: cesium.ColorGeometryInstanceAttribute.fromColor(
            cesium.Color.fromCssColorString(MARKER_COLOR),
          ),
        },
      }),
      appearance: new cesium.PerInstanceColorAppearance({ translucent: false }),
      asynchronous: false,
      show: false,
    });
    const outline = new cesium.Primitive({
      geometryInstances: new cesium.GeometryInstance({
        geometry: cesium.BoxOutlineGeometry.fromDimensions({
          dimensions: dimensions(),
        }),
        attributes: {
          color: cesium.ColorGeometryInstanceAttribute.fromColor(
            cesium.Color.fromCssColorString(MARKER_OUTLINE),
          ),
        },
      }),
      appearance: new cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: false,
      }),
      asynchronous: false,
      show: false,
    });
    scene.primitives.add(box);
    scene.primitives.add(outline);
    parts = { box, outline };
    return parts;
  };
  return {
    /**
     * Stand the marker at the walker: `place(x, y, z)` turns the frame's
     * metres into a Cartesian3 (the binding's frame).
     */
    update(state, place) {
      const { box, outline } = make();
      const pose = markerPose(state);
      const position = place(pose.x, pose.y, pose.z);
      const matrix = cesium.Transforms.headingPitchRollToFixedFrame(
        position,
        new cesium.HeadingPitchRoll(pose.yaw, 0, 0),
      );
      box.modelMatrix = matrix;
      outline.modelMatrix = matrix;
      box.show = true;
      outline.show = true;
    },
    hide() {
      if (!parts) return;
      parts.box.show = false;
      parts.outline.show = false;
    },
    destroy() {
      if (!parts) return;
      for (const primitive of [parts.box, parts.outline])
        if (scene.primitives.contains(primitive))
          scene.primitives.remove(primitive);
      parts = null;
    },
  };
}
