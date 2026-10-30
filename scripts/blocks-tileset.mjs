#!/usr/bin/env node
/**
 * Personal fork: build a Blocks tileset for a box (docs/BLOCKS-PLAN.md,
 * milestone 6, step A: the first cut, heights and water, no structures).
 *
 *   npm run blocks:tileset -- --bbox <w,s,e,n> --levels <finest m> --out <dir>
 *       [--coarsest <m>] [--base <values server, http://localhost:4173>]
 *       [--dry-run]
 *
 * The block world the live Blocks mode builds per view, built once: for
 * each pyramid level from the finest up (pyramid.js: ×4 from 30 m, levelM
 * by levelMFor), the chunk groups over the box are read and quantised by
 * the live source's own rules (source.js createChunkSource: the lattice
 * tiles, columnsFromHeights, the sea at 0 m and the water plane's lakes
 * above OSM_WATER_MAX_M), greedy-meshed by the live mesher (mesh.js), and
 * written as one glTF tile a group under a 3D Tiles 1.1 tileset.json.
 *
 * Heights come through a height reader: anything answering the values
 * request source.js asks ({layer, mode, box, cells, water} → {header,
 * values, water}). Today that is the app server's GET /api/raster/values
 * (read-only, its 30-day cache, Earth Engine's day budget for fresh
 * tiles); a local DEM reader (Copernicus GLO-30, 3DEP 1 m) answers the
 * same request once those files are approved and downloaded.
 *
 * The tree. Every level shares one anchor (the box's south-west corner on
 * the coarsest level's graticule) and so one east-north-up frame, so a
 * group of one level (4 × 4 chunks of 64 columns) is exactly one chunk of
 * the next level up: a tile's sixteen children are the groups under its
 * sixteen chunks. A child the box does not reach is that chunk of the
 * parent level alone (a fill tile), so a refined tile never leaves a hole
 * (REPLACE). Sixteen children a tile is not a quadtree, so the tree is
 * explicit (tileset.json lists every tile); see TILESET_FORMAT.
 *
 * Geometry. Each tile's glTF holds its chunks' meshes in the tile's frame
 * (the anchor's east-north-up moved to the tile's south-west corner),
 * written by the shared Blocks encoder (src/layers/blocks/gltf.js: the
 * bytes the live renderer draws, its layout and shader attributes,
 * _BLOCKCOORD folded by chunk, one feature row a chunk), then compressed
 * with EXT_meshopt_compression (compressGlb; Cesium decodes it). Heights
 * are mean sea level on the ellipsoid (the client raises the tileset by
 * the geoid's undulation, as the live renderer's datum offset), each
 * vertex dropped by where the ellipsoid lies under the tangent plane. Two
 * primitives: the opaque faces and the water (alpha blended). Chunks mesh
 * against their neighbours inside the tile;
 * along a tile's border they hang skirts down to the lowest ground any
 * level has there, so a tile beside a finer or coarser one shows no gap.
 *
 * --dry-run prints the levels, tiles and lattice tiles and asks nothing.
 * The tiles are written atomically (a temporary name, then a rename).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRasterValuesClient } from '../src/data/rasterValues.js';
import {
  CHUNK_COLUMNS,
  CURVED_BLOCK_M,
  createRegion,
  metresPerDegree,
  snapOrigin,
} from '../src/layers/blocks/grid.js';
import { latticeTilesOver } from '../src/layers/blocks/lattice.js';
import { buildChunkMesh } from '../src/layers/blocks/mesh.js';
import {
  FOLD_COLUMNS,
  encodeBlocksGlb,
  mergeParts,
} from '../src/layers/blocks/gltf.js';
import { splitMesh } from '../src/layers/blocks/renderer.js';
import { MeshoptEncoder } from 'meshoptimizer';
import { BLOCK_PYRAMID_M, levelMFor } from '../src/layers/blocks/pyramid.js';
import {
  CHUNK_GROUP,
  GROUP_COLUMNS,
  createChunkSource,
  groupBounds,
} from '../src/layers/blocks/source.js';
import { NONE, createChunk } from '../src/layers/blocks/store.js';
import {
  QUERY_GAP_MS,
  applyStructures,
  createStructuresSource,
  serialQuery,
} from '../src/layers/blocks/structures.js';
import {
  STRUCTURES_MAX_BLOCK_M,
  withoutBuildings,
} from '../src/layers/blocks/index.js';
import { createOverpassViewClient } from '../src/sources/overpassView.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await MeshoptEncoder.ready;

/** The app server the heights are read through by default (read-only GET). */
export const DEFAULT_BASE = 'http://localhost:4173';
/**
 * The levels a tileset may hold: the pyramid's ×4 chain from 30 m. A build
 * whose coarsest level is CURVED_BLOCK_M or more is curved: every level is
 * laid out on the azimuthal map from the box's middle and stood on the
 * ellipsoid, as the live renderer places its curved levels (mesh.js
 * curvedPlacement), so a finer level (480 m) nests in the curved ones.
 */
export const TILESET_LEVELS_M = Object.freeze(
  BLOCK_PYRAMID_M.filter((m) => m >= 30),
);
/** External tilesets: a subtree in its own JSON every this many levels below the root. */
export const SPLIT_DEPTH = 2;
/**
 * A finest level with more groups than this is built tile by tile
 * (streamed: each tile's chunks read when it is built, the skirts from a
 * first pass's summaries), so a country is never held whole.
 */
export const STREAM_GROUPS = 64;
/** What the tileset's asset says it is. */
export const TILESET_FORMAT = Object.freeze({
  version: '1.1',
  tree: 'explicit, split into external tilesets',
  children: CHUNK_GROUP * CHUNK_GROUP,
  refine: 'REPLACE',
  upAxis: 'Y',
  datum: 'mean sea level on the ellipsoid; the client adds the geoid',
});

/**
 * The command line: {bbox, finestM, coarsestM|null, out, base, dryRun},
 * or {error}.
 */
export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const box = String(value('--bbox') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite))
    return { error: '--bbox west,south,east,north is required' };
  const [west, south, east, north] = box;
  if (west < -180 || east > 180 || !(west < east))
    return { error: '--bbox needs -180 ≤ west < east ≤ 180' };
  if (south < -90 || north > 90 || !(south < north))
    return { error: '--bbox needs -90 ≤ south < north ≤ 90' };
  const level = (name) => {
    const text = value(name);
    if (text === undefined) return { m: null };
    const m = Number(text);
    return TILESET_LEVELS_M.includes(m)
      ? { m }
      : {
          error: `${name} must be a tileset level (${TILESET_LEVELS_M.join(', ')} m: the ×4 pyramid): not ${text}`,
        };
  };
  const finest = level('--levels');
  if (finest.error) return { error: finest.error };
  if (finest.m === null) return { error: '--levels <finest m> is required' };
  const coarsest = level('--coarsest');
  if (coarsest.error) return { error: coarsest.error };
  if (coarsest.m !== null && coarsest.m < finest.m)
    return { error: '--coarsest must be at least --levels' };
  const split = value('--split-depth');
  const splitDepth = split === undefined ? SPLIT_DEPTH : Number(split);
  if (!Number.isInteger(splitDepth) || splitDepth < 0)
    return { error: '--split-depth needs a whole number ≥ 0 (0: one JSON)' };
  const dryRun = argv.includes('--dry-run');
  const out = value('--out');
  if (!out && !dryRun) return { error: '--out <dir> is required' };
  return {
    bbox: { west, south, east, north },
    finestM: finest.m,
    coarsestM: coarsest.m,
    out: out ?? null,
    base: value('--base') ?? DEFAULT_BASE,
    structures: !argv.includes('--no-structures'),
    stream: argv.includes('--stream'),
    splitDepth,
    dryRun,
  };
}

