// Personal fork: the Blocks controller (docs/BLOCKS-PLAN.md). With "Render:
// Blocks" picked beside the ANALYSIS heading and the Elevation layer on, the
// ground around the camera is streamed as chunks of cubes on a grid anchored
// to the world: a region (grid.js) is anchored at the camera with a block
// size from the view's pixel footprint up the source's pyramid of levels
// (source.regionFor; docs/BLOCKS-PLAN.md milestone 5), the chunks within the
// render distance are loaded (source.loadChunk), meshed with their
// neighbours (mesh.js buildChunkMesh) and handed to the renderer
// (renderer.js), nearest the camera's column first and a few per tick;
// chunks that fall far behind are dropped. Beyond them, out to four times
// the distance, a coarse ring: a chunk of 4 × 4 groups at four times the
// block size (source.loadCoarseChunk), drawn until the 16 fine chunks under
// it are. The modules it drives are passed
// in (src/app/blocks.js wires the real ones), so this file stays pure enough
// to test on fakes. Not part of upstream God's Eye View.

import { NO_RELIEF, drawnHeightM } from './relief.js';
import { ELEVATION_LAYER_ID } from '../lego/layerSpecs.js';
import {
  setBlocksFloorM,
  setBlocksScene,
  setBlocksTiles,
  blockSizeText,
} from './floor.js';
import { tilesSourceText } from './tiles.js';
import { BLOCK_PYRAMID_M, levelMFor, pyramidLevelM } from './pyramid.js';
import { latticeIndex } from './lattice.js';
import { blocksStyleLevelFor } from '../../data/blocksStyle.js';
import { cameraArrivalPending } from '../../data/cameraArrival.js';

/** The render distance, in blocks (512 m at 1 m, 15 km at 30 m). */
export const RENDER_DISTANCE_BLOCKS = 512;
/** Chunks beyond this many times the render distance are removed. */
export const REMOVE_FACTOR = 1.25;
/** A coarse chunk covers this many fine chunks a side (4 × 4). */
export const GROUP_CHUNKS = 4;
/** The coarse ring reaches this many times the render distance (R2 = 4·R1). */
export const COARSE_REACH = 4;
/**
 * The block size follows the view (docs/BLOCKS-PLAN.md milestone 5): the
 * smallest level of the pyramid (pyramid.js) at least the source's native
 * cell and FOOTPRINT_BLOCKS screen pixels at the view's centre, so a block
 * is never finer than the data nor than about two pixels.
 */
export const FOOTPRINT_BLOCKS = 2;
/** The pyramid's top level (pyramid.js). */
export const TOP_LEVEL_M = BLOCK_PYRAMID_M[BLOCK_PYRAMID_M.length - 1];
/**
 * Buildings and land cover (structures.js) only up to this block size, the
 * native cells': coarser, a group's Overpass box runs to hundreds of
 * kilometres, and no building is a block wide.
 */
export const STRUCTURES_MAX_BLOCK_M = 30;
/**
 * The app's wait before anchoring (src/app/blocks.js gives it as settleMs):
 * the camera still this long since it last moved, or since the controller
 * started. A shared link's view comes by a flight 1.5 s after the page
 * opens (shareRestoration.js); without the wait a region was anchored at
 * the opening orbit first (worker3's trace, 2026-10-28: 5 requests for 31 km
 * blocks nobody saw).
 */
export const ANCHOR_SETTLE_MS = 2000;
/** The Earth's mean radius, for the horizon (m). */
const EARTH_RADIUS_M = 6_371_000;
/**
 * The ground beyond the horizon is not asked for: the coarse ring (and
 * the rings past it) only to this many times the distance to it.
 */
export const HORIZON_MARGIN = 1.25;
/**
 * The ground distance to the horizon from a height above the ground (m),
 * along the sphere: R · acos(R / (R + h)). 62 km from 300 m, 2,445 km from
 * 500 km, 5,245 km from 3,000 km, never past a quarter of the way round
 * (10,007 km), so a ring cut by it never reaches the antipode.
 */
export const horizonM = (heightM) => {
  const h = Math.max(1, Number(heightM) || 0);
  return EARTH_RADIUS_M * Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));
};
/** Half the way round: no ring reaches past it (m). */
export const ANTIPODE_M = Math.PI * EARTH_RADIUS_M;

/**
 * The fine ring's radius in blocks: R1, or fewer where R1 blocks would
 * pass the horizon cut (at 30,720 m R1 is 15,700 km, wider than the
 * hemisphere: the chunks past the antipode folded back and nothing covered
 * the camera); at least one chunk.
 */
export function fineRadiusBlocks(radiusBlocks, blockM, cutM, chunkColumns) {
  const cap = Math.floor(Math.min(cutM, ANTIPODE_M) / blockM);
  return Math.max(chunkColumns, Math.min(radiusBlocks, cap));
}
/** Each ring past the primary region is the next level at least this × the cell before. */
export const RING_STEP = 4;

/**
 * The rings past the primary region (milestone 5, decision 4): each the
 * next pyramid level at least RING_STEP × the cell before it, with a reach
 * of R1 blocks of it, until a ring's reach passes the horizon (that ring
 * is the last) or the top level. The primary's outermost ring is where
 * they start: its coarse ring (4 × blockM, 4 × R1 × blockM), else its fine
 * disc.
 * @returns {number[]} the rings' block sizes, finest first
 */
export function ringLevels({
  nativeM,
  innerCellM,
  innerReachM,
  radiusBlocks,
  horizonM: horizon,
}) {
  const levels = [];
  let cell = innerCellM;
  let reach = innerReachM;
  while (reach < horizon && cell < TOP_LEVEL_M) {
    const level = pyramidLevelM(nativeM, cell * RING_STEP);
    if (!(level > cell)) break;
    levels.push(level);
    cell = level;
    reach = radiusBlocks * level;
  }
  return levels;
}

/**
 * A ring past the coarse one asks at most this many lattice tiles
 * (lattice.js: 512 cells of its level a side): its 3 × 3 nearest. Uncapped,
 * a ring straddling tile edges asked 4 × 4 (QA, 2026-10-29: 16 at 30 m), the
 * farthest of them for the fog's edge.
 */
export const RING_MAX_TILES = 9;

/**
 * A ring's chunks (nearest first) cut to those whose tiles (`tilesOf(ci,
 * cj)` → tile keys) fall within the first `maxTiles` met: a chunk adding a
 * tile past the budget is left out. Without tiles (no lattice) the list
 * stands.
 */
export function capRingTiles(list, tilesOf, maxTiles = RING_MAX_TILES) {
  const kept = new Set();
  const out = [];
  for (const place of list) {
    const tiles = tilesOf(place.ci, place.cj) || [];
    const fresh = tiles.filter((key) => !kept.has(key));
    if (kept.size + fresh.length > maxTiles) continue;
    for (const key of fresh) kept.add(key);
    out.push(place);
  }
  return out;
}

/** A ring chunk's renderer key (renderer.js levelChunkKey): 'L<blockM>:ci:cj'. */
export const ringKey = (blockM, ci, cj) => `L${blockM}:${ci}:${cj}`;

/** A level changes only when the wanted cell is this far past it, either way. */
export const LEVEL_HYSTERESIS = 2;

/**
 * The level a region at `levelM` (the one asked for) should move to for
 * a wanted cell, or null to stay: up once even half the wanted cell needs
 * a coarser level, down once even twice it fits a finer one (×2 either
 * way, so a view near a boundary does not re-anchor on every move).
 */
export function nextLevelM(levelM, wantedM, nativeM) {
  if (!(wantedM > 0) || !(levelM > 0)) return null;
  const up = pyramidLevelM(nativeM, wantedM / LEVEL_HYSTERESIS) > levelM;
  const down = pyramidLevelM(nativeM, wantedM * LEVEL_HYSTERESIS) < levelM;
  if (!up && !down) return null;
  const next = pyramidLevelM(nativeM, wantedM);
  return next === levelM ? null : next;
}

/**
 * Blocks builds nothing while the camera is higher above the ground than
 * this many times the farthest ring at a block size (4 × R2 × blockM).
 * With the block following the footprint that is never reached below the
 * top level's (251,658 km at 30,720 m); it holds only a region whose source
 * had no level as coarse as asked (8 km at 1 m, 246 km at 30 m): every
 * chunk is Earth Engine data someone pays for, and a block finer than a
 * pixel cannot be seen.
 */
export const CEILING_REACHES = 4;
/** The ground's plausible heights over the ellipsoid, for the ceiling (m). */
const GROUND_FLOOR_M = 500;
const GROUND_CEILING_M = 9000;

/** The height above the ground over which Blocks builds nothing (m). */
export function ceilingM(blockM, radiusBlocks) {
  return (
    CEILING_REACHES *
    radiusBlocks *
    COARSE_REACH *
    (blockM > 0 ? blockM : TOP_LEVEL_M)
  );
}

// A height drawn under the Relief control, as Cesium draws the globe's
// (scene.verticalExaggeration about its relative height): src/layers/
// blocks/relief.js, shared with navigation (the walker, its eye, targeting
// and the outline follow the drawn blocks).
export { drawnHeightM };

/**
 * Whether the camera is in flight (Cesium's flyTo in progress) or an
 * arrival correction still owns it (cameraArrival.js: the ground guard).
 */
export function cameraInFlight(viewer) {
  return (
    Boolean(viewer?.camera?._currentFlight) || cameraArrivalPending(viewer)
  );
}

/** Fog from this fraction of the farthest ring drawn to its edge. */
export const FOG_START = 0.7;
/**
 * Chunks loaded (in flight) and meshed per tick, at most: the mesher takes
 * 10 to 65 ms a chunk warm, so 8 is about half a tick at 1 m.
 */
export const CHUNK_BUDGET = 8;
/**
 * With the worker pool meshing (meshAsync), a tick may start this many
 * loads and submit this many meshes, fine and coarse each: the pool, not
 * the tick, is then the bound (a fresh 1 m ring of about 530 chunks took
 * 25 to 30 s at 8 a tick, the pool idle most of it). Meshes wait while the
 * pool has more than BACKLOG_PER_WORKER × its workers queued.
 */
export const ASYNC_BUDGET = 24;
export const BACKLOG_PER_WORKER = 2;
/** How long the last region's chunks are kept, hidden, after leaving Blocks. */
export const PARK_MS = 60_000;

/** A chunk that fails is asked again this many times at most, backing off. */
export const MAX_ATTEMPTS = 6;
/** The backoff before attempt n + 1: 2 s, 4 s, 8 s … at most a minute. */
export const retryDelayMs = (attempts) =>
  Math.min(60_000, 2000 * 2 ** (attempts - 1));
/** From this block size the budget doubles (tickBudget). */
export const COARSE_BLOCK_M = 30;
/** The borders a fine chunk can hang a skirt from: [name, Δci, Δcj]. */
export const SKIRT_SIDES = Object.freeze([
  ['n', 0, 1],
  ['s', 0, -1],
  ['e', 1, 0],
  ['w', -1, 0],
]);
/** Below this a column's top is the store's NONE (no ground). */
const NO_TOP = -2147483648;
/** A chunk's neighbours as buildChunkMesh names them: [name, Δci, Δcj]. */
export const NEIGHBOURS = Object.freeze([
  ['n', 0, 1],
  ['s', 0, -1],
  ['e', 1, 0],
  ['w', -1, 0],
  ['ne', 1, 1],
  ['nw', -1, 1],
  ['se', 1, -1],
  ['sw', -1, -1],
]);
/** The tick while the camera moves, or while chunks are still coming. */
export const TICK_MS = 500;
/**
 * How long the camera must hold still for Blocks to take it as settled
 * without a moveEnd (a little over Cesium's cameraEventWaitTime, 500 ms):
 * after some flights the camera's up vector changes by ~1e-16 every frame,
 * moveStart fires again ~15 ms after each moveEnd, or no moveEnd comes at
 * all, and the first region (anchored where the camera settles) waited on
 * "waiting for the camera to land" for minutes (3,000 km at −45°,
 * 2026-10-28).
 */
export const SETTLE_MS = 600;
/** Still: within this of where it was (m), and turned less than SETTLE_COS. */
const SETTLE_M = 0.01;
/** cos(0.001°): the camera's direction and up turned less than this. */
const SETTLE_COS = Math.cos((0.001 * Math.PI) / 180);
/**
 * How often the sun is read again at the camera, ms: a view left open
 * follows the day (the study sun's switch at 15°, the light's direction).
 */
export const SUN_TICK_MS = 60_000;
/**
 * How far the real sun moves, degrees, before the chunks are meshed again
 * (the light is baked into the meshes): about 12 minutes of the day.
 */
export const SUN_REMESH_DEG = 3;

