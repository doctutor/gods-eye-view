// Personal fork: draws the Countries basemap as Cesium geometry on the
// globe. Country fills are PolygonGeometry instances in one Primitive with a
// per-instance colour; outlines are PolylineGeometry instances in another.
// The subdivisions style adds first-level units around the view below a
// camera height, and the hex style replaces the polygons with a hex
// tessellation of land (hexGrid.js). Both view-dependent groups are rebuilt
// when the view moves far enough, the planet-wide groups only when the
// style, theme or opacity changes. No tiles, no server: the geometry comes
// from the bundled Natural Earth packs, loaded on first use.

import * as Cesium from 'cesium';
import { loadBundledJson } from '../../data/bundledJson.js';
import { SUBDIVISIONS_MAX_HEIGHT_M } from './catalog.js';
import { decodePack, featureAt, partsInRectangle } from './geometry.js';
import {
  hexCellsForView,
  hexTierForHeight,
  localGridStale,
  localHalfSideKm,
} from './hexGrid.js';
import { COUNTRY_THEMES, fillFor, onCountryFillChange } from './palette.js';

/** The fill opacity kept in this browser. */
export const OPACITY_STORAGE_KEY = 'gev.countries.opacity';

/** The credit line every countries style shows. */
export const NATURAL_EARTH_CREDIT =
  'Made with <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>';

const PACKS = {
  countries: new URL(
    '../../data/local_data/natural_earth/countries.json',
    import.meta.url,
  ),
  admin1: new URL(
    '../../data/local_data/natural_earth/states_provinces.json',
    import.meta.url,
  ),
};

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** The opacity stored for the basemap, else 1. */
export function readOpacity(storage) {
  try {
    const raw = storage?.getItem?.(OPACITY_STORAGE_KEY);
    const value = Number(raw);
    return raw !== null && raw !== undefined && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 1;
  } catch {
    return 1;
  }
}

/** The lon/lat rectangle around a view that the local groups cover. */
export function viewRectangleDegrees(lat, lon, heightM) {
  const halfKm = localHalfSideKm(heightM);
  const dLat = halfKm / 111.32;
  const dLon =
    halfKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  if (dLon >= 180) return { west: -180, east: 180, south: -90, north: 90 };
  return {
    west: wrap(lon - dLon),
    east: wrap(lon + dLon),
    south: Math.max(-90, lat - dLat),
    north: Math.min(90, lat + dLat),
  };
}

/**
 * Create the renderer for one viewer.
 * @param {{ viewer: object, cesium?: object, loadPack?: (name: 'countries' | 'admin1') => Promise<object>, requestRender?: (reason: string) => void, storage?: object | null }} options
 */