/**
 * A level's region: the anchor's frame, the level's block and level
 * height; `curved` for a curved build (the azimuthal map at every level).
 */
export const levelRegion = (anchor, blockM, curved = false) =>
  createRegion({
    lon0: anchor.lon0,
    lat0: anchor.lat0,
    blockM,
    levelM: levelMFor(blockM),
    curved,
  });

/** The columns of a region a box covers: {i0, j0, i1, j1}, inclusive. */
export function boxColumns(region, bbox) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  // The edges' midpoints too: a lon/lat box is not a rectangle on the
  // plane; on the curved map, more of each edge.
  const steps = region.curved ? 16 : 2;
  for (let a = 0; a <= steps; a++)
    for (let b = 0; b <= steps; b++) {
      const u = a / steps;
      const v = b / steps;
      const { x, y } = region.toLocal(
        bbox.west + u * (bbox.east - bbox.west),
        bbox.south + v * (bbox.north - bbox.south),
      );
      xMin = Math.min(xMin, x);
      yMin = Math.min(yMin, y);
      xMax = Math.max(xMax, x);
      yMax = Math.max(yMax, y);
    }
  const b = region.blockM;
  // A box edge on a column edge (to a millimetre) does not take the column beyond.
  const lowOf = (m) => Math.floor(m / b + 1e-6);
  const highOf = (m) => Math.ceil(m / b - 1e-6) - 1;
  return {
    i0: lowOf(xMin),
    j0: lowOf(yMin),
    i1: highOf(xMax),
    j1: highOf(yMax),
  };
}

/**
 * The anchor for a box: the graticule point of the coarsest level (grid.js
 * snapOrigin) at or south-west of the box's south-west corner, so the box
 * starts in group (0, 0) of every level.
 */
export function anchorFor(bbox, blockM) {
  const perDegree = metresPerDegree(
    Math.max(-89, Math.min(89, Math.round(bbox.south))),
  );
  // Half a step back: snapOrigin's round becomes a floor.
  return snapOrigin(
    bbox.west - blockM / perDegree.lon / 2,
    bbox.south - blockM / perDegree.lat / 2,
    blockM,
  );
}

/**
 * A curved build's anchor: the coarsest level's graticule point nearest the
 * box's middle, where the azimuthal map is truest (3 % across at the lower
 * 48's corners, 2,700 km out).
 */
export const middleAnchorFor = (bbox, blockM) =>
  snapOrigin(
    (bbox.west + bbox.east) / 2,
    (bbox.south + bbox.north) / 2,
    blockM,
  );

const tileKey = (gi, gj) => `${gi}:${gj}`;

/** Whether two boxes in degrees overlap. */
const meetsBox = (a, b) =>
  a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;

/**
 * The tiles for a box: the levels (coarsest first, each ×4 the next), the
 * anchor, and per level the groups built. A level's groups are those the
 * box covers and the parents of the finer level's (the same ground).
 * A curved build (coarsest level CURVED_BLOCK_M or more) anchors at the
 * box's middle (middleAnchorFor), every level on the curved map.
 * @returns {{anchor: {lon0, lat0}, levels: number[], groups: Map<number,
 *   Map<string, {gi, gj}>>, curved: boolean}}
 */
export function planTiles(bbox, finestM, coarsestM = null) {
  const chain = TILESET_LEVELS_M.filter((m) => m >= finestM);
  // By default up to the first level above the finest whose one group holds the box.
  let top = coarsestM;
  if (top === null) {
    top = chain[chain.length - 1];
    for (const m of chain.slice(1)) {
      const anchor = anchorFor(bbox, m);
      const c = boxColumns(levelRegion(anchor, m), bbox);
      const g = (k) => Math.floor(k / GROUP_COLUMNS);
      if (g(c.i0) === g(c.i1) && g(c.j0) === g(c.j1)) {
        top = m;
        break;
      }
    }
  }
  const levels = chain.filter((m) => m <= top).reverse();
  const curved = levels[0] >= CURVED_BLOCK_M;
  const anchor = curved
    ? middleAnchorFor(bbox, levels[0])
    : anchorFor(bbox, levels[0]);
  const groups = new Map();
  let finer = null;
  for (const m of [...levels].reverse()) {
    const here = new Map();
    const region = levelRegion(anchor, m, curved);
    const c = boxColumns(region, bbox);
    for (
      let gj = Math.floor(c.j0 / GROUP_COLUMNS);
      gj <= Math.floor(c.j1 / GROUP_COLUMNS);
      gj++
    )
      for (
        let gi = Math.floor(c.i0 / GROUP_COLUMNS);
        gi <= Math.floor(c.i1 / GROUP_COLUMNS);
        gi++
      )
        // On the curved map the box is a bowed shape whose bounding
        // rectangle reaches far past its corners: only groups whose ground
        // meets the box (the box around the group's own corners).
        if (!curved || meetsBox(groupBounds(region, gi, gj), bbox))
          here.set(tileKey(gi, gj), { gi, gj });
    if (finer)
      for (const { gi, gj } of finer.values()) {
        const parent = {
          gi: Math.floor(gi / CHUNK_GROUP),
          gj: Math.floor(gj / CHUNK_GROUP),
        };
        here.set(tileKey(parent.gi, parent.gj), parent);
      }
    groups.set(m, here);
    finer = here;
  }
  return { anchor, levels, groups, curved };
}

/**
 * The tree: each tile {level, gi, gj, kind: 'group'|'fill', ci?, cj?,
 * children}. A group tile's children are, chunk by chunk, the finer
 * level's group under that chunk, or that chunk alone (a fill tile, a
 * leaf). Roots: the coarsest level's groups.
 */
export function tileTree(plan) {
  const { levels, groups } = plan;
  const make = (index, gi, gj) => {
    const level = levels[index];
    const tile = { level, kind: 'group', gi, gj, children: [] };
    const finerM = levels[index + 1];
    if (finerM === undefined) return tile;
    for (let b = 0; b < CHUNK_GROUP; b++)
      for (let a = 0; a < CHUNK_GROUP; a++) {
        const ci = gi * CHUNK_GROUP + a;
        const cj = gj * CHUNK_GROUP + b;
        // The finer group under chunk (ci, cj): the same ground.
        tile.children.push(
          groups.get(finerM).has(tileKey(ci, cj))
            ? make(index + 1, ci, cj)
            : { level, kind: 'fill', gi, gj, ci, cj, children: [] },
        );
      }
    return tile;
  };
  return [...groups.get(levels[0]).values()].map(({ gi, gj }) =>
    make(0, gi, gj),
  );
}

/** The chunks a tile holds: [ci, cj] pairs. */
export function tileChunks(tile) {
  if (tile.kind === 'fill') return [[tile.ci, tile.cj]];
  const chunks = [];
  for (let b = 0; b < CHUNK_GROUP; b++)
    for (let a = 0; a < CHUNK_GROUP; a++)
      chunks.push([tile.gi * CHUNK_GROUP + a, tile.gj * CHUNK_GROUP + b]);
  return chunks;
}

/** A tile's file, relative to the tileset. */
export const tileUri = (tile) =>
  tile.kind === 'fill'
    ? `${tile.level}m/c${tile.ci}_${tile.cj}.glb`
    : `${tile.level}m/g${tile.gi}_${tile.gj}.glb`;

