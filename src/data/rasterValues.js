// Personal fork: raster values, numbers instead of coloured tiles, for a
// layer over a view window (GET /api/raster/values, served by
// server/providers/rasterValues.js). The encoding, the window's grid and the
// client's fetch, shared by the server and the client. Not part of upstream
// God's Eye View.

export const RASTER_VALUES_ROUTE = '/api/raster/values';
export const RASTER_VALUES_SCHEMA = 'raster-values/1';
/** The most cells a side a request may ask for (cells² ≤ 262,144). */
export const MAX_CELLS = 512;
/** Aliases the Lego renderer (src/layers/lego/) imports. */
export const RASTER_VALUES_ENDPOINT = RASTER_VALUES_ROUTE;
export const RASTER_VALUES_MAX_CELLS = MAX_CELLS;

/** A failed values request or body; `status` is the HTTP status (0: a bad body). */
export class RasterValuesError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RasterValuesError';
    this.status = status;
  }
}
/** Ground metres per degree of latitude (and of longitude at the equator). */
export const M_PER_DEG = 111_319.49;

/**
 * The body: a 4-byte little-endian uint32 header length, the UTF-8 JSON
 * header, then the values as little-endian Float32, row-major, the north
 * row first and the west column first. Nodata is NaN.
 * @param {object} header
 * @param {Float32Array} values cols × rows
 * @returns {Uint8Array}
 */
export function encodeRasterValues(header, values) {
  // JSON has no NaN: the header says "NaN" for nodata, min and max of an
  // empty grid are null.
  const json = new TextEncoder().encode(
    JSON.stringify({ schema: RASTER_VALUES_SCHEMA, ...header, nodata: 'NaN' }),
  );
  // The values start on a 4-byte boundary, so a Float32Array can view them.
  const pad = (4 - ((4 + json.length) % 4)) % 4;
  const headerLength = json.length + pad;
  const out = new Uint8Array(4 + headerLength + values.length * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, headerLength, true);
  out.set(json, 4);
  out.fill(0x20, 4 + json.length, 4 + headerLength); // spaces: still JSON
  let at = 4 + headerLength;
  for (let i = 0; i < values.length; i++, at += 4)
    view.setFloat32(at, values[i], true);
  return out;
}

/**
 * Decode a body: {header, values}, the header's nodata as NaN.
 * @param {ArrayBuffer|Uint8Array} body
 */
export function decodeRasterValues(body) {
  const bytes =
    body instanceof Uint8Array
      ? body
      : new Uint8Array(body, 0, body.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 4)
    throw new RasterValuesError('Raster values: no header');
  const headerLength = view.getUint32(0, true);
  if (4 + headerLength > bytes.byteLength)
    throw new RasterValuesError('Raster values: header past the end');
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)),
  );
  if (header.schema !== RASTER_VALUES_SCHEMA)
    throw new RasterValuesError(`Raster values: schema ${header.schema}`);
  header.nodata = NaN;
  const count = header.cols * header.rows;
  const start = 4 + headerLength;
  if (start + count * 4 > bytes.byteLength)
    throw new RasterValuesError('Raster values: fewer values than cols × rows');
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++)
    values[i] = view.getFloat32(start + i * 4, true);
  return { header, values };
}

const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** The ground, km², of an equal-angle cell between two latitudes and `widthDeg` wide. */
export function cellAreaKm2(south, north, widthDeg) {
  return (
    EARTH_RADIUS_KM *
    EARTH_RADIUS_KM *
    widthDeg *
    RAD *
    (Math.sin(north * RAD) - Math.sin(south * RAD))
  );
}

/** The finite min and max of values (null for an empty grid). */
export function valueRange(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value !== value) continue; // NaN
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : { min: null, max: null };
}

/**
 * The grid over a window: `cells` on its longer side (in ground metres at
 * its centre) and as many on the other as keep the cells about square, or
 * fewer when that would be finer than `nativeM` (the source's own cell).
 * @returns {{cols: number, rows: number, cellSizeM: number}} cellSizeM: a
 *   cell's width at the window's centre.
 */
