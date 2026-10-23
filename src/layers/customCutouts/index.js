/**
 * Personal fork: the Custom cutouts layer. While it is on, the Google 3D
 * tiles are clipped to the visible cutouts' boundaries (./clipping.js), and
 * the map controller lays a plain plate under them (MapSourceController's
 * setPlate: the globe shown in black or white), so each cut piece stands
 * on the plate with the draped overlays around it. Off, or with no visible
 * cutout, the tiles are exactly as without the layer. Nothing happens on a
 * globe map: the panel says it needs Google 3D. The list, the plate and the
 * toggle live in ./store.js (and the share link's `cc`); rings come from
 * ./source.js, or, for an outline drawn on the map (./drawInput.js), from
 * its own source key.
 */
import * as Cesium from 'cesium';
import {
  MAX_CUTOUTS,
  nextDrawnName,
  visibleRings,
} from '../../data/customCutouts.js';
import { createCutoutClipping } from './clipping.js';
import { createCutoutDrawer } from './drawInput.js';

export const CUSTOM_CUTOUTS_LAYER_ID = 'custom-cutouts';
/** The plate colours, as the keyless blank styles paint the globe. */
const PLATE_RGB = Object.freeze({ black: [0, 0, 0], white: [1, 1, 1] });

/** Popover credit while cutouts from OpenStreetMap are drawn. */
export const CUTOUTS_CREDIT = Object.freeze({
  key: 'custom-cutouts',
  html: 'Custom cutouts: boundaries © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL), through the local Overpass API',
});

/**
 * @param {{store: object, source: object, placeSearch?: object,
 *   cesium?: object, clipping?: object, requestRender?: Function,
 *   credits?: {register?: Function}, osmCredit?: {show: Function, hide: Function},
 *   setTimeoutImpl?: Function, pickWorld?: Function, createDrawer?: Function}} options
 *   `pickWorld(viewer, nx, ny)` is the app's depth-aware surface pick for
 *   drawing (normalised screen coordinates to {lat, lon, height}).
 */
