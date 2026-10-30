// Personal fork: the Blocks tileset build (scripts/blocks-tileset.mjs,
// docs/BLOCKS-PLAN.md milestone 6 step A): its arguments, the tree of
// levels and fill tiles, the quantised columns and the meshes against
// golden values from a synthetic height reader (sea, land, a hill, a lake
// in the water plane, a nodata patch), the glTF's layout, the tileset read
// by Cesium's own loader from the files written; step B: the structures
// from a synthetic Overpass answer (a building, a park, a road, a bridge)
// in two variants as the Buildings switch has them, the Overpass client's
// pacing, and resume (a tile with unchanged inputs is kept); the tiles in
// the shared encoder's layout (gltf.js) with EXT_meshopt_compression,
// decoded by Cesium's own loader.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as Cesium from 'cesium';

import {
  TILESET_LEVELS_M,
  anchorFor,
  boxColumns,
  BUILD_STATE,
  buildTileset,
  compressGlb,
  encodeTile,
  levelRegion,
  loadChunks,
  loadStructures,
  main,
  parseArgs,
  planLatticeTiles,
  planTiles,
  serverOverpass,
  skirtFloors,
  summarizeLevels,
  loadTileChunks,
  streamedVariants,
  tileFrame,
  tileRunCap,
  TILE_CELL_PX,
  canaryChunk,
  meshFingerprint,
  buildFingerprint,
  tileDigest,
  enuTransform,
  tileMesh,
  tileTree,
  walkTiles,
} from '../../scripts/blocks-tileset.mjs';
import {
  FAN_BELOW_M,
  buildChunkMesh,
  curvedRunCap,
} from '../layers/blocks/mesh.js';
import {
  FOLD_COLUMNS,
  foldColumns,
  readBlocksGlb,
} from '../layers/blocks/gltf.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { STUDY_SUN, sunDirection } from '../layers/blocks/lighting.js';
import { createChunkSource, groupBounds } from '../layers/blocks/source.js';
import { MATERIALS, NONE } from '../layers/blocks/store.js';
import { createStructuresSource } from '../layers/blocks/structures.js';

/** A synthetic place (no real ground): one 30 m group south-west of it. */
const SEED = { lon: 10, lat: 45 };
const GROUP_M = 64 * 4 * 30;

/** The box of 30 m group (0, 0) under the seed's 120 m anchor, a metre in. */
function groupBox() {
  const anchor = anchorFor(
    {
      west: SEED.lon,
      south: SEED.lat,
      east: SEED.lon + 0.01,
      north: SEED.lat + 0.01,
    },
    120,
  );
  const region = levelRegion(anchor, 30);
  const sw = region.toLonLat(1, 1);
  const ne = region.toLonLat(GROUP_M - 1, GROUP_M - 1);
  const nw = region.toLonLat(1, GROUP_M - 1);
  const se = region.toLonLat(GROUP_M - 1, 1);
  return {
    anchor,
    bbox: {
      west: Math.max(sw.lon, nw.lon),
      south: Math.max(sw.lat, se.lat),
      east: Math.min(ne.lon, se.lon),
      north: Math.min(ne.lat, nw.lat),
    },
  };
}

/**
 * The synthetic ground, metres above sea level at a place: the sea west of
 * the box's first fifth (0 m, as the server's means give it), land rising
 * east from 40 m, a hill near the middle, a nodata patch north; its water share 1 in
 * a disc on the land (a lake only the water plane knows).
 */
function ground(lon, lat, bbox) {
  const u = (lon - bbox.west) / (bbox.east - bbox.west);
  const v = (lat - bbox.south) / (bbox.north - bbox.south);
  if (u < 0.2) return { height: 0, water: 1 };
  if (u > 0.4 && u < 0.5 && v > 0.8 && v < 0.9)
    return { height: NaN, water: 0 };
  const hill = 260 * Math.exp(-((u - 0.6) ** 2 + (v - 0.5) ** 2) / 0.01);
  const lake = (u - 0.35) ** 2 + (v - 0.3) ** 2 < 0.004;
  return { height: 40 + 100 * (u - 0.2) + hill, water: lake ? 1 : 0 };
}

/** A height reader answering source.js's values request from `ground`. */
function syntheticReader(bbox, asked = []) {
  return async ({ box, cells, water }) => {
    asked.push({ box, cells, water: Boolean(water) });
    const values = new Float32Array(cells * cells);
    const shares = water ? new Float32Array(cells * cells) : null;
    for (let row = 0; row < cells; row++)
      for (let col = 0; col < cells; col++) {
        const lon = box.west + ((col + 0.5) / cells) * (box.east - box.west);
        const lat = box.north - ((row + 0.5) / cells) * (box.north - box.south);
        const at = ground(lon, lat, bbox);
        values[row * cells + col] = at.height;
        if (shares) shares[row * cells + col] = at.water;
      }
    return {
      header: { ...box, cols: cells, rows: cells, source: 'synthetic' },
      values,
      ...(shares ? { water: shares } : {}),
    };
  };
}

/**
 * A synthetic Overpass answer over the box (u, v: shares of its width and
 * height): a 30 m building on the land, a park, a primary road west to
 * east, and a road bridge over the sea. Every query gets it; `count()`
 * the queries.
 */
function syntheticOverpass(bbox) {
  const at = (u, v) => ({
    lon: bbox.west + u * (bbox.east - bbox.west),
    lat: bbox.south + v * (bbox.north - bbox.south),
  });
  const box = (u0, v0, u1, v1) => [
    at(u0, v0),
    at(u1, v0),
    at(u1, v1),
    at(u0, v1),
    at(u0, v0),
  ];
  const elements = [
    {
      type: 'way',
      id: 1,
      tags: { building: 'yes', height: '30' },
      geometry: box(0.7, 0.2, 0.74, 0.24),
    },
    {
      type: 'way',
      id: 2,
      tags: { leisure: 'park' },
      geometry: box(0.45, 0.6, 0.55, 0.7),
    },
    {
      type: 'way',
      id: 3,
      tags: { highway: 'primary' },
      geometry: [at(0.25, 0.45), at(0.95, 0.45)],
    },
    {
      type: 'way',
      id: 4,
      tags: { highway: 'primary', bridge: 'yes' },
      geometry: [at(0.1, 0.8), at(0.3, 0.8)],
    },
  ];
  let sent = 0;
  const query = async () => {
    sent++;
    return { elements };
  };
  query.count = () => sent;
  return query;
}

const digest = (...arrays) => {
  const hash = createHash('sha256');
  for (const array of arrays)
    hash.update(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    );
  return hash.digest('hex').slice(0, 16);
};

/** Temporary directories the tests wrote, removed after. */
const written = [];
after(() => {
  for (const dir of written) fs.rmSync(dir, { recursive: true, force: true });
});
const temporary = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  written.push(dir);
  return dir;
};

let builtOnce = null;
/** The synthetic box built into a temporary directory, once for the tests below. */
const built = () => (builtOnce ??= build());

async function build(finestM = 30) {
  const { bbox } = groupBox();
  const plan = planTiles(bbox, finestM);
  const asked = [];
  const source = createChunkSource({
    fetchValues: syntheticReader(bbox, asked),
    maxChunks: 4096,
  });
  const chunksByLevel = await loadChunks(plan, source);
  const out = temporary('blocks-tileset-');
  const result = await buildTileset(plan, chunksByLevel, {
    out,
    inputs: { heights: 'synthetic' },
  });
  return { bbox, plan, chunksByLevel, out, asked, ...result };
}