/** The angle between two {east, north, up} directions, degrees. */
function angleDeg(a, b) {
  const dot = a.east * b.east + a.north * b.north + a.up * b.up;
  const lengths =
    Math.hypot(a.east, a.north, a.up) * Math.hypot(b.east, b.north, b.up);
  return (
    (Math.acos(Math.max(-1, Math.min(1, dot / (lengths || 1)))) * 180) / Math.PI
  );
}
/** The window the source looks at to pick a region's block size, metres. */
export const REGION_WINDOW_M = 1024;
/**
 * A region is re-anchored when the camera is this far from its origin:
 * 20 km, or twice the render distance when that is more (30 m blocks). The
 * tangent plane is 0.2 m off at 50 km, under a block.
 */
export const REANCHOR_M = 20_000;
/**
 * The sun when none is given (src/app/blocks.js gives the renderer's
 * blocksSun, the real sun above 15°): the renderer's study sun, 60° up
 * from the south-west, a unit vector toward it in the region's
 * east-north-up frame.
 */
export const STUDY_SUN = Object.freeze({
  dir: Object.freeze({
    east: -Math.SQRT1_2 / 2,
    north: -Math.SQRT1_2 / 2,
    up: Math.sqrt(3) / 2,
  }),
  fixed: true,
});

/**
 * Where sea level sits when none is given: the ground is flat (the globe
 * on the ellipsoid), so level 0 is drawn on the ellipsoid. src/app/blocks.js
 * gives the real test (the globe's terrain and the photoreal tiles) and the
 * EGM96 geoid.
 */
export const FLAT_DATUM = Object.freeze({
  flat: () => true,
  undulation: () => 0,
});

const RAD = Math.PI / 180;

/** A call's result as a promise, asked now; a throw is a rejection. */
function call(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * The chunks within `radius` columns of the column (i, j), nearest first:
 * a chunk's distance is from the column to the nearest point of the chunk's
 * square, ties broken by the distance to its centre, then by its key. The
 * camera's own chunk is always first.
 * @returns {{ci: number, cj: number, distance: number}[]}
 */
export function chunkRing({ i, j, radius, chunkColumns }) {
  const size = chunkColumns;
  const x = i + 0.5;
  const y = j + 0.5;
  const ring = [];
  for (
    let ci = Math.floor((x - radius) / size);
    ci <= Math.floor((x + radius) / size);
    ci++
  )
    for (
      let cj = Math.floor((y - radius) / size);
      cj <= Math.floor((y + radius) / size);
      cj++
    ) {
      const distance = chunkDistance({ x, y }, ci, cj, size);
      if (distance > radius) continue;
      const centre = Math.hypot((ci + 0.5) * size - x, (cj + 0.5) * size - y);
      ring.push({ ci, cj, distance, centre });
    }
  ring.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.centre - b.centre ||
      a.ci - b.ci ||
      a.cj - b.cj,
  );
  return ring.map(({ ci, cj, distance }) => ({ ci, cj, distance }));
}

/**
 * A structures answer without its buildings: the land cover (`material`)
 * and the bridge decks (columns `structure` marks) kept, every other
 * column's top NONE. The answer itself is not changed.
 */
export function withoutBuildings(levels) {
  if (!levels?.top) return levels;
  const top = new Int32Array(levels.top.length).fill(NO_TOP);
  if (levels.structure)
    for (let k = 0; k < top.length; k++)
      if (levels.structure[k]) top[k] = levels.top[k];
  return { ...levels, top };
}

/**
 * Take a chunk's buildings and land cover off: its structures layer
 * cleared column by column, and its surfaces (roads, greens, OSM water)
 * back to the heightfield's (store.js clearSurfaces), so its version moves
 * on and it is meshed again. The land cover is painted into the chunk the
 * source holds, so without this a chunk painted once stayed painted with
 * the Buildings switch off, beside chunks first loaded bare: the paint
 * cut off along the chunk grid.
 * @returns {number} columns cleared
 */
export function clearStructures(chunk) {
  const surfaces = chunk?.clearSurfaces?.() || 0;
  if (!chunk?.structure || typeof chunk.setStructure !== 'function')
    return surfaces;
  let cleared = surfaces;
  // A column a value, a chunk square.
  const n = Math.round(Math.sqrt(chunk.structure.top.length));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      if (chunk.structureTop(i, j) !== NO_TOP) {
        chunk.setStructure(i, j, NO_TOP);
        cleared++;
      }
  // The emptied layer goes, so the next call (each tick while the switch
  // is off) has nothing to walk.
  chunk.clearStructures?.();
  return cleared;
}

/**
 * The fine chunks to draw: every chunk of each 4 × 4 group within `radius`
 * columns, so a group is either all fine or coarse (a coarse chunk cannot
 * hide part of itself), nearest first as chunkRing orders them.
 * @returns {{ci: number, cj: number, distance: number}[]}
 */
export function fineRing({ i, j, radius, chunkColumns }) {
  const x = i + 0.5;
  const y = j + 0.5;
  const size = chunkColumns;
  const out = [];
  for (const { gi, gj } of groupRing({ i, j, radius, chunkColumns }))
    for (let dj = 0; dj < GROUP_CHUNKS; dj++)
      for (let di = 0; di < GROUP_CHUNKS; di++) {
        const ci = gi * GROUP_CHUNKS + di;
        const cj = gj * GROUP_CHUNKS + dj;
        out.push({
          ci,
          cj,
          distance: chunkDistance({ x, y }, ci, cj, size),
          centre: Math.hypot((ci + 0.5) * size - x, (cj + 0.5) * size - y),
        });
      }
  out.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.centre - b.centre ||
      a.ci - b.ci ||
      a.cj - b.cj,
  );
  return out.map(({ ci, cj, distance }) => ({ ci, cj, distance }));
}

/**
 * The 4 × 4 groups within `radius` columns, nearest first (chunkRing on
 * squares four chunks wide).
 * @returns {{gi: number, gj: number, distance: number}[]}
 */
export function groupRing({ i, j, radius, chunkColumns }) {
  return chunkRing({
    i,
    j,
    radius,
    chunkColumns: chunkColumns * GROUP_CHUNKS,
  }).map(({ ci, cj, distance }) => ({ gi: ci, gj: cj, distance }));
}

/** The group a fine chunk is in. */
export const groupOf = (ci, cj) => ({
  gi: Math.floor(ci / GROUP_CHUNKS),
  gj: Math.floor(cj / GROUP_CHUNKS),
});

/** A coarse chunk's renderer key: 'c:gi:gj'. */
export const coarseKey = (gi, gj) => `c:${gi}:${gj}`;

/**
 * The fog for a region: from FOG_START of the farthest ring drawn to its
 * edge, the coarse ring's when there is one (R2 = 4·R1), else the fine.
 */
export function fogFor(radiusBlocks, blockM, coarse) {
  const reach = radiusBlocks * (coarse ? COARSE_REACH : 1) * blockM;
  return { startM: FOG_START * reach, endM: reach };
}

/**
 * The sphere the anchor's shift runs on, metres: WGS84's equatorial
 * radius, whose degree is the 111,320 m the shift has always used.
 */
const ANCHOR_SPHERE_M = 6_378_137;
/** A region's anchor is never further than this from the camera's ground, metres. */
export const ANCHOR_MAX_SHIFT_M = 1_000_000;

/** Great-circle metres between two places, on the anchor's sphere. */
export function groundDistanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * ANCHOR_SPHERE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The place `southM` metres south along the meridian and `westM` metres
 * west along the parallel of {lon, lat} (negative: north, east): latitude
 * within ±89.9°, longitude within ±180°, so a shift never wraps past a
 * pole or the antimeridian.
 */
export function shiftAlongGround({ lon, lat }, southM, westM) {
  const lat0 = Math.max(
    -89.9,
    Math.min(89.9, lat - southM / ANCHOR_SPHERE_M / RAD),
  );
  const perDegree = ANCHOR_SPHERE_M * RAD * Math.max(1e-6, Math.cos(lat * RAD));
  const lon0 = lon - westM / perDegree;
  return { lon: ((((lon0 + 180) % 360) + 360) % 360) - 180, lat: lat0 };
}

/**
 * Where a region is anchored for a camera over {lon, lat} (its ground
 * point) at a block size.
 *
 * Below the curved levels (blockM < curvedBlockM, 1,920 m): half a
 * supergroup (supergroupGroups × 4 chunks × 64 columns × blockM / 2)
 * south along the meridian and as far west along the camera's parallel,
 * so the camera stands in the middle of a supergroup in the region's own
 * metres and the buildings' one Overpass query a supergroup (30 m blocks
 * and finer) reaches into as few as the ground allows. Each leg is capped
 * at ANCHOR_MAX_SHIFT_M / √2, so the anchor is never more than 1,000 km
 * from the ground point (at 480 m the shift is 246 km a leg; the cap never
 * bites below the curved levels). This path, rather than one great circle
 * at 225°, keeps the camera centred: the region's axes follow its anchor's
 * meridian, and a great circle leaves the camera 3 to 10% off-centre at
 * 480 m (6% at 60° N) where this path is within 1.3%. createRegion still
 * snaps the point to the block graticule.
 *
 * The curved levels (1,920 m and up) anchor at the ground point itself:
 * no buildings there, and the values come from the global lattice
 * whatever the anchor, so the alignment helps nothing, while the shift
 * grows with the block. Uncapped, in degrees, as it was: 3,932 km a leg at
 * 7,680 m, and 15,728 km (141°) at 30,720 m, which put the anchor past
 * the South Pole at lat0 −99.8° (about 80° S in Antarctica) and the
 * camera's ground 13,500 km from it, past a hemisphere, where the curved
 * grid's azimuthal mapping is distorted: North America drew streaked and
 * out of place.
 *
 * No supergroups: the ground point.
 * @returns {{lon0: number, lat0: number}}
 */
export function anchorFor(
  { lon, lat },
  blockM,
  { supergroupGroups = 0, curvedBlockM = Infinity, chunkColumns = 64 } = {},
) {
  if (!(supergroupGroups > 0) || blockM >= curvedBlockM)
    return { lon0: lon, lat0: lat };
  const halfM = (supergroupGroups * GROUP_CHUNKS * chunkColumns * blockM) / 2;
  let legM = Math.min(halfM, ANCHOR_MAX_SHIFT_M / Math.SQRT2);
  let place = shiftAlongGround({ lon, lat }, legM, legM);
  // Capped: the west leg is measured on the camera's parallel, a little
  // longer on the ground further south; shorten both until it is in reach.
  for (let k = 0; legM < halfM && k < 4; k++) {
    const away = groundDistanceM({ lon, lat }, place);
    if (away <= ANCHOR_MAX_SHIFT_M) break;
    legM *= (ANCHOR_MAX_SHIFT_M / away) * 0.999;
    place = shiftAlongGround({ lon, lat }, legM, legM);
  }
  return { lon0: place.lon, lat0: place.lat };
}

/** Columns from the point {x, y} (in columns) to the farthest corner of the chunk's square. */
export function farthestDistance({ x, y }, ci, cj, size) {
  const dx = Math.max(Math.abs(ci * size - x), Math.abs((ci + 1) * size - x));
  const dy = Math.max(Math.abs(cj * size - y), Math.abs((cj + 1) * size - y));
  return Math.hypot(dx, dy);
}

/** Columns from the point {x, y} (in columns) to the chunk's square. */
export function chunkDistance({ x, y }, ci, cj, size) {
  const dx = Math.max(ci * size - x, 0, x - (ci + 1) * size);
  const dy = Math.max(cj * size - y, 0, y - (cj + 1) * size);
  return Math.hypot(dx, dy);
}

/** The block size from which a region stands on the sphere (grid.js CURVED_BLOCK_M). */
export const CURVED_FROM_M = 1920;
/**
 * The farthest a curved region (CURVED_FROM_M and up) serves from its
 * anchor, metres. It is anchored at the camera's ground point (anchorFor),
 * and its azimuthal mapping stretches across the bearing by (d / R) /
 * sin(d / R): 1.7 % at 2,000 km, 17 % at 6,000 km, 57 % at 10,000 km.
 * Without it, 2 × R1 blocks was 7,864 km at 7,680 m and 31,457 km at
 * 30,720 m (past half the planet: never re-anchored), so a search that
 * flew the camera to another continent kept the old region.
 */
export const CURVED_REANCHOR_M = 2_000_000;

/**
 * How far from its origin a region of `blockM` serves (m): 2 × R1 blocks
 * (at least REANCHOR_M), and at most CURVED_REANCHOR_M for a curved one.
 */
export const reanchorRadiusM = (blockM, radiusBlocks) => {
  const radius = Math.max(REANCHOR_M, 2 * radiusBlocks * blockM);
  return blockM >= CURVED_FROM_M ? Math.min(radius, CURVED_REANCHOR_M) : radius;
};

/**
 * Whether the camera at local {x, y} m has left a region of `blockM` (for
 * a region without grid.js's `within`).
 */
export function needsReanchor(local, blockM, radiusBlocks) {
  return !(
    Math.hypot(local.x, local.y) <= reanchorRadiusM(blockM, radiusBlocks)
  );
}