export function createCustomCutoutsLayer({
  store,
  source,
  placeSearch = null,
  cesium = Cesium,
  clipping = createCutoutClipping({ cesium }),
  requestRender = () => {},
  credits = null,
  osmCredit = null,
  setTimeoutImpl = (...args) => setTimeout(...args),
  pickWorld = null,
  createDrawer = createCutoutDrawer,
}) {
  let viewer = null;
  let controller = null;
  let unsubscribeMap = null;
  let unsubscribeStore = null;
  let enabled = false;
  let rowListener = null;
  /** source -> 'loading' | 'failed' */
  const loading = new Map();
  /** Why nothing is cut now, for the panel ('' when cutting). */
  let reason = '';
  const panelListeners = new Set();
  let drawer = null;
  let drawerViewer = null;
  /** Why drawing did not start ('full'), else ''. */
  let drawNote = '';

  const notify = () => {
    for (const listener of [...panelListeners]) {
      try {
        listener();
      } catch {
        /* the panel's problem */
      }
    }
    try {
      rowListener?.();
    } catch {
      /* the row's problem */
    }
  };

  // One Color a plate: the controller compares by identity, and a new one
  // every sync would have it notify (and this sync) again without end.
  const plateColors = new Map();
  const plateColor = (plate) => {
    const key = PLATE_RGB[plate] ? plate : 'black';
    if (!plateColors.has(key))
      plateColors.set(key, new cesium.Color(...PLATE_RGB[key], 1));
    return plateColors.get(key);
  };

  /** Clip and plate, or undo both, to match the state and the map. */
  function sync() {
    const state = store.get();
    const tileset = controller?.getImageryHostTileset?.() || null;
    const rings = visibleRings(state.cutouts);
    const scene = viewer?.scene;
    let next = '';
    if (!enabled) next = 'off';
    else if (!tileset) next = 'needs-3d';
    else if (scene && !clipping.supported(scene)) next = 'no-webgl2';
    else if (!rings.length)
      next = state.cutouts.length ? 'none-visible' : 'empty';
    if (next || !scene) {
      clipping.clear();
      controller?.setPlate?.(null);
      osmCredit?.hide(viewer);
    } else {
      clipping.apply(scene, tileset, rings, state.plate);
      controller?.setPlate?.(plateColor(state.plate));
      osmCredit?.show(viewer);
      credits?.register?.(viewer, CUTOUTS_CREDIT);
    }
    requestRender('custom-cutouts');
    if (next !== reason) {
      reason = next;
      notify();
    }
  }

  /** Fetch the rings each listed cutout lacks (the URL holds none). */
  function fetchMissing() {
    for (const cutout of store.get().cutouts) {
      if (cutout.rings || loading.get(cutout.source) === 'loading') continue;
      loading.set(cutout.source, 'loading');
      notify();
      source
        .cutout(cutout.source)
        .then((made) => {
          if (made?.rings?.length) {
            loading.delete(cutout.source);
            store.update(cutout.source, {
              rings: made.rings,
              level: made.level,
            });
          } else {
            loading.set(cutout.source, 'failed');
            notify();
          }
        })
        .catch(() => {
          loading.set(cutout.source, 'failed');
          notify();
        });
    }
  }

  function onStore() {
    if (drawNote === 'full' && store.get().cutouts.length < MAX_CUTOUTS)
      drawNote = '';
    if (enabled) fetchMissing();
    sync();
    notify();
  }

  /** The point under the middle of the view (else under the camera). */
  function viewCentre() {
    const camera = viewer?.camera;
    const canvas = viewer?.scene?.canvas;
    let point = null;
    try {
      const hit =
        canvas && camera?.pickEllipsoid
          ? camera.pickEllipsoid(
              new cesium.Cartesian2(
                canvas.clientWidth / 2,
                canvas.clientHeight / 2,
              ),
            )
          : null;
      if (hit) point = cesium.Cartographic.fromCartesian(hit);
    } catch {
      /* no pick */
    }
    point ||= camera?.positionCartographic || null;
    if (!point) return null;
    return {
      lat: cesium.Math.toDegrees(point.latitude),
      lon: cesium.Math.toDegrees(point.longitude),
    };
  }

  /** The pick when the app gives none: the ellipsoid under the pointer. */
  function ellipsoidPick(target, nx, ny) {
    const canvas = target?.scene?.canvas;
    const hit = target?.camera?.pickEllipsoid?.(
      new cesium.Cartesian2(nx * canvas.clientWidth, ny * canvas.clientHeight),
    );
    if (!hit) return null;
    const point = cesium.Cartographic.fromCartesian(hit);
    return {
      lat: cesium.Math.toDegrees(point.latitude),
      lon: cesium.Math.toDegrees(point.longitude),
      height: 0,
    };
  }

  function drawerFor(target) {
    if (drawer && drawerViewer === target) return drawer;
    drawer?.stop();
    drawerViewer = target;
    drawer = createDrawer({
      viewer: target,
      cesium,
      pick: pickWorld || ellipsoidPick,
      onChange: notify,
      onFinish: (key) =>
        store.add({
          source: key,
          name: nextDrawnName(store.get().cutouts),
          visible: true,
        }),
    });
    return drawer;
  }

  const drawView = () => {
    const now = drawer?.view() || { drawing: false, count: 0, max: 0 };
    return { ...now, reason: now.reason || drawNote };
  };

  const layer = {
    id: CUSTOM_CUTOUTS_LAYER_ID,
    name: 'Custom cutouts',
    icon: '✂',
    source: 'Google 3D tiles · OpenStreetMap boundaries',
    updateInterval: 0,

    init(nextViewer) {
      viewer = nextViewer;
    },

    enable(nextViewer) {
      viewer = nextViewer || viewer;
      enabled = true;
      unsubscribeStore ||= store.subscribe(onStore);
      store.setEnabled(true);
      fetchMissing();
      sync();
      notify();
    },

    disable() {
      drawer?.stop();
      drawNote = '';
      enabled = false;
      store.setEnabled(false);
      sync();
      notify();
    },

    async update() {
      // Nothing on a clock; `false` here would read as a refused enable.
      return enabled;
    },

    destroy() {
      this.disable();
      unsubscribeStore?.();
      unsubscribeStore = null;
      unsubscribeMap?.();
      unsubscribeMap = null;
      controller = null;
      drawer = null;
      drawerViewer = null;
      viewer = null;
      rowListener = null;
      panelListeners.clear();
    },

    /** Every settled map switch (and the plate's own): clip again. */
    attachMapStackController(next) {
      unsubscribeMap?.();
      unsubscribeMap = null;
      controller = next || null;
      const off = controller?.subscribe?.(() => sync());
      unsubscribeMap = typeof off === 'function' ? off : null;
      sync();
    },

    /**
     * The layer is local-only, so the data manager never restores it: a
     * share link's `cc` that says on turns it on once the page is up.
     */
    attachDataManager(manager) {
      if (!store.get().enabled || typeof manager?.setEnabled !== 'function')
        return;
      setTimeoutImpl(() => {
        manager.setEnabled(CUSTOM_CUTOUTS_LAYER_ID, true, {
          origin: 'programmatic',
        });
      }, 0);
    },

    getStats() {
      const state = store.get();
      const shown = state.cutouts.filter((c) => c.visible).length;
      return {
        count: enabled ? shown : 0,
        countLabel: enabled ? `${shown}/${state.cutouts.length}` : '—',
      };
    },

    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },

    // --- the panel's API ---------------------------------------------------

    /** What the panel draws: the state, each cutout's fetch, the reason. */
    view() {
      const state = store.get();
      return {
        enabled,
        plate: state.plate,
        reason,
        cutouts: state.cutouts.map((cutout) => ({
          source: cutout.source,
          name: cutout.name,
          level: cutout.level,
          visible: cutout.visible,
          status: cutout.rings
            ? 'ready'
            : loading.get(cutout.source) || 'loading',
          vertices: cutout.rings
            ? cutout.rings.reduce((sum, ring) => sum + ring.length, 0)
            : 0,
        })),
        draw: drawView(),
      };
    },
    onChange(listener) {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
    /** The administrative areas under the middle of the view. */
    async areasAtView({ signal } = {}) {
      const centre = viewCentre();
      if (!centre) return { areas: [], from: 'none' };
      return source.areasAt(centre.lat, centre.lon, { signal });
    },
    /**
     * A place's areas by name, through the search box's geocoder: the
     * areas at the place it finds, the one named like the query first.
     */
    async areasByName(query, { signal } = {}) {
      const text = String(query || '').trim();
      if (!text) return { areas: [], from: 'none' };
      let place = null;
      try {
        place = (await placeSearch?.geocode?.(text, { signal }))?.place || null;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
      const found =
        place && Number.isFinite(place.lat) && Number.isFinite(place.lng);
      let answer = found
        ? await source.areasAt(place.lat, place.lng, { signal })
        : { areas: [], from: 'none' };
      // Overpass silent: the bundled packs, by name.
      if (!answer.areas.length) {
        const pack = await source.packArea(text, {
          near: found ? { lat: place.lat, lon: place.lng } : null,
        });
        if (pack)
          answer = { from: 'packs', areas: [pack], reason: answer.reason };
      }
      const wanted = text.toLowerCase();
      const named = (area) =>
        area.name.toLowerCase() === wanted ||
        String(place?.name || '').toLowerCase() === area.name.toLowerCase();
      return {
        ...answer,
        areas: [...answer.areas].sort(
          (a, b) => Number(named(b)) - Number(named(a)),
        ),
      };
    },
    add: (area) => store.add({ ...area, visible: true }),
    rename: (source0, name) => store.update(source0, { name }),
    setVisible: (source0, visible) => store.update(source0, { visible }),
    remove: (source0) => store.remove(source0),
    reset: () => store.reset(),
    setPlate: (plate) => store.setPlate(plate),
    retry(source0) {
      loading.delete(source0);
      fetchMissing();
    },

    /**
     * Draw mode: corners clicked on the map make a ring, added as
     * "Drawn N" when it closes. False when it cannot start (the list is
     * full, the scene not up, or another tool has the pointer).
     */
    startDraw() {
      drawNote = '';
      if (!viewer) return false;
      if (store.get().cutouts.length >= MAX_CUTOUTS) {
        drawNote = 'full';
        notify();
        return false;
      }
      const started = drawerFor(viewer).start();
      notify();
      return started.ok;
    },
    undoDraw: () => drawer?.undo() || false,
    finishDraw: () => drawer?.finish() || { done: false },
    cancelDraw() {
      drawer?.cancel();
      drawNote = '';
      notify();
    },

    /** For tests: what is clipped. */
    _state: () => ({ enabled, reason, clipping: clipping.state(), drawer }),
  };
  return layer;
}
