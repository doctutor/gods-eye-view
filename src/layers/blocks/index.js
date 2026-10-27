// Personal fork: the Blocks controller (docs/BLOCKS-PLAN.md). With "Render:
// Blocks" picked beside the ANALYSIS heading and the Elevation layer on, the
// ground around the camera is streamed as chunks of cubes on a grid anchored
// to the world: a region (grid.js) is anchored at the camera with the
// elevation source's block size (source.regionFor), the chunks within the
// render distance are loaded (source.loadChunk), meshed with their
// neighbours (mesh.js buildChunkMesh) and handed to the renderer
// (renderer.js), nearest the camera's column first and a few per tick;
// chunks that fall far behind are dropped. The modules it drives are passed
// in (src/app/blocks.js wires the real ones), so this file stays pure enough
// to test on fakes. Not part of upstream God's Eye View.

import { ELEVATION_LAYER_ID } from '../lego/layerSpecs.js';
import { setBlocksFloorM, setBlocksScene } from './floor.js';

/** The render distance, in blocks (512 m at 1 m, 15 km at 30 m). */
export const RENDER_DISTANCE_BLOCKS = 512;
/** Chunks beyond this many times the render distance are removed. */
export const REMOVE_FACTOR = 1.25;
/**
 * Chunks loaded (in flight) and meshed per tick, at most: the mesher takes
 * 10 to 65 ms a chunk warm, so 8 is about half a tick at 1 m.
 */
export const CHUNK_BUDGET = 8;
/** From this block size the budget doubles (tickBudget). */
export const COARSE_BLOCK_M = 30;
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
 *   source: {regionFor: Function, loadChunk: Function},
 *   renderer: {setRegion: Function, upsert: Function, remove: Function,
 *     setSun?: Function, setFog?: Function, destroy?: Function},
 *   grid: {createRegion: Function, chunkKey: Function, CHUNK_COLUMNS: number},
 *   buildChunkMesh: Function,
 *   sun?: (lon: number, lat: number) => {dir: {east: number, north: number,
 *     up: number}, fixed: boolean},
 *   flatStyle?: () => boolean, whether the map is a drawn style (blank,
 *     Positron, dark, Countries), where Blocks hides the globe,
 *   datum?: {flat: () => boolean, undulation: (lat: number, lon: number)
 *     => number|Promise<number>, subscribe?: Function},
 *   radiusBlocks?: number, budget?: number, tickMs?: number,
 *   requestRender?: Function,
 *   setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval,
 * }} options
 */
