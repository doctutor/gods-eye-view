/**
 * Personal fork: the Earth Engine overlay layers' catalog, from the local
 * server's /api/earth-engine/layers (server/providers/earthEngine.js), which
 * holds the service account and proxies the tiles. One request is shared by
 * every layer, and the answer is kept a few minutes.
 */

export const EARTH_ENGINE_ENDPOINT = '/api/earth-engine';
/** The catalog is asked for again after this long. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** One server layer, checked on the way in, or null. */
export function toCatalogLayer(row) {
  const id = String(row?.id || '');
  if (!/^ee-[a-z0-9-]{1,40}$/.test(id)) return null;
  const variants = (Array.isArray(row.variants) ? row.variants : [])
    .filter((variant) => /^[a-z0-9-]{1,20}$/.test(String(variant?.key || '')))
    .map((variant) => ({
      key: variant.key,
      ready: variant.ready === true,
      ...(Number.isFinite(variant.minHeightM)
        ? { minHeightM: variant.minHeightM }
        : {}),
      ...(Number.isFinite(variant.maxHeightM)
        ? { maxHeightM: variant.maxHeightM }
        : {}),
    }));
  return {
    id,
    attribution: text(row.attribution, 300),
    maxZoom: Number.isInteger(row.maxZoom) ? Math.min(18, row.maxZoom) : 12,
    variants,
    legend: (Array.isArray(row.legend) ? row.legend : [])
      .filter((entry) => /^#[0-9a-f]{6}$/i.test(String(entry?.color || '')))
      .map((entry) => ({ label: text(entry.label, 40), color: entry.color })),
    error: row.error ? text(row.error) : null,
  };
}

/** The tile URL template for a layer variant (the server's proxy). */
export function tileTemplate(layerId, variantKey) {
  return `${EARTH_ENGINE_ENDPOINT}/tile/${layerId}/${variantKey}/{z}/{x}/{y}`;
}

/**
 * The catalog, shared and kept CATALOG_TTL_MS.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createEarthEngineSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    const response = await fetchImpl(`${EARTH_ENGINE_ENDPOINT}/layers`, {
      credentials: 'same-origin',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    const layers = new Map(
      (Array.isArray(body?.layers) ? body.layers : [])
        .map(toCatalogLayer)
        .filter(Boolean)
        .map((layer) => [layer.id, layer]),
    );
    return {
      configured: body?.configured === true,
      message: body?.message ? text(body.message) : '',
      tiles: {
        used: Number(body?.tiles?.used) || 0,
        budget: Number(body?.tiles?.budget) || 0,
      },
      layers,
      at: now(),
    };
  }

  return {
    /** @returns {Promise<object>} the catalog (a failed request throws). */
    async catalog({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < CATALOG_TTL_MS) return held;
      inflight ||= load()
        .then((catalog) => (held = catalog))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    /** The last catalog seen, if any. */
    last: () => held,
  };
}
