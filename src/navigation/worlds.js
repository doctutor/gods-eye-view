/**
 * Personal fork: the worlds the movement model walks in (movement.js):
 * the Blocks store's occupancy under Blocks (src/layers/blocks/store.js),
 * else a heightfield sampled from the trusted surface (src/surfaceTrust.js,
 * through the binding), cached by cell. Pure; no Cesium.
 */
import { MATERIALS, NONE, isSolid } from '../layers/blocks/store.js';
import { CHUNK_COLUMNS } from '../layers/blocks/grid.js';

const EPS = 1e-6;
/** The most levels scanned down a column for a surface. */
const MAX_SCAN_LEVELS = 4096;

/**
 * A world of blocks: `region` (src/layers/blocks/grid.js) and `chunkAt(ci,
 * cj)` the loaded chunk or null. x, y are the region's metres; z is metres
 * above mean sea level (level × blockM). An unloaded chunk is unknown.
 */
export function createBlockWorld({ region, chunkAt }) {
  const blockM = region.blockM;
  const cellOf = (x, y) => {
    const i = Math.floor(x / blockM);
    const j = Math.floor(y / blockM);
    const ci = Math.floor(i / CHUNK_COLUMNS);
    const cj = Math.floor(j / CHUNK_COLUMNS);
    const chunk = chunkAt(ci, cj) || null;
    return {
      chunk,
      i,
      j,
      li: i - ci * CHUNK_COLUMNS,
      lj: j - cj * CHUNK_COLUMNS,
    };
  };
  const levelOf = (z) => Math.floor(z / blockM);

  /** What occupies a block (region column i, j and level), null if unknown. */
  const occupancy = (i, j, level) => {
    const ci = Math.floor(i / CHUNK_COLUMNS);
    const cj = Math.floor(j / CHUNK_COLUMNS);
    const chunk = chunkAt(ci, cj);
    if (!chunk) return null;
    return chunk.occupancy(
      i - ci * CHUNK_COLUMNS,
      j - cj * CHUNK_COLUMNS,
      level,
    );
  };

  return {
    kind: 'blocks',
    region,
    blockM,
    stepUpM: blockM,
    occupancy,
    surfaceBelow(x, y, z) {
      const { chunk, li, lj } = cellOf(x, y);
      if (!chunk) return Number.NaN;
      const top = chunk.topSolid(li, lj);
      if (top === NONE) return Number.NaN;
      const level = levelOf(z);
      // Nothing solid above the column's top: the top is the surface.
      if (top < level) return (top + 1) * blockM;
      for (let y = level; y > level - MAX_SCAN_LEVELS; y -= 1)
        if (isSolid(chunk.occupancy(li, lj, y))) return (y + 1) * blockM;
      return Number.NaN;
    },
    blocked(x, y, z0, z1) {
      const { chunk, li, lj } = cellOf(x, y);
      if (!chunk || !(z1 > z0)) return false;
      const last = Math.floor((z1 - EPS) / blockM);
      for (let level = Math.floor(z0 / blockM); level <= last; level += 1)
        if (isSolid(chunk.occupancy(li, lj, level))) return true;
      return false;
    },
    waterAt(x, y, z) {
      const { chunk, li, lj } = cellOf(x, y);
      return (
        chunk !== null &&
        chunk.occupancy(li, lj, levelOf(z)) === MATERIALS.WATER
      );
    },
    /**
     * The first solid block along a ray (region metres, z above mean sea
     * level) within `maxM`: its column, level and the face the ray came in
     * through; null when none (or the ray leaves the loaded chunks).
     */
    raycast(origin, direction, maxM = 64 * blockM) {
      return raycastBlocks(occupancy, blockM, origin, direction, maxM);
    },
  };
}

/**
 * Amanatides–Woo traversal of the block grid from `origin` along
 * `direction` to the first solid block within `maxM`.
 */
export function raycastBlocks(occupancy, blockM, origin, direction, maxM) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return null;
  const d = [direction.x / length, direction.y / length, direction.z / length];
  const p = [origin.x / blockM, origin.y / blockM, origin.z / blockM];
  const cell = p.map(Math.floor);
  const stepOf = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tDelta = d.map((v) => (v ? Math.abs(1 / v) : Infinity));
  const tMax = d.map((v, k) =>
    v > 0 ? (cell[k] + 1 - p[k]) / v : v < 0 ? (p[k] - cell[k]) / -v : Infinity,
  );
  const maxT = maxM / blockM;
  let face = null;
  for (let t = 0; t <= maxT;) {
    const material = occupancy(cell[0], cell[1], cell[2]);
    if (material === null) return null;
    if (isSolid(material))
      return {
        i: cell[0],
        j: cell[1],
        y: cell[2],
        face,
        distanceM: t * blockM,
      };
    const axis =
      tMax[0] < tMax[1]
        ? tMax[0] < tMax[2]
          ? 0
          : 2
        : tMax[1] < tMax[2]
          ? 1
          : 2;
    t = tMax[axis];
    cell[axis] += stepOf[axis];
    tMax[axis] += tDelta[axis];
    face = [0, 0, 0];
    face[axis] = -stepOf[axis];
  }
  return null;
}

/**
 * A heightfield world over a surface sampler: `sample(x, y)` → the surface
 * height there (the camera's vertical datum) or NaN, asked once per cell of
 * `cellM` and kept `ttlMs` (the tiles under a walker refine as it goes).
 * There is no water off the Blocks.
 */
export function createHeightfieldWorld({
  sample,
  cellM = 0.5,
  ttlMs = 1000,
  now = () => Date.now(),
  stepUpM,
  maxCells = 4096,
}) {
  const cache = new Map();
  const surfaceAt = (x, y) => {
    const ci = Math.floor(x / cellM);
    const cj = Math.floor(y / cellM);
    const key = `${ci}:${cj}`;
    const t = now();
    const held = cache.get(key);
    if (held && t - held.at < ttlMs && Number.isFinite(held.heightM))
      return held.heightM;
    // A miss is asked again sooner: the tiles may be arriving.
    if (held && t - held.at < Math.min(ttlMs, 250)) return held.heightM;
    let heightM;
    try {
      heightM = Number(sample((ci + 0.5) * cellM, (cj + 0.5) * cellM));
    } catch {
      heightM = Number.NaN;
    }
    if (cache.size >= maxCells) cache.clear();
    cache.set(key, { heightM, at: t });
    return heightM;
  };
  return {
    kind: 'surface',
    ...(stepUpM === undefined ? {} : { stepUpM }),
    surfaceAt,
    surfaceBelow: (x, y) => surfaceAt(x, y),
    blocked(x, y, z0) {
      const heightM = surfaceAt(x, y);
      return Number.isFinite(heightM) && heightM > z0 + EPS;
    },
    waterAt: () => false,
    /** Forget the samples (the camera jumped somewhere else). */
    clear: () => cache.clear(),
  };
}
