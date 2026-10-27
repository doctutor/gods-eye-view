// Personal fork: OpenStreetMap buildings as stacked blocks for the Blocks
// render mode (docs/BLOCKS-PLAN.md, milestone 3), the way Arnis builds
// them. For a chunk group (source.js's 4 × 4 chunks, the elevation fetch's
// bounds) one Overpass query through the app's /api/overpass proxy asks for
// the buildings and building parts in the group's box: tagged ways, and
// relations, whose outer and inner member ways are joined into rings. Each
// footprint covers the group's columns whose centres are inside it
// (even-odd, so courtyards stay open). Its roof is level, as Arnis builds
// it: its base is the highest ground under it, its top base + its height
// in blocks (round(height tag, else building:levels × 3.2 m, else 6.4 m,
// / blockM), at least one), and its walls go down to each column's own
// ground, so on a slope they reach further down on the low side. A part
// with min_height (or building:min_level) starts that far above the base,
// leaving a hollow under it. Parts override their building's outline where
// they overlap; overlapping parts (or outlines) unite. The ground comes
// from the elevation source's chunks of the same group (loadChunk), which
// that source fetched in its one request; a footprint across a group's
// edge takes its base from the columns in each group.
//
// A chunk's levels are put into the store's structures layer (between the
// heightfield and the edits) by applyStructures, so the result is data like
// the heightfield and an edit can still break or stack a block of a
// building. Groups are cached; a failed query is not, so the group has no
// buildings until the controller retries, as it does for elevation.

import { createOverpassViewClient } from '../../sources/overpassView.js';
import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import {
  CHUNK_GROUP,
  GROUP_COLUMNS,
  groupBounds,
  groupOf,
  regionKey,
} from './source.js';
import { MATERIALS, NONE } from './store.js';

/** The material buildings are drawn in. */
export const BUILDING = MATERIALS.BUILDING;
/** A storey, metres (building:levels × this when there is no height tag). */
export const LEVEL_HEIGHT_M = 3.2;
/** A building's height when it says nothing: two storeys. */
export const DEFAULT_HEIGHT_M = 2 * LEVEL_HEIGHT_M;
/** Groups of buildings kept in memory. */
export const MAX_GROUPS = 64;
/** The least time between two Overpass queries from the blocks. */
const QUERY_GAP_MS = 700;
const FOOT_M = 0.3048;

/**
 * A length tag in metres: "12", "12.5 m", "12m", "40 ft", "40'", "12'6\"";
 * NaN when it is not one.
 */
export function parseLengthM(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(',', '.');
  const feet =
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/.exec(
      text,
    );
  if (feet) return (Number(feet[1]) + Number(feet[2] || 0) / 12) * FOOT_M;
  const metres = /^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/.exec(text);
  return metres ? Number(metres[1]) : NaN;
}

/** A building's height in metres from its tags. */
export function buildingHeightM(tags = {}) {
  const height = parseLengthM(tags.height);
  if (height > 0) return height;
  const levels = parseFloat(tags['building:levels']);
  if (levels > 0) return levels * LEVEL_HEIGHT_M;
  return DEFAULT_HEIGHT_M;
}

/** A building's height in blocks of blockM: rounded, at least one. */
export const buildingHeightBlocks = (tags, blockM) =>
  Math.max(1, Math.round(buildingHeightM(tags) / blockM));

/**
 * How far above the ground a building (part) starts, metres: min_height,
 * else building:min_level × 3.2 m, else 0.
 */
export function buildingMinHeightM(tags = {}) {
  const height = parseLengthM(tags.min_height);
  if (height > 0) return height;
  const levels = parseFloat(tags['building:min_level']);
  if (levels > 0) return levels * LEVEL_HEIGHT_M;
  return 0;
}

/** Whether a footprint is a building:part (it overrides its building's outline). */
export const isBuildingPart = (tags = {}) =>
  Boolean(tags['building:part']) && tags['building:part'] !== 'no';

/** The Overpass query for the buildings and building parts in a box. */
export function buildingsQuery({ west, south, east, north }) {
  const bbox = [south, west, north, east].map((v) => v.toFixed(7)).join(',');
  return (
    '[out:json][timeout:25];' +
    `(way["building"]["building"!="no"](${bbox});` +
    `relation["building"]["building"!="no"](${bbox});` +
    `way["building:part"]["building:part"!="no"](${bbox});` +
    `relation["building:part"]["building:part"!="no"](${bbox}););` +
    'out geom qt;'
  );
}

