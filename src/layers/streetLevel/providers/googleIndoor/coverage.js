// Personal fork: indoor-view pins for the view, and probes of unexplored ground.
import { msg } from '../../../../i18n/marker.js';
import * as Cesium from 'cesium';
import { passesImageryFilter } from '../../filter.js';
import {
  cameraHeightAboveGround,
  metresBetween,
  viewCentre,
} from '../../view.js';
import {
  COLORS,
  COVERAGE_DEBOUNCE_MS,
  COVERAGE_MAX_HEIGHT_M,
  FETCH_RADIUS_MAX_M,
  FETCH_RADIUS_MIN_M,
  FETCH_RADIUS_PER_HEIGHT,
  MAX_PINS,
  PICK_PREFIX,
  PIN_SIZE_PX,
  PROBE_BACKOFF_MS,
  PROBE_BELOW_HEIGHT_M,
  PROBE_RADIUS_KM,
  isPanoId,
  panoDateMs,
} from './policy.js';

/** Hits further than this many fetch radii from the view are forgotten. */
const PRUNE_FACTOR = 4;

/** Radius (m) of ground worth fetching hits for at a camera height. */
export function fetchRadiusM(heightM) {
  if (!Number.isFinite(heightM)) return FETCH_RADIUS_MIN_M;
  return Math.min(
    FETCH_RADIUS_MAX_M,
    Math.max(FETCH_RADIUS_MIN_M, heightM * FETCH_RADIUS_PER_HEIGHT),
  );
}

/**
 * Whether to probe now: zoomed in, the server reports unprobed cells, no
 * probe in flight or held back, and quota left today.
 */
export function shouldProbe({
  heightM,
  unprobedCells,
  probing,
  holdUntil,
  now,
  remainingToday,
}) {
  if (!Number.isFinite(heightM) || heightM > PROBE_BELOW_HEIGHT_M) return false;
  if (!(unprobedCells > 0) || probing) return false;
  if (now < holdUntil) return false;
  if (Number.isFinite(remainingToday) && remainingToday <= 0) return false;
  return true;
}

/** A hit as the imagery filter sees it: always a panorama, dated by month. */
function filterRecord(hit) {
  return { isPano: true, capturedAt: panoDateMs(hit.panoDate) || 0 };
}

/**
 * Coverage over the provider state: fetch the database's hits for the view on
 * camera settle, draw them as pins, and probe unexplored ground when zoomed in.
 */
