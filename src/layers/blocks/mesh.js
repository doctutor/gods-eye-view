/**
 * Personal fork: the Blocks chunk mesher (docs/BLOCKS-PLAN.md, "Mesh").
 *
 * Culled faces: a face is emitted where a solid block meets air or water,
 * and a water face where water meets air. Greedy merging then joins faces
 * of one direction, one plane, one material and one ambient occlusion into
 * rectangles. Each vertex's colour is the material's colour × the face's
 * shade × its ambient occlusion × the sun term, baked (lighting.js); water
 * keeps its alpha, and its faces come after the opaque ones in the index
 * buffer (`opaqueIndexCount`), so the renderer can draw them in the
 * translucent pass. Positions are east-north-up metres from the chunk's
 * south-west corner at mean sea level: x, y = column × blockM, z = level ×
 * levelM (a cube at native cells; flatter at coarse ones).
 *
 * Neighbour chunks (n, s, e, w, and the diagonals ne, nw, se, sw for
 * ambient occlusion at the corners) cull faces across the chunk's borders;
 * a missing neighbour reads as the edge column repeated, so an open edge
 * has no wall, and the chunk is meshed again when the neighbour arrives.
 * Personal fork: unless a skirt is asked for along that border (`skirt`):
 * then the edge columns' sides run down from their tops to a floor, so a
 * fine ring's edge meets a coarser ring behind it without a seam.
 */
import { CHUNK_COLUMNS, columnIndex, createRegion } from './grid.js';
import { MATERIALS, NONE, isSolid } from './store.js';
import {
  AO,
  FACE_SHADE,
  STUDY_SUN_DIR,
  litColor,
  sunTerm,
} from './lighting.js';

const N = CHUNK_COLUMNS;

/**
 * The six directions: the outward normal, the axis it lies along (0 east,
 * 1 north, 2 up) and the face's (u, v) axes, ordered so u × v is the
 * normal (counter-clockwise seen from outside).
 */
export const DIRECTIONS = Object.freeze(
  [
    { name: 'up', normal: [0, 0, 1], axis: 2, u: 0, v: 1 },
    { name: 'down', normal: [0, 0, -1], axis: 2, u: 1, v: 0 },
    { name: 'east', normal: [1, 0, 0], axis: 0, u: 1, v: 2 },
    { name: 'west', normal: [-1, 0, 0], axis: 0, u: 2, v: 1 },
    { name: 'north', normal: [0, 1, 0], axis: 1, u: 2, v: 0 },
    { name: 'south', normal: [0, -1, 0], axis: 1, u: 0, v: 2 },
  ].map((d) => Object.freeze(d)),
);

/** The (u, v) signs of a face's corners, in quad order. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Where a column of the meshed chunk's surroundings lives: the chunk (self
 * or a neighbour) and its local column. A missing side neighbour repeats
 * the edge column; a missing diagonal takes the side neighbour that is
 * there, else the edge column.
 */
function makeLocator(chunk, neighbours = {}) {
  const table = {
    '0,0': chunk,
    '0,1': neighbours.n,
    '0,-1': neighbours.s,
    '1,0': neighbours.e,
    '-1,0': neighbours.w,
    '1,1': neighbours.ne,
    '-1,1': neighbours.nw,
    '1,-1': neighbours.se,
    '-1,-1': neighbours.sw,
  };
  const clampColumn = (k) => Math.max(0, Math.min(N - 1, k));
  return (i, j) => {
    let dx = i < 0 ? -1 : i >= N ? 1 : 0;
    let dy = j < 0 ? -1 : j >= N ? 1 : 0;
    let owner = table[`${dx},${dy}`];
    if (!owner && dx && dy) {
      if (table[`0,${dy}`]) dx = 0;
      else if (table[`${dx},0`]) dy = 0;
      else dx = dy = 0;
      owner = table[`${dx},${dy}`];
    } else if (!owner) {
      dx = dy = 0;
      owner = chunk;
    }
    return {
      owner,
      li: dx ? i - dx * N : clampColumn(i),
      lj: dy ? j - dy * N : clampColumn(j),
    };
  };
}

