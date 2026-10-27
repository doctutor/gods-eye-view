/**
 * Personal fork: the walker seen in third person (view.js): a 0.6 × 0.6 ×
 * 1.8 m box in a colour nothing else uses, standing where the walker
 * stands and turned to its heading. Hidden in first person and outside
 * Walk and Fly.
 */
import * as Cesium from 'cesium';
import { MARKER_HEIGHT_M, MARKER_WIDTH_M, markerPose } from './view.js';

export const MARKER_COLOR = '#ff8a1c';
export const MARKER_OUTLINE = '#2a1400';

/** @param {{viewer: object, cesium?: object}} options */
export function createPlayerMarker({ viewer, cesium = Cesium }) {
  let entity = null;
  const make = () => {
    entity ||= viewer.entities.add({
      show: false,
      box: {
        dimensions: new cesium.Cartesian3(
          MARKER_WIDTH_M,
          MARKER_WIDTH_M,
          MARKER_HEIGHT_M,
        ),
        material: cesium.Color.fromCssColorString(MARKER_COLOR),
        outline: true,
        outlineColor: cesium.Color.fromCssColorString(MARKER_OUTLINE),
      },
    });
    return entity;
  };
  return {
    /**
     * Stand the marker at the walker: `place(x, y, z)` turns the frame's
     * metres into a Cartesian3 (the binding's frame).
     */
    update(state, place) {
      const marker = make();
      const pose = markerPose(state);
      const position = place(pose.x, pose.y, pose.z);
      marker.position = position;
      marker.orientation = cesium.Transforms.headingPitchRollQuaternion(
        position,
        new cesium.HeadingPitchRoll(pose.yaw, 0, 0),
      );
      marker.show = true;
    },
    hide() {
      if (entity) entity.show = false;
    },
    destroy() {
      if (entity) viewer.entities.remove(entity);
      entity = null;
    },
  };
}
