import * as Cesium from 'cesium';
import { loadBundledJson } from '../../data/bundledJson.js';
import { getLocale } from '../../i18n/index.js';
import { activeLuminance, resolveInk } from '../../maps/ink.js';
import {
  OverpassViewError,
  createOverpassViewClient,
} from '../../sources/overpassView.js';
import {
  OSM_MAX_HEIGHT_M,
  OSM_QUERY_LIMIT,
  PLACE_COLORS,
  boxCovers,
  buildPlacesQuery,
  mergePlaces,
  normalizeOsmPlace,
  osmPlaceKindsForHeight,
  osmQueryBox,
  pickNaturalEarthPlaces,
  placeCardEntry,
  placeLabelEntry,
  placeName,
} from './places.js';
import { placeCardDetails, rowControls } from './presentation.js';

/**
 * Personal fork: the Localities layer (REFERENCE in the DATA LAYERS panel):
 * populated places with their names at every height. From orbit to
 * regional scale, Natural Earth's 7,342 populated places (public domain),
 * bundled as a trimmed pack (src/data/local_data/natural_earth/
 * populated_places.json, built by scripts/build-populated-places-pack.mjs)
 * and named from the zoom Natural Earth gives each (places.js, "Level of
 * detail"); below OSM_MAX_HEIGHT_M, OpenStreetMap's place nodes for the
 * view as well, from Overpass through the app's /api/overpass proxy (which
 * needs OVERPASS_UPSTREAMS; without it the row says so and Natural Earth
 * keeps naming). The names are world-overlay labels (never Cesium labels:
 * src/noCesiumLabels.test.mjs), white on dark maps and imagery and
 * near-black on light maps (the basemap's luminance, src/maps/ink.js);
 * DOTS adds a point at each place. A click on a name or a dot opens a card
 * beside it (kind, country, population, source); a click elsewhere closes
 * it. Everything is rebuilt when the camera settles, nothing per frame.
 */

export const LOCALITIES_LAYER_ID = 'localities';
export const LOCALITIES_SOURCE = 'localities';
export const PLACES_PACK_URL = new URL(
  '../../data/local_data/natural_earth/populated_places.json',
  import.meta.url,
);
export const DOTS_STORAGE_KEY = 'gev.localities.dots';
/** Wait this long after the camera settles before asking Overpass. */
export const OSM_DEBOUNCE_MS = 400;
const DOT_PREFIX = 'locality:';

export const LOCALITIES_CREDIT = Object.freeze({
  key: 'localities',
  html:
    'Places: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain); close in, ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL)',
});