export function createCountriesRenderer({
  viewer,
  cesium = Cesium,
  loadPack = (name) => loadBundledJson(PACKS[name]),
  requestRender = () => {},
  storage,
}) {
  const store = storageOf(storage);
  let _record = null;
  let _opacity = readOpacity(store);
  let _gen = 0;
  let _destroyed = false;
  let _removeMove = null;
  const _packs = { countries: null, admin1: null };
  const _loading = { countries: null, admin1: null };
  /** Planet-wide and view-bound primitives, kept apart so moves are cheap. */
  const _world = { fills: null, outlines: null };
  const _local = { fills: null, outlines: null, admin1: null };
  /** What the local group was made for, and the hex grid it holds. */
  let _madeFor = null;
  let _hex = null;
  let _worldKey = '';

  const offFill = onCountryFillChange(() => {
    _worldKey = ''; // the colours changed under the same key
    if (_record) void build({ world: true, local: true });
  });

  async function pack(name) {
    if (_packs[name]) return _packs[name];
    if (!_loading[name])
      _loading[name] = Promise.resolve()
        .then(() => loadPack(name))
        .then((raw) => {
          _packs[name] = decodePack(raw);
          return _packs[name];
        })
        .catch((error) => {
          _loading[name] = null;
          throw error;
        });
    return _loading[name];
  }

  function cameraHeight() {
    const height = viewer?.camera?.positionCartographic?.height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /** The point under the middle of the view (else under the camera), and the height. */
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
    return {
      lat: degrees(point?.latitude),
      lon: degrees(point?.longitude),
      heightM: cameraHeight(),
    };
  }

  const colour = (css, alpha = 1) =>
    cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const positions = (ring) => cesium.Cartesian3.fromDegreesArray(ring.flat());

  function fillInstance(polygon, color, id) {
    if (polygon.outer.length < 3) return null;
    return new cesium.GeometryInstance({
      id,
      geometry: new cesium.PolygonGeometry({
        polygonHierarchy: new cesium.PolygonHierarchy(
          positions(polygon.outer),
          polygon.holes
            .filter((hole) => hole.length >= 3)
            .map((hole) => new cesium.PolygonHierarchy(positions(hole))),
        ),
        vertexFormat: cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    });
  }

  function outlineInstance(ring, color, width, id) {
    if (ring.length < 2) return null;
    return new cesium.GeometryInstance({
      id,
      geometry: new cesium.PolylineGeometry({
        positions: positions([...ring, ring[0]]),
        width,
        vertexFormat: cesium.PolylineColorAppearance.VERTEX_FORMAT,
        arcType: cesium.ArcType.GEODESIC,
      }),
      attributes: {
        color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    });
  }

  function fillPrimitive(instances) {
    if (!instances.length) return null;
    return new cesium.Primitive({
      geometryInstances: instances,
      appearance: new cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: _opacity < 1,
      }),
      asynchronous: true,
      allowPicking: false,
      releaseGeometryInstances: true,
    });
  }

  function linePrimitive(instances) {
    if (!instances.length) return null;
    return new cesium.Primitive({
      geometryInstances: instances,
      appearance: new cesium.PolylineColorAppearance({ translucent: false }),
      asynchronous: true,
      allowPicking: false,
      releaseGeometryInstances: true,
    });
  }

  function add(primitive) {
    if (primitive) viewer.scene.primitives.add(primitive);
    return primitive;
  }

  function remove(group, key) {
    const primitive = group[key];
    group[key] = null;
    if (!primitive) return;
    try {
      viewer.scene.primitives.remove(primitive);
    } catch {
      /* already gone with the scene */
    }
  }

  function clear(group) {
    for (const key of Object.keys(group)) remove(group, key);
  }

  /** The planet-wide country polygons (simple and subdivisions styles). */
  function buildWorld(features) {
    clear(_world);
    const theme = COUNTRY_THEMES[_record.theme];
    const options = { theme: _record.theme, style: _record.style };
    const fills = [];
    const outlines = [];
    const outline = colour(theme.outline);
    for (const feature of features) {
      const fill = colour(fillFor(feature, options), _opacity);
      feature.polygons.forEach((polygon, index) => {
        const id = `${feature.id}/${index}`;
        const instance = fillInstance(polygon, fill, id);
        if (instance) fills.push(instance);
        const line = outlineInstance(
          polygon.outer,
          outline,
          theme.outlineWidth,
          id,
        );
        if (line) outlines.push(line);
      });
    }
    _world.fills = add(fillPrimitive(fills));
    _world.outlines = add(linePrimitive(outlines));
  }

  /** First-level units around the view (subdivisions style, low enough). */
  function buildAdmin1(units, view) {
    clear(_local);
    _hex = null;
    _madeFor = null;
    if (view.heightM >= SUBDIVISIONS_MAX_HEIGHT_M) return;
    const theme = COUNTRY_THEMES[_record.theme];
    const rect = viewRectangleDegrees(view.lat, view.lon, view.heightM);
    const line = colour(theme.admin1Outline);
    const outlines = [];
    for (const { feature, polygon } of partsInRectangle(units, rect)) {
      const instance = outlineInstance(
        polygon.outer,
        line,
        theme.admin1OutlineWidth,
        feature.id,
      );
      if (instance) outlines.push(instance);
    }
    _local.admin1 = add(linePrimitive(outlines));
    _madeFor = {
      lon: view.lon,
      lat: view.lat,
      heightM: view.heightM,
      halfSideKm: localHalfSideKm(view.heightM),
    };
  }

  /** The hex tessellation of land for the view (hex style). */
  function buildHex(features, view) {
    clear(_local);
    const theme = COUNTRY_THEMES[_record.theme];
    const options = { theme: _record.theme, style: 'hex' };
    const grid = hexCellsForView(view, (lon, lat) =>
      featureAt(features, lon, lat),
    );
    const outline = colour(theme.hexOutline);
    const fills = [];
    const outlines = [];
    for (const cell of grid.cells) {
      const fill = colour(fillFor(cell.feature, options), _opacity);
      const polygon = { outer: cell.ring, holes: [] };
      const instance = fillInstance(polygon, fill, cell.key);
      if (instance) fills.push(instance);
      const line = outlineInstance(
        cell.ring,
        outline,
        theme.hexOutlineWidth,
        cell.key,
      );
      if (line) outlines.push(line);
    }
    _local.fills = add(fillPrimitive(fills));
    _local.outlines = add(linePrimitive(outlines));
    _hex = { sizeKm: grid.sizeKm, scope: grid.scope, cells: grid.cells.length };
    _madeFor = grid.made;
  }

  /** Whether the view-bound group must be made again for this view. */
  function localStale(view) {
    if (!_record) return false;
    if (_record.style === 'hex') {
      if (!_madeFor) return true;
      if (_madeFor.halfSideKm === null)
        return hexTierForHeight(view.heightM).scope !== 'global';
      return localGridStale(_madeFor, view);
    }
    if (_record.style === 'subdivisions') {
      const wanted = view.heightM < SUBDIVISIONS_MAX_HEIGHT_M;
      if (!wanted) return Boolean(_local.admin1);
      return !_local.admin1 || localGridStale(_madeFor, view);
    }
    return false;
  }

  async function build({ world, local }) {
    const gen = ++_gen;
    const record = _record;
    if (!record) return;
    try {
      const features = await pack('countries');
      const units =
        record.style === 'subdivisions' ? await pack('admin1') : null;
      if (gen !== _gen || _destroyed || _record !== record) return;
      const view = viewNow();
      // The planet-wide group follows the style, theme and opacity whatever
      // asked for this build: a camera move that supersedes a style switch
      // must not leave the old style's polygons on the globe.
      const key = `${record.style}|${record.theme}|${_opacity}`;
      if (record.style === 'hex') {
        if (_world.fills || _world.outlines) clear(_world);
        _worldKey = '';
      } else if (key !== _worldKey || !_world.fills) {
        buildWorld(features);
        _worldKey = key;
      }
      if (local || localStale(view)) {
        if (record.style === 'hex') buildHex(features, view);
        else if (record.style === 'subdivisions') buildAdmin1(units, view);
        else {
          clear(_local);
          _hex = null;
          _madeFor = null;
        }
      }
      requestRender('countries-basemap');
    } catch (error) {
      if (gen === _gen && !_destroyed)
        console.warn('[CountriesBasemap] could not draw:', error);
    }
  }

  function onMoved() {
    if (_destroyed || !_record) return;
    if (localStale(viewNow())) void build({ world: false, local: true });
  }

  return {
    /** Draw a style; a repeated record is a no-op. */
    show(record) {
      if (_destroyed || !record) return;
      const changed = _record?.id !== record.id;
      _record = record;
      if (viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = viewer.camera.moveEnd.addEventListener(onMoved);
      if (changed) void build({ world: true, local: true });
    },
    hide() {
      _gen++;
      _record = null;
      _removeMove?.();
      _removeMove = null;
      clear(_world);
      clear(_local);
      _worldKey = '';
      _hex = null;
      _madeFor = null;
      requestRender('countries-basemap');
    },
    setOpacity(value) {
      _opacity = Math.min(1, Math.max(0, Number(value) || 0));
      try {
        store?.setItem?.(OPACITY_STORAGE_KEY, String(_opacity));
      } catch {
        /* storage is a convenience */
      }
      if (_record) void build({ world: true, local: true });
    },
    getOpacity: () => _opacity,
    /** For tests and the owner: what is drawn. */
    getState() {
      return {
        activeId: _record?.id || null,
        style: _record?.style || null,
        theme: _record?.theme || null,
        opacity: _opacity,
        world: { fills: !!_world.fills, outlines: !!_world.outlines },
        local: {
          fills: !!_local.fills,
          outlines: !!_local.outlines,
          admin1: !!_local.admin1,
        },
        hex: _hex,
        madeFor: _madeFor,
        packs: {
          countries: !!_packs.countries,
          admin1: !!_packs.admin1,
        },
      };
    },
    /** Settled drawing, for tests: resolves once pending builds finished. */
    async settled() {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    destroy() {
      if (_destroyed) return;
      this.hide();
      _destroyed = true;
      offFill();
    },
  };
}
