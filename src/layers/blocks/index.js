// Personal fork: the Blocks controller (docs/BLOCKS-PLAN.md). With "Render:
// Blocks" picked beside the ANALYSIS heading and the Elevation layer on, the
// ground around the camera is streamed as chunks of cubes on a grid anchored
// to the world: a region (grid.js) is anchored at the camera with the
// elevation source's block size (source.regionFor), the chunks within the
// render distance are loaded (source.loadChunk), meshed with their
// neighbours (mesh.js buildChunkMesh) and handed to the renderer
// (renderer.js), nearest the camera's column first and a few per tick;
// chunks that fall far behind are dropped. Beyond them, out to four times
// the distance, a coarse ring: a chunk of 4 × 4 groups at four times the
// block size (source.loadCoarseChunk), drawn until the 16 fine chunks under
// it are. The modules it drives are passed
// in (src/app/blocks.js wires the real ones), so this file stays pure enough
// to test on fakes. Not part of upstream God's Eye View.

import { ELEVATION_LAYER_ID } from '../lego/layerSpecs.js';
import { setBlocksFloorM, setBlocksScene } from './floor.js';
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
 * Blocks builds nothing while the camera is higher above the ground than
 * this many times the farthest ring (4 × R2 × blockM: 8 km at 1 m, 246 km
 * at 30 m), nor at all above NO_REGION_CEILING_M before a region says the
 * block size: every chunk is Earth Engine data someone pays for, and from
 * orbit none of it can be seen.
 */
export const CEILING_REACHES = 4;
export const NO_REGION_CEILING_M = 100_000;

/** The height above the ground over which Blocks builds nothing (m). */
export function ceilingM(blockM, radiusBlocks) {
  return blockM > 0
    ? CEILING_REACHES * radiusBlocks * COARSE_REACH * blockM
    : NO_REGION_CEILING_M;
}

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
 * Take a chunk's buildings off (its structures layer cleared column by
 * column, so its version moves on and it is meshed again).
 * @returns {number} columns cleared
 */
