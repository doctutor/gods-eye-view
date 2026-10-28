// Personal fork: the Blocks render mode's chunk heights (docs/BLOCKS-PLAN.md).
// A chunk's columns come from GET /api/raster/values for the Elevation layer
// (src/data/rasterValues.js), built a group at a time: a CHUNK_GROUP ×
// CHUNK_GROUP block of chunks aligned to a 4-chunk grid is cut from one
// read of its 256 × 256 columns, with one coarse chunk of the same ground
// at 4 × blockM for the ring beyond the fine render distance. The coarse
// ring beyond the fine chunks is built by supergroup: SUPERGROUP ×
// SUPERGROUP groups (1,024 blocks a side, so 256 columns of 4 × blockM)
// give 16 coarse chunks, and a fine group's own coarse chunk, the mean of
// its fine columns, replaces its supergroup one whenever the fine group is
// loaded.
//
// Milestone 5, blocks at any scale: a region's blockM is a level of the
// pyramid (pyramid.js, regionFor), and every level is served alike. The
// values are asked in tiles of a global lattice of the level (lattice.js:
// 512 cells of blockM a side, the same box for every view), each column
// read from the tile cell under its centre, so the server's 30-day cache
// answers any view at that level and a warm-up can fill it; a level
// coarser than the source's own cell is the mean over each cell (the
// server reduces). Each Earth Engine answer counts a tile against the
// day's budget: at most 18 for a fresh view at any level (3 × 3 tiles for
// the fine disc, 3 × 3 for its coarse ring). Heights are mean sea level as
// the DEM stack reports them; a column at or below 0 m is the sea, water at
// level 0 over a seabed below it.
//
// A region (grid.js) is used through lon0, lat0, blockM, levelM (the
// metres a level, worker1's; blockM when absent), chunkBounds and
// columnCentre; chunks are store.js's, its createChunk unless the
// controller passes one.

import { createRasterValuesClient } from '../../data/rasterValues.js';
import { DEM_SOURCES, VALID_HEIGHT_M } from '../../data/demStack.js';
import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, createChunk as storeChunk } from './store.js';
import { levelMFor, pyramidLevelM } from './pyramid.js';
import {
  LATTICE_CELLS,
  latticeBox,
  latticeIndex,
  latticeKey,
} from './lattice.js';

/** The layer whose values are the heights. */
export const ELEVATION_LAYER = 'ee-elevation';
/**
 * A coarse column is water when less than this share of its fine columns
 * have heights: the server's rule for its means (rasterValues LAND_SHARE).
 */
export const LAND_SHARE = 0.5;
/** Chunks kept in memory, fine and coarse. */
export const MAX_CHUNKS = 1024;
/** Lattice tiles' answers kept in memory (about 1 MB each). */
export const MAX_TILES = 24;
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
 * How far from a region's anchor its tangent plane still stands over the
 * ground, metres (the polar radius, less 1%): grid.js puts a place
 * further out on the limb, so a column there is nodata until the curved
 * frame (milestone 5, decision 5).
 */
export const PLANE_REACH_M = 6_356_752 * 0.99;

/** A region's place at east and north metres, or null past PLANE_REACH_M. */
export const placeAt = (region, x, y) =>
  Math.hypot(x, y) < PLANE_REACH_M ? region.toLonLat(x, y) : null;

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

/**
 * A height as the source may hold it, else NaN: a value outside
 * VALID_HEIGHT_M is a fill value (−9999) that reached the answer, never
 * a column (an answer cached before the server masked fills keeps them).
 */
const validHeight = (h) =>
  h >= VALID_HEIGHT_M[0] && h <= VALID_HEIGHT_M[1] ? h : NaN;

/**
 * A size × size grid of heights, index j × size + i, each read from the
 * lattice tile answer (`answers`: latticeKey → answer) at `blockM` under
 * placeOf(i, j); NaN where the place or its tile is missing, or the value
 * is a fill.
 */