test('parseArgs: the box, the finest level, the ×4 flat chain only, the output', () => {
  const ok = parseArgs([
    '--bbox',
    '-76.7,39.2,-76.5,39.3',
    '--levels',
    '30',
    '--out',
    'x',
  ]);
  assert.deepEqual(ok.bbox, {
    west: -76.7,
    south: 39.2,
    east: -76.5,
    north: 39.3,
  });
  assert.equal(ok.finestM, 30);
  assert.equal(ok.coarsestM, null);
  assert.equal(ok.base, 'http://localhost:4173');
  assert.deepEqual(TILESET_LEVELS_M, [30, 120, 480, 1920, 7680, 30720]);
  assert.match(parseArgs(['--levels', '30', '--out', 'x']).error, /--bbox/);
  assert.match(
    parseArgs([
      '--bbox',
      '-76.7,39.2,-76.5,39.3',
      '--levels',
      '10',
      '--out',
      'x',
    ]).error,
    /not 10/,
  );
  // The curved levels too; --split-depth a whole number; --stream.
  assert.equal(
    parseArgs(['--bbox', '-125,24,-66,50', '--levels', '1920', '--out', 'x'])
      .finestM,
    1920,
  );
  assert.equal(ok.splitDepth, 2);
  assert.equal(ok.stream, false);
  assert.match(
    parseArgs([
      '--bbox',
      '-76.7,39.2,-76.5,39.3',
      '--levels',
      '30',
      '--split-depth',
      '-1',
      '--out',
      'x',
    ]).error,
    /--split-depth/,
  );
  assert.match(
    parseArgs([
      '--bbox',
      '-76.7,39.2,-76.5,39.3',
      '--levels',
      '120',
      '--coarsest',
      '30',
      '--out',
      'x',
    ]).error,
    /at least/,
  );
  assert.match(
    parseArgs(['--bbox', '-76.7,39.2,-76.5,39.3', '--levels', '30']).error,
    /--out/,
  );
  assert.equal(
    parseArgs([
      '--bbox',
      '-76.7,39.2,-76.5,39.3',
      '--levels',
      '30',
      '--dry-run',
    ]).dryRun,
    true,
  );
});

test('planTiles: one 30 m group under a 120 m root; its fifteen other chunks are fill tiles', () => {
  const { bbox, anchor } = groupBox();
  const plan = planTiles(bbox, 30);
  assert.deepEqual(plan.levels, [120, 30]);
  assert.deepEqual(plan.anchor, anchor);
  assert.deepEqual(boxColumns(levelRegion(plan.anchor, 30), bbox), {
    i0: 0,
    j0: 0,
    i1: 255,
    j1: 255,
  });
  assert.deepEqual([...plan.groups.get(30).keys()], ['0:0']);
  assert.deepEqual([...plan.groups.get(120).keys()], ['0:0']);
  const [root, ...others] = tileTree(plan);
  assert.equal(others.length, 0);
  assert.equal(root.children.length, 16);
  const kinds = root.children.map((child) => `${child.kind}:${child.level}`);
  assert.equal(kinds.filter((kind) => kind === 'group:30').length, 1);
  assert.equal(kinds.filter((kind) => kind === 'fill:120').length, 15);
  assert.equal(
    root.children[0].kind,
    'group',
    'the south-west chunk is refined',
  );
  assert.equal([...walkTiles([root])].length, 17);
  // The lattice tiles each level reads.
  const lattice = planLatticeTiles(plan);
  assert.ok(lattice.get(30) >= 1 && lattice.get(120) >= 1);
  // A box over two 30 m groups: both, under the one 120 m root. (Its
  // north edge kept south of the groups': a parallel bows north on the
  // tangent plane away from the anchor.)
  const wider = planTiles(
    {
      ...bbox,
      east: bbox.east + (bbox.east - bbox.west) / 2,
      north: (bbox.south + bbox.north) / 2,
    },
    30,
  );
  assert.deepEqual([...wider.groups.get(30).keys()].sort(), ['0:0', '1:0']);
  assert.equal(
    tileTree(wider)[0].children.filter((child) => child.kind === 'group')
      .length,
    2,
  );
  // At 120 m the same box: one group under a 480 m root.
  assert.deepEqual(planTiles(bbox, 120).levels, [480, 120]);
});

test('quantised columns (golden): the sea at level 0 over a bed at -1, the hill in 30 m levels, the lake at 120 m only, nodata none', async () => {
  const { chunksByLevel, asked } = await built();
  const census = (m) => {
    const counts = { sea: 0, land: 0, lake: 0, none: 0 };
    const tops = [];
    const waters = [];
    for (const [key, chunk] of [...chunksByLevel.get(m)].sort()) {
      void key;
      for (let k = 0; k < chunk.top.length; k++) {
        const top = chunk.top[k];
        const water = chunk.water[k];
        if (top === NONE) counts.none++;
        else if (water === 0 && top < 0) counts.sea++;
        else if (water !== NONE) counts.lake++;
        else counts.land++;
      }
      tops.push(chunk.top);
      waters.push(chunk.water);
    }
    return { counts, digest: digest(...tops, ...waters) };
  };
  const fine = chunksByLevel.get(30);
  const chunk = fine.get('0:0');
  // A sea column: water at level 0 over a bed at -1.
  assert.equal(chunk.top[0], -1);
  assert.equal(chunk.water[0], 0);
  // The hill's top (u 0.6, v 0.5: column 153, 127 of the group): 40 + 40 + 260 m.
  const hillChunk = fine.get('2:1');
  const hill = hillChunk.top[(127 - 64) * 64 + (153 - 128)];
  assert.ok(hill >= 10 && hill <= 11, `hill top ${hill} levels of 30 m`);
  // At 30 m the lake disc is land (OSM's water, step B); no water plane asked.
  assert.ok(
    asked.filter((a) => a.water).length > 0,
    'the 120 m tiles ask the water plane',
  );
  assert.ok(asked.every((a) => !a.water || a.cells === 512));
  const fineCensus = census(30);
  const coarseCensus = census(120);
  assert.equal(fineCensus.counts.lake, 0, 'no lake at 30 m');
  assert.ok(
    coarseCensus.counts.lake > 0,
    'the water plane makes a lake at 120 m',
  );
  assert.ok(fineCensus.counts.none > 0, 'the nodata patch');
  // Golden: change only with the column rules (source.js), on purpose.
  assert.deepEqual(fineCensus, {
    counts: { sea: 13262, land: 51598, lake: 0, none: 676 },
    digest: '977c86aced9627f1',
  });
  assert.deepEqual(coarseCensus, {
    counts: { sea: 3328, land: 62107, lake: 52, none: 49 },
    digest: 'c334b3cac0458170',
  });
});

/**
 * A compressed tile (EXT_meshopt_compression) as a plain GLB: each view's
 * bytes from `decode(viewIndex, view)` (decoded, or as stored), laid out
 * one after another, the extension gone; then gltf.js's readBlocksGlb
 * reads it.
 */
async function plainGlb(glb, decode) {
  const bytes = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const parts = [];
  let length = 0;
  const views = [];
  for (const [index, view] of json.bufferViews.entries()) {
    const data = Buffer.from(await decode(index, view, json, bytes));
    const offset = (length + 7) & ~7;
    if (offset > length) parts.push(Buffer.alloc(offset - length));
    parts.push(data);
    length = offset + data.length;
    const { extensions, ...rest } = view;
    void extensions;
    views.push({
      ...rest,
      buffer: 0,
      byteOffset: offset,
      byteLength: data.length,
    });
  }
  const bin = Buffer.concat([...parts, Buffer.alloc((4 - (length % 4)) % 4)]);
  const plain = {
    ...json,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    extensionsUsed: json.extensionsUsed.filter(
      (name) => name !== 'EXT_meshopt_compression',
    ),
    extensionsRequired: json.extensionsRequired.filter(
      (name) => name !== 'EXT_meshopt_compression',
    ),
  };
  let text = Buffer.from(JSON.stringify(plain));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + 8 + bin.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header.subarray(0, 20), text, binHeader, bin]);
}

/** The stored GLB's views decoded by meshoptimizer's own decoder (as Cesium's loader calls it). */
async function unpack(glb) {
  await MeshoptDecoder.ready;
  return readBlocksGlb(
    await plainGlb(glb, (index, view, json, bytes) => {
      const jsonLength = bytes.readUInt32LE(12);
      const bin = bytes.subarray(28 + jsonLength);
      const meshopt = view.extensions?.EXT_meshopt_compression;
      if (!meshopt)
        return bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
      const out = new Uint8Array(meshopt.count * meshopt.byteStride);
      MeshoptDecoder.decodeGltfBuffer(
        out,
        meshopt.count,
        meshopt.byteStride,
        bin.subarray(
          meshopt.byteOffset,
          meshopt.byteOffset + meshopt.byteLength,
        ),
        meshopt.mode,
        meshopt.filter,
      );
      return out;
    }),
  );
}

/**
 * A tile's triangles, whatever their order or rotation (meshopt reorders
 * the vertices and its index codec turns triangles): each vertex as its
 * block point, chunk, colour and kind; each triangle from its least vertex,
 * winding kept; sorted.
 */