/** Columns of the meshed surroundings a side: the chunk and one beyond. */
const SPAN = N + 2;

/** Whether each material id is solid, for the inner loops. */
const SOLID = Uint8Array.from({ length: 256 }, (_, m) => (isSolid(m) ? 1 : 0));

/**
 * The surroundings' occupancy, dense: one byte per block for the chunk's
 * columns and the ring around them, over the levels that can hold a face
 * (and their occlusion), each column's levels contiguous; with each
 * column's lowest open level (`low`) and highest filled one (`up`). Null
 * when no column holds anything.
 */
function occupancyVolume(chunk, neighbours) {
  const locate = makeLocator(chunk, neighbours);
  const count = SPAN * SPAN;
  const tops = new Float64Array(count);
  const waters = new Float64Array(count);
  const materials = new Uint8Array(count);
  // The structures layer (store.js): a top and material per column.
  const structureTops = new Float64Array(count);
  const structureBottoms = new Float64Array(count);
  const structureMaterials = new Uint8Array(count);
  const low = new Float64Array(count);
  const up = new Float64Array(count);
  const edits = new Array(count);
  let floor = Infinity;
  let high = -Infinity;
  for (let j = -1, k = 0; j <= N; j += 1)
    for (let i = -1; i <= N; i += 1, k += 1) {
      const { owner, li, lj } = locate(i, j);
      const index = columnIndex(li, lj);
      const top = owner.top[index];
      const water = owner.water[index];
      const structure = owner.structure;
      const structureTop = structure ? structure.top[index] : NONE;
      const columnEdits = owner.columnEdits(li, lj);
      // The lowest level this column may be open at (its top, or an edit
      // below it), and the highest that holds anything.
      let lowest = top === NONE ? Infinity : top;
      let highest = top === NONE ? -Infinity : top;
      if (water !== NONE) highest = Math.max(highest, water);
      if (structureTop !== NONE) highest = Math.max(highest, structureTop);
      for (const [y] of columnEdits) {
        lowest = Math.min(lowest, y);
        highest = Math.max(highest, y);
      }
      tops[k] = top === NONE ? -Infinity : top;
      waters[k] = water === NONE ? -Infinity : water;
      materials[k] = owner.material[index];
      structureTops[k] = structureTop === NONE ? -Infinity : structureTop;
      structureBottoms[k] =
        structure && structure.bottom ? structure.bottom[index] : -Infinity;
      structureMaterials[k] = structure ? structure.material[index] : 0;
      low[k] = lowest;
      up[k] = highest;
      edits[k] = columnEdits;
      floor = Math.min(floor, lowest);
      high = Math.max(high, highest);
    }
  if (floor === Infinity) return null;
  // A column without data opens down to the lowest ground around it.
  for (let k = 0; k < count; k += 1) if (low[k] === Infinity) low[k] = floor;
  const yMin = floor - 2;
  const levels = high + 2 - yMin + 1;
  const cells = new Uint8Array(count * levels);
  for (let k = 0; k < count; k += 1) {
    const start = k * levels;
    const solidTo = Math.min(levels, Math.max(0, tops[k] - yMin + 1));
    const waterTo = Math.min(levels, Math.max(0, waters[k] - yMin + 1));
    cells.fill(materials[k], start, start + solidTo);
    if (waterTo > solidTo)
      cells.fill(MATERIALS.WATER, start + solidTo, start + waterTo);
    // A structure stands from its bottom (by default on the top) to its
    // top, over any water; a higher bottom leaves a hollow under it.
    const structureTo = Math.min(
      levels,
      Math.max(0, structureTops[k] - yMin + 1),
    );
    const structureFrom = Math.max(
      solidTo,
      Math.min(levels, structureBottoms[k] - yMin),
    );
    if (structureTo > structureFrom)
      cells.fill(
        structureMaterials[k],
        start + structureFrom,
        start + structureTo,
      );
    for (const [y, value] of edits[k])
      if (y - yMin >= 0 && y - yMin < levels) cells[start + y - yMin] = value;
  }
  return { cells, yMin, levels, low, up };
}

