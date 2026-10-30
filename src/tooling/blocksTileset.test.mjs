// Personal fork: the Blocks tileset build (scripts/blocks-tileset.mjs,
// docs/BLOCKS-PLAN.md milestone 6 step A): its arguments, the tree of
// levels and fill tiles, the quantised columns and the meshes against
// golden values from a synthetic height reader (sea, land, a hill, a lake
// in the water plane, a nodata patch), the glTF's layout, and the
// tileset read by Cesium's own loader from the files written.
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
  buildTileset,
  encodeGlb,
  levelRegion,
  loadChunks,
  main,
  parseArgs,
  planLatticeTiles,
  planTiles,
  tileTree,
  walkTiles,
} from '../../scripts/blocks-tileset.mjs';
import { createChunkSource } from '../layers/blocks/source.js';
import { NONE } from '../layers/blocks/store.js';

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
  const result = buildTileset(plan, chunksByLevel, {
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
  assert.deepEqual(TILESET_LEVELS_M, [30, 120, 480]);
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
  assert.match(
    parseArgs([
      '--bbox',
      '-76.7,39.2,-76.5,39.3',
      '--levels',
      '1920',
      '--out',
      'x',
    ]).error,
    /flat/,
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

test('meshes (golden): tile sizes and geometry, opaque then water, in the tile frame', async () => {
  const { tiles, out } = await built();
  const summary = tiles.map(
    ({ uri, vertices, indices }) => `${uri} ${vertices} ${indices / 3}`,
  );
  assert.equal(tiles.length, 17);
  const geometry = createHash('sha256');
  let deepestDropM = 0;
  for (const { uri, level } of tiles) {
    const { arrays, geometryKey } = readGlb(
      fs.readFileSync(path.join(out, uri)),
    );
    geometry.update(geometryKey);
    // Each position is its block point in the tile's frame: columns × the
    // block east and north of the tile's corner, levels × 30 m up, less
    // the ellipsoid's drop under the plane (y up: east, up, -north).
    const [positions, , , coords] = [
      arrays[0],
      arrays[1],
      arrays[2],
      arrays[3],
    ];
    const fill = /\/c(\d+)_(\d+)\.glb$/.exec(uri);
    const group = /\/g(\d+)_(\d+)\.glb$/.exec(uri);
    const columns = fill ? 64 : 256;
    const [a, b] = (fill || group).slice(1).map(Number);
    for (let v = 0; v < positions.length / 3; v++) {
      const east = positions[v * 3];
      const up = positions[v * 3 + 1];
      const north = -positions[v * 3 + 2];
      assert.ok(Math.abs(east - (coords[v * 3] - a * columns) * level) < 0.01);
      assert.ok(
        Math.abs(north - (coords[v * 3 + 1] - b * columns) * level) < 0.01,
      );
      const drop = up - coords[v * 3 + 2] * 30;
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
  assert.deepEqual(summary, [
    '120m/g0_0.glb 5378 4024',
    '30m/g0_0.glb 16046 11950',
    '120m/c1_0.glb 129 84',
    '120m/c2_0.glb 86 52',
    '120m/c3_0.glb 175 116',
    '120m/c0_1.glb 137 88',
    '120m/c1_1.glb 172 116',
    '120m/c2_1.glb 86 52',
    '120m/c3_1.glb 108 66',
    '120m/c0_2.glb 140 88',
    '120m/c1_2.glb 86 52',
    '120m/c2_2.glb 172 116',
    '120m/c3_2.glb 108 66',
    '120m/c0_3.glb 116 70',
    '120m/c1_3.glb 86 52',
    '120m/c2_3.glb 129 84',
    '120m/c3_3.glb 280 194',
  ]);
  assert.equal(geometry.digest('hex').slice(0, 16), '028f881070a291a4');
});

/**
 * A binary glTF read back: its JSON, every accessor's typed array, and a
 * key of its block coordinates and indices (for the golden geometry).
 */
function readGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(jsonLength % 4, 0);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binAt = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binAt);
  assert.equal(bytes.readUInt32LE(binAt + 4), 0x004e4942);
  assert.equal(binLength % 4, 0);
  assert.equal(json.buffers[0].byteLength, binLength);
  const bin = bytes.subarray(binAt + 8, binAt + 8 + binLength);
  const TYPES = {
    5126: Float32Array,
    5125: Uint32Array,
    5123: Uint16Array,
    5121: Uint8Array,
  };
  const SIZES = { SCALAR: 1, VEC3: 3, VEC4: 4 };
  const arrays = json.accessors.map((accessor) => {
    const view = json.bufferViews[accessor.bufferView];
    const Type = TYPES[accessor.componentType];
    const offset = view.byteOffset + (accessor.byteOffset || 0);
    assert.equal(offset % Type.BYTES_PER_ELEMENT, 0, 'aligned');
    const length = accessor.count * SIZES[accessor.type];
    assert.ok(
      offset + length * Type.BYTES_PER_ELEMENT <=
        view.byteOffset + view.byteLength,
    );
    const copy = new Uint8Array(
      bin.subarray(offset, offset + length * Type.BYTES_PER_ELEMENT),
    );
    return new Type(copy.buffer);
  });
  const indexArrays = json.meshes[0].primitives.map(
    (primitive) => arrays[primitive.indices],
  );
  // The block points and the triangles: exact, unlike the placed positions.
  const geometryKey = Buffer.concat(
    [arrays[3], ...indexArrays].map((array) => Buffer.from(array.buffer)),
  );
  return { json, arrays, geometryKey };
}

test('glTF layout: shared attributes, opaque and blended water primitives, bounds and indices in range', async () => {
  const { tiles, out } = await built();
  const withWater = [];
  for (const { uri, vertices } of tiles) {
    const { json, arrays } = readGlb(fs.readFileSync(path.join(out, uri)));
    const [primitive] = json.meshes[0].primitives;
    assert.deepEqual(primitive.attributes, {
      POSITION: 0,
      NORMAL: 1,
      COLOR_0: 2,
      _BLOCK_COORD: 3,
    });
    assert.equal(json.accessors[2].normalized, true);
    assert.deepEqual(json.extensionsUsed, ['KHR_materials_unlit']);
    assert.equal(json.materials[1].alphaMode, 'BLEND');
    // POSITION's min and max are the positions' own.
    const positions = arrays[0];
    for (let c = 0; c < 3; c++) {
      let min = Infinity;
      let max = -Infinity;
      for (let k = c; k < positions.length; k += 3) {
        min = Math.min(min, positions[k]);
        max = Math.max(max, positions[k]);
      }
      assert.equal(json.accessors[0].min[c], min);
      assert.equal(json.accessors[0].max[c], max);
    }
    for (const p of json.meshes[0].primitives) {
      for (const index of arrays[p.indices]) assert.ok(index < vertices);
      assert.equal(p.mode, 4);
    }
    if (json.meshes[0].primitives.some((p) => p.material === 1))
      withWater.push(uri);
  }
  assert.ok(withWater.includes('30m/g0_0.glb'), 'the sea is water');
  // Block coordinates: whole or half columns from the anchor, levels in range.
  const { arrays } = readGlb(fs.readFileSync(path.join(out, '30m/g0_0.glb')));
  const coords = arrays[3];
  for (let k = 0; k < coords.length; k++)
    assert.ok(Number.isInteger(coords[k] * 2), `block coordinate ${coords[k]}`);
  assert.ok(Math.max(...coords.filter((_, k) => k % 3 === 0)) <= 256);
});

test("glTF's y up: Cesium's Y_UP_TO_Z_UP turns (east, up, -north) back to east, north, up", () => {
  const glb = encodeGlb({
    positions: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Uint8Array(12).fill(255),
    blockCoords: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]),
    opaqueIndexCount: 3,
  });
  const { arrays } = readGlb(glb);
  const turned = Cesium.Matrix4.multiplyByPoint(
    Cesium.Axis.Y_UP_TO_Z_UP,
    new Cesium.Cartesian3(arrays[0][0], arrays[0][1], arrays[0][2]),
    new Cesium.Cartesian3(),
  );
  assert.deepEqual(
    [turned.x, turned.y, turned.z].map((v) => Math.round(v * 1e6) / 1e6),
    [1, 2, 3],
  );
  const up = Cesium.Matrix4.multiplyByPointAsVector(
    Cesium.Axis.Y_UP_TO_Z_UP,
    new Cesium.Cartesian3(arrays[1][0], arrays[1][1], arrays[1][2]),
    new Cesium.Cartesian3(),
  );
  assert.deepEqual(
    [up.x, up.y, up.z].map((v) => Math.round(v * 1e6) / 1e6 + 0),
    [0, 0, 1],
  );
  assert.equal(encodeGlb({ ...emptyMesh() }), null);
});

const emptyMesh = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Uint8Array(0),
  blockCoords: new Float32Array(0),
  indices: new Uint32Array(0),
  opaqueIndexCount: 0,
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
      Object.keys(loader.gltfJson.meshes[0].primitives[0].attributes),
      ['POSITION', 'NORMAL', 'COLOR_0', '_BLOCK_COORD'],
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
  assert.equal(
    await main({
      argv: [...argv, '--out', out],
      fetchValues: syntheticReader(bbox, asked),
      log: (line) => lines.push(line),
    }),
    0,
  );
  assert.ok(fs.existsSync(path.join(out, 'tileset.json')));
  assert.ok(lines.some((line) => /^30 m: 1 tiles/.test(line)));
  assert.equal(await main({ argv: ['--levels', '30'], log: () => {} }), 2);
});
