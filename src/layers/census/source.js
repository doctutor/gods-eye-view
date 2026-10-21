/**
 * Personal fork: the Census tracts layer's locally drawn modes (HOUSEHOLD
 * INCOME), from the local server's /api/census (server/providers/census.js,
 * built by `npm run census:build`). The layer asks `censusImageryOptions`
 * for a mode and, when it is built, draws it with Cesium's
 * UrlTemplateImageryProvider; otherwise the row says what to do. Nothing
 * here imports Cesium.
 */

import { colourScales } from '../../maps/colourScale.js';
import {
  censusScaleBounds,
  censusScaleDefaults,
  censusScaleKey,
  censusScaleToken,
} from '../../data/censusScale.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';
import {
  CENSUS_ENDPOINT,
  CENSUS_LOCAL_MODES,
} from '../../data/censusTracts.js';

/** The status is asked for again after this long. */
export const STATUS_TTL_MS = 5 * 60 * 1000;

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The server's /layers answer, checked on the way in. */
export function toCensusStatus(body) {
  const modes = {};
  for (const mode of CENSUS_LOCAL_MODES) {
    const entry = body?.modes?.[mode];
    const version = /^[0-9a-f]{12}$/.test(String(entry?.version || ''))
      ? entry.version
      : '';
    modes[mode] = {
      ready: entry?.ready === true && Boolean(version),
      version,
      message: text(entry?.message || body?.message || ''),
    };
  }
  return {
    configured: body?.configured === true,
    message: text(body?.message || ''),
    attribution: text(body?.attribution, 300),
    minZoom: Number.isInteger(body?.minZoom) ? body.minZoom : 7,
    maxZoom: Number.isInteger(body?.maxZoom) ? Math.min(18, body.maxZoom) : 14,
    acsYear: Number.isInteger(body?.acsYear) ? body.acsYear : null,
    modes,
  };
}

/** Why a local mode cannot be drawn, or '' when it can. */
export function censusModeMessage(status, mode) {
  if (!status) return '';
  const entry = status.modes?.[mode];
  return entry?.ready ? '' : entry?.message || status.message || '';
}

/**
 * Options for `new Cesium.UrlTemplateImageryProvider(...)` for a mode, or
 * null when it is not built. `version` only busts the browser's cache.
 */
export function censusImageryOptions(status, mode, scales = colourScales()) {
  const entry = status?.modes?.[mode];
  if (!entry?.ready) return null;
  // A changed colour scale rides on the URL (the server draws in it), so
  // the layer remounts when it changes; the default is the classed tiles.
  const defaults = censusScaleDefaults(mode);
  const token = defaults
    ? censusScaleToken(scales.get(censusScaleKey(mode), defaults), mode)
    : '';
  return {
    url: `${CENSUS_ENDPOINT}/tile/${mode}/{z}/{x}/{y}?v=${entry.version}${token ? `&s=${token}` : ''}`,
    minimumLevel: status.minZoom,
    maximumLevel: status.maxZoom,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: status.attribution,
  };
}

/**
 * The row's Scale controls for a locally drawn mode (income, surface
 * temperature), or null for another mode: the window over the classes'
 * range, the slider over the tracts' values. The Census tracts row (the
 * Earth Engine layer's) returns it as `scale`, and its legend from
 * scaleRowLegend when the scale is not the default.
 */
export function censusScaleControl(mode, scales = colourScales()) {
  const defaults = censusScaleDefaults(mode);
  if (!defaults) return null;
  return scaleRowControl({
    store: scales,
    key: censusScaleKey(mode),
    defaults,
    auto: defaults.range,
    range: censusScaleBounds(mode),
  });
}

/**
 * The status, shared and kept STATUS_TTL_MS; a failed request reads as not
 * built.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createCensusSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;
  async function load() {
    try {
      const response = await fetchImpl(`${CENSUS_ENDPOINT}/layers`, {
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        return {
          ...toCensusStatus({}),
          message: text(body?.error || `HTTP ${response.status}`),
          at: now(),
        };
      return { ...toCensusStatus(body), at: now() };
    } catch (error) {
      return {
        ...toCensusStatus({}),
        message: text(error?.message || error),
        at: now(),
      };
    }
  }
  return {
    async status({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < STATUS_TTL_MS) return held;
      inflight ||= load()
        .then((status) => (held = status))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    last: () => held,
  };
}