/** Which way each direction's stats count. */
const STAT_NAMES = DIRECTIONS.map((d) => d.name);

/**
 * The borders a skirt can hang from: the `skirt` key, the neighbour it
 * stands in for, the direction its faces look, and which edge columns.
 */
const SKIRT_BORDERS = Object.freeze([
  { key: 'e', dirIndex: 2, column: (k) => [N - 1, k] },
  { key: 'w', dirIndex: 3, column: (k) => [0, k] },
  { key: 'n', dirIndex: 4, column: (k) => [k, N - 1] },
  { key: 's', dirIndex: 5, column: (k) => [k, 0] },
]);
/** The deepest a skirt hangs below an edge column's top, in levels. */
const MAX_SKIRT_LEVELS = 4096;

/** The Earth's mean radius, for the curved greedy cap. */
const EARTH_RADIUS_M = 6_371_000;
/** A curved level's intended footprint: a cell this many pixels wide. */
export const CURVED_CELL_PX = 8;

/**
 * The most cells a merged face runs along the ground on a curved level:
 * a run of n cells is a chord of L = n·cell that sags L²/8R under the
 * ground it spans, kept under one pixel at the level's footprint (a cell
 * CURVED_CELL_PX pixels wide, so a pixel is cell / CURVED_CELL_PX):
 * n ≤ √(8R / (CURVED_CELL_PX · cell)). 57 at 1,920 m, 28 at 7,680 m, 14 at
 * 30,720 m.
 */
export const curvedRunCap = (cellM) =>
  Math.max(
    1,
    Math.floor(
      Math.sqrt((8 * EARTH_RADIUS_M) / (CURVED_CELL_PX * Math.max(1, cellM))),
    ),
  );

/**
 * A flat chunk's vertices dropped onto the curve, each by its own place:
 * the renderer lowers the chunk by its south-west corner's drop
 * (grid.js chunkOrigin z), so each vertex goes down by the rest,
 * dropAt(its place) − dropAt(the corner). Dropped by the corner alone a
 * chunk was a flat slab, a step lower than its neighbour nearer the
 * region's origin: 1.2 km at 480 m blocks half a supergroup (245 km) out,
 * a crack through the view along every chunk seam (Lake Tahoe at 70 km,
 * 2026-10-30). `flatDrop`: the region ({lon0, lat0, regionBlockM}) and the
 * chunk's corner in its metres (`cornerM`).
 * @returns {(positions: Float32Array, vertex: number) => void}
 */
function flatDropping({ lon0, lat0, regionBlockM, cornerM }) {
  const region = curvedRegion({ lon0, lat0, regionBlockM });
  const cornerX = Number(cornerM?.x) || 0;
  const cornerY = Number(cornerM?.y) || 0;
  const base = region.dropAt(cornerX, cornerY);
  return (positions, vertex) => {
    const k = vertex * 3;
    positions[k + 2] +=
      region.dropAt(cornerX + positions[k], cornerY + positions[k + 1]) - base;
  };
}

/** The regions the curved placement has built, by origin and block size. */
const curvedRegions = new Map();
function curvedRegion({ lon0, lat0, regionBlockM }) {
  const key = `${lon0},${lat0},${regionBlockM}`;
  let region = curvedRegions.get(key);
  if (!region) {
    if (curvedRegions.size > 32) curvedRegions.clear();
    // Always the azimuthal map, whatever the block (the tileset build
    // places its 480 m levels this way too).
    region = createRegion({ lon0, lat0, blockM: regionBlockM, curved: true });
    curvedRegions.set(key, region);
  }
  return region;
}

/**
 * The curved placement (docs/BLOCKS-PLAN.md milestone 5, decision 5): a
 * chunk-local block point (columns east and north, levels up) stood on
 * the ellipsoid. Its column corner goes through the region to lon/lat
 * (`cornerM`: the chunk's south-west corner in region metres), its height
 * is the datum plus its levels; the point is then written in the
 * renderer's frame (the region's east-north-up at the datum), less the
 * chunk's own origin, which the mesh carries as `origin`. A face's normal
 * turns to its corner's own east, north or up.
 */
