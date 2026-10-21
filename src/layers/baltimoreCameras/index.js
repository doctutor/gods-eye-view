import * as Cesium from 'cesium';
import { BALTIMORE_CAMERA_SETS, fetchCameraSet } from './source.js';
import { msg, t } from '../../i18n/index.js';
export * from './source.js';

/** What a partly loaded set says: "3 of 4 sets loaded; … unavailable", or ''. */
export function cameraSetNote({ failed = [], loaded = 0, total = 0 } = {}) {
  if (!failed.length) return '';
  return t('{loaded} of {total} sets loaded; {missing} unavailable', {
    loaded,
    total,
    missing: failed.map((label) => t(label)).join(', '),
  });
}

/** Labels appear only once the view is this close, nearest cameras first. */
const LABEL_MAX_CAMERA_HEIGHT_M = 12000;
const LABEL_RADIUS_M = 6000;
const LABEL_LIMIT = 40;
/** The data changes rarely; refetch at most every six hours. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

function distanceM(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * One Baltimore camera-location layer: colored ground points for every
 * camera, plus name labels for the nearest few when zoomed in.
 * @param {{setKey: 'enforcement'|'citiwatch', overlayHost: object,
 *   credits?: {register?: function(object, object): void},
 *   fetchImpl?: typeof fetch}} options
 */
export function createBaltimoreCameraLayer({
  setKey,
  overlayHost,
  credits,
  fetchImpl,
} = {}) {
  const set = BALTIMORE_CAMERA_SETS[setKey];
  if (!set) throw new TypeError(`Unknown Baltimore camera set: ${setKey}`);
  if (!overlayHost)
    throw new TypeError('Baltimore cameras require an overlay host');
  const overlaySourceId = set.id;
  let _viewer = null;
  let _dataSource = null;
  let _records = [];
  let _lastUpdate = null;
  let _lastError = null;
  /** The last load's layers that did not answer ({failed, loaded, total}). */
  let _partial = null;
  let _enabled = false;
  let _request = null;
  let _removeMoveListener = null;

  function refreshLabels() {
    if (!_enabled || !_viewer || !_records.length) {
      overlayHost.clearSource(overlaySourceId);
      return;
    }
    const carto = _viewer.camera.positionCartographic;
    if (!carto || carto.height > LABEL_MAX_CAMERA_HEIGHT_M) {
      overlayHost.clearSource(overlaySourceId);
      return;
    }
    // Rank by distance to the ground point under the screen centre when it
    // resolves, else to the point under the camera.
    let lat = Cesium.Math.toDegrees(carto.latitude);
    let lon = Cesium.Math.toDegrees(carto.longitude);
    const canvas = _viewer.scene.canvas;
    const centre = _viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    if (centre) {
      const c = Cesium.Cartographic.fromCartesian(centre);
      lat = Cesium.Math.toDegrees(c.latitude);
      lon = Cesium.Math.toDegrees(c.longitude);
    }
    const nearest = _records
      .map((record) => ({
        record,
        d: distanceM(lat, lon, record.lat, record.lon),
      }))
      .filter(({ d }) => d <= LABEL_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, LABEL_LIMIT);
    overlayHost.setEntries(
      overlaySourceId,
      nearest.map(({ record, d }) => ({
        id: record.id,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        variant: 'label',
        title: record.title,
        details: [t(record.kind)],
        accent: record.color,
        priority: Math.round(LABEL_RADIUS_M - d),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        verticalOnly: true,
        placement: 'above',
      })),
      { cohortLimit: LABEL_LIMIT, collisionCapacity: 24, moving: false },
    );
  }

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const record of _records) {
      const color = Cesium.Color.fromCssColorString(record.color);
      _dataSource.entities.add({
        id: `${set.id}:${record.id}`,
        name: record.title,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        point: {
          pixelSize: 9,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Stay visible over photorealistic buildings.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(500, 1.3, 60000, 0.5),
        },
        properties: { kind: t(record.kind), location: record.title },
      });
    }
    _dataSource.entities.resumeEvents();
  }

  return {
    id: set.id,
    name: set.name,
    icon: set.icon,
    source: set.sourceLabel,
    updateInterval: REFRESH_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(set.id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(overlaySourceId, false);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(overlaySourceId, true);
      credits?.register?.(viewer || _viewer, {
        key: `${set.id}-credit`,
        html: set.credit,
      });
      if (!_removeMoveListener && _viewer) {
        _removeMoveListener =
          _viewer.camera.moveEnd.addEventListener(refreshLabels);
      }
      refreshLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      overlayHost.clearSource(overlaySourceId);
      overlayHost.setVisible(overlaySourceId, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      if (
        _lastUpdate &&
        Date.now() - _lastUpdate < REFRESH_MS &&
        _records.length
      )
        return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const result = await fetchCameraSet(setKey, {
          signal: request.signal,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const { records } = result;
        _records = records;
        _lastUpdate = Date.now();
        _lastError = null;
        // Some layers missing: the set shows what came, and says so.
        _partial = result.failed.length ? result : null;
        render();
        refreshLabels();
        console.log(
          `[Data:${set.id}] Loaded ${records.length} camera locations` +
            (_partial ? ` (${result.failed.join(', ')} unavailable)` : ''),
        );
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError =
          error?.message || msg('Baltimore camera service unavailable');
        console.warn(`[Data:${set.id}] Fetch error:`, error);
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      overlayHost.clearSource(overlaySourceId);
      overlayHost.setVisible(overlaySourceId, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _records = [];
      _lastUpdate = null;
      _lastError = null;
      _partial = null;
    },

    getStats() {
      return {
        count: _records.length,
        lastUpdate: _lastUpdate,
        error: _lastError || cameraSetNote(_partial) || null,
      };
    },
  };
}

/** Both Baltimore camera-location layers, in panel order. */
export function createBaltimoreCameraLayers(options = {}) {
  return [
    createBaltimoreCameraLayer({ ...options, setKey: 'enforcement' }),
    createBaltimoreCameraLayer({ ...options, setKey: 'citiwatch' }),
  ];
}