/** A tile's south-west corner and side in region metres. */
function tileExtent(tile) {
  const chunkM = CHUNK_COLUMNS * tile.level;
  if (tile.kind === 'fill')
    return { x: tile.ci * chunkM, y: tile.cj * chunkM, side: chunkM };
  const side = chunkM * CHUNK_GROUP;
  return { x: tile.gi * side, y: tile.gj * side, side };
}

/** The tiles of a tree, depth first, parents before children. */
export function* walkTiles(tiles) {
  for (const tile of tiles) {
    yield tile;
    yield* walkTiles(tile.children);
  }
}

/**
 * Every level's chunks for the plan, read through `source` (source.js
 * createChunkSource, any height reader behind it): Map level → Map
 * 'ci:cj' → chunk.
 */
export async function loadChunks(plan, source) {
  const out = new Map();
  for (const m of plan.levels) {
    const region = levelRegion(plan.anchor, m, plan.curved);
    const chunks = new Map();
    for (const { gi, gj } of plan.groups.get(m).values())
      await Promise.all(
        Array.from({ length: CHUNK_GROUP * CHUNK_GROUP }, async (_, k) => {
          const ci = gi * CHUNK_GROUP + (k % CHUNK_GROUP);
          const cj = gj * CHUNK_GROUP + Math.floor(k / CHUNK_GROUP);
          chunks.set(tileKey(ci, cj), await source.loadChunk(region, ci, cj));
        }),
      );
    out.set(m, chunks);
  }
  return out;
}

/** A column's top at a level, or null (not built, or no data). */
function topAt(chunks, i, j) {
  const ci = Math.floor(i / CHUNK_COLUMNS);
  const cj = Math.floor(j / CHUNK_COLUMNS);
  const chunk = chunks.get(tileKey(ci, cj));
  if (!chunk) return null;
  const top =
    chunk.top[
      (j - cj * CHUNK_COLUMNS) * CHUNK_COLUMNS + (i - ci * CHUNK_COLUMNS)
    ];
  return top === NONE ? null : top;
}

/**
 * A chunk's lowest tops, for the skirt floors of a build that does not hold
 * every chunk (streamed): along each edge's columns (n, s, e, w) and over
 * the whole chunk (all); null where it has none.
 */
export function chunkSummary(chunk) {
  const N = CHUNK_COLUMNS;
  const low = { n: Infinity, s: Infinity, e: Infinity, w: Infinity };
  let all = Infinity;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const top = chunk.top[j * N + i];
      if (top === NONE) continue;
      if (top < all) all = top;
      if (j === N - 1 && top < low.n) low.n = top;
      if (j === 0 && top < low.s) low.s = top;
      if (i === N - 1 && top < low.e) low.e = top;
      if (i === 0 && top < low.w) low.w = top;
    }
  const or = (value) => (value === Infinity ? null : value);
  return {
    n: or(low.n),
    s: or(low.s),
    e: or(low.e),
    w: or(low.w),
    all: or(all),
  };
}

const isWhole = (value) => Math.abs(value - Math.round(value)) < 1e-9;

/**
 * A tile's skirt floors {n, s, e, w} in its level's levels: along each
 * border, the lowest top of the columns either side of it at every level
 * built (all levels share one levelM up to 480 m blocks; otherwise each
 * is converted through metres), so the skirt reaches whatever ground a
 * finer or coarser neighbour stands on there. With `summaries` (level →
 * 'ci:cj' → chunkSummary, a streamed build's), from those: a level whose
 * chunk edges lie on the border gives the same floor as its columns; a
 * coarser level whose chunks straddle it gives each such chunk's lowest
 * top, deeper than the columns would, never shallower.
 */
export function skirtFloors(tile, chunksByLevel, summaries = null) {
  const { x, y, side } = tileExtent(tile);
  const levelM = levelMFor(tile.level);
  const lines = {
    w: { along: 'y', at: x, from: y },
    e: { along: 'y', at: x + side, from: y },
    s: { along: 'x', at: y, from: x },
    n: { along: 'x', at: y + side, from: x },
  };
  const floors = {};
  for (const [name, line] of Object.entries(lines)) {
    let lowestM = Infinity;
    const lower = (top, m) => {
      if (top !== null && top !== undefined)
        lowestM = Math.min(lowestM, top * levelMFor(m));
    };
    for (const [m, byKey] of summaries ?? chunksByLevel) {
      if (!summaries) {
        const across = Math.round(line.at / m);
        const first = Math.floor(line.from / m);
        const count = Math.ceil(side / m);
        for (let k = first; k < first + count; k++)
          for (const c of [across - 1, across])
            lower(
              line.along === 'y' ? topAt(byKey, c, k) : topAt(byKey, k, c),
              m,
            );
        continue;
      }
      const chunkM = CHUNK_COLUMNS * m;
      const key = (c, k) =>
        line.along === 'y' ? tileKey(c, k) : tileKey(k, c);
      if (
        isWhole(line.at / chunkM) &&
        isWhole(line.from / chunkM) &&
        isWhole(side / chunkM)
      ) {
        // The border on this level's chunk edges: the chunk before it gives
        // its far edge (e or n), the one after it its near edge (w or s).
        const across = Math.round(line.at / chunkM);
        const first = Math.round(line.from / chunkM);
        for (let k = first; k < first + Math.round(side / chunkM); k++) {
          const before = byKey.get(key(across - 1, k));
          const after = byKey.get(key(across, k));
          lower(line.along === 'y' ? before?.e : before?.n, m);
          lower(line.along === 'y' ? after?.w : after?.s, m);
        }
        continue;
      }
      // A coarser level's chunks across the border: each one's lowest.
      const crossing = new Set([
        Math.floor((line.at - 1e-6) / chunkM),
        Math.floor((line.at + 1e-6) / chunkM),
      ]);
      const first = Math.floor(line.from / chunkM);
      const last = Math.floor((line.from + side - 1e-6) / chunkM);
      for (let k = first; k <= last; k++)
        for (const c of crossing) lower(byKey.get(key(c, k))?.all, m);
    }
    floors[name] =
      lowestM === Infinity ? null : Math.floor(lowestM / levelM + 1e-9);
  }
  return floors;
}

/**
 * A tile's mesh: its chunks meshed (neighbours inside the tile only, skirts
 * on the tile's borders) in the tile's frame. Flat: east-north-up metres
 * from its south-west corner, each vertex dropped onto the ellipsoid's
 * curve under the tangent plane. Curved (a curved region): each column
 * stood on the ellipsoid by the live mesher (mesh.js curvedPlacement, its
 * greedy runs capped by curvedRunCap) in the anchor's frame, then moved by
 * `toTile` (tileFrame) into the tile's own east-north-up frame.
 * @returns {{chunks: Array<{ci, cj, mesh}>, faces: number, vertices:
 *   number, indices: number, bounds: {min, max}|null}}
 */
