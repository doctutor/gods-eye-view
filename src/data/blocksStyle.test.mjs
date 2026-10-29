// Personal fork: Elevation's Blocks style (src/data/blocksStyle.js and
// server/providers/earthEngine.js blocksStyleExpression): its levels and
// modes, the level-height rule, the footprint pick, the Earth Engine
// expression, and the tile route's 'blocks-<cellM>' modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BLOCKS_STYLE_EDGE_TONE,
  BLOCKS_STYLE_TERRAIN_RGB,
  BLOCKS_STYLE_TOP_LIGHT,
  BLOCKS_STYLE_WATER_RGB,
  blocksStyleLit,
  BLOCKS_STYLE_LAYER,
  BLOCKS_STYLE_LEVELS_M,
  BLOCKS_STYLE_MAX_ZOOM,
  blocksStyleZoom,
  blocksStyleZoomBand,
  blocksLevelM,
  blocksStyleCell,
  blocksStyleLevelFor,
  blocksStyleMode,
  blocksStyleTemplate,
} from './blocksStyle.js';
import { EARTH_ENGINE_LAYERS, layerVariants } from './earthEngineLayers.js';
import {
  BLOCKS_EDGE_PARTS,
  BLOCKS_MEAN_SUB,
  TRANSPARENT_TILE,
  ZOOM_VARIANT,
  blocksStyleGrid,
  createEarthEngineService,
  mapRequestFor,
} from '../../server/providers/earthEngine.js';
import { latticeBox } from '../layers/blocks/lattice.js';
import {
  FACE_SHADE,
  MATERIAL_COLORS,
  litColor,
  sunTerm,
} from '../layers/blocks/lighting.js';
import { MATERIALS } from '../layers/blocks/store.js';
import { EDGE_DEFAULTS } from '../layers/blocks/renderer.js';
import { BLOCK_PYRAMID_M, levelMFor } from '../layers/blocks/pyramid.js';

const elevation = EARTH_ENGINE_LAYERS.find(
  (layer) => layer.id === BLOCKS_STYLE_LAYER,
);

test('the levels are the pyramid’s coarse ones; a mode names its cell', () => {
  assert.deepEqual(
    [...BLOCKS_STYLE_LEVELS_M],
    BLOCK_PYRAMID_M.filter((level) => level > 30),
  );
  for (const cellM of BLOCKS_STYLE_LEVELS_M)
    assert.equal(blocksLevelM(cellM), levelMFor(cellM));
  assert.equal(blocksStyleMode(1920), 'blocks-1920');
  assert.equal(blocksStyleCell('blocks-1920'), 1920);
  assert.equal(blocksStyleCell('blocks-1000'), null);
  assert.equal(blocksStyleCell('default'), null);
  assert.equal(
    blocksStyleTemplate(480),
    '/api/earth-engine/tile/ee-elevation/blocks-480/{variant}/default/{z}/{x}/{y}',
  );
});

test('blocksLevelM: cubes to 30 m, then max(30 m, cell / 32)', () => {
  assert.equal(blocksLevelM(1), 1);
  assert.equal(blocksLevelM(30), 30);
  assert.equal(blocksLevelM(120), 30);
  assert.equal(blocksLevelM(480), 30);
  assert.equal(blocksLevelM(1920), 60);
  assert.equal(blocksLevelM(7680), 240);
  assert.equal(blocksLevelM(30720), 960);
});

test('blocksStyleLevelFor: the smallest cell of at least eight pixels (an edge line of one), else the coarsest', () => {
  assert.equal(blocksStyleLevelFor(10), 120);
  assert.equal(blocksStyleLevelFor(15), 120);
  assert.equal(blocksStyleLevelFor(50), 480);
  assert.equal(blocksStyleLevelFor(200), 1920);
  assert.equal(blocksStyleLevelFor(900), 7680);
  assert.equal(blocksStyleLevelFor(3000), 30720);
  assert.equal(blocksStyleLevelFor(1e6), 30720);
});

/** Every valueReference in a node graph, with where it is used. */
function references(node, out = []) {
  if (Array.isArray(node)) for (const item of node) references(item, out);
  else if (node && typeof node === 'object') {
    if (typeof node.valueReference === 'string') out.push(node.valueReference);
    for (const value of Object.values(node)) references(value, out);
  }
  return out;
}