export function createIndoorCoverage({ state, source, now = Date.now }) {
  const { context } = state;
  const cov = state.coverage;

  function requestRender() {
    context.services?.render?.governorRequestRender?.('gsv-indoor-coverage');
  }

  function hits() {
    return [...cov.hits.values()];
  }

  function visibleHits() {
    const filter = context.getFilter();
    return hits().filter((hit) =>
      passesImageryFilter(filterRecord(hit), filter),
    );
  }

  function removeCollection() {
    if (!cov.collection) return;
    const scene = state.viewer?.scene;
    try {
      scene?.primitives?.remove(cov.collection);
    } catch {
      /* already gone */
    }
    if (!cov.collection.isDestroyed?.()) cov.collection.destroy?.();
    cov.collection = null;
  }

  function draw() {
    removeCollection();
    const scene = state.viewer?.scene;
    cov.drawn = 0;
    if (!scene?.primitives || !context.isActive()) return;
    const shown = visibleHits().slice(0, MAX_PINS);
    if (!shown.length) {
      requestRender();
      return;
    }
    const collection = new Cesium.PointPrimitiveCollection();
    const color = Cesium.Color.fromCssColorString(COLORS.coverage);
    for (const hit of shown)
      collection.add({
        id: `${PICK_PREFIX.pano}${hit.panoId}`,
        position: Cesium.Cartesian3.fromDegrees(hit.lon, hit.lat),
        color,
        pixelSize: PIN_SIZE_PX,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    scene.primitives.add(collection);
    cov.collection = collection;
    cov.drawn = shown.length;
    requestRender();
  }

  function merge(list) {
    let changed = false;
    for (const hit of Array.isArray(list) ? list : []) {
      if (!isPanoId(hit?.panoId)) continue;
      if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) continue;
      const previous = cov.hits.get(hit.panoId);
      if (
        !previous ||
        previous.checkedAt !== hit.checkedAt ||
        previous.name !== hit.name
      ) {
        cov.hits.set(hit.panoId, { ...hit });
        changed = true;
      }
    }
    return changed;
  }

  /** Forget hits far from the view, so a long session stays small. */
  function prune(centre) {
    const keep = FETCH_RADIUS_MAX_M * PRUNE_FACTOR;
    for (const [id, hit] of cov.hits)
      if (metresBetween(centre, hit) > keep) cov.hits.delete(id);
  }

  function view() {
    const viewer = state.viewer;
    if (!viewer) return null;
    const centre = viewCentre(viewer);
    if (!Number.isFinite(centre?.lat) || !Number.isFinite(centre?.lon))
      return null;
    const heightM = cameraHeightAboveGround(viewer, {
      groundAt: context.groundCaster?.groundAt,
    });
    return { centre, heightM };
  }

  /** Server answers that say the API is not usable: show why and hold off. */
  function applyRefusal(result) {
    if (result?.configured === false) {
      state.configured = false;
      cov.error = result.error || msg('Indoor views are not configured');
      cov.holdUntil = now() + PROBE_BACKOFF_MS;
      return true;
    }
    return false;
  }

  async function probe(centre) {
    cov.probing = true;
    cov.hint = msg('Looking for indoor views here…');
    context.notify();
    const controller = new AbortController();
    cov.probeAbort = controller;
    try {
      const result = await source.probe(
        { lat: centre.lat, lon: centre.lon, radiusKm: PROBE_RADIUS_KM },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result?.usage) state.usage = result.usage;
      if (result?.busy) cov.holdUntil = now() + 5000;
      else if (!applyRefusal(result)) {
        state.configured = true;
        cov.error = null;
        if (result?.capReached) {
          cov.holdUntil = Infinity;
          cov.hint = msg('Daily Street View lookup cap reached');
        } else if (result?.stopped && result.stopped !== 'aborted') {
          cov.holdUntil = now() + PROBE_BACKOFF_MS;
          cov.error = result.error || null;
        } else if (result?.incomplete) {
          // The area stays unprobed (Places failed): try again later, not on every settle.
          cov.holdUntil = now() + PROBE_BACKOFF_MS;
        }
        cov.lastProbe = {
          at: now(),
          newHits: result?.newHits?.length || 0,
          requests: result?.requests || null,
        };
      }
      if (merge(result?.hits)) draw();
    } catch (error) {
      if (controller.signal.aborted) return;
      cov.holdUntil = now() + PROBE_BACKOFF_MS;
      cov.error = error?.message || msg('Indoor probe failed');
    } finally {
      if (cov.probeAbort === controller) cov.probeAbort = null;
      cov.probing = false;
      if (cov.hint !== msg('Daily Street View lookup cap reached'))
        cov.hint = '';
      context.notify();
    }
  }

  async function refresh() {
    if (!context.isActive() || !state.viewer) return;
    if (state.configured === null) return; // status first
    const current = view();
    if (!current) return;
    const { centre, heightM } = current;
    if (Number.isFinite(heightM) && heightM > COVERAGE_MAX_HEIGHT_M) {
      cov.hint = msg('Zoom in to see indoor views');
      removeCollection();
      cov.drawn = 0;
      requestRender();
      context.notify();
      return;
    }
    cov.fetchAbort?.abort();
    const controller = new AbortController();
    cov.fetchAbort = controller;
    cov.loading = true;
    context.notify();
    let answer;
    try {
      answer = await source.hitsNear(
        {
          lat: centre.lat,
          lon: centre.lon,
          radiusKm: fetchRadiusM(heightM) / 1000,
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      cov.error = error?.message || msg('Indoor views could not be loaded');
      answer = null;
    } finally {
      if (cov.fetchAbort === controller) {
        cov.fetchAbort = null;
        cov.loading = false;
      }
    }
    if (controller.signal.aborted || !context.isActive()) return;
    if (answer) {
      if (cov.hint === msg('Zoom in to see indoor views')) cov.hint = '';
      merge(answer.hits);
      prune(centre);
      draw();
      if (
        // Refused before (API not enabled yet): ask again after the backoff.
        (state.configured !== false || now() >= cov.holdUntil) &&
        shouldProbe({
          heightM,
          unprobedCells: answer.unprobedCells,
          probing: cov.probing,
          holdUntil: cov.holdUntil,
          now: now(),
          remainingToday: state.usage?.remainingToday,
        })
      )
        probe(centre);
    }
    context.notify();
  }

  function scheduleRefresh() {
    clearTimeout(cov.debounceTimer);
    cov.debounceTimer = setTimeout(() => {
      cov.debounceTimer = null;
      refresh();
    }, COVERAGE_DEBOUNCE_MS);
  }

  return {
    refresh,
    draw,
    merge,
    hits,
    drawnCount: () => cov.drawn || 0,

    attach(viewer) {
      state.viewer = viewer;
      cov.removeCameraListener?.();
      const camera = viewer?.camera;
      if (camera?.moveEnd?.addEventListener) {
        const removeEnd = camera.moveEnd.addEventListener(scheduleRefresh);
        cov.removeCameraListener = () => removeEnd();
      }
      refresh();
    },

    detach() {
      cov.removeCameraListener?.();
      cov.removeCameraListener = null;
      clearTimeout(cov.debounceTimer);
      cov.debounceTimer = null;
      cov.fetchAbort?.abort();
      cov.fetchAbort = null;
      cov.probeAbort?.abort();
      cov.probeAbort = null;
      cov.loading = false;
      cov.probing = false;
    },

    clear() {
      removeCollection();
      cov.drawn = 0;
      cov.hint = '';
      requestRender();
    },

    resetErrors() {
      cov.error = null;
      if (cov.holdUntil !== Infinity) cov.holdUntil = 0;
    },
  };
}