/**
 * The chunks a tick may load and mesh: `budget`, doubled for 30 m blocks
 * and coarser (the mesher costs the same per chunk, and the chunks are
 * 30 times wider).
 */
export const tickBudget = (budget, blockM) =>
  blockM >= COARSE_BLOCK_M ? budget * 2 : budget;

/** A source's name for the status line, from what regionFor returned. */
export function sourceName(source) {
  if (typeof source === 'string') return source;
  return String(source?.name ?? source?.label ?? source?.id ?? '');
}

/**
 * @param {{
 *   viewer?: object|null,
 *   store: {getMode: () => string, subscribe: Function},
 *   layers: {isEnabled: (id: string) => boolean, subscribeActivity?: Function},
 *   source: {regionFor: Function, loadChunk: Function,
 *     loadCoarseChunk?: Function},
 *   renderer: {setRegion: Function, upsert: Function, remove: Function,
 *     setSun?: Function, setFog?: Function, destroy?: Function},
 *   grid: {createRegion: Function, chunkKey: Function, CHUNK_COLUMNS: number},
 *   buildChunkMesh: Function,
 *   meshAsync?: (chunk: object, options: object) => Promise<object>, the
 *     worker pool's meshChunkAsync (meshPool.js): buildChunkMesh's
 *     arguments, a promise of its mesh; buildChunkMesh in-thread without,
 *   structures?: {loadChunk: (region, ci, cj) => Promise<{top: Int32Array,
 *     bottom: Int32Array}|null>, apply: (chunk, levels) => number,
 *     groupBuildings?: (region, gi, gj)
 *     => Promise<string[]>}, OpenStreetMap land cover and buildings
 *     (structures.js) for the fine chunks while Overpass answers: the land
 *     cover (roads, greens, water, bridge decks) always, the buildings
 *     while store.getBuildings() is not false,
 *   sun?: (lon: number, lat: number) => {dir: {east: number, north: number,
 *     up: number}, fixed: boolean},
 *   supergroupGroups?: number, the groups a side of the source's coarse
 *     request (source.js SUPERGROUP): a region is anchored with the camera
 *     in the middle of one, and a supergroup all of whose groups are drawn
 *     fine is not asked for (0: neither),
 *   meshBacklog?: () => {waiting: number, workers: number}, the pool's
 *     queue (meshPool.js stats), for back-pressure on mesh submits,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout,
 *   inFlight?: () => boolean, a camera flight or arrival correction in
 *     progress (cameraInFlight on the viewer unless given),
 *   flatStyle?: () => boolean, whether the map is a drawn style (blank,
 *     Positron, dark, Countries), where Blocks hides the globe,
 *   datum?: {flat: () => boolean, undulation: (lat: number, lon: number)
 *     => number|Promise<number>, subscribe?: Function},
 *   footprint?: () => number, what one screen pixel covers at the view's
 *     centre, m (src/hud/cameraState.js viewFootprintM); NaN when unknown,
 *     and the block is then the native cell,
 *   relief?: () => {factor: number, relativeM: number}, the Relief
 *     control as the scene draws it (scene.verticalExaggeration and its
 *     relative height): the drawn heights follow, the readouts keep metres,
 *   subscribeRelief?: (listener: Function) => Function,
 *   settleMs?: number, how long the camera must be still before a region
 *     is anchored or changes level (ANCHOR_SETTLE_MS in the app; 0 here),
 *   radiusBlocks?: number, budget?: number, tickMs?: number,
 *   requestRender?: Function, now?: () => number,
 *   setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval,
 *   setSunIntervalImpl?: typeof setInterval,
 *   clearSunIntervalImpl?: typeof clearInterval,
 * }} options sun: (lon, lat) → the light at the camera, read when a
 *   region is anchored and every SUN_TICK_MS after.
 */
