// Personal fork: network access for the Google indoor-views provider.
import { GSV_INDOOR_ROUTE } from './policy.js';

/** HTTP error from the local indoor routes. */
export class IndoorSourceError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = 'IndoorSourceError';
    this.status = status;
    this.payload = payload;
  }
}

async function readJson(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* status is authoritative */
  }
  // 409 (a probe already running) carries a usable body.
  if (!response.ok && response.status !== 409)
    throw new IndoorSourceError(
      payload?.error || `${label} HTTP ${response.status}`,
      { status: response.status, payload },
    );
  return payload || {};
}

/**
 * The local /api/streetview/indoor routes (the server holds the Google key and
 * the database) plus the browser key the Maps Embed viewer needs.
 */
export function createGoogleIndoorSource({
  apiKey = import.meta.env?.GOOGLE_MAPS_API_KEY || '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  route = GSV_INDOOR_ROUTE,
} = {}) {
  return {
    embedKey: () => String(apiKey || '').trim(),

    async getStatus({ signal } = {}) {
      const response = await fetchImpl(`${route}/status`, {
        signal,
        cache: 'no-store',
      });
      return readJson(response, 'Indoor status');
    },

    async hitsNear({ lat, lon, radiusKm }, { signal } = {}) {
      const search = new URLSearchParams({
        near: `${lat.toFixed(6)},${lon.toFixed(6)}`,
        radiusKm: String(Math.round(radiusKm * 1000) / 1000),
      });
      const response = await fetchImpl(`${route}?${search}`, {
        signal,
        cache: 'no-store',
      });
      return readJson(response, 'Indoor hits');
    },

    async probe({ lat, lon, radiusKm }, { signal } = {}) {
      const response = await fetchImpl(`${route}/probe`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon, radiusKm }),
      });
      return readJson(response, 'Indoor probe');
    },
  };
}
