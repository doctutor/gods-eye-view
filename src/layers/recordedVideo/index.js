import * as Cesium from 'cesium';
import {
  PRECISION_STYLE,
  SOURCE_COLOR,
  fetchLandmarkVideos,
  fetchLandmarksNear,
  fetchMentions,
  fetchNearVideos,
  fetchWikidataVideos,
  viewQuery,
} from './source.js';
import { createVideoPlayer, precisionLabel } from './player.js';
import { msg } from '../../i18n/index.js';
export * from './source.js';

/**
 * Personal fork: the Recorded Video layer (Cameras section) — non-live
 * videos tied to places. Wikidata's videos (exact: the video is about that
 * place) load everywhere on enable; YouTube's own geotags are asked for near
 * the view once the camera settles below SEARCH_MAX_HEIGHT_M (debounced, one
 * request in flight, one per cache cell). Pins say how precise they are:
 * site solid, area hollow, region faint. Clicking a pin plays the video in a
 * small floating YouTube player; nothing is projected into the scene.
 *
 * Landmarks (notable Wikidata places) show as outlined diamonds below
 * LANDMARK_MAX_HEIGHT_M. Clicking one (or its panel row) asks for videos
 * about it, which pin at the landmark tagged ABOUT; playing one asks Filmot
 * (once per landmark) for the moments its captions name the place.
 */

