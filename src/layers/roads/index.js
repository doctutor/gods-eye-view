import * as Cesium from 'cesium';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { activeLuminance, readInkSetting, resolveInk } from '../../maps/ink.js';
import { drapeZoomForHeight } from '../../data/demStack.js';
import { riverHeightForCanvas } from '../../data/earthEngineLayers.js';
import { imageryRectangleDegrees } from '../../maps/imageryHost.js';
import { isSurfacePick, pickGroundPosition } from '../../data/scenePick.js';
import { ROAD_MODES } from '../../data/overtureRoads.js';
import { createRoadsSource, roadsImageryOptions } from './source.js';
import { roadCardDetails, roadCardTitle, rowControls } from './presentation.js';

/**
 * Personal fork: the Roads layer (ANALYSIS in the DATA LAYERS panel):
 * Overture Maps' road segments (OpenStreetMap's, and TomTom's where its
 * sources say so) as self-hosted tiles (/api/roads, built by `npm run
 * overture:build -- --roads` for the conterminous US and Europe), draped on
 * the globe or the photoreal tiles. The classes follow the zoom (motorways
 * and trunks from orbit, primary roads from z 7, secondary and tertiary
 * from z 9, streets from z 12, service roads and paths from z 14; see
 * src/data/overtureRoads.js). Modes NETWORK (by class, the default), SPEED
 * (the speed limit) and SURFACE, kept as gev.roads.mode; inks AUTO (by the
 * basemap), LIGHT and DARK, kept as gev.roads.ink. A click on a road opens
 * its card (name, class, speed limit, surface, bicycles, source); a click
 * off a road closes it.
 */

export const ROADS_LAYER_ID = 'roads';
export const ROADS_SOURCE = 'roads';
export const MODE_STORAGE_KEY = 'gev.roads.mode';
export const INK_STORAGE_KEY = 'gev.roads.ink';
/** The tiles' opacity over the map. */
export const ROADS_ALPHA = 0.95;

export const ROADS_CREDIT = Object.freeze({
  key: 'roads',
  html:
    'Roads: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. ' +
    'Available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">Open Database License</a>. ' +
    'Data from <a href="https://www.tomtom.com/" target="_blank" rel="noopener">TomTom</a>. ' +
    '<a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener">Overture Maps Foundation</a>',
});

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{overlayHost?: object|null, cesium?: object,
 *   requestRender?: (reason: string) => void, credits?: {register?: Function},
 *   source?: object, storage?: Storage|null, picking?: object|null,
 *   isPointerFree?: () => boolean}} [options]
 */