function triangleSet({ primitives, properties }) {
  const triangles = [];
  for (const p of primitives) {
    const vertex = (v) =>
      `${p.kind}|${properties.ci[p.featureIds[v]]},${properties.cj[p.featureIds[v]]}|` +
      `${p.blockCoords[v * 3]},${p.blockCoords[v * 3 + 1]},${p.blockCoords[v * 3 + 2]}|` +
      `${p.colors[v * 4]},${p.colors[v * 4 + 1]},${p.colors[v * 4 + 2]},${p.colors[v * 4 + 3]}`;
    for (let k = 0; k < p.indices.length; k += 3) {
      const three = [0, 1, 2].map((c) => vertex(p.indices[k + c]));
      let first = 0;
      for (let c = 1; c < 3; c++) if (three[c] < three[first]) first = c;
      triangles.push([0, 1, 2].map((c) => three[(first + c) % 3]).join(' / '));
    }
  }
  return triangles.sort();
}

test('meshes (golden): tile sizes and geometry, opaque then water, in the tile frame', async () => {
  const { tiles, out } = await built();
  const summary = tiles.map(
    ({ uri, vertices, indices }) => `${uri} ${vertices} ${indices / 3}`,
  );
  assert.equal(tiles.length, 17);
  const geometry = createHash('sha256');
  let deepestDropM = 0;
  for (const { uri, level } of tiles) {
    const tile = await unpack(fs.readFileSync(path.join(out, uri)));
    for (const triangle of triangleSet(tile)) geometry.update(`${triangle}\n`);
    // Each position is its block point in the tile's frame: the chunk's
    // columns (unfolded) × the block east and north of the tile's corner,
    // levels × 30 m up, less the ellipsoid's drop under the plane.
    const fill = /\/c(\d+)_(\d+)\.glb$/.exec(uri);
    const group = /\/g(\d+)_(\d+)\.glb$/.exec(uri);
    const columns = fill ? 64 : 256;
    const [a, b] = (fill || group).slice(1).map(Number);
    const { ci, cj } = tile.properties;
    for (const p of tile.primitives)
      for (let v = 0; v < p.positions.length / 3; v++) {
        const row = p.featureIds[v];
        const column =
          p.blockCoords[v * 3] - foldColumns(ci[row]) + ci[row] * 64;
        const line =
          p.blockCoords[v * 3 + 1] - foldColumns(cj[row]) + cj[row] * 64;
        assert.ok(
          Math.abs(p.positions[v * 3] - (column - a * columns) * level) < 0.01,
        );
        assert.ok(
          Math.abs(p.positions[v * 3 + 1] - (line - b * columns) * level) <
            0.01,
        );
        const drop = p.positions[v * 3 + 2] - p.blockCoords[v * 3 + 2] * 30;
        assert.ok(drop <= 0.01 && drop > -200, `drop ${drop} m`);
        deepestDropM = Math.min(deepestDropM, drop);
      }
  }
  // The 120 m group's far corner is 43 km out, its ground about 146 m
  // under the anchor's plane.
  assert.ok(
    deepestDropM < -100 && deepestDropM > -160,
    `deepest drop ${deepestDropM} m`,
  );
  // Golden: change only with the mesher (mesh.js) or this layout, on purpose.
  // The 120 m tiles without the fan since FAN_BELOW_M (two triangles a face).
  assert.deepEqual(summary, [
    '120m/g0_0.glb 4488 2244',
    '30m/g0_0.glb 16046 11950',
    '120m/c1_0.glb 116 58',
    '120m/c2_0.glb 80 40',
    '120m/c3_0.glb 156 78',
    '120m/c0_1.glb 124 62',
    '120m/c1_1.glb 152 76',
    '120m/c2_1.glb 80 40',
    '120m/c3_1.glb 100 50',
    '120m/c0_2.glb 128 64',
    '120m/c1_2.glb 80 40',
    '120m/c2_2.glb 152 76',
    '120m/c3_2.glb 100 50',
    '120m/c0_3.glb 108 54',
    '120m/c1_3.glb 80 40',
    '120m/c2_3.glb 116 58',
    '120m/c3_3.glb 244 122',
  ]);
  assert.equal(geometry.digest('hex').slice(0, 16), 'c4edfa737de162f1');
});

test("glTF layout: the shared encoder's, meshopt required, a feature a chunk, water blended, indices in range", async () => {
  const { tiles, out } = await built();
  const withWater = [];
  for (const { uri } of tiles) {
    const stored = fs.readFileSync(path.join(out, uri));
    const json = JSON.parse(
      stored.subarray(20, 20 + stored.readUInt32LE(12)).toString('utf8'),
    );
    assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
    assert.ok(json.extensionsRequired.includes('KHR_mesh_quantization'));
    assert.deepEqual(json.buffers[1].extensions, {
      EXT_meshopt_compression: { fallback: true },
    });
    const tile = await unpack(stored);
    assert.deepEqual(Object.keys(tile.properties).sort(), [
      'blockM',
      'ci',
      'cj',
    ]);
    assert.equal(tile.featureCount, uri.includes('/c') ? 1 : 16);
    assert.ok(tile.properties.blockM.every((m) => uri.startsWith(`${m}m/`)));
    for (const p of tile.primitives) {
      const vertices = p.positions.length / 3;
      for (const index of p.indices) assert.ok(index < vertices);
      for (let v = 0; v < vertices; v++) {
        assert.equal(p.colors[v * 4 + 3] < 255, p.kind === 'water');
        assert.ok(p.featureIds[v] < tile.featureCount);
      }
      // Block points: whole or half columns, folded by chunk.
      for (let k = 0; k < p.blockCoords.length; k++)
        assert.ok(Number.isInteger(p.blockCoords[k] * 2));
      for (let k = 0; k < p.blockCoords.length; k += 3)
        assert.ok(p.blockCoords[k] >= 0 && p.blockCoords[k] <= FOLD_COLUMNS);
    }
    if (tile.primitives.some((p) => p.kind === 'water')) withWater.push(uri);
  }
  assert.ok(withWater.includes('30m/g0_0.glb'), 'the sea is water');
});

test("meshopt: Cesium's own buffer view loader decodes a tile to the encoder's triangles, at a fraction of the size", async () => {
  const { plan, chunksByLevel } = await built();
  const tile = tileTree(plan)[0].children.find(
    (child) => child.kind === 'group',
  );
  const mesh = tileMesh(
    tile,
    chunksByLevel,
    levelRegion(plan.anchor, tile.level),
  );
  const plain = encodeTile(mesh, tile.level, { compress: false });
  const packed = compressGlb(plain);
  assert.ok(
    packed.length < plain.length / 3,
    `${packed.length} of ${plain.length} bytes`,
  );
  // Cesium's decoder (meshoptimizer's WASM inside Cesium) instantiates
  // when Cesium loads, and its loader does not wait for it: in a page it
  // is long ready before a tile; here, wait until it decodes.
  const resource = Cesium.Resource.createIfNeeded('');
  const loader = new Cesium.GltfLoader({
    typedArray: new Uint8Array(packed),
    gltfResource: resource,
    baseResource: resource,
    releaseGltfJson: false,
  });
  await loader.load();
  const gltf = loader.gltfJson;
  const viewBytes = async (index) => {
    for (let attempt = 0; ; attempt++) {
      const viewLoader = Cesium.ResourceCache.getBufferViewLoader({
        gltf,
        bufferViewId: index,
        gltfResource: resource,
        baseResource: resource,
      });
      try {
        await viewLoader.load();
        const bytes = new Uint8Array(viewLoader.typedArray);
        Cesium.ResourceCache.unload(viewLoader);
        return bytes;
      } catch (error) {
        Cesium.ResourceCache.unload(viewLoader);
        if (attempt > 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  };
  const decoded = readBlocksGlb(
    await plainGlb(packed, (index) => viewBytes(index)),
  );
  assert.deepEqual(triangleSet(decoded), triangleSet(readBlocksGlb(plain)));
  loader.destroy();
  // And a Model from it.
  const model = await Cesium.Model.fromGltfAsync({
    gltf: new Uint8Array(packed),
  });
  assert.ok(model instanceof Cesium.Model);
  model.destroy();
});

test("Cesium's own loader reads the tileset and a tile's glTF from the files written", async () => {
  const { out, bbox } = await built();
  const implementations = Cesium.Resource._Implementations;
  const original = implementations.loadWithXhr;
  implementations.loadWithXhr = (
    url,
    responseType,
    method,
    data,
    headers,
    deferred,
  ) => {
    const name = decodeURIComponent(
      url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0],
    );
    const file = path.join(out, name);
    if (!fs.existsSync(file)) {
      deferred.reject(new Cesium.RequestErrorEvent(404, 'missing'));
      return;
    }
    const bytes = fs.readFileSync(file);
    if (responseType === 'json')
      deferred.resolve(JSON.parse(bytes.toString('utf8')));
    else if (responseType === 'text') deferred.resolve(bytes.toString('utf8'));
    else
      deferred.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
  };
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      'http://tiles.test/tileset.json',
    );
    assert.equal(tileset.asset.version, '1.1');
    const { root } = tileset;
    assert.equal(root.children.length, 16);
    assert.equal(root.geometricError, 120);
    assert.equal(root.refine, Cesium.Cesium3DTileRefine.REPLACE);
    const degrees = (tile) => {
      const c = Cesium.Cartographic.fromCartesian(
        tile.boundingVolume.boundingVolume.center,
      );
      return {
        lon: Cesium.Math.toDegrees(c.longitude),
        lat: Cesium.Math.toDegrees(c.latitude),
        height: c.height,
      };
    };
    // The refined chunk's 30 m group stands over the box's middle.
    const fine = root.children.find((child) =>
      child._contentResource?.url.endsWith('30m/g0_0.glb'),
    );
    const centre = degrees(fine);
    assert.ok(
      Math.abs(centre.lon - (bbox.west + bbox.east) / 2) < 1e-3,
      `lon ${centre.lon}`,
    );
    assert.ok(
      Math.abs(centre.lat - (bbox.south + bbox.north) / 2) < 1e-3,
      `lat ${centre.lat}`,
    );
    assert.ok(
      centre.height > -50 && centre.height < 300,
      `height ${centre.height}`,
    );
    assert.equal(fine.geometricError, 0);
    const loader = new Cesium.GltfLoader({
      gltfResource: new Cesium.Resource({
        url: 'http://tiles.test/30m/g0_0.glb',
      }),
      releaseGltfJson: false,
    });
    await loader.load();
    assert.deepEqual(
      Object.keys(loader.gltfJson.meshes[0].primitives[0].attributes).sort(),
      ['COLOR_0', 'NORMAL', 'POSITION', '_BLOCKCOORD', '_FEATURE_ID_0'],
    );
    assert.ok(
      loader.gltfJson.extensionsUsed.includes('EXT_meshopt_compression'),
    );
    loader.destroy();
  } finally {
    implementations.loadWithXhr = original;
  }
});

