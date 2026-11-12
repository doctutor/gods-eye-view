/**
 * Personal fork: the TREEMAP window's link to the globe, minimal
 * (docs/TREEMAP-PLAN.md): hovering a tile outlines its `geo` (a GeoRef the
 * source turns into GeoJSON: /api/treemap/geo, or a box) as ground
 * polylines, as the river reach highlight draws its reach
 * (src/layers/rivers/reachHighlight.js); double-clicking flies there.
 * Lines only: no text on the globe.
 */
import * as Cesium from 'cesium';

/** The outline's look. */
export const TREEMAP_OUTLINE = Object.freeze({
  color: '#00d4ff',
  alpha: 0.95,
  width: 3,
});
/** Hover settles this long before the outline is asked (ms). */
export const OUTLINE_DEBOUNCE_MS = 120;
/** At most this many vertices a ring are drawn (the rest thinned). */
const MAX_RING_VERTICES = 2000;

/** The outer and inner rings of a GeoJSON object, as [[lon, lat]…] lists. */
export function ringsOf(geojson) {
  const out = [];
  const visit = (geometry) => {
    if (!geometry) return;
    switch (geometry.type) {
      case 'Feature':
        visit(geometry.geometry);
        break;
      case 'FeatureCollection':
        for (const feature of geometry.features || []) visit(feature);
        break;
      case 'GeometryCollection':
        for (const part of geometry.geometries || []) visit(part);
        break;
      case 'Polygon':
        for (const ring of geometry.coordinates || []) out.push(ring);
        break;
      case 'MultiPolygon':
        for (const polygon of geometry.coordinates || [])
          for (const ring of polygon) out.push(ring);
        break;
      case 'LineString':
        out.push(geometry.coordinates || []);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates || []) out.push(line);
        break;
      default:
        break;
    }
  };
  visit(geojson);
  return out
    .filter((ring) => Array.isArray(ring) && ring.length >= 2)
    .map((ring) => {
      if (ring.length <= MAX_RING_VERTICES) return ring;
      const step = Math.ceil(ring.length / MAX_RING_VERTICES);
      const thin = ring.filter((_, k) => k % step === 0);
      thin.push(ring[ring.length - 1]);
      return thin;
    });
}

/** The [w, s, e, n] around a GeoJSON object's rings; null when empty. */
export function boundsOf(geojson) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of ringsOf(geojson))
    for (const [lon, lat] of ring) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * @param {{viewer: object, source: {geo: (ref: string) => Promise<object>},
 *   cesium?: object, requestRender?: () => void,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} options
 */
export function createTreemapGlobeLink({
  viewer,
  source,
  cesium = Cesium,
  requestRender = () => viewer?.scene?.requestRender?.(),
  setTimer = (...args) => setTimeout(...args),
  clearTimer = (...args) => clearTimeout(...args),
}) {
  let primitive = null;
  let shown = null;
  let wanted = null;
  let timer = null;
  let token = 0;
  let destroyed = false;
  const cache = new Map();

  const geoOf = async (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    const geojson = await source.geo(ref);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    cache.set(ref, geojson || null);
    return geojson || null;
  };

  function remove() {
    if (!primitive) return;
    const scene = viewer?.scene;
    try {
      scene?.groundPrimitives?.remove(primitive);
      scene?.primitives?.remove(primitive);
    } catch {
      /* gone with the scene */
    }
    primitive = null;
    shown = null;
    requestRender();
  }

  function draw(ref, geojson) {
    remove();
    const scene = viewer?.scene;
    const rings = ringsOf(geojson);
    if (!scene || !rings.length) return;
    let ground = true;
    try {
      ground = cesium.GroundPolylinePrimitive.isSupported(scene);
    } catch {
      ground = false;
    }
    const color = cesium.Color.fromCssColorString(
      TREEMAP_OUTLINE.color,
    ).withAlpha(TREEMAP_OUTLINE.alpha);
    const instances = rings.map(
      (ring, index) =>
        new cesium.GeometryInstance({
          id: `treemap-outline-${index}`,
          geometry: new (ground
            ? cesium.GroundPolylineGeometry
            : cesium.PolylineGeometry)({
            positions: cesium.Cartesian3.fromDegreesArray(ring.flat()),
            width: TREEMAP_OUTLINE.width,
            arcType: cesium.ArcType.GEODESIC,
          }),
          attributes: {
            color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
          },
        }),
    );
    const appearance = new cesium.PolylineColorAppearance();
    primitive = ground
      ? scene.groundPrimitives.add(
          new cesium.GroundPolylinePrimitive({
            geometryInstances: instances,
            appearance,
            classificationType: cesium.ClassificationType.BOTH,
            asynchronous: true,
          }),
        )
      : scene.primitives.add(
          new cesium.Primitive({
            geometryInstances: instances,
            appearance,
            asynchronous: true,
          }),
        );
    shown = ref;
    requestRender();
  }

  return {
    /** Outline the tile's geo (null: none). */
    outline(ref) {
      if (destroyed) return;
      wanted = ref || null;
      if (timer) clearTimer(timer);
      timer = null;
      if (!wanted) {
        token++;
        remove();
        return;
      }
      if (wanted === shown) return;
      const mine = ++token;
      timer = setTimer(() => {
        timer = null;
        geoOf(wanted).then(
          (geojson) => {
            if (mine !== token || destroyed) return;
            draw(wanted, geojson);
          },
          () => {
            if (mine === token) remove();
          },
        );
      }, OUTLINE_DEBOUNCE_MS);
    },
    /** Fly to the tile's geo: its extent, or a point from 60 km. */
    async flyTo(ref) {
      if (destroyed || !ref) return false;
      let geojson = null;
      try {
        geojson = await geoOf(ref);
      } catch {
        return false;
      }
      const box = boundsOf(geojson);
      const camera = viewer?.camera;
      if (!box || !camera) return false;
      const [w, s, e, n] = box;
      if (w === e && s === n)
        camera.flyTo({
          destination: cesium.Cartesian3.fromDegrees(w, s, 60_000),
        });
      else
        camera.flyTo({
          destination: cesium.Rectangle.fromDegrees(w, s, e, n),
        });
      return true;
    },
    shown: () => shown,
    destroy() {
      destroyed = true;
      if (timer) clearTimer(timer);
      remove();
    },
  };
}