export function tileMesh(
  tile,
  chunksByLevel,
  region,
  { summaries = null, toTile = null } = {},
) {
  const chunks = chunksByLevel.get(tile.level);
  const levelM = levelMFor(tile.level);
  const blockM = tile.level;
  const chunkM = CHUNK_COLUMNS * blockM;
  const inTile = new Set(tileChunks(tile).map(([ci, cj]) => tileKey(ci, cj)));
  const floors = skirtFloors(tile, chunksByLevel, summaries);
  const { x: tileX, y: tileY } = tileExtent(tile);
  const neighbourAt = (ci, cj) =>
    inTile.has(tileKey(ci, cj)) ? chunks.get(tileKey(ci, cj)) : undefined;
  const meshes = [];
  for (const [ci, cj] of tileChunks(tile)) {
    const chunk = chunks.get(tileKey(ci, cj));
    if (!chunk) continue;
    const neighbours = {};
    for (const [name, di, dj] of [
      ['n', 0, 1],
      ['s', 0, -1],
      ['e', 1, 0],
      ['w', -1, 0],
      ['ne', 1, 1],
      ['nw', -1, 1],
      ['se', 1, -1],
      ['sw', -1, -1],
    ]) {
      const next = neighbourAt(ci + di, cj + dj);
      if (next) neighbours[name] = next;
    }
    const skirt = {};
    for (const name of ['n', 's', 'e', 'w'])
      skirt[name] = neighbours[name] ? null : floors[name];
    const mesh = buildChunkMesh(chunk, {
      neighbours,
      blockM,
      levelM,
      skirt,
      ...(region.curved
        ? {
            curved: {
              lon0: region.lon0,
              lat0: region.lat0,
              regionBlockM: region.blockM,
              cornerM: { x: ci * chunkM, y: cj * chunkM },
              datumM: 0,
            },
          }
        : {}),
    });
    meshes.push({ mesh, ci, cj });
  }
  // The ellipsoid's drop under the tangent plane at region metres (x, y).
  const drops = new Map();
  const dropAt = (x, y) => {
    const key = `${x},${y}`;
    let drop = drops.get(key);
    if (drop === undefined) {
      drop = region.chunkOrigin(x / chunkM, y / chunkM).z;
      drops.set(key, drop);
    }
    return drop;
  };
  const placed = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  let faces = 0;
  let vertices = 0;
  let indices = 0;
  for (const { mesh, ci, cj } of meshes) {
    const count = mesh.positions.length / 3;
    const positions = new Float32Array(count * 3);
    const dx = ci * chunkM;
    const dy = cj * chunkM;
    for (let v = 0; v < count; v++) {
      if (region.curved) {
        // The anchor's frame (the mesh's origin plus its position), then the tile's.
        const ax = mesh.origin.x + mesh.positions[v * 3];
        const ay = mesh.origin.y + mesh.positions[v * 3 + 1];
        const az = mesh.origin.z + mesh.positions[v * 3 + 2];
        for (let c = 0; c < 3; c++)
          p[c] =
            toTile[c] * ax +
            toTile[4 + c] * ay +
            toTile[8 + c] * az +
            toTile[12 + c];
      } else {
        const x = mesh.positions[v * 3] + dx;
        const y = mesh.positions[v * 3 + 1] + dy;
        p[0] = x - tileX;
        p[1] = y - tileY;
        p[2] = mesh.positions[v * 3 + 2] + dropAt(x, y);
      }
      for (let c = 0; c < 3; c++) {
        positions[v * 3 + c] = p[c];
        if (p[c] < min[c]) min[c] = p[c];
        if (p[c] > max[c]) max[c] = p[c];
      }
    }
    placed.push({ ci, cj, mesh: { ...mesh, positions } });
    faces += mesh.faces;
    vertices += count;
    indices += mesh.indices.length;
  }
  return {
    chunks: placed,
    faces,
    vertices,
    indices,
    bounds: vertices ? { min, max } : null,
  };
}

/** The inverse of a rigid column-major 4 × 4 (a rotation and a translation). */
export function inverseRigid(m) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++)
    out[12 + r] = -(
      m[r * 4] * m[12] +
      m[r * 4 + 1] * m[13] +
      m[r * 4 + 2] * m[14]
    );
  out[15] = 1;
  return out;
}

/**
 * A curved build's tile frame: east-north-up on the ellipsoid at the
 * middle of the tile's ground (`world`, column-major, Earth-fixed), and
 * the move from the anchor's frame (the mesher's) into it (`toTile`).
 */
export function tileFrame(tile, region) {
  const { x, y, side } = tileExtent(tile);
  const middle = region.toLonLat(x + side / 2, y + side / 2);
  const world = enuTransform({ lon0: middle.lon, lat0: middle.lat });
  const anchor = enuTransform({ lon0: region.lon0, lat0: region.lat0 });
  return { world, toTile: multiplyTransform(inverseRigid(world), anchor) };
}

/**
 * The chunks of one tile, read through `source` (a streamed build's: the
 * tile's own level only; the skirts come from the summaries).
 */
export async function loadTileChunks(plan, source, tile) {
  const region = levelRegion(plan.anchor, tile.level, plan.curved);
  const chunks = new Map();
  const loaded = await Promise.all(
    tileChunks(tile).map(([ci, cj]) => source.loadChunk(region, ci, cj)),
  );
  tileChunks(tile).forEach(([ci, cj], k) =>
    chunks.set(tileKey(ci, cj), loaded[k]),
  );
  return new Map([[tile.level, chunks]]);
}

/**
 * Every built chunk's summary (chunkSummary), level by level, group by
 * group through `source`, holding none of the chunks: a streamed build's
 * first pass, for the skirt floors.
 * @returns {Promise<Map<number, Map<string, object>>>}
 */
export async function summarizeLevels(plan, source, { log = null } = {}) {
  const out = new Map();
  for (const m of plan.levels) {
    const region = levelRegion(plan.anchor, m, plan.curved);
    const byKey = new Map();
    const groups = [...plan.groups.get(m).values()];
    for (const [n, { gi, gj }] of groups.entries()) {
      const keys = [];
      const loads = [];
      for (let k = 0; k < CHUNK_GROUP * CHUNK_GROUP; k++) {
        const ci = gi * CHUNK_GROUP + (k % CHUNK_GROUP);
        const cj = gj * CHUNK_GROUP + Math.floor(k / CHUNK_GROUP);
        keys.push(tileKey(ci, cj));
        loads.push(source.loadChunk(region, ci, cj));
      }
      try {
        (await Promise.all(loads)).forEach((chunk, k) =>
          byKey.set(keys[k], chunkSummary(chunk)),
        );
      } catch (error) {
        // Left out: its skirts read as no ground there; a rerun reads it again.
        log?.(
          `summaries: ${m} m group ${gi}:${gj} failed (${error?.status ?? ''} ${error?.message ?? error})`.replace(
            /\s+/g,
            ' ',
          ),
        );
      }
      if (log && ((n + 1) % 50 === 0 || n + 1 === groups.length))
        log(`summaries: ${m} m, ${n + 1} of ${groups.length} groups read`);
    }
    out.set(m, byKey);
  }
  return out;
}

/**
 * A tile mesh as a binary glTF: the shared Blocks encoder's layout (gltf.js
 * encodeBlocksGlb, the same bytes the live renderer draws), each chunk's
 * faces split into opaque and water (renderer.js splitMesh), its block
 * points folded by its chunk, and one feature row a chunk (ci, cj and the
 * block size), compressed (compressGlb) unless `compress` is false. Null
 * when the tile has no faces.
 */