test('main: the plan printed, a dry run reads nothing; a run writes the tileset', async () => {
  const { bbox } = groupBox();
  const argv = [
    '--bbox',
    [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
    '--levels',
    '30',
  ];
  const lines = [];
  const asked = [];
  assert.equal(
    await main({
      argv: [...argv, '--dry-run'],
      fetchValues: syntheticReader(bbox, asked),
      log: (line) => lines.push(line),
    }),
    0,
  );
  assert.match(
    lines[0],
    /levels 120, 30 m; 17 tiles \(120 m: 1 groups \+ 15 fill, 30 m: 1 groups\)/,
  );
  assert.equal(asked.length, 0);
  const out = temporary('blocks-tileset-main-');
  lines.length = 0;
  const run = () =>
    main({
      argv: [...argv, '--out', out],
      fetchValues: syntheticReader(bbox, asked),
      query: syntheticOverpass(bbox),
      log: (line) => lines.push(line),
    });
  assert.equal(await run(), 0);
  assert.ok(fs.existsSync(path.join(out, 'tileset.json')));
  assert.ok(fs.existsSync(path.join(out, 'tileset-ground.json')));
  // The box asked for and the finest level, in the tileset's extras.
  const extras = JSON.parse(
    fs.readFileSync(path.join(out, 'tileset.json'), 'utf8'),
  ).asset.extras.blocks;
  assert.deepEqual(extras.bbox, [bbox.west, bbox.south, bbox.east, bbox.north]);
  assert.equal(extras.finestM, 30);
  assert.ok(
    lines.some((line) =>
      /^structures at 30 m .*, 1 Overpass queries$/.test(line),
    ),
    lines.join('\n'),
  );
  assert.ok(lines.some((line) => /^30 m: 2 tiles/.test(line)));
  // Again: nothing changed, every tile kept.
  lines.length = 0;
  assert.equal(await run(), 0);
  assert.ok(lines.includes('18 of 18 tiles kept (inputs unchanged)'));
  // Without structures: the heights alone, one tileset.
  const bare = temporary('blocks-tileset-bare-');
  assert.equal(
    await main({
      argv: [...argv, '--out', bare, '--no-structures'],
      fetchValues: syntheticReader(bbox, asked),
      log: () => {},
    }),
    0,
  );
  assert.ok(!fs.existsSync(path.join(bare, 'tileset-ground.json')));
  assert.equal(await main({ argv: ['--levels', '30'], log: () => {} }), 2);
});

/** The synthetic box's chunks with its structures, both variants. */
async function withStructures() {
  const { bbox } = groupBox();
  const plan = planTiles(bbox, 30);
  const source = createChunkSource({
    fetchValues: syntheticReader(bbox),
    maxChunks: 4096,
  });
  const chunksByLevel = await loadChunks(plan, source);
  const query = syntheticOverpass(bbox);
  const structures = createStructuresSource({
    loadChunk: (region, ci, cj) => source.loadChunk(region, ci, cj),
    query,
  });
  const variants = await loadStructures(plan, chunksByLevel, structures);
  return { bbox, plan, chunksByLevel, query, ...variants };
}

/** Columns by what the structures put there, over a level's chunks. */
function structureCensus(chunks) {
  const counts = { building: 0, deck: 0, grass: 0, road: 0 };
  for (const chunk of chunks.values())
    for (let k = 0; k < chunk.top.length; k++) {
      const material = chunk.structure?.material[k];
      if (chunk.structure && chunk.structure.top[k] !== NONE)
        counts[material === MATERIALS.ROAD ? 'deck' : 'building']++;
      if (chunk.material[k] === MATERIALS.GRASS) counts.grass++;
      if (chunk.material[k] === MATERIALS.ROAD) counts.road++;
    }
  return counts;
}

test('structures at 30 m (golden): the land cover and decks in both variants, the buildings in one, nothing at 120 m', async () => {
  const { chunksByLevel, built, ground, levels, query } =
    await withStructures();
  assert.deepEqual(levels, [30]);
  assert.equal(query.count(), 1, 'one Overpass query for the one 30 m group');
  // 120 m is the heights alone, the same chunks in both variants.
  assert.equal(built.get(120), chunksByLevel.get(120));
  assert.equal(ground.get(120), chunksByLevel.get(120));
  assert.deepEqual(structureCensus(chunksByLevel.get(120)), {
    building: 0,
    deck: 0,
    grass: 0,
    road: 0,
  });
  // The source's own chunks are not painted: each variant has copies.
  assert.deepEqual(structureCensus(chunksByLevel.get(30)), {
    building: 0,
    deck: 0,
    grass: 0,
    road: 0,
  });
  const withBuildings = structureCensus(built.get(30));
  const without = structureCensus(ground.get(30));
  assert.ok(withBuildings.building > 0 && withBuildings.deck > 0);
  assert.equal(without.building, 0, 'no buildings in the ground variant');
  assert.equal(without.deck, withBuildings.deck, 'the decks kept');
  assert.equal(without.grass, withBuildings.grass, 'the land cover kept');
  assert.equal(without.road, withBuildings.road);
  // Golden: change only with the structures rules (structures.js), on purpose.
  assert.deepEqual(withBuildings, {
    building: 105,
    deck: 52,
    grass: 650,
    road: 269,
  });
});

test('two tilesets over one tree: the fine tiles per variant, the coarse ones shared', async () => {
  const { plan, chunksByLevel, built, ground } = await withStructures();
  const out = temporary('blocks-tileset-variants-');
  const { tiles, tilesets } = await buildTileset(plan, chunksByLevel, {
    out,
    variants: [
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
    ],
  });
  const uris = (tileset) => {
    const found = [];
    const walk = (node) => {
      if (node.content) found.push(node.content.uri);
      (node.children ?? []).forEach(walk);
    };
    walk(tileset.root);
    return found.sort();
  };
  const a = uris(tilesets.get('tileset.json'));
  const b = uris(tilesets.get('tileset-ground.json'));
  assert.ok(a.includes('30m/g0_0.glb') && b.includes('30m/g0_0.ground.glb'));
  assert.deepEqual(
    a.filter((uri) => uri.startsWith('120m/')),
    b.filter((uri) => uri.startsWith('120m/')),
  );
  assert.equal(tiles.length, 18, '16 at 120 m once, a 30 m tile a variant');
  const fine = (uri) => tiles.find((tile) => tile.uri === uri);
  assert.ok(
    fine('30m/g0_0.ground.glb').vertices < fine('30m/g0_0.glb').vertices,
    'a building has walls',
  );
  assert.equal(
    tilesets.get('tileset-ground.json').asset.extras.blocks.variant,
    'ground',
  );
});

test('resume: a tile whose inputs are unchanged is kept; a changed chunk or a missing file builds again', async () => {
  const { plan, chunksByLevel } = await withStructures();
  const out = temporary('blocks-tileset-resume-');
  const first = await buildTileset(plan, chunksByLevel, { out });
  assert.ok(first.tiles.every((tile) => !tile.kept));
  assert.ok(fs.existsSync(path.join(out, BUILD_STATE)));
  const again = await buildTileset(plan, chunksByLevel, { out });
  assert.ok(again.tiles.every((tile) => tile.kept));
  assert.deepEqual(again.tileset.root, first.tileset.root, 'the same tree');
  // A column of the 30 m group raised: that tile again, the rest kept.
  const chunk = chunksByLevel.get(30).get('1:1');
  chunk.top[100] += 3;
  const changed = await buildTileset(plan, chunksByLevel, { out });
  assert.deepEqual(
    changed.tiles.filter((tile) => !tile.kept).map((tile) => tile.uri),
    ['30m/g0_0.glb'],
  );
  chunk.top[100] -= 3;
  // A fill tile's file gone: that one again.
  fs.rmSync(path.join(out, '120m/c3_3.glb'));
  const restored = await buildTileset(plan, chunksByLevel, { out });
  assert.deepEqual(
    restored.tiles.filter((tile) => !tile.kept).map((tile) => tile.uri),
    ['30m/g0_0.glb', '120m/c3_3.glb'],
  );
});

test("serverOverpass: POST to the app server's proxy, one at a time, 700 ms apart, counted", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, at: Date.now(), method: init.method });
    return new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const query = serverOverpass({ base: 'http://localhost:4173', fetchImpl });
  await Promise.all([
    query('[out:json];way(1);out;'),
    query('[out:json];way(2);out;'),
  ]);
  assert.equal(query.count(), 2);
  assert.deepEqual(
    calls.map((call) => [call.url, call.method]),
    [
      ['http://localhost:4173/api/overpass', 'POST'],
      ['http://localhost:4173/api/overpass', 'POST'],
    ],
  );
  assert.ok(
    calls[1].at - calls[0].at >= 690,
    `${calls[1].at - calls[0].at} ms apart`,
  );
});

