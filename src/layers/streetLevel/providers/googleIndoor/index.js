// Personal fork: "Google indoor views" Street Level provider.
import { msg } from '../../../../i18n/marker.js';
import { createIndoorCoverage } from './coverage.js';
import { createGoogleIndoorViewer } from './viewer.js';
import { passesImageryFilter } from '../../filter.js';
import { metresBetween } from '../../view.js';
import {
  COLORS,
  GSV_INDOOR_CREDIT_HTML,
  GSV_INDOOR_KEY_ID,
  GSV_INDOOR_LABEL,
  GSV_INDOOR_NAME,
  GSV_INDOOR_PROVIDER_ID,
  GSV_INDOOR_SOURCE_METHODS,
  NEAREST_INDOOR_RADIUS_M,
  PICK_PREFIX,
  PROBE_BACKOFF_MS,
  isPanoId,
  panoDateMs,
} from './policy.js';

function createProviderState(context) {
  return {
    context,
    viewer: null,
    /** null until the first status; false when the server cannot probe. */
    configured: null,
    keyRequired: false,
    usage: null,
    coverage: {
      hits: new Map(),
      collection: null,
      drawn: 0,
      loading: false,
      probing: false,
      hint: '',
      error: null,
      holdUntil: 0,
      lastProbe: null,
      debounceTimer: null,
      fetchAbort: null,
      probeAbort: null,
      removeCameraListener: null,
    },
  };
}

/**
 * Places with Google Street View indoor imagery or photospheres, found by the
 * server's metadata probes and kept in its database; opened in the Maps Embed
 * viewer. Off until switched on. `source` is ./source.js or a stand-in.
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createGoogleIndoorProvider({ source }) {
  if (
    !GSV_INDOOR_SOURCE_METHODS.every(
      (method) => typeof source?.[method] === 'function',
    )
  )
    throw new TypeError('A Google indoor-views source is required');

  return Object.freeze({
    id: GSV_INDOOR_PROVIDER_ID,
    name: GSV_INDOOR_NAME,
    label: GSV_INDOOR_LABEL,
    requiresKeyId: GSV_INDOOR_KEY_ID,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: GSV_INDOOR_CREDIT_HTML }),
    defaultOn: false,

    create(context) {
      const state = createProviderState(context);
      const coverage = createIndoorCoverage({ state, source });
      const viewer = createGoogleIndoorViewer({
        source,
        lookup: (panoId) => state.coverage.hits.get(panoId) || null,
      });

      return {
        async status() {
          const first = state.configured === null;
          state.keyRequired = !source.embedKey();
          try {
            const status = await source.getStatus();
            state.configured = status?.configured === true;
            state.usage = status;
            state.coverage.error = state.configured
              ? null
              : status?.message || msg('Indoor views are not configured');
            if (!state.configured)
              state.coverage.holdUntil = Date.now() + PROBE_BACKOFF_MS;
          } catch (error) {
            state.configured = false;
            state.coverage.error =
              error?.message || msg('Indoor views status unavailable');
          }
          // Hits already in the database still draw when probing is off.
          if (first) coverage.refresh();
          context.notify();
          return { configured: state.configured && !state.keyRequired };
        },

        init(cesiumViewer) {
          state.viewer = cesiumViewer;
        },

        activate(cesiumViewer) {
          state.viewer = cesiumViewer;
          coverage.attach(cesiumViewer);
        },

        deactivate() {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
        },

        destroy() {
          coverage.detach();
          coverage.clear();
          state.coverage.hits.clear();
        },

        refreshCoverage: () => coverage.refresh(),

        setFilter() {
          coverage.draw();
        },

        coverageStats() {
          const cov = state.coverage;
          return {
            count: coverage.drawnCount(),
            zoom: null,
            kind: 'indoor',
            loading: cov.loading || cov.probing,
            hint: cov.hint,
            error: cov.error,
            keyRequired: state.keyRequired,
          };
        },

        handlePick(pickId) {
          if (!pickId.startsWith(PICK_PREFIX.pano)) return false;
          const panoId = pickId.slice(PICK_PREFIX.pano.length);
          if (!isPanoId(panoId)) return false;
          context.actions.openImage(panoId);
          return true;
        },

        /** Nearest known indoor view that passes the imagery filter, or null. */
        async nearestImage({ lat, lon }) {
          const filter = context.getFilter();
          let best = null;
          let bestD = Infinity;
          for (const hit of state.coverage.hits.values()) {
            if (
              !passesImageryFilter(
                { isPano: true, capturedAt: panoDateMs(hit.panoDate) || 0 },
                filter,
              )
            )
              continue;
            const d = metresBetween({ lat, lon }, hit);
            if (d < bestD) {
              best = hit;
              bestD = d;
            }
          }
          return best && bestD <= NEAREST_INDOOR_RADIUS_M ? best.panoId : null;
        },

        viewer,
      };
    },
  });
}
