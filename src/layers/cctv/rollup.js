// Personal fork: the Cameras layer's hex rollup (src/layers/pointRollup/).
// From orbit the pins crowd and stack; while the camera is above
// ROLLUP_ENTER_HEIGHT_M or the view window holds more than
// ROLLUP_ENTER_COUNT cameras the pins hide and one hex per H3 cell shows
// their count, resolving back into pins as the view comes in. The
// row's ROLLUP AUTO / OFF chips switch it; the choice is kept in this
// browser as gev.cctv.rollup.

import { t } from '../../i18n/index.js';
import { attachPointRollup } from '../pointRollup/index.js';
import {
  ROLLUP_ENTER_COUNT,
  ROLLUP_ENTER_HEIGHT_M,
} from '../pointRollup/rollup.js';
import { CCTV_THUMBNAIL_STYLE } from '../../overlays/worldOverlayTokens.js';

export const ROLLUP_STORAGE_KEY = 'gev.cctv.rollup';
export const ROLLUP_MODES = Object.freeze(['auto', 'off']);

/** The saved mode; auto when storage is missing or unreadable. */
export function readRollupMode(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(ROLLUP_STORAGE_KEY);
    return raw === 'off' ? 'off' : 'auto';
  } catch {
    return 'auto';
  }
}

/** Save the mode; a failing storage (private window) only loses persistence. */
export function writeRollupMode(mode, storage = globalThis.localStorage) {
  try {
    if (mode === 'off') storage?.setItem?.(ROLLUP_STORAGE_KEY, 'off');
    else storage?.removeItem?.(ROLLUP_STORAGE_KEY);
  } catch {
    /* persistence is best effort */
  }
}

/** The points the rollup bins: every loaded camera's position. */
export function cameraPoints(records) {
  const points = [];
  for (const record of records || []) {
    const camera = record?.camera;
    if (!camera) continue;
    points.push({ id: camera.id, lat: camera.lat, lon: camera.lon });
  }
  return points;
}

/**
 * The layer part: attaches the rollup to the viewer while the layer is on,
 * hides the pins while it is active, and offers the row's chips.
 */
export function createRollup({ state: layerState, parts, services }) {
  let _rollup = null;
  let _mode = readRollupMode();
  let _refreshQueued = false;
  let _rowListener = null;

  function notifyRow() {
    try {
      _rowListener?.();
    } catch (error) {
      console.warn('[Data:CCTV] rollup row listener error:', error);
    }
  }

  function hidePins(active) {
    layerState._rollupHidesPins = active;
    if (layerState._billboards)
      layerState._billboards.show = !!layerState._enabled && !active;
    parts.rendering?.refreshHorizonCulling?.();
    // The ambient cards annotate pins: none while the hexes stand in.
    parts.cards?.refreshAmbientCards?.();
    parts.presentation?.notifyListeners?.();
  }

  function start() {
    if (_rollup || !layerState._viewer) return;
    _rollup = attachPointRollup(
      {
        id: 'cctv',
        viewer: layerState._viewer,
        overlays: layerState._cctvOverlayHost,
        picking: services?.picking || null,
        requestRender: (reason) =>
          services?.render?.governorRequestRender?.(reason),
        ...(services?.cesium ? { cesium: services.cesium } : {}),
      },
      {
        getPoints: () => cameraPoints(layerState._records),
        accent: CCTV_THUMBNAIL_STYLE.accent,
        onModeChange: hidePins,
        onUpdate: notifyRow,
        enabled: _mode === 'auto',
      },
    );
    _rollup.refresh();
  }

  function stop() {
    _rollup?.detach();
    _rollup = null;
    if (layerState._rollupHidesPins) hidePins(false);
  }

  /** Points changed or the view settled: decide again, once per tick. */
  function scheduleRefresh() {
    if (!_rollup || _refreshQueued) return;
    _refreshQueued = true;
    queueMicrotask(() => {
      _refreshQueued = false;
      _rollup?.refresh();
    });
  }

  function setRollupMode(mode, { storage } = {}) {
    const next = mode === 'off' ? 'off' : 'auto';
    writeRollupMode(next, storage);
    if (next === _mode) return next;
    _mode = next;
    _rollup?.setEnabled(next === 'auto');
    parts.presentation?.notifyListeners?.();
    notifyRow();
    return next;
  }

  function getRowControls() {
    const state = _rollup?.getState() || null;
    const chip = (mode, label, title) => ({
      id: `rollup-${mode}`,
      label,
      title,
      active: _mode === mode,
      onClick: () => setRollupMode(mode),
    });
    return {
      chips: [
        chip(
          'auto',
          t('ROLLUP AUTO'),
          t(
            'Group the pins into hexes with counts from above {height} km, or when the view holds more than {count} cameras',
            { count: ROLLUP_ENTER_COUNT, height: ROLLUP_ENTER_HEIGHT_M / 1000 },
          ),
        ),
        chip('off', t('OFF'), t('Always draw every camera pin')),
      ],
      // The hexes' count window, while they stand in for the pins.
      scale: state?.active ? _rollup?.scaleControl?.() || null : null,
      info: state?.active
        ? t('{count} cameras in {cells} hexes at resolution {res}', {
            count: state.inView,
            cells: state.cells,
            res: state.res,
          })
        : '',
    };
  }

  return {
    start,
    stop,
    scheduleRefresh,
    getRollupMode: () => _mode,
    getRollupState: () => _rollup?.getState() || null,
    methods: {
      getRowControls,
      setRollupMode,
      setRowControlsListener(listener) {
        _rowListener = typeof listener === 'function' ? listener : null;
      },
    },
  };
}
