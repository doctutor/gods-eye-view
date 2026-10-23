/**
 * Personal fork: the Custom cutouts draw mode on the scene. While it runs:
 *
 * - it holds the shared pointer (src/data/inputOwnership.js), so no layer's
 *   click acts on the map, and borrows the Viewer's stock LEFT_CLICK and
 *   LEFT_DOUBLE_CLICK (entity select and track), as the annotation Draw
 *   tool does;
 * - the camera gives up the left button: a click never starts a pan, while
 *   right-drag pans, middle-drag tilts and the wheel zooms;
 * - a left click picks the surface point (the app's depth-aware pick, so a
 *   corner lands on Google's ground or roof) and adds a corner; Enter
 *   finishes, Escape cancels, Backspace undoes. The click is taken from
 *   the press and the release on the map (LEFT_DOWN, LEFT_UP), not from
 *   Cesium's LEFT_CLICK, which drops a click that moved more than 5 px: a
 *   left drag does nothing here, so a press that wobbles up to
 *   CLICK_TOLERANCE_PX still adds its corner, and a longer drag adds none;
 *   a press that began off the map (on the panel) never counts;
 * - the open outline is drawn live, with a dot at each corner.
 *
 * Every way out (finish, cancel, the layer off or destroyed) runs one
 * stop(), which gives back the pointer, the clicks and the camera's five
 * event-type lists exactly as they were. Cesium, the pick and the document
 * are injected, so tests run it against stubs.
 */
import * as Cesium from 'cesium';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { createDrawState } from './drawState.js';

export const CUTOUT_DRAW_POINTER_OWNER = 'cutouts-draw';
/** A click this close (px) to the first corner closes the ring. */
export const CLOSE_RADIUS_PX = 10;
/** A press and release at most this far apart (px) is a click. */
export const CLICK_TOLERANCE_PX = 12;
/** The camera controller's input lists draw mode changes (and gives back). */
export const CAMERA_EVENT_PROPERTIES = Object.freeze([
  'rotateEventTypes',
  'translateEventTypes',
  'zoomEventTypes',
  'tiltEventTypes',
  'lookEventTypes',
]);

const asList = (value) =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
const eventKind = (entry) =>
  entry && typeof entry === 'object' ? entry.eventType : entry;

/**
 * The camera's input lists for draw mode: no left drag anywhere (bare or
 * with a modifier), pan on the right drag, zoom kept on the wheel and pinch
 * (not the right drag, now the pan), tilt kept on the middle drag.
 */
export function drawCameraEventTypes(saved, cameraEventType) {
  const { LEFT_DRAG, RIGHT_DRAG } = cameraEventType;
  const without = (value, kinds) =>
    asList(value).filter((entry) => !kinds.includes(eventKind(entry)));
  return {
    rotateEventTypes: [RIGHT_DRAG],
    translateEventTypes: [RIGHT_DRAG],
    zoomEventTypes: without(saved.zoomEventTypes, [LEFT_DRAG, RIGHT_DRAG]),
    tiltEventTypes: without(saved.tiltEventTypes, [LEFT_DRAG]),
    lookEventTypes: without(saved.lookEventTypes, [LEFT_DRAG]),
  };
}

const editable = (target) =>
  Boolean(
    target &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );

/**
 * @param {{
 *   viewer: object,
 *   pick: (viewer: object, nx: number, ny: number) => ({lat: number, lon: number, height?: number}|null),
 *   cesium?: object,
 *   doc?: Document,
 *   onChange?: Function,
 *   onFinish?: (key: string) => void,
 *   claim?: Function,
 *   release?: Function,
 * }} options
 */