export function sampleLattice(answers, blockM, size, placeOf) {
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const place = placeOf(i, j);
      let height = NaN;
      if (Number.isFinite(place?.lon) && Number.isFinite(place?.lat)) {
        const { ti, tj } = latticeIndex(blockM, place.lon, place.lat);
        const answer = answers.get(latticeKey(blockM, ti, tj));
        if (answer) {
          const { west, south, east, north, cols, rows } = answer.header;
          const col = Math.floor(((place.lon - west) / (east - west)) * cols);
          const row = Math.floor(
            ((north - place.lat) / (north - south)) * rows,
          );
          if (col >= 0 && col < cols && row >= 0 && row < rows)
            height = validHeight(answer.values[row * cols + col]);
        }
      }
      heights[j * size + i] = height;
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
 * field, of its finite heights only; NaN where it has none. With
 * `landShare` (the server's rule for its means, LAND_SHARE), a block less
 * than that share of which has heights, or whose mean is at or below 0 m,
 * is water: 0 m (the sea is nodata in every source).
 */
export function coarseHeights(heights, size, factor, { landShare = 0 } = {}) {
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
      const mean = count ? sum / count : NaN;
      out[j * side + i] =
        landShare > 0 && (count < landShare * factor * factor || mean <= 0)
          ? 0
          : mean;
    }
  }
  return out;
}

/**
 * Heights to the store's columns: level = floor(h / levelM) (the metres a
 * level: blockM for cubes, more for the coarse levels); at or below 0 m
 * water fills level 0 over a seabed at most level -1; nodata is NONE.
 */
