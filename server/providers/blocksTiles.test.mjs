// Personal fork: the Blocks tilesets' read-only route
// (server/providers/blocksTiles.js): the index of built boxes, files served
// from a box's folder and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BLOCKS_TILES_ROUTE,
  blocksTilesIndex,
  createBlocksTilesHandler,
  resolveBlocksTilesPath,
} from './blocksTiles.js';

/** A box as the build writes it: tileset.json with its extras, the state, a tile. */
async function fakeBox(
  root,
  name,
  { levelsM = [120, 30], groups = [[0, 0]] } = {},
) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '30m'), { recursive: true });
  await fs.mkdir(path.join(dir, 'subtrees', '120m'), { recursive: true });
  const tileset = {
    asset: {
      version: '1.1',
      extras: {
        blocks: {
          anchor: { lon0: -76.64, lat0: 39.24 },
          levelsM,
          variants: [
            { file: 'tileset.json', name: 'buildings' },
            { file: 'tileset-ground.json', name: 'ground' },
          ],
        },
      },
    },
    root: { geometricError: 120 },
  };
  await fs.writeFile(path.join(dir, 'tileset.json'), JSON.stringify(tileset));
  await fs.writeFile(path.join(dir, 'tileset-ground.json'), '{}');
  await fs.writeFile(path.join(dir, 'subtrees', '120m', 'g0_0.json'), '{}');
  const tiles = {};
  for (const [gi, gj] of groups) {
    tiles[`30m/g${gi}_${gj}.glb`] = { stats: { level: 30, kind: 'group' } };
    tiles[`30m/g${gi}_${gj}.ground.glb`] = {
      stats: { level: 30, kind: 'group' },
    };
  }
  tiles['120m/g0_0.glb'] = { stats: { level: 120, kind: 'group' } };
  tiles['30m/f9_9.glb'] = { stats: { level: 30, kind: 'fill' } };
  await fs.writeFile(
    path.join(dir, 'build-state.json'),
    JSON.stringify({ tiles }),
  );
  await fs.writeFile(path.join(dir, 'build.log'), 'private');
  await fs.writeFile(path.join(dir, '30m', 'g0_0.glb'), Buffer.from('glTF'));
  return dir;
}

test('the index: each built box with its levels, date, variants, finest groups and box in degrees', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-blocks-tiles-'));
  await fakeBox(root, 'harbour', {
    groups: [
      [0, 0],
      [1, 0],
    ],
  });
  await fs.mkdir(path.join(root, 'empty'));
  const index = blocksTilesIndex(root);
  assert.equal(index.schema, 'blocks-tiles/1');
  assert.equal(
    index.boxes.length,
    1,
    'a folder without a tileset is not a box',
  );
  const [box] = index.boxes;
  assert.equal(box.name, 'harbour');
  assert.deepEqual(box.levelsM, [120, 30]);
  assert.equal(box.finestM, 30);
  assert.deepEqual(
    box.groups,
    [
      [0, 0],
      [1, 0],
    ],
    'fill tiles and variants are not groups',
  );
  assert.deepEqual(
    box.variants.map((v) => v.file),
    ['tileset.json', 'tileset-ground.json'],
  );
  assert.ok(Date.parse(box.built) > 0);
  // Two 30 m groups east of the anchor: 2 × 7,680 m by 7,680 m.
  const [west, south, east, north] = box.bbox;
  // The anchor snaps to the block graticule (createRegion).
  assert.ok(Math.abs(west - -76.64) < 1e-3 && Math.abs(south - 39.24) < 1e-3);
  assert.ok(Math.abs((east - west) * 86_206 - 15_360) < 60, `${east - west}`);
  assert.ok(Math.abs((north - south) * 111_000 - 7_680) < 60);
  assert.deepEqual(blocksTilesIndex(path.join(root, 'none')).boxes, []);
});

test('files: a box’s JSON and GLB only, never its state or log, nothing outside it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-blocks-tiles-'));
  await fakeBox(root, 'harbour');
  const ok = (p) => resolveBlocksTilesPath(root, p);
  assert.equal(ok('/harbour/tileset.json').contentType, 'application/json');
  assert.equal(ok('/harbour/30m/g0_0.glb').contentType, 'model/gltf-binary');
  assert.equal(ok('/harbour/subtrees/120m/g0_0.json').status, 200);
  assert.equal(ok('/harbour/tileset.json?v=1').status, 200);
  assert.ok(ok('/index.json').json.boxes);
  for (const bad of [
    '/harbour/build-state.json',
    '/harbour/build.log',
    '/harbour/../harbour/tileset.json',
    '/../secret.json',
    '/harbour/%2e%2e/x.json',
    '/harbour\\..\\x.json',
    '/harbour/30m/missing.glb',
    '/harbour/readme.txt',
    '/tileset.json',
    '/harbour/.hidden.json',
    '/C:/x.json',
  ])
    assert.equal(ok(bad).status, 404, bad);
  assert.equal(resolveBlocksTilesPath(root, '/%E0%A4%A').status, 400);
});

test('the handler: GET and HEAD, an ETag and a 304, same-site only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-blocks-tiles-'));
  await fakeBox(root, 'harbour');
  const handler = createBlocksTilesHandler({ root });
  const call = (url, { method = 'GET', headers = {} } = {}) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 0,
        headers: {},
        chunks: [],
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        write(chunk) {
          this.chunks.push(Buffer.from(chunk));
          return true;
        },
        on() {
          return this;
        },
        once() {
          return this;
        },
        emit() {},
        end(chunk) {
          if (chunk) this.chunks.push(Buffer.from(chunk));
          resolve(this);
        },
      };
      handler(
        {
          url,
          method,
          headers: { host: 'localhost:4173', ...headers },
          socket: {},
        },
        res,
      );
    });
  const index = await call('/index.json');
  assert.equal(index.statusCode, 200);
  assert.equal(
    JSON.parse(Buffer.concat(index.chunks)).boxes[0].name,
    'harbour',
  );
  const head = await call('/harbour/30m/g0_0.glb', { method: 'HEAD' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], 4);
  const again = await call('/harbour/30m/g0_0.glb', {
    headers: { 'if-none-match': head.headers.etag },
  });
  assert.equal(again.statusCode, 304);
  assert.equal((await call('/harbour/build.log')).statusCode, 404);
  assert.equal(
    (await call('/harbour/tileset.json', { method: 'POST' })).statusCode,
    405,
  );
  const crossSite = await call('/index.json', {
    headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(BLOCKS_TILES_ROUTE, '/api/blocks/tiles');
});