function curvedPlacement(curved, scale) {
  const region = curvedRegion(curved);
  const datumM = Number(curved.datumM) || 0;
  const cornerX = Number(curved.cornerM?.x) || 0;
  const cornerY = Number(curved.cornerM?.y) || 0;
  // Each column corner once: its place's ground on the ellipsoid and its
  // own east, north and up in the region's axes. A point h over the
  // ellipsoid there is the ground plus h along its up (the region's frame
  // is linear in the Earth-fixed one), so a vertex costs no trigonometry.
  const columns = new Map();
  const column = (bx, by) => {
    // Corners run −1 … CHUNK_COLUMNS + 1 (halves at faces' centres).
    const key = bx * 4096 + by;
    let held = columns.get(key);
    if (!held) {
      const place = region.toLonLat(
        cornerX + bx * scale[0],
        cornerY + by * scale[1],
      );
      held = {
        ground: region.localPoint(place.lon, place.lat, 0),
        basis: region.basisAt(place.lon, place.lat),
      };
      columns.set(key, held);
    }
    return held;
  };
  const frameAt = (bx, by, bz) => {
    const { ground, basis } = column(bx, by);
    const h = datumM + bz * scale[2];
    const up = basis.up;
    return [
      ground.x + h * up[0],
      ground.y + h * up[1],
      ground.z + h * up[2] - datumM,
    ];
  };
  const origin = frameAt(0, 0, 0);
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    /** A block point's position, relative to the chunk's origin. */
    position(bx, by, bz) {
      const p = frameAt(bx, by, bz);
      return [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    },
    /**
     * A direction's normal at a column corner: its own east, north or up
     * (the directions are the axes), reversed for west, south and down.
     */
    normal(d, bx, by) {
      const held = column(bx, by);
      const axis = [held.basis.east, held.basis.north, held.basis.up][d.axis];
      if (d.normal[d.axis] > 0) return axis;
      held.reversed ||= [];
      return (held.reversed[d.axis] ||= [-axis[0], -axis[1], -axis[2]]);
    },
  };
}

/**
 * Mesh a chunk. `blockM` scales columns to metres east and north,
 * `levelM` (`blockM` unless given) levels to metres up; `sunDir` is the
 * unit vector to the sun, {east, north, up} in the region's frame (the
 * study sun when not given);
 * `greedy: false` keeps one quad per block face (for counting faces).
 * `fan: false` draws a quad whose corners are shaded unevenly as two
 * triangles too, split along the diagonal between its two brighter corners
 * (the usual voxel rule), rather than four around a centre at the corners'
 * mean: a quarter fewer vertices and half the triangles of such a quad, for
 * levels seen from far off (the tileset at 480 m and up); the fan stays the
 * default. `runCap` replaces curvedRunCap's longest run on a curved level.
 * `skirt: {n, s, e, w}`, each a floor level or null: along a border whose
 * neighbour is absent, every solid block of each edge column from its top
 * down to and including the floor level gets a side face (shaded as a
 * side, without ambient occlusion), merged like the other sides; nothing
 * below the floor. A border with its neighbour present ignores it.
 * `stats` counts block faces by direction (and water, and the skirts'
 * share in `skirt`), before merging.
 * @returns {{positions: Float32Array, normals: Float32Array,
 *   colors: Uint8Array, blockCoords: Float32Array, indices: Uint32Array,
 *   faces: number, opaqueIndexCount: number, stats: Object<string, number>}}
 *   `blockCoords`: each vertex's block point, three floats a vertex in the
 *   order of `positions` — (i, j, level): columns east and north from the
 *   chunk's south-west corner (0 … CHUNK_COLUMNS), and the level from mean
 *   sea level; whole numbers at a face's corners, halves at a shaded
 *   face's centre. The block lattice, flat or curved: the renderer's
 *   edges and dither read it where a curved chunk's positions are off the
 *   lattice by hundreds of kilometres.
 */
