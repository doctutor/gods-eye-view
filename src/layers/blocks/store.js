/**
 * Personal fork: the Blocks chunk store (docs/BLOCKS-PLAN.md, "Store").
 *
 * A chunk is a column heightfield (the top solid level, its material and a
 * water level per column) plus a sparse edits overlay, so "what occupies
 * this point?" always has an answer (`occupancy`), and breaking or stacking
 * a block later is an edit, never a change to the heightfield. Columns are
 * chunk-local (i, j) in 0 … CHUNK_COLUMNS − 1, rows running north; levels
 * are the region's (y = 0 the block whose base is mean sea level). Columns
 * are filled: every level at or below the top is the column's material,
 * then water up to the water level, then air.
 *
 * A structures layer (OSM buildings, structures.js) sits between the
 * heightfield and the edits: a column's structure fills the levels from
 * just above its top up to the structure's top with the structure's
 * material, over any water. It is data like the heightfield, not an edit:
 * the overlay is never touched, and an edit over a structure wins.
 */
import { CHUNK_COLUMNS, columnIndex } from './grid.js';

/** Block materials; land cover ids follow. */
export const MATERIALS = Object.freeze({
  AIR: 0,
  TERRAIN: 1,
  WATER: 2,
  BUILDING: 3,
});
/** No level: a column without data, or without water. */
export const NONE = -2147483648;

const COLUMNS = CHUNK_COLUMNS * CHUNK_COLUMNS;

/** Whether a material is solid (neither air nor water). */
export const isSolid = (material) =>
  material !== MATERIALS.AIR && material !== MATERIALS.WATER;

function checkColumn(i, j) {
  if (
    !Number.isInteger(i) ||
    !Number.isInteger(j) ||
    i < 0 ||
    j < 0 ||
    i >= CHUNK_COLUMNS ||
    j >= CHUNK_COLUMNS
  )
    throw new RangeError(`column (${i}, ${j}) is outside the chunk`);
}

function checkLevel(y) {
  if (!Number.isInteger(y) || y === NONE)
    throw new RangeError(`level ${y} is not a block level`);
}

function columnArray(Type, given, fill, name) {
  if (given === undefined) return new Type(COLUMNS).fill(fill);
  if (!(given instanceof Type) || given.length !== COLUMNS)
    throw new TypeError(`${name} must be a ${Type.name} of ${COLUMNS}`);
  return given;
}

/**
 * A chunk from its heightfield: `top` the highest solid level per column
 * (NONE: no data), `material` the column's material (TERRAIN when not
 * given), `water` the water surface's level (NONE: no water), each
 * CHUNK_COLUMNS² long, indexed j × CHUNK_COLUMNS + i.
 */