export const RECORDED_VIDEO_LAYER_ID = 'recorded-video';
export const SEARCH_MAX_HEIGHT_M = 50_000;
export const SEARCH_DEBOUNCE_MS = 1200;
const LABEL_MAX_CAMERA_HEIGHT_M = 15_000;
const LABEL_RADIUS_M = 8000;
const LABEL_LIMIT = 30;
const WIKIDATA_REFRESH_MS = 24 * 60 * 60 * 1000;
const ENTITY_PREFIX = `${RECORDED_VIDEO_LAYER_ID}:`;
export const LANDMARK_MAX_HEIGHT_M = 20_000;
const LANDMARK_PREFIX = `${ENTITY_PREFIX}landmark:`;
const LANDMARK_RADIUS_KM = 8;
const LANDMARK_LABEL_LIMIT = 12;
/** An outlined diamond: unlike the round video pins, and hollow so an ABOUT pin shows through. */
const LANDMARK_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><path d="M11 2 20 11 11 20 2 11Z" fill="none" stroke="#0b0f14" stroke-opacity="0.7" stroke-width="4"/><path d="M11 2 20 11 11 20 2 11Z" fill="none" stroke="${SOURCE_COLOR.landmark}" stroke-width="2"/></svg>`,
)}`;

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
  /** Personal fork: the panel's view of the layer (recordedVideoPanel.js). */
  const _listeners = new Set();
  let _quota = null;
  let _lastSearch = null;
  /** Personal fork: landmarks near the view, qid → landmark. */
  let _landmarkSource = null;
  const _landmarks = new Map();
  /** qid → its video record ids in the server's ranked order. */
  const _landmarkVideos = new Map();
  /** qid → {loading, done, refused, configured, cached, error}. */
  const _landmarkState = new Map();
  let _landmarkRequest = null;
  let _landmarkPending = null;
  const _landmarkAreasDone = new Set();
  let _selectedLandmark = null;
  let _playing = null;
  const notify = () => {
    for (const listener of _listeners)
      try {
        listener();
      } catch {
        /* a listener's problem is its own */
      }
  };
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

  function landmarkEntity(landmark) {
    return {
      id: `${LANDMARK_PREFIX}${landmark.qid}`,
      name: landmark.label,
      position: Cesium.Cartesian3.fromDegrees(landmark.lon, landmark.lat),
      billboard: {
        image: LANDMARK_ICON,
        width: 22,
        height: 22,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(500, 1.1, 20_000, 0.7),
      },
      properties: { qid: landmark.qid, kind: landmark.kind },
    };
  }

  function renderLandmarks() {
    if (!_landmarkSource) return;
    _landmarkSource.entities.suspendEvents();
    _landmarkSource.entities.removeAll();
    for (const landmark of _landmarks.values())
      _landmarkSource.entities.add(landmarkEntity(landmark));
    _landmarkSource.entities.resumeEvents();
  }

  /** Landmark diamonds only while on and below LANDMARK_MAX_HEIGHT_M. */
  function showLandmarks(view) {
    if (!_landmarkSource) return;
    _landmarkSource.show = Boolean(
      _enabled && view && view.height <= LANDMARK_MAX_HEIGHT_M,
    );
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
    const landmarks = [..._landmarks.values()]
      .map((landmark) => ({
        landmark,
        d: distanceM(view.lat, view.lon, landmark.lat, landmark.lon),
      }))
      .filter(({ d }) => d <= LABEL_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, LANDMARK_LABEL_LIMIT);
    const landmarkLabels = landmarks.map(({ landmark, d }) => {
      const count = _landmarkVideos.get(landmark.qid)?.length;
      return {
        id: `landmark:${landmark.qid}`,
        position: Cesium.Cartesian3.fromDegrees(landmark.lon, landmark.lat),
        variant: 'label',
        title: landmark.label.slice(0, 48),
        details: [
          Number.isFinite(count)
            ? // i18n-ignore: personal fork, English-only UI
              `${count} VIDEO${count === 1 ? '' : 'S'}`
            : // i18n-ignore: personal fork, English-only UI
              'LANDMARK',
        ],
        accent: SOURCE_COLOR.landmark,
        priority: Math.round((LABEL_RADIUS_M - d) / 2),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        verticalOnly: true,
        placement: 'above',
      };
    });
    overlayHost.setEntries(
      RECORDED_VIDEO_LAYER_ID,
      landmarkLabels.concat(
        nearest.map(({ record, d }) => ({
          id: record.id,
          position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
          variant: 'label',
          title: record.title.slice(0, 48),
          details: [precisionLabel(record.coordinatesQuality)],
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
      ),
      {
        cohortLimit: LABEL_LIMIT + LANDMARK_LABEL_LIMIT,
        collisionCapacity: 20,
        moving: false,
      },
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
      notify();
      return true;
    } catch (error) {
      if (!request.signal.aborted)
        _lastError = error?.message || msg('Recorded video unavailable');
      return false;
    } finally {
      if (_wikidataRequest === request) _wikidataRequest = null;
    }
  }

  async function searchView(query, { refresh = false } = {}) {
    if (_nearRequest) {
      // One in flight: the newest settled view goes next.
      _pendingQuery = { query, refresh };
      return;
    }
    if (!refresh && _cellsAsked.has(query.cell)) return;
    _cellsAsked.add(query.cell);
    const request = new AbortController();
    _nearRequest = request;
    try {
      const result = await fetchNearVideos(
        query.lat,
        query.lon,
        query.radiusKm,
        { ...fetchOptions, signal: request.signal, refresh },
      );
      if (request.signal.aborted || !_enabled) return;
      _refused = result.refused;
      if (result.quota) _quota = result.quota;
      _lastSearch = {
        cell: query.cell,
        at: Date.now(),
        cached: result.cached,
        refused: result.refused,
        configured: result.configured,
      };
      if (result.refused) _cellsAsked.delete(query.cell);
      // A refreshed answer replaces that view's geotags.
      if (refresh && !result.refused)
        for (const [id, record] of _records)
          if (record.source !== 'wikidata' && record.cell === query.cell)
            _records.delete(id);
      if (
        addRecords(result.records.map((r) => ({ ...r, cell: query.cell }))) ||
        refresh
      ) {
        render();
        refreshLabels();
      }
      notify();
    } catch (error) {
      _cellsAsked.delete(query.cell);
      if (!request.signal.aborted)
        _lastError = error?.message || msg('Recorded video search failed');
    } finally {
      if (_nearRequest === request) _nearRequest = null;
      const next = _pendingQuery;
      _pendingQuery = null;
      if (next && _enabled) searchView(next.query, { refresh: next.refresh });
    }
  }

  /** The landmarks around a low view (the server fills its cells a few at a time). */
  async function loadLandmarks(view) {
    // 0.05° areas: one answered in full is not asked again.
    const area = `${Math.round(view.lat * 20)},${Math.round(view.lon * 20)}`;
    if (_landmarkAreasDone.has(area)) return;
    if (_landmarkRequest) {
      _landmarkPending = view;
      return;
    }
    const request = new AbortController();
    _landmarkRequest = request;
    try {
      const result = await fetchLandmarksNear(
        view.lat,
        view.lon,
        LANDMARK_RADIUS_KM,
        { ...fetchOptions, signal: request.signal },
      );
      if (request.signal.aborted || !_enabled) return;
      if (!result.pending) _landmarkAreasDone.add(area);
      let added = 0;
      for (const landmark of result.landmarks)
        if (!_landmarks.has(landmark.qid)) {
          _landmarks.set(landmark.qid, landmark);
          added++;
        }
      if (added) {
        renderLandmarks();
        refreshLabels();
      }
      notify();
    } catch (error) {
      if (!request.signal.aborted)
        // i18n-ignore: personal fork, English-only UI
        _lastError = error?.message || 'Landmarks unavailable';
    } finally {
      if (_landmarkRequest === request) _landmarkRequest = null;
      const next = _landmarkPending;
      _landmarkPending = null;
      if (next && _enabled) loadLandmarks(next);
    }
  }

  /**
   * Ask for one landmark's videos (once; again with refresh) and select it.
   * Resolves to its state, or null when off or unknown.
   */
  async function openLandmark(qid, { refresh = false } = {}) {
    if (!_enabled || !_landmarks.has(qid)) return null;
    _selectedLandmark = qid;
    const state = _landmarkState.get(qid);
    if (state?.loading || (state?.done && !refresh)) {
      notify();
      return state;
    }
    _landmarkState.set(qid, { ...state, loading: true });
    notify();
    let next;
    try {
      const result = await fetchLandmarkVideos(qid, {
        ...fetchOptions,
        refresh,
      });
      if (result.quota) _quota = result.quota;
      next = {
        loading: false,
        done: !result.refused && result.configured,
        refused: result.refused,
        configured: result.configured,
        cached: result.cached,
        error: null,
      };
      if (!result.refused && _enabled) {
        // Only this landmark's own videos (a Wikidata video of the same id wins).
        const own = result.records.filter(
          (r) => r.source === 'landmark' && r.landmarkQid === qid,
        );
        for (const id of _landmarkVideos.get(qid) || []) _records.delete(id);
        addRecords(own);
        _landmarkVideos.set(
          qid,
          own.map((r) => r.id).filter((id) => _records.has(id)),
        );
        render();
        refreshLabels();
      }
    } catch (error) {
      next = {
        loading: false,
        done: false,
        // i18n-ignore: personal fork, English-only UI
        error: error?.message || 'Landmark videos unavailable',
      };
    }
    _landmarkState.set(qid, next);
    notify();
    return next;
  }

  /** Play a record; a landmark's video also gets its "mentioned at" moments. */
  function play(record) {
    player.open(record);
    _playing = record.id;
    if (record.source !== 'landmark' || !player.showMentions) return;
    fetchMentions(record.landmarkQid, record.videoId, fetchOptions)
      .then((mentions) => {
        if (_enabled && _playing === record.id && mentions.length)
          player.showMentions(record, mentions);
      })
      .catch(() => {
        /* no moments: the video plays from the start */
      });
  }

  function onSettled() {
    showLandmarks(_enabled ? viewCentre() : null);
    refreshLabels();
    notify();
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
      if (view && view.height <= LANDMARK_MAX_HEIGHT_M) loadLandmarks(view);
    }, SEARCH_DEBOUNCE_MS);
  }

  function onPick(entity) {
    const id = String(entity?.id || '');
    if (!_enabled || !id.startsWith(ENTITY_PREFIX)) return;
    if (id.startsWith(LANDMARK_PREFIX)) {
      openLandmark(id.slice(LANDMARK_PREFIX.length));
      return;
    }
    const record = _records.get(id.slice(ENTITY_PREFIX.length));
    if (record) play(record);
  }

  return {
    id: RECORDED_VIDEO_LAYER_ID,
    name: 'Recorded Video',
    icon: '▶',
    source: 'Wikidata · YouTube geotags · landmarks',
    updateInterval: WIKIDATA_REFRESH_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(RECORDED_VIDEO_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _landmarkSource = new Cesium.CustomDataSource(
        `${RECORDED_VIDEO_LAYER_ID}-landmarks`,
      );
      _landmarkSource.show = false;
      viewer.dataSources.add(_landmarkSource);
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, false);
    },

    enable(viewer) {
      _enabled = true;
      queueMicrotask(notify);
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, true);
      credits?.register?.(viewer || _viewer, {
        key: 'recorded-video-credit',
        html: 'Recorded video: places and landmarks from <a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a> (CC0), uploaders’ YouTube geotags and YouTube search; caption moments from <a href="https://filmot.com/" target="_blank" rel="noopener">Filmot</a>; videos play in YouTube’s player',
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
      _landmarkRequest?.abort();
      _landmarkPending = null;
      _playing = null;
      clearTimeoutImpl(_debounce);
      _debounce = null;
      if (_dataSource) _dataSource.show = false;
      if (_landmarkSource) _landmarkSource.show = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      _removeClick?.();
      _removeClick = null;
      player.close();
      overlayHost?.clearSource(RECORDED_VIDEO_LAYER_ID);
      overlayHost?.setVisible(RECORDED_VIDEO_LAYER_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      return loadWikidata();
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      if (_landmarkSource && viewer)
        viewer.dataSources.remove(_landmarkSource, true);
      _dataSource = null;
      _landmarkSource = null;
      _landmarks.clear();
      _landmarkVideos.clear();
      _landmarkState.clear();
      _landmarkAreasDone.clear();
      _selectedLandmark = null;
      _viewer = null;
      _records.clear();
      _cellsAsked.clear();
      _wikidataAt = 0;
      _lastError = null;
    },

    getStats() {
      const bySource = { wikidata: 0, 'youtube-geotag': 0, landmark: 0 };
      for (const record of _records.values()) bySource[record.source]++;
      return {
        count: _records.size,
        ...bySource,
        landmarks: _landmarks.size,
        refused: _refused,
        error: _lastError,
      };
    },

    /** Personal fork: the RECORDED VIDEO panel's view of the layer. */
    records: () => [..._records.values()],
    isEnabled: () => _enabled,
    viewCentre: () => (_enabled ? viewCentre() : null),
    quota: () => _quota,
    lastSearch: () => _lastSearch,
    /** Landmarks near the view with their state; videoCount is null until asked. */
    landmarks: () =>
      [..._landmarks.values()].map((landmark) => {
        const state = _landmarkState.get(landmark.qid) || {};
        const ids = _landmarkVideos.get(landmark.qid);
        return {
          ...landmark,
          loading: Boolean(state.loading),
          refused: Boolean(state.refused),
          configured: state.configured !== false,
          error: state.error || null,
          videoCount: ids ? ids.length : null,
        };
      }),
    /** A landmark's videos in ranked order. */
    landmarkVideos: (qid) =>
      (_landmarkVideos.get(qid) || [])
        .map((id) => _records.get(id))
        .filter(Boolean),
    selectedLandmark: () => _selectedLandmark,
    openLandmark,
    /** Listen for changes; returns the unsubscribe. */
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    /** Fly to a record's pin and play it. */
    focus(record) {
      if (!_enabled || !record) return;
      _viewer?.camera?.flyTo?.({
        destination: Cesium.Cartesian3.fromDegrees(
          record.lon,
          record.lat,
          1800,
        ),
        duration: 1.6,
      });
      play(record);
    },
    /**
     * Ask YouTube again for the current view (the 7-day answer is skipped),
     * budget permitting. False when the view is too high to search.
     */
    searchAgain() {
      if (!_enabled) return false;
      const view = viewCentre();
      const query = view
        ? viewQuery(view.lat, view.lon, view.height, {
            maxHeightM: SEARCH_MAX_HEIGHT_M,
          })
        : null;
      if (!query) return false;
      searchView(query, { refresh: true });
      return true;
    },
    _pick: onPick,
  };
}
