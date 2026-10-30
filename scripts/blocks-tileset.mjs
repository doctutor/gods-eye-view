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
 * Geometry. Each tile's glTF holds its chunks' meshes merged, in the
 * tile's frame (the anchor's east-north-up moved to the tile's south-west
 * corner), y up as glTF has it (east, up, −north). Heights are mean sea
 * level on the ellipsoid (the client raises the tileset by the geoid's
 * undulation, as the live renderer's datum offset), each vertex dropped by
 * where the ellipsoid lies under the tangent plane. Attributes: POSITION,
 * NORMAL, COLOR_0 (the mesher's baked study-sun colour, alpha for water)
 * and _BLOCK_COORD (the block point: columns east and north from the
 * anchor, and the level). Two primitives: the opaque faces and the water
 * (alpha blended). Chunks mesh against their neighbours inside the tile;
 * along a tile's border they hang skirts down to the lowest ground any
 * level has there, so a tile beside a finer or coarser one shows no gap.
 *
 * --dry-run prints the levels, tiles and lattice tiles and asks nothing.
 * The tiles are written atomically (a temporary name, then a rename).
 */
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
import { BLOCK_PYRAMID_M, levelMFor } from '../src/layers/blocks/pyramid.js';
import {
  CHUNK_GROUP,
  GROUP_COLUMNS,
  createChunkSource,
  groupBounds,
} from '../src/layers/blocks/source.js';
import { NONE } from '../src/layers/blocks/store.js';

/** The app server the heights are read through by default (read-only GET). */
export const DEFAULT_BASE = 'http://localhost:4173';
/**
 * The levels a tileset may hold: the pyramid's ×4 chain from 30 m, flat
 * (under CURVED_BLOCK_M: a curved level's columns stand on the sphere,
 * not on one tangent frame; a later cut).
 */
export const TILESET_LEVELS_M = Object.freeze(
  BLOCK_PYRAMID_M.filter((m) => m >= 30 && m < CURVED_BLOCK_M),
);
/** What the tileset's asset says it is. */
export const TILESET_FORMAT = Object.freeze({
  version: '1.1',
  tree: 'explicit',
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
          error: `${name} must be a tileset level (${TILESET_LEVELS_M.join(', ')} m: the ×4 pyramid, flat): not ${text}`,
        };
  };
  const finest = level('--levels');
  if (finest.error) return { error: finest.error };
  if (finest.m === null) return { error: '--levels <finest m> is required' };
  const coarsest = level('--coarsest');
  if (coarsest.error) return { error: coarsest.error };
  if (coarsest.m !== null && coarsest.m < finest.m)
    return { error: '--coarsest must be at least --levels' };
  const dryRun = argv.includes('--dry-run');
  const out = value('--out');
  if (!out && !dryRun) return { error: '--out <dir> is required' };
  return {
    bbox: { west, south, east, north },
    finestM: finest.m,
    coarsestM: coarsest.m,
    out: out ?? null,
    base: value('--base') ?? DEFAULT_BASE,
    dryRun,
  };
}

/** A level's region: the anchor's frame, the level's block and level height. */
export const levelRegion = (anchor, blockM) =>
  createRegion({
    lon0: anchor.lon0,
    lat0: anchor.lat0,
    blockM,
    levelM: levelMFor(blockM),
  });

/** The columns of a region a box covers: {i0, j0, i1, j1}, inclusive. */
export function boxColumns(region, bbox) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  // The edges' midpoints too: a lon/lat box is not a rectangle on the plane.
  for (const u of [0, 0.5, 1])
    for (const v of [0, 0.5, 1]) {
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

const tileKey = (gi, gj) => `${gi}:${gj}`;

/**
 * The tiles for a box: the levels (coarsest first, each ×4 the next), the
 * anchor, and per level the groups built. A level's groups are those the
 * box covers and the parents of the finer level's (the same ground).
 * @returns {{anchor: {lon0, lat0}, levels: number[], groups: Map<number,
 *   Map<string, {gi, gj}>>}}
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
  const anchor = anchorFor(bbox, levels[0]);
  const groups = new Map();
  let finer = null;
  for (const m of [...levels].reverse()) {
    const here = new Map();
    const c = boxColumns(levelRegion(anchor, m), bbox);
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
  return { anchor, levels, groups };
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
    const region = levelRegion(plan.anchor, m);
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
 * A tile's skirt floors {n, s, e, w} in its level's levels: along each
 * border, the lowest top of the columns either side of it at every level
 * built (all levels share one levelM up to 480 m blocks; otherwise each
 * is converted through metres), so the skirt reaches whatever ground a
 * finer or coarser neighbour stands on there.
 */
export function skirtFloors(tile, chunksByLevel) {
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
    for (const [m, chunks] of chunksByLevel) {
      const across = Math.round(line.at / m);
      const first = Math.floor(line.from / m);
      const count = Math.ceil(side / m);
      for (let k = first; k < first + count; k++)
        for (const c of [across - 1, across]) {
          const top =
            line.along === 'y' ? topAt(chunks, c, k) : topAt(chunks, k, c);
          if (top !== null) lowestM = Math.min(lowestM, top * levelMFor(m));
        }
    }
    floors[name] =
      lowestM === Infinity ? null : Math.floor(lowestM / levelM + 1e-9);
  }
  return floors;
}

/**
 * A tile's mesh: its chunks meshed (neighbours inside the tile only, skirts
 * on the tile's borders) and merged in the tile's frame, east-north-up
 * metres from its south-west corner, each vertex dropped onto the
 * ellipsoid's curve under the tangent plane. Opaque indices first, then
 * the water's.
 * @returns {{positions: Float32Array, normals: Float32Array, colors:
 *   Uint8Array, blockCoords: Float32Array, indices: Uint32Array,
 *   opaqueIndexCount: number, faces: number}}
 */
export function tileMesh(tile, chunksByLevel, region) {
  const chunks = chunksByLevel.get(tile.level);
  const levelM = levelMFor(tile.level);
  const blockM = tile.level;
  const chunkM = CHUNK_COLUMNS * blockM;
  const inTile = new Set(tileChunks(tile).map(([ci, cj]) => tileKey(ci, cj)));
  const floors = skirtFloors(tile, chunksByLevel);
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
    const mesh = buildChunkMesh(chunk, { neighbours, blockM, levelM, skirt });
    meshes.push({ mesh, ci, cj });
  }
  const vertexCount = meshes.reduce(
    (n, { mesh }) => n + mesh.positions.length / 3,
    0,
  );
  const indexCount = meshes.reduce((n, { mesh }) => n + mesh.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 4);
  const blockCoords = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const opaqueTotal = meshes.reduce(
    (n, { mesh }) => n + mesh.opaqueIndexCount,
    0,
  );
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
  let vertexBase = 0;
  let opaqueAt = 0;
  let waterAt = opaqueTotal;
  let faces = 0;
  for (const { mesh, ci, cj } of meshes) {
    const count = mesh.positions.length / 3;
    const dx = ci * chunkM;
    const dy = cj * chunkM;
    for (let v = 0; v < count; v++) {
      const x = mesh.positions[v * 3] + dx;
      const y = mesh.positions[v * 3 + 1] + dy;
      const o = (vertexBase + v) * 3;
      positions[o] = x - tileX;
      positions[o + 1] = y - tileY;
      positions[o + 2] = mesh.positions[v * 3 + 2] + dropAt(x, y);
      blockCoords[o] = mesh.blockCoords[v * 3] + ci * CHUNK_COLUMNS;
      blockCoords[o + 1] = mesh.blockCoords[v * 3 + 1] + cj * CHUNK_COLUMNS;
      blockCoords[o + 2] = mesh.blockCoords[v * 3 + 2];
    }
    normals.set(mesh.normals, vertexBase * 3);
    colors.set(mesh.colors, vertexBase * 4);
    for (let k = 0; k < mesh.indices.length; k++) {
      const index = mesh.indices[k] + vertexBase;
      if (k < mesh.opaqueIndexCount) indices[opaqueAt++] = index;
      else indices[waterAt++] = index;
    }
    vertexBase += count;
    faces += mesh.faces;
  }
  return {
    positions,
    normals,
    colors,
    blockCoords,
    indices,
    opaqueIndexCount: opaqueTotal,
    faces,
  };
}

