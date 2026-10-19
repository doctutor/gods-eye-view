// Personal fork: the Localities layer's client for the local Overture
// divisions index (server/providers/overture.js, built by
// `npm run overture:build`): whether it is built, and the places of a
// view. A newer question aborts the one in flight.
import {
  OVERTURE_ENDPOINT,
  OVERTURE_KINDS,
} from '../../data/overtureDivisions.js';

/** A failed answer: `code` is 'unconfigured' (no build) or 'failed'. */
export class OvertureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OvertureError';
    this.code = code;
  }
}

const KINDS = new Set(OVERTURE_KINDS.map((k) => k.kind));
const shortText = (value, max = 200) =>
  typeof value === 'string' && value && value.length <= max ? value : '';

/** An answer's place, checked, as a Localities place (source 'overture'), or null. */
export function normalizeOverturePlace(raw) {
  const name = shortText(raw?.name);
  const [lon, lat] = Array.isArray(raw?.at) ? raw.at.map(Number) : [];
  if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const id = shortText(raw.id, 40);
  if (!/^ov:\d+$/.test(id)) return null;
  const pop = Number(raw.pop);
  const prominence = Number(raw.prominence);
  const optional = (key, test) =>
    test(raw[key]) && raw[key] !== name ? { [key]: raw[key] } : {};
  return {
    id,
    name,
    source: 'overture',
    kind: KINDS.has(raw.kind) ? raw.kind : 'locality',
    ...optional('es', (v) => Boolean(shortText(v))),
    ...optional('ru', (v) => Boolean(shortText(v))),
    ...optional('local', (v) => Boolean(shortText(v))),
    ...(Number.isSafeInteger(pop) && pop > 0 ? { pop } : {}),
    ...(prominence > 0 && prominence <= 100 ? { prominence } : {}),
    ...(/^Q\d{1,12}$/.test(raw.wikidata || '')
      ? { wikidata: raw.wikidata }
      : {}),
    ...(/^[A-Z]{2}$/.test(raw.country || '') ? { country: raw.country } : {}),
    at: [lon, lat],
  };
}

/**
 * @param {{fetchImpl?: typeof fetch, url?: string}} [options]
 */
export function createOvertureClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = OVERTURE_ENDPOINT,
} = {}) {
  let inflight = null;

  async function getJson(path, signal) {
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new OvertureError('failed', 'The Overture index did not answer');
    }
    const body = await response.json().catch(() => null);
    if (response.status === 503)
      throw new OvertureError('unconfigured', body?.error || 'Not built yet');
    if (!response.ok || !body)
      throw new OvertureError(
        'failed',
        body?.error || `Overture ${response.status}`,
      );
    return body;
  }

  return {
    /** Whether the index is built: {configured, version, release, …}. */
    async status() {
      try {
        const body = await getJson('/layers');
        return body?.configured && /^[0-9a-f]{12}$/.test(body.version || '')
          ? body
          : { configured: false, message: String(body?.message || '') };
      } catch (error) {
        return { configured: false, message: String(error?.message || '') };
      }
    },
    /**
     * The places of a box at a zoom, under the index's version.
     * @returns {Promise<{places: object[], count: number, saturated: boolean, version: string}>}
     */
    async places({ box, zoom, version }) {
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      const params = new URLSearchParams({
        west: String(box.west),
        south: String(box.south),
        east: String(box.east),
        north: String(box.north),
        zoom: String(Math.floor(zoom)),
        ...(version ? { v: version } : {}),
      });
      try {
        const body = await getJson(`/divisions?${params}`, controller.signal);
        const places = (Array.isArray(body.places) ? body.places : [])
          .map(normalizeOverturePlace)
          .filter(Boolean);
        return {
          places,
          count: places.length,
          saturated: body.saturated === true,
          version: String(body.version || ''),
        };
      } finally {
        if (inflight === controller) inflight = null;
      }
    },
    abort() {
      inflight?.abort();
      inflight = null;
    },
  };
}
