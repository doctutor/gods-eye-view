// Personal fork: the Blocks render mode's chunk heights (docs/BLOCKS-PLAN.md).
// A chunk's columns come from GET /api/raster/values for the Elevation layer
// (src/data/rasterValues.js), fetched a group at a time: one request of
// 256 cells a side over a CHUNK_GROUP × CHUNK_GROUP block of chunks aligned
// to a 4-chunk grid answers all 16, and one coarse chunk of the same
// ground at 4 × blockM for the ring beyond the fine render distance. So a
// 1 m view asks about 20 times, not 270 (each Earth Engine answer counts a
// tile against the day's budget); the server's 30-day disk cache keeps the
// answers too. The coarse ring beyond the fine chunks is fetched by
// supergroup: one request of 256 cells over SUPERGROUP × SUPERGROUP groups
// (1,024 blocks a side, so 4 × blockM cells) answers 16 coarse chunks, and
// a fine group's own coarse chunk, the mean of its fine columns, replaces
// its supergroup one whenever the fine group is loaded. Heights are mean sea level as the DEM stack reports them; a column
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
/** Chunks kept in memory, fine and coarse. */
export const MAX_CHUNKS = 1024;
/** Chunks a group side: one request answers CHUNK_GROUP² chunks and a coarse one. */
export const CHUNK_GROUP = 4;
/** Cells a group request asks for a side (under the server's 512). */
export const GROUP_COLUMNS = CHUNK_COLUMNS * CHUNK_GROUP;
/** Groups a supergroup side: one request answers SUPERGROUP² coarse chunks. */
export const SUPERGROUP = 4;
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
 * The heights of a size × size block of columns from column (i0, j0) of
 * the region, index j × size + i (i east, j north): each column's centre
 * read from the answer's cell under it. The answer's grid is equal-angle
 * over its box and may be a cell short of the asked count when the native
 * cell is the block, so columns are looked up by place, not index.
 */
export const sampleBlock = (region, i0, j0, size, answer) =>
  samplePlaces(answer, size, (i, j) => region.columnCentre(i0 + i, j0 + j));

/**
 * A size × size grid of heights, index j × size + i, each read from the
 * answer's cell under placeOf(i, j) → {lon, lat}; NaN outside it.
 */
export function samplePlaces({ header, values }, size, placeOf) {
  const { west, south, east, north, cols, rows } = header;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const { lon, lat } = placeOf(i, j);
      const col = Math.floor(((lon - west) / (east - west)) * cols);
      const row = Math.floor(((north - lat) / (north - south)) * rows);
      heights[j * size + i] =
        col < 0 || col >= cols || row < 0 || row >= rows
          ? NaN
          : values[row * cols + col];
    }
  }
  return heights;
}

/** A chunk's heights (columnIndex order) from an answer covering it. */
export const sampleColumns = (region, ci, cj, answer) =>
  sampleBlock(
    region,
    ci * CHUNK_COLUMNS,
    cj * CHUNK_COLUMNS,
    CHUNK_COLUMNS,
    answer,
  );

/** The group a chunk is in. */
export const groupOf = (ci, cj) => ({
  gi: Math.floor(ci / CHUNK_GROUP),
  gj: Math.floor(cj / CHUNK_GROUP),
});

/** The supergroup a group is in. */
export const supergroupOf = (gi, gj) => ({
  si: Math.floor(gi / SUPERGROUP),
  sj: Math.floor(gj / SUPERGROUP),
});

/** A group's extent in degrees: the box around its corner chunks' boxes. */
export const groupBounds = (region, gi, gj) =>
  chunksBounds(region, gi * CHUNK_GROUP, gj * CHUNK_GROUP, CHUNK_GROUP);

/** A supergroup's extent in degrees: the box around its corner chunks' boxes. */
export const supergroupBounds = (region, si, sj) => {
  const side = CHUNK_GROUP * SUPERGROUP;
  return chunksBounds(region, si * side, sj * side, side);
};