/** A synthetic curved box: about 390 by 445 km around the seed, built at 7,680 and 1,920 m. */
const CURVED_BOX = { west: 7.5, south: 43, east: 12.5, north: 47 };
let curvedOnce = null;
/** The curved box built once into a temporary directory (in memory, not streamed). */
const curvedBuilt = () =>
  (curvedOnce ??= (async () => {
    const plan = planTiles(CURVED_BOX, 1920, 7680);
    const source = createChunkSource({
      fetchValues: syntheticReader(CURVED_BOX),
      maxChunks: 4096,
    });
    const chunksByLevel = await loadChunks(plan, source);
    const out = temporary('blocks-tileset-curved-');
    const result = await buildTileset(plan, chunksByLevel, { out });
    return { plan, chunksByLevel, out, ...result };
  })());

test('a curved build: the box middle on the coarsest graticule, every level on the curved map', () => {
  const plan = planTiles(CURVED_BOX, 1920, 7680);
  assert.equal(plan.curved, true);
  assert.deepEqual(plan.levels, [7680, 1920]);
  assert.ok(
    Math.abs(plan.anchor.lon0 - 10) < 0.1 &&
      Math.abs(plan.anchor.lat0 - 45) < 0.1,
  );
  // The anchor is a corner of four groups at every level.
  assert.deepEqual([...plan.groups.get(1920).keys()].sort(), [
    '-1:-1',
    '-1:0',
    '0:-1',
    '0:0',
  ]);
  assert.deepEqual([...plan.groups.get(7680).keys()].sort(), [
    '-1:-1',
    '-1:0',
    '0:-1',
    '0:0',
  ]);
  assert.equal(
    levelRegion(plan.anchor, 480, true).curved,
    true,
    'a finer level on the curved map too',
  );
  // The flat builds are as they were.
  assert.equal(planTiles(groupBox().bbox, 30).curved, false);
});

test('a curved plan keeps the groups whose ground meets the box, not the bowed rectangle around it', () => {
  // The lower 48 at 480 m and up (no reads: the plan alone).
  const box = { west: -125, south: 24, east: -66, north: 50 };
  const plan = planTiles(box, 480);
  assert.deepEqual(plan.levels, [30720, 7680, 1920, 480]);
  const region = levelRegion(plan.anchor, 480, true);
  const fine = [...plan.groups.get(480).values()];
  for (const { gi, gj } of fine) {
    const b = groupBounds(region, gi, gj);
    assert.ok(
      b.west < box.east &&
        b.east > box.west &&
        b.south < box.north &&
        b.north > box.south,
      `group ${gi}:${gj} off the box`,
    );
  }
  // The rectangle around the box's image would be 1,350 groups.
  assert.equal(fine.length, 1082);
  // Every finer group's parent is built.
  for (const { gi, gj } of fine)
    assert.ok(
      plan.groups.get(1920).has(`${Math.floor(gi / 4)}:${Math.floor(gj / 4)}`),
    );
});

test('curved placement: each vertex is its block corner on the ellipsoid, at its level above it', async () => {
  const { plan, out, tiles } = await curvedBuilt();
  const region = levelRegion(plan.anchor, 1920, true);
  let checked = 0;
  for (const { uri } of tiles.filter((tile) => tile.uri.startsWith('1920m/'))) {
    const [, gi, gj] = /g(-?\d+)_(-?\d+)\.glb$/.exec(uri).map(Number);
    const { world } = tileFrame(
      { level: 1920, kind: 'group', gi, gj, children: [] },
      region,
    );
    const tile = await unpack(fs.readFileSync(path.join(out, uri)));
    const { ci, cj } = tile.properties;
    for (const p of tile.primitives)
      for (let v = 0; v < p.positions.length / 3; v += 7) {
        const row = p.featureIds[v];
        const i = p.blockCoords[v * 3] - foldColumns(ci[row]) + ci[row] * 64;
        const j =
          p.blockCoords[v * 3 + 1] - foldColumns(cj[row]) + cj[row] * 64;
        const level = p.blockCoords[v * 3 + 2];
        // Faces' corners only (a shaded face's centre is a half).
        if (!Number.isInteger(i) || !Number.isInteger(j)) continue;
        const [x, y, z] = [0, 1, 2].map((c) => p.positions[v * 3 + c]);
        const earth = new Cesium.Cartesian3(
          ...[0, 1, 2].map(
            (c) =>
              world[c] * x +
              world[4 + c] * y +
              world[8 + c] * z +
              world[12 + c],
          ),
        );
        const at = Cesium.Cartographic.fromCartesian(earth);
        const corner = region.toLonLat(i * 1920, j * 1920);
        assert.ok(
          Math.abs(Cesium.Math.toDegrees(at.longitude) - corner.lon) < 1e-5,
        );
        assert.ok(
          Math.abs(Cesium.Math.toDegrees(at.latitude) - corner.lat) < 1e-5,
        );
        assert.ok(
          Math.abs(at.height - level * 60) < 0.5,
          `height ${at.height} at level ${level}`,
        );
        checked++;
      }
  }
  assert.ok(checked > 1000, `${checked} vertices checked`);
});

