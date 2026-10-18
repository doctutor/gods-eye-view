// Personal fork: level of detail for point layers. From orbit a layer's
// thousands of pins crowd and stack; attached to a layer, this rolls them
// up into counts per H3 hexagon at the resolution the camera height
// implies (maps/h3Resolution.js), bounded to the view window
// (maps/h3Cells.js), and resolves back into pins as the view comes in,
// the way the Wikipedia coverage layer's Hexes mode works. The hexes are
// ground-clamped (maps/h3Surface.js), filled in the layer's accent colour
// on a log ramp of their count, labelled with the count through the
// world-overlay host, and a click on one flies the camera to its bounds.
//
// The owning layer keeps its points and its pins; it only hides the pins
// while `onModeChange(true)` holds and shows them again on `false`. Adopt
// it in a few lines:
//
//   const rollup = attachPointRollup(
//     { id: 'my-layer', viewer, overlays, cesium, picking, requestRender },
//     { getPoints: () => records, accent: '#39d5ff',
//       onModeChange: (active) => (pins.show = !active) },
//   );
//   // on moveEnd or when the points change: rollup.refresh()
//   // on disable: rollup.detach()

import * as Cesium from 'cesium';
import { viewMoved, viewWindow } from '../../maps/h3Cells.js';
import { h3ResolutionForHeight } from '../../maps/h3Resolution.js';
import { createHexSurface } from '../../maps/h3Surface.js';
import {
  binPoints,
  cellAlpha,
  cellBox,
  countInWindow,
  labelEntry,
  rollupWanted,
} from './rollup.js';

export const DEFAULT_ROLLUP_ACCENT = '#39d5ff';
/** The fly-to on a hex click, seconds. */
export const ROLLUP_FLY_SECONDS = 1.2;

/**
 * @param {object} layer
 * @param {string} layer.id The owning layer's id (the overlay source is `<id>-rollup`).
 * @param {object} layer.viewer
 * @param {{ setEntries: Function, setVisible: Function, clearSource: Function }} layer.overlays
 *   The world-overlay host (src/overlays/worldOverlay.js, or a layer's wrapper of it).
 * @param {object} [layer.cesium]
 * @param {{ resolvePickId?: Function, registerPickOwner?: Function, unregisterPickOwner?: Function }} [layer.picking]
 * @param {(reason: string) => void} [layer.requestRender]
 * @param {(box: object) => void} [layer.flyTo] Replaces the camera flight (tests).
 * @param {object} options
 * @param {() => Array<{lat: number, lon: number, id?: string}>} options.getPoints
 * @param {string} [options.accent]
 * @param {{ enter?: number, exit?: number, enterHeightM?: number, exitHeightM?: number, minHeightM?: number }} [options.threshold]
 * @param {(active: boolean) => void} [options.onModeChange]
 * @param {() => void} [options.onUpdate] After each redraw or clear (a row readout).
 * @param {boolean} [options.enabled=true]
 */