/** East, north, up to glTF's y up: (e, u, −n) (Cesium turns it back). */
function yUp(source) {
  const out = new Float32Array(source.length);
  for (let k = 0; k < source.length; k += 3) {
    // + 0: no -0 (JSON's min and max cannot say it).
    out[k] = source[k] + 0;
    out[k + 1] = source[k + 2] + 0;
    out[k + 2] = 0 - source[k + 1];
  }
  return out;
}

/** The min and max of each component of a VEC3 float array. */
function bounds3(values) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < values.length; k += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], values[k + c]);
      max[c] = Math.max(max[c], values[k + c]);
    }
  return { min, max };
}

/**
 * A tile mesh as a binary glTF 2.0: one mesh, a primitive for the opaque
 * faces and one for the water (alpha blended), sharing the vertex
 * attributes POSITION, NORMAL, COLOR_0 (normalised bytes) and _BLOCK_COORD;
 * unlit materials (the colours are baked). Indices are 16-bit when the
 * vertices allow. Null when the mesh is empty.
 */
export function encodeGlb(mesh) {
  const vertexCount = mesh.positions.length / 3;
  if (!vertexCount || !mesh.indices.length) return null;
  const parts = [];
  let byteLength = 0;
  const bufferViews = [];
  const add = (typed, target) => {
    const bytes = new Uint8Array(
      typed.buffer,
      typed.byteOffset,
      typed.byteLength,
    );
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.byteLength,
      target,
    });
    parts.push(bytes);
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;
  const FLOAT = 5126;
  const positions = yUp(mesh.positions);
  const normals = yUp(mesh.normals);
  const { min, max } = bounds3(positions);
  const accessors = [
    {
      bufferView: add(positions, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC3',
      min,
      max,
    },
    {
      bufferView: add(normals, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC3',
    },
    {
      bufferView: add(mesh.colors, ARRAY_BUFFER),
      componentType: 5121,
      normalized: true,
      count: vertexCount,
      type: 'VEC4',
    },
    {
      bufferView: add(mesh.blockCoords, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC3',
    },
  ];
  const short = vertexCount <= 0xffff;
  const indices = short ? Uint16Array.from(mesh.indices) : mesh.indices;
  const indexView = add(indices, ELEMENT_ARRAY_BUFFER);
  const attributes = { POSITION: 0, NORMAL: 1, COLOR_0: 2, _BLOCK_COORD: 3 };
  const primitives = [];
  const ranges = [
    [0, mesh.opaqueIndexCount, 0],
    [mesh.opaqueIndexCount, mesh.indices.length, 1],
  ];
  for (const [from, to, material] of ranges) {
    if (to <= from) continue;
    accessors.push({
      bufferView: indexView,
      byteOffset: from * indices.BYTES_PER_ELEMENT,
      componentType: short ? 5123 : 5125,
      count: to - from,
      type: 'SCALAR',
    });
    primitives.push({
      attributes,
      indices: accessors.length - 1,
      material,
      mode: 4,
    });
  }
  const unlit = { KHR_materials_unlit: {} };
  const json = {
    asset: { version: '2.0', generator: 'godseye scripts/blocks-tileset.mjs' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: [
      {
        name: 'blocks',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extensions: unlit,
      },
      {
        name: 'water',
        alphaMode: 'BLEND',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extensions: unlit,
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const tail = (4 - (byteLength % 4)) % 4;
  if (tail) {
    parts.push(new Uint8Array(tail));
    byteLength += tail;
  }
  json.buffers[0].byteLength = byteLength;
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + text.length + 8 + byteLength;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = (length, type) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(length, 0);
    out.writeUInt32LE(type, 4);
    return out;
  };
  return Buffer.concat([
    header,
    chunkHeader(text.length, 0x4e4f534a), // 'JSON'
    text,
    chunkHeader(byteLength, 0x004e4942), // 'BIN\0'
    ...parts.map((part) =>
      Buffer.from(part.buffer, part.byteOffset, part.byteLength),
    ),
  ]);
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

/** A box bounding volume around a tile mesh's positions (its frame, z up). */
function boxVolume(positions, side) {
  if (!positions.length) {
    // An empty tile still has its ground's footprint.
    return [side / 2, side / 2, 0, side / 2, 0, 0, 0, side / 2, 0, 0, 0, 1];
  }
  const { min, max } = bounds3(positions);
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
 * Build the tileset: every tile's glTF and the tileset.json, under `out`.
 * @returns {{tiles: Array<{uri, level, kind, bytes, vertices, indices,
 *   faces}>, tileset: object}}
 */
export function buildTileset(plan, chunksByLevel, { out, inputs = {} }) {
  const roots = tileTree(plan);
  const regions = new Map(
    plan.levels.map((m) => [m, levelRegion(plan.anchor, m)]),
  );
  const tiles = [];
  const toJson = (tile, parent = null) => {
    const mesh = tileMesh(tile, chunksByLevel, regions.get(tile.level));
    const glb = encodeGlb(mesh);
    const uri = tileUri(tile);
    if (glb) writeAtomic(path.join(out, uri), glb);
    tiles.push({
      uri,
      level: tile.level,
      kind: tile.kind,
      bytes: glb ? glb.length : 0,
      vertices: mesh.positions.length / 3,
      indices: mesh.indices.length,
      faces: mesh.faces,
    });
    const { x, y, side } = tileExtent(tile);
    const origin = parent ? { x: x - parent.x, y: y - parent.y } : { x, y };
    const node = {
      // Relative to the parent's frame (the root's to the anchor's).
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin.x, origin.y, 0, 1],
      boundingVolume: { box: boxVolume(mesh.positions, side) },
      // The content's error is its block; a leaf is exact as far as the tree goes.
      geometricError: tile.children.length ? tile.level : 0,
      refine: 'REPLACE',
      ...(glb ? { content: { uri } } : {}),
    };
    if (tile.children.length)
      node.children = tile.children.map((child) => toJson(child, { x, y }));
    return node;
  };
  const rootNodes = roots.map((root) => toJson(root));
  const rootFrame = enuTransform(plan.anchor);
  const coarsest = plan.levels[0];
  const root =
    rootNodes.length === 1
      ? {
          ...rootNodes[0],
          transform: multiplyTransform(rootFrame, rootNodes[0].transform),
        }
      : {
          transform: rootFrame,
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
          levelsM: plan.levels,
          levelHeightsM: plan.levels.map(levelMFor),
          chunkColumns: CHUNK_COLUMNS,
          chunkGroup: CHUNK_GROUP,
          format: TILESET_FORMAT,
          attributes: {
            _BLOCK_COORD:
              'columns east and north of the anchor at the tile level, and the level',
          },
          inputs,
        },
      },
    },
    geometricError: coarsest * CHUNK_GROUP * 2,
    root,
  };
  writeAtomic(path.join(out, 'tileset.json'), JSON.stringify(tileset, null, 1));
  return { tiles, tileset };
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
    const region = levelRegion(plan.anchor, m);
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
 * Run: plan, read, build, report.
 * @param {{argv?: string[], fetchValues?: Function, log?: Function}} options
 *   fetchValues: the height reader (serverHeightReader's unless given).
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  fetchValues,
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const plan = planTiles(args.bbox, args.finestM, args.coarsestM);
  const tree = tileTree(plan);
  const all = [...walkTiles(tree)];
  const lattice = planLatticeTiles(plan);
  log(
    `levels ${plan.levels.join(', ')} m; ${all.length} tiles (` +
      plan.levels
        .map((m) => {
          const here = all.filter((tile) => tile.level === m);
          const fills = here.filter((tile) => tile.kind === 'fill').length;
          return `${m} m: ${here.length - fills} groups${fills ? ` + ${fills} fill` : ''}`;
        })
        .join(', ') +
      `); lattice tiles to read: ${[...lattice].map(([m, n]) => `${m} m: ${n}`).join(', ')} (a cached one costs nothing)`,
  );
  if (args.dryRun) return 0;
  const reader = fetchValues ?? serverHeightReader({ base: args.base });
  const source = createChunkSource({ fetchValues: reader, maxChunks: 4096 });
  const started = Date.now();
  const chunksByLevel = await loadChunks(plan, source);
  log(`heights read in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const { tiles } = buildTileset(plan, chunksByLevel, {
    out: args.out,
    inputs: {
      heights: fetchValues
        ? 'a given reader'
        : `${args.base}/api/raster/values`,
      builtAt: new Date().toISOString(),
    },
  });
  for (const m of plan.levels) {
    const here = tiles.filter((tile) => tile.level === m);
    const sum = (key) => here.reduce((n, tile) => n + tile[key], 0);
    log(
      `${m} m: ${here.length} tiles, ${(sum('bytes') / 1024).toFixed(0)} KiB, ` +
        `${sum('vertices')} vertices, ${sum('indices') / 3} triangles, ` +
        `largest ${(Math.max(...here.map((tile) => tile.bytes)) / 1024).toFixed(0)} KiB`,
    );
  }
  log(`written to ${args.out}`);
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