test('curved greedy runs: no top face longer than the tileset run cap, each straight edge chord under a pixel of its cell', async (t) => {
  const { plan, out, tiles } = await curvedBuilt();
  const region = levelRegion(plan.anchor, 1920, true);
  const cap = tileRunCap(1920);
  let longest = 0;
  let deepestEdge = 0;
  let deepestMiddle = 0;
  const earthOf = (world, q) =>
    Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        ...[0, 1, 2].map(
          (c) =>
            world[c] * q[0] +
            world[4 + c] * q[1] +
            world[8 + c] * q[2] +
            world[12 + c],
        ),
      ),
    ).height;
  for (const { uri } of tiles.filter((tile) => tile.uri.startsWith('1920m/'))) {
    const [, gi, gj] = /g(-?\d+)_(-?\d+)\.glb$/.exec(uri).map(Number);
    const { world } = tileFrame(
      { level: 1920, kind: 'group', gi, gj, children: [] },
      region,
    );
    const tile = await unpack(fs.readFileSync(path.join(out, uri)));
    for (const p of tile.primitives)
      for (let k = 0; k < p.indices.length; k += 3) {
        const v = [0, 1, 2].map((c) => p.indices[k + c]);
        const levels = v.map((w) => p.blockCoords[w * 3 + 2]);
        // Top faces: one level, whole columns at every corner.
        if (levels[0] !== levels[1] || levels[1] !== levels[2]) continue;
        const i = v.map((w) => p.blockCoords[w * 3]);
        const j = v.map((w) => p.blockCoords[w * 3 + 1]);
        if (![...i, ...j].every(Number.isInteger)) continue;
        longest = Math.max(
          longest,
          Math.max(...i) - Math.min(...i),
          Math.max(...j) - Math.min(...j),
        );
        const at = (w) => [0, 1, 2].map((c) => p.positions[w * 3 + c]);
        // Each edge along a row or a column: its middle under the level's height.
        for (const [a, b] of [
          [0, 1],
          [1, 2],
          [2, 0],
        ]) {
          if (i[a] !== i[b] && j[a] !== j[b]) continue;
          const middle = [0, 1, 2].map((c) => (at(v[a])[c] + at(v[b])[c]) / 2);
          deepestEdge = Math.max(
            deepestEdge,
            levels[0] * 60 - earthOf(world, middle),
          );
        }
        // The face's inside, for the record (not what the cap bounds).
        const centroid = [0, 1, 2].map(
          (c) => v.reduce((sum, w) => sum + at(w)[c], 0) / 3,
        );
        deepestMiddle = Math.max(
          deepestMiddle,
          levels[0] * 60 - earthOf(world, centroid),
        );
      }
  }
  t.diagnostic(
    `longest run ${longest} cells; edge chord ${deepestEdge.toFixed(0)} m, face middle ${deepestMiddle.toFixed(0)} m (a pixel: ${1920 / TILE_CELL_PX} m)`,
  );
  assert.ok(longest <= cap, `a run of ${longest} cells, cap ${cap}`);
  // The open sea merges up to the cap, or to the chunk's 64 columns when the cap is wider.
  assert.equal(longest, Math.min(cap, 64));
  assert.equal(cap, 81, 'longer than the live 8 px rule (57)');
  assert.equal(curvedRunCap(1920), 57);
  assert.ok(
    deepestEdge <= 1920 / TILE_CELL_PX,
    `an edge's chord sags ${deepestEdge} m`,
  );
  // A face capped both ways sags about twice an edge at its middle (the
  // cap bounds runs, not faces): 1.7 px of an 8 px cell here.
  assert.ok(
    deepestMiddle > deepestEdge && deepestMiddle < (2.5 * 1920) / TILE_CELL_PX,
    `inside ${deepestMiddle} m`,
  );
});

test('curved roots: four groups under a content-free root, each tile in its own Earth-fixed frame, Cesium reads them', async () => {
  const { out, tileset } = await curvedBuilt();
  assert.ok(
    tileset.root.boundingVolume.sphere,
    'several roots: a sphere around them',
  );
  assert.equal(tileset.root.children.length, 4);
  assert.equal(tileset.asset.extras.blocks.curved, true);
  await withTilesFrom(out, async () => {
    const loaded = await Cesium.Cesium3DTileset.fromUrl(
      'http://tiles.test/tileset.json',
    );
    for (const child of loaded.root.children) {
      const centre = Cesium.Cartographic.fromCartesian(
        child.boundingVolume.boundingVolume.center,
      );
      // Each root group's box is over its quarter of the 7,864 km around the seed.
      assert.ok(Math.abs(Cesium.Math.toDegrees(centre.latitude) - 45) < 40);
      const fine = child.children.find((tile) =>
        tile._contentResource?.url.includes('/1920m/'),
      );
      assert.ok(fine, 'a 1,920 m group under each root');
      const middle = Cesium.Cartographic.fromCartesian(
        fine.boundingVolume.boundingVolume.center,
      );
      assert.ok(Math.abs(Cesium.Math.toDegrees(middle.longitude) - 10) < 4);
      assert.ok(Math.abs(Cesium.Math.toDegrees(middle.latitude) - 45) < 4);
    }
  });
});

/**
 * Run `body` with Cesium's requests answered from files under `out`
 * (http://tiles.test/<path>), as a page would fetch them.
 */
async function withTilesFrom(out, body) {
  const implementations = Cesium.Resource._Implementations;
  const original = implementations.loadWithXhr;
  implementations.loadWithXhr = (
    url,
    responseType,
    method,
    data,
    headers,
    deferred,
  ) => {
    const name = decodeURIComponent(
      url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0],
    );
    const file = path.join(out, name);
    if (!fs.existsSync(file)) {
      deferred.reject(new Cesium.RequestErrorEvent(404, 'missing'));
      return;
    }
    const bytes = fs.readFileSync(file);
    if (responseType === 'json')
      deferred.resolve(JSON.parse(bytes.toString('utf8')));
    else if (responseType === 'text') deferred.resolve(bytes.toString('utf8'));
    else
      deferred.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
  };
  try {
    await body();
  } finally {
    implementations.loadWithXhr = original;
  }
}

test('external tilesets: a subtree every split depth in its own JSON, its paths resolving from its folder, in Cesium too', async () => {
  // The flat box with three levels (480, 120, 30 m): the 120 m group has children.
  const { bbox } = groupBox();
  const plan = planTiles(bbox, 30, 480);
  assert.deepEqual(plan.levels, [480, 120, 30]);
  const source = createChunkSource({
    fetchValues: syntheticReader(bbox),
    maxChunks: 4096,
  });
  const chunksByLevel = await loadChunks(plan, source);
  const out = temporary('blocks-tileset-split-');
  const { tileset, externals } = await buildTileset(plan, chunksByLevel, {
    out,
    splitDepth: 1,
  });
  assert.deepEqual(externals, ['subtrees/120m/g0_0.json']);
  const reference = tileset.root.children.find(
    (child) => child.content?.uri === externals[0],
  );
  assert.ok(
    reference && !reference.children,
    'the subtree is referenced, not inlined',
  );
  const sub = JSON.parse(fs.readFileSync(path.join(out, externals[0]), 'utf8'));
  assert.equal(
    sub.root.transform,
    undefined,
    "its root in the referencing tile's frame",
  );
  assert.deepEqual(sub.root.boundingVolume, reference.boundingVolume);
  const uris = [];
  const walk = (node) => {
    if (node.content) uris.push(node.content.uri);
    (node.children ?? []).forEach(walk);
  };
  walk(sub.root);
  assert.equal(uris[0], '../../120m/g0_0.glb');
  for (const uri of uris)
    assert.ok(
      fs.existsSync(path.join(out, path.dirname(externals[0]), uri)),
      uri,
    );
  // The main JSON holds the root and the references only.
  walk({ children: [] });
  await withTilesFrom(out, async () => {
    const main = await Cesium.Cesium3DTileset.fromUrl(
      'http://tiles.test/tileset.json',
    );
    const tile = main.root.children.find((child) =>
      child._contentResource?.url.endsWith('.json'),
    );
    assert.ok(tile._contentResource.url.endsWith('/subtrees/120m/g0_0.json'));
    // Cesium resolves the subtree's paths from its own folder.
    const subtree = await Cesium.Cesium3DTileset.fromUrl(
      tile._contentResource.url,
    );
    assert.equal(
      subtree.root._contentResource.url,
      'http://tiles.test/120m/g0_0.glb',
    );
    assert.equal(subtree.root.children.length, 16);
  });
});

test('streamed: tile by tile from the summaries, the same tiles, skirt floors never shallower than the held build', async () => {
  const { plan, chunksByLevel, tiles: held } = await built();
  const source = createChunkSource({
    fetchValues: syntheticReader(groupBox().bbox),
    maxChunks: 64,
  });
  const summaries = await summarizeLevels(plan, source);
  for (const tile of walkTiles(tileTree(plan))) {
    const full = skirtFloors(tile, chunksByLevel);
    const light = skirtFloors(tile, chunksByLevel, summaries);
    for (const side of ['n', 's', 'e', 'w'])
      if (full[side] !== null)
        assert.ok(
          light[side] <= full[side],
          `${side}: ${light[side]} > ${full[side]}`,
        );
  }
  const out = temporary('blocks-tileset-streamed-');
  const { tiles } = await buildTileset(plan, null, {
    out,
    summaries,
    variants: [
      {
        file: 'tileset.json',
        suffix: '',
        chunksFor: (tile) => loadTileChunks(plan, source, tile),
      },
    ],
  });
  assert.deepEqual(
    tiles.map((t) => t.uri),
    held.map((t) => t.uri),
  );
  // The finest tile's floors line up with its own level's chunk edges: the same mesh.
  const fine = (list) => list.find((t) => t.uri === '30m/g0_0.glb');
  assert.ok(fine(tiles).vertices >= fine(held).vertices);
});