export function buildChunkMesh(
  chunk,
  {
    neighbours = {},
    blockM = 1,
    levelM = blockM,
    sunDir = STUDY_SUN_DIR,
    greedy = true,
    skirt = null,
    curved = null,
    flatDrop = null,
    fan = true,
    runCap: runCapGiven = null,
  } = {},
) {
  const counts = new Float64Array(8);
  const volume = occupancyVolume(chunk, neighbours);
  // Metres per block unit along east, north and up.
  const scale = [blockM, blockM, levelM];
  if (!volume)
    return writeQuads([], [], {
      scale,
      sunDir,
      counts,
      curved,
      flatDrop,
      fan,
    });
  const { cells, yMin, levels, low, up } = volume;
  // Index strides along east, north and up in the volume.
  const strides = [levels, SPAN * levels, 1];
  const steps = DIRECTIONS.map((d) => ({
    normal:
      d.normal[0] * strides[0] +
      d.normal[1] * strides[1] +
      d.normal[2] * strides[2],
  }));
  // Each direction's corner offsets in the layer a face looks into: the
  // two sides of corner c at [8·dir + 2c], [8·dir + 2c + 1].
  const cornerSteps = new Int32Array(48);
  DIRECTIONS.forEach((d, dirIndex) =>
    CORNERS.forEach(([su, sv], c) => {
      cornerSteps[dirIndex * 8 + c * 2] = su * strides[d.u];
      cornerSteps[dirIndex * 8 + c * 2 + 1] = sv * strides[d.v];
    }),
  );

  // Faces by direction, then plane (the level for up and down, the column
  // for the sides): [u, v, key] triples.
  const planes = DIRECTIONS.map(() => []);
  const planeOffset = DIRECTIONS.map((d) => (d.axis === 2 ? -yMin : 1));
  const p = [0, 0, 0];
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const k = (j + 1) * SPAN + (i + 1);
      if (up[k] === -Infinity) continue;
      // Below every neighbour's lowest open level, nothing is exposed.
      const start = Math.min(
        low[k],
        low[k - 1],
        low[k + 1],
        low[k - SPAN],
        low[k + SPAN],
      );
      p[0] = i;
      p[1] = j;
      for (let y = start; y <= up[k]; y += 1) {
        const index = k * levels + (y - yMin);
        const material = cells[index];
        if (material === MATERIALS.AIR) continue;
        const isWater = material === MATERIALS.WATER;
        p[2] = y;
        for (let dirIndex = 0; dirIndex < 6; dirIndex += 1) {
          const step = steps[dirIndex];
          const q = index + step.normal;
          const beyond = cells[q];
          if (isWater ? beyond !== MATERIALS.AIR : SOLID[beyond] === 1)
            continue;
          // Ambient occlusion: the blocks around each corner, in the layer
          // the face looks into. Water faces are not occluded.
          let key = material << 8;
          if (!isWater)
            for (let c = 0; c < 4; c += 1) {
              const su = cornerSteps[dirIndex * 8 + c * 2];
              const sv = cornerSteps[dirIndex * 8 + c * 2 + 1];
              const side1 = SOLID[cells[q + su]];
              const side2 = SOLID[cells[q + sv]];
              const count =
                side1 & side2 ? 3 : side1 + side2 + SOLID[cells[q + su + sv]];
              key |= count << (6 - 2 * c);
            }
          const d = DIRECTIONS[dirIndex];
          const slot = p[d.axis] + planeOffset[dirIndex];
          const plane = (planes[dirIndex][slot] ??= []);
          plane.push(p[d.u], p[d.v], key);
          counts[isWater ? 6 : dirIndex] += 1;
        }
      }
    }

  // Skirts: where a border's neighbour is absent (so its edge columns'
  // sides were culled against themselves), those sides down to the floor.
  for (const border of SKIRT_BORDERS) {
    const floor = skirt?.[border.key];
    if (!Number.isInteger(floor) || neighbours[border.key]) continue;
    const d = DIRECTIONS[border.dirIndex];
    for (let k = 0; k < N; k += 1) {
      const [i, j] = border.column(k);
      const top = chunk.topSolid(i, j);
      if (top === NONE || top < floor) continue;
      const bottom = Math.max(floor, top - MAX_SKIRT_LEVELS);
      p[0] = i;
      p[1] = j;
      for (let y = bottom; y <= top; y += 1) {
        const material = chunk.occupancy(i, j, y);
        if (!isSolid(material)) continue;
        p[2] = y;
        const slot = p[d.axis] + planeOffset[border.dirIndex];
        const plane = (planes[border.dirIndex][slot] ??= []);
        // No ambient occlusion: all four corners unoccluded.
        plane.push(p[d.u], p[d.v], material << 8);
        counts[border.dirIndex] += 1;
        counts[7] += 1;
      }
    }
  }

  // Merge each plane's faces into rectangles (or keep them one by one). On
  // a curved level a face runs at most curvedRunCap cells along the ground
  // (levels up a side stay straight, along the local up).
  const opaque = [];
  const water = [];
  const runCap = curved ? (runCapGiven ?? curvedRunCap(blockM)) : Infinity;
  planes.forEach((byPlane, dirIndex) =>
    byPlane.forEach((cellsOfPlane, slot) => {
      const slice = slot - planeOffset[dirIndex];
      const d = DIRECTIONS[dirIndex];
      const caps = {
        u: d.u === 2 ? Infinity : runCap,
        v: d.v === 2 ? Infinity : runCap,
      };
      for (const rect of mergeCells(cellsOfPlane, greedy, caps)) {
        rect.dirIndex = dirIndex;
        rect.slice = slice;
        (rect.key >> 8 === MATERIALS.WATER ? water : opaque).push(rect);
      }
    }),
  );
  return writeQuads(opaque, water, {
    scale,
    sunDir,
    counts,
    curved,
    flatDrop,
    fan,
  });
}