export function clearStructures(chunk) {
  if (!chunk?.structure || typeof chunk.setStructure !== 'function') return 0;
  let cleared = 0;
  // A column a value, a chunk square.
  const n = Math.round(Math.sqrt(chunk.structure.top.length));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      if (chunk.structureTop(i, j) !== NO_TOP) {
        chunk.setStructure(i, j, NO_TOP);
        cleared++;
      }
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

/** Columns from the point {x, y} (in columns) to the chunk's square. */
export function chunkDistance({ x, y }, ci, cj, size) {
  const dx = Math.max(ci * size - x, 0, x - (ci + 1) * size);
  const dy = Math.max(cj * size - y, 0, y - (cj + 1) * size);
  return Math.hypot(dx, dy);
}

/** How far from its origin a region of `blockM` serves (m). */
export const reanchorRadiusM = (blockM, radiusBlocks) =>
  Math.max(REANCHOR_M, 2 * radiusBlocks * blockM);

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
 *     => Promise<string[]>}, OpenStreetMap buildings (structures.js) for
 *     the fine chunks, while store.getBuildings() is not false and
 *     Overpass answers,
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
}) {
  let _viewer = viewer;
  let _region = null; // {region, blockM, sourceName, sun}
  let _anchoring = null; // the regionFor promise in flight
  let _generation = 0;
  let _interval = null;
  let _sunInterval = null;
  let _moving = false;
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
  /** Overpass said it is not configured: no buildings this page. */
  let _overpassMissing = false;
  /** 'gi:gj' → the ids of the buildings placed in that group. */
  const _groupBuildings = new Map();
  /**
   * Whether buildings are drawn: a structures source, Overpass not known
   * to be missing, and the Buildings switch not turned off (unchosen is on).
   */
  const buildingsOn = () =>
    Boolean(structures) &&
    !_overpassMissing &&
    store.getBuildings?.() !== false;
  /** Whether the source draws a coarse ring (loadCoarseChunk). */
  const coarseOn = () => typeof source.loadCoarseChunk === 'function';
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
  const setStatus = (status) => {
    const same =
      Object.keys(status).length === Object.keys(_status).length &&
      Object.keys(status).every((key) => status[key] === _status[key]);
    _status = status;
    setBlocksFloorM(
      status.state === 'ready' && status.chunks + (status.coarse || 0) > 0
        ? status.blockM
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
    for (const entry of [..._chunks.values(), ..._coarse.values()])
      if (entry.shown) {
        try {
          renderer.remove(entry.key);
        } catch (error) {
          console.warn('[Blocks] chunk not removed:', error?.message);
        }
      }
    _chunks.clear();
    _coarse.clear();
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
    // Buildings drawn: those placed in groups with a fine chunk drawn
    // with its buildings, each once; not counted at all while a drawn
    // group's buildings or ids are still coming, so two looks at the same
    // place agree.
    const ids = new Set();
    let buildingsPending = false;
    if (buildingsOn()) {
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
      chunks: shown,
      coarse,
      pending,
      failed,
      source: _region.sourceName,
      buildings: buildingsPending ? 0 : ids.size,
      buildingsPending,
      buildingsOn: buildingsOn(),
      // The study sun (the real one is under 15°): said on the line.
      sunFixed: Boolean(_region.sun?.fixed),
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
    _anchoring = call(() =>
      source.regionFor(camera.lon, camera.lat, REGION_WINDOW_M),
    ).then(
      async (found) => {
        if (stale()) return;
        const blockM = Number(found?.blockM);
        if (!(blockM > 0)) throw new Error('no block size for this region');
        const region = grid.createRegion({
          ...anchorPoint(camera, blockM),
          blockM,
        });
        // Where sea level is: the ellipsoid on flat ground, the geoid on terrain.
        const flat = Boolean(datum.flat());
        const datumOffsetM = await datumOffsetFor(region, flat, camera);
        if (stale()) return;
        _anchoring = null;
        // The sun at the region, once: mesh.js bakes it into the colours.
        const light = sun(camera.lon, camera.lat) || STUDY_SUN;
        call(() => renderer.setRegion(region, { datumOffsetM })).catch(
          (error) =>
            console.warn('[Blocks] region not set:', error?.message || error),
        );
        renderer.setSun?.(light.dir, { fixed: Boolean(light.fixed) });
        renderer.setFog?.(fogFor(radiusBlocks, blockM, coarseOn()));
        _region = {
          region,
          blockM,
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

  /**
   * Where a region is anchored: half a supergroup (supergroupGroups × 4
   * chunks × 64 columns / 2) south-west of the camera, so the camera stands
   * in the middle of a supergroup and the fine ring reaches into as few as
   * the ground allows (createRegion still snaps the point to the block
   * graticule); the camera itself without supergroupGroups.
   */
  function anchorPoint(camera, blockM) {
    const n = supergroupGroups;
    if (!(n > 0)) return { lon0: camera.lon, lat0: camera.lat };
    const halfM = (n * GROUP_CHUNKS * grid.CHUNK_COLUMNS * blockM) / 2;
    const mPerDegLat = 111_320;
    const mPerDegLon = mPerDegLat * Math.cos(camera.lat * RAD);
    return {
      lon0: camera.lon - halfM / mPerDegLon,
      lat0: camera.lat - halfM / mPerDegLat,
    };
  }

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
    const { region } = _region;
    const held = entry.coarse ? _coarse : _chunks;
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
    const at = entry.coarse
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
   *   (four fine levels to a coarse one), for where the fine ground is
   *   higher;
   * - a coarse chunk, along a border with a group drawn fine: down to the
   *   lowest fine ground there (in coarse levels), for where the coarse
   *   ground is higher. None toward other coarse chunks.
   */
  function skirtFor(entry) {
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
        skirt[name] = Math.floor(lowest / GROUP_CHUNKS);
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
      skirt[name] = lowest * GROUP_CHUNKS;
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
      // The sun's epoch too: the light is baked, so a new sun meshes again.
      signature: `${signatureOf(entry.chunk, neighbours)}|${floors}|s${_region.sunEpoch ?? 0}`,
    };
  }

  /** What buildChunkMesh (or meshAsync) is given: plain data but the chunks. */
  const meshOptions = (entry, { neighbours, skirt }) => ({
    neighbours,
    // A coarse chunk's levels are in its own unit, four blocks.
    blockM: _region.blockM * (entry.coarse ? GROUP_CHUNKS : 1),
    sunDir: _region.sun.dir,
    ...(skirt ? { skirt } : {}),
  });

  /** A mesh drawn for its entry, as meshed from `signature`. */
  function place(entry, built, signature) {
    if (entry.coarse) {
      // The renderer cannot read a 'c:' key: the group's south-west corner.
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
    const held = entry.coarse ? _coarse : _chunks;
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
  function loadStructures(entry) {
    const generation = _generation;
    const { region } = _region;
    entry.structures = 'loading';
    const stale = () =>
      generation !== _generation || _chunks.get(entry.key) !== entry;
    call(() => structures.loadChunk(region, entry.ci, entry.cj)).then(
      (levels) => {
        if (stale()) return;
        if (!buildingsOn() || !entry.chunk) {
          entry.structures = undefined;
          return;
        }
        if (levels) structures.apply(entry.chunk, levels);
        entry.structures = 'done';
        const { gi, gj } = groupOf(entry.ci, entry.cj);
        const key = `${gi}:${gj}`;
        if (structures.groupBuildings && !_groupBuildings.has(key)) {
          // null while the ids are coming: the count waits for them.
          _groupBuildings.set(key, null);
          call(() => structures.groupBuildings(region, gi, gj)).then(
            (list) => {
              if (generation !== _generation || !_groupBuildings.has(key))
                return;
              _groupBuildings.set(key, Array.isArray(list) ? list : []);
              statusNow();
            },
            () => {
              // No ids: counted as none rather than waited for.
              if (_groupBuildings.get(key) === null)
                _groupBuildings.set(key, []);
            },
          );
        }
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
   * Buildings for the fine ring, nearest first and under the budget, or,
   * with the switch off, taken off every chunk that has them.
   */
  function syncStructures(ring, perTick, time) {
    if (!structures) return;
    if (!buildingsOn()) {
      for (const entry of _chunks.values()) {
        if (entry.structures === 'done' && entry.chunk)
          clearStructures(entry.chunk);
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
    setGlobe(cannotBuild);
    // Told after the globe is set, so the overlays re-drape where it is.
    setBlocksScene({
      active: active() && !cannotBuild,
      globeHidden: _globeHidden,
    });
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
   * arrival correction owns it, 'too-high' above the ceiling (the region's
   * block size's, or NO_REGION_CEILING_M before one).
   */
  function holdFor(camera) {
    if (!camera) return null;
    if (inFlight ? inFlight() : cameraInFlight(_viewer)) return 'flying';
    const ceiling = ceilingM(_region?.blockM, radiusBlocks);
    return heightAboveGround(camera) > ceiling ? 'too-high' : null;
  }

  /** The camera's height over the ground: over the globe's surface where it answers, else the ellipsoid. */
  function heightAboveGround(camera) {
    let ground = 0;
    try {
      const at = _viewer?.camera?.positionCartographic;
      const h = at ? _viewer?.scene?.globe?.getHeight?.(at) : undefined;
      if (Number.isFinite(h)) ground = h;
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
    const camera = active() ? cameraLonLat() : null;
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
      setStatus({
        state: held,
        ceilingM: ceilingM(_region?.blockM, radiusBlocks),
      });
      // In flight: tick until it lands (a correction may end without a
      // moveEnd); too high: the next moveEnd looks again.
      if (held === 'flying' || _moving) startTicking();
      else stopTicking();
      return;
    }
    if (_anchoring) return;
    // The first region is anchored where the camera settles, not mid-move.
    if (!_region && _moving) {
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
      if (left || Boolean(datum.flat()) !== _region.flat) {
        clearAll('anchoring');
        startTicking();
      }
    }
    if (!_region) {
      anchor(camera);
      return;
    }
    const { region } = _region;
    const local = region.toLocal(camera.lon, camera.lat);
    const { i, j } = region.columnOf(local.x, local.y);
    const size = grid.CHUNK_COLUMNS;
    // Drop what fell behind: fine chunks a group at a time.
    const at = { x: i + 0.5, y: j + 0.5 };
    const groupSize = size * GROUP_CHUNKS;
    const far = radiusBlocks * REMOVE_FACTOR;
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
    const ring = fineRing({ i, j, radius: radiusBlocks, chunkColumns: size });
    const groups = coarseOn()
      ? groupRing({
          i,
          j,
          radius: radiusBlocks * COARSE_REACH,
          chunkColumns: size,
        }).filter(
          ({ gi, gj }) =>
            !supergroupInside(at, gi, gj, groupSize, radiusBlocks),
        )
      : [];
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
    statusNow();
    if (changed) requestRender('blocks-chunks');
    // Keep ticking while moving or while work remains; stop when settled.
    if (_moving || hasWork(ring, groups)) startTicking();
    else stopTicking();
  }

  /**
   * Whether a load is in flight, a chunk in range is unloaded or waits for
   * a retry, a mesh is stale, or a coarse chunk is shown when it should not
   * be, or the other way round.
   */
  function hasWork(ring, groups = []) {
    for (const entry of [..._chunks.values(), ..._coarse.values()])
      if (entry.loading || entry.meshing) return true;
    // Not asked yet, or a retry still to come.
    const waiting = (entry) =>
      !entry || (entry.failed && entry.retryAt !== Infinity);
    const wantBuildings = buildingsOn();
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
    return false;
  }

  const statusOff = () =>
    !_destroyed && store.getMode() === 'blocks' ? 'no-elevation' : 'off';

  function attach(viewerNow) {
    _viewer = viewerNow || _viewer;
    const camera = _viewer?.camera;
    if (!camera) return;
    if (camera.moveStart)
      _removers.push(
        camera.moveStart.addEventListener(() => {
          _moving = true;
          if (active()) startTicking();
        }),
      );
    if (camera.moveEnd)
      _removers.push(
        camera.moveEnd.addEventListener(() => {
          _moving = false;
          tick();
        }),
      );
  }

  _removers.push(store.subscribe(() => tick()));
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
