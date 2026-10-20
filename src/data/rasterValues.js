// Personal fork: a thin client for the local server's raster values
// (`GET /api/raster/values`, server side: worker2's values service): a
// window of a raster layer as a grid of numbers, the Lego rendering mode's
// input (src/layers/lego/). Fetch, decode and a small LRU; nothing else.
//
// The answer is application/octet-stream: a uint32 LE header length, a JSON
// header {schema: 'raster-values/1', layer, mode, cols, rows, west, south,
// east, north, cellSizeM, units, nodata (NaN), min, max, legendMin,
// legendMax, source, version, aggregation}, then cols × rows float32 LE,
// row-major, the north row first and the west column first.

export const RASTER_VALUES_ENDPOINT = '/api/raster/values';
export const RASTER_VALUES_SCHEMA = 'raster-values/1';
/** The most cells a side the service is asked for. */
export const RASTER_VALUES_MAX_CELLS = 512;
/** Grids kept in memory. */
export const RASTER_VALUES_LRU = 12;

/** A failed values request; `status` is the HTTP status (404: not served). */
export class RasterValuesError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RasterValuesError';
    this.status = status;
  }
}

/** The request URL for a layer, mode, box and cells across the longer side. */
export function rasterValuesUrl({ layer, mode = '', box, cells }) {
  const params = new URLSearchParams({
    layer: String(layer),
    mode: String(mode || ''),
    west: String(box.west),
    south: String(box.south),
    east: String(box.east),
    north: String(box.north),
    cells: String(
      Math.max(1, Math.min(RASTER_VALUES_MAX_CELLS, Math.round(cells))),
    ),
  });
  return `${RASTER_VALUES_ENDPOINT}?${params}`;
}

/**
 * Decode an answer's bytes into {header, values}; throws on a bad header or
 * a body of the wrong length.
 * @param {ArrayBuffer} buffer
 */
export function decodeRasterValues(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4)
    throw new RasterValuesError('Raster values answer too short');
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  if (headerLength <= 0 || 4 + headerLength > buffer.byteLength)
    throw new RasterValuesError('Raster values header length out of range');
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  );
  if (header?.schema !== RASTER_VALUES_SCHEMA)
    throw new RasterValuesError(
      `Unknown raster values schema ${header?.schema}`,
    );
  const cols = Number(header.cols);
  const rows = Number(header.rows);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1
  )
    throw new RasterValuesError('Raster values grid size missing');
  const count = cols * rows;
  const start = 4 + headerLength;
  if (buffer.byteLength - start < count * 4)
    throw new RasterValuesError('Raster values body too short');
  // Copy out so the values are 4-byte aligned whatever the header length.
  const values = new Float32Array(count);
  const body = new DataView(buffer, start, count * 4);
  for (let i = 0; i < count; i++) values[i] = body.getFloat32(i * 4, true);
  return { header, values };
}

/** Encode a grid as the service does (tests, and the harness's stub). */
export function encodeRasterValues(header, values) {
  const json = new TextEncoder().encode(
    JSON.stringify({ schema: RASTER_VALUES_SCHEMA, ...header }),
  );
  const buffer = new ArrayBuffer(4 + json.length + values.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, json.length, true);
  new Uint8Array(buffer, 4, json.length).set(json);
  for (let i = 0; i < values.length; i++)
    view.setFloat32(4 + json.length + i * 4, values[i], true);
  return buffer;
}

/**
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [options]
 */
export function createRasterValuesClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  limit = RASTER_VALUES_LRU,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  function remember(url, grid) {
    cache.delete(url);
    cache.set(url, grid);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }

  return {
    /**
     * A layer's values for a window (cached by URL).
     * @param {{layer: string, mode?: string, box: object, cells: number,
     *   signal?: AbortSignal}} request
     * @returns {Promise<{header: object, values: Float32Array}>}
     */
    async fetch({ signal, ...request }) {
      const url = rasterValuesUrl(request);
      const hit = cache.get(url);
      if (hit) {
        remember(url, hit);
        return hit;
      }
      if (inflight.has(url)) return inflight.get(url);
      const run = (async () => {
        const response = await fetchImpl(url, { signal });
        if (!response.ok)
          throw new RasterValuesError(
            `Raster values ${response.status}`,
            response.status,
          );
        const grid = decodeRasterValues(await response.arrayBuffer());
        remember(url, grid);
        return grid;
      })();
      inflight.set(url, run);
      try {
        return await run;
      } finally {
        inflight.delete(url);
      }
    },
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}