/** Whether a quad's four corners are shaded alike (its AO counts in `key`). */
const evenlyShaded = (key) => {
  const ao = key & 0xff;
  return ao === 0 || ao === 0x55 || ao === 0xaa || ao === 0xff;
};

/**
 * The typed arrays for merged quads, opaque first, then water. Quad n's
 * corners are vertices 4n … 4n + 3. A quad whose corners are shaded alike
 * is two triangles; one whose shading varies (a dark corner at a step) is
 * four, around a centre vertex at the corners' mean shading, appended
 * after every quad's corners: two triangles would carry a dark corner
 * across half the face (at 10 m blocks, a dark fin standing at each step
 * of a staircase, 2026-10-27).
 */
function writeQuads(
  opaque,
  water,
  { scale, sunDir, counts, curved = null, flatDrop = null, fan = true },
) {
  const quads = opaque.concat(water);
  const bend = curved ? curvedPlacement(curved, scale) : null;
  const drop = !bend && flatDrop ? flatDropping(flatDrop) : null;
  const fanned = fan
    ? quads.filter((rect) => !evenlyShaded(rect.key)).length
    : 0;
  const vertices = quads.length * 4 + fanned;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Uint8Array(vertices * 4);
  const blockCoords = new Float32Array(vertices * 3);
  const indices = new Uint32Array(quads.length * 6 + fanned * 6);
  // Colour bytes by material, direction and light, made once each.
  const palette = new Map();
  const colorOf = (material, dirIndex, occlusion) => {
    const id = `${material}:${dirIndex}:${occlusion}`;
    let color = palette.get(id);
    if (!color) {
      const d = DIRECTIONS[dirIndex];
      color = litColor(
        material,
        FACE_SHADE[d.name] * occlusion * sunTerm(d.normal, sunDir),
      );
      palette.set(id, color);
    }
    return color;
  };
  const writeVertex = (vertex, d, color, normal = d.normal) => {
    normals[vertex * 3] = normal[0];
    normals[vertex * 3 + 1] = normal[1];
    normals[vertex * 3 + 2] = normal[2];
    colors[vertex * 4] = color[0];
    colors[vertex * 4 + 1] = color[1];
    colors[vertex * 4 + 2] = color[2];
    colors[vertex * 4 + 3] = color[3];
  };
  let centre = quads.length * 4;
  let index = 0;
  let opaqueIndexCount = 0;
  // A block point (corner c of a face, or its centre) in block units.
  const blockPoint = (d, planeB, uB, vB) => {
    const b = [0, 0, 0];
    b[d.axis] = planeB;
    b[d.u] = uB;
    b[d.v] = vB;
    return b;
  };
  for (let n = 0; n < quads.length; n += 1) {
    if (n === opaque.length) opaqueIndexCount = index;
    const rect = quads[n];
    const d = DIRECTIONS[rect.dirIndex];
    const material = rect.key >> 8;
    if (bend) {
      // Curved: each corner stood on the ellipsoid (curvedPlacement).
      const planeB = rect.slice + (d.normal[d.axis] > 0 ? 1 : 0);
      const uB = [rect.u, rect.u + rect.w];
      const vB = [rect.v, rect.v + rect.h];
      let light = 0;
      for (let c = 0; c < 4; c += 1) {
        const vertex = n * 4 + c;
        const b = blockPoint(
          d,
          planeB,
          uB[c === 1 || c === 2 ? 1 : 0],
          vB[c >= 2 ? 1 : 0],
        );
        positions.set(bend.position(b[0], b[1], b[2]), vertex * 3);
        blockCoords.set(b, vertex * 3);
        const occlusion = AO[(rect.key >> (6 - 2 * c)) & 3];
        light += occlusion;
        writeVertex(
          vertex,
          d,
          colorOf(material, rect.dirIndex, occlusion),
          bend.normal(d, b[0], b[1]),
        );
      }
      const base = n * 4;
      if (!fan || evenlyShaded(rect.key)) {
        const split = splitOf(rect.key);
        for (let k = 0; k < 6; k += 1) indices[index++] = base + split[k];
        continue;
      }
      const b = blockPoint(d, planeB, (uB[0] + uB[1]) / 2, (vB[0] + vB[1]) / 2);
      positions.set(bend.position(b[0], b[1], b[2]), centre * 3);
      blockCoords.set(b, centre * 3);
      writeVertex(
        centre,
        d,
        colorOf(material, rect.dirIndex, light / 4),
        bend.normal(d, b[0], b[1]),
      );
      for (let c = 0; c < 4; c += 1) {
        indices[index++] = base + c;
        indices[index++] = base + ((c + 1) % 4);
        indices[index++] = centre;
      }
      centre += 1;
      continue;
    }
    // The plane along the face's axis, u and v across it, each axis at its
    // own scale (levels up, columns east and north).
    const planeB = rect.slice + (d.normal[d.axis] > 0 ? 1 : 0);
    const plane = (rect.slice + (d.normal[d.axis] > 0 ? 1 : 0)) * scale[d.axis];
    const u0 = rect.u * scale[d.u];
    const v0 = rect.v * scale[d.v];
    const u1 = (rect.u + rect.w) * scale[d.u];
    const v1 = (rect.v + rect.h) * scale[d.v];
    let light = 0;
    for (let c = 0; c < 4; c += 1) {
      const vertex = n * 4 + c;
      positions[vertex * 3 + d.axis] = plane;
      positions[vertex * 3 + d.u] = c === 1 || c === 2 ? u1 : u0;
      positions[vertex * 3 + d.v] = c >= 2 ? v1 : v0;
      blockCoords[vertex * 3 + d.axis] = planeB;
      blockCoords[vertex * 3 + d.u] =
        c === 1 || c === 2 ? rect.u + rect.w : rect.u;
      blockCoords[vertex * 3 + d.v] = c >= 2 ? rect.v + rect.h : rect.v;
      const occlusion = AO[(rect.key >> (6 - 2 * c)) & 3];
      light += occlusion;
      writeVertex(vertex, d, colorOf(material, rect.dirIndex, occlusion));
    }
    const base = n * 4;
    if (drop) for (let c = 0; c < 4; c += 1) drop(positions, base + c);
    if (!fan || evenlyShaded(rect.key)) {
      const split = splitOf(rect.key);
      for (let k = 0; k < 6; k += 1) indices[index++] = base + split[k];
      continue;
    }
    // Four triangles around the centre, at the corners' mean shading.
    positions[centre * 3 + d.axis] = plane;
    positions[centre * 3 + d.u] = (u0 + u1) / 2;
    positions[centre * 3 + d.v] = (v0 + v1) / 2;
    if (drop) drop(positions, centre);
    blockCoords[centre * 3 + d.axis] = planeB;
    blockCoords[centre * 3 + d.u] = rect.u + rect.w / 2;
    blockCoords[centre * 3 + d.v] = rect.v + rect.h / 2;
    writeVertex(centre, d, colorOf(material, rect.dirIndex, light / 4));
    for (let c = 0; c < 4; c += 1) {
      indices[index++] = base + c;
      indices[index++] = base + ((c + 1) % 4);
      indices[index++] = centre;
    }
    centre += 1;
  }
  if (opaque.length === quads.length) opaqueIndexCount = index;
  const stats = Object.fromEntries(
    STAT_NAMES.map((name, dirIndex) => [name, counts[dirIndex]]),
  );
  stats.water = counts[6];
  stats.skirt = counts[7];
  return {
    positions,
    normals,
    colors,
    blockCoords,
    indices,
    faces: quads.length,
    opaqueIndexCount,
    stats,
    // A curved chunk's own origin in the renderer's frame (its positions
    // are relative to it); the flat ones use the region's chunkOrigin.
    // `curved` tells the renderer its positions are off the block lattice
    // (renderer.js chunkIsCurved), whatever its block size.
    ...(bend ? { origin: bend.origin, curved: true } : {}),
  };
}