export function windowGrid({ west, south, east, north }, cells, nativeM = 0) {
  const lat = (south + north) / 2;
  const widthM = (east - west) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const heightM = (north - south) * M_PER_DEG;
  const cell = Math.max(Math.max(widthM, heightM) / cells, nativeM || 0);
  const side = (metres) =>
    Math.max(1, Math.min(cells, Math.floor(metres / cell + 1e-6)));
  const cols = side(widthM);
  const rows = side(heightM);
  return { cols, rows, cellSizeM: widthM / cols };
}

/**
 * Check a request's parameters (URLSearchParams or a plain object).
 * @returns {{ok: true, layer: string, mode: string, box: {west, south,
 *   east, north}, cells: number} | {ok: false, status: number, error: string}}
 */
export function parseRasterValuesQuery(params) {
  const get = (key) =>
    typeof params.get === 'function' ? params.get(key) : params[key];
  const bad = (error, status = 400) => ({ ok: false, status, error });
  const layer = String(get('layer') ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(layer)) return bad('Bad layer');
  const mode = String(get('mode') ?? '');
  if (mode && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(mode)) return bad('Bad mode');
  const box = {};
  for (const key of ['west', 'south', 'east', 'north']) {
    const raw = get(key);
    const value = raw === null || raw === undefined || raw === '' ? NaN : +raw;
    if (!Number.isFinite(value)) return bad(`Bad ${key}`);
    box[key] = value;
  }
  if (box.west < -180 || box.east > 180 || !(box.west < box.east))
    return bad('The box needs -180 ≤ west < east ≤ 180');
  if (box.south < -90 || box.north > 90 || !(box.south < box.north))
    return bad('The box needs -90 ≤ south < north ≤ 90');
  const rawCells = get('cells');
  const cells =
    rawCells === null || rawCells === undefined || rawCells === ''
      ? NaN
      : +rawCells;
  if (!Number.isInteger(cells) || cells < 1)
    return bad('cells must be a whole number from 1 to 512');
  if (cells * cells > MAX_CELLS * MAX_CELLS)
    return bad(`At most ${MAX_CELLS} cells a side`, 413);
  return { ok: true, layer, mode, box, cells };
}

/** The key a window is cached under, on the server's disk and the client's LRU. */
export function rasterValuesKey({ layer, mode = '', box, cells }) {
  const { west, south, east, north } = box;
  return `${layer}|${mode}|${[west, south, east, north].join(',')}|${cells}`;
}

/** The request's URL. */
export function rasterValuesUrl({ layer, mode = '', box, cells }, base = '') {
  const query = new URLSearchParams({
    layer,
    mode,
    west: String(box.west),
    south: String(box.south),
    east: String(box.east),
    north: String(box.north),
    cells: String(Math.min(MAX_CELLS, cells)),
  });
  return `${base}${RASTER_VALUES_ROUTE}?${query}`;
}

/**
 * The client's fetch: {header, values} for a layer over a window, kept in an
 * in-memory LRU keyed like the server's cache; one request per key however
 * many ask at once. A failure rejects with an Error carrying `status`.
 * @param {{fetchImpl?: typeof fetch, maxEntries?: number, base?: string}} [options]
 */
export function createRasterValuesClient({
  fetchImpl = (...args) => fetch(...args),
  maxEntries = 64,
  limit = maxEntries,
  base = '',
} = {}) {
  maxEntries = limit;
  const held = new Map(); // key → Promise<{header, values}> (LRU by insertion)

  function remember(key, promise) {
    held.delete(key);
    held.set(key, promise);
    while (held.size > maxEntries) held.delete(held.keys().next().value);
  }

  return {
    /** @param {{layer: string, mode?: string, box: object, cells: number}} request */
    get({ signal, ...request }) {
      const key = rasterValuesKey(request);
      const known = held.get(key);
      if (known) {
        remember(key, known);
        return known;
      }
      const promise = (async () => {
        const response = await fetchImpl(rasterValuesUrl(request, base), {
          signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new RasterValuesError(
            body?.error || `Raster values: HTTP ${response.status}`,
            response.status,
          );
        }
        return decodeRasterValues(await response.arrayBuffer());
      })();
      remember(key, promise);
      // A failure is not kept: the next ask tries again.
      promise.catch(() => {
        if (held.get(key) === promise) held.delete(key);
      });
      return promise;
    },
    /** The Lego renderer's name for get(). */
    fetch(request) {
      return this.get(request);
    },
    /** Entries held (for tests). */
    size: () => held.size,
    clear: () => held.clear(),
  };
}