export function encodeTile({ chunks }, blockM, { compress = true } = {}) {
  const opaque = [];
  const water = [];
  chunks.forEach(({ ci, cj, mesh }, row) => {
    const parts = splitMesh(mesh);
    opaque.push({ part: parts.opaque, chunk: [ci, cj], feature: row });
    water.push({ part: parts.water, chunk: [ci, cj], feature: row });
  });
  const glb = encodeBlocksGlb({
    opaque: mergeParts(opaque),
    water: mergeParts(water),
    features: {
      count: chunks.length,
      properties: {
        ci: Int32Array.from(chunks, (chunk) => chunk.ci),
        cj: Int32Array.from(chunks, (chunk) => chunk.cj),
        blockM: Float32Array.from(chunks, () => blockM),
      },
    },
  });
  if (!glb) return null;
  return compress
    ? compressGlb(glb)
    : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

/** A GLB's JSON and its binary chunk. */
function splitGlb(glb) {
  const bytes = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binAt = 20 + jsonLength;
  const bin = bytes.subarray(binAt + 8, binAt + 8 + bytes.readUInt32LE(binAt));
  return { json, bin };
}

/** A GLB from its JSON and binary chunk, each padded to four bytes. */
function joinGlb(json, bin) {
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const body = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + body.length, 8);
  const chunk = (length, type) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(length, 0);
    out.writeUInt32LE(type, 4);
    return out;
  };
  return Buffer.concat([
    header,
    chunk(text.length, 0x4e4f534a), // 'JSON'
    text,
    chunk(body.length, 0x004e4942), // 'BIN\0'
    body,
  ]);
}

const COMPONENT_BYTES = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/**
 * A GLB with EXT_meshopt_compression (meshoptimizer's codecs, which
 * Cesium's glTF loader decodes): each primitive's vertices put in the order
 * its triangles use them (reorderMesh, as gltfpack does), then every vertex
 * attribute view encoded as ATTRIBUTES and every index view as TRIANGLES
 * into the GLB's buffer; the original layout stays as a fallback buffer
 * with no data, which the extension's loaders never read, so the extension
 * is required. Views it does not encode (the property table) are copied.
 */
export function compressGlb(glb) {
  const { json, bin } = splitGlb(glb);
  const data = Buffer.from(bin); // a copy: the reorder rewrites it
  const view = (index) => json.bufferViews[index];
  const accessorBytes = (accessor) => {
    const v = view(accessor.bufferView);
    const element =
      COMPONENT_BYTES[accessor.componentType] * TYPE_SIZE[accessor.type];
    const stride = v.byteStride || element;
    const at = v.byteOffset + (accessor.byteOffset || 0);
    return { at, stride, element };
  };
  // Each primitive's vertices in the order its triangles use them.
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) {
      const indexAccessor = json.accessors[primitive.indices];
      const ia = accessorBytes(indexAccessor);
      const Type =
        indexAccessor.componentType === 5123 ? Uint16Array : Uint32Array;
      const indices = Uint32Array.from(
        new Type(data.buffer, data.byteOffset + ia.at, indexAccessor.count),
      );
      const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, true);
      const target = new Type(
        data.buffer,
        data.byteOffset + ia.at,
        indexAccessor.count,
      );
      target.set(indices);
      for (const id of Object.values(primitive.attributes)) {
        const accessor = json.accessors[id];
        const { at, stride } = accessorBytes(accessor);
        const before = Buffer.from(
          data.subarray(at, at + accessor.count * stride),
        );
        for (let v = 0; v < accessor.count; v++) {
          const to = remap[v];
          if (to === 0xffffffff) continue;
          before.copy(data, at + to * stride, v * stride, v * stride + stride);
        }
        accessor.count = unique;
      }
    }
  // What each view holds: an attribute (its stride) or a primitive's indices.
  const roles = new Map();
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) {
      for (const id of Object.values(primitive.attributes)) {
        const accessor = json.accessors[id];
        const { stride } = accessorBytes(accessor);
        roles.set(accessor.bufferView, {
          mode: 'ATTRIBUTES',
          stride,
          count: accessor.count,
        });
      }
      const indexAccessor = json.accessors[primitive.indices];
      roles.set(indexAccessor.bufferView, {
        mode: 'TRIANGLES',
        stride: COMPONENT_BYTES[indexAccessor.componentType],
        count: indexAccessor.count,
      });
    }
  const parts = [];
  let length = 0;
  const append = (bytes) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    length += pad;
    const offset = length;
    parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    length += bytes.byteLength;
    return offset;
  };
  json.bufferViews = json.bufferViews.map((v, index) => {
    const raw = data.subarray(v.byteOffset, v.byteOffset + v.byteLength);
    const role = roles.get(index);
    if (!role || (role.mode === 'ATTRIBUTES' && role.stride % 4 !== 0)) {
      // Not encoded: its bytes, copied as they are.
      return { ...v, buffer: 0, byteOffset: append(raw) };
    }
    const source = raw.subarray(0, role.count * role.stride);
    const encoded =
      role.mode === 'ATTRIBUTES'
        ? MeshoptEncoder.encodeVertexBuffer(source, role.count, role.stride)
        : MeshoptEncoder.encodeIndexBuffer(source, role.count, role.stride);
    const byteOffset = append(encoded);
    return {
      ...v,
      buffer: 1,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset,
          byteLength: encoded.byteLength,
          byteStride: role.stride,
          count: role.count,
          mode: role.mode,
        },
      },
    };
  });
  const body = Buffer.concat(parts);
  json.buffers = [
    { byteLength: body.length },
    {
      byteLength: bin.length,
      extensions: { EXT_meshopt_compression: { fallback: true } },
    },
  ];
  const add = (list, name) => [...new Set([...(list || []), name])];
  json.extensionsUsed = add(json.extensionsUsed, 'EXT_meshopt_compression');
  json.extensionsRequired = add(
    json.extensionsRequired,
    'EXT_meshopt_compression',
  );
  return joinGlb(json, body);
}

/** The anchor's east-north-up frame on the ellipsoid as a column-major 4 × 4. */
export function enuTransform({ lon0, lat0 }) {
  const RAD = Math.PI / 180;
  const a = 6_378_137;
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const lon = lon0 * RAD;
  const lat = lat0 * RAD;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const origin = [
    n * Math.cos(lat) * Math.cos(lon),
    n * Math.cos(lat) * Math.sin(lon),
    n * (1 - e2) * Math.sin(lat),
  ];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  ];
  const up = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
  return [...east, 0, ...north, 0, ...up, 0, ...origin, 1];
}

/** A box bounding volume around a tile mesh's bounds (its frame, z up). */
function boxVolume(bounds, side) {
  if (!bounds) {
    // An empty tile still has its ground's footprint.
    return [side / 2, side / 2, 0, side / 2, 0, 0, 0, side / 2, 0, 0, 0, 1];
  }
  const { min, max } = bounds;
  const half = (c) => Math.max((max[c] - min[c]) / 2, 0.5);
  const mid = (c) => (max[c] + min[c]) / 2;
  return [mid(0), mid(1), mid(2), half(0), 0, 0, 0, half(1), 0, 0, 0, half(2)];
}

/** Write a file atomically: a temporary name beside it, then a rename. */
function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

/**
 * The files the tile digests cover besides the inputs: the build and the
 * mesher's (a change to either rebuilds every tile; the inputs, the
 * heights and the structures, are in each tile's digest as data).
 */
const CODE_FILES = [
  'scripts/blocks-tileset.mjs',
  'src/layers/blocks/mesh.js',
  'src/layers/blocks/gltf.js',
  'src/layers/blocks/lighting.js',
  'src/layers/blocks/store.js',
  'src/layers/blocks/grid.js',
];
let codeDigest = null;
/** The build's code, hashed once a run. */
function buildCodeDigest() {
  if (codeDigest) return codeDigest;
  const hash = createHash('sha256');
  for (const file of CODE_FILES)
    hash.update(fs.readFileSync(path.join(ROOT, file)));
  codeDigest = hash.digest('hex');
  return codeDigest;
}

/** A typed array's bytes, for a digest. */
const bytesOf = (array) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

/**
 * A tile's inputs' digest: the build's code, the tile, its skirt floors and
 * every column of its chunks (heightfield, surfaces and structures). A tile
 * already written with the same digest is not built again.
 */
