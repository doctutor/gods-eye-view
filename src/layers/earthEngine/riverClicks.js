import {
  riverHeightForCanvas,
  riverOrdersAt,
} from '../../data/earthEngineLayers.js';
import {
  attachReachClicks,
  attachReachHighlight,
} from '../rivers/reachHighlight.js';

/**
 * Personal fork: the Rivers layer's clicks (src/layers/rivers/
 * reachHighlight.js). While the layer is on, a click on the map finds the
 * reach there and traces it to the sea; the size limit is the orders the
 * layer draws at the camera's height (riverOrdersAt, on a canvas of this
 * size: 3 from orbit, every order close in), so a click picks a river that
 * is on screen. Off, the
 * highlight, the card and the click handler go.
 *
 * The lookup is HydroRIVERS v1's (server/providers/riverReach.js). Over the
 * Americas the lines are HydroSHEDS v2's, which draws streams v1 does not
 * have (every 1 km² basin against v1's 10 km²) and draws them where they
 * are, where v1's coarser lines can run a few hundred metres off: while the
 * layer draws v2 (`v2Drawn`, from enable's options), a click asks for v2's
 * line too, and the highlight is that line, with v1's reach for the card's
 * details and the paths up and down stream.
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
    enable(viewer, { v2Drawn = () => false } = {}) {
      if (highlight || !viewer?.scene) return;
      highlight = attachHighlight({
        viewer,
        overlays: overlayHost,
        picking,
        requestRender,
        visibleLines: () => v2Drawn() === true,
      });
      detachClicks = attachClicks({
        viewer,
        highlight,
        picking,
        isPointerFree,
        // The orders drawn: the band picked for this canvas's size.
        maxOrder: (heightM) =>
          riverOrdersAt(
            riverHeightForCanvas(
              heightM,
              viewer.scene.canvas?.clientWidth,
              viewer.scene.canvas?.clientHeight,
            ),
          ),
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
