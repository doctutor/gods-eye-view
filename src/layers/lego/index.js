import * as Cesium from 'cesium';
import {
  RasterValuesError,
  createRasterValuesClient,
} from '../../data/rasterValues.js';
import {
  COLUMN_BUDGET,
  boxSizeM,
  brickHeightM,
  cellsForWindow,
  legoViewMoved,
  legoWindow,
  columnCardEntry,
  gridColumns,
} from './model.js';
import {
  ELEVATION_LAYER_ID,
  currentMode,
  isLegoLayer,
  layerSpec,
  legoColourScale,
  withColourScale,
  withHeader,
} from './layerSpecs.js';
import { LegoBrickPrimitive, buildBrickMesh } from './bricks.js';
import { colourScales, encodeScaleFields } from '../../maps/colourScale.js';
import { createRenderModeStore, isFlatBasemap } from './renderMode.js';
import { columnCardDetails } from './presentation.js';

/**
 * Personal fork: the Lego rendering mode. With "Render: Lego" picked beside
 * the ANALYSIS heading, the raster layer turned on last (an Earth Engine
 * image layer, the Census tracts' raster modes, Wikipedia coverage) is
 * also built as bricks: each cell of its values grid around the camera
 * (src/data/rasterValues.js) a column of 2×2 bricks as tall as its value
 * and in its own ramp's colour snapped to the Lego palette (model.js). The
 * colour imagery stays beneath, so nodata and zero cells still read. On a
 * flat basemap the columns stand on the ellipsoid; on photoreal tiles or
 * terrain each stands on its cell's ground height, from the elevation
 * values of the same window and cells (elevation's own columns are the
 * height and always rise from the ellipsoid).
 *
 * Level of detail: the window is fitted to the ground in view (a square
 * 2.5 camera heights across, at least 10 km: legoWindow), cut into at most
 * 512 cells a side and 200,000 in all, never finer than the layer's native
 * cells (cellsForWindow); rebuilt when the camera settles out of the
 * window's middle half or its height doubles or halves (legoViewMoved), the
 * old bricks freed. One primitive, one draw call (bricks.js). A click on a column opens
 * a card through the world overlay (N bricks = the value, the cell size,
 * its centre, the source); Esc or another click closes it.
 */

export const LEGO_CARD_SOURCE = 'lego-card';
/** Wait this long after the camera settles before rebuilding. */
export const LEGO_DEBOUNCE_MS = 300;
/** A planet-wide view's window: this far around the point under the camera. */
const WORLD_HALF_DEGREES = 60;

/**
 * @param {{viewer?: object, layers: {getAll: Function, isEnabled: Function,
 *   subscribeActivity: Function}, overlayHost?: object|null,
 *   mapStackController?: object|null, store?: object, values?: object,
 *   cesium?: object, requestRender?: Function, layerName?: (id: string) => string,
 *   storage?: Storage|null, budget?: number, now?: () => number,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} options
 */
