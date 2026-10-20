// Personal fork: the client for a local Overture point index: the Places
// layer's (/api/overture/places, built by `npm run overture:build --
// --places`) by default, or another with its own endpoint (Street assets'
// infrastructure, streetAssets/infrastructureSource.js): whether it is
// built, the pins of a box and the counts of a view. A newer question of a
// kind aborts the one in flight.
import { OVERTURE_PLACES_ENDPOINT } from '../../data/overturePlaces.js';
import { normalizePlace } from './places.js';

/** A failed answer: `code` is 'unconfigured' (no build) or 'failed'. */
export class PlacesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlacesError';
    this.code = code;
  }
}

const H3_CELL = /^[0-9a-f]{15}$/;

/** The Places layer's source: the places index. */
export const createPlacesSource = (options = {}) => createPointSource(options);

/**
 * @param {{fetchImpl?: typeof fetch, endpoint?: string, statusKey?: string,
 *   categoryParam?: string, withConfidence?: boolean,
 *   normalize?: (raw: object) => object|null, words?: string}} [options]
 *   `statusKey`: the index's entry in /api/overture/layers;
 *   `categoryParam`: the query's name for the category; `withConfidence`:
 *   whether the route takes minConfidence; `normalize`: a pin checked on
 *   the way in (null drops it).
 */
export function createPointSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = OVERTURE_PLACES_ENDPOINT,
  statusKey = 'poi',
  categoryParam = 'category',
  withConfidence = true,
  normalize = normalizePlace,
  words = 'The places index',
} = {}) {
  const inflight = { pins: null, counts: null };

  async function getJson(url, kind) {
    inflight[kind]?.abort();
    const controller = new AbortController();
    inflight[kind] = controller;
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        credentials: 'same-origin',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new PlacesError('failed', `${words} did not answer`);
    } finally {
      if (inflight[kind] === controller) inflight[kind] = null;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 503)
      throw new PlacesError('unconfigured', body?.error || 'Not built');
    if (!response.ok || !body)
      throw new PlacesError(
        'failed',
        body?.error || `Places ${response.status}`,
      );
    return body;
  }

  const filters = ({ category, minConfidence, version }) =>
    new URLSearchParams({
      [categoryParam]: category,
      ...(withConfidence ? { minConfidence: String(minConfidence) } : {}),
      ...(version ? { v: version } : {}),
    });

  return {
    /** {configured, version, places, sources}: /api/overture/layers' entry. */
    async status() {
      try {
        const response = await fetchImpl('/api/overture/layers', {
          credentials: 'same-origin',
        });
        const body = await response.json().catch(() => null);
        const places = body?.[statusKey];
        return places?.configured && /^[0-9a-f]{12}$/.test(places.version || '')
          ? {
              configured: true,
              version: places.version,
              places: Number(places.places) || 0,
              sources:
                places.sources && typeof places.sources === 'object'
                  ? places.sources
                  : {},
            }
          : { configured: false };
      } catch {
        return { configured: false };
      }
    },
    /** The pins of a box: {places, count, saturated}. */
    async pins({ box, category, minConfidence, version }) {
      const params = filters({ category, minConfidence, version });
      for (const side of ['west', 'south', 'east', 'north'])
        params.set(side, String(box[side]));
      const body = await getJson(`${endpoint}?${params}`, 'pins');
      const places = (Array.isArray(body.places) ? body.places : [])
        .map(normalize)
        .filter(Boolean);
      return {
        places,
        count: places.length,
        saturated: body.saturated === true,
      };
    },
    /** The counts of a view: Map cell → count. */
    async counts({ res, bounds, category, minConfidence, version }) {
      const params = filters({ category, minConfidence, version });
      params.set('res', String(res));
      if (bounds)
        for (const side of ['west', 'south', 'east', 'north'])
          params.set(side, String(bounds[side]));
      const body = await getJson(`${endpoint}/counts?${params}`, 'counts');
      const cells = new Map();
      for (const entry of Array.isArray(body.cells) ? body.cells : []) {
        const [cell, count] = Array.isArray(entry) ? entry : [];
        if (H3_CELL.test(String(cell)) && Number.isInteger(count) && count > 0)
          cells.set(cell, count);
      }
      return cells;
    },
    abort() {
      inflight.pins?.abort();
      inflight.counts?.abort();
    },
  };
}
