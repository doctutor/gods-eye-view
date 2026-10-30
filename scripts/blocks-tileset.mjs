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
    structures: !argv.includes('--no-structures'),
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
  let faces = 0;
  let vertices = 0;
  let indices = 0;
  for (const { mesh, ci, cj } of meshes) {
    const count = mesh.positions.length / 3;
    const positions = new Float32Array(count * 3);
    const dx = ci * chunkM;
    const dy = cj * chunkM;
    for (let v = 0; v < count; v++) {
      const x = mesh.positions[v * 3] + dx;
      const y = mesh.positions[v * 3 + 1] + dy;
      const p = [
        x - tileX,
        y - tileY,
        mesh.positions[v * 3 + 2] + dropAt(x, y),
      ];
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
export function tileDigest(tile, chunksByLevel) {
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
      floors: skirtFloors(tile, chunksByLevel),
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
 * `out`. `variants` ([{file, name, suffix, chunksByLevel}], the first the
 * default): the same tree drawn from different chunks, a tile's file
 * shared where a variant's chunks of its level are the first's (the coarse
 * levels), its own (`suffix` before .glb) where not (the fine levels
 * without their buildings). A tile whose file exists with its inputs'
 * digest unchanged (BUILD_STATE) is kept, not built again; the state is
 * written after each tile, so an interrupted build resumes where it
 * stopped.
 * @returns {{tiles: Array<{uri, level, kind, bytes, vertices, indices,
 *   faces, kept}>, tilesets: Map<string, object>, tileset: object}}
 */
export function buildTileset(
  plan,
  chunksByLevel,
  { out, inputs = {}, variants = null },
) {
  variants ??= [{ file: 'tileset.json', suffix: '', chunksByLevel }];
  const base = variants[0].chunksByLevel;
  const roots = tileTree(plan);
  const regions = new Map(
    plan.levels.map((m) => [m, levelRegion(plan.anchor, m)]),
  );
  const state = readState(out);
  const writeState = () =>
    writeAtomic(path.join(out, BUILD_STATE), JSON.stringify(state));
  const tiles = [];
  const done = new Map(); // uri → {box, content}, this run
  const buildTile = (tile, chunks, uri) => {
    const known = done.get(uri);
    if (known) return known;
    const digest = tileDigest(tile, chunks);
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
      const mesh = tileMesh(tile, chunks, regions.get(tile.level));
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
    return result;
  };
  const tilesets = new Map();
  for (const variant of variants) {
    const uriOf = (tile) =>
      variant.chunksByLevel.get(tile.level) === base.get(tile.level)
        ? tileUri(tile)
        : tileUri(tile).replace(/\.glb$/, `${variant.suffix}.glb`);
    const toJson = (tile, parent = null) => {
      const uri = uriOf(tile);
      const { box, content } = buildTile(tile, variant.chunksByLevel, uri);
      const { x, y } = tileExtent(tile);
      const origin = parent ? { x: x - parent.x, y: y - parent.y } : { x, y };
      const node = {
        // Relative to the parent's frame (the root's to the anchor's).
        transform: [
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
        ],
        boundingVolume: { box },
        // The content's error is its block; a leaf is exact as far as the tree goes.
        geometricError: tile.children.length ? tile.level : 0,
        refine: 'REPLACE',
        ...(content ? { content: { uri } } : {}),
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
  return { tiles, tilesets, tileset: tilesets.get(variants[0].file) };
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
    const region = levelRegion(plan.anchor, m);
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
  let started = Date.now();
  const chunksByLevel = await loadChunks(plan, source);
  log(`heights read in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  let variants = null;
  const structureLevels = plan.levels.filter(
    (m) => m <= STRUCTURES_MAX_BLOCK_M,
  );
  if (args.structures && structureLevels.length) {
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
  const { tiles } = buildTileset(plan, chunksByLevel, {
    out: args.out,
    variants,
    inputs: {
      heights: fetchValues
        ? 'a given reader'
        : `${args.base}/api/raster/values`,
      structures: variants
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
