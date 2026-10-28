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
  BLOCKS_STYLE_LAYER,
  BLOCKS_STYLE_LEVELS_M,
  blocksLevelM,
  blocksStyleCell,
  blocksStyleLevelFor,
  blocksStyleMode,
  blocksStyleTemplate,
} from './blocksStyle.js';
import { EARTH_ENGINE_LAYERS, layerVariants } from './earthEngineLayers.js';
import {
  ZOOM_VARIANT,
  createEarthEngineService,
  mapRequestFor,
} from '../../server/providers/earthEngine.js';
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

test('blocksStyleLevelFor: the smallest cell of at least two pixels, else the coarsest', () => {
  assert.equal(blocksStyleLevelFor(10), 120);
  assert.equal(blocksStyleLevelFor(100), 480);
  assert.equal(blocksStyleLevelFor(900), 1920);
  assert.equal(blocksStyleLevelFor(5000), 30720);
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

test('the expression: a mean over each cell, quantised to its level, coloured, shaded flat, edged; drawn as RGB', () => {
  const variant = layerVariants(elevation)[0];
  const body = mapRequestFor(elevation, variant, 'default', 'blocks-1920');
  const text = JSON.stringify(body.expression);
  // Every reference is to a value the graph has (none overwritten).
  const { values, result } = body.expression;
  assert.ok(values[result]);
  for (const ref of references(values))
    assert.ok(ref in values, `missing value ${ref}`);
  assert.match(text, /"Image\.reduceResolution"/);
  assert.match(text, /"Reducer\.mean"/);
  assert.match(text, /"Image\.reproject"/);
  assert.match(text, /"scale":\{"constantValue":1920\}/);
  // Quantised to 60 m levels.
  assert.match(text, /"constantValue":60\}/);
  assert.match(text, /"Image\.floor"/);
  assert.match(text, /"Terrain\.hillshade"/);
  assert.match(text, /"Image\.pixelCoordinates"/);
  assert.match(text, /"Image\.visualize"/);
  assert.match(
    text,
    new RegExp(`"palette":\\{"constantValue":\\["${elevation.vis.palette[0]}"`),
  );
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
  // One map a level: each level its own request.
  assert.notEqual(
    JSON.stringify(mapRequestFor(elevation, variant, 'default', 'blocks-480')),
    JSON.stringify(body),
  );
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
  const ask = (mode, scale) =>
    service.tile(
      'ee-elevation',
      ZOOM_VARIANT,
      'default',
      4,
      4,
      6,
      mode,
      ...(scale ? [scale] : []),
    );
  const first = await ask('blocks-1920');
  assert.equal(first.status, 200);
  assert.equal(first.body.toString(), '4/4/6');
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