export function createCutoutDrawer({
  viewer,
  pick,
  cesium = Cesium,
  doc = globalThis.document,
  onChange = () => {},
  onFinish = () => {},
  claim = claimPointer,
  release = releasePointer,
}) {
  let state = null;
  let lease = null;
  let handler = null;
  let savedCamera = null;
  let savedClick = null;
  let savedDoubleClick = null;
  let lines = null;
  let dots = null;
  let cursor = null;
  /** Where the left button went down on the map, until it comes up. */
  let pressAt = null;
  /** The last refusal to start ('pointer', or the caller's). */
  let startReason = '';

  const scene = () => viewer?.scene;
  const changed = () => {
    try {
      onChange();
    } catch {
      /* the panel's problem */
    }
  };

  const toCartesian = ({ lon, lat, height = 0 }) =>
    cesium.Cartesian3.fromDegrees(lon, lat, height);

  function drawPreview() {
    const corners = state?.view().corners || [];
    if (lines) {
      const path = corners.map(toCartesian);
      if (cursor && corners.length) path.push(toCartesian(cursor));
      if (path.length >= 2) {
        lines.line.positions = path;
        lines.line.show = true;
      } else lines.line.show = false;
    }
    if (dots) {
      dots.removeAll();
      corners.forEach((corner, index) =>
        dots.add({
          position: toCartesian(corner),
          // The first corner is larger: a click on it closes the ring.
          pixelSize: index === 0 ? 10 : 7,
          color: cesium.Color.WHITE,
          outlineColor: cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    scene()?.requestRender?.();
  }

  function pickAt(position) {
    const canvas = scene()?.canvas;
    const width = canvas?.clientWidth || canvas?.width || 1;
    const height = canvas?.clientHeight || canvas?.height || 1;
    try {
      return pick(viewer, position.x / width, position.y / height) || null;
    } catch {
      return null;
    }
  }

  function nearFirst(position) {
    const first = state?.view().corners[0];
    if (!first) return false;
    try {
      const at = cesium.SceneTransforms.worldToWindowCoordinates(
        scene(),
        toCartesian(first),
      );
      return Boolean(
        at &&
        Math.hypot(at.x - position.x, at.y - position.y) <= CLOSE_RADIUS_PX,
      );
    } catch {
      return false;
    }
  }

  function done(key) {
    stop();
    try {
      onFinish(key);
    } catch {
      /* the layer's problem */
    }
    changed();
  }

  const onClick = (position) => {
    if (!state) return;
    const closing = nearFirst(position);
    const point = closing ? null : pickAt(position);
    const answer = state.click(point, { nearFirst: closing });
    if (answer.result === 'finished') return done(answer.key);
    drawPreview();
    changed();
  };

  // Cesium reuses its event objects: the press point is copied.
  const onDown = (event) => {
    pressAt =
      state && event?.position
        ? { x: event.position.x, y: event.position.y }
        : null;
  };

  const onUp = (event) => {
    const start = pressAt;
    pressAt = null;
    if (!state || !start || !event?.position) return;
    const moved = Math.hypot(
      event.position.x - start.x,
      event.position.y - start.y,
    );
    // A drag: nothing added, nothing said.
    if (moved > CLICK_TOLERANCE_PX) return;
    // The corner goes where the button went down: where it was aimed.
    onClick(start);
  };

  const onMove = (event) => {
    if (!state || !event?.endPosition) return;
    cursor = pickAt(event.endPosition);
    drawPreview();
  };

  const onKey = (event) => {
    if (!state) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (editable(event.target)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      finish();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      undo();
    }
  };

  function start() {
    if (state) return { ok: true };
    startReason = '';
    const sc = scene();
    if (!sc?.screenSpaceCameraController || !sc.canvas) {
      startReason = 'no-scene';
      return { ok: false, reason: startReason };
    }
    lease = claim(CUTOUT_DRAW_POINTER_OWNER);
    if (!lease) {
      startReason = 'pointer';
      return { ok: false, reason: startReason };
    }
    state = createDrawState();
    cursor = null;
    const camera = sc.screenSpaceCameraController;
    savedCamera = {};
    for (const key of CAMERA_EVENT_PROPERTIES) savedCamera[key] = camera[key];
    Object.assign(
      camera,
      drawCameraEventTypes(savedCamera, cesium.CameraEventType),
    );
    const type = cesium.ScreenSpaceEventType;
    const stock = viewer.screenSpaceEventHandler;
    if (stock) {
      savedClick = stock.getInputAction(type.LEFT_CLICK) || null;
      savedDoubleClick = stock.getInputAction(type.LEFT_DOUBLE_CLICK) || null;
      stock.removeInputAction(type.LEFT_CLICK);
      stock.removeInputAction(type.LEFT_DOUBLE_CLICK);
    }
    handler = new cesium.ScreenSpaceEventHandler(sc.canvas);
    // No LEFT_CLICK of its own: it would add the corner a second time.
    handler.setInputAction(onDown, type.LEFT_DOWN);
    handler.setInputAction(onUp, type.LEFT_UP);
    handler.setInputAction(onMove, type.MOUSE_MOVE);
    doc?.addEventListener?.('keydown', onKey, true);
    lines = new cesium.PolylineCollection();
    lines.line = lines.add({
      positions: [],
      width: 2,
      show: false,
      material: cesium.Material.fromType('Color', {
        color: cesium.Color.YELLOW,
      }),
    });
    dots = new cesium.PointPrimitiveCollection();
    sc.primitives.add(lines);
    sc.primitives.add(dots);
    drawPreview();
    changed();
    return { ok: true };
  }

  /** Give everything back; safe to call any number of times. */
  function stop() {
    if (!state && !lease && !handler && !savedCamera) return;
    const sc = scene();
    doc?.removeEventListener?.('keydown', onKey, true);
    if (handler) {
      try {
        handler.destroy();
      } catch {
        /* already gone with the scene */
      }
      handler = null;
    }
    const type = cesium.ScreenSpaceEventType;
    const stock = viewer?.screenSpaceEventHandler;
    if (stock && !stock.isDestroyed?.()) {
      if (savedClick) stock.setInputAction(savedClick, type.LEFT_CLICK);
      if (savedDoubleClick)
        stock.setInputAction(savedDoubleClick, type.LEFT_DOUBLE_CLICK);
    }
    savedClick = null;
    savedDoubleClick = null;
    const camera = sc?.screenSpaceCameraController;
    if (camera && savedCamera)
      for (const key of CAMERA_EVENT_PROPERTIES) camera[key] = savedCamera[key];
    savedCamera = null;
    for (const preview of [lines, dots])
      if (preview && sc?.primitives && !preview.isDestroyed?.())
        sc.primitives.remove(preview);
    lines = null;
    dots = null;
    cursor = null;
    pressAt = null;
    release(lease);
    lease = null;
    state = null;
    sc?.requestRender?.();
  }

  function undo() {
    if (!state?.undo()) return false;
    drawPreview();
    changed();
    return true;
  }

  function finish() {
    if (!state) return { done: false, reason: 'not-drawing' };
    const answer = state.finish();
    if (answer.done) done(answer.key);
    else changed();
    return answer;
  }

  function cancel() {
    if (!state) return;
    state.cancel();
    stop();
    changed();
  }

  return {
    start,
    stop,
    undo,
    finish,
    cancel,
    /** What the panel shows: drawing or not, corners, the cap, a refusal. */
    view() {
      const now = state?.view();
      return {
        drawing: Boolean(state),
        count: now?.count || 0,
        max: now?.max || 0,
        reason: now?.reason || startReason,
      };
    },
    /** For tests: the state machine and the input this has borrowed. */
    _state: () => ({ state, lease, handler, savedCamera }),
  };
}
