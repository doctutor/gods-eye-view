import * as Cesium from 'cesium';
import {
  PRECISION_STYLE,
  SOURCE_COLOR,
  fetchNearVideos,
  fetchWikidataVideos,
  viewQuery,
} from './source.js';
import { createVideoPlayer } from './player.js';
export * from './source.js';

/**
 * Personal fork: the Recorded Video layer (Cameras section) — non-live
 * videos tied to places. Wikidata's videos (exact: the video is about that
 * place) load everywhere on enable; YouTube's own geotags are asked for near
 * the view once the camera settles below SEARCH_MAX_HEIGHT_M (debounced, one
 * request in flight, one per cache cell). Pins say how precise they are:
 * site solid, area hollow, region faint. Clicking a pin plays the video in a
 * small floating YouTube player; nothing is projected into the scene.
 */

export const RECORDED_VIDEO_LAYER_ID = 'recorded-video';
export const SEARCH_MAX_HEIGHT_M = 50_000;
export const SEARCH_DEBOUNCE_MS = 1200;
const LABEL_MAX_CAMERA_HEIGHT_M = 15_000;
const LABEL_RADIUS_M = 8000;
const LABEL_LIMIT = 30;
const WIKIDATA_REFRESH_MS = 24 * 60 * 60 * 1000;
const ENTITY_PREFIX = `${RECORDED_VIDEO_LAYER_ID}:`;

function distanceM(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** A left-click handler on the scene: calls onPick with the picked entity. */
function defaultClickHandler(viewer, onPick) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked?.id) onPick(picked.id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  return () => handler.destroy();
}

/**
 * @param {{overlayHost?: object, credits?: {register?: Function},
 *   fetchImpl?: typeof fetch, player?: ReturnType<typeof createVideoPlayer>,
 *   createClickHandler?: (viewer: object, onPick: Function) => Function,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} [options]
 */
