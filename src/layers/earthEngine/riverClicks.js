import { riverOrdersAt } from '../../data/earthEngineLayers.js';
import {
  attachReachClicks,
  attachReachHighlight,
} from '../rivers/reachHighlight.js';

/**
 * Personal fork: the Rivers layer's clicks (src/layers/rivers/
 * reachHighlight.js). While the layer is on, a click on the map finds the
 * reach there and traces it to the sea; the size limit is the orders the
 * layer draws at the camera's height (riverOrdersAt: 3 from orbit, every
 * order below 104 km), so a click picks a river that is on screen. Off, the
 * highlight, the card and the click handler go.
 *
 * The lookup is HydroRIVERS v1's (server/providers/riverReach.js). Over the
 * Americas the lines are HydroSHEDS v2's, which draws streams v1 does not
 * have (every 1 km² basin against v1's 10 km²): a click on one of those
 * finds the nearest v1 reach within the click tolerance, usually the river
 * it flows into, or misses.
 *
 * @param {{overlayHost?: object|null, picking?: object|null,
 *   isPointerFree?: () => boolean, requestRender?: Function,
 *   attachHighlight?: typeof attachReachHighlight,
 *   attachClicks?: typeof attachReachClicks,
 *   credits?: {register?: Function}, credit?: object|null}} [options]
 */
export function createRiverClicks({
  overlayHost = null,
  picking = null,
  isPointerFree = () => true,
  requestRender = () => {},
  attachHighlight = attachReachHighlight,
  attachClicks = attachReachClicks,
  credits = null,
  credit = null,
} = {}) {
  let highlight = null;
  let detachClicks = null;
  return {
    enable(viewer) {
      if (highlight || !viewer?.scene) return;
      highlight = attachHighlight({
        viewer,
        overlays: overlayHost,
        picking,
        requestRender,
      });
      detachClicks = attachClicks({
        viewer,
        highlight,
        picking,
        isPointerFree,
        maxOrder: (heightM) => riverOrdersAt(heightM),
      });
      if (credit) credits?.register?.(viewer, credit);
    },
    disable() {
      detachClicks?.();
      detachClicks = null;
      highlight?.detach();
      highlight = null;
    },
    /** For tests: whether clicks are attached. */
    attached: () => Boolean(highlight),
  };
}