export function tileDigest(tile, chunksByLevel, summaries = null) {
  const hash = createHash('sha256');
  hash.update(buildCodeDigest());
  hash.update(
    JSON.stringify({
      level: tile.level,
      kind: tile.kind,
      gi: tile.gi,
      gj: tile.gj,
      ci: tile.ci,
      cj: tile.cj,
      floors: skirtFloors(tile, chunksByLevel, summaries),
    }),
  );
  const chunks = chunksByLevel.get(tile.level);
  for (const [ci, cj] of tileChunks(tile)) {
    const chunk = chunks.get(tileKey(ci, cj));
    hash.update(`|${ci}:${cj}|`);
    if (!chunk) continue;
    hash.update(bytesOf(chunk.top));
    hash.update(bytesOf(chunk.material));
    hash.update(bytesOf(chunk.water));
    const structure = chunk.structure;
    if (structure)
      for (const array of [structure.top, structure.bottom, structure.material])
        hash.update(bytesOf(array));
  }
  return hash.digest('hex').slice(0, 32);
}

/** The build's record beside the tiles: each tile's digest, box and counts. */
export const BUILD_STATE = 'build-state.json';

function readState(out) {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(out, BUILD_STATE), 'utf8'),
    );
    return state && typeof state.tiles === 'object' ? state : { tiles: {} };
  } catch {
    return { tiles: {} };
  }
}

/**
 * Build the tilesets: every tile's glTF, and a tileset JSON a variant, under
 * `out`. `variants` ([{file, name, suffix, chunksByLevel | chunksFor}], the
 * first the default): the same tree drawn from different chunks, a tile's
 * file shared where a variant's chunks of its level are the first's (the
 * coarse levels), its own (`suffix` before .glb) where not (the fine levels
 * without their buildings). A streamed variant reads each tile's chunks
 * when it builds it (`chunksFor(tile)`), with `summaries` for the skirts.
 * A tile whose file exists with its inputs' digest unchanged (BUILD_STATE)
 * is kept, not built again; the state is written after each tile, so an
 * interrupted build resumes where it stopped. Every `splitDepth` levels
 * below the root a subtree goes into its own JSON (an external tileset,
 * `subtrees/<level>m/g<gi>_<gj>.json`), which Cesium loads when it
 * reaches it, so a country's tileset.json stays small.
 * @returns {Promise<{tiles: Array<{uri, level, kind, bytes, vertices,
 *   indices, faces, kept}>, tilesets: Map<string, object>, tileset:
 *   object, externals: string[]}>}
 */
export async function buildTileset(
  plan,
  chunksByLevel,
  {
    out,
    inputs = {},
    variants = null,
    summaries = null,
    splitDepth = SPLIT_DEPTH,
    log = null,
  },
) {
  variants ??= [{ file: 'tileset.json', suffix: '', chunksByLevel }];
  const base = variants[0].chunksByLevel;
  const roots = tileTree(plan);
  const regions = new Map(
    plan.levels.map((m) => [m, levelRegion(plan.anchor, m, plan.curved)]),
  );
  const state = readState(out);
  const writeState = () =>
    writeAtomic(path.join(out, BUILD_STATE), JSON.stringify(state));
  const tiles = [];
  const failed = []; // tiles whose heights did not come, left for a rerun
  const done = new Map(); // uri → {box, content}, this run
  const total = variants.length * [...walkTiles(roots)].length;
  const started = Date.now();
  let visited = 0;
  const buildTile = async (tile, variant, uri) => {
    visited++;
    const known = done.get(uri);
    if (known) return known;
    let chunks;
    try {
      chunks = variant.chunksFor
        ? await variant.chunksFor(tile)
        : variant.chunksByLevel;
    } catch (error) {
      failed.push(uri);
      log?.(
        `tile ${uri}: heights failed (${error?.status ?? ''} ${error?.message ?? error}); left for a rerun`,
      );
      const { side } = tileExtent(tile);
      const result = { box: boxVolume(null, side), content: false };
      done.set(uri, result);
      return result;
    }
    const digest = tileDigest(tile, chunks, summaries);
    const record = state.tiles[uri];
    const file = path.join(out, uri);
    let result;
    if (
      record?.digest === digest &&
      (record.bytes === 0 || fs.existsSync(file))
    ) {
      result = { box: record.box, content: record.bytes > 0 };
      tiles.push({ ...record.stats, uri, bytes: record.bytes, kept: true });
    } else {
      const region = regions.get(tile.level);
      const mesh = tileMesh(tile, chunks, region, {
        summaries,
        toTile: plan.curved ? tileFrame(tile, region).toTile : null,
      });
      const glb = encodeTile(mesh, tile.level);
      if (glb) writeAtomic(file, glb);
      const stats = {
        level: tile.level,
        kind: tile.kind,
        vertices: mesh.vertices,
        indices: mesh.indices,
        faces: mesh.faces,
      };
      result = {
        box: boxVolume(mesh.bounds, tileExtent(tile).side),
        content: Boolean(glb),
      };
      const bytes = glb ? glb.length : 0;
      state.tiles[uri] = { digest, box: result.box, bytes, stats };
      writeState();
      tiles.push({ ...stats, uri, bytes, kept: false });
    }
    done.set(uri, result);
    if (log && (visited % 25 === 0 || visited === total)) {
      const kept = tiles.filter((t) => t.kept).length;
      log(
        `${visited} of ${total} tiles: ${tiles.length - kept} built, ${kept} kept, ` +
          `${((Date.now() - started) / 1000).toFixed(0)} s`,
      );
    }
    return result;
  };
  const tilesets = new Map();
  const externals = [];
  for (const variant of variants) {
    const uriOf = (tile) =>
      variants.length === 1 ||
      variant.chunksByLevel?.get(tile.level) === base?.get(tile.level)
        ? tileUri(tile)
        : tileUri(tile).replace(/\.glb$/, `${variant.suffix}.glb`);
    const toJson = async (tile, parent, depth) => {
      const uri = uriOf(tile);
      const { box, content } = await buildTile(tile, variant, uri);
      const { x, y } = tileExtent(tile);
      let transform;
      let world = null;
      if (plan.curved) {
        // Each tile in its own east-north-up frame, relative to its parent's.
        world = tileFrame(tile, regions.get(tile.level)).world;
        transform = parent
          ? multiplyTransform(inverseRigid(parent.world), world)
          : world;
      } else {
        // Relative to the parent's frame (the root's to the anchor's).
        const origin = parent ? { x: x - parent.x, y: y - parent.y } : { x, y };
        transform = [
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          origin.x,
          origin.y,
          0,
          1,
        ];
      }
      const node = {
        transform,
        boundingVolume: { box },
        // The content's error is its block; a leaf is exact as far as the tree goes.
        geometricError: tile.children.length ? tile.level : 0,
        refine: 'REPLACE',
        ...(content ? { content: { uri } } : {}),
      };
      if (tile.children.length) {
        node.children = [];
        for (const child of tile.children)
          node.children.push(await toJson(child, { x, y, world }, depth + 1));
      }
      if (
        splitDepth > 0 &&
        depth > 0 &&
        depth % splitDepth === 0 &&
        node.children
      ) {
        // The subtree in its own JSON: its root in the referencing tile's
        // frame (no transform of its own), its files' paths from there.
        const file = `subtrees${variant.suffix}/${tile.level}m/g${tile.gi}_${tile.gj}.json`;
        const { transform: own, ...rest } = node;
        void own;
        writeAtomic(
          path.join(out, file),
          JSON.stringify({
            asset: {
              version: TILESET_FORMAT.version,
              generator: 'godseye scripts/blocks-tileset.mjs',
            },
            geometricError: node.geometricError,
            root: prefixUris(rest, '../../'),
          }),
        );
        externals.push(file);
        return {
          transform: node.transform,
          boundingVolume: node.boundingVolume,
          geometricError: node.geometricError,
          refine: 'REPLACE',
          content: { uri: file },
        };
      }
      return node;
    };
    const rootNodes = [];
    for (const root of roots) rootNodes.push(await toJson(root, null, 0));
    const coarsest = plan.levels[0];
    let root;
    if (rootNodes.length === 1)
      root = plan.curved
        ? rootNodes[0]
        : {
            ...rootNodes[0],
            transform: multiplyTransform(
              enuTransform(plan.anchor),
              rootNodes[0].transform,
            ),
          };
    else if (plan.curved)
      root = {
        // Several roots, each in its own Earth-fixed frame.
        boundingVolume: { sphere: enclosingSphere(rootNodes) },
        geometricError: coarsest * CHUNK_GROUP,
        refine: 'REPLACE',
        children: rootNodes,
      };
    else
      root = {
        transform: enuTransform(plan.anchor),
        boundingVolume: enclosingBox(rootNodes),
        geometricError: coarsest * CHUNK_GROUP,
        refine: 'REPLACE',
        children: rootNodes,
      };
    const tileset = {
      asset: {
        version: TILESET_FORMAT.version,
        generator: 'godseye scripts/blocks-tileset.mjs',
        extras: {
          blocks: {
            anchor: plan.anchor,
            curved: plan.curved,
            levelsM: plan.levels,
            levelHeightsM: plan.levels.map(levelMFor),
            chunkColumns: CHUNK_COLUMNS,
            chunkGroup: CHUNK_GROUP,
            format: { ...TILESET_FORMAT, splitDepth },
            // The encoder's (gltf.js): its block point folded by chunk.
            attributes: {
              _BLOCKCOORD: `columns east and north, the chunk's folded modulo ${FOLD_COLUMNS}, and the level`,
              _FEATURE_ID_0: 'the chunk: property table columns ci, cj, blockM',
            },
            compression: 'EXT_meshopt_compression',
            // The variant this file draws, and its siblings over the same tree.
            variant: variant.name ?? 'default',
            variants: variants.map(({ file, name }) => ({
              file,
              name: name ?? 'default',
            })),
            inputs,
          },
        },
      },
      geometricError: coarsest * CHUNK_GROUP * 2,
      root,
    };
    writeAtomic(path.join(out, variant.file), JSON.stringify(tileset, null, 1));
    tilesets.set(variant.file, tileset);
  }
  return {
    tiles,
    tilesets,
    tileset: tilesets.get(variants[0].file),
    externals,
    failed,
  };
}

