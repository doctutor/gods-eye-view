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
 * south-west corner at mean sea level (z = level × blockM).
 *
 * Neighbour chunks (n, s, e, w, and the diagonals ne, nw, se, sw for
 * ambient occlusion at the corners) cull faces across the chunk's borders;
 * a missing neighbour reads as the edge column repeated, so an open edge
 * has no wall, and the chunk is meshed again when the neighbour arrives.
 */
import { CHUNK_COLUMNS, columnIndex } from './grid.js';
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
    // A structure stands on the top, over any water.
    const structureTo = Math.min(
      levels,
      Math.max(0, structureTops[k] - yMin + 1),
    );
    if (structureTo > solidTo)
      cells.fill(structureMaterials[k], start + solidTo, start + structureTo);
    for (const [y, value] of edits[k])
      if (y - yMin >= 0 && y - yMin < levels) cells[start + y - yMin] = value;
  }
  return { cells, yMin, levels, low, up };
}

/** Which way each direction's stats count. */
const STAT_NAMES = DIRECTIONS.map((d) => d.name);

/**
 * Mesh a chunk. `blockM` scales block units to metres; `sunDir` is the
 * unit vector to the sun, {east, north, up} in the region's frame (the
 * study sun when not given);
 * `greedy: false` keeps one quad per block face (for counting faces).
 * `stats` counts block faces by direction (and water), before merging.
 * @returns {{positions: Float32Array, normals: Float32Array,
 *   colors: Uint8Array, indices: Uint32Array, faces: number,
 *   opaqueIndexCount: number, stats: Object<string, number>}}
 */
export function buildChunkMesh(
  chunk,
  { neighbours = {}, blockM = 1, sunDir = STUDY_SUN_DIR, greedy = true } = {},
) {
  const counts = new Float64Array(7);
  const volume = occupancyVolume(chunk, neighbours);
  if (!volume) return writeQuads([], [], { blockM, sunDir, counts });
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

  // Merge each plane's faces into rectangles (or keep them one by one).
  const opaque = [];
  const water = [];
  planes.forEach((byPlane, dirIndex) =>
    byPlane.forEach((cellsOfPlane, slot) => {
      const slice = slot - planeOffset[dirIndex];
      for (const rect of mergeCells(cellsOfPlane, greedy)) {
        rect.dirIndex = dirIndex;
        rect.slice = slice;
        (rect.key >> 8 === MATERIALS.WATER ? water : opaque).push(rect);
      }
    }),
  );
  return writeQuads(opaque, water, { blockM, sunDir, counts });
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
function writeQuads(opaque, water, { blockM, sunDir, counts }) {
  const quads = opaque.concat(water);
  const fanned = quads.filter((rect) => !evenlyShaded(rect.key)).length;
  const vertices = quads.length * 4 + fanned;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Uint8Array(vertices * 4);
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
  const writeVertex = (vertex, d, color) => {
    normals[vertex * 3] = d.normal[0];
    normals[vertex * 3 + 1] = d.normal[1];
    normals[vertex * 3 + 2] = d.normal[2];
    colors[vertex * 4] = color[0];
    colors[vertex * 4 + 1] = color[1];
    colors[vertex * 4 + 2] = color[2];
    colors[vertex * 4 + 3] = color[3];
  };
  let centre = quads.length * 4;
  let index = 0;
  let opaqueIndexCount = 0;
  for (let n = 0; n < quads.length; n += 1) {
    if (n === opaque.length) opaqueIndexCount = index;
    const rect = quads[n];
    const d = DIRECTIONS[rect.dirIndex];
    const material = rect.key >> 8;
    const plane = (rect.slice + (d.normal[d.axis] > 0 ? 1 : 0)) * blockM;
    const u0 = rect.u * blockM;
    const v0 = rect.v * blockM;
    const u1 = (rect.u + rect.w) * blockM;
    const v1 = (rect.v + rect.h) * blockM;
    let light = 0;
    for (let c = 0; c < 4; c += 1) {
      const vertex = n * 4 + c;
      positions[vertex * 3 + d.axis] = plane;
      positions[vertex * 3 + d.u] = c === 1 || c === 2 ? u1 : u0;
      positions[vertex * 3 + d.v] = c >= 2 ? v1 : v0;
      const occlusion = AO[(rect.key >> (6 - 2 * c)) & 3];
      light += occlusion;
      writeVertex(vertex, d, colorOf(material, rect.dirIndex, occlusion));
    }
    const base = n * 4;
    if (evenlyShaded(rect.key)) {
      for (let k = 0; k < 6; k += 1) indices[index++] = base + TRIANGLES[k];
      continue;
    }
    // Four triangles around the centre, at the corners' mean shading.
    positions[centre * 3 + d.axis] = plane;
    positions[centre * 3 + d.u] = (u0 + u1) / 2;
    positions[centre * 3 + d.v] = (v0 + v1) / 2;
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
  return {
    positions,
    normals,
    colors,
    indices,
    faces: quads.length,
    opaqueIndexCount,
    stats,
  };
}

const TRIANGLES = [0, 1, 2, 0, 2, 3];

/**
 * Greedy rectangles over one plane's cells ([u, v, key] triples), on a
 * dense grid of the plane's extent: row by row, each free cell grows along
 * u while the key holds, then along v while every cell of the next row does.
 */
function mergeCells(cells, greedy) {
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
      while (u + w < width && grid[v * width + u + w] === key) w += 1;
      let h = 1;
      for (; v + h < height; h += 1) {
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