/** The arguments of every call to `name` in a node graph. */
function callsOf(node, name, out = []) {
  if (Array.isArray(node)) for (const item of node) callsOf(item, name, out);
  else if (node && typeof node === 'object') {
    if (node.functionInvocationValue?.functionName === name)
      out.push(node.functionInvocationValue.arguments);
    for (const value of Object.values(node)) callsOf(value, name, out);
  }
  return out;
}

test('the expression: every property a cell’s own: heights averaged on the cell grid, water by share, level, colour and shade from the cells, edges an eighth on a grid of eighths', () => {
  const variant = layerVariants(elevation)[0];
  const body = mapRequestFor(elevation, variant, 'default', 'blocks-1920');
  const text = JSON.stringify(body.expression);
  // Every reference is to a value the graph has (none overwritten).
  const { values, result } = body.expression;
  assert.ok(values[result]);
  for (const ref of references(values))
    assert.ok(ref in values, `missing value ${ref}`);
  // 1,920 m and up read the far band (GMTED 230 m), whatever the tile.
  assert.match(text, /USGS\/GMTED2010_FULL/);
  assert.doesNotMatch(text, /FABDEM/);
  assert.match(
    JSON.stringify(mapRequestFor(elevation, variant, 'default', 'blocks-480')),
    /FABDEM/,
  );
  // Grids: the cell's, its quarters (the mean's samples) and its eighths
  // (the edges), all from 180° W and whole cells from 90° S.
  const cell = blocksStyleGrid(1920);
  assert.ok(Math.abs(cell.deg - 1920 / 111_319.49) < 1e-12);
  assert.ok(
    Math.abs(((cell.top + 90) / cell.deg) % 1) < 1e-6 ||
      Math.abs((((cell.top + 90) / cell.deg) % 1) - 1) < 1e-6,
  );
  const transforms = callsOf(body.expression, 'Image.reproject').map(
    ({ crsTransform }) => crsTransform.constantValue,
  );
  assert.ok(transforms.length >= 4);
  const parts = new Set(transforms.map((t) => Math.round(cell.deg / t[0])));
  assert.deepEqual(
    [...parts].sort((a, b) => a - b),
    [1, BLOCKS_EDGE_PARTS],
  );
  for (const t of transforms) {
    assert.equal(t[2], -180);
    assert.ok(Math.abs(t[5] - cell.top) < 1e-9);
    assert.equal(t[4], -t[0]);
  }
  // The mean: BLOCKS_MEAN_SUB² samples at a quarter cell.
  const reduced = callsOf(body.expression, 'Image.reduceResolution');
  // The heights, the share with heights and the share that is water.
  assert.equal(reduced.length, 3);
  for (const { maxPixels, image } of reduced) {
    assert.equal(maxPixels.constantValue, BLOCKS_MEAN_SUB ** 2);
    const grid =
      image.functionInvocationValue.arguments.crsTransform.constantValue;
    assert.ok(Math.abs(grid[0] - cell.deg / BLOCKS_MEAN_SUB) < 1e-15);
  }
  // Water: under half the samples with heights, or a mean at or below 0 m,
  // in the Blocks water colour.
  assert.ok(
    callsOf(body.expression, 'Image.lt').some((call) =>
      /"constantValue":0\.5/.test(JSON.stringify(call.image2)),
    ),
  );
  // Lakes: a cell at least half water in JRC Global Surface Water
  // (occurrence ≥ 50 %, averaged on the cell grid) is coloured as water,
  // and keeps its level: the sea's rule alone sets a level to 0.
  assert.match(text, /JRC\/GSW1_4\/GlobalSurfaceWater/);
  const occurrence = callsOf(body.expression, 'Image.select').find((call) =>
    /"occurrence"/.test(JSON.stringify(call.bandSelectors)),
  );
  assert.ok(occurrence, 'the occurrence band');
  assert.ok(
    callsOf(body.expression, 'Image.gte').some(
      (call) =>
        /"constantValue":50\}/.test(JSON.stringify(call.image2)) &&
        /"occurrence"/.test(JSON.stringify(call.image1)),
    ),
  );
  const lake = callsOf(body.expression, 'Image.gte').find(
    (call) =>
      /"constantValue":0\.5\}/.test(JSON.stringify(call.image2)) &&
      /GSW1_4/.test(JSON.stringify(call.image1)),
  );
  assert.ok(lake, 'a lake: the water share ≥ 0.5');
  assert.ok(
    callsOf(lake.image1, 'Image.reduceResolution').length === 1,
    'the share is the mean on the cell grid',
  );
  const [level] = callsOf(body.expression, 'Image.where');
  assert.doesNotMatch(JSON.stringify(level), /GSW1_4/);
  // The geometry's colours, lit as a top face under the study sun.
  assert.ok(
    text.includes(
      `"constantValue":[${blocksStyleLit(BLOCKS_STYLE_WATER_RGB)}]`,
    ),
  );
  assert.ok(
    text.includes(
      `"constantValue":[${blocksStyleLit(BLOCKS_STYLE_TERRAIN_RGB)}]`,
    ),
  );
  // No height ramp: the Elevation palette is not the style's.
  assert.equal(callsOf(body.expression, 'Image.visualize').length, 0);
  assert.ok(!text.includes(elevation.vis.palette[0]));
  // The level: 60 m steps of the cell mean; the shade from it.
  assert.match(text, /"constantValue":60\}/);
  const shade = callsOf(body.expression, 'Terrain.hillshade');
  assert.equal(shade.length, 1);
  assert.ok(shade[0].input.valueReference);
  // The edges: the westmost and southmost of eight parts.
  assert.match(text, /"Image\.pixelCoordinates"/);
  const mods = callsOf(body.expression, 'Image.mod');
  assert.equal(mods.length, 2);
  for (const { image2 } of mods)
    assert.match(JSON.stringify(image2), /"constantValue":8\}/);
  // Fill values masked in each source before it is resampled or averaged.
  assert.match(text, /"Image\.gte".{0,200}"constantValue":-500/s);
  assert.match(text, /"Image\.lte".{0,200}"constantValue":9000/s);
  // Already coloured: drawn 0 to 255, no palette of the map's own.
  assert.deepEqual(body.visualizationOptions, {
    ranges: [{ min: 0, max: 255 }],
  });
  // The ordinary Elevation map is as it was.
  const plain = mapRequestFor(elevation, variant, 'default');
  assert.doesNotMatch(
    JSON.stringify(plain.expression),
    /reduceResolution|pixelCoordinates/,
  );
  assert.ok(plain.visualizationOptions.paletteColors.length > 1);
});