export function createLegoController({
  viewer = null,
  layers,
  overlayHost = null,
  mapStackController = null,
  store = createRenderModeStore(),
  // The colour scales (src/maps/colourScale.js): Lego maps their window.
  scales = colourScales(),
  values = createRasterValuesClient(),
  cesium = Cesium,
  requestRender = () => {},
  layerName = (id) => id,
  storage,
  budget = COLUMN_BUDGET,
  now = () => performance.now(),
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
}) {
  let _viewer = viewer;
  let _primitive = null;
  let _built = null; // {layer, mode, exaggeration, flat, view, header, columns, boxes}
  let _status = { state: 'off' };
  let _debounce = null;
  let _request = 0;
  let _selected = null;
  /** Lego layers in the order they were turned on. */
  const _order = [];
  const _listeners = new Set();
  const _removers = [];

  const emit = () => {
    for (const listener of _listeners) {
      try {
        listener(_status);
      } catch (error) {
        console.warn('[Lego] listener failed:', error);
      }
    }
  };
  const setStatus = (status) => {
    _status = status;
    emit();
  };

  function activeLayer() {
    for (let i = _order.length - 1; i >= 0; i--)
      if (layers.isEnabled(_order[i])) return _order[i];
    // Restored layers were on before we listened: take them in panel order.
    const on = (layers.getAll?.() || [])
      .map((layer) => layer.id)
      .filter((id) => isLegoLayer(id) && layers.isEnabled(id));
    return on.at(-1) || null;
  }

  function viewNow() {
    const camera = _viewer?.camera;
    const canvas = _viewer?.scene?.canvas;
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
      /* under the camera */
    }
    point ||= camera?.positionCartographic || null;
    const degrees = (radians) =>
      Number.isFinite(radians) ? cesium.Math.toDegrees(radians) : 0;
    const height = camera?.positionCartographic?.height;
    return {
      lat: degrees(point?.latitude),
      lon: degrees(point?.longitude),
      height: Number.isFinite(height) ? height : 2e7,
    };
  }

  /** Whether the columns stand on the ellipsoid (a flat basemap). */
  function flatGround() {
    if (mapStackController?.getImageryHostTileset?.()) return false;
    const terrain = _viewer?.terrainProvider;
    return !terrain || terrain instanceof cesium.EllipsoidTerrainProvider;
  }

  /**
   * Whether the basemap is a flat map (the exaggeration's default: 2×), by
   * the active map stack's kind (isFlatBasemap); without one, by the ground.
   */
  function flatBasemap() {
    const flat = isFlatBasemap(mapStackController?.getActiveStack?.());
    return flat ?? flatGround();
  }

  function windowFor(view) {
    const box = legoWindow(view.lat, view.lon, view.height);
    if (box) return box;
    const dLon = Math.min(
      180,
      WORLD_HALF_DEGREES / Math.max(0.2, Math.cos((view.lat * Math.PI) / 180)),
    );
    return {
      west: Math.max(-180, view.lon - dLon),
      south: Math.max(-85, view.lat - WORLD_HALF_DEGREES),
      east: Math.min(180, view.lon + dLon),
      north: Math.min(85, view.lat + WORLD_HALF_DEGREES),
    };
  }

  function clearCard() {
    if (!_selected) return;
    _selected = null;
    try {
      overlayHost?.clearSource?.(LEGO_CARD_SOURCE);
    } catch {
      /* the host is gone */
    }
    requestRender('lego-card');
  }

  function removePrimitive() {
    if (!_primitive) return;
    try {
      _viewer?.scene?.primitives?.remove(_primitive);
    } catch {
      /* gone with the scene */
    }
    _primitive = null;
  }

  function clear(state = 'off') {
    _request++;
    removePrimitive();
    clearCard();
    _built = null;
    setStatus({ state });
    requestRender('lego-clear');
  }

  async function rebuild({ force = false } = {}) {
    if (store.getMode() !== 'lego') return clear('off');
    const layer = activeLayer();
    if (!layer) return clear('no-layer');
    const mode = currentMode(layer, storage);
    const flat = flatGround();
    const exaggeration = store.getExaggeration(flatBasemap());
    const view = viewNow();
    const colourScale = legoColourScale(scales, layer, mode);
    const scaleToken = colourScale ? encodeScaleFields(colourScale) : '';
    if (
      !force &&
      _built &&
      _built.layer === layer &&
      _built.mode === mode &&
      _built.exaggeration === exaggeration &&
      _built.flat === flat &&
      _built.scaleToken === scaleToken &&
      !legoViewMoved(_built.view, view)
    )
      return;
    const spec = layerSpec(layer, mode);
    if (!spec) return clear('no-layer');
    const box = windowFor(view);
    const size = boxSizeM(box);
    const { cols, rows } = cellsForWindow({
      ...size,
      nativeM: spec.nativeM,
      budget,
    });
    const cells = Math.max(cols, rows);
    const request = ++_request;
    setStatus({ state: 'loading', layer, layerName: layerName(layer) });
    try {
      const started = now();
      const wantsBase = !flat && layer !== ELEVATION_LAYER_ID;
      const [grid, base] = await Promise.all([
        values.fetch({ layer, mode, box, cells }),
        wantsBase
          ? values
              .fetch({ layer: ELEVATION_LAYER_ID, mode: '', box, cells })
              .catch(() => null)
          : null,
      ]);
      if (request !== _request) return;
      const sameGrid =
        base &&
        base.header.cols === grid.header.cols &&
        base.header.rows === grid.header.rows;
      const columns = gridColumns(grid, {
        spec: withColourScale(withHeader(spec, grid.header), colourScale),
        elevation: spec.elevation,
        exaggeration,
        base: sameGrid ? base : null,
      });
      const header = grid.header;
      const mesh = buildBrickMesh(columns, {
        cols: header.cols,
        rows: header.rows,
        cellSizeM: header.cellSizeM,
        centerLon: (header.west + header.east) / 2,
        centerLat: (header.south + header.north) / 2,
      });
      removePrimitive();
      clearCard();
      if (columns.length) {
        _primitive = new LegoBrickPrimitive({ mesh, cesium });
        _viewer?.scene?.primitives?.add(_primitive);
      }
      _built = {
        layer,
        mode,
        exaggeration,
        flat,
        scaleToken,
        view,
        header,
        columns,
        boxes: mesh.boxes,
      };
      setStatus({
        state: 'ready',
        layer,
        layerName: layerName(layer),
        columns: columns.length,
        faces: mesh.faces,
        brickM: brickHeightM(header.cellSizeM),
        cellSizeM: header.cellSizeM,
        buildMs: Math.round(now() - started),
      });
      requestRender('lego-build');
    } catch (error) {
      if (request !== _request || error?.name === 'AbortError') return;
      removePrimitive();
      _built = null;
      const unavailable =
        error instanceof RasterValuesError &&
        [404, 501, 503].includes(error.status);
      setStatus({
        state: unavailable ? 'unavailable' : 'failed',
        layer,
        layerName: layerName(layer),
        error: String(error?.message || error),
      });
      if (!unavailable)
        console.warn('[Lego] bricks not built:', error?.message);
    }
  }

  function schedule(options) {
    clearTimeoutImpl(_debounce);
    _debounce = setTimeoutImpl(() => {
      _debounce = null;
      rebuild(options);
    }, LEGO_DEBOUNCE_MS);
  }

  /** The column at a lon/lat and height, or null. */
  function columnAt(lon, lat, height) {
    if (!_built) return null;
    const { header, columns, boxes } = _built;
    const dLon = (header.east - header.west) / header.cols;
    const dLat = (header.north - header.south) / header.rows;
    const col0 = Math.floor((lon - header.west) / dLon);
    const row0 = Math.floor((header.north - lat) / dLat);
    let best = null;
    let bestScore = Infinity;
    columns.forEach((column, i) => {
      if (Math.abs(column.col - col0) > 1 || Math.abs(column.row - row0) > 1)
        return;
      const inside =
        lon >= column.west - dLon * 0.02 &&
        lon <= column.east + dLon * 0.02 &&
        lat >= column.south - dLat * 0.02 &&
        lat <= column.north + dLat * 0.02;
      const within =
        height >= boxes[i * 2] - 2 && height <= boxes[i * 2 + 1] + 2;
      const score =
        (inside ? 0 : 10) +
        (within ? 0 : 5) +
        Math.hypot(column.col - col0, column.row - row0);
      if (score < bestScore) {
        bestScore = score;
        best = { column, index: i };
      }
    });
    return best && bestScore < 10 ? best : null;
  }

  function showCard(found) {
    const { column, index } = found;
    const { header, layer, boxes } = _built;
    _selected = column;
    const entry = columnCardEntry({
      column,
      title: layerName(layer),
      details: columnCardDetails(column, header, {
        sourceName: header.source,
      }),
      cesium,
      topM: boxes[index * 2 + 1],
    });
    try {
      overlayHost?.setEntries?.(LEGO_CARD_SOURCE, [entry], { moving: false });
      overlayHost?.setVisible?.(LEGO_CARD_SOURCE, true);
    } catch (error) {
      console.warn('[Lego] card not drawn:', error?.message);
    }
    requestRender('lego-card');
  }

  /** A click at a screen position: a column's card, or nothing (closes one). */
  function pickAt(position) {
    if (!_built || store.getMode() !== 'lego') return null;
    let world = null;
    try {
      world = _viewer?.scene?.pickPositionSupported
        ? _viewer.scene.pickPosition(position)
        : null;
    } catch {
      world = null;
    }
    if (!world) {
      clearCard();
      return null;
    }
    const place = cesium.Cartographic.fromCartesian(world);
    const found = place
      ? columnAt(
          cesium.Math.toDegrees(place.longitude),
          cesium.Math.toDegrees(place.latitude),
          place.height,
        )
      : null;
    if (!found || found.column === _selected) {
      clearCard();
      return null;
    }
    showCard(found);
    return found.column;
  }

  function attach(viewerNow) {
    _viewer = viewerNow || _viewer;
    if (!_viewer) return;
    if (_viewer.camera?.moveEnd)
      _removers.push(_viewer.camera.moveEnd.addEventListener(() => schedule()));
    if (cesium.ScreenSpaceEventHandler && _viewer.scene?.canvas) {
      try {
        const handler = new cesium.ScreenSpaceEventHandler(
          _viewer.scene.canvas,
        );
        handler.setInputAction(
          (movement) => pickAt(movement.position),
          cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        _removers.push(() => handler.destroy());
      } catch {
        /* no canvas input */
      }
    }
    const doc = _viewer.scene?.canvas?.ownerDocument || globalThis.document;
    if (doc?.addEventListener) {
      const onKey = (event) => {
        if (event.key === 'Escape') clearCard();
      };
      doc.addEventListener('keydown', onKey);
      _removers.push(() => doc.removeEventListener('keydown', onKey));
    }
  }

  _removers.push(
    store.subscribe(() => {
      emit();
      schedule({ force: true });
    }),
  );
  // A changed colour scale rebuilds when it is the drawn layer's.
  _removers.push(scales.subscribe(() => schedule()));
  if (layers?.subscribeActivity)
    _removers.push(
      layers.subscribeActivity((change) => {
        if (
          change?.type !== 'visibility-settled' ||
          !isLegoLayer(change.layerId)
        )
          return;
        const index = _order.indexOf(change.layerId);
        if (index >= 0) _order.splice(index, 1);
        if (layers.isEnabled(change.layerId)) _order.push(change.layerId);
        schedule({ force: true });
      }),
    );
  const offMap = mapStackController?.subscribe?.(() =>
    schedule({ force: true }),
  );
  if (typeof offMap === 'function') _removers.push(offMap);
  if (_viewer) attach(_viewer);

  return {
    attach,
    rebuild,
    pickAt,
    getMode: () => store.getMode(),
    setMode: (mode) => store.setMode(mode),
    getExaggeration: () => store.getExaggeration(flatBasemap()),
    setExaggeration: (value) => store.setExaggeration(value),
    getStatus: () => _status,
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    /** For tests and the harness. */
    _state: () => ({
      built: _built,
      primitive: _primitive,
      selected: _selected,
    }),
    destroy() {
      clearTimeoutImpl(_debounce);
      for (const remove of _removers.splice(0)) {
        try {
          remove?.();
        } catch {
          /* already gone */
        }
      }
      clear('off');
      _listeners.clear();
    },
  };
}
