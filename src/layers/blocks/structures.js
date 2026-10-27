// Personal fork: OpenStreetMap buildings as stacked blocks for the Blocks
// render mode (docs/BLOCKS-PLAN.md, milestone 3), the way Arnis builds
// them. For a chunk group (source.js's 4 × 4 chunks, the elevation fetch's
// bounds) one Overpass query through the app's /api/overpass proxy asks for
// the buildings in the group's box: tagged ways, and building relations,
// whose outer and inner member ways are joined into rings. Each footprint
// is filled onto the group's column grid (a column is in when its centre
// is, even-odd so courtyards stay open) with its height in blocks:
// round(height tag, else building:levels × 3.2 m, else 6.4 m, / blockM),
// at least one. A chunk's heights are applied by applyStructures on top of
// its terrain (the store's structures layer, between the heightfield and
// the edits), so the result is data like the heightfield and an edit can
// still break or stack a block of a building.
//
// Groups are cached; a failed query is not, so the group has no buildings
// until the controller retries, as it does for elevation.

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

/** The Overpass query for the buildings in a box. */
export function buildingsQuery({ west, south, east, north }) {
  const bbox = [south, west, north, east].map((v) => v.toFixed(7)).join(',');
  return (
    '[out:json][timeout:25];' +
    `(way["building"]["building"!="no"](${bbox});` +
    `relation["building"]["building"!="no"](${bbox}););` +
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
 * Fill rings (region metres, [{x, y}]) onto a size × size grid of columns
 * from column (i0, j0), index j × size + i: a column whose centre is inside
 * (even-odd) takes `value` unless it holds more already.
 * @returns {number} columns set
 */
export function fillFootprint(rings, { blockM, i0, j0, size, out, value }) {
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
  let set = 0;
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
      for (let i = iFrom; i <= iTo; i++) {
        const index = j * size + i;
        if (out[index] < value) {
          out[index] = value;
          set++;
        }
      }
    }
  }
  return set;
}

/**
 * A group's building heights in blocks, GROUP_COLUMNS² (index j ×
 * GROUP_COLUMNS + i), from its footprints. `placed`, when given, collects
 * the ids of the footprints that set a column (the Blocks status line's
 * count of buildings).
 */
export function rasteriseGroup(region, gi, gj, footprints, placed = null) {
  const out = new Uint16Array(GROUP_COLUMNS * GROUP_COLUMNS);
  for (const footprint of footprints) {
    const rings = footprint.rings.map((ring) =>
      ring.map(({ lon, lat }) => region.toLocal(lon, lat)),
    );
    const set = fillFootprint(rings, {
      blockM: region.blockM,
      i0: gi * GROUP_COLUMNS,
      j0: gj * GROUP_COLUMNS,
      size: GROUP_COLUMNS,
      out,
      value: Math.min(
        65535,
        buildingHeightBlocks(footprint.tags, region.blockM),
      ),
    });
    if (placed && set > 0) placed.push(footprint.id);
  }
  return out;
}

/** Chunk (a, b) of a group's heights, in columnIndex order; null when it has none. */
function chunkHeights(heights, a, b) {
  const out = new Uint16Array(CHUNK_COLUMNS * CHUNK_COLUMNS);
  let any = false;
  for (let j = 0; j < CHUNK_COLUMNS; j++) {
    const from = (b * CHUNK_COLUMNS + j) * GROUP_COLUMNS + a * CHUNK_COLUMNS;
    const row = heights.subarray(from, from + CHUNK_COLUMNS);
    out.set(row, columnIndex(0, j));
    if (!any) any = row.some((h) => h > 0);
  }
  return any ? out : null;
}

/**
 * Put a chunk's buildings into its structures layer: each column with a
 * height h stands h blocks over its terrain top (over the water, where the
 * column is under water). Columns without data take none.
 * @param {object} chunk store.js's
 * @param {Uint16Array|null} heights per column, in blocks
 * @returns {number} columns with a building
 */
export function applyStructures(chunk, heights, material = BUILDING) {
  if (!heights) return 0;
  let count = 0;
  for (let j = 0; j < CHUNK_COLUMNS; j++)
    for (let i = 0; i < CHUNK_COLUMNS; i++) {
      const index = columnIndex(i, j);
      const h = heights[index];
      const top = chunk.top[index];
      if (!h || top === NONE) continue;
      const water = chunk.water[index];
      const base = water === NONE ? top : Math.max(top, water);
      chunk.setStructure(i, j, base + h, material);
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
 * @param {{query?: (ql: string) => Promise<{elements: object[]}>,
 *   maxGroups?: number}} [options] query: the app's Overpass client
 *   (src/sources/overpassView.js through /api/overpass) unless given.
 */
export function createStructuresSource({ query, maxGroups = MAX_GROUPS } = {}) {
  if (!query)
    query = serialQuery(createOverpassViewClient({ minGapMs: QUERY_GAP_MS }));
  const held = new Map(); // group key → Promise<Map<chunk key, heights|null>>

  function remember(key, promise) {
    held.delete(key);
    held.set(key, promise);
    while (held.size > maxGroups) held.delete(held.keys().next().value);
  }

  /** A group's buildings by chunk key 'ci:cj': heights in blocks, or null. */
  function loadGroup(region, gi, gj) {
    const key = `${regionKey(region)}|g${gi}:${gj}`;
    const known = held.get(key);
    if (known) {
      remember(key, known);
      return known;
    }
    const promise = (async () => {
      const { elements } = await query(
        buildingsQuery(groupBounds(region, gi, gj)),
      );
      const placed = [];
      const heights = rasteriseGroup(
        region,
        gi,
        gj,
        parseFootprints(elements),
        placed,
      );
      const chunks = new Map();
      // The buildings placed in the group (their ids), beside the chunks.
      chunks.buildings = placed;
      for (let b = 0; b < CHUNK_GROUP; b++)
        for (let a = 0; a < CHUNK_GROUP; a++)
          chunks.set(
            `${gi * CHUNK_GROUP + a}:${gj * CHUNK_GROUP + b}`,
            chunkHeights(heights, a, b),
          );
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
     * A chunk's building heights in blocks (columnIndex order), or null
     * when it has none; from its group's one query.
     * @returns {Promise<Uint16Array|null>}
     */
    async loadChunkStructures(region, ci, cj) {
      const { gi, gj } = groupOf(ci, cj);
      return (await loadGroup(region, gi, gj)).get(`${ci}:${cj}`) ?? null;
    },
    /** The ids of the buildings placed in a group, from its one query. */
    async loadGroupBuildings(region, gi, gj) {
      return (await loadGroup(region, gi, gj)).buildings ?? [];
    },
    /** Groups held (for tests). */
    size: () => held.size,
    clear: () => held.clear(),
  };
}