/** A tree node with every content path given a prefix (an external tileset's, from its folder). */
function prefixUris(node, prefix) {
  return {
    ...node,
    ...(node.content ? { content: { uri: prefix + node.content.uri } } : {}),
    ...(node.children
      ? { children: node.children.map((child) => prefixUris(child, prefix)) }
      : {}),
  };
}

/** A sphere [x, y, z, r] (Earth-fixed) around several nodes' boxes in their own frames. */
function enclosingSphere(nodes) {
  const corners = [];
  for (const { transform: m, boundingVolume } of nodes) {
    const b = boundingVolume.box;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const local = [0, 1, 2].map(
            (c) => b[c] + sx * b[3 + c] + sy * b[6 + c] + sz * b[9 + c],
          );
          corners.push(
            [0, 1, 2].map(
              (c) =>
                m[c] * local[0] +
                m[4 + c] * local[1] +
                m[8 + c] * local[2] +
                m[12 + c],
            ),
          );
        }
  }
  const centre = [0, 1, 2].map(
    (c) =>
      (Math.min(...corners.map((p) => p[c])) +
        Math.max(...corners.map((p) => p[c]))) /
      2,
  );
  const radius = Math.max(
    ...corners.map((p) =>
      Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]),
    ),
  );
  return [...centre, radius];
}

/**
 * A chunk's copy (store.js createChunk over copies of its columns), for a
 * variant to paint and build on without touching the source's cached one.
 */
const copyChunk = (chunk) =>
  createChunk({
    ci: chunk.ci,
    cj: chunk.cj,
    top: chunk.top.slice(),
    material: chunk.material.slice(),
    water: chunk.water.slice(),
  });

/**
 * The OSM structures at the levels the live controller applies them
 * (STRUCTURES_MAX_BLOCK_M and finer: land cover, roads, bridge decks and
 * buildings by structures.js's rules), group by group through
 * `structures` (createStructuresSource: one Overpass query a group, one at
 * a time and paced). Two variants of those levels' chunks, as the
 * Buildings switch has them since the land-cover fix: `built` with the
 * buildings, `ground` without (index.js withoutBuildings: the land cover
 * and the decks kept). Coarser levels are the heights alone, shared.
 * @returns {Promise<{built: Map, ground: Map, levels: number[]}>} each
 *   level → 'ci:cj' → chunk
 */
export async function loadStructures(plan, chunksByLevel, structures) {
  const built = new Map(chunksByLevel);
  const ground = new Map(chunksByLevel);
  const levels = plan.levels.filter((m) => m <= STRUCTURES_MAX_BLOCK_M);
  for (const m of levels) {
    const region = levelRegion(plan.anchor, m, plan.curved);
    const withBuildings = new Map();
    const without = new Map();
    for (const [key, chunk] of chunksByLevel.get(m)) {
      const answer = await structures.loadChunkStructures(
        region,
        chunk.ci,
        chunk.cj,
      );
      const a = copyChunk(chunk);
      const b = copyChunk(chunk);
      applyStructures(a, answer);
      applyStructures(b, withoutBuildings(answer));
      withBuildings.set(key, a);
      without.set(key, b);
    }
    built.set(m, withBuildings);
    ground.set(m, without);
  }
  return { built, ground, levels };
}

/** a × b, column-major 4 × 4. */
function multiplyTransform(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** A box around several tiles' boxes (each translated by its transform). */
function enclosingBox(nodes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    const { box } = node.boundingVolume;
    const shift = [node.transform[12], node.transform[13], node.transform[14]];
    const half = [box[3], box[7], box[11]];
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], box[c] + shift[c] - half[c]);
      max[c] = Math.max(max[c], box[c] + shift[c] + half[c]);
    }
  }
  const mid = (c) => (max[c] + min[c]) / 2;
  const half = (c) => (max[c] - min[c]) / 2;
  return {
    box: [mid(0), mid(1), mid(2), half(0), 0, 0, 0, half(1), 0, 0, 0, half(2)],
  };
}

/** The lattice tiles a plan asks, per level (each fresh one counts against Earth Engine's day). */
export function planLatticeTiles(plan) {
  const out = new Map();
  for (const m of plan.levels) {
    const region = levelRegion(plan.anchor, m, plan.curved);
    const keys = new Set();
    for (const { gi, gj } of plan.groups.get(m).values())
      for (const { ti, tj } of latticeTilesOver(groupBounds(region, gi, gj), m))
        keys.add(`${ti}:${tj}`);
    out.set(m, keys.size);
  }
  return out;
}

/**
 * The height reader through the app server: source.js's values request
 * answered by GET {base}/api/raster/values. A local DEM reader takes its
 * place by answering the same request ({layer, mode, box, cells, water}
 * → {header: {west, south, east, north, cols, rows}, values, water?}).
 */