/** The box around the corner chunks of n × n chunks from (c0, r0). */
function chunksBounds(region, c0, r0, n) {
  const c1 = c0 + n - 1;
  const r1 = r0 + n - 1;
  const boxes = [
    [c0, r0],
    [c1, r0],
    [c0, r1],
    [c1, r1],
  ].map(([ci, cj]) => region.chunkBounds(ci, cj));
  return {
    west: Math.min(...boxes.map((box) => box.west)),
    south: Math.min(...boxes.map((box) => box.south)),
    east: Math.max(...boxes.map((box) => box.east)),
    north: Math.max(...boxes.map((box) => box.north)),
  };
}

/**
 * Chunk (a, b) of GROUP_COLUMNS² heights (a group's fine columns, or a
 * supergroup's coarse ones), in columnIndex order.
 */
function chunkOfGroup(heights, a, b) {
  const out = new Float32Array(CHUNK_COLUMNS * CHUNK_COLUMNS);
  for (let j = 0; j < CHUNK_COLUMNS; j++) {
    const from = (b * CHUNK_COLUMNS + j) * GROUP_COLUMNS + a * CHUNK_COLUMNS;
    out.set(heights.subarray(from, from + CHUNK_COLUMNS), columnIndex(0, j));
  }
  return out;
}

/**
 * Coarse heights: the mean of each factor × factor block of a size × size
 * field, of its finite heights only; NaN where it has none.
 */
