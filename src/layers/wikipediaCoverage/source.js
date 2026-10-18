/**
 * Personal fork: the Wikipedia coverage layer's catalog and tile bytes, from
 * the local server's /api/wikipedia-coverage (server/providers/
 * wikipediaCoverage.js), which reads a grid built by
 * `npm run wikipedia:build`. The catalog is kept a few minutes.
 */

export const WIKIPEDIA_COVERAGE_ENDPOINT = '/api/wikipedia-coverage';
/** The catalog is asked for again after this long. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;
export const VARIANT_KEYS = Object.freeze(['articles', 'text', 'count']);
export const TILE_MAGIC = 'WCT1';

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const finite = (value) => (Number.isFinite(value) ? value : null);

/** One server variant, checked on the way in, or null. */
export function toCatalogVariant(row) {
  const key = String(row?.key || '');
  if (!VARIANT_KEYS.includes(key)) return null;
  const min = finite(row?.domain?.min);
  const max = finite(row?.domain?.max);
  const available =
    row?.available === true &&
    min !== null &&
    max !== null &&
    max > min &&
    min > 0;
  return {
    key,
    available,
    ...(available
      ? { domain: { min, max, median: finite(row.domain.median) ?? min } }
      : {}),
  };
}

/** The server's catalog, checked on the way in. */
export function toCatalog(body) {
  const variants = new Map(
    (Array.isArray(body?.variants) ? body.variants : [])
      .map(toCatalogVariant)
      .filter(Boolean)
      .map((variant) => [variant.key, variant]),
  );
  // Every variant is listed, even when the server left one out.
  for (const key of VARIANT_KEYS)
    if (!variants.has(key)) variants.set(key, { key, available: false });
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message) : '',
    builtAt: body?.builtAt ? text(body.builtAt, 40) : '',
    dumpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body?.dump?.date || ''))
      ? body.dump.date
      : '',
    articles:
      Number.isInteger(body?.rows?.kept) && body.rows.kept >= 0
        ? body.rows.kept
        : 0,
    text: body?.text === true,
    maxZoom: Number.isInteger(body?.maxZoom)
      ? Math.min(14, Math.max(0, body.maxZoom))
      : 9,
    attribution: text(body?.attribution, 200),
    variants,
  };
}

/** The tile URL for a variant and tile. */
export function tileUrl(variant, z, x, y) {
  return `${WIKIPEDIA_COVERAGE_ENDPOINT}/tile/${variant}/${z}/${x}/${y}`;
}

/**
 * A tile's bytes as its values: 'WCT1', width, height, dtype (uint32 LE
 * each), then Float32 values, row 0 at the north edge.
 * @param {ArrayBuffer} buffer
 * @returns {{width: number, height: number, values: Float32Array}}
 */
export function decodeTile(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16)
    throw new Error('Not a coverage tile');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== TILE_MAGIC) throw new Error('Not a coverage tile');
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const dtype = view.getUint32(12, true);
  if (dtype !== 1 || width > 4096 || height > 4096)
    throw new Error('Unknown coverage tile format');
  if (buffer.byteLength !== 16 + width * height * 4)
    throw new Error('Coverage tile truncated');
  // A copy: the values must start at a 4-byte boundary, which offset 16 is,
  // but a fresh array also frees the response buffer.
  const values = new Float32Array(width * height);
  values.set(new Float32Array(buffer, 16, width * height));
  return { width, height, values };
}

/**
 * The catalog, shared and kept CATALOG_TTL_MS.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createWikipediaCoverageSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    const response = await fetchImpl(`${WIKIPEDIA_COVERAGE_ENDPOINT}/layers`, {
      credentials: 'same-origin',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return { ...toCatalog(body), at: now() };
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