let packPromise = null;
/** The pack ({countries, places}), loaded once on first use. */
export function loadPlacesPack(load = loadBundledJson) {
  packPromise ||= load(PLACES_PACK_URL)
    .then((pack) => ({
      countries: Array.isArray(pack?.countries) ? pack.countries : [],
      places: Array.isArray(pack?.places) ? pack.places : [],
    }))
    .catch((error) => {
      packPromise = null;
      throw error;
    });
  return packPromise;
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** DOTS as stored in this browser; on by default. */
export function readDots(storage) {
  try {
    return storage?.getItem(DOTS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * @param {{overlayHost?: object|null, cesium?: object,
 *   requestRender?: (reason: string) => void, credits?: {register?: Function},
 *   load?: () => Promise<{countries: string[], places: object[]}>,
 *   overpass?: {query: Function, abort: Function}, storage?: Storage|null,
 *   hitTest?: Function, locale?: () => string,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} [options]
 */
export function createLocalitiesLayer({
  overlayHost = null,
  cesium = Cesium,
  requestRender = () => {},
  credits = null,
  load = () => loadPlacesPack(),
  overpass = createOverpassViewClient(),
  storage,
  hitTest = null,
  locale = getLocale,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
} = {}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _pack = null;
  let _dots = readDots(store);
  let _points = null;
  let _removeMove = null;
  let _handler = null;
  let _controller = null;
  let _unsubscribeMap = null;
  let _rowListener = null;
  let _debounce = null;
  /** OpenStreetMap: {state, places, box, kinds, count, saturated}. */
  let _osm = { state: 'above', places: [], box: null, kinds: [], count: 0 };
  let _view = null;
  /** id → {place, lon, lat} of what is drawn now. */
  let _drawn = new Map();
  let _selected = null;
  let _neCount = 0;

  const notify = () => _rowListener?.();

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
      /* no pick: under the camera */
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

  function ink() {
    return resolveInk('auto', activeLuminance(_controller));
  }

  function removePoints() {
    if (!_points) return;
    try {
      _viewer?.scene?.primitives?.remove(_points);
    } catch {
      /* gone with the scene */
    }
    _points = null;
  }

  function drawDots(items, color) {
    removePoints();
    if (!_dots || !items.length || !cesium.PointPrimitiveCollection) return;
    _points = new cesium.PointPrimitiveCollection();
    const fill = cesium.Color.fromCssColorString(color);
    const outline = cesium.Color.fromCssColorString(
      color === PLACE_COLORS.dark ? '#ffffff' : '#000000',
    ).withAlpha(0.6);
    for (const { id, place, lon, lat } of items)
      _points.add({
        id: `${DOT_PREFIX}${id}`,
        position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
        pixelSize: place.cap === 'country' ? 7 : place.cap ? 5 : 4,
        color: fill,
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    _viewer?.scene?.primitives?.add(_points);
  }

  /** Publish the names (and dots, and the card) for the settled view. */
  function draw() {
    if (!_enabled || !_pack || !_view) return;
    const accent = PLACE_COLORS[ink()] || PLACE_COLORS.light;
    const language = locale();
    const close = _view.height < OSM_MAX_HEIGHT_M;
    const merged = mergePlaces(
      pickNaturalEarthPlaces(_pack.places, _view),
      close ? _osm.places : [],
    );
    const items = [...merged.osm, ...merged.naturalEarth];
    _neCount = merged.naturalEarth.length;
    _drawn = new Map(items.map((item) => [item.id, item]));
    const entries = items.map((item) =>
      placeLabelEntry({
        ...item,
        title: placeName(item.place, language),
        accent,
        cesium,
      }),
    );
    if (_selected) {
      const { place, lon, lat } = _selected;
      entries.push(
        placeCardEntry({
          place,
          lon,
          lat,
          title: placeName(place, language),
          details: placeCardDetails(place, _pack.countries),
          accent,
          cesium,
        }),
      );
    }
    drawDots(items, accent);
    try {
      overlayHost?.setEntries(LOCALITIES_SOURCE, entries, { moving: false });
    } catch (error) {
      console.warn('[Localities] names not drawn:', error?.message);
    }
    requestRender('localities');
    notify();
  }

  async function fetchOsm(box, kinds) {
    _osm = { ..._osm, state: 'loading' };
    notify();
    try {
      const { elements } = await overpass.query(
        buildPlacesQuery(box, kinds, OSM_QUERY_LIMIT),
      );
      const places = elements.map(normalizeOsmPlace).filter(Boolean);
      _osm = {
        state: 'ready',
        places,
        box,
        kinds,
        count: places.length,
        saturated: elements.length >= OSM_QUERY_LIMIT,
      };
    } catch (error) {
      if (error?.name === 'AbortError') return;
      const code = error instanceof OverpassViewError ? error.code : 'failed';
      _osm = {
        state: code,
        places: _osm.box && boxCovers(_osm.box, box) ? _osm.places : [],
        box: null,
        kinds: [],
        count: 0,
      };
      if (code === 'limited' && error.retryAfterMs)
        _debounce = setTimeoutImpl(
          () => _enabled && settle(),
          error.retryAfterMs,
        );
    }
    draw();
  }

  /** The camera settled: name what it sees, and ask OpenStreetMap close in. */
  function settle() {
    if (!_enabled) return;
    _view = viewNow();
    clearTimeoutImpl(_debounce);
    _debounce = null;
    const kinds = osmPlaceKindsForHeight(_view.height);
    if (!kinds.length) {
      overpass.abort?.();
      _osm = { state: 'above', places: [], box: null, kinds: [], count: 0 };
    } else if (_osm.state !== 'unconfigured') {
      const box = osmQueryBox(_view);
      const covered =
        _osm.state === 'ready' &&
        boxCovers(_osm.box, box) &&
        kinds.every((kind) => _osm.kinds.includes(kind));
      if (!covered)
        _debounce = setTimeoutImpl(() => {
          _debounce = null;
          fetchOsm(box, kinds);
        }, OSM_DEBOUNCE_MS);
    }
    draw();
  }

  function select(id) {
    const item = id ? _drawn.get(id) : null;
    _selected =
      item && _selected?.id !== item.id ? { ...item, id: item.id } : null;
    draw();
  }

  /** A click: on one of our names or dots opens its card; elsewhere closes it. */
  function onClick(position) {
    if (!_enabled) return;
    const hit = hitTest?.(position.x, position.y, {
      sourceId: LOCALITIES_SOURCE,
    });
    if (hit?.entryId && hit.entryId !== 'card') return select(hit.entryId);
    let picked = null;
    try {
      picked = _viewer?.scene?.pick?.(position);
    } catch {
      picked = null;
    }
    const pickedId = String(picked?.id ?? '');
    if (pickedId.startsWith(DOT_PREFIX))
      return select(pickedId.slice(DOT_PREFIX.length));
    if (_selected && hit?.entryId !== 'card') {
      _selected = null;
      draw();
    }
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

  function setDots(on) {
    _dots = on !== false;
    try {
      store?.setItem(DOTS_STORAGE_KEY, _dots ? '1' : '0');
    } catch {
      /* private mode: kept for this page only */
    }
    draw();
    notify();
  }

  return {
    id: LOCALITIES_LAYER_ID,
    name: 'Localities',
    icon: '◉',
    source: 'Natural Earth · OpenStreetMap',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_enabled) return;
      _enabled = true;
      overlayHost?.setVisible(LOCALITIES_SOURCE, true);
      credits?.register?.(_viewer, LOCALITIES_CREDIT);
      if (_viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = _viewer.camera.moveEnd.addEventListener(settle);
      attachClick();
      if (!_pack)
        load()
          .then((pack) => {
            _pack = pack;
            draw();
          })
          .catch((error) => {
            console.warn('[Localities] places not loaded:', error?.message);
          });
      settle();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      clearTimeoutImpl(_debounce);
      _debounce = null;
      overpass.abort?.();
      _removeMove?.();
      _removeMove = null;
      try {
        _handler?.destroy?.();
      } catch {
        /* already gone */
      }
      _handler = null;
      removePoints();
      _selected = null;
      _drawn = new Map();
      _neCount = 0;
      overlayHost?.clearSource(LOCALITIES_SOURCE);
      overlayHost?.setVisible(LOCALITIES_SOURCE, false);
      requestRender('localities-hide');
      notify();
    },

    async update() {
      // Nothing on a clock: the names follow the camera.
      return _enabled;
    },

    destroy() {
      this.disable();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = null;
      _viewer = null;
      _rowListener = null;
    },

    /** The map stack controller: the basemap's luminance picks the ink. */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _controller = controller || null;
      const off = _controller?.subscribe?.(() => draw());
      _unsubscribeMap = typeof off === 'function' ? off : null;
      draw();
    },

    getStats() {
      return {
        count: _drawn.size,
        countLabel: _enabled ? String(_drawn.size) : '—',
      };
    },

    getRowControls() {
      return rowControls({
        dots: _dots,
        onDots: setDots,
        enabled: _enabled,
        naturalEarth: _neCount,
        osm: _osm,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests: what is drawn and asked. */
    _state: () => ({
      view: _view,
      osm: _osm,
      drawn: _drawn,
      selected: _selected,
      dots: _dots,
      points: _points,
    }),
    _onClick: onClick,
    _settle: settle,
  };
}