export function serverHeightReader({ base = DEFAULT_BASE, fetchImpl } = {}) {
  const client = createRasterValuesClient({
    base,
    maxEntries: 16,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return (request) => client.get(request);
}

/**
 * The Overpass queries through the app server's proxy (POST
 * {base}/api/overpass, the local clone behind it), one at a time and
 * QUERY_GAP_MS apart as the live Blocks asks them; `count()` the queries
 * sent.
 */
export function serverOverpass({ base = DEFAULT_BASE, fetchImpl } = {}) {
  let sent = 0;
  const query = serialQuery(
    createOverpassViewClient({
      url: `${base}/api/overpass`,
      minGapMs: QUERY_GAP_MS,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  );
  const counted = (ql) => {
    sent++;
    return query(ql);
  };
  counted.count = () => sent;
  return counted;
}

/**
 * Run: plan, read, build, report.
 * @param {{argv?: string[], fetchValues?: Function, query?: Function, log?:
 *   Function}} options fetchValues: the height reader (serverHeightReader's
 *   unless given); query: the Overpass query (serverOverpass's unless given).
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  fetchValues,
  query,
  log: print = console.log,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    print(args.error);
    return 2;
  }
  const startedAt = Date.now();
  // Every line to the console and, once there is an output, its build.log.
  const logFile = args.out ? path.join(args.out, 'build.log') : null;
  const log = (line) => {
    print(line);
    if (!logFile) return;
    fs.mkdirSync(args.out, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  };
  const plan = planTiles(args.bbox, args.finestM, args.coarsestM);
  const tree = tileTree(plan);
  const all = [...walkTiles(tree)];
  const lattice = planLatticeTiles(plan);
  const finestGroups = plan.groups.get(
    plan.levels[plan.levels.length - 1],
  ).size;
  const streamed = args.stream || finestGroups > STREAM_GROUPS;
  log(
    `levels ${plan.levels.join(', ')} m${plan.curved ? ' (curved)' : ''}; ${all.length} tiles (` +
      plan.levels
        .map((m) => {
          const here = all.filter((tile) => tile.level === m);
          const fills = here.filter((tile) => tile.kind === 'fill').length;
          return `${m} m: ${here.length - fills} groups${fills ? ` + ${fills} fill` : ''}`;
        })
        .join(', ') +
      `); lattice tiles to read: ${[...lattice].map(([m, n]) => `${m} m: ${n}`).join(', ')} (a cached one costs nothing)` +
      (streamed ? '; streamed tile by tile' : ''),
  );
  if (args.dryRun) return 0;
  // Earth Engine's day as the app server counts it (other sessions' use counts too).
  const budget = async () => {
    if (fetchValues) return null;
    try {
      const answer = await fetch(`${args.base}/api/earth-engine/budget`);
      return answer.ok ? (await answer.json()).total : null;
    } catch {
      return null;
    }
  };
  const budgetBefore = await budget();
  // The server's own word on each read (X-Raster-Values-Cache: hit or
  // miss): a miss is an Earth Engine tile this build fetched itself.
  const cache = { hit: 0, miss: 0, unsaid: 0 };
  const asked =
    fetchValues ??
    serverHeightReader({
      base: args.base,
      fetchImpl: async (...request) => {
        const answer = await fetch(...request);
        const said = answer.headers.get('x-raster-values-cache');
        cache[said === 'hit' || said === 'miss' ? said : 'unsaid']++;
        return answer;
      },
    });
  // Every values read that fails, logged with its time (the chunk source
  // asks a 503 again after 5 and 20 s; a 429 is the day's budget).
  let firstFailure = null;
  const reader = (request) =>
    Promise.resolve(asked(request)).catch((error) => {
      const line = `values ${error?.status ?? '?'} at ${request.cells ?? ''} cells over ${JSON.stringify(request.box)}: ${error?.message ?? error}`;
      firstFailure ??= new Date().toISOString();
      log(line);
      throw error;
    });
  const source = createChunkSource({
    fetchValues: reader,
    maxChunks: streamed ? 512 : 4096,
  });
  let started = Date.now();
  let chunksByLevel = null;
  let summaries = null;
  let variants = null;
  const structureLevels = plan.levels.filter(
    (m) => m <= STRUCTURES_MAX_BLOCK_M,
  );
  if (streamed) {
    summaries = await summarizeLevels(plan, source, { log });
    log(`summaries read in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (args.structures && structureLevels.length)
      log('structures need the whole box held: none in a streamed build');
    variants = [
      {
        file: 'tileset.json',
        suffix: '',
        chunksFor: (tile) => loadTileChunks(plan, source, tile),
      },
    ];
  } else {
    chunksByLevel = await loadChunks(plan, source);
    log(`heights read in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  if (!streamed && args.structures && structureLevels.length) {
    const overpass = query ?? serverOverpass({ base: args.base });
    const structures = createStructuresSource({
      loadChunk: (region, ci, cj) => source.loadChunk(region, ci, cj),
      query: overpass,
    });
    started = Date.now();
    const { built, ground } = await loadStructures(
      plan,
      chunksByLevel,
      structures,
    );
    const count = overpass.count?.();
    log(
      `structures at ${structureLevels.join(', ')} m in ${((Date.now() - started) / 1000).toFixed(1)} s` +
        (count === undefined ? '' : `, ${count} Overpass queries`),
    );
    variants = [
      {
        file: 'tileset.json',
        name: 'buildings',
        suffix: '',
        chunksByLevel: built,
      },
      {
        file: 'tileset-ground.json',
        name: 'ground',
        suffix: '.ground',
        chunksByLevel: ground,
      },
    ];
  }
  const { tiles, externals, failed } = await buildTileset(plan, chunksByLevel, {
    out: args.out,
    variants,
    summaries,
    splitDepth: args.splitDepth,
    log,
    inputs: {
      heights: fetchValues
        ? 'a given reader'
        : `${args.base}/api/raster/values`,
      structures:
        variants?.length > 1
          ? query
            ? 'a given query'
            : `${args.base}/api/overpass`
          : 'none',
    },
  });
  const kept = tiles.filter((tile) => tile.kept).length;
  if (kept) log(`${kept} of ${tiles.length} tiles kept (inputs unchanged)`);
  for (const m of plan.levels) {
    const here = tiles.filter((tile) => tile.level === m);
    const sum = (key) => here.reduce((n, tile) => n + tile[key], 0);
    log(
      `${m} m: ${here.length} tiles, ${(sum('bytes') / 1024).toFixed(0)} KiB, ` +
        `${sum('vertices')} vertices, ${sum('indices') / 3} triangles, ` +
        `largest ${(Math.max(...here.map((tile) => tile.bytes)) / 1024).toFixed(0)} KiB`,
    );
  }
  if (externals.length) log(`${externals.length} external tilesets`);
  if (failed.length)
    log(
      `${failed.length} tiles without heights, left for a rerun: ${failed.join(', ')}`,
    );
  if (firstFailure) log(`first failed values read at ${firstFailure}`);
  if (!fetchValues)
    log(
      `values reads: ${cache.hit} cache hits, ${cache.miss} misses (fetched from Earth Engine by this build)` +
        (cache.unsaid ? `, ${cache.unsaid} unsaid` : ''),
    );
  const budgetAfter = await budget();
  if (budgetBefore !== null && budgetAfter !== null)
    log(
      `Earth Engine today: ${budgetBefore} → ${budgetAfter} tiles (anyone's, during this build)`,
    );
  log(
    `written to ${args.out} in ${((Date.now() - startedAt) / 1000).toFixed(0)} s`,
  );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error?.message || error);
      process.exit(1);
    },
  );