test('blocksStyleGrid: a style cell is a Blocks lattice cell (the same edges)', () => {
  for (const cellM of BLOCKS_STYLE_LEVELS_M) {
    const { deg, top } = blocksStyleGrid(cellM);
    const box = latticeBox(cellM, 3, 2);
    const k = (box.south - (top - Math.ceil(180 / deg) * deg)) / deg;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `${cellM}: ${k}`);
    const i = (box.west + 180) / deg;
    assert.ok(Math.abs(i - Math.round(i)) < 1e-6);
  }
});

function fakeBackend() {
  const made = [];
  const tiles = [];
  return {
    made,
    tiles,
    async createMap(layer, variant, ink, mode) {
      made.push(`${layer.id}/${variant.key}/${ink}/${mode ?? 'default'}`);
      return { name: `projects/p/maps/${layer.id}-${made.length}` };
    },
    async fetchTile(name, z, x, y) {
      tiles.push(`${name}/${z}/${x}/${y}`);
      return {
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(`${z}/${x}/${y}`),
      };
    },
  };
}

test('the tile route: blocks-<cellM> modes on Elevation, made when asked, kept, counted; others refused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-blocks-style-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: { EARTH_ENGINE_DAILY_TILES: '2' },
    backend,
  });
  // Each level at a zoom in its band (the Chesapeake's tile).
  const at = {
    'blocks-480': [11, 590, 786],
    'blocks-1920': [9, 147, 196],
    'blocks-7680': [7, 36, 49],
  };
  const ask = (mode, scale) =>
    service.tile(
      'ee-elevation',
      ZOOM_VARIANT,
      'default',
      ...(at[mode] || [9, 147, 196]),
      mode,
      ...(scale ? [scale] : []),
    );
  const first = await ask('blocks-1920');
  assert.equal(first.status, 200);
  assert.equal(first.body.toString(), '9/147/196');
  assert.equal(backend.made.length, 1);
  assert.match(backend.made[0], /^ee-elevation\/.+\/default\/blocks-1920$/);
  // Kept on disk: the second ask costs nothing.
  assert.equal((await ask('blocks-1920')).cached, true);
  assert.equal(backend.tiles.length, 1);
  // Another level is another map.
  assert.equal((await ask('blocks-7680')).status, 200);
  assert.equal(backend.made.length, 2);
  // Past the day's tiles: 429, as for the layer's own tiles.
  assert.equal((await ask('blocks-480')).status, 429);
  assert.equal((await ask('blocks-1000')).status, 404);
  assert.equal(
    (
      await service.tile(
        'ee-forest-loss',
        'default',
        'default',
        3,
        2,
        1,
        'blocks-1920',
      )
    ).status,
    404,
  );
  assert.equal((await ask('blocks-1920', 'anything')).status, 400);
  // The catalog makes none of them.
  const before = backend.made.length;
  const catalog = await service.layers();
  assert.ok(!backend.made.slice(before).some((entry) => /blocks-/.test(entry)));
  const row = catalog.layers.find((entry) => entry.id === 'ee-elevation');
  assert.ok(row);
});

