// Personal fork: the Blocks render mode's chunk heights (docs/BLOCKS-PLAN.md).
// A chunk's columns come from GET /api/raster/values for the Elevation layer
// (src/data/rasterValues.js), one request per chunk at CHUNK_COLUMNS cells
// over the chunk's bounds, so the server's 30-day disk cache keeps them
// too. Heights are mean sea level as the DEM stack reports them; a column
// at or below 0 m is the sea, water at level 0 over a seabed below it.
//
// A region (grid.js) is used through lon0, lat0, blockM, chunkBounds and
// columnCentre; chunks are store.js's, its createChunk unless the
// controller passes one.

import { createRasterValuesClient } from '../../data/rasterValues.js';
import { DEM_SOURCES } from '../../data/demStack.js';
import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, createChunk as storeChunk } from './store.js';

/** The layer whose values are the heights. */
export const ELEVATION_LAYER = 'ee-elevation';
/** Chunks kept in memory. */
export const MAX_CHUNKS = 1024;
/** Probe sides, metres: the first resolves cells of 1–64 m, the next 64 m–4 km. */
const PROBE_SIDES_M = [CHUNK_COLUMNS, CHUNK_COLUMNS * CHUNK_COLUMNS];
const M_PER_DEG = 111_319.49;

/** The DEM stack's native cell sizes, metres (1, 2, 8, 10, 30, 231). */
export const NATIVE_CELLS_M = Object.freeze(
  [...new Set(DEM_SOURCES.map((entry) => entry.pixelM))]
    .filter((size) => size > 0)
    .sort((a, b) => a - b),
);

/**
 * The native cell a measured cell width stands for: the stack's size
 * nearest it by ratio (the server reports widthM / cols, so 64 m of 30 m
 * cells reads 32 m).
 */
export function snapBlockM(cellSizeM) {
  let best = NATIVE_CELLS_M[0];
  for (const size of NATIVE_CELLS_M)
    if (
      Math.abs(Math.log(size / cellSizeM)) <
      Math.abs(Math.log(best / cellSizeM))
    )
      best = size;
  return best;
}

/** A square window `sideM` a side centred on a point, in degrees. */
export function probeBox(lon, lat, sideM) {
  const halfLat = sideM / 2 / M_PER_DEG;
  const halfLon =
    sideM / 2 / (M_PER_DEG * Math.max(1e-6, Math.cos((lat * Math.PI) / 180)));
  return {
    west: Math.max(-180, lon - halfLon),
    south: Math.max(-90, lat - halfLat),
    east: Math.min(180, lon + halfLon),
    north: Math.min(90, lat + halfLat),
  };
}

/**
 * A chunk's heights, one per column (columnIndex: j × CHUNK_COLUMNS + i, i
 * east and j north from the chunk's south-west corner): each column's
 * centre read from the answer's cell under it. The answer's grid is
 * equal-angle over the chunk's bounds and may be a cell short of
 * CHUNK_COLUMNS when the native cell is the block, so columns are looked
 * up by place, not index.
 */
export function sampleColumns(region, ci, cj, { header, values }) {
  const { west, south, east, north, cols, rows } = header;
  const heights = new Float32Array(CHUNK_COLUMNS * CHUNK_COLUMNS);
  for (let j = 0; j < CHUNK_COLUMNS; j++) {
    for (let i = 0; i < CHUNK_COLUMNS; i++) {
      const { lon, lat } = region.columnCentre(
        ci * CHUNK_COLUMNS + i,
        cj * CHUNK_COLUMNS + j,
      );
      const col = Math.floor(((lon - west) / (east - west)) * cols);
      const row = Math.floor(((north - lat) / (north - south)) * rows);
      heights[columnIndex(i, j)] =
        col < 0 || col >= cols || row < 0 || row >= rows
          ? NaN
          : values[row * cols + col];
    }
  }
  return heights;
}

/**
 * Heights to the store's columns: level = floor(h / blockM); at or below
 * 0 m water fills level 0 over a seabed at most level -1; nodata is NONE.
 */
export function columnsFromHeights(heights, blockM) {
  const count = heights.length;
  const top = new Int32Array(count);
  const material = new Uint8Array(count);
  const water = new Int32Array(count);
  for (let k = 0; k < count; k++) {
    const h = heights[k];
    if (!Number.isFinite(h)) {
      top[k] = NONE;
      water[k] = NONE;
      material[k] = MATERIALS.AIR;
      continue;
    }
    const level = Math.floor(h / blockM);
    material[k] = MATERIALS.TERRAIN;
    if (h <= 0) {
      top[k] = Math.min(level, -1);
      water[k] = 0;
    } else {
      top[k] = level;
      water[k] = NONE;
    }
  }
  return { top, material, water };
}

/** A region's cache key: its anchor and block size. */
export const regionKey = (region) =>
  `${region.lon0},${region.lat0},${region.blockM}`;

/**
 * @param {{fetchValues?: (request: {layer: string, mode: string, box:
 *   object, cells: number}) => Promise<{header: object, values:
 *   Float32Array}>, createChunk?: Function, maxChunks?: number}} options
 *   createChunk: store.js's unless given.
 */
export function createChunkSource({
  fetchValues,
  createChunk = storeChunk,
  maxChunks = MAX_CHUNKS,
} = {}) {
  if (!fetchValues) {
    const client = createRasterValuesClient({ maxEntries: 16 });
    fetchValues = (request) => client.get(request);
  }
  const held = new Map(); // key → Promise<chunk>, least recently used first

  function remember(key, promise) {
    held.delete(key);
    held.set(key, promise);
    while (held.size > maxChunks) held.delete(held.keys().next().value);
  }

  const ask = (box) =>
    fetchValues({
      layer: ELEVATION_LAYER,
      mode: '',
      box,
      cells: CHUNK_COLUMNS,
    });

  return {
    /**
     * The block size and source name at a point: the DEM stack's native
     * cell there, read from a probe small enough that the server answers
     * at that cell. `windowM` caps the probe; the native cell is the
     * centre's, so a corner of 3DEP 1 m does not turn a 30 m view into
     * 1 m blocks.
     * @returns {Promise<{blockM: number, source: string, cellSizeM: number}>}
     */
    async regionFor(lon, lat, windowM = Infinity) {
      let header;
      for (const side of PROBE_SIDES_M) {
        ({ header } = await ask(probeBox(lon, lat, Math.min(side, windowM))));
        if (header.cols >= 2 || side >= windowM) break;
      }
      return {
        blockM: snapBlockM(header.cellSizeM),
        source: header.source,
        cellSizeM: header.cellSizeM,
      };
    },

    /** A chunk of the region; one request per key however many ask. */
    loadChunk(region, ci, cj) {
      const key = `${regionKey(region)}|${ci}:${cj}`;
      const known = held.get(key);
      if (known) {
        remember(key, known);
        return known;
      }
      const promise = (async () => {
        const answer = await ask(region.chunkBounds(ci, cj));
        const heights = sampleColumns(region, ci, cj, answer);
        return createChunk({
          ci,
          cj,
          ...columnsFromHeights(heights, region.blockM),
        });
      })();
      remember(key, promise);
      // A failure is not kept: the controller's retry asks again.
      promise.catch(() => {
        if (held.get(key) === promise) held.delete(key);
      });
      return promise;
    },

    /** Chunks held (for tests and the status line). */
    size: () => held.size,
    clear: () => held.clear(),
  };
}