export function attachPointRollup(
  {
    id,
    viewer,
    overlays,
    cesium = Cesium,
    picking = null,
    requestRender = () => {},
    flyTo = null,
  },
  {
    getPoints,
    accent = DEFAULT_ROLLUP_ACCENT,
    threshold = {},
    onModeChange = () => {},
    onUpdate = () => {},
    enabled = true,
  },
) {
  if (!id || typeof getPoints !== 'function')
    throw new TypeError('A point rollup needs a layer id and getPoints');
  const sourceId = `${id}-rollup`;
  const pickPrefix = `rollup:${id}:`;
  let _enabled = enabled !== false;
  let _active = false;
  let _madeFor = null;
  let _surface = null;
  let _cells = new Map();
  let _inView = 0;
  let _destroyed = false;
  let _removeMove = null;
  let _handler = null;

  function viewNow() {
    const camera = viewer?.camera;
    const canvas = viewer?.scene?.canvas;
    let point = null;
    try {
      const centre =
        canvas && camera?.pickEllipsoid
          ? camera.pickEllipsoid(
              new cesium.Cartesian2(
                canvas.clientWidth / 2,
                canvas.clientHeight / 2,
              ),
            )
          : null;
      if (centre) point = cesium.Cartographic.fromCartesian(centre);
    } catch {
      /* no pick: under the camera */
    }
    point ||= camera?.positionCartographic || null;
    const degrees = (radians) =>
      Number.isFinite(radians) ? cesium.Math.toDegrees(radians) : 0;
    const height = camera?.positionCartographic?.height;
    return {
      lat: degrees(point?.latitude),
      lon: degrees(point?.longitude),
      heightM: Number.isFinite(height) ? height : Infinity,
    };
  }

  function removeSurface() {
    if (_surface?.primitive) {
      try {
        viewer?.scene?.primitives?.remove(_surface.primitive);
      } catch {
        /* already gone with the scene */
      }
    }
    _surface = null;
  }

  function setActive(active) {
    if (_active === active) return;
    _active = active;
    try {
      onModeChange(active);
    } catch (error) {
      console.warn(`[PointRollup] ${id} mode listener failed:`, error);
    }
  }

  function notifyUpdate() {
    try {
      onUpdate();
    } catch (error) {
      console.warn(`[PointRollup] ${id} update listener failed:`, error);
    }
  }

  function deactivate() {
    const had = _surface || _cells.size;
    removeSurface();
    _cells = new Map();
    _madeFor = null;
    try {
      overlays?.clearSource?.(sourceId);
      overlays?.setVisible?.(sourceId, false);
    } catch {
      /* the host is gone */
    }
    setActive(false);
    if (had) {
      requestRender('point-rollup-clear');
      notifyUpdate();
    }
  }

  function flyToCell(cell) {
    const box = cellBox(cell);
    if (typeof flyTo === 'function') return flyTo(box, cell);
    const camera = viewer?.camera;
    if (!camera?.flyTo || !cesium.Rectangle?.fromDegrees) return;
    camera.flyTo({
      destination: cesium.Rectangle.fromDegrees(
        box.west,
        box.south,
        box.east,
        box.north,
      ),
      duration: ROLLUP_FLY_SECONDS,
    });
  }

  function build(points, window, res, view) {
    const bins = binPoints(points, res, window);
    let max = 0;
    for (const count of bins.values()) if (count > max) max = count;
    const base = cesium.Color.fromCssColorString(accent);
    const coloured = [];
    const entries = [];
    for (const [cell, count] of bins) {
      coloured.push([cell, base.withAlpha(cellAlpha(count, max))]);
      entries.push(
        labelEntry({
          cell,
          count,
          accent,
          cesium,
          activate: () => flyToCell(cell),
          accessibilityLabel: `${count} ${id}`,
        }),
      );
    }
    removeSurface();
    _surface = createHexSurface({
      cells: coloured,
      cesium,
      allowPicking: true,
      idPrefix: pickPrefix,
    });
    if (_surface.primitive) viewer?.scene?.primitives?.add(_surface.primitive);
    _cells = bins;
    try {
      overlays?.setEntries?.(sourceId, entries);
      overlays?.setVisible?.(sourceId, true);
    } catch (error) {
      console.warn(`[PointRollup] ${id} labels failed:`, error);
    }
    _madeFor = { ...view, res, points: points.length };
    setActive(true);
    requestRender('point-rollup');
    notifyUpdate();
  }

  /** Decide, and draw or clear, for the current view and points. */
  function refresh({ force = false } = {}) {
    if (_destroyed) return;
    if (!_enabled) {
      deactivate();
      return;
    }
    const view = viewNow();
    // No camera to read a height from: nothing to decide, the pins stand.
    if (!Number.isFinite(view.heightM)) {
      deactivate();
      return;
    }
    const points = getPoints() || [];
    const window = viewWindow(view.lat, view.lon, view.heightM);
    _inView = countInWindow(points, window);
    if (
      !rollupWanted(
        { heightM: view.heightM, inView: _inView, active: _active },
        threshold,
      )
    ) {
      deactivate();
      return;
    }
    const res = h3ResolutionForHeight(view.heightM);
    if (
      !force &&
      _madeFor &&
      _madeFor.res === res &&
      _madeFor.points === points.length &&
      !viewMoved(_madeFor, view)
    )
      return;
    build(points, window, res, view);
  }

  /** A click's pick id: true when it was one of this rollup's hexes. */
  function handlePickedId(pickedId) {
    const text = String(pickedId ?? '');
    if (!text.startsWith(pickPrefix)) return false;
    const cell = text.slice(pickPrefix.length);
    if (!_cells.has(cell)) return false;
    flyToCell(cell);
    return true;
  }

  if (viewer?.camera?.moveEnd?.addEventListener)
    _removeMove = viewer.camera.moveEnd.addEventListener(() => refresh());
  picking?.registerPickOwner?.(sourceId, (pickedId) =>
    String(pickedId ?? '').startsWith(pickPrefix),
  );
  if (cesium.ScreenSpaceEventHandler && viewer?.scene?.canvas) {
    try {
      _handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      _handler.setInputAction((movement) => {
        if (!_active || !_cells.size) return;
        let picked = null;
        try {
          picked = viewer.scene.pick(movement.position);
        } catch {
          return;
        }
        const pickedId = picking?.resolvePickId
          ? picking.resolvePickId(picked)
          : (picked?.id ?? picked?.primitive?.id);
        handlePickedId(pickedId);
      }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    } catch {
      _handler = null; // no canvas input: labels still activate
    }
  }

  return {
    refresh,
    setEnabled(on) {
      _enabled = on !== false;
      refresh();
    },
    isEnabled: () => _enabled,
    isActive: () => _active,
    handlePickedId,
    flyToCell,
    getState() {
      return {
        enabled: _enabled,
        active: _active,
        res: _madeFor?.res ?? null,
        cells: _cells.size,
        points: _madeFor?.points ?? null,
        inView: _inView,
        madeFor: _madeFor,
        primitive: _surface?.primitive || null,
      };
    },
    detach() {
      if (_destroyed) return;
      deactivate();
      _destroyed = true;
      _removeMove?.();
      _removeMove = null;
      picking?.unregisterPickOwner?.(sourceId);
      try {
        _handler?.destroy?.();
      } catch {
        /* already gone */
      }
      _handler = null;
    },
  };
}