test('a streamed build whose heights fail for a tile: logged with the time, the tile left out, a rerun builds it', async () => {
  const { bbox } = groupBox();
  const argv = [
    '--bbox',
    [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
    '--levels',
    '30',
    '--stream',
    '--no-structures',
  ];
  const out = temporary('blocks-tileset-failing-');
  const good = syntheticReader(bbox);
  // The 30 m lattice tiles (0.14° a side) refused, as a server's 4xx.
  const failing = async (request) => {
    if (request.box.east - request.box.west < 0.2) {
      const error = new Error('refused');
      error.status = 400;
      throw error;
    }
    return good(request);
  };
  const lines = [];
  const run = (fetchValues) =>
    main({
      argv: [...argv, '--out', out],
      fetchValues,
      log: (line) => lines.push(line),
    });
  assert.equal(await run(failing), 0);
  assert.ok(lines.some((line) => /^values 400 at 512 cells/.test(line)));
  assert.ok(
    lines.some((line) => /^tile 30m\/g0_0\.glb: heights failed/.test(line)),
  );
  assert.ok(
    lines.some((line) =>
      /^1 tiles without heights, left for a rerun: 30m\/g0_0\.glb$/.test(line),
    ),
  );
  assert.ok(
    lines.some((line) => /^first failed values read at \d{4}-/.test(line)),
  );
  assert.ok(
    fs
      .readFileSync(path.join(out, 'build.log'), 'utf8')
      .includes('heights failed'),
  );
  // Again with the heights: that tile built, the rest kept.
  lines.length = 0;
  assert.equal(await run(good), 0);
  assert.ok(
    lines.includes('16 of 17 tiles kept (inputs unchanged)'),
    lines.join('\n'),
  );
  assert.ok(fs.existsSync(path.join(out, '30m/g0_0.glb')));
});

test('land only: the finest groups over open sea are not built or read, their parents stand in, and the reads are listed', async () => {
  // Open sea west of 10° E (0 m), land east (100 m), around the curved box.
  const reader = async ({ box, cells, water }) => {
    const values = new Float32Array(cells * cells);
    for (let row = 0; row < cells; row++)
      for (let col = 0; col < cells; col++) {
        const lon = box.west + ((col + 0.5) / cells) * (box.east - box.west);
        values[row * cells + col] = lon < 10 ? 0 : 100;
      }
    return {
      header: { ...box, cols: cells, rows: cells, source: 'synthetic' },
      values,
      ...(water ? { water: new Float32Array(cells * cells) } : {}),
    };
  };
  const asked = [];
  const counted = (request) => {
    asked.push(request);
    return reader(request);
  };
  const argv = [
    '--bbox',
    '7.5,43,12.5,47',
    '--levels',
    '1920',
    '--coarsest',
    '7680',
    '--land-only',
  ];
  const lines = [];
  const list = path.join(temporary('blocks-tileset-reads-'), 'reads.json');
  assert.equal(
    await main({
      argv: [
        ...argv,
        '--out',
        temporary('blocks-tileset-list-'),
        '--list-reads',
        list,
      ],
      fetchValues: counted,
      log: (line) => lines.push(line),
    }),
    0,
  );
  assert.ok(
    lines.includes(
      'land only: 2 of 4 groups at 1920 m over open sea, left to the 7680 m fills',
    ),
    lines.join('\n'),
  );
  const reads = JSON.parse(fs.readFileSync(list, 'utf8'));
  assert.equal(reads.level, 1920);
  assert.ok(
    reads.tiles.length > 0 && reads.tiles.every((t) => t.box.east > 10 - 5),
  );
  // Listing reads nothing at the finest level (1,920 m lattice tiles are 256 cells).
  const finestSide = (256 * 1920) / 111_319.49;
  assert.ok(
    asked.every((r) => Math.abs(r.box.east - r.box.west - finestSide) > 1e-6),
  );
  // The build: the sea groups are 7,680 m fills, the land ones 1,920 m groups.
  const out = temporary('blocks-tileset-land-');
  assert.equal(
    await main({
      argv: [...argv, '--out', out, '--stream'],
      fetchValues: reader,
      log: () => {},
    }),
    0,
  );
  const fine = fs.readdirSync(path.join(out, '1920m')).sort();
  assert.deepEqual(fine, ['g0_-1.glb', 'g0_0.glb']);
  assert.ok(
    fs.existsSync(path.join(out, '7680m/c-1_0.glb')),
    'a sea chunk drawn by its 7,680 m fill',
  );
});

test("the build's flat placement is the live mesher's: a vertex at its levels plus dropAt at its own place, to the millimetre", async () => {
  const { plan, chunksByLevel } = await built();
  const region = levelRegion(plan.anchor, 30);
  const chunk = chunksByLevel.get(30).get('1:1');
  const chunkM = 64 * 30;
  // The live mesher (since 3e4568a1): each vertex dropped by the rest of
  // the curve, the chunk lowered by its corner's drop.
  const live = buildChunkMesh(chunk, {
    blockM: 30,
    levelM: 30,
    flatDrop: {
      lon0: region.lon0,
      lat0: region.lat0,
      regionBlockM: 30,
      cornerM: { x: chunkM, y: chunkM },
    },
  });
  const plain = buildChunkMesh(chunk, { blockM: 30, levelM: 30 });
  const corner = region.chunkOrigin(1, 1).z;
  let worst = 0;
  for (let v = 0; v < plain.positions.length / 3; v++) {
    const x = plain.positions[v * 3] + chunkM;
    const y = plain.positions[v * 3 + 1] + chunkM;
    // The build: its levels plus the drop at its own place (tileMesh).
    const build =
      plain.positions[v * 3 + 2] + region.chunkOrigin(x / chunkM, y / chunkM).z;
    const shown = live.positions[v * 3 + 2] + corner;
    worst = Math.max(worst, Math.abs(build - shown));
  }
  assert.ok(worst < 0.01, `${worst} m apart`);
  assert.ok(plain.positions.length > 300);
});

test("curved placement against the live flat rule: the same within a flat region's reach, apart by h(1 − cos θ) and a lean far out", (t) => {
  // A live flat region at 480 m and a column `d` east of its anchor at
  // height h: the live rule stands it on the ellipsoid under the tangent
  // plane and raises it along the anchor's up; the curved one (the
  // tileset's) raises it along its own place's vertical.
  const anchor = { lon0: 10, lat0: 45 };
  const region = levelRegion(anchor, 480);
  const world = enuTransform({ lon0: region.lon0, lat0: region.lat0 });
  const geodetic = (p) =>
    Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        ...[0, 1, 2].map(
          (c) =>
            world[c] * p[0] +
            world[4 + c] * p[1] +
            world[8 + c] * p[2] +
            world[12 + c],
        ),
      ),
    );
  const apart = (d, h) => {
    const t0 = region.dropAt(d, 0);
    const ground = geodetic([d, 0, t0]);
    const shown = geodetic([d, 0, t0 + h]);
    const lean = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromRadians(ground.longitude, ground.latitude, 0),
      Cesium.Cartesian3.fromRadians(shown.longitude, shown.latitude, 0),
    );
    return { dh: h - shown.height, lean };
  };
  const near = apart(20_000, 300);
  const far = apart(245_000, 1000);
  const mountain = apart(245_000, 3000);
  t.diagnostic(
    `20 km, 300 m: ${near.dh.toFixed(4)} m lower, ${near.lean.toFixed(2)} m lean; ` +
      `245 km, 1,000 m: ${far.dh.toFixed(2)} m, ${far.lean.toFixed(1)} m; ` +
      `245 km, 3,000 m: ${mountain.dh.toFixed(2)} m, ${mountain.lean.toFixed(1)} m`,
  );
  // Within a flat region's reach (20 km) the two agree to millimetres.
  assert.ok(Math.abs(near.dh) < 0.005);
  // Far out the live column sits lower by h(1 − cos θ), θ = d / R, and leans by h sin θ.
  const theta = 245_000 / 6_371_000;
  assert.ok(Math.abs(far.dh - 1000 * (1 - Math.cos(theta))) < 0.1);
  assert.ok(Math.abs(far.lean - 1000 * Math.sin(theta)) < 2);
});