export function createBlocksController({
  viewer = null,
  store,
  layers,
  source,
  renderer,
  grid,
  buildChunkMesh,
  meshAsync = null,
  structures = null,
  sun = () => STUDY_SUN,
  datum = FLAT_DATUM,
  flatStyle = () => false,
  inFlight = null,
  supergroupGroups = 0,
  meshBacklog = null,
  footprint = () => Number.NaN,
  settleMs = 0,
  relief = () => NO_RELIEF,
  subscribeRelief = null,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
  radiusBlocks = RENDER_DISTANCE_BLOCKS,
  budget = CHUNK_BUDGET,
  tickMs = TICK_MS,
  requestRender = () => {},
  now = () => Date.now(),
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
  // The sun's own interval (SUN_TICK_MS), not holding a process open.
  setSunIntervalImpl = (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle?.unref?.();
    return handle;
  },
  clearSunIntervalImpl = (handle) => clearInterval(handle),
  // The precomputed tilesets (tiles.js planTiles over the server's index):
  // {plan({lon, lat, wantedM, samples}) → {mode, box, floorM}}, or null.
  tiles = null,
}) {
  let _viewer = viewer;
  let _region = null; // {region, blockM, levelM, askedM, nativeM, relief, sourceName, sun}
  let _anchoring = null; // the regionFor promise in flight
  let _generation = 0;
  let _interval = null;
  let _sunInterval = null;
  let _moving = false;
  /** When the camera last came to rest (the controller's start at first). */
  let _settledAt = now();
  let _destroyed = false;
  let _status = { state: 'off' };
  let _globeHidden = false;
  let _globeBefore = true;
  /** Left Blocks: the region's chunks kept, hidden, until this timer evicts them. */
  let _parkTimer = null;
  /** key → {key, ci, cj, chunk, loading, failed, signature, shown} */
  const _chunks = new Map();
  /** 'c:gi:gj' → the same, for the coarse ring ({gi, gj}, and its mesh kept). */
  const _coarse = new Map();
  /**
   * The rings past the primary region's coarse ring, by block size: {level,
   * region (its own, anchored at the camera), chunks: ringKey → entry}.
   */
  const _rings = new Map();
  /** The ring holes last told to the renderer (syncRings), as JSON. */
  let _ringHolesKey = null;
  /**
   * The precomputed tiles' plan in force (tiles.js planTiles): 'tiles' (they
   * draw the view, the live chunks none), 'hybrid' (the live levels finer
   * than their floor, the tiles the rest outside a hole), 'off'.
   */
  let _tiles = { mode: 'off' };
  /** The live chunks' reach (m) about the rings' centre: the tiles' hole. */
  let _liveReachM = 0;
  /**
   * The fog's reach with tiles (m): the eye's straight line to the horizon
   * (the shader fogs by distance from the eye), with HORIZON_MARGIN.
   */
  let _horizonCutM = 0;
  const eyeHorizonM = (heightM) => {
    const h = Math.max(1, Number(heightM) || 0);
    return HORIZON_MARGIN * Math.sqrt(h * (2 * EARTH_RADIUS_M + h));
  };
  /** The geoid under the tiles in 'tiles' mode: {lon, lat, flat, offsetM}. */
  let _tilesDatum = null;
  /** What the tiles layer was last told (status.tiles), kept while the same. */
  let _tilesStatus = null;
  /** The live rings' centre (the camera's ground at the last tick). */
  let _holeCentre = null;
  /**
   * What the last tick wanted drawn, nearest first: the fine disc, the
   * coarse ring and the rings past it, each with its reach (m), for the
   * tiles' hole to open only as far as the live chunks are drawn
   * (drawnReachM).
   */
  let _wanted = null;
  /** The live renderer's fog last set for the tiles ('hybrid'), as JSON. */
  let _tilesFogKey = null;
  /** The map an entry is kept in. */
  const heldOf = (entry) =>
    entry.ring ? entry.ring.chunks : entry.coarse ? _coarse : _chunks;
  /** Every ring chunk's entry. */
  const ringEntries = () =>
    [..._rings.values()].flatMap((ring) => [...ring.chunks.values()]);
  /** Overpass said it is not configured: no buildings this page. */
  let _overpassMissing = false;
  /** 'gi:gj' → the ids of the buildings placed in that group. */
  const _groupBuildings = new Map();
  /**
   * Whether buildings can be drawn: a structures source, Overpass not
   * known to be missing, and the Buildings switch not turned off (unchosen
   * is on).
   */
  const buildingsOn = () =>
    Boolean(structures) &&
    !_overpassMissing &&
    store.getBuildings?.() !== false;
  /**
   * Whether this region's fine chunks get the OSM land cover (roads,
   * greens, water, bridge decks): a structures source, Overpass not known
   * to be missing, and blocks no coarser than STRUCTURES_MAX_BLOCK_M (a
   * group's Overpass box is 30 km across at 120 m blocks, 8,000 km at the
   * top level). Not the Buildings switch: the land cover is painted on
   * every fine chunk from its first load either way, so no chunk's paint
   * depends on when it came (a Baltimore street, 2026-10-29: roads and
   * greens cut off along the chunk grid with Buildings off).
   */
  const structuresHere = () =>
    Boolean(structures) &&
    !_overpassMissing &&
    Boolean(_region) &&
    _region.blockM <= STRUCTURES_MAX_BLOCK_M;
  /** Whether the fine chunks get their buildings too: the switch on. */
  const buildingsHere = () =>
    structuresHere() && store.getBuildings?.() !== false;
  /** Whether the held answers were last applied with their buildings. */
  let _buildingsApplied = null;
  /**
   * The finest level the tiles draw in 'hybrid' (the live chunks stay
   * finer), else Infinity.
   */
  const tilesFloorM = () =>
    _tiles.mode === 'hybrid' && _tiles.floorM > 0 ? _tiles.floorM : Infinity;
  /**
   * Whether the source draws a coarse ring (loadCoarseChunk), and the
   * tiles do not draw its level (4 × the region's blocks) in 'hybrid'.
   */
  const coarseOn = (blockM = _region?.blockM) =>
    typeof source.loadCoarseChunk === 'function' &&
    !(blockM * GROUP_CHUNKS >= tilesFloorM());
  const _listeners = new Set();
  const _removers = [];

  const emit = () => {
    for (const listener of [..._listeners]) {
      try {
        listener(_status);
      } catch (error) {
        console.warn('[Blocks] listener failed:', error);
      }
    }
  };
  const setStatus = (next) => {
    // Every status carries the tiles' plan in force (null when off): the
    // tiles layer shows them whatever the live chunks are doing.
    const status =
      'tiles' in next ? next : { ...next, tiles: tilesStatusNow() };
    const same =
      Object.keys(status).length === Object.keys(_status).length &&
      Object.keys(status).every((key) => status[key] === _status[key]);
    _status = status;
    setBlocksFloorM(
      status.state === 'ready' && status.chunks + (status.coarse || 0) > 0
        ? status.blockM
        : null,
    );
    // The tiles drawing the view are the HUD's floor: "Blocks tiles
    // 2026-10 · lower 48 · 480 m".
    setBlocksTiles(
      status.state === 'tiles' && status.tiles
        ? {
            name: tilesSourceText(status.tiles, blockSizeText),
            floorM: status.tiles.finestM,
          }
        : null,
    );
    if (!same) emit();
  };

  const active = () =>
    !_destroyed &&
    store.getMode() === 'blocks' &&
    Boolean(layers?.isEnabled?.(ELEVATION_LAYER_ID));

  /** The camera's position in degrees, or null. */
  function cameraLonLat() {
    const place = _viewer?.camera?.positionCartographic;
    if (!place || !Number.isFinite(place.longitude)) return null;
    return {
      lon: place.longitude / RAD,
      lat: place.latitude / RAD,
      height: place.height,
    };
  }

  /**
   * The ground the view shows: the canvas's middle, corners and edges'
   * middles where they meet the ellipsoid (the sky's are left out), as
   * {lon, lat}; none without a camera that picks.
   */
  function viewSamples() {
    const camera = _viewer?.camera;
    const canvas = _viewer?.scene?.canvas;
    const ellipsoid = _viewer?.scene?.globe?.ellipsoid;
    if (!camera?.pickEllipsoid || !canvas || !ellipsoid) return [];
    const width = canvas.clientWidth || canvas.width || 0;
    const height = canvas.clientHeight || canvas.height || 0;
    const out = [];
    for (const [u, v] of [
      [0.5, 0.5],
      [0, 0],
      [0.5, 0],
      [1, 0],
      [0, 0.5],
      [1, 0.5],
      [0, 1],
      [0.5, 1],
      [1, 1],
    ])
      try {
        const hit = camera.pickEllipsoid({ x: u * width, y: v * height });
        const at = hit && ellipsoid.cartesianToCartographic(hit);
        if (at) out.push({ lon: at.longitude / RAD, lat: at.latitude / RAD });
      } catch {
        /* off the globe */
      }
    return out;
  }

  /**
   * The tiles' plan for the view now (tiles.plan), with hysteresis: in
   * 'tiles' it stays until the view wants cells under half their floor.
   */
  function tilesPlanNow(camera) {
    if (!tiles?.plan || !camera) return { mode: 'off' };
    const wantedM = wantedCellM();
    let plan = null;
    try {
      plan = tiles.plan({
        lon: camera.lon,
        lat: camera.lat,
        wantedM,
        samples: viewSamples(),
      });
    } catch (error) {
      console.warn('[Blocks] no tiles plan:', error?.message || error);
    }
    if (!plan?.mode) return { mode: 'off' };
    if (
      _tiles.mode === 'tiles' &&
      plan.mode === 'hybrid' &&
      plan.box === _tiles.box &&
      wantedM >= plan.floorM / LEVEL_HYSTERESIS
    )
      return { ...plan, mode: 'tiles' };
    return plan;
  }

  /**
   * What the tiles layer is told (status.tiles): the box and its floor, the
   * hole about the camera's ground the live chunks draw ('hybrid'), the
   * geoid offset to raise them by (the region's in 'hybrid', the camera's
   * in 'tiles': their heights are above sea level) and the fog toward the
   * horizon; null when off. The same object while nothing changed.
   */
  /**
   * How far about the rings' centre the live chunks are drawn (m): none
   * until every chunk of the fine disc is drawn (or failed), then the fine
   * disc's reach, the coarse ring's once it is in, and each ring's as it
   * comes, nearest first; never past the live reach. The tiles' hole opens
   * to it ('hybrid'), so the tiles stay the picture until the live chunks
   * replace them, and nothing is drawn twice for long.
   */
  function drawnReachM() {
    const wanted = _wanted;
    if (!wanted || !_region) return 0;
    const done = (entry) => Boolean(entry && (entry.shown || entry.failed));
    if (
      !wanted.fine.every(({ ci, cj }) =>
        done(_chunks.get(grid.chunkKey(ci, cj))),
      )
    )
      return 0;
    let reach = wanted.fineReachM;
    if (wanted.groups.length) {
      const coarseIn = wanted.groups.every(
        ({ gi, gj }) =>
          done(_coarse.get(coarseKey(gi, gj))) || groupDrawn(gi, gj),
      );
      if (!coarseIn) return Math.min(reach, _liveReachM);
      reach = wanted.coarseReachM;
    }
    for (const { ring, list } of wanted.rings) {
      if (_rings.get(ring.level) !== ring) break;
      if (
        !list.every(({ ci, cj }) =>
          done(ring.chunks.get(ringKey(ring.level, ci, cj))),
        )
      )
        break;
      reach = radiusBlocks * ring.level;
    }
    return Math.min(reach, _liveReachM);
  }

  function tilesStatusNow() {
    if (_tiles.mode === 'off' || !_tiles.box) {
      _tilesStatus = null;
      return null;
    }
    const hybrid = _tiles.mode === 'hybrid';
    const holeM = hybrid && _region && _holeCentre ? drawnReachM() : 0;
    const next = {
      mode: _tiles.mode,
      box: _tiles.box.name,
      label: _tiles.box.label,
      month: _tiles.box.month,
      finestM: _tiles.box.finestM,
      floorM: _tiles.floorM,
      // Where the live chunks are drawn: none until the fine disc is in.
      hole: holeM > 0 ? { ..._holeCentre, radiusM: holeM } : null,
      datumOffsetM: hybrid
        ? (_region?.datumOffsetM ?? 0)
        : (_tilesDatum?.offsetM ?? 0),
      fog:
        _horizonCutM > 0
          ? { startM: FOG_START * _horizonCutM, endM: _horizonCutM }
          : null,
    };
    if (JSON.stringify(next) !== JSON.stringify(_tilesStatus))
      _tilesStatus = next;
    return _tilesStatus;
  }

  /**
   * The view drawn by the tiles alone: the live region, if any, goes; the
   * globe is hidden with no style draped (the tiles are the world); the
   * geoid under the camera raises them. Ticks only while the camera moves.
   */
  function enterTiles(camera, plan) {
    const fromLive = _region || _anchoring || _chunks.size || _coarse.size;
    _tiles = plan;
    if (fromLive) clearAll('tiles');
    _horizonCutM = eyeHorizonM(heightAboveGround(camera));
    setGlobe(false);
    setBlocksScene({ active: true, globeHidden: _globeHidden, style: null });
    syncTilesDatum(camera);
    setStatus({ state: 'tiles', tiles: tilesStatusNow() });
    if (_moving) startTicking();
    else stopTicking();
  }

  /**
   * The geoid's undulation under the camera for the tiles alone, asked
   * again when the camera has gone REANCHOR_M or the datum changed (0 on a
   * flat basemap, as the live regions have it).
   */
  function syncTilesDatum(camera) {
    const flat = Boolean(datum.flat());
    const known = _tilesDatum;
    if (
      known &&
      known.flat === flat &&
      groundDistanceM(known, camera) < REANCHOR_M
    )
      return;
    const asked = { lon: camera.lon, lat: camera.lat, flat, offsetM: 0 };
    _tilesDatum = { ...asked, offsetM: known?.offsetM ?? 0 };
    datumOffsetFor({ lon0: camera.lon, lat0: camera.lat }, flat, camera).then(
      (offsetM) => {
        if (_tilesDatum?.lon !== asked.lon || _tilesDatum?.lat !== asked.lat)
          return;
        _tilesDatum = { ...asked, offsetM };
        if (_tiles.mode === 'tiles' && active())
          setStatus({ state: 'tiles', tiles: tilesStatusNow() });
      },
    );
  }

  /**
   * Another plan than 'tiles': the live chunks draw again. A region
   * anchored under another plan (the tiles' floor or box changed, or they
   * came or went) is anchored again, so its rings and coarse ring stop
   * short of what the tiles draw.
   */
  function leaveTiles(plan) {
    const was = _tiles;
    _tiles = plan;
    if (
      was.mode === plan.mode &&
      was.box === plan.box &&
      was.floorM === plan.floorM
    )
      return;
    _tilesFogKey = null;
    if (_region || _anchoring) clearAll('anchoring');
    else if (_status.state === 'tiles') setStatus({ state: 'anchoring' });
  }

  function stopTicking() {
    if (_interval === null) return;
    clearIntervalImpl(_interval);
    _interval = null;
  }
  function startTicking() {
    if (_interval !== null || _destroyed) return;
    _interval = setIntervalImpl(() => tick(), tickMs);
  }

  /**
   * Read the sun again at the camera (SUN_TICK_MS): the status line's
   * study-sun flag follows the day, and when the sun switches between the
   * real one and the study sun, or the real one has moved SUN_REMESH_DEG,
   * the chunks are meshed again in the new light, nearest first.
   * @returns {boolean} whether the light changed
   */
  function refreshSun() {
    if (!_region || _destroyed || !active()) return false;
    const camera = cameraLonLat();
    if (!camera) return false;
    const light = sun(camera.lon, camera.lat) || STUDY_SUN;
    const before = _region.sun;
    const changed =
      Boolean(light.fixed) !== Boolean(before?.fixed) ||
      !before?.dir ||
      angleDeg(light.dir, before.dir) > SUN_REMESH_DEG;
    if (!changed) return false;
    _region.sun = light;
    _region.sunEpoch = (_region.sunEpoch ?? 0) + 1;
    renderer.setSun?.(light.dir, { fixed: Boolean(light.fixed) });
    statusNow();
    startTicking();
    requestRender('blocks-sun');
    return true;
  }
  function startSunTicking() {
    if (_sunInterval !== null || _destroyed) return;
    _sunInterval = setSunIntervalImpl(() => refreshSun(), SUN_TICK_MS);
  }
  function stopSunTicking() {
    if (_sunInterval === null) return;
    clearSunIntervalImpl(_sunInterval);
    _sunInterval = null;
  }

  /** Every chunk off the renderer and forgotten; the region too. */
  function clearAll(state) {
    _generation++;
    _anchoring = null;
    for (const entry of [
      ..._chunks.values(),
      ..._coarse.values(),
      ...ringEntries(),
    ])
      if (entry.shown) {
        try {
          renderer.remove(entry.key);
        } catch (error) {
          console.warn('[Blocks] chunk not removed:', error?.message);
        }
      }
    _chunks.clear();
    _coarse.clear();
    _rings.clear();
    _ringHolesKey = null;
    _tilesFogKey = null;
    _liveReachM = 0;
    _wanted = null;
    _groupBuildings.clear();
    _region = null;
    stopTicking();
    stopSunTicking();
    setStatus({ state });
    requestRender('blocks-clear');
  }

  function statusNow() {
    // Parked (Blocks left) or off: a late result does not bring it back.
    if (!_region || _parkTimer !== null || !active()) return;
    let shown = 0;
    let coarse = 0;
    let failed = 0;
    let pending = 0;
    for (const entry of _chunks.values()) {
      if (entry.shown) shown++;
      else if (entry.failed) failed++;
      else pending++;
    }
    for (const entry of _coarse.values()) {
      if (entry.shown) coarse++;
      else if (entry.failed) failed++;
      else if (!entry.chunk) pending++;
    }
    // The rings past the coarse one count with it.
    for (const entry of ringEntries()) {
      if (entry.shown) coarse++;
      else if (entry.failed) failed++;
      else pending++;
    }
    // Buildings drawn: those placed in groups with a fine chunk drawn
    // with its buildings, each once; not counted at all while a drawn
    // group's buildings or ids are still coming, so two looks at the same
    // place agree.
    const ids = new Set();
    let buildingsPending = false;
    if (buildingsHere()) {
      for (const entry of _chunks.values())
        if (entry.shown && structuresComing(entry)) buildingsPending = true;
      for (const [key, list] of _groupBuildings) {
        const [gi, gj] = key.split(':').map(Number);
        if (!groupHasBuildings(gi, gj)) continue;
        if (list === null) buildingsPending = true;
        else for (const id of list) ids.add(id);
      }
    }
    setStatus({
      state: pending
        ? 'loading'
        : shown || coarse || !failed
          ? 'ready'
          : 'failed',
      blockM: _region.blockM,
      levelM: _region.levelM,
      relief: _region.relief.factor,
      chunks: shown,
      coarse,
      pending,
      failed,
      source: _region.sourceName,
      buildings: buildingsPending ? 0 : ids.size,
      buildingsPending,
      buildingsOn: buildingsHere(),
      // The study sun (the real one is under 15°): said on the line.
      sunFixed: Boolean(_region.sun?.fixed),
      // The precomputed tiles past the live chunks ('hybrid'), or null.
      tiles: tilesStatusNow(),
    });
  }

  function anchor(camera) {
    const generation = _generation;
    const stale = () => generation !== _generation || !active();
    setStatus({ state: 'anchoring' });
    const fail = (error, unavailable = false) => {
      if (generation !== _generation) return;
      _anchoring = null;
      stopTicking();
      setStatus({
        state: unavailable ? 'unavailable' : 'failed',
        error: String(error?.message || error),
      });
      if (!unavailable)
        console.warn('[Blocks] no region:', error?.message || error);
    };
    // The cell the view wants: two pixels at its centre.
    const wantedM = wantedCellM();
    _anchoring = call(() =>
      source.regionFor(camera.lon, camera.lat, REGION_WINDOW_M, { wantedM }),
    ).then(
      async (found) => {
        if (stale()) return;
        const blockM = Number(found?.blockM);
        if (!(blockM > 0)) throw new Error('no block size for this region');
        // The source's native cell (a source without levels answers it).
        const nativeM =
          Number(found?.nativeM) > 0 ? Number(found.nativeM) : blockM;
        // The metres a level: the source's (regionFor), else the rule's.
        const levelM =
          Number(found?.levelM) > 0 ? Number(found.levelM) : levelMFor(blockM);
        const region = grid.createRegion({
          ...anchorPoint(camera, blockM),
          blockM,
          levelM,
          ...liveCurved(blockM),
        });
        // Where sea level is: the ellipsoid on flat ground, the geoid on terrain.
        const flat = Boolean(datum.flat());
        const datumOffsetM = await datumOffsetFor(region, flat, camera);
        if (stale()) return;
        _anchoring = null;
        // The sun at the region, once: mesh.js bakes it into the colours.
        const light = sun(camera.lon, camera.lat) || STUDY_SUN;
        const shown = readRelief();
        call(() =>
          renderer.setRegion(region, {
            datumOffsetM: drawnHeightM(datumOffsetM, shown),
          }),
        ).catch((error) =>
          console.warn('[Blocks] region not set:', error?.message || error),
        );
        renderer.setSun?.(light.dir, { fixed: Boolean(light.fixed) });
        renderer.setFog?.(fogFor(radiusBlocks, blockM, coarseOn(blockM)));
        _region = {
          region,
          blockM,
          levelM,
          // The level asked for (the source may have none so coarse).
          askedM: pyramidLevelM(nativeM, wantedM),
          followsView: wantedM > 0,
          nativeM,
          relief: shown,
          reliefEpoch: 0,
          sourceName: sourceName(found.source),
          sun: light,
          sunEpoch: 0,
          flat,
          datumOffsetM,
        };
        startSunTicking();
        tick();
      },
      (error) => fail(error, [404, 501, 503].includes(Number(error?.status))),
    );
    _anchoring.catch((error) => fail(error));
  }

  /** The cell the view wants (m): FOOTPRINT_BLOCKS pixels, NaN unknown. */
  function wantedCellM() {
    let px = Number.NaN;
    try {
      px = Number(footprint());
    } catch {
      /* not measured */
    }
    return px > 0 ? FOOTPRINT_BLOCKS * px : Number.NaN;
  }

  /** The Relief control now: {factor ≥ 1, relativeM}. */
  function readRelief() {
    let now = NO_RELIEF;
    try {
      now = relief() || NO_RELIEF;
    } catch {
      /* none */
    }
    const factor = Number(now.factor) > 1 ? Number(now.factor) : 1;
    const relativeM = Number.isFinite(Number(now.relativeM))
      ? Number(now.relativeM)
      : 0;
    return Object.freeze({ factor, relativeM: factor > 1 ? relativeM : 0 });
  }

  /**
   * Follow the Relief control: a new relative height moves the region
   * (the renderer keeps the chunks); a new factor meshes them again (the
   * level height drawn is levelM × the factor).
   * @returns {boolean} whether anything changed
   */
  function syncRelief() {
    if (!_region) return false;
    const next = readRelief();
    const before = _region.relief;
    if (next.factor === before.factor && next.relativeM === before.relativeM)
      return false;
    if (next.factor !== before.factor) _region.reliefEpoch += 1;
    _region.relief = next;
    call(() =>
      renderer.setRegion(_region.region, {
        datumOffsetM: drawnHeightM(_region.datumOffsetM, next),
      }),
    ).catch((error) =>
      console.warn('[Blocks] region not moved:', error?.message || error),
    );
    requestRender('blocks-relief');
    return true;
  }

  /**
   * A live region's map: curved from grid.js LIVE_CURVED_BLOCK_M (480 m)
   * up, as the tileset's 480 m level is, so a live chunk and a tile beside
   * it raise their columns along the same verticals; a grid without it
   * keeps createRegion's own rule.
   */
  const liveCurved = (blockM) =>
    grid.LIVE_CURVED_BLOCK_M > 0
      ? { curved: blockM >= grid.LIVE_CURVED_BLOCK_M }
      : {};

  /** Where a region is anchored (anchorFor, with this controller's supergroups). */
  const anchorPoint = (camera, blockM) =>
    anchorFor(camera, blockM, {
      supergroupGroups,
      curvedBlockM: grid.CURVED_BLOCK_M ?? Infinity,
      chunkColumns: grid.CHUNK_COLUMNS,
    });

  /**
   * The region's datum offset (m, added to its heights above sea level):
   * 0 on flat ground, where the globe is the ellipsoid and sea level is
   * drawn on it (as Lego's columns stand); the geoid undulation at the
   * origin on terrain or the photoreal tiles, whose heights are
   * ellipsoidal, so level 0 lands on the sea surface there. A geoid that
   * cannot be read is 0 (about 30 m off at worst).
   */
  async function datumOffsetFor(region, flat, camera) {
    if (flat) return 0;
    try {
      const n = Number(
        await datum.undulation(
          region.lat0 ?? camera.lat,
          region.lon0 ?? camera.lon,
        ),
      );
      return Number.isFinite(n) ? n : 0;
    } catch (error) {
      console.warn('[Blocks] no geoid:', error?.message || error);
      return 0;
    }
  }

  function load(entry) {
    const generation = _generation;
    const region = entry.ring ? entry.ring.region : _region.region;
    const held = heldOf(entry);
    entry.loading = call(() =>
      entry.coarse
        ? source.loadCoarseChunk(region, entry.gi, entry.gj)
        : source.loadChunk(region, entry.ci, entry.cj),
    ).then(
      (chunk) => {
        if (generation !== _generation || held.get(entry.key) !== entry) return;
        entry.loading = null;
        entry.chunk = chunk;
      },
      (error) => {
        if (generation !== _generation || held.get(entry.key) !== entry) return;
        entry.loading = null;
        entry.failed = true;
        entry.attempts += 1;
        // The source keeps no failure: asked again after a backoff.
        entry.retryAt =
          entry.attempts < MAX_ATTEMPTS
            ? now() + retryDelayMs(entry.attempts)
            : Infinity;
        console.warn(
          `[Blocks] chunk ${entry.key} not loaded (attempt ${entry.attempts}${error?.status ? `, HTTP ${error.status}` : ''}):`,
          error?.message || error,
        );
      },
    );
  }

  /**
   * The loaded chunks around one: the four it shares a side with (their
   * border faces) and the four diagonals (ambient occlusion at its
   * corners). mesh.js reads a missing one as the edge column repeated (no
   * wall), so a chunk is meshed again when any of the eight arrives.
   */
  function neighboursOf(entry) {
    const { ring } = entry;
    const at = ring
      ? (ci, cj) => ring.chunks.get(ringKey(ring.level, ci, cj))?.chunk || null
      : entry.coarse
        ? (gi, gj) => _coarse.get(coarseKey(gi, gj))?.chunk || null
        : (ci, cj) => _chunks.get(grid.chunkKey(ci, cj))?.chunk || null;
    const [a, b] = entry.coarse ? [entry.gi, entry.gj] : [entry.ci, entry.cj];
    const out = {};
    for (const [name, di, dj] of NEIGHBOURS) {
      // Beyond a side of a coarse chunk, a group drawn fine is not its
      // neighbour: its hidden coarse chunk would cull the border where the
      // fine ground is lower, so the skirt (skirtFor) stands in.
      if (entry.coarse && (di === 0 || dj === 0) && groupDrawn(a + di, b + dj))
        continue;
      const chunk = at(a + di, b + dj);
      if (chunk) out[name] = chunk;
    }
    return out;
  }
  const signatureOf = (chunk, neighbours) =>
    [chunk, ...NEIGHBOURS.map(([name]) => neighbours[name])]
      .map((c) => (c ? String(c.version ?? 0) : '-'))
      .join('|');

  /**
   * The lowest top of a chunk, in its own levels (null for one with no
   * ground), kept until its version changes.
   */
  function lowestTop(entry) {
    const version = entry.chunk.version ?? 0;
    if (entry.lowestVersion === version) return entry.lowest;
    let lowest = Infinity;
    const n = grid.CHUNK_COLUMNS;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const top = entry.chunk.topSolid?.(i, j);
        if (Number.isFinite(top) && top > NO_TOP && top < lowest) lowest = top;
      }
    entry.lowest = lowest === Infinity ? null : lowest;
    entry.lowestVersion = version;
    return entry.lowest;
  }

  /** The lowest top of a group drawn fine, in fine levels, or null. */
  function lowestFine(gi, gj) {
    let lowest = Infinity;
    for (let dj = 0; dj < GROUP_CHUNKS; dj++)
      for (let di = 0; di < GROUP_CHUNKS; di++) {
        const entry = _chunks.get(
          grid.chunkKey(gi * GROUP_CHUNKS + di, gj * GROUP_CHUNKS + dj),
        );
        const top = entry?.chunk ? lowestTop(entry) : null;
        if (top !== null && top < lowest) lowest = top;
      }
    return lowest === Infinity ? null : lowest;
  }

  /**
   * A chunk's skirts ({n, s, e, w}, floor levels or null), where the fine
   * ring meets the coarse one, so neither shows the background between:
   * - a fine chunk, along a border whose fine neighbour is neither loaded
   *   nor coming: down to the lowest ground of the coarse chunk beyond
   *   (a coarse chunk keeps the region's levels: its blocks are four wide,
   *   not four tall), for where the fine ground is higher;
   * - a coarse chunk, along a border with a group drawn fine: down to the
   *   lowest fine ground there (in coarse levels), for where the coarse
   *   ground is higher. None toward other coarse chunks.
   */
  function skirtFor(entry) {
    // The rings past the coarse one hang none (their edges are in fog).
    if (entry.ring) return null;
    let any = false;
    const skirt = {};
    if (entry.coarse) {
      for (const [name, di, dj] of SKIRT_SIDES) {
        skirt[name] = null;
        const gi = entry.gi + di;
        const gj = entry.gj + dj;
        if (!groupDrawn(gi, gj)) continue;
        const lowest = lowestFine(gi, gj);
        if (lowest === null) continue;
        skirt[name] = lowest;
        any = true;
      }
      return any ? skirt : null;
    }
    for (const [name, di, dj] of SKIRT_SIDES) {
      skirt[name] = null;
      const ci = entry.ci + di;
      const cj = entry.cj + dj;
      const fine = _chunks.get(grid.chunkKey(ci, cj));
      if (fine?.chunk || fine?.loading) continue;
      const { gi, gj } = groupOf(ci, cj);
      const beyond = _coarse.get(coarseKey(gi, gj));
      if (!beyond?.chunk) continue;
      const lowest = lowestTop(beyond);
      if (lowest === null) continue;
      skirt[name] = lowest;
      any = true;
    }
    return any ? skirt : null;
  }

  /** What a chunk is meshed from, and the signature that says when again. */
  function meshInputs(entry) {
    const neighbours = neighboursOf(entry);
    const skirt = skirtFor(entry);
    const floors = skirt
      ? SKIRT_SIDES.map(([name]) => skirt[name] ?? '-').join(',')
      : '';
    return {
      neighbours,
      skirt,
      // The sun's epoch too: the light is baked, so a new sun meshes again;
      // and the relief's, the level height drawn.
      signature: `${signatureOf(entry.chunk, neighbours)}|${floors}|s${_region.sunEpoch ?? 0}|r${_region.reliefEpoch ?? 0}`,
    };
  }

  /** What buildChunkMesh (or meshAsync) is given: plain data but the chunks. */
  const meshOptions = (entry, { neighbours, skirt }) => {
    // A coarse chunk's blocks are four wide, on the region's levels; a
    // ring's, its own level's.
    const blockM = entry.ring
      ? entry.ring.level
      : _region.blockM * (entry.coarse ? GROUP_CHUNKS : 1);
    return {
      neighbours,
      blockM,
      // The level height drawn: the region's (the ring's), times the relief.
      levelM:
        (entry.ring ? entry.ring.region.levelM : _region.levelM) *
        _region.relief.factor,
      sunDir: _region.sun.dir,
      ...(skirt ? { skirt } : {}),
      // Cells of CURVED_BLOCK_M and up, and every chunk of a curved region
      // (480 m and up, liveCurved), stand on the ellipsoid (mesh.js
      // curvedPlacement): the region, the mesh's south-west corner in its
      // metres, and the drawn datum the renderer's frame sits at.
      ...(blockM >= grid.CURVED_BLOCK_M ||
      (entry.ring ? entry.ring.region : _region.region)?.curved === true
        ? { curved: curvedOptions(entry) }
        : flatDropOptions(entry)),
    };
  };

  /**
   * A flat chunk's place on its region, for the mesher to drop each vertex
   * onto the curve (mesh.js flatDrop): none for a region without a
   * dropAt (a test's), whose chunks keep the corner's drop alone.
   */
  function flatDropOptions(entry) {
    const region = entry.ring ? entry.ring.region : _region.region;
    if (typeof region?.dropAt !== 'function') return {};
    const corner = entry.coarse
      ? region.chunkOrigin(entry.gi * GROUP_CHUNKS, entry.gj * GROUP_CHUNKS)
      : region.chunkOrigin(entry.ci, entry.cj);
    return {
      flatDrop: {
        lon0: region.lon0,
        lat0: region.lat0,
        regionBlockM: region.blockM,
        cornerM: { x: corner.x, y: corner.y },
      },
    };
  }

  /** What the mesher needs to stand a chunk's columns on the ellipsoid. */
  function curvedOptions(entry) {
    // A ring's chunk is in its own region.
    const region = entry.ring ? entry.ring.region : _region.region;
    const corner = entry.coarse
      ? region.chunkOrigin(entry.gi * GROUP_CHUNKS, entry.gj * GROUP_CHUNKS)
      : region.chunkOrigin(entry.ci, entry.cj);
    return {
      lon0: region.lon0,
      lat0: region.lat0,
      regionBlockM: region.blockM,
      cornerM: { x: corner.x, y: corner.y },
      datumM: drawnHeightM(_region.datumOffsetM || 0, _region.relief),
    };
  }

  /** A mesh drawn for its entry, as meshed from `signature`. */
  function place(entry, built, signature) {
    if (entry.coarse) {
      // The renderer cannot read a 'c:' key: the group's south-west corner
      // (a curved mesh carries its own origin). Kept for when it comes back.
      if (!built.origin)
        built.origin = _region.region.chunkOrigin(
          entry.gi * GROUP_CHUNKS,
          entry.gj * GROUP_CHUNKS,
        );
      entry.mesh = built;
    }
    entry.signature = signature;
    // A coarse chunk covered meanwhile keeps the mesh for when it comes back.
    if (entry.coarse && groupDrawn(entry.gi, entry.gj)) return;
    renderer.upsert(entry.key, built);
    entry.shown = true;
  }

  /**
   * A mesh that failed: the chunk is loaded and meshed again after the
   * loads' backoff (2 s, 4 s, … six tries), not given up for the region.
   */
  function meshFailed(entry, error) {
    entry.failed = true;
    entry.chunk = null;
    entry.attempts += 1;
    entry.retryAt =
      entry.attempts < MAX_ATTEMPTS
        ? now() + retryDelayMs(entry.attempts)
        : Infinity;
    console.warn(
      `[Blocks] chunk ${entry.key} not meshed (attempt ${entry.attempts}):`,
      error?.message || error,
    );
  }

  /**
   * Mesh a chunk: in this thread with buildChunkMesh, or through `meshAsync`
   * (the worker pool, meshPool.js) when given. A pooled mesh that comes
   * back after the region was anchored again, the chunk was dropped, or
   * its inputs moved on (its version, a neighbour, a skirt) is thrown
   * away: the next tick meshes it again from what it is now.
   */
  function mesh(entry, inputs) {
    const options = meshOptions(entry, inputs);
    if (!meshAsync) {
      place(entry, buildChunkMesh(entry.chunk, options), inputs.signature);
      return;
    }
    const generation = _generation;
    const held = heldOf(entry);
    entry.meshing = inputs.signature;
    call(() => meshAsync(entry.chunk, options)).then(
      (built) => {
        if (generation !== _generation || held.get(entry.key) !== entry) return;
        if (entry.meshing === inputs.signature) entry.meshing = null;
        if (!entry.chunk || meshInputs(entry).signature !== inputs.signature)
          return;
        place(entry, built, inputs.signature);
        statusNow();
        requestRender('blocks-chunks');
      },
      (error) => {
        if (generation !== _generation || held.get(entry.key) !== entry) return;
        entry.meshing = null;
        meshFailed(entry, error);
      },
    );
  }

  /** Whether a fine chunk's buildings are still to come (asked, or to be asked again). */
  const structuresComing = (entry) =>
    entry.structures === undefined ||
    entry.structures === 'loading' ||
    (entry.structures === 'failed' && entry.structuresRetryAt !== Infinity);

  /** Whether a fine chunk of the group is drawn with its buildings. */
  function groupHasBuildings(gi, gj) {
    for (let dj = 0; dj < GROUP_CHUNKS; dj++)
      for (let di = 0; di < GROUP_CHUNKS; di++) {
        const entry = _chunks.get(
          grid.chunkKey(gi * GROUP_CHUNKS + di, gj * GROUP_CHUNKS + dj),
        );
        if (entry?.shown && entry.structures === 'done') return true;
      }
    return false;
  }

  /**
   * A fine chunk's buildings: asked of the structures source once its
   * terrain is in, put into its structures layer (its version moves on, so
   * it is meshed again), and its group's building ids kept for the count.
   * A failure is asked again after the same backoff as a chunk; Overpass
   * saying it is not configured ends buildings for this page.
   */
  /**
   * Put a chunk's kept answer into it: the land cover and bridge decks
   * always, the buildings with the switch on (withoutBuildings otherwise).
   * The structures layer is cleared first, so a switch change re-applies
   * in place; the surfaces are idempotent.
   */
  function applyLevels(entry) {
    if (!entry.chunk) return;
    entry.chunk.clearStructures?.();
    if (!entry.levels) return;
    structures.apply(
      entry.chunk,
      buildingsHere() ? entry.levels : withoutBuildings(entry.levels),
    );
  }

  /** A group's building ids, for the count (asked once a group). */
  function askGroupBuildings(entry) {
    if (!structures.groupBuildings) return;
    const generation = _generation;
    const { region } = _region;
    const { gi, gj } = groupOf(entry.ci, entry.cj);
    const key = `${gi}:${gj}`;
    if (_groupBuildings.has(key)) return;
    // null while the ids are coming: the count waits for them.
    _groupBuildings.set(key, null);
    call(() => structures.groupBuildings(region, gi, gj)).then(
      (list) => {
        if (generation !== _generation || !_groupBuildings.has(key)) return;
        _groupBuildings.set(key, Array.isArray(list) ? list : []);
        statusNow();
      },
      () => {
        // No ids: counted as none rather than waited for.
        if (_groupBuildings.get(key) === null) _groupBuildings.set(key, []);
      },
    );
  }

  function loadStructures(entry) {
    const generation = _generation;
    const { region } = _region;
    entry.structures = 'loading';
    const stale = () =>
      generation !== _generation || _chunks.get(entry.key) !== entry;
    call(() => structures.loadChunk(region, entry.ci, entry.cj)).then(
      (levels) => {
        if (stale()) return;
        if (!structuresHere() || !entry.chunk) {
          entry.structures = undefined;
          return;
        }
        // The answer is kept (the structures source holds it anyway), so
        // the switch can raise or drop its buildings without asking again.
        entry.levels = levels || null;
        applyLevels(entry);
        entry.structures = 'done';
        if (buildingsHere()) askGroupBuildings(entry);
      },
      (error) => {
        if (stale()) return;
        if (error?.code === 'unconfigured') {
          _overpassMissing = true;
          entry.structures = undefined;
          statusNow();
          return;
        }
        entry.structuresAttempts = (entry.structuresAttempts || 0) + 1;
        entry.structures = 'failed';
        entry.structuresRetryAt =
          entry.structuresAttempts < MAX_ATTEMPTS
            ? now() + retryDelayMs(entry.structuresAttempts)
            : Infinity;
        console.warn(
          `[Blocks] buildings for ${entry.key} not loaded:`,
          error?.message || error,
        );
      },
    );
  }

  /**
   * The land cover (and, with the switch on, the buildings) for the fine
   * ring, nearest first and under the budget. A switch change re-applies
   * every held answer in place: buildings raised or dropped, the paint
   * kept, nothing asked again. With no land cover here at all (Overpass
   * missing, blocks too coarse) everything comes off every held chunk.
   */
  function syncStructures(ring, perTick, time) {
    if (!structures) return;
    const withBuildings = buildingsHere();
    if (structuresHere() && _buildingsApplied !== withBuildings) {
      _buildingsApplied = withBuildings;
      if (!withBuildings) _groupBuildings.clear();
      for (const entry of _chunks.values()) {
        if (entry.structures !== 'done') continue;
        applyLevels(entry);
        if (withBuildings) askGroupBuildings(entry);
      }
    }
    if (!structuresHere()) {
      _buildingsApplied = null;
      // Every held chunk, not only those this pass painted: one the source
      // handed back from its cache can carry an earlier pass's paint.
      for (const entry of _chunks.values()) {
        if (entry.chunk) clearStructures(entry.chunk);
        entry.structures = undefined;
      }
      _groupBuildings.clear();
      return;
    }
    let inFlight = 0;
    for (const entry of _chunks.values())
      if (entry.structures === 'loading') inFlight++;
    for (const { ci, cj } of ring) {
      if (inFlight >= perTick) break;
      const entry = _chunks.get(grid.chunkKey(ci, cj));
      if (!entry?.chunk) continue;
      if (entry.structures === 'loading' || entry.structures === 'done')
        continue;
      if (entry.structures === 'failed' && !(entry.structuresRetryAt <= time))
        continue;
      loadStructures(entry);
      inFlight++;
    }
  }

  const newEntry = (fields) => ({
    chunk: null,
    loading: null,
    failed: false,
    attempts: 0,
    retryAt: 0,
    signature: '',
    shown: false,
    ...fields,
  });

  /**
   * Whether every group of the supergroup holding (gi, gj) lies within
   * the fine ring (radius columns of the camera, as fineRing measures): its
   * coarse chunks would never be drawn, so the source's request for them
   * is not made.
   */
  function supergroupInside(at, gi, gj, groupSize, radius) {
    const n = supergroupGroups;
    if (!(n > 0)) return false;
    const si = Math.floor(gi / n) * n;
    const sj = Math.floor(gj / n) * n;
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++)
        if (chunkDistance(at, si + a, sj + b, groupSize) > radius) return false;
    return true;
  }

  /** Whether all 16 fine chunks under a group are drawn. */
  function groupDrawn(gi, gj) {
    for (let dj = 0; dj < GROUP_CHUNKS; dj++)
      for (let di = 0; di < GROUP_CHUNKS; di++)
        if (
          !_chunks.get(
            grid.chunkKey(gi * GROUP_CHUNKS + di, gj * GROUP_CHUNKS + dj),
          )?.shown
        )
          return false;
    return true;
  }

  /**
   * One step: anchor or re-anchor, drop the far chunks, start loads and
   * mesh what arrived, each under the budget, nearest first.
   */
  /**
   * Within the render distance the world is the blocks: on a drawn style
   * the globe is hidden while Blocks is on (the fog hides the edge). On
   * imagery and the photoreal tiles the globe stays. Leaving Blocks on a
   * drawn style shows it again; on a switch to another map the map stack
   * controller has set it for that map already, and it is left as it is.
   */
  /**
   * `held`: why Blocks waits, or null. Through a flight or an arrival
   * correction the globe stays hidden on a drawn style (Blocks will build
   * where it lands, and a shown globe would have the Elevation layer fetch
   * colour tiles for nothing: about 127 Earth Engine tiles a session that
   * opens into Blocks); too high to build, Blocks cannot, and the globe
   * shows.
   */
  function applyGlobe(held = null) {
    const cannotBuild = held === 'too-high';
    const style = styleCellNow(held);
    // The style drapes the globe, so the globe shows while it is on.
    setGlobe(cannotBuild || style !== null);
    // Told after the globe is set, so the overlays re-drape where it is.
    setBlocksScene({
      active: active() && !cannotBuild,
      globeHidden: _globeHidden,
      style,
    });
  }

  /**
   * The cell of the Elevation layer's Blocks style to drape now
   * (blocksStyleLevelFor the view's pixel footprint), or null: under and
   * beyond blocks coarser than the native cells, and where Blocks cannot
   * build (above its ceiling, failed, no values service). Never while the
   * native cells' geometry covers the view, nor without a footprint (Walk
   * and Fly), nor in flight.
   */
  function styleCellNow(held) {
    if (_destroyed || !active() || held === 'flying') return null;
    const cannotBuild =
      held === 'too-high' ||
      _status.state === 'failed' ||
      _status.state === 'unavailable';
    // Over coarse blocks only while they build (the first picture): once
    // they are drawn the rings reach the horizon and hide the drape, whose
    // tiles were then asked for nothing (QA, 2026-10-29: 138 to 245 a step
    // at continental scale).
    const coarse = _region
      ? _region.blockM > STRUCTURES_MAX_BLOCK_M
      : wantedCellM() > STRUCTURES_MAX_BLOCK_M;
    const building =
      !_region || _status.state === 'anchoring' || _status.state === 'loading';
    if (!cannotBuild && !(coarse && building)) return null;
    let px = Number.NaN;
    try {
      px = Number(footprint());
    } catch {
      /* not measured */
    }
    return px > 0 ? blocksStyleLevelFor(px) : null;
  }

  function setGlobe(cannotBuild) {
    const globe = _viewer?.scene?.globe;
    if (!globe) return;
    const drawn = Boolean(flatStyle());
    if (active() && drawn && !cannotBuild) {
      if (!_globeHidden) {
        _globeHidden = true;
        _globeBefore = globe.show;
      }
      if (globe.show) {
        globe.show = false;
        requestRender('blocks-globe');
      }
      return;
    }
    if (!_globeHidden) return;
    _globeHidden = false;
    if (drawn && !globe.show && _globeBefore !== false) {
      globe.show = true;
      requestRender('blocks-globe');
    }
  }

  /**
   * Why Blocks waits now, or null: 'flying' while the camera flies or an
   * arrival correction owns it, 'too-high' above the ceiling (ceilingNow).
   */
  function holdFor(camera) {
    if (!camera) return null;
    if (inFlight ? inFlight() : cameraInFlight(_viewer)) return 'flying';
    return heightAboveGround(camera) > ceilingNow() ? 'too-high' : null;
  }

  /**
   * The ceiling now: the top level's, unless the region cannot follow the
   * view: its source had no level as coarse as was asked (a source without
   * levels), or the view's footprint was not known when it was anchored.
   * Its own block size then bounds it, as before the pyramid.
   */
  function ceilingNow() {
    const bounded =
      _region && (_region.blockM < _region.askedM || !_region.followsView);
    return ceilingM(bounded ? _region.blockM : TOP_LEVEL_M, radiusBlocks);
  }

  /** The camera's height over the ground: over the globe's surface where it answers, else the ellipsoid. */
  function heightAboveGround(camera) {
    let ground = 0;
    try {
      // A hidden globe (Blocks hides it through a flight hold) answers from
      // tiles it no longer updates: tens of kilometres below the ellipsoid
      // just after landing, which read as too high to build until the next
      // moveEnd. Only a shown globe's height counts, and only a plausible
      // one (no land lies 500 m below the ellipsoid, none 9 km above).
      const globe = _viewer?.scene?.globe;
      const at = _viewer?.camera?.positionCartographic;
      const h = at && globe?.show ? globe.getHeight?.(at) : undefined;
      if (Number.isFinite(h) && h > -GROUND_FLOOR_M && h < GROUND_CEILING_M)
        ground = h;
    } catch {
      /* no globe */
    }
    return camera.height - ground;
  }

  /**
   * Leaving Blocks (another render mode, or Elevation off): the region's
   * chunks are hidden, not dropped, for PARK_MS, so coming back is
   * instant; then they go. Without a renderer that can hide, they go now.
   */
  function park() {
    if (_parkTimer !== null) return;
    if (!_region || typeof renderer.setVisible !== 'function') {
      clearAll(statusOff());
      return;
    }
    renderer.setVisible(false);
    stopTicking();
    setStatus({ state: statusOff() });
    requestRender('blocks-park');
    _parkTimer = setTimeoutImpl(() => {
      _parkTimer = null;
      clearAll(statusOff());
      renderer.setVisible(true);
    }, PARK_MS);
  }

  /** Back in Blocks while parked: the kept chunks shown again. */
  function unpark() {
    if (_parkTimer === null) return;
    clearTimeoutImpl(_parkTimer);
    _parkTimer = null;
    renderer.setVisible?.(true);
    requestRender('blocks-unpark');
  }

  function tick() {
    // Cesium says the camera moves, but it has held still SETTLE_MS (a
    // moveEnd late, or never: its up vector churning by ~1e-16 a frame):
    // settled all the same.
    if (_moving && cameraStill()) {
      _moving = false;
      // At rest since it stopped changing, for settleMs.
      _settledAt = _still?.since ?? now();
    }
    const camera = active() ? cameraLonLat() : null;
    // The precomputed tiles first: when they draw the view there is no
    // anchor, no ceiling and no waiting for a flight to land. Out of
    // Blocks, none.
    if (!camera && _tiles.mode !== 'off') {
      _tiles = { mode: 'off' };
      _tilesStatus = null;
    }
    if (camera) {
      const plan = tilesPlanNow(camera);
      if (plan.mode === 'tiles') {
        unpark();
        enterTiles(camera, plan);
        return;
      }
      leaveTiles(plan);
    }
    const held = holdFor(camera);
    applyGlobe(held);
    if (!active()) {
      if (_region || _anchoring || _chunks.size) park();
      else setStatus({ state: statusOff() });
      return;
    }
    unpark();
    if (!camera) return;
    if (held) {
      // Nothing anchored or asked for; what is drawn stays.
      setStatus({ state: held, ceilingM: ceilingNow() });
      // In flight: tick until it lands (a correction may end without a
      // moveEnd); too high: the next moveEnd looks again.
      if (held === 'flying' || _moving) startTicking();
      else stopTicking();
      return;
    }
    if (_anchoring) return;
    // The first region is anchored where the camera settles, not mid-move,
    // and only once it has been still settleMs.
    const settled = !_moving && now() - _settledAt >= settleMs;
    if (!_region && !settled) {
      startTicking();
      return;
    }
    if (_region) {
      const local = _region.region.toLocal(camera.lon, camera.lat);
      const radiusM = reanchorRadiusM(_region.blockM, radiusBlocks);
      const left =
        typeof _region.region.within === 'function'
          ? !_region.region.within(camera.lon, camera.lat, radiusM)
          : needsReanchor(local, _region.blockM, radiusBlocks);
      // The view wants another level (×2 past it either way). Not mid-move:
      // a zoom re-anchors where it settles.
      const level =
        settled &&
        nextLevelM(_region.askedM, wantedCellM(), _region.nativeM) !== null;
      // Settling toward another level: look again next tick.
      if (!settled && !_moving) startTicking();
      if (left || level || Boolean(datum.flat()) !== _region.flat) {
        clearAll('anchoring');
        startTicking();
      }
    }
    if (!_region) {
      anchor(camera);
      return;
    }
    syncRelief();
    const { region } = _region;
    const local = region.toLocal(camera.lon, camera.lat);
    const { i, j } = region.columnOf(local.x, local.y);
    const size = grid.CHUNK_COLUMNS;
    // Drop what fell behind: fine chunks a group at a time.
    const at = { x: i + 0.5, y: j + 0.5 };
    const groupSize = size * GROUP_CHUNKS;
    // The fine ring to R1 blocks, or to the horizon where that is nearer
    // (continental levels); everything past the horizon is left out.
    const horizonCut = HORIZON_MARGIN * horizonM(heightAboveGround(camera));
    _horizonCutM = eyeHorizonM(heightAboveGround(camera));
    const radius = fineRadiusBlocks(
      radiusBlocks,
      _region.blockM,
      horizonCut,
      size,
    );
    const far = radius * REMOVE_FACTOR;
    let changed = false;
    for (const entry of [..._chunks.values()]) {
      const { gi, gj } = groupOf(entry.ci, entry.cj);
      if (chunkDistance(at, gi, gj, groupSize) <= far) continue;
      if (entry.shown) {
        renderer.remove(entry.key);
        changed = true;
      }
      _chunks.delete(entry.key);
    }
    // The dropped groups' building ids go with them.
    for (const key of [..._groupBuildings.keys()]) {
      const [gi, gj] = key.split(':').map(Number);
      if (chunkDistance(at, gi, gj, groupSize) > far)
        _groupBuildings.delete(key);
    }
    const coarseFar = radiusBlocks * COARSE_REACH * REMOVE_FACTOR;
    for (const entry of [..._coarse.values()]) {
      if (chunkDistance(at, entry.gi, entry.gj, groupSize) <= coarseFar)
        continue;
      if (entry.shown) {
        renderer.remove(entry.key);
        changed = true;
      }
      _coarse.delete(entry.key);
    }
    const ring = fineRing({ i, j, radius, chunkColumns: size });
    const groups = coarseOn()
      ? groupRing({
          i,
          j,
          radius: radiusBlocks * COARSE_REACH,
          chunkColumns: size,
        }).filter(
          ({ gi, gj, distance }) =>
            !supergroupInside(at, gi, gj, groupSize, radius) &&
            // Not past the horizon (from 500 km the ring would run over
            // the pole on the tangent plane).
            distance * _region.blockM <= horizonCut,
        )
      : [];
    // A chunk held but no longer wanted (the camera moved on, the ring
    // shrank with the horizon) that is not drawn and not on its way goes:
    // nothing would mesh it, and it would count as loading for ever.
    const wantedFine = new Set(ring.map(({ ci, cj }) => grid.chunkKey(ci, cj)));
    dropUnwanted(_chunks, wantedFine);
    // Coarse chunks drawn or kept with their data (hidden under a drawn
    // fine group) stay; one without data that is no longer wanted goes.
    const wantedCoarse = new Set(groups.map(({ gi, gj }) => coarseKey(gi, gj)));
    dropUnwanted(_coarse, wantedCoarse, (entry) => !entry.chunk);
    // With the pool meshing, the pool is the bound, not the tick.
    const perTick = meshAsync
      ? Math.max(ASYNC_BUDGET, tickBudget(budget, _region.blockM))
      : tickBudget(budget, _region.blockM);
    const time = now();
    // Start loads, nearest first, while fewer than the budget are in flight:
    // the fine chunks, and the coarse ring with a budget of its own (a
    // coarse chunk costs what a fine one does and covers 16).
    const startLoads = (wanted, held, keyOf, make) => {
      let inFlight = 0;
      for (const entry of held.values()) if (entry.loading) inFlight++;
      for (const place of wanted) {
        if (inFlight >= perTick) break;
        const key = keyOf(place);
        const known = held.get(key);
        if (known) {
          // A failed chunk is asked again once its backoff is over.
          if (known.failed && known.retryAt <= time) {
            known.failed = false;
            load(known);
            inFlight++;
          }
          continue;
        }
        const entry = make(key, place);
        held.set(key, entry);
        load(entry);
        inFlight++;
      }
    };
    startLoads(
      ring,
      _chunks,
      ({ ci, cj }) => grid.chunkKey(ci, cj),
      (key, { ci, cj }) => newEntry({ key, ci, cj }),
    );
    startLoads(
      groups,
      _coarse,
      ({ gi, gj }) => coarseKey(gi, gj),
      (key, { gi, gj }) => newEntry({ key, gi, gj, coarse: true }),
    );
    // The fine ring's buildings (never the coarse ring's).
    syncStructures(ring, perTick, time);
    // The rings past the coarse one: loaded once the fine ring is in, so
    // the near ground comes first.
    const rings = syncRings(camera, horizonCut);
    _wanted = {
      fine: ring,
      fineReachM: radius * _region.blockM,
      groups,
      coarseReachM: radiusBlocks * COARSE_REACH * _region.blockM,
      rings,
    };
    // With the tiles past the live chunks, one fog for both, toward the
    // horizon (the live rings stop short of it).
    if (_tiles.mode === 'hybrid') {
      const fog = { startM: FOG_START * _horizonCutM, endM: _horizonCutM };
      const key = JSON.stringify(fog);
      if (key !== _tilesFogKey) {
        _tilesFogKey = key;
        renderer.setFog?.(fog);
      }
    }
    for (const { ring: outer, list } of rings)
      dropUnwanted(
        outer.chunks,
        new Set(list.map(({ ci, cj }) => ringKey(outer.level, ci, cj))),
      );
    const fineIn = ring.every(({ ci, cj }) => {
      const entry = _chunks.get(grid.chunkKey(ci, cj));
      return Boolean(entry && !entry.loading && (entry.chunk || entry.failed));
    });
    if (fineIn)
      for (const { ring: outer, list } of rings)
        startLoads(
          list,
          outer.chunks,
          ({ ci, cj }) => ringKey(outer.level, ci, cj),
          (key, { ci, cj }) => newEntry({ key, ci, cj, ring: outer }),
        );
    // Mesh what arrived or changed (its version, or a neighbour's), nearest
    // first; a coarse chunk goes when the 16 fine chunks under it are drawn
    // and comes back (its mesh kept) when one of them is dropped.
    // Back-pressure: no mesh submits while the pool's queue is deep.
    const backlog = meshAsync ? meshBacklog?.() : null;
    const poolFull =
      Boolean(backlog) &&
      backlog.waiting > BACKLOG_PER_WORKER * Math.max(1, backlog.workers || 0);
    const meshEach = (
      wanted,
      held,
      keyOf,
      covered = () => false,
      wait = () => false,
    ) => {
      let meshed = poolFull ? perTick : 0;
      for (const place of wanted) {
        if (meshed >= perTick) break;
        const entry = held.get(keyOf(place));
        if (!entry?.chunk) continue;
        if (!entry.shown && wait(entry)) continue;
        if (covered(entry)) {
          if (entry.shown) {
            renderer.remove(entry.key);
            entry.shown = false;
            changed = true;
          }
          continue;
        }
        const inputs = meshInputs(entry);
        const { signature } = inputs;
        if (entry.shown && entry.signature === signature) continue;
        // Already being meshed from what it is now (meshAsync).
        if (entry.meshing === signature) continue;
        if (!entry.shown && entry.mesh && entry.signature === signature) {
          renderer.upsert(entry.key, entry.mesh);
          entry.shown = true;
          changed = true;
          continue;
        }
        try {
          mesh(entry, inputs);
        } catch (error) {
          meshFailed(entry, error);
        }
        meshed++;
        changed = true;
      }
    };
    // A fine chunk waits while a neighbour in the ring is still to come
    // (meshing it now would mesh it again when that neighbour lands); at
    // the ring's outer edge the neighbours beyond do not count.
    const inRing = new Set(ring.map(({ ci, cj }) => grid.chunkKey(ci, cj)));
    const neighbourComing = (entry) => {
      for (const [, di, dj] of NEIGHBOURS) {
        const key = grid.chunkKey(entry.ci + di, entry.cj + dj);
        if (!inRing.has(key)) continue;
        const neighbour = _chunks.get(key);
        if (!neighbour || neighbour.loading) return true;
      }
      return false;
    };
    meshEach(
      ring,
      _chunks,
      ({ ci, cj }) => grid.chunkKey(ci, cj),
      undefined,
      neighbourComing,
    );
    meshEach(
      groups,
      _coarse,
      ({ gi, gj }) => coarseKey(gi, gj),
      (entry) => groupDrawn(entry.gi, entry.gj),
    );
    for (const { ring: outer, list } of rings)
      meshEach(list, outer.chunks, ({ ci, cj }) =>
        ringKey(outer.level, ci, cj),
      );
    statusNow();
    if (changed) requestRender('blocks-chunks');
    // Keep ticking while moving, while the camera is settling (the level
    // check waits for it: stopping here left a cached view at the last
    // level), or while work remains; stop when settled.
    if (_moving || !settled || hasWork(ring, groups, rings)) startTicking();
    else stopTicking();
  }

  /**
   * Drop the entries of `held` not in `wanted` that are neither drawn nor
   * loading nor meshing (and pass `also`): a chunk left behind by the ring.
   */
  function dropUnwanted(held, wanted, also = () => true) {
    for (const [key, entry] of [...held])
      if (
        !wanted.has(key) &&
        !entry.shown &&
        !entry.loading &&
        !entry.meshing &&
        also(entry)
      )
        held.delete(key);
  }

  /**
   * Whether a load is in flight, a chunk in range is unloaded or waits for
   * a retry, a mesh is stale, or a coarse chunk is shown when it should not
   * be, or the other way round.
   */
  function hasWork(ring, groups = [], rings = []) {
    for (const entry of [
      ..._chunks.values(),
      ..._coarse.values(),
      ...ringEntries(),
    ])
      if (entry.loading || entry.meshing) return true;
    // Not asked yet, or a retry still to come.
    const waiting = (entry) =>
      !entry || (entry.failed && entry.retryAt !== Infinity);
    const wantBuildings = structuresHere();
    for (const { ci, cj } of ring) {
      const entry = _chunks.get(grid.chunkKey(ci, cj));
      if (waiting(entry)) return true;
      if (!entry.chunk) continue;
      // Buildings still to come, or to be asked again.
      if (
        wantBuildings &&
        (entry.structures === undefined ||
          entry.structures === 'loading' ||
          (entry.structures === 'failed' &&
            entry.structuresRetryAt !== Infinity))
      )
        return true;
      if (!entry.shown || entry.signature !== meshInputs(entry).signature)
        return true;
    }
    for (const { gi, gj } of groups) {
      const entry = _coarse.get(coarseKey(gi, gj));
      if (waiting(entry)) return true;
      if (!entry.chunk) continue;
      const covered = groupDrawn(gi, gj);
      if (covered === entry.shown) return true;
      if (!covered && entry.signature !== meshInputs(entry).signature)
        return true;
    }
    for (const { ring: outer, list } of rings)
      for (const { ci, cj } of list) {
        const entry = outer.chunks.get(ringKey(outer.level, ci, cj));
        if (waiting(entry)) return true;
        if (!entry.chunk) continue;
        if (!entry.shown || entry.signature !== meshInputs(entry).signature)
          return true;
      }
    return false;
  }

  /**
   * The rings past the primary's coarse ring for the camera now
   * (ringLevels, to the horizon): each its own region at its own level,
   * anchored at the camera and again when the camera leaves it, its chunks
   * within R1 blocks less those whose centre the ring inside it covers,
   * none past the horizon (at most its 3 × 3 lattice tiles). The renderer
   * hears of a change through setRegions; one without setRegions draws
   * the primary region alone.
   * @returns {{ring: object, list: {ci: number, cj: number}[]}[]}
   */
  function syncRings(camera, horizonCut) {
    if (typeof renderer.setRegions !== 'function') return [];
    const coarse = coarseOn();
    const innerReachM =
      radiusBlocks * (coarse ? COARSE_REACH : 1) * _region.blockM;
    // The levels the tiles draw ('hybrid') are left to them.
    const levels = ringLevels({
      nativeM: _region.nativeM,
      innerCellM: _region.blockM * (coarse ? GROUP_CHUNKS : 1),
      innerReachM,
      radiusBlocks,
      horizonM: horizonCut,
    }).filter((level) => level < tilesFloorM());
    let changed = false;
    for (const level of [..._rings.keys()])
      if (!levels.includes(level)) {
        _rings.delete(level);
        changed = true;
      }
    const size = grid.CHUNK_COLUMNS;
    const out = [];
    let inner = innerReachM;
    // Each ring's hole: the reach of the rings inside it, which draw that
    // ground (renderer.setRingHoles), about the camera's ground now.
    const reachM = {};
    for (const level of levels) {
      let outer = _rings.get(level);
      const left =
        outer &&
        (typeof outer.region.within === 'function'
          ? !outer.region.within(
              camera.lon,
              camera.lat,
              reanchorRadiusM(level, radiusBlocks),
            )
          : needsReanchor(
              outer.region.toLocal(camera.lon, camera.lat),
              level,
              radiusBlocks,
            ));
      if (!outer || left) {
        outer = {
          level,
          region: grid.createRegion({
            lon0: camera.lon,
            lat0: camera.lat,
            blockM: level,
            levelM: levelMFor(level),
            ...liveCurved(level),
          }),
          chunks: new Map(),
        };
        _rings.set(level, outer);
        changed = true;
      }
      const local = outer.region.toLocal(camera.lon, camera.lat);
      const { i, j } = outer.region.columnOf(local.x, local.y);
      const at = { x: i + 0.5, y: j + 0.5 };
      // Drop what fell behind.
      for (const entry of [...outer.chunks.values()]) {
        if (
          chunkDistance(at, entry.ci, entry.cj, size) <=
          radiusBlocks * REMOVE_FACTOR
        )
          continue;
        if (entry.shown) renderer.remove(entry.key);
        outer.chunks.delete(entry.key);
      }
      const innerBlocks = inner / level;
      reachM[level] = inner;
      // A chunk any part of which lies past the rings inside: one ring
      // chunk (64 blocks) may be wider than the hole, so a chunk whose
      // centre is inside can still reach past it; the renderer leaves out
      // its ground inside the hole.
      const list = capRingTiles(
        chunkRing({
          i,
          j,
          radius: radiusBlocks,
          chunkColumns: size,
        }).filter(
          ({ ci, cj, distance }) =>
            farthestDistance(at, ci, cj, size) > innerBlocks &&
            distance * level <= horizonCut,
        ),
        (ci, cj) => chunkTiles(outer.region, level, ci, cj, size),
      );
      out.push({ ring: outer, list });
      inner = radiusBlocks * level;
    }
    // What the live chunks reach about the camera's ground: the tiles'
    // hole in 'hybrid'.
    _liveReachM = Math.min(inner, horizonCut);
    _holeCentre = { lon: camera.lon, lat: camera.lat };
    if (changed) applyRegions();
    // Told only when they change (the camera moved, a ring came or went):
    // a still camera ticking asked the same holes every 500 ms.
    const holes = levels.length
      ? { lon: camera.lon, lat: camera.lat, reachM }
      : null;
    const key = JSON.stringify(holes);
    if (key !== _ringHolesKey) {
      _ringHolesKey = key;
      call(() => renderer.setRingHoles?.(holes)).catch(() => {});
    }
    return out;
  }

  /**
   * The lattice tiles a chunk of a ring's region asks, as keys: its
   * group's corners' (the source loads a 4 × 4 group of chunks at a time
   * from every tile under it); none for a region without toLonLat (no
   * lattice to count).
   */
  function chunkTiles(region, level, ci, cj, size) {
    if (typeof region.toLonLat !== 'function') return [];
    const groupM = size * GROUP_CHUNKS * level;
    const { gi, gj } = groupOf(ci, cj);
    const keys = new Set();
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const { lon, lat } = region.toLonLat(
        (gi + u) * groupM,
        (gj + v) * groupM,
      );
      const { ti, tj } = latticeIndex(level, lon, lat);
      keys.add(`${ti}:${tj}`);
    }
    return [...keys];
  }

  /**
   * The primary region and the rings to the renderer (setRegions: one
   * datum, the fog from the outermost ring); without rings, the primary
   * region's own fog as before.
   */
  function applyRegions() {
    const regions = [
      _region.region,
      ...[..._rings.values()].map((outer) => outer.region),
    ];
    // With the tiles past the rings ('hybrid') the fog is the horizon's,
    // set each tick; not the outermost ring's.
    const hybrid = _tiles.mode === 'hybrid';
    _tilesFogKey = null;
    call(() =>
      renderer.setRegions(regions, {
        datumOffsetM: drawnHeightM(_region.datumOffsetM, _region.relief),
        fogReachBlocks: _rings.size && !hybrid ? radiusBlocks : null,
      }),
    ).catch((error) =>
      console.warn('[Blocks] rings not set:', error?.message || error),
    );
    if (!_rings.size && !hybrid)
      renderer.setFog?.(fogFor(radiusBlocks, _region.blockM, coarseOn()));
    requestRender('blocks-rings');
  }

  const statusOff = () =>
    !_destroyed && store.getMode() === 'blocks' ? 'no-elevation' : 'off';

  /**
   * Whether the camera has held still SETTLE_MS (its position, direction
   * and up within SETTLE_M and SETTLE_COS of the last time it moved).
   * Asked each tick while Cesium says it moves.
   */
  let _still = null;
  function cameraStill() {
    const camera = _viewer?.camera;
    const p = camera?.positionWC;
    const d = camera?.direction;
    const u = camera?.up;
    if (!p || !d || !u) return false;
    const pose = [p.x, p.y, p.z, d.x, d.y, d.z, u.x, u.y, u.z];
    const t = now();
    const held = _still;
    const same =
      held &&
      Math.hypot(
        pose[0] - held.pose[0],
        pose[1] - held.pose[1],
        pose[2] - held.pose[2],
      ) <= SETTLE_M &&
      pose[3] * held.pose[3] +
        pose[4] * held.pose[4] +
        pose[5] * held.pose[5] >=
        SETTLE_COS &&
      pose[6] * held.pose[6] +
        pose[7] * held.pose[7] +
        pose[8] * held.pose[8] >=
        SETTLE_COS;
    if (!same) {
      _still = { pose, since: t };
      return false;
    }
    return t - held.since >= SETTLE_MS;
  }

  function attach(viewerNow) {
    _viewer = viewerNow || _viewer;
    const camera = _viewer?.camera;
    if (!camera) return;
    if (camera.moveStart)
      _removers.push(
        camera.moveStart.addEventListener(() => {
          // A fresh move: the camera is still only from here on.
          if (!_moving) _still = null;
          _moving = true;
          if (active()) startTicking();
        }),
      );
    if (camera.moveEnd)
      _removers.push(
        camera.moveEnd.addEventListener(() => {
          _moving = false;
          _settledAt = now();
          tick();
        }),
      );
  }

  _removers.push(store.subscribe(() => tick()));
  // The Relief control: read on the next turn, once the scene has it.
  const offRelief = subscribeRelief?.(() =>
    setTimeoutImpl(() => {
      if (!_destroyed && syncRelief()) {
        statusNow();
        startTicking();
      }
    }, 0),
  );
  if (typeof offRelief === 'function') _removers.push(offRelief);
  // A new map stack can flip the ground between flat and terrain.
  const offDatum = datum.subscribe?.(() => tick());
  if (typeof offDatum === 'function') _removers.push(offDatum);
  if (layers?.subscribeActivity)
    _removers.push(
      layers.subscribeActivity((change) => {
        if (
          change?.type === 'visibility-settled' &&
          change.layerId === ELEVATION_LAYER_ID
        )
          tick();
      }),
    );
  if (_viewer) attach(_viewer);
  tick();

  return {
    attach,
    tick,
    /** Read the sun again now (it is read every SUN_TICK_MS); true if the light changed. */
    refreshSun,
    getStatus: () => _status,
    /** Whether buildings are drawn (the Buildings switch, where Overpass answers). */
    getBuildings: () => buildingsOn(),
    /** The Buildings switch (kept in the render mode store and the link). */
    setBuildings: (on) => store.setBuildings?.(on === true),
    /** Whether buildings can be drawn: a structures source, and Overpass answering. */
    buildingsAvailable: () => Boolean(structures) && !_overpassMissing,
    /**
     * The drawn world for Walk and Fly (src/navigation/blocksSource.js):
     * the region, its loaded chunks and the datum offset the renderer
     * lifts it by; null while Blocks is not drawn.
     */
    world() {
      if (!_region || !active()) return null;
      return {
        region: _region.region,
        geoidM: _region.datumOffsetM || 0,
        chunkAt: (ci, cj) => _chunks.get(grid.chunkKey(ci, cj))?.chunk || null,
        // The elevation source's name, for the HUD's BLOCK line.
        sourceName: _region.sourceName || '',
        // The Relief the blocks are drawn under (relief.js), for the walker.
        relief: _region.relief,
      };
    },
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    /** For tests and the harness. */
    _state: () => ({
      parked: _parkTimer !== null,
      groupBuildings: _groupBuildings,
      region: _region,
      chunks: _chunks,
      coarse: _coarse,
      rings: _rings,
      ticking: _interval !== null,
      moving: _moving,
    }),
    destroy() {
      if (_destroyed) return;
      if (_parkTimer !== null) clearTimeoutImpl(_parkTimer);
      _parkTimer = null;
      for (const remove of _removers.splice(0)) {
        try {
          remove?.();
        } catch {
          /* already gone */
        }
      }
      clearAll('off');
      _destroyed = true;
      applyGlobe();
      _listeners.clear();
      setBlocksFloorM(null);
      try {
        renderer.destroy?.();
      } catch {
        /* gone with the scene */
      }
    },
  };
}
