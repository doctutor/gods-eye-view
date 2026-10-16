import * as Cesium from 'cesium';

/**
 * Personal fork: proximity loading. The initial catalog is the server's capped
 * worldwide set; wherever the view settles, this asks the server for every
 * indexed camera near the centre of the view (uncapped, public-interest
 * streams ranked first) and adds the ones the layer does not have yet.
 * Cameras added this way are dropped again, farthest first, once more than
 * PROXIMITY_WORKING_SET of them have accumulated; the initial catalog is never
 * touched.
 */

/** Cameras asked for per settled view. */
export const PROXIMITY_LIMIT = 400;
/** Cameras added by proximity that are kept before the farthest go. */
export const PROXIMITY_WORKING_SET = 2500;
/** Above this altitude the view is regional or wider: nothing is fetched. */
export const PROXIMITY_MAX_ALTITUDE_M = 400_000;
/** Wait this long after the view settles, so a quick pan-and-stop is one fetch. */
const SETTLE_MS = 500;

const toRad = Math.PI / 180;

export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Search radius for a view from this altitude: about what is on screen, never
 * tighter than a neighbourhood nor wider than a region.
 * @param {number} altitudeM
 * @returns {number} Radius in km.
 */
export function proximityRadiusKm(altitudeM) {
  const km = (Number(altitudeM) / 1000) * 1.5;
  return Math.min(200, Math.max(3, Number.isFinite(km) ? km : 3));
}

/**
 * Whether a new view needs a new query: it moved well away from the last
 * centre, or zoomed far enough that the radius changed a lot.
 * @param {{lat:number, lon:number, radiusKm:number}|null} last
 * @param {{lat:number, lon:number, radiusKm:number}} next
 */
export function needsRefetch(last, next) {
  if (!last) return true;
  if (distanceKm(last.lat, last.lon, next.lat, next.lon) > last.radiusKm * 0.35)
    return true;
  const ratio = next.radiusKm / last.radiusKm;
  return ratio < 0.5 || ratio > 2;
}

/**
 * The proximity-added records to drop: everything beyond the working set,
 * farthest from the current centre first.
 * @param {Array<Object>} records - Records added by proximity.
 * @param {{lat:number, lon:number}} center
 * @param {number} [keep=PROXIMITY_WORKING_SET]
 * @returns {Array<Object>}
 */
export function recordsToEvict(records, center, keep = PROXIMITY_WORKING_SET) {
  if (records.length <= keep) return [];
  return records
    .map((record) => ({
      record,
      d: distanceKm(
        center.lat,
        center.lon,
        record.camera.lat,
        record.camera.lon,
      ),
    }))
    .sort((a, b) => b.d - a.d)
    .slice(0, records.length - keep)
    .map((entry) => entry.record);
}

export function createProximity({ state: layerState, parts, source }) {
  let lastQuery = null;
  let timer = 0;
  let inflight = null;
  let listener = null;
  /** Ids of cameras this module added. */
  const added = new Set();

  function viewCenter(viewer) {
    const camera = viewer.camera;
    const altitude = camera.positionCartographic?.height;
    const canvas = viewer.scene.canvas;
    const hit = camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const carto = hit
      ? Cesium.Cartographic.fromCartesian(hit)
      : camera.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      altitude,
    };
  }

  async function refresh() {
    timer = 0;
    const viewer = layerState._viewer;
    if (!layerState._enabled || !viewer) return;
    const center = viewCenter(viewer);
    if (!center || !(center.altitude <= PROXIMITY_MAX_ALTITUDE_M)) return;
    const query = {
      lat: center.lat,
      lon: center.lon,
      radiusKm: proximityRadiusKm(center.altitude),
    };
    if (!needsRefetch(lastQuery, query)) return;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    try {
      const data = await source.getNearby(query.lat, query.lon, {
        radiusKm: query.radiusKm,
        limit: PROXIMITY_LIMIT,
        signal: controller.signal,
      });
      if (controller.signal.aborted || !layerState._enabled) return;
      lastQuery = query;
      const missing = data.sources.filter(
        (item) => item?.id && !layerState._recordById.has(String(item.id)),
      );
      const cameras = parts.catalog.buildCatalogFromSources(missing);
      const records = parts.lifecycle.addRecords(cameras);
      for (const record of records) added.add(record.camera.id);
      const tracked = [...added]
        .map((id) => layerState._recordById.get(id))
        .filter(Boolean);
      for (const id of added)
        if (!layerState._recordById.has(id)) added.delete(id);
      const evicted = recordsToEvict(tracked, query);
      const removed = parts.lifecycle.removeRecords(evicted);
      for (const record of evicted)
        if (!layerState._recordById.has(record.camera.id))
          added.delete(record.camera.id);
      if (records.length || removed)
        console.log(
          `[Data:CCTV] Nearby: +${records.length} cameras within ${Math.round(query.radiusKm)} km` +
            (removed ? `, ${removed} distant dropped` : '') +
            ` (${layerState._count} loaded)`,
        );
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn('[Data:CCTV] Nearby cameras unavailable:', error?.message);
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, SETTLE_MS);
  }

  return {
    /** Follow the view while the layer is enabled. */
    start() {
      if (typeof source.getNearby !== 'function') return;
      const viewer = layerState._viewer;
      if (!viewer || listener) return;
      listener = schedule;
      viewer.camera.moveEnd.addEventListener(listener);
      schedule();
    },
    stop() {
      clearTimeout(timer);
      timer = 0;
      inflight?.abort();
      inflight = null;
      if (listener)
        layerState._viewer?.camera.moveEnd.removeEventListener(listener);
      listener = null;
      // A later enable starts from wherever the view is then.
      lastQuery = null;
    },
    /** Forget what was added (the catalog was rebuilt). */
    reset() {
      added.clear();
      lastQuery = null;
    },
    addedCount: () => added.size,
  };
}