export function createChunk({ ci, cj, top, material, water } = {}) {
  const tops = columnArray(Int32Array, top, NONE, 'top');
  const materials = columnArray(
    Uint8Array,
    material,
    MATERIALS.TERRAIN,
    'material',
  );
  const waters = columnArray(Int32Array, water, NONE, 'water');
  /** Edits by column index, then level: the overlay. */
  const overlay = new Map();
  /** The structures layer, made on the first structure: top level and material per column. */
  let structure = null;
  let version = 0;

  /** What the heightfield and structures put at a point. */
  const base = (index, y) => {
    const top = tops[index];
    if (top === NONE) {
      if (y <= waters[index] && waters[index] !== NONE) return MATERIALS.WATER;
      return MATERIALS.AIR;
    }
    if (y <= top) return materials[index];
    if (structure && y <= structure.top[index])
      return structure.material[index];
    if (y <= waters[index] && waters[index] !== NONE) return MATERIALS.WATER;
    return MATERIALS.AIR;
  };

  const chunk = {
    ci,
    cj,
    top: tops,
    material: materials,
    water: waters,
    /** Bumps on every edit, so a mesh can tell it is stale. */
    get version() {
      return version;
    },
    /** What occupies a point: the edit there, else the heightfield's. */
    occupancy(i, j, y) {
      checkColumn(i, j);
      const index = columnIndex(i, j);
      const edited = overlay.get(index)?.get(y);
      return edited ?? base(index, y);
    },
    /**
     * Put a material at a point (AIR breaks a block). An edit that agrees
     * with the heightfield is dropped, so the overlay holds only changes.
     */
    setBlock(i, j, y, material) {
      checkColumn(i, j);
      checkLevel(y);
      if (!Number.isInteger(material) || material < 0 || material > 255)
        throw new RangeError(`material ${material} is not a material id`);
      const index = columnIndex(i, j);
      let column = overlay.get(index);
      const before = column?.get(y) ?? base(index, y);
      if (material === base(index, y)) {
        column?.delete(y);
        if (column?.size === 0) overlay.delete(index);
      } else {
        if (!column) overlay.set(index, (column = new Map()));
        column.set(y, material);
      }
      if (before !== material) version += 1;
    },
    /**
     * The structures layer, {top, material} per column (top NONE: none),
     * or null before the first structure.
     */
    get structure() {
      return structure;
    },
    /**
     * A structure in a column: levels from just above the heightfield's
     * top up to `topLevel` are `material` (NONE, or a top not above the
     * heightfield's, clears it). A column without data takes none.
     */
    setStructure(i, j, topLevel, material = MATERIALS.BUILDING) {
      checkColumn(i, j);
      if (topLevel !== NONE) checkLevel(topLevel);
      if (!Number.isInteger(material) || material < 0 || material > 255)
        throw new RangeError(`material ${material} is not a material id`);
      const index = columnIndex(i, j);
      const top = tops[index];
      const next =
        top === NONE || topLevel === NONE || topLevel <= top ? NONE : topLevel;
      if (!structure) {
        if (next === NONE) return;
        structure = {
          top: new Int32Array(COLUMNS).fill(NONE),
          material: new Uint8Array(COLUMNS),
        };
      }
      if (
        structure.top[index] === next &&
        (next === NONE || structure.material[index] === material)
      )
        return;
      structure.top[index] = next;
      structure.material[index] = next === NONE ? 0 : material;
      version += 1;
    },
    /** The structure's top level in a column, NONE when none. */
    structureTop(i, j) {
      checkColumn(i, j);
      return structure ? structure.top[columnIndex(i, j)] : NONE;
    },
    /** Remove every structure. */
    clearStructures() {
      if (!structure) return;
      if (structure.top.some((top) => top !== NONE)) version += 1;
      structure = null;
    },
    /** Every edit, as {i, j, y, material}. */
    get edits() {
      return (function* walk() {
        for (const [index, column] of overlay)
          for (const [y, material] of column)
            yield {
              i: index % CHUNK_COLUMNS,
              j: Math.floor(index / CHUNK_COLUMNS),
              y,
              material,
            };
      })();
    },
    /** The edits in one column, as [y, material] pairs (none: empty). */
    columnEdits(i, j) {
      checkColumn(i, j);
      return [...(overlay.get(columnIndex(i, j)) ?? [])];
    },
    /** The highest solid level in a column after edits; NONE if none. */
    topSolid(i, j) {
      checkColumn(i, j);
      const index = columnIndex(i, j);
      const column = overlay.get(index);
      const baseTop = tops[index];
      const structureTop = structure ? structure.top[index] : NONE;
      let highest = Math.max(baseTop, structureTop);
      if (column)
        for (const [y, material] of column)
          if (isSolid(material) && (highest === NONE || y > highest))
            highest = y;
      if (highest === NONE) return NONE;
      // Down from the highest candidate: edits may have broken it, and
      // every level below the heightfield's top is solid unless edited.
      for (let y = highest; ; y -= 1) {
        const edited = column?.get(y);
        if (edited !== undefined) {
          if (isSolid(edited)) return y;
          continue;
        }
        if (structureTop !== NONE && y > baseTop && y <= structureTop) {
          if (isSolid(structure.material[index])) return y;
          continue;
        }
        if (baseTop !== NONE && y <= baseTop)
          return isSolid(materials[index]) ? y : NONE;
        if (!column || y < lowestEdit(column)) return NONE;
      }
    },
    /** The edits as plain data, for persistence by chunk key. */
    toJSON() {
      return { ci, cj, edits: [...chunk.edits] };
    },
  };
  return chunk;
}

function lowestEdit(column) {
  let lowest = Infinity;
  for (const y of column.keys()) if (y < lowest) lowest = y;
  return lowest;
}

/** Apply serialised edits (chunk.toJSON().edits) to a chunk. */
export function applyEdits(chunk, edits = []) {
  for (const { i, j, y, material } of edits) chunk.setBlock(i, j, y, material);
  return chunk;
}