const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;

/**
 * Join member ways into closed rings: each open way is extended by any
 * way that shares an end, turned round if need be; a ring that cannot be
 * closed is closed straight.
 */
export function assembleRings(ways) {
  const pool = ways.filter((way) => way.length >= 2).map((way) => [...way]);
  const rings = [];
  while (pool.length) {
    const ring = pool.shift();
    while (!samePoint(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const at = pool.findIndex(
        (way) => samePoint(way[0], end) || samePoint(way[way.length - 1], end),
      );
      if (at < 0) break;
      const [next] = pool.splice(at, 1);
      if (!samePoint(next[0], end)) next.reverse();
      ring.push(...next.slice(1));
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/**
 * Building footprints from an Overpass answer (`out geom`): {rings:
 * [[{lat, lon}]], tags, id}. A relation's outer and inner ways are rings
 * alike; the fill is even-odd.
 */
export function parseFootprints(elements = []) {
  const footprints = [];
  for (const element of elements) {
    if (element.type === 'way' && element.geometry?.length >= 3)
      footprints.push({
        id: `way/${element.id}`,
        tags: element.tags || {},
        rings: [element.geometry],
      });
    else if (element.type === 'relation' && Array.isArray(element.members)) {
      const ways = element.members
        .filter(
          (member) =>
            member.type === 'way' &&
            (member.role === 'outer' ||
              member.role === 'inner' ||
              member.role === '') &&
            member.geometry?.length >= 2,
        )
        .map((member) => member.geometry);
      const rings = assembleRings(ways);
      if (rings.length)
        footprints.push({
          id: `relation/${element.id}`,
          tags: element.tags || {},
          rings,
        });
    }
  }
  return footprints;
}

/**
 * Visit the columns of a size × size grid from column (i0, j0) whose
 * centres are inside rings (region metres, [{x, y}]; even-odd), by index
 * j × size + i.
 */
function scanFootprint(rings, { blockM, i0, j0, size }, visit) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const ring of rings)
    for (const { y } of ring) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  const jFrom = Math.max(0, Math.ceil(yMin / blockM - 0.5) - j0);
  const jTo = Math.min(size - 1, Math.floor(yMax / blockM - 0.5) - j0);
  const crossings = [];
  for (let j = jFrom; j <= jTo; j++) {
    const y = (j0 + j + 0.5) * blockM;
    crossings.length = 0;
    for (const ring of rings)
      for (let k = 0, n = ring.length; k < n; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % n];
        if (a.y <= y === b.y <= y) continue; // the edge does not cross the row
        crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    crossings.sort((p, q) => p - q);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      // Columns whose centre (i + 0.5) · blockM lies in [from, to).
      const iFrom = Math.max(0, Math.ceil(crossings[c] / blockM - 0.5) - i0);
      const iTo = Math.min(
        size - 1,
        Math.ceil(crossings[c + 1] / blockM - 0.5) - 1 - i0,
      );
      for (let i = iFrom; i <= iTo; i++) visit(j * size + i);
    }
  }
}

/**
 * Fill rings onto a grid ({blockM, i0, j0, size}, as scanFootprint): a
 * column inside takes `value` unless it holds more already.
 * @returns {number} columns set
 */
export function fillFootprint(rings, { out, value, ...grid }) {
  let set = 0;
  scanFootprint(rings, grid, (index) => {
    if (out[index] < value) {
      out[index] = value;
      set++;
    }
  });
  return set;
}

/** The grid indices of the columns inside rings (as scanFootprint). */
export function footprintColumns(rings, grid) {
  const columns = [];
  scanFootprint(rings, grid, (index) => columns.push(index));
  return columns;
}

/**
 * A group's structures as levels, GROUP_COLUMNS² each (index j ×
 * GROUP_COLUMNS + i; NONE where none): `top` and `bottom` per column.
 * `terrainTop(index)` is a column's heightfield top and `ground(index)`
 * what a building stands on (the water where that is higher), NONE
 * without data. A footprint's roof is level: the highest ground under it
 * plus its height. Its bottom is each column's own top + 1 (walls down to
 * the ground), or base + min height + 1 for one that starts higher. Parts
 * override outlines; overlaps unite (the lowest bottom, the highest top).
 */
export function structureLevels(
  region,
  gi,
  gj,
  footprints,
  { terrainTop, ground },
) {
  const count = GROUP_COLUMNS * GROUP_COLUMNS;
  const [outlines, parts] = [0, 1].map(() => ({
    top: new Int32Array(count).fill(NONE),
    bottom: new Int32Array(count).fill(NONE),
  }));
  const grid = {
    blockM: region.blockM,
    i0: gi * GROUP_COLUMNS,
    j0: gj * GROUP_COLUMNS,
    size: GROUP_COLUMNS,
  };
  for (const footprint of footprints) {
    const rings = footprint.rings.map((ring) =>
      ring.map(({ lon, lat }) => region.toLocal(lon, lat)),
    );
    const columns = footprintColumns(rings, grid).filter(
      (index) => terrainTop(index) !== NONE,
    );
    if (!columns.length) continue;
    let base = -Infinity;
    for (const index of columns) base = Math.max(base, ground(index));
    const height = buildingHeightBlocks(footprint.tags, region.blockM);
    const lift = Math.min(
      height - 1,
      Math.round(buildingMinHeightM(footprint.tags) / region.blockM),
    );
    const top = base + height;
    const layer = isBuildingPart(footprint.tags) ? parts : outlines;
    for (const index of columns) {
      const bottom = lift > 0 ? base + lift + 1 : terrainTop(index) + 1;
      if (layer.top[index] === NONE || top > layer.top[index])
        layer.top[index] = top;
      if (layer.bottom[index] === NONE || bottom < layer.bottom[index])
        layer.bottom[index] = bottom;
    }
  }
  for (let index = 0; index < count; index++)
    if (parts.top[index] !== NONE) {
      outlines.top[index] = parts.top[index];
      outlines.bottom[index] = parts.bottom[index];
    }
  return outlines;
}

/** Chunk (a, b) of a group's levels, in columnIndex order; null when it has none. */
function chunkLevels({ top, bottom }, a, b) {
  const out = {
    top: new Int32Array(CHUNK_COLUMNS * CHUNK_COLUMNS),
    bottom: new Int32Array(CHUNK_COLUMNS * CHUNK_COLUMNS),
  };
  let any = false;
  for (let j = 0; j < CHUNK_COLUMNS; j++) {
    const from = (b * CHUNK_COLUMNS + j) * GROUP_COLUMNS + a * CHUNK_COLUMNS;
    const row = top.subarray(from, from + CHUNK_COLUMNS);
    out.top.set(row, columnIndex(0, j));
    out.bottom.set(
      bottom.subarray(from, from + CHUNK_COLUMNS),
      columnIndex(0, j),
    );
    if (!any) any = row.some((level) => level !== NONE);
  }
  return any ? out : null;
}

/**
 * A group's ground from its 16 chunks (chunks[b × CHUNK_GROUP + a]), by
 * group column index: the heightfield top, and the ground a building
 * stands on (the water where that is higher).
 */
export function groupTerrain(chunks) {
  const at = (index) => {
    const i = index % GROUP_COLUMNS;
    const j = Math.floor(index / GROUP_COLUMNS);
    const chunk =
      chunks[
        Math.floor(j / CHUNK_COLUMNS) * CHUNK_GROUP +
          Math.floor(i / CHUNK_COLUMNS)
      ];
    return { chunk, k: columnIndex(i % CHUNK_COLUMNS, j % CHUNK_COLUMNS) };
  };
  return {
    terrainTop(index) {
      const { chunk, k } = at(index);
      return chunk.top[k];
    },
    ground(index) {
      const { chunk, k } = at(index);
      const top = chunk.top[k];
      const water = chunk.water[k];
      return top === NONE || water === NONE ? top : Math.max(top, water);
    },
  };
}

/**
 * Put a chunk's buildings into its structures layer: each column with a
 * top gets its structure from its bottom to its top (store.js
 * setStructure). Columns without data take none.
 * @param {object} chunk store.js's
 * @param {{top: Int32Array, bottom: Int32Array}|null} levels per column
 *   (columnIndex order; top NONE: none), from loadChunkStructures
 * @returns {number} columns with a building
 */
export function applyStructures(chunk, levels, material = BUILDING) {
  if (!levels) return 0;
  let count = 0;
  for (let j = 0; j < CHUNK_COLUMNS; j++)
    for (let i = 0; i < CHUNK_COLUMNS; i++) {
      const index = columnIndex(i, j);
      const top = levels.top[index];
      if (top === NONE || chunk.top[index] === NONE) continue;
      chunk.setStructure(i, j, top, material, levels.bottom[index]);
      count++;
    }
  return count;
}

/** One Overpass query at a time, so the view client never aborts one for the next. */
function serialQuery(client) {
  let chain = Promise.resolve();
  return (query) => {
    const run = chain.then(() => client.query(query));
    chain = run.catch(() => {});
    return run;
  };
}

/**
 * @param {{loadChunk: (region: object, ci: number, cj: number) =>
 *   Promise<object>, query?: (ql: string) => Promise<{elements:
 *   object[]}>, maxGroups?: number}} options loadChunk: the elevation
 *   source's (source.js), for the ground under the buildings; query: the
 *   app's Overpass client (src/sources/overpassView.js through
 *   /api/overpass) unless given.
 */
export function createStructuresSource({
  loadChunk,
  query,
  maxGroups = MAX_GROUPS,
} = {}) {
  if (typeof loadChunk !== 'function')
    throw new TypeError(
      'createStructuresSource needs loadChunk (the elevation source)',
    );
  if (!query)
    query = serialQuery(createOverpassViewClient({ minGapMs: QUERY_GAP_MS }));
  const held = new Map(); // group key → Promise<Map<chunk key, levels|null>>

  function remember(key, promise) {
    held.delete(key);
    held.set(key, promise);
    while (held.size > maxGroups) held.delete(held.keys().next().value);
  }

  /** A group's buildings by chunk key 'ci:cj': {top, bottom} levels, or null. */
  function loadGroup(region, gi, gj) {
    const key = `${regionKey(region)}|g${gi}:${gj}`;
    const known = held.get(key);
    if (known) {
      remember(key, known);
      return known;
    }
    const promise = (async () => {
      const cells = [];
      for (let b = 0; b < CHUNK_GROUP; b++)
        for (let a = 0; a < CHUNK_GROUP; a++)
          cells.push({
            a,
            b,
            ci: gi * CHUNK_GROUP + a,
            cj: gj * CHUNK_GROUP + b,
          });
      // The ground comes with the elevation source's one group request.
      const [{ elements }, terrain] = await Promise.all([
        query(buildingsQuery(groupBounds(region, gi, gj))),
        Promise.all(cells.map(({ ci, cj }) => loadChunk(region, ci, cj))),
      ]);
      const footprints = parseFootprints(elements);
      const levels = structureLevels(
        region,
        gi,
        gj,
        footprints,
        groupTerrain(terrain),
      );
      const chunks = new Map();
      for (const { a, b, ci, cj } of cells)
        chunks.set(`${ci}:${cj}`, chunkLevels(levels, a, b));
      // The ids of the group's buildings, beside the chunks (the Blocks
      // status line counts them once across groups).
      chunks.buildings = footprints.map((footprint) => footprint.id);
      return chunks;
    })();
    remember(key, promise);
    // A failure is not kept: the controller's retry asks again.
    promise.catch(() => {
      if (held.get(key) === promise) held.delete(key);
    });
    return promise;
  }

  return {
    loadGroup,
    /**
     * A chunk's buildings as levels, {top, bottom} per column
     * (columnIndex order, top NONE: none), or null when it has none; from
     * its group's one query.
     * @returns {Promise<{top: Int32Array, bottom: Int32Array}|null>}
     */
    async loadChunkStructures(region, ci, cj) {
      const { gi, gj } = groupOf(ci, cj);
      return (await loadGroup(region, gi, gj)).get(`${ci}:${cj}`) ?? null;
    },
    /** The ids of the buildings in a group, from its one query. */
    async loadGroupBuildings(region, gi, gj) {
      return (await loadGroup(region, gi, gj)).buildings ?? [];
    },
    /** Groups held (for tests). */
    size: () => held.size,
    clear: () => held.clear(),
  };
}
