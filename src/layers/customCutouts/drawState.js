/**
 * Personal fork: the Custom cutouts draw mode's state, pure. Each click adds
 * a corner at the picked point; UNDO (or Backspace) takes the last one back;
 * FINISH (or Enter, or a click on the first corner) closes the ring once it
 * has three corners and does not cross itself; CANCEL (or Escape) drops it.
 * Corners are kept at the 1e-6° the URL keeps them at, so the ring checked
 * here is the ring the key holds. ./drawInput.js feeds it from the scene.
 */
import {
  DRAW_MAX_VERTICES,
  encodeDrawnRing,
  pathSelfIntersects,
  ringSelfIntersects,
} from '../../data/customCutouts.js';

const round = (degrees) => Math.round(degrees * 1e6) / 1e6;

/**
 * Why a click or a finish was refused, as the panel words it:
 * 'too-few' (under 3 corners), 'crosses' (the outline would cross itself),
 * 'cap' (DRAW_MAX_VERTICES reached).
 * @param {{max?: number}} [options]
 */
export function createDrawState({ max = DRAW_MAX_VERTICES } = {}) {
  /** Corners {lon, lat, height}, in click order. */
  const corners = [];
  /** 'drawing' | 'finished' | 'cancelled' */
  let status = 'drawing';
  let reason = '';
  let key = '';

  const ring = () => corners.map(({ lon, lat }) => [lon, lat]);

  function finish() {
    if (status !== 'drawing') return { done: false, reason: 'not-drawing' };
    reason = '';
    if (corners.length < 3) reason = 'too-few';
    else if (ringSelfIntersects(ring())) reason = 'crosses';
    if (reason) return { done: false, reason };
    key = encodeDrawnRing(ring()) || '';
    if (!key) {
      reason = 'cap';
      return { done: false, reason };
    }
    status = 'finished';
    return { done: true, key, ring: ring() };
  }

  return {
    /**
     * A click at a picked point ({lat, lon, height}), `nearFirst` when it
     * landed on the first corner (the ring closes there).
     * @returns {{result: 'added'|'finished'|'refused'|'ignored', reason?: string, key?: string}}
     */
    click(point, { nearFirst = false } = {}) {
      if (status !== 'drawing') return { result: 'ignored' };
      if (nearFirst && corners.length) {
        if (corners.length < 3) {
          reason = 'too-few';
          return { result: 'refused', reason };
        }
        const closed = finish();
        return closed.done
          ? { result: 'finished', key: closed.key }
          : { result: 'refused', reason: closed.reason };
      }
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon))
        return { result: 'ignored' };
      const corner = {
        lon: round(point.lon),
        lat: round(point.lat),
        height: Number.isFinite(point.height) ? point.height : 0,
      };
      const last = corners.at(-1);
      // A double click lands twice on one spot: one corner.
      if (last && last.lon === corner.lon && last.lat === corner.lat)
        return { result: 'ignored' };
      if (corners.length >= max) {
        reason = 'cap';
        return { result: 'refused', reason };
      }
      if (pathSelfIntersects([...ring(), [corner.lon, corner.lat]])) {
        reason = 'crosses';
        return { result: 'refused', reason };
      }
      corners.push(corner);
      reason = corners.length >= max ? 'cap' : '';
      return { result: 'added' };
    },

    /** Take the last corner back; false when there is none. */
    undo() {
      if (status !== 'drawing' || !corners.length) return false;
      corners.pop();
      reason = '';
      return true;
    },

    finish,

    /** Drop the drawing: nothing is added. */
    cancel() {
      if (status === 'drawing') status = 'cancelled';
      corners.length = 0;
      reason = '';
    },

    /** What the panel and the preview draw. */
    view: () => ({
      status,
      count: corners.length,
      max,
      reason,
      key,
      corners: corners.map((corner) => ({ ...corner })),
    }),
  };
}