test('the mesher fingerprint: two synthetic tiles carrying every kind of input, flat and curved', () => {
  const chunk = canaryChunk();
  const N = 64;
  const kinds = {
    sea: 0,
    lake: 0,
    land: 0,
    nodata: 0,
    building: 0,
    deck: 0,
    road: 0,
    grass: 0,
  };
  for (let k = 0; k < N * N; k++) {
    const top = chunk.top[k];
    const water = chunk.water[k];
    if (top === NONE) kinds.nodata++;
    else if (water === 0 && top < 0) kinds.sea++;
    else if (water !== NONE) kinds.lake++;
    else kinds.land++;
    if (chunk.structure?.top[k] !== NONE && chunk.structure)
      kinds[
        chunk.structure.material[k] === MATERIALS.ROAD ? 'deck' : 'building'
      ]++;
    if (chunk.material[k] === MATERIALS.ROAD) kinds.road++;
    if (chunk.material[k] === MATERIALS.GRASS) kinds.grass++;
  }
  for (const [kind, count] of Object.entries(kinds))
    assert.ok(count > 0, `no ${kind}`);
  // Meshed as the fingerprint meshes them: skirts, water, shaded corners, both placements.
  for (const [blockM, curved] of [
    [30, false],
    [1920, true],
  ]) {
    const region = levelRegion({ lon0: 10, lat0: 45 }, blockM, curved);
    const tile = {
      level: blockM,
      kind: 'fill',
      gi: 0,
      gj: 0,
      ci: 1,
      cj: 1,
      children: [],
    };
    let stats = null;
    const mesh = tileMesh(
      tile,
      new Map([[blockM, new Map([['1:1', canaryChunk()]])]]),
      region,
      {
        toTile: curved ? tileFrame(tile, region).toTile : null,
        mesher: (c, options) => {
          const out = buildChunkMesh(c, options);
          stats = out.stats;
          return out;
        },
      },
    );
    assert.ok(stats.skirt > 0, 'skirts on the borders');
    assert.ok(stats.water > 0, 'water faces');
    // Shaded corners: a fan's centre below FAN_BELOW_M (30 m), two
    // triangles split by the shading from it up (1,920 m): both paths.
    const coords = mesh.chunks[0].mesh.blockCoords;
    assert.equal(
      coords.some((v) => !Number.isInteger(v)),
      blockM < FAN_BELOW_M,
      'a shaded face centre (ambient occlusion) below 120 m only',
    );
    assert.equal(region.curved, curved);
  }
  const first = meshFingerprint();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(meshFingerprint(), first, 'the same every time');
  assert.equal(buildFingerprint(), first);
});

test('the fingerprint: a refactor keeping the bytes keeps it and every record; a one-constant change in the mesher or the encoder changes it', async () => {
  const fingerprint = meshFingerprint();
  // A refactor: the same mesher reached another way, its arrays copied.
  const refactored = (chunk, options) => {
    const out = buildChunkMesh(chunk, { ...options });
    return {
      ...out,
      positions: Float32Array.from(out.positions),
      indices: Uint32Array.from(out.indices),
    };
  };
  assert.equal(meshFingerprint({ mesher: refactored }), fingerprint);
  // One constant in the mesher: the sun a hundredth of a radian round.
  const sunMoved = (chunk, options) =>
    buildChunkMesh(chunk, {
      ...options,
      sunDir: sunDirection(STUDY_SUN.azimuthDeg + 0.6, STUDY_SUN.elevationDeg),
    });
  assert.notEqual(meshFingerprint({ mesher: sunMoved }), fingerprint);
  // One constant in the encoder: compression off.
  assert.notEqual(
    meshFingerprint({
      encode: (mesh, blockM) => encodeTile(mesh, blockM, { compress: false }),
    }),
    fingerprint,
  );
  // The records follow it: kept with the same fingerprint, all built again with another.
  const { plan, chunksByLevel } = await built();
  const out = temporary('blocks-tileset-fingerprint-');
  await buildTileset(plan, chunksByLevel, { out, fingerprint });
  const same = await buildTileset(plan, chunksByLevel, { out, fingerprint });
  assert.ok(same.tiles.every((tile) => tile.kept));
  const moved = await buildTileset(plan, chunksByLevel, {
    out,
    fingerprint: 'another',
  });
  assert.ok(moved.tiles.every((tile) => !tile.kept));
});

test("the build's own settings shape the digest by value: land only, the split depth, the lattice side", async () => {
  const { plan, chunksByLevel } = await built();
  const tile = tileTree(plan)[0];
  const base = tileDigest(tile, chunksByLevel, null, { fingerprint: 'f' });
  assert.equal(
    tileDigest(tile, chunksByLevel, null, { fingerprint: 'f' }),
    base,
  );
  assert.notEqual(
    tileDigest(tile, chunksByLevel, null, { fingerprint: 'f', landOnly: true }),
    base,
  );
  assert.notEqual(
    tileDigest(tile, chunksByLevel, null, { fingerprint: 'f', splitDepth: 1 }),
    base,
  );
  assert.notEqual(
    tileDigest(tile, chunksByLevel, null, { fingerprint: 'g' }),
    base,
  );
  // The lattice side is the level's (512 cells at 120 m, 256 at 480 m): another level, another digest.
  assert.notEqual(
    tileDigest(
      { ...tile, level: 480 },
      new Map([[480, chunksByLevel.get(120)]]),
      null,
      { fingerprint: 'f' },
    ),
    tileDigest(
      { ...tile, level: 120 },
      new Map([[120, chunksByLevel.get(120)]]),
      null,
      { fingerprint: 'f' },
    ),
  );
});

test('streamed structures: a streamed build with buildings and land cover writes the very tiles a held one does, one Overpass query a group', async () => {
  const { bbox } = groupBox();
  const plan = planTiles(bbox, 30);
  const source = createChunkSource({
    fetchValues: syntheticReader(bbox),
    maxChunks: 4096,
  });
  const chunksByLevel = await loadChunks(plan, source);
  // The same skirt floors for both: the streamed build's summaries.
  const summaries = await summarizeLevels(plan, source);
  const heldQuery = syntheticOverpass(bbox);
  const held = await loadStructures(
    plan,
    chunksByLevel,
    createStructuresSource({
      loadChunk: (region, ci, cj) => source.loadChunk(region, ci, cj),
      query: heldQuery,
    }),
  );
  const heldOut = temporary('blocks-tileset-held-');
  const a = await buildTileset(plan, chunksByLevel, {
    out: heldOut,
    summaries,
    variants: [
      {
        file: 'tileset.json',
        name: 'buildings',
        suffix: '',
        chunksByLevel: held.built,
      },
      {
        file: 'tileset-ground.json',
        name: 'ground',
        suffix: '.ground',
        chunksByLevel: held.ground,
      },
    ],
  });
  const streamQuery = syntheticOverpass(bbox);
  const streamSource = createChunkSource({
    fetchValues: syntheticReader(bbox),
    maxChunks: 64,
  });
  const streamOut = temporary('blocks-tileset-streamed-structures-');
  const b = await buildTileset(plan, null, {
    out: streamOut,
    summaries,
    variants: streamedVariants(
      plan,
      streamSource,
      createStructuresSource({
        loadChunk: (region, ci, cj) => streamSource.loadChunk(region, ci, cj),
        query: streamQuery,
      }),
    ),
  });
  assert.equal(
    streamQuery.count(),
    1,
    'one query for the one 30 m group, both variants',
  );
  const uris = (result) => result.tiles.map((tile) => tile.uri).sort();
  assert.deepEqual(uris(b), uris(a));
  assert.ok(
    uris(a).includes('30m/g0_0.ground.glb') &&
      !uris(a).some((u) => u.startsWith('120m/') && u.includes('.ground')),
  );
  for (const uri of uris(a))
    assert.ok(
      fs
        .readFileSync(path.join(streamOut, uri))
        .equals(fs.readFileSync(path.join(heldOut, uri))),
      `${uri} differs`,
    );
  for (const file of ['tileset.json', 'tileset-ground.json'])
    assert.deepEqual(
      b.tilesets.get(file).root,
      a.tilesets.get(file).root,
      file,
    );
  // --hold keeps a box in memory past the streaming threshold.
  assert.equal(
    parseArgs(['--bbox', '1,1,2,2', '--levels', '30', '--hold', '--dry-run'])
      .hold,
    true,
  );
});