export function createRoadsLayer({
  overlayHost = null,
  cesium = Cesium,
  requestRender = () => {},
  credits = null,
  source = createRoadsSource(),
  storage,
  picking = null,
  isPointerFree = () => true,
} = {}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _mode = (() => {
    try {
      const value = store?.getItem(MODE_STORAGE_KEY);
      return ROAD_MODES.includes(value) ? value : 'network';
    } catch {
      return 'network';
    }
  })();
  let _inkSetting = readInkSetting(store, INK_STORAGE_KEY);
  let _status = null;
  let _controller = null;
  let _unsubscribeMap = null;
  let _imagery = null;
  let _collection = null;
  let _mountedKey = '';
  let _handler = null;
  let _removeMove = null;
  let _rowListener = null;
  let _selected = null; // {segment, at: [lon, lat]}
  /** The last click's outcome for the row: {state: 'hit'|'miss'|'failed', segment?}. */
  let _click = null;

  const notify = () => _rowListener?.();

  function inkNow() {
    return resolveInk(_inkSetting, activeLuminance(_controller));
  }

  function imageryHost() {
    if (!_controller)
      return _viewer?.imageryLayers
        ? { collection: _viewer.imageryLayers, kind: 'globe' }
        : { collection: null, kind: 'none' };
    return resolveImageryHost({
      viewer: _viewer,
      tileset: _controller.getImageryHostTileset?.() || null,
    });
  }

  function viewPoint() {
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
      /* no pick: under the camera */
    }
    point ||= camera?.positionCartographic || null;
    if (!point) return null;
    return {
      lat: cesium.Math.toDegrees(point.latitude),
      lon: cesium.Math.toDegrees(point.longitude),
    };
  }

  /** Whether the point under the view is in one of the build's regions. */
  function inRegions() {
    const point = viewPoint();
    if (!point || !_status?.boxes?.length) return true;
    return _status.boxes.some(
      ([west, south, east, north]) =>
        point.lat >= south &&
        point.lat <= north &&
        point.lon >= west &&
        point.lon <= east,
    );
  }

  function unmount() {
    if (!_imagery) return;
    try {
      _collection?.remove(_imagery, true);
    } catch {
      /* gone with its tileset or the viewer */
    }
    _imagery = null;
    _collection = null;
    _mountedKey = '';
    requestRender('roads-hide');
  }

  /** Drape the tiles for the mode and ink on the map stack's host. */
  function sync() {
    if (!_enabled) return unmount();
    const ink = inkNow();
    const options = roadsImageryOptions(_status, _mode, ink);
    const host = imageryHost();
    if (!options || !host.collection) {
      unmount();
      notify();
      return;
    }
    const key = `${options.url}|${host.kind}`;
    if (_imagery && _mountedKey === key && _collection === host.collection)
      return;
    unmount();
    const { boxes, ...rest } = options;
    // The build's regions, clipped to Web Mercator. A provider whose
    // rectangle misses the tiling scheme's has none (Cesium intersects the
    // two), and an imagery layer over it throws "Expected rectangle to be
    // typeof object" on every frame: such an extent is not mounted.
    const extent = imageryRectangleDegrees(boxes);
    if (!extent) {
      notify();
      return;
    }
    const provider = new cesium.UrlTemplateImageryProvider({
      ...rest,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      rectangle: cesium.Rectangle.fromDegrees(...extent),
    });
    if (!provider.rectangle) {
      notify();
      return;
    }
    _imagery = new cesium.ImageryLayer(provider, { alpha: ROADS_ALPHA });
    host.collection.add(_imagery);
    _collection = host.collection;
    _mountedKey = key;
    credits?.register?.(_viewer, ROADS_CREDIT);
    requestRender('roads-show');
    notify();
  }

  async function loadStatus({ refresh = false } = {}) {
    try {
      _status = await source.status({ refresh });
    } catch {
      _status = { configured: false, failed: true, boxes: [] };
    }
    if (_enabled) sync();
    notify();
  }

  function drawCard() {
    const entries = [];
    if (_selected) {
      const { segment, at } = _selected;
      const title = roadCardTitle(segment);
      entries.push({
        id: 'card',
        variant: 'card',
        position: cesium.Cartesian3.fromDegrees(at[0], at[1], 0),
        title,
        details: roadCardDetails(segment),
        accent: '#ffb347',
        priority: 1000,
        protected: true,
        collisionGroup: 'roads-card',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        placement: 'above',
        accessibilityLabel: title,
      });
    }
    try {
      overlayHost?.setEntries?.(ROADS_SOURCE, entries, { moving: false });
    } catch (error) {
      console.warn('[Roads] card not drawn:', error?.message);
    }
    requestRender('roads-card');
  }

  async function onClick(position) {
    if (!_enabled || !_status?.configured || !isPointerFree()) return;
    let picked = null;
    try {
      picked = _viewer?.scene?.pick?.(position);
    } catch {
      picked = null;
    }
    // Something else's pin or label was clicked: not ours.
    if (!isSurfacePick(picked)) {
      const id = picking?.resolvePickId?.(picked) ?? null;
      if (id && picking?.findPickOwner?.(id)) return;
    }
    const ground = pickGroundPosition(_viewer, position);
    if (!ground) {
      _click = null;
      if (_selected) {
        _selected = null;
        drawCard();
      }
      notify();
      return;
    }
    const carto = cesium.Cartographic.fromCartesian(ground);
    const lon = cesium.Math.toDegrees(carto.longitude);
    const lat = cesium.Math.toDegrees(carto.latitude);
    // The zoom the tiles are drawn at here: Cesium drapes coarser tiles on a
    // smaller canvas (a 717 px pane at 20 km: z 12, not a 1,600 px one's
    // z 13), so the server's 8 px tolerance is 8 pixels of what is drawn.
    const canvas = _viewer?.scene?.canvas;
    const zoom = drapeZoomForHeight(
      riverHeightForCanvas(
        _viewer?.camera?.positionCartographic?.height,
        canvas?.clientWidth,
        canvas?.clientHeight,
      ),
    );
    let segment = null;
    let failed = false;
    try {
      segment = await source.nearest({ lon, lat, zoom });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      segment = null;
      failed = true;
    }
    if (!_enabled) return;
    _selected = segment ? { segment, at: [lon, lat] } : null;
    _click = segment
      ? { state: 'hit', segment }
      : { state: failed ? 'failed' : 'miss' };
    drawCard();
    notify();
  }

  function attachClick() {
    if (_handler || !cesium.ScreenSpaceEventHandler || !_viewer?.scene?.canvas)
      return;
    try {
      _handler = new cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
      _handler.setInputAction(
        (movement) => onClick(movement.position),
        cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    } catch {
      _handler = null;
    }
  }

  function setMode(key) {
    if (!ROAD_MODES.includes(key) || key === _mode) return;
    _mode = key;
    try {
      store?.setItem(MODE_STORAGE_KEY, key);
    } catch {
      /* private mode */
    }
    sync();
    notify();
  }

  function setInk(key) {
    if (!['auto', 'light', 'dark'].includes(key) || key === _inkSetting) return;
    _inkSetting = key;
    try {
      store?.setItem(INK_STORAGE_KEY, key);
    } catch {
      /* private mode */
    }
    sync();
    notify();
  }

  function onMapSettled() {
    if (_enabled) sync();
    notify();
  }

  return {
    id: ROADS_LAYER_ID,
    name: 'Roads',
    icon: '⛙',
    source: 'Overture Maps',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_enabled) return;
      _enabled = true;
      overlayHost?.setVisible?.(ROADS_SOURCE, true);
      if (_viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = _viewer.camera.moveEnd.addEventListener(notify);
      attachClick();
      sync();
      loadStatus();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      source.abort?.();
      _removeMove?.();
      _removeMove = null;
      try {
        _handler?.destroy?.();
      } catch {
        /* gone */
      }
      _handler = null;
      _selected = null;
      _click = null;
      overlayHost?.clearSource?.(ROADS_SOURCE);
      overlayHost?.setVisible?.(ROADS_SOURCE, false);
      unmount();
      notify();
    },

    async update() {
      return _enabled;
    },

    destroy() {
      this.disable();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _viewer = null;
      _rowListener = null;
    },

    getStats() {
      const count = _status?.configured ? _status.segments : 0;
      return { count, countLabel: _enabled ? String(count) : '—' };
    },

    getRowControls() {
      return rowControls({
        mode: _mode,
        onMode: setMode,
        ink: _inkSetting,
        onInk: setInk,
        inkDrawn: inkNow(),
        status: _status,
        inRegions: inRegions(),
        enabled: _enabled,
        click: _click,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** The map stack controller: where to drape, and every settled switch. */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = controller || null;
      const off = _controller?.subscribe?.(onMapSettled);
      _unsubscribeMap = typeof off === 'function' ? off : null;
      onMapSettled();
    },

    /** For tests. */
    _state: () => ({
      mode: _mode,
      inkSetting: _inkSetting,
      ink: inkNow(),
      status: _status,
      mounted: Boolean(_imagery),
      url: _imagery?.imageryProvider?.url || '',
      collection: _collection,
      selected: _selected,
      click: _click,
    }),
    _onClick: onClick,
    _loadStatus: loadStatus,
  };
}