export function createBlocksController({
  viewer = null,
  store,
  layers,
  source,
  renderer,
  grid,
  buildChunkMesh,
  sun = () => STUDY_SUN,
  datum = FLAT_DATUM,
  flatStyle = () => false,
  radiusBlocks = RENDER_DISTANCE_BLOCKS,
  budget = CHUNK_BUDGET,
  tickMs = TICK_MS,
  requestRender = () => {},
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
}) {
  let _viewer = viewer;
  let _region = null; // {region, blockM, sourceName, sun}
  let _anchoring = null; // the regionFor promise in flight
  let _generation = 0;
  let _interval = null;
  let _moving = false;
  let _destroyed = false;
  let _status = { state: 'off' };
  let _globeHidden = false;
  let _globeBefore = true;
  /** key → {key, ci, cj, chunk, loading, failed, signature, shown} */
  const _chunks = new Map();
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
      status.state === 'ready' && status.chunks > 0 ? status.blockM : null,
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

  /** Every chunk off the renderer and forgotten; the region too. */
  function clearAll(state) {
    _generation++;
    _anchoring = null;
    for (const entry of _chunks.values())
      if (entry.shown) {
        try {
          renderer.remove(entry.key);
        } catch (error) {
          console.warn('[Blocks] chunk not removed:', error?.message);
        }
      }
    _chunks.clear();
    _region = null;
    stopTicking();
    setStatus({ state });
    requestRender('blocks-clear');
  }

  function statusNow() {
    if (!_region) return;
    let shown = 0;
    let failed = 0;
    let pending = 0;
    for (const entry of _chunks.values()) {
      if (entry.shown) shown++;
      else if (entry.failed) failed++;
      else pending++;
    }
    setStatus({
      state: pending ? 'loading' : shown || !failed ? 'ready' : 'failed',
      blockM: _region.blockM,
      chunks: shown,
      pending,
      failed,
      source: _region.sourceName,
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
          lon0: camera.lon,
          lat0: camera.lat,
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
        renderer.setFog?.({
          startM: radiusBlocks * blockM * 0.6,
          endM: radiusBlocks * blockM,
        });
        _region = {
          region,
          blockM,
          sourceName: sourceName(found.source),
          sun: light,
          flat,
          datumOffsetM,
        };
        tick();
      },
      (error) => fail(error, [404, 501, 503].includes(Number(error?.status))),
    );
    _anchoring.catch((error) => fail(error));
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
    entry.loading = call(() =>
      source.loadChunk(region, entry.ci, entry.cj),
    ).then(
      (chunk) => {
        if (generation !== _generation || _chunks.get(entry.key) !== entry)
          return;
        entry.loading = null;
        entry.chunk = chunk;
      },
      (error) => {
        if (generation !== _generation || _chunks.get(entry.key) !== entry)
          return;
        entry.loading = null;
        entry.failed = true;
        console.warn(
          `[Blocks] chunk ${entry.key} not loaded:`,
          error?.message || error,
        );
      },
    );
  }

  /** What a chunk's mesh depends on: its version and its neighbours'. */
  /**
   * The loaded chunks around one: the four it shares a side with (their
   * border faces) and the four diagonals (ambient occlusion at its
   * corners). mesh.js reads a missing one as the edge column repeated (no
   * wall), so a chunk is meshed again when any of the eight arrives.
   */
  function neighboursOf(entry) {
    const at = (ci, cj) => _chunks.get(grid.chunkKey(ci, cj))?.chunk || null;
    const out = {};
    for (const [name, di, dj] of NEIGHBOURS) {
      const chunk = at(entry.ci + di, entry.cj + dj);
      if (chunk) out[name] = chunk;
    }
    return out;
  }
  const signatureOf = (chunk, neighbours) =>
    [chunk, ...NEIGHBOURS.map(([name]) => neighbours[name])]
      .map((c) => (c ? String(c.version ?? 0) : '-'))
      .join('|');

  function mesh(entry, neighbours, signature) {
    const built = buildChunkMesh(entry.chunk, {
      neighbours,
      blockM: _region.blockM,
      sunDir: _region.sun.dir,
    });
    renderer.upsert(entry.key, built);
    entry.signature = signature;
    entry.shown = true;
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
  function applyGlobe() {
    setGlobe();
    // Told after the globe is set, so the overlays re-drape where it is.
    setBlocksScene({ active: active(), globeHidden: _globeHidden });
  }

  function setGlobe() {
    const globe = _viewer?.scene?.globe;
    if (!globe) return;
    const drawn = Boolean(flatStyle());
    if (active() && drawn) {
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

  function tick() {
    applyGlobe();
    if (!active()) {
      if (_region || _anchoring || _chunks.size) clearAll(statusOff());
      else setStatus({ state: statusOff() });
      return;
    }
    const camera = cameraLonLat();
    if (!camera) return;
    if (_anchoring) return;
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
    // Drop what fell behind.
    const far = radiusBlocks * REMOVE_FACTOR;
    let changed = false;
    for (const entry of [..._chunks.values()]) {
      if (
        chunkDistance({ x: i + 0.5, y: j + 0.5 }, entry.ci, entry.cj, size) <=
        far
      )
        continue;
      if (entry.shown) {
        renderer.remove(entry.key);
        changed = true;
      }
      _chunks.delete(entry.key);
    }
    // Start loads, nearest first, while fewer than `budget` are in flight.
    const ring = chunkRing({ i, j, radius: radiusBlocks, chunkColumns: size });
    const perTick = tickBudget(budget, _region.blockM);
    let inFlight = 0;
    for (const entry of _chunks.values()) if (entry.loading) inFlight++;
    for (const { ci, cj } of ring) {
      if (inFlight >= perTick) break;
      const key = grid.chunkKey(ci, cj);
      if (_chunks.has(key)) continue;
      const entry = {
        key,
        ci,
        cj,
        chunk: null,
        loading: null,
        failed: false,
        signature: '',
        shown: false,
      };
      _chunks.set(key, entry);
      load(entry);
      inFlight++;
    }
    // Mesh what arrived or changed (its version, or a neighbour's), nearest first.
    let meshed = 0;
    for (const { ci, cj } of ring) {
      if (meshed >= perTick) break;
      const entry = _chunks.get(grid.chunkKey(ci, cj));
      if (!entry?.chunk) continue;
      const neighbours = neighboursOf(entry);
      const signature = signatureOf(entry.chunk, neighbours);
      if (entry.shown && entry.signature === signature) continue;
      try {
        mesh(entry, neighbours, signature);
      } catch (error) {
        entry.failed = true;
        entry.chunk = null;
        console.warn(
          `[Blocks] chunk ${entry.key} not meshed:`,
          error?.message || error,
        );
      }
      meshed++;
      changed = true;
    }
    statusNow();
    if (changed) requestRender('blocks-chunks');
    // Keep ticking while moving or while work remains; stop when settled.
    if (_moving || hasWork(ring)) startTicking();
    else stopTicking();
  }

  /** Whether a load is in flight, a chunk in range is unloaded, or a mesh is stale. */
  function hasWork(ring) {
    for (const entry of _chunks.values()) if (entry.loading) return true;
    for (const { ci, cj } of ring) {
      const entry = _chunks.get(grid.chunkKey(ci, cj));
      if (!entry) return true;
      if (!entry.chunk) continue;
      if (
        !entry.shown ||
        entry.signature !== signatureOf(entry.chunk, neighboursOf(entry))
      )
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
    getStatus: () => _status,
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    /** For tests and the harness. */
    _state: () => ({
      region: _region,
      chunks: _chunks,
      ticking: _interval !== null,
      moving: _moving,
    }),
    destroy() {
      if (_destroyed) return;
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
