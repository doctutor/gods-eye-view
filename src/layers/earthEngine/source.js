/**
 * Personal fork: the Earth Engine overlay layers' catalog, from the local
 * server's /api/earth-engine/layers (server/providers/earthEngine.js), which
 * holds the service account and proxies the tiles. One request is shared by
 * every layer, and the answer is kept a few minutes.
 */

export const EARTH_ENGINE_ENDPOINT = '/api/earth-engine';
/**
 * The pseudo-variant a layer whose bands name their zooms (the Rivers) is
 * drawn through: the server draws each tile with the band of its zoom.
 */
export const ZOOM_VARIANT = 'zoom';
/** The catalog is asked for again after this long. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** {versions: {ink: hash}} for the well-formed entries, or nothing. */
function versionsOf(versions) {
  const kept = Object.entries(versions || {}).filter(
    ([ink, hash]) =>
      /^[a-z]{1,10}$/.test(ink) && /^[0-9a-f]{12}$/.test(String(hash)),
  );
  return kept.length ? { versions: Object.fromEntries(kept) } : {};
}

/** {modeVersions: {mode: {ink: hash}}} for the well-formed entries, or nothing. */
function modeVersionsOf(modeVersions) {
  const kept = Object.entries(modeVersions || {})
    .filter(([mode]) => /^[a-z-]{1,20}$/.test(mode))
    .map(([mode, versions]) => [mode, versionsOf(versions).versions])
    .filter(([, versions]) => versions);
  return kept.length ? { modeVersions: Object.fromEntries(kept) } : {};
}

/** One server layer, checked on the way in, or null. */
export function toCatalogLayer(row) {
  const id = String(row?.id || '');
  if (!/^ee-[a-z0-9-]{1,40}$/.test(id)) return null;
  const variants = (Array.isArray(row.variants) ? row.variants : [])
    .filter((variant) => /^[a-z0-9-]{1,20}$/.test(String(variant?.key || '')))
    .map((variant) => ({
      key: variant.key,
      ready: variant.ready === true,
      ...(variant.auto === true ? { auto: true } : {}),
      ...(Number.isFinite(variant.minHeightM)
        ? { minHeightM: variant.minHeightM }
        : {}),
      ...(Number.isFinite(variant.maxHeightM)
        ? { maxHeightM: variant.maxHeightM }
        : {}),
      ...(Number.isInteger(variant.minZoom) &&
      variant.minZoom >= 0 &&
      variant.minZoom <= 18
        ? { minZoom: variant.minZoom }
        : {}),
      // Per ink (and mode), the hash of what the map is made from (the server's).
      ...versionsOf(variant.versions),
      ...modeVersionsOf(variant.modeVersions),
    }));
  const inks = (Array.isArray(row.inks) ? row.inks : []).filter((ink) =>
    /^[a-z]{1,10}$/.test(String(ink)),
  );
  const modes = (Array.isArray(row.modes) ? row.modes : []).filter((mode) =>
    /^[a-z-]{1,20}$/.test(String(mode)),
  );
  return {
    id,
    attribution: text(row.attribution, 300),
    maxZoom: Number.isInteger(row.maxZoom) ? Math.min(18, row.maxZoom) : 12,
    variants,
    // The inks the server has maps for: 'light' and 'dark' for a features
    // layer, 'default' otherwise.
    inks: inks.length ? inks : ['default'],
    // The modes it has maps for (the Rivers' colourings), when it has any.
    ...(modes.length ? { modes } : {}),
    legend: (Array.isArray(row.legend) ? row.legend : [])
      .filter((entry) => /^#[0-9a-f]{6}$/i.test(String(entry?.color || '')))
      .map((entry) => ({ label: text(entry.label, 40), color: entry.color })),
    error: row.error ? text(row.error) : null,
    // Earth Engine tiles this layer took today (the server counts them).
    ...(Number.isInteger(row.tilesToday) && row.tilesToday >= 0
      ? { tilesToday: row.tilesToday }
      : {}),
  };
}

/**
 * The tile URL template for a layer variant in an ink (and mode: the
 * server's proxy). `version`, the hash of the map's request, only busts the
 * browser's cache: the server reads the path.
 */
export function tileTemplate(
  layerId,
  variantKey,
  ink = 'default',
  version,
  mode = 'default',
) {
  const query = /^[0-9a-f]{12}$/.test(String(version || ''))
    ? `?v=${version}`
    : '';
  const moded = mode && mode !== 'default' ? `${mode}/` : '';
  return `${EARTH_ENGINE_ENDPOINT}/tile/${layerId}/${moded}${variantKey}/${ink}/{z}/{x}/{y}${query}`;
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