test('blocksStyleZoomBand: from two zooms under a level’s own (a cell of up to 8 px) to the layer’s deepest', () => {
  assert.equal(BLOCKS_STYLE_MAX_ZOOM, elevation.maxZoom);
  const own = Object.fromEntries(
    BLOCKS_STYLE_LEVELS_M.map((cellM) => [cellM, blocksStyleZoom(cellM)]),
  );
  assert.deepEqual(own, { 120: 13, 480: 11, 1920: 9, 7680: 7, 30720: 5 });
  assert.deepEqual(blocksStyleZoomBand(1920), { min: 7, max: 14 });
  assert.deepEqual(blocksStyleZoomBand(7680), { min: 5, max: 14 });
  assert.deepEqual(blocksStyleZoomBand(30720), { min: 3, max: 14 });
  assert.deepEqual(blocksStyleZoomBand(120), { min: 11, max: 14 });
  // A cell at its own zoom is at most 8 px on the equator, over 4.
  for (const cellM of BLOCKS_STYLE_LEVELS_M) {
    const px = cellM / (156_543.03392804097 / 2 ** blocksStyleZoom(cellM));
    assert.ok(px > 4 && px <= 8, `${cellM}: ${px}`);
  }
});

test('under its band a level’s tile is blank: 200, the transparent PNG, no map, no Earth Engine, nothing counted', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-blocks-band-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: { EARTH_ENGINE_DAILY_TILES: '1' },
    backend,
  });
  const tile = (mode, z, x, y) =>
    service.tile('ee-elevation', ZOOM_VARIANT, 'default', z, x, y, mode);
  // The tile that timed out live: 1,920 m at z 4 (its band starts at 7).
  for (const [mode, z, x, y] of [
    ['blocks-1920', 4, 4, 5],
    ['blocks-1920', 6, 18, 24],
    ['blocks-7680', 4, 4, 5],
    ['blocks-30720', 2, 1, 1],
    ['blocks-120', 10, 294, 393],
  ]) {
    const blank = await tile(mode, z, x, y);
    assert.equal(blank.status, 200, `${mode} z${z}`);
    assert.equal(blank.blank, true);
    assert.equal(blank.contentType, 'image/png');
    assert.equal(blank.body, TRANSPARENT_TILE);
  }
  assert.equal(backend.made.length, 0);
  assert.equal(backend.tiles.length, 0);
  assert.equal((await service.budget()).total, 0);
  // At the band's first zoom it is Earth Engine's (the day's one tile).
  const drawn = await tile('blocks-1920', 7, 36, 49);
  assert.equal(drawn.status, 200);
  assert.notEqual(drawn.blank, true);
  assert.equal(backend.made.length, 1);
  // Out of range is still out of range.
  assert.equal((await tile('blocks-1920', 4, 16, 0)).status, 400);
});

test("the style's colours are the geometry's: lighting.js's sand and water, a top face's light, the renderer's edge", () => {
  const rgb = (material) => [...MATERIAL_COLORS[material]].slice(0, 3);
  assert.deepEqual([...BLOCKS_STYLE_TERRAIN_RGB], rgb(MATERIALS.TERRAIN));
  assert.deepEqual([...BLOCKS_STYLE_WATER_RGB], rgb(MATERIALS.WATER));
  const top = FACE_SHADE.up * sunTerm({ east: 0, north: 0, up: 1 });
  assert.ok(Math.abs(BLOCKS_STYLE_TOP_LIGHT - top) < 1e-12);
  assert.equal(BLOCKS_STYLE_EDGE_TONE, 1 - EDGE_DEFAULTS.strength);
  // A flat cell is the colour of a lit top face (litColor's rounding).
  const lit = litColor(MATERIALS.TERRAIN, top);
  assert.deepEqual(blocksStyleLit(BLOCKS_STYLE_TERRAIN_RGB), lit.slice(0, 3));
});