export function createRecordedVideoLayer({
  overlayHost,
  credits,
  fetchImpl,
  player = createVideoPlayer(),
  createClickHandler = defaultClickHandler,
  setTimeoutImpl = (...a) => setTimeout(...a),
  clearTimeoutImpl = (...a) => clearTimeout(...a),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  /** record id → record; Wikidata first, geotags merged in by video. */
  const _records = new Map();
  let _wikidataAt = 0;
  let _wikidataRequest = null;
  let _nearRequest = null;
  let _pendingQuery = null;
  let _debounce = null;
  const _cellsAsked = new Set();
  let _lastError = null;
  let _refused = false;
  let _removeMoveListener = null;
  let _removeClick = null;
  const fetchOptions = fetchImpl ? { fetchImpl } : {};

  function viewCentre() {
    const carto = _viewer?.camera?.positionCartographic;
    if (!carto) return null;
    let lat = Cesium.Math.toDegrees(carto.latitude);
    let lon = Cesium.Math.toDegrees(carto.longitude);
    const canvas = _viewer.scene?.canvas;
    const centre = canvas
      ? _viewer.camera.pickEllipsoid(
          new Cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
        )
      : null;
    if (centre) {
      const c = Cesium.Cartographic.fromCartesian(centre);
      lat = Cesium.Math.toDegrees(c.latitude);
      lon = Cesium.Math.toDegrees(c.longitude);
    }
    return { lat, lon, height: carto.height };
  }

  function addRecords(records) {
    let added = 0;
    const videos = new Set(
      [..._records.values()]
        .filter((r) => r.source === 'wikidata')
        .map((r) => r.videoId),
    );
    for (const record of records) {
      // A Wikidata item about the place says more than an uploader's geotag.
      if (record.source !== 'wikidata' && videos.has(record.videoId)) continue;
      if (_records.has(record.id)) continue;
      _records.set(record.id, record);
      added++;
    }
    return added;
  }

  function entityFor(record) {
    const style = PRECISION_STYLE[record.coordinatesQuality];
    const hue = Cesium.Color.fromCssColorString(SOURCE_COLOR[record.source]);
    return {
      id: `${ENTITY_PREFIX}${record.id}`,
      name: record.title,
      position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
      point: {
        pixelSize: style.pixelSize,
        color: style.fill
          ? hue.withAlpha(style.fill)
          : Cesium.Color.TRANSPARENT,
        outlineColor: hue.withAlpha(style.outline),
        outlineWidth: style.fill ? 1.5 : 2.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(500, 1.3, 2_000_000, 0.45),
      },
      properties: {
        videoId: record.videoId,
        source: record.source,
        coordinatesQuality: record.coordinatesQuality,
      },
    };
  }

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const record of _records.values())
      _dataSource.entities.add(entityFor(record));
    _dataSource.entities.resumeEvents();
  }

  function refreshLabels() {
    if (!overlayHost) return;
    const view = _enabled ? viewCentre() : null;
    if (!view || view.height > LABEL_MAX_CAMERA_HEIGHT_M) {
      overlayHost.clearSource(RECORDED_VIDEO_LAYER_ID);
      return;
    }
    const nearest = [..._records.values()]
      .map((record) => ({
        record,
        d: distanceM(view.lat, view.lon, record.lat, record.lon),
      }))
      .filter(({ d }) => d <= LABEL_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, LABEL_LIMIT);
    overlayHost.setEntries(
      RECORDED_VIDEO_LAYER_ID,
      nearest.map(({ record, d }) => ({
        id: record.id,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        variant: 'label',
        title: record.title.slice(0, 48),
        details: [PRECISION_STYLE[record.coordinatesQuality].label],
        accent: SOURCE_COLOR[record.source],
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
      { cohortLimit: LABEL_LIMIT, collisionCapacity: 20, moving: false },
    );
  }

  async function loadWikidata() {
    if (_wikidataRequest || Date.now() - _wikidataAt < WIKIDATA_REFRESH_MS)
      return false;
    const request = new AbortController();
    _wikidataRequest = request;
    try {
      const records = await fetchWikidataVideos({
        ...fetchOptions,
        signal: request.signal,
      });
      if (request.signal.aborted || !_enabled) return false;
      _wikidataAt = Date.now();
      _lastError = null;
      addRecords(records);
      render();
      refreshLabels();
      return true;
    } catch (error) {
      if (!request.signal.aborted)
        // i18n-ignore: personal fork, English-only UI
        _lastError = error?.message || 'Recorded video unavailable';
      return false;
    } finally {
      if (_wikidataRequest === request) _wikidataRequest = null;
    }
  }

  async function searchView(query) {
    if (_nearRequest) {
      // One in flight: the newest settled view goes next.
      _pendingQuery = query;
      return;
    }
    if (_cellsAsked.has(query.cell)) return;
    _cellsAsked.add(query.cell);
    const request = new AbortController();
    _nearRequest = request;
    try {
      const result = await fetchNearVideos(
        query.lat,
        query.lon,
        query.radiusKm,
        { ...fetchOptions, signal: request.signal },
      );
      if (request.signal.aborted || !_enabled) return;
      _refused = result.refused;
      if (result.refused) _cellsAsked.delete(query.cell);
      if (addRecords(result.records)) {
        render();
        refreshLabels();
      }
    } catch (error) {
      _cellsAsked.delete(query.cell);
      if (!request.signal.aborted)
        // i18n-ignore: personal fork, English-only UI
        _lastError = error?.message || 'Recorded video search failed';
    } finally {
      if (_nearRequest === request) _nearRequest = null;
      const next = _pendingQuery;
      _pendingQuery = null;
      if (next && _enabled) searchView(next);
    }
  }

  function onSettled() {
    refreshLabels();
    clearTimeoutImpl(_debounce);
    _debounce = setTimeoutImpl(() => {
      _debounce = null;
      if (!_enabled) return;
      const view = viewCentre();
      const query = view
        ? viewQuery(view.lat, view.lon, view.height, {
            maxHeightM: SEARCH_MAX_HEIGHT_M,
          })
        : null;
      if (query) searchView(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  function onPick(entity) {
    const id = String(entity?.id || '');
    if (!_enabled || !id.startsWith(ENTITY_PREFIX)) return;
    const record = _records.get(id.slice(ENTITY_PREFIX.length));
    if (record) player.open(record);
  }

  return {
    id: RECORDED_VIDEO_LAYER_ID,
    name: 'Recorded Video',
    icon: '▶',
    source: 'Wikidata · YouTube geotags',
    updateInterval: WIKIDATA_REFRESH_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(RECORDED_VIDEO_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, false);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, true);
      credits?.register?.(viewer || _viewer, {
        key: 'recorded-video-credit',
        html: 'Recorded video: places from <a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a> (CC0) and uploaders’ YouTube geotags; videos play in YouTube’s player',
      });
      if (_viewer && !_removeMoveListener)
        _removeMoveListener =
          _viewer.camera.moveEnd.addEventListener(onSettled);
      if (_viewer && !_removeClick)
        _removeClick = createClickHandler(_viewer, onPick);
      onSettled();
    },

    disable() {
      _enabled = false;
      _wikidataRequest?.abort();
      _nearRequest?.abort();
      _pendingQuery = null;
      clearTimeoutImpl(_debounce);
      _debounce = null;
      if (_dataSource) _dataSource.show = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      _removeClick?.();
      _removeClick = null;
      player.close();
      overlayHost?.clearSource(RECORDED_VIDEO_LAYER_ID);
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      return loadWikidata();
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _records.clear();
      _cellsAsked.clear();
      _wikidataAt = 0;
      _lastError = null;
    },

    getStats() {
      const bySource = { wikidata: 0, 'youtube-geotag': 0 };
      for (const record of _records.values()) bySource[record.source]++;
      return {
        count: _records.size,
        ...bySource,
        refused: _refused,
        error: _lastError,
      };
    },

    /** Personal fork: for tests and the console. */
    _records: () => [..._records.values()],
    _pick: onPick,
  };
}
