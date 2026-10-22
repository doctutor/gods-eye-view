// Personal fork: level of detail for point layers. From orbit a layer's
// thousands of pins crowd and stack; attached to a layer, this rolls them
// up into counts per H3 hexagon at the resolution the camera height
// implies (maps/h3Resolution.js), bounded to the view window
// (maps/h3Cells.js), and resolves back into pins as the view comes in,
// the way the Wikipedia coverage layer's Hexes mode works. The hexes are
// ground-clamped (maps/h3Surface.js), filled in the layer's accent colour
// on a log ramp of their count, labelled with the count through the
// world-overlay host, and a click on one flies the camera to its bounds.
// The count window is a colour scale (scale.js): a user's floor and
// ceiling, log or linear, palette and HIDE OUTSIDE, kept per layer as
// `<id>:rollup` in the colour-scale store; `scaleControl()` is the row's.
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
import { colourScales } from '../../maps/colourScaleStore.js';
import { encodeScaleFields } from '../../maps/colourScale.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';
import {
  binPoints,
  cellAlpha,
  cellBox,
  countInWindow,
  labelEntry,
  rollupWanted,
} from './rollup.js';
import {
  rollupAuto,
  rollupFill,
  rollupScaleDefaults,
  rollupScaleKey,
  rollupScaleModel,
  setRollupAccent,
} from './scale.js';

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
 * @param {() => Array<{lat: number, lon: number, id?: string}>} [options.getPoints]
 * @param {(res: number, window: object|null) => Map<string, number>|null} [options.getCounts]
 *   Counts already made per cell (a server's, for points too many to send):
 *   used in place of binning getPoints' points; null draws nothing.
 * @param {string} [options.accent]
 * @param {{ enter?: number, exit?: number, enterHeightM?: number, exitHeightM?: number, minHeightM?: number }} [options.threshold]
 * @param {(active: boolean) => void} [options.onModeChange]
 * @param {() => void} [options.onUpdate] After each redraw or clear (a row readout).
 * @param {boolean} [options.enabled=true]
 * @param {object|null} [options.scales] The colour-scale store
 *   (src/maps/colourScaleStore.js; the app's by default, null for none).
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
    getPoints = null,
    getCounts = null,
    accent = DEFAULT_ROLLUP_ACCENT,
    threshold = {},
    onModeChange = () => {},
    onUpdate = () => {},
    enabled = true,
    scales = colourScales(),
  },
) {
  if (
    !id ||
    (typeof getPoints !== 'function' && typeof getCounts !== 'function')
  )
    throw new TypeError(
      'A point rollup needs a layer id and getPoints or getCounts',
    );
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
  let _maxCount = 0;
  let _scaleToken = '';
  setRollupAccent(id, accent);
  // The scale registered, and a change of it redraws the hexes.
  if (scales) scales.get(rollupScaleKey(id), rollupScaleDefaults(id));
  const _unsubscribeScale =
    scales?.subscribe?.((key) => {
      if (key === undefined || key === rollupScaleKey(id))
        refresh({ force: true });
    }) || null;

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

  function build(points, window, res, view, counts = null) {
    const bins = counts || binPoints(points, res, window);
    let max = 0;
    for (const count of bins.values()) if (count > max) max = count;
    _maxCount = max;
    const base = cesium.Color.fromCssColorString(accent);
    // A user's count window (scale.js); null: the accent's log ramp.
    const model = rollupScaleModel(scales, id);
    const defaults = rollupScaleDefaults(id);
    _scaleToken = model ? encodeScaleFields(model) : '';
    const coloured = [];
    const entries = [];
    for (const [cell, count] of bins) {
      if (model) {
        const fill = rollupFill(model, defaults, count, max);
        if (!fill) continue; // outside the window, hidden
        const [r, g, b] = fill.rgb;
        coloured.push([
          cell,
          new cesium.Color(r / 255, g / 255, b / 255, fill.alpha),
        ]);
      } else coloured.push([cell, base.withAlpha(cellAlpha(count, max))]);
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
    _madeFor = { ...view, res, points: counts ? counts : points.length };
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
    const window = viewWindow(view.lat, view.lon, view.heightM);
    const res = h3ResolutionForHeight(view.heightM);
    const counts = getCounts ? getCounts(res, window) : null;
    const points = counts ? [] : getPoints?.() || [];
    if (counts) {
      _inView = 0;
      for (const count of counts.values()) _inView += count;
    } else _inView = countInWindow(points, window);
    if (
      !rollupWanted(
        { heightM: view.heightM, inView: _inView, active: _active },
        threshold,
      )
    ) {
      deactivate();
      return;
    }
    if (
      !force &&
      _madeFor &&
      _madeFor.res === res &&
      _madeFor.points === (counts ? counts : points.length) &&
      !viewMoved(_madeFor, view)
    )
      return;
    build(points, window, res, view, counts);
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
    /**
     * The row's Scale controls for the count window (colourScaleWidget.js),
     * the automatic window one to the fullest hex drawn; null without a
     * store.
     */
    scaleControl() {
      if (!scales) return null;
      const auto = rollupAuto(_maxCount);
      return scaleRowControl({
        store: scales,
        key: rollupScaleKey(id),
        defaults: rollupScaleDefaults(id),
        auto,
        range: { min: 1, max: Math.max(auto.max, 10) },
      });
    },
    getState() {
      return {
        enabled: _enabled,
        active: _active,
        res: _madeFor?.res ?? null,
        cells: _cells.size,
        points: typeof _madeFor?.points === 'number' ? _madeFor.points : null,
        inView: _inView,
        maxCount: _maxCount,
        scaleToken: _scaleToken,
        madeFor: _madeFor,
        primitive: _surface?.primitive || null,
      };
    },
    detach() {
      if (_destroyed) return;
      deactivate();
      _destroyed = true;
      _unsubscribeScale?.();
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
