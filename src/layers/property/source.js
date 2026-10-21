// Personal fork: the Property sales layer's client for /api/property
// (server/providers/property.js): whether the index is built, a metric's
// hexagons, the buildings of a box and one building's records. A newer
// question of a kind aborts the one in flight.
import { PROPERTY_ENDPOINT } from '../../data/propertySales.js';
import { normalizeBuilding, normalizeBuildingDetail } from './property.js';

/** A failed answer: `code` is 'unconfigured', 'tooMany' (a 413) or 'failed'. */
export class PropertyError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'PropertyError';
    this.code = code;
    this.status = status;
  }
}

const H3_CELL = /^[0-9a-f]{15}$/;
const finite = (value) => (Number.isFinite(value) ? value : null);

/** A domain from the server, checked, or null. */
export function toDomain(raw) {
  const min = finite(raw?.min);
  const max = finite(raw?.max);
  return min !== null && max !== null && max > min
    ? { min, max, median: finite(raw.median) ?? min }
    : null;
}

/** /api/property/layers, checked. */
export function toStatus(body) {
  if (body?.configured !== true || !/^[0-9a-f]{12}$/.test(body.version || ''))
    return {
      configured: false,
      message: typeof body?.message === 'string' ? body.message : '',
    };
  const domains = {};
  for (const [res, byMetric] of Object.entries(body.domains || {})) {
    if (!/^[0-7]$/.test(res)) continue;
    domains[res] = Object.fromEntries(
      Object.entries(byMetric || {}).map(([metric, domain]) => [
        metric,
        toDomain(domain),
      ]),
    );
  }
  return {
    configured: true,
    version: body.version,
    builtAt: String(body.builtAt || '').slice(0, 40),
    records: Number(body.records) || 0,
    buildings: Number(body.buildings) || 0,
    priceSinceYear: Number(body.priceSinceYear) || 2015,
    domains,
  };
}

/**
 * @param {{fetchImpl?: typeof fetch, endpoint?: string}} [options]
 */
export function createPropertySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = PROPERTY_ENDPOINT,
} = {}) {
  const inflight = { hexes: null, buildings: null, building: null };

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
      throw new PropertyError('failed', 'The property index did not answer');
    } finally {
      if (inflight[kind] === controller) inflight[kind] = null;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 503)
      throw new PropertyError('unconfigured', body?.error || 'Not built', 503);
    if (response.status === 413)
      throw new PropertyError('tooMany', body?.error || 'Too many', 413);
    if (!response.ok || !body)
      throw new PropertyError(
        'failed',
        body?.error || `Property ${response.status}`,
        response.status,
      );
    return body;
  }

  const boxParams = (box, version) => {
    const params = new URLSearchParams();
    for (const side of ['west', 'south', 'east', 'north'])
      params.set(side, String(Math.round(box[side] * 1e5) / 1e5));
    if (version) params.set('v', version);
    return params;
  };

  return {
    /** The index's status (never throws: unreachable is unconfigured). */
    async status() {
      try {
        const response = await fetchImpl(`${endpoint}/layers`, {
          credentials: 'same-origin',
        });
        return toStatus(await response.json().catch(() => null));
      } catch {
        return { configured: false, message: '' };
      }
    },
    /** A metric's hexagons in a box: {res, domain, cells: Map index → value}. */
    async hexes({ res, metric, box, version }) {
      const body = await getJson(
        `${endpoint}/h3/${res}/${metric}?${boxParams(box, version)}`,
        'hexes',
      );
      const cells = new Map();
      for (const entry of Array.isArray(body.cells) ? body.cells : []) {
        const [cell, value] = Array.isArray(entry) ? entry : [];
        if (H3_CELL.test(String(cell)) && Number.isFinite(value))
          cells.set(cell, value);
      }
      return { res, metric, domain: toDomain(body.domain), cells };
    },
    /** The buildings of a box: {buildings, count, saturated}. */
    async buildings({ box, version }) {
      const body = await getJson(
        `${endpoint}/buildings?${boxParams(box, version)}`,
        'buildings',
      );
      const buildings = (Array.isArray(body.buildings) ? body.buildings : [])
        .map(normalizeBuilding)
        .filter(Boolean);
      return {
        buildings,
        count: buildings.length,
        saturated: body.saturated === true,
      };
    },
    /** One building's records, or null. */
    async building({ id, version }) {
      const params = new URLSearchParams({ id });
      if (version) params.set('v', version);
      const body = await getJson(`${endpoint}/building?${params}`, 'building');
      return normalizeBuildingDetail(body);
    },
    abort() {
      for (const controller of Object.values(inflight)) controller?.abort();
    },
  };
}