const TRIANGLES = [0, 1, 2, 0, 2, 3];
/** The same quad split along its other diagonal (corners 1 and 3). */
const TRIANGLES_FLIPPED = [0, 1, 3, 1, 2, 3];

/**
 * A quad's two triangles: along the diagonal between its brighter corners
 * (the fewer occluders, `key`'s AO counts), so a dark corner is not drawn
 * across the face; corners 0 and 2 when even.
 */
const splitOf = (key) => {
  const count = (c) => (key >> (6 - 2 * c)) & 3;
  return count(0) + count(2) > count(1) + count(3)
    ? TRIANGLES_FLIPPED
    : TRIANGLES;
};

/**
 * Greedy rectangles over one plane's cells ([u, v, key] triples), on a
 * dense grid of the plane's extent: row by row, each free cell grows along
 * u while the key holds, then along v while every cell of the next row does.
 */
function mergeCells(cells, greedy, caps = null) {
  const capU = caps?.u ?? Infinity;
  const capV = caps?.v ?? Infinity;
  const count = cells.length / 3;
  const rects = [];
  if (!greedy) {
    for (let k = 0; k < count; k += 1)
      rects.push({
        u: cells[k * 3],
        v: cells[k * 3 + 1],
        w: 1,
        h: 1,
        key: cells[k * 3 + 2],
      });
    return rects;
  }
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (let k = 0; k < count; k += 1) {
    u0 = Math.min(u0, cells[k * 3]);
    u1 = Math.max(u1, cells[k * 3]);
    v0 = Math.min(v0, cells[k * 3 + 1]);
    v1 = Math.max(v1, cells[k * 3 + 1]);
  }
  const width = u1 - u0 + 1;
  const height = v1 - v0 + 1;
  // -1: no face there, or already in a rectangle.
  const grid = new Int32Array(width * height).fill(-1);
  for (let k = 0; k < count; k += 1)
    grid[(cells[k * 3 + 1] - v0) * width + (cells[k * 3] - u0)] =
      cells[k * 3 + 2];
  for (let v = 0; v < height; v += 1)
    for (let u = 0; u < width; u += 1) {
      const key = grid[v * width + u];
      if (key < 0) continue;
      let w = 1;
      while (u + w < width && w < capU && grid[v * width + u + w] === key)
        w += 1;
      let h = 1;
      for (; v + h < height && h < capV; h += 1) {
        let row = true;
        for (let k = 0; k < w && row; k += 1)
          row = grid[(v + h) * width + u + k] === key;
        if (!row) break;
      }
      for (let dv = 0; dv < h; dv += 1)
        grid.fill(-1, (v + dv) * width + u, (v + dv) * width + u + w);
      rects.push({ u: u + u0, v: v + v0, w, h, key });
    }
  return rects;
}