export function coarseHeights(heights, size, factor) {
  const side = size / factor;
  const out = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < factor; y++)
        for (let x = 0; x < factor; x++) {
          const h = heights[(j * factor + y) * size + i * factor + x];
          if (Number.isFinite(h)) {
            sum += h;
            count++;
          }
        }
      out[j * side + i] = count ? sum / count : NaN;
    }
  }
  return out;
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
  const groups = new Map(); // key → Promise<group>, while in flight
  const supergroups = new Map(); // key → Promise<Map<key, chunk>>, while in flight

  function remember(key, promise) {
    held.delete(key);
    held.set(key, promise);
    while (held.size > maxChunks) held.delete(held.keys().next().value);
  }

  const ask = (box, cells) =>
    fetchValues({ layer: ELEVATION_LAYER, mode: '', box, cells });

  const groupKey = (region, gi, gj) => `${regionKey(region)}|g${gi}:${gj}`;
  const coarseKey = (region, gi, gj) => `${regionKey(region)}|c${gi}:${gj}`;

  /**
   * A group's 16 chunks and its coarse chunk from one request. Once built
   * they all go into the cache, so the neighbours come free; the coarse
   * chunk, the mean of the fine columns, replaces a supergroup's.
   * @returns {Promise<{chunks: Map<string, object>, coarse: object,
   *   coarseKey: string}>}
   */
  function loadGroup(region, gi, gj) {
    const prefix = regionKey(region);
    const key = groupKey(region, gi, gj);
    const inFlight = groups.get(key);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const answer = await ask(groupBounds(region, gi, gj), GROUP_COLUMNS);
      const heights = sampleBlock(
        region,
        gi * GROUP_COLUMNS,
        gj * GROUP_COLUMNS,
        GROUP_COLUMNS,
        answer,
      );
      const chunks = new Map();
      for (let b = 0; b < CHUNK_GROUP; b++)
        for (let a = 0; a < CHUNK_GROUP; a++) {
          const ci = gi * CHUNK_GROUP + a;
          const cj = gj * CHUNK_GROUP + b;
          const columns = columnsFromHeights(
            chunkOfGroup(heights, a, b),
            region.blockM,
          );
          chunks.set(
            `${prefix}|${ci}:${cj}`,
            createChunk({ ci, cj, ...columns }),
          );
        }
      const coarse = createChunk({
        ci: gi,
        cj: gj,
        ...columnsFromHeights(
          coarseHeights(heights, GROUP_COLUMNS, CHUNK_GROUP),
          region.blockM * CHUNK_GROUP,
        ),
      });
      return { chunks, coarse, coarseKey: coarseKey(region, gi, gj) };
    })();
    groups.set(key, promise);
    promise
      .then(
        ({ chunks, coarse, coarseKey: exactKey }) => {
          for (const [chunkKey, chunk] of chunks)
            if (!held.has(chunkKey)) remember(chunkKey, Promise.resolve(chunk));
          remember(exactKey, Promise.resolve(coarse));
        },
        () => {},
      )
      .then(() => groups.delete(key));
    return promise;
  }

  /**
   * A supergroup's 16 coarse chunks from one request of GROUP_COLUMNS
   * cells over its 16 × 16 chunks: each cell is a coarse column (4 ×
   * blockM), read at the column's centre. Those not already held (a fine
   * group's are better) go into the cache.
   * @returns {Promise<Map<string, object>>} coarse key → chunk
   */
  function loadSupergroup(region, si, sj) {
    const key = `${regionKey(region)}|s${si}:${sj}`;
    const inFlight = supergroups.get(key);
    if (inFlight) return inFlight;
    const coarseM = region.blockM * CHUNK_GROUP;
    const promise = (async () => {
      const answer = await ask(supergroupBounds(region, si, sj), GROUP_COLUMNS);
      const i0 = si * GROUP_COLUMNS;
      const j0 = sj * GROUP_COLUMNS;
      const heights = samplePlaces(answer, GROUP_COLUMNS, (i, j) =>
        region.toLonLat((i0 + i + 0.5) * coarseM, (j0 + j + 0.5) * coarseM),
      );
      const chunks = new Map();
      for (let b = 0; b < SUPERGROUP; b++)
        for (let a = 0; a < SUPERGROUP; a++) {
          const gi = si * SUPERGROUP + a;
          const gj = sj * SUPERGROUP + b;
          const columns = columnsFromHeights(
            chunkOfGroup(heights, a, b),
            coarseM,
          );
          chunks.set(
            coarseKey(region, gi, gj),
            createChunk({ ci: gi, cj: gj, ...columns }),
          );
        }
      return chunks;
    })();
    supergroups.set(key, promise);
    promise
      .then(
        (chunks) => {
          for (const [chunkKey, chunk] of chunks)
            if (!held.has(chunkKey)) remember(chunkKey, Promise.resolve(chunk));
        },
        () => {},
      )
      .then(() => supergroups.delete(key));
    return promise;
  }

  /** A cached chunk, or one load() makes; failures are not kept. */
  function cached(key, load) {
    const known = held.get(key);
    if (known) {
      remember(key, known);
      return known;
    }
    const promise = load();
    remember(key, promise);
    // A failure is not kept: the controller's retry asks again.
    promise.catch(() => {
      if (held.get(key) === promise) held.delete(key);
    });
    return promise;
  }

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
        ({ header } = await ask(
          probeBox(lon, lat, Math.min(side, windowM)),
          CHUNK_COLUMNS,
        ));
        if (header.cols >= 2 || side >= windowM) break;
      }
      return {
        blockM: snapBlockM(header.cellSizeM),
        source: header.source,
        cellSizeM: header.cellSizeM,
      };
    },

    /** A chunk of the region, from its group's one request. */
    loadChunk(region, ci, cj) {
      const key = `${regionKey(region)}|${ci}:${cj}`;
      const { gi, gj } = groupOf(ci, cj);
      return cached(key, () =>
        loadGroup(region, gi, gj).then(({ chunks }) => chunks.get(key)),
      );
    },

    /**
     * A group's coarse chunk: 64 × 64 columns of CHUNK_GROUP × blockM over
     * the group's ground (chunk gi, gj of a region of that block size at
     * the same origin). From the fine group when it is loaded or in flight
     * (each column the mean of the 4 × 4 fine columns under it), else from
     * its supergroup's one request (the server's cell at 4 × blockM).
     */
    loadCoarseChunk(region, gi, gj) {
      const key = coarseKey(region, gi, gj);
      return cached(key, () => {
        if (groups.has(groupKey(region, gi, gj)))
          return loadGroup(region, gi, gj).then(({ coarse }) => coarse);
        const { si, sj } = supergroupOf(gi, gj);
        return loadSupergroup(region, si, sj).then((chunks) => chunks.get(key));
      });
    },

    /** Chunks held, fine and coarse (for tests and the status line). */
    size: () => held.size,
    clear: () => held.clear(),
  };
}