export function columnsFromHeights(heights, levelM) {
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
    const level = Math.floor(h / levelM);
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

/** A region's metres a level: its levelM, else its blockM (cubes). */
export const levelOf = (region) =>
  region.levelM > 0 ? region.levelM : region.blockM;

/**
 * The metres a level of a region's coarse ring: its coarseLevelM, else the
 * region's own levelM. The controller meshes fine and coarse chunks at one
 * levelM and matches their levels one to one at the skirts, so a coarse
 * column is CHUNK_GROUP × blockM across and levelM a level, as a fine one.
 */
export const coarseLevelOf = (region) =>
  region.coarseLevelM > 0 ? region.coarseLevelM : levelOf(region);

/** A region's cache key: its anchor, block size and level heights. */
export const regionKey = (region) =>
  `${region.lon0},${region.lat0},${region.blockM}` +
  (levelOf(region) !== region.blockM || region.coarseLevelM > 0
    ? `,${levelOf(region)},${coarseLevelOf(region)}`
    : '');

/**
 * @param {{fetchValues?: (request: {layer: string, mode: string, box:
 *   object, cells: number}) => Promise<{header: object, values:
 *   Float32Array}>, createChunk?: Function, maxChunks?: number,
 *   maxTiles?: number}} options createChunk: store.js's unless given.
 */
export function createChunkSource({
  fetchValues,
  createChunk = storeChunk,
  maxChunks = MAX_CHUNKS,
  maxTiles = MAX_TILES,
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

  const tiles = new Map(); // latticeKey → Promise<answer>, least recently used first
  /** A lattice tile's answer, asked once while kept; a failure is not kept. */
  function tile(blockM, ti, tj) {
    const key = latticeKey(blockM, ti, tj);
    let promise = tiles.get(key);
    if (promise) tiles.delete(key);
    else {
      promise = ask(latticeBox(blockM, ti, tj), LATTICE_CELLS);
      promise.catch(() => {
        if (tiles.get(key) === promise) tiles.delete(key);
      });
    }
    tiles.set(key, promise);
    while (tiles.size > maxTiles) tiles.delete(tiles.keys().next().value);
    return promise;
  }

  /**
   * A size × size grid of heights at a level, each column read at
   * placeOf(i, j) from the lattice tiles under the places (asked together).
   */
  async function heightsAt(blockM, size, placeOf) {
    const lon = new Float64Array(size * size);
    const lat = new Float64Array(size * size);
    const needed = new Map();
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const place = placeOf(i, j);
        const k = j * size + i;
        lon[k] = place?.lon ?? NaN;
        lat[k] = place?.lat ?? NaN;
        if (!Number.isFinite(lon[k]) || !Number.isFinite(lat[k])) continue;
        const { ti, tj } = latticeIndex(blockM, lon[k], lat[k]);
        needed.set(latticeKey(blockM, ti, tj), [ti, tj]);
      }
    const answers = new Map();
    await Promise.all(
      [...needed].map(async ([key, [ti, tj]]) => {
        answers.set(key, await tile(blockM, ti, tj));
      }),
    );
    return sampleLattice(answers, blockM, size, (i, j) => ({
      lon: lon[j * size + i],
      lat: lat[j * size + i],
    }));
  }

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
      const blockM = region.blockM;
      const i0 = gi * GROUP_COLUMNS;
      const j0 = gj * GROUP_COLUMNS;
      const heights = await heightsAt(blockM, GROUP_COLUMNS, (i, j) =>
        placeAt(region, (i0 + i + 0.5) * blockM, (j0 + j + 0.5) * blockM),
      );
      const chunks = new Map();
      for (let b = 0; b < CHUNK_GROUP; b++)
        for (let a = 0; a < CHUNK_GROUP; a++) {
          const ci = gi * CHUNK_GROUP + a;
          const cj = gj * CHUNK_GROUP + b;
          const columns = columnsFromHeights(
            chunkOfGroup(heights, a, b),
            levelOf(region),
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
          coarseHeights(heights, GROUP_COLUMNS, CHUNK_GROUP, {
            landShare: LAND_SHARE,
          }),
          coarseLevelOf(region),
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
   * A supergroup's 16 coarse chunks: GROUP_COLUMNS² coarse columns (4 ×
   * blockM) over its 16 × 16 chunks, each read at its centre from the
   * lattice of the coarse level. Those not already held (a fine group's
   * are better) go into the cache.
   * @returns {Promise<Map<string, object>>} coarse key → chunk
   */
  function loadSupergroup(region, si, sj) {
    const key = `${regionKey(region)}|s${si}:${sj}`;
    const inFlight = supergroups.get(key);
    if (inFlight) return inFlight;
    const coarseM = region.blockM * CHUNK_GROUP;
    const promise = (async () => {
      const i0 = si * GROUP_COLUMNS;
      const j0 = sj * GROUP_COLUMNS;
      const heights = await heightsAt(coarseM, GROUP_COLUMNS, (i, j) =>
        placeAt(region, (i0 + i + 0.5) * coarseM, (j0 + j + 0.5) * coarseM),
      );
      const chunks = new Map();
      for (let b = 0; b < SUPERGROUP; b++)
        for (let a = 0; a < SUPERGROUP; a++) {
          const gi = si * SUPERGROUP + a;
          const gj = sj * SUPERGROUP + b;
          const columns = columnsFromHeights(
            chunkOfGroup(heights, a, b),
            coarseLevelOf(region),
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
     * The block size and source name at a point: the pyramid level
     * (pyramidLevelM) for the DEM stack's native cell there and the block
     * wanted, the native cell read from a probe small enough that the
     * server answers at that cell. `windowM` caps the probe; the native
     * cell is the centre's, so a corner of 3DEP 1 m does not turn a 30 m
     * view into 1 m blocks. `wantedM` not a finite positive number (NaN
     * when the footprint is unknown) is the native cell. `levelM` is the
     * rule's for the block (levelMFor), for createRegion({lon0, lat0,
     * blockM, levelM}). Called as regionFor(lon, lat, windowM, {wantedM});
     * regionFor(lon, lat, {windowM, wantedM}) is the same.
     * @returns {Promise<{blockM: number, levelM: number, nativeM: number,
     *   source: string, cellSizeM: number}>}
     */
    async regionFor(lon, lat, windowOrOptions = Infinity, options = {}) {
      const { windowM = Infinity, wantedM = NaN } =
        typeof windowOrOptions === 'number'
          ? { ...options, windowM: windowOrOptions }
          : { ...windowOrOptions, ...options };
      let header;
      for (const side of PROBE_SIDES_M) {
        ({ header } = await ask(
          probeBox(lon, lat, Math.min(side, windowM)),
          CHUNK_COLUMNS,
        ));
        if (header.cols >= 2 || side >= windowM) break;
      }
      const nativeM = snapBlockM(header.cellSizeM);
      const blockM = pyramidLevelM(nativeM, wantedM);
      return {
        blockM,
        levelM: levelMFor(blockM),
        nativeM,
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
    clear() {
      held.clear();
      tiles.clear();
    },
  };
}
