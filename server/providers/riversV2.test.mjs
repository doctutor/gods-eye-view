// Personal fork: the self-hosted HydroSHEDS v2 rivers' bands, tile maths,
// level files, renderer and routes (server/providers/riversV2.js and
// server/providers/riversV2/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BANDS,
  INKS,
  MAX_ORDER,
  MAX_ZOOM,
  bandForZoom,
  minUplandForOrder,
  orderForUpland,
  quantBitsFor,
  styleSpec,
  tileVersion,
  widthFor,
} from './riversV2/bands.js';
import {
  createLevelWriter,
  decodeCell,
  encodePiece,
  openLevel,
  readLevelHeader,
  unzigzag,
  zigzag,
} from './riversV2/levelFile.js';
import {
  EMPTY_PNG,
  createCoverage,
  encodePng,
  parseInk,
} from './riversV2/render.js';
import { renderTileCoverage } from './riversV2/tiles.js';
import {
  boxesOverlap,
  cellKey,
  cellRange,
  latOf,
  lonOf,
  tileBounds,
  tileWorldBox,
  validTile,
  worldBoxOfBounds,
  worldX,
  worldY,
} from './riversV2/tileMath.js';
import {
  ATTRIBUTION,
  NEEDS_BUILD,
  createRiversV2Handler,
  createRiversV2Service,
  riversCacheDir,
} from './riversV2.js';

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-rivers-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** A PNG's size, colour type and pixels (filter 0 rows only, as written). */
export function decodePng(png) {
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    assert.equal(crc, zlib.crc32(png.subarray(at + 4, at + 8 + length)) >>> 0);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const channels = colorType === 4 ? 2 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  const alpha = (x, y) => {
    assert.equal(raw[y * stride], 0, 'filter 0');
    return raw[y * stride + 1 + x * channels + channels - 1];
  };
  const color = (x, y) => [
    ...raw.subarray(
      y * stride + 1 + x * channels,
      y * stride + 1 + (x + 1) * channels,
    ),
  ];
  return { width, height, colorType, alpha, color };
}

// --- bands ------------------------------------------------------------------

test('upstream area maps to v1-equivalent orders by decade', () => {
  assert.equal(orderForUpland(5_946_076), 2, 'the Amazon');
  assert.equal(orderForUpland(3_181_270), 2, 'the Mississippi');
  assert.equal(orderForUpland(10_000_000), 1);
  assert.equal(orderForUpland(1_000_000), 2);
  assert.equal(orderForUpland(999_999), 3);
  assert.equal(orderForUpland(100), 6);
  assert.equal(orderForUpland(99.9), 7);
  assert.equal(orderForUpland(1), 8, "v2's 1 km² threshold");
  assert.equal(orderForUpland(0.5), MAX_ORDER, 'clamped');
  assert.equal(orderForUpland(1e9), 1, 'clamped');
  assert.equal(orderForUpland(Number.NaN), MAX_ORDER);
  for (let order = 1; order <= MAX_ORDER; order++)
    assert.equal(orderForUpland(minUplandForOrder(order)), order);
});

test('the bands cover zoom 0 to 14 once each and thin by order', () => {
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const matching = BANDS.filter(
      (band) => z >= band.minZoom && z <= band.maxZoom,
    );
    assert.equal(matching.length, 1, `zoom ${z}`);
    assert.equal(bandForZoom(z), matching[0]);
  }
  assert.equal(bandForZoom(MAX_ZOOM + 1), null);
  assert.equal(MAX_ZOOM, 14);
  const orders = BANDS.map((band) => band.maxOrder);
  assert.deepEqual(
    orders,
    [...orders].sort((a, b) => a - b),
    'never fewer rivers deeper',
  );
  assert.equal(bandForZoom(0).maxOrder, 3);
  assert.equal(
    bandForZoom(14).maxOrder,
    MAX_ORDER,
    'every v2 reach at the street',
  );
  for (const band of BANDS) {
    assert.ok(
      band.gridZoom <= band.maxZoom,
      `${band.level}: a tile is inside a cell`,
    );
    assert.ok(quantBitsFor(band) <= 28);
    assert.equal(band.minUplandKm2, minUplandForOrder(band.maxOrder));
  }
});

test('line width grows with river size and stays in bounds', () => {
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const band = bandForZoom(z);
    assert.equal(
      widthFor(band.maxOrder, z),
      0.75,
      'the smallest drawn is thin',
    );
    for (let order = 2; order <= band.maxOrder; order++)
      assert.ok(widthFor(order - 1, z) >= widthFor(order, z));
    assert.ok(widthFor(1, z) <= 4);
  }
});

test('the tile version hashes the style and the build', () => {
  const light = tileVersion('light', 'build-a');
  assert.match(light, /^[0-9a-f]{12}$/);
  assert.equal(tileVersion('light', 'build-a'), light, 'stable');
  assert.notEqual(tileVersion('dark', 'build-a'), light, 'per ink');
  assert.notEqual(tileVersion('light', 'build-b'), light, 'per build');
  assert.equal(styleSpec('light').ink, INKS.light);
  assert.equal(INKS.light, 'ffffffcc');
  assert.equal(INKS.dark, '1a1a1acc');
});

// --- tile maths -------------------------------------------------------------

test('Web Mercator round trips and tile boxes', () => {
  assert.equal(worldX(-180), 0);
  assert.equal(worldX(0), 0.5);
  assert.equal(worldY(0), 0.5);
  assert.ok(Math.abs(worldY(85.05112877980659)) < 1e-12);
  for (const lat of [-60, -1.5, 0, 45, 83])
    assert.ok(Math.abs(latOf(worldY(lat)) - lat) < 1e-9);
  assert.ok(Math.abs(lonOf(worldX(-97.3)) + 97.3) < 1e-9);
  assert.deepEqual(tileWorldBox(1, 1, 0), { x0: 0.5, y0: 0, x1: 1, y1: 0.5 });
  const bounds = tileBounds(2, 1, 1);
  assert.equal(bounds.west, -90);
  assert.equal(bounds.east, 0);
  assert.ok(Math.abs(bounds.south) < 1e-9);
  assert.ok(bounds.north > 66 && bounds.north < 67);
  assert.ok(validTile(0, 0, 0));
  assert.ok(validTile(14, 16383, 0, 14));
  assert.ok(!validTile(14, 16384, 0, 14));
  assert.ok(!validTile(15, 0, 0, 14));
  assert.ok(!validTile(-1, 0, 0));
  assert.ok(!validTile(1.5, 0, 0));
  const americas = worldBoxOfBounds({
    west: -170,
    south: -56,
    east: -32,
    north: 83,
  });
  assert.ok(boxesOverlap(tileWorldBox(2, 0, 1), americas));
  assert.ok(!boxesOverlap(tileWorldBox(2, 3, 1), americas), 'Asia');
  assert.deepEqual(cellRange({ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.26 }, 2), {
    cx0: 0,
    cy0: 0,
    cx1: 1,
    cy1: 1,
  });
  assert.deepEqual(cellRange({ x0: -0.1, y0: -1, x1: 2, y1: 2 }, 1), {
    cx0: 0,
    cy0: 0,
    cx1: 1,
    cy1: 1,
  });
  assert.equal(cellKey(3, 2, 2), 11);
});

// --- level files ------------------------------------------------------------

test('zigzag and piece encoding round trip', () => {
  for (const n of [0, 1, -1, 63, -64, 1e6, -(2 ** 28)])
    assert.equal(unzigzag(zigzag(n)), n);
  const bytes = Buffer.concat([
    encodePiece(3, [1000, 2000, 1010, 1990, 900, 2100], 1024, 2048),
    encodePiece(8, [1100, 2100, 1101, 2101], 1024, 2048),
  ]);
  const pieces = [];
  decodeCell(bytes, 1024, 2048, (order, coords) =>
    pieces.push([order, Array.from(coords)]),
  );
  assert.deepEqual(pieces, [
    [3, [1000, 2000, 1010, 1990, 900, 2100]],
    [8, [1100, 2100, 1101, 2101]],
  ]);
});

test('a level file keeps cells in key order and reads them back', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'level.bin');
  const writer = createLevelWriter(file);
  writer.addCell(3, encodePiece(4, [0, 0, 5, 5], 0, 0));
  writer.addCell(70_000, encodePiece(5, [7, 7, 9, 9], 0, 0));
  assert.throws(() => writer.addCell(10, Buffer.from([1])), /ascending/);
  const written = writer.finish({ level: 'test', quantBits: 12, gridZoom: 2 });
  assert.equal(written.cells, 2);
  assert.equal(written.compression, 'deflate-raw');
  assert.equal(readLevelHeader(file).level, 'test');
  const level = openLevel(file);
  t.after(() => level.close());
  assert.equal(level.find(3), 0);
  assert.equal(level.find(70_000), 1);
  assert.equal(level.find(4), -1);
  const seen = [];
  decodeCell(level.readCell(1), 0, 0, (order, coords) =>
    seen.push(order, ...coords),
  );
  assert.deepEqual(seen, [5, 7, 7, 9, 9]);
  fs.writeFileSync(path.join(root, 'junk.bin'), 'not a level');
  assert.throws(() => openLevel(path.join(root, 'junk.bin')), /level file/);
});

// --- rendering --------------------------------------------------------------

test('lines draw antialiased, max-composited, into a gray+alpha PNG', () => {
  const coverage = createCoverage(256);
  assert.equal(coverage.empty, true);
  coverage.polyline(new Float64Array([10, 128.5, 246, 128.5]), 2);
  coverage.polyline(new Float64Array([128.5, 10, 128.5, 246]), 2);
  assert.equal(coverage.empty, false);
  const png = decodePng(encodePng(coverage, INKS.light));
  assert.equal(png.width, 256);
  assert.equal(png.colorType, 4, 'gray ink → gray + alpha');
  assert.equal(png.alpha(128, 128), 0xcc, 'the crossing is not darker');
  assert.equal(png.alpha(50, 128), 0xcc);
  assert.deepEqual(png.color(50, 128), [255, 0xcc]);
  assert.equal(png.alpha(50, 120), 0, 'off the line');
  assert.ok(
    png.alpha(50, 129) > 0 && png.alpha(50, 129) < 0xcc,
    'antialiased edge',
  );
  const dark = decodePng(encodePng(coverage, INKS.dark));
  assert.deepEqual(dark.color(50, 128), [0x1a, 0xcc]);
  const red = decodePng(encodePng(coverage, 'ff000080'));
  assert.equal(red.colorType, 6);
  assert.deepEqual(red.color(50, 128), [255, 0, 0, 0x80]);
  const thin = createCoverage(16);
  thin.polyline(new Float64Array([0, 8.5, 16, 8.5]), 0.5);
  assert.ok(
    Math.abs(thin.values[8 * 16 + 8] - 0.5) < 1e-6,
    'sub-pixel → fainter',
  );
  assert.throws(() => parseInk('fff'), /bad ink/);
  const empty = decodePng(EMPTY_PNG);
  assert.equal(empty.alpha(0, 0), 0);
  assert.ok(EMPTY_PNG.length < 400, 'the transparent tile is tiny');
});

// --- service and routes -----------------------------------------------------

/**
 * A build of one river along 1°N from 60°W to 50°W, order 3 (drawn at
 * every zoom), in every band's level file.
 */
function writeTestBuild(dir, { buildId = 'test-build-1' } = {}) {
  const levelsDir = `levels-${buildId}`;
  fs.mkdirSync(path.join(dir, levelsDir), { recursive: true });
  const levels = [];
  for (const band of BANDS) {
    const quantBits = quantBitsFor(band);
    const scale = 2 ** quantBits;
    const cellUnits = 2 ** (quantBits - band.gridZoom);
    const y = Math.round(worldY(1) * scale);
    const x0 = Math.round(worldX(-60) * scale);
    const x1 = Math.round(worldX(-50) * scale);
    const cells = new Map();
    // One piece per cell the river crosses, in that cell.
    for (
      let cx = Math.floor(x0 / cellUnits);
      cx <= Math.floor(x1 / cellUnits);
      cx++
    ) {
      const from = Math.max(x0, cx * cellUnits);
      const to = Math.min(x1, (cx + 1) * cellUnits);
      const cy = Math.floor(y / cellUnits);
      cells.set(
        cellKey(cx, cy, band.gridZoom),
        encodePiece(3, [from, y, to, y], cx * cellUnits, cy * cellUnits),
      );
    }
    const file = `${levelsDir}/level-${band.level}.bin`;
    const writer = createLevelWriter(path.join(dir, ...file.split('/')));
    for (const key of [...cells.keys()].sort((a, b) => a - b))
      writer.addCell(key, cells.get(key));
    writer.finish({ ...band, quantBits });
    levels.push({ level: band.level, file });
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      buildId,
      builtAt: '2026-10-18T00:00:00.000Z',
      reaches: 1,
      sources: [{ region: 'test' }],
      extent: { west: -60, south: 0.9, east: -50, north: 1.1 },
      levels,
    }),
  );
}

function callerFor(handler) {
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.raw = body;
        this.body = /json/.test(this.headers['content-type'] || '')
          ? JSON.parse(body)
          : body;
      },
    };
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
      },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
}

test('the cache directory honours RIVERS_CACHE_DIR', () => {
  const root = path.resolve('/repo');
  assert.equal(
    riversCacheDir({}, root),
    path.join(root, '.gev-cache', 'rivers'),
  );
  assert.equal(
    riversCacheDir({ RIVERS_CACHE_DIR: '/main/.gev-cache/rivers' }, root),
    path.resolve('/main/.gev-cache/rivers'),
  );
  assert.equal(
    riversCacheDir({ RIVERS_CACHE_DIR: 'elsewhere' }, root),
    path.join(root, 'elsewhere'),
  );
});

test('a tile is drawn from the band its zoom reads', async (t) => {
  const root = await tempRoot(t);
  writeTestBuild(root);
  const service = createRiversV2Service({ dir: root });
  await service.layers();
  // Zoom 5 tile with 55°W on the equator: x = floor(worldX(-55) * 32).
  const z = 5;
  const x = Math.floor(worldX(-55) * 2 ** z);
  const y = Math.floor(worldY(1) * 2 ** z);
  const levels = new Map(
    BANDS.map((band) => [
      band.level,
      openLevel(
        path.join(root, 'levels-test-build-1', `level-${band.level}.bin`),
      ),
    ]),
  );
  t.after(() => {
    for (const level of levels.values()) level.close();
  });
  const drawn = renderTileCoverage(levels, z, x, y);
  assert.ok(drawn.cells >= 1);
  assert.equal(drawn.coverage.empty, false);
  const away = renderTileCoverage(levels, z, x, y - 3);
  assert.equal(away.coverage.empty, true);
});

test('routes: 403 cross-site, 405, 404, 400, 503 unbuilt, PNG tiles with the version in the cache path', async (t) => {
  const root = await tempRoot(t);
  writeTestBuild(root);
  const service = createRiversV2Service({ dir: root });
  const call = callerFor(createRiversV2Handler({ service }));

  assert.equal(
    (await call('/layers', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call('/tile/light/0/0/0', {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).statusCode,
    403,
  );
  assert.equal((await call('/layers', { method: 'POST' })).statusCode, 405);

  const layers = await call('/layers');
  assert.equal(layers.statusCode, 200);
  assert.equal(layers.headers['cache-control'], 'no-store');
  assert.equal(layers.body.configured, true);
  assert.equal(layers.body.attribution, ATTRIBUTION);
  assert.equal(layers.body.license.name, 'CC BY 4.0');
  assert.deepEqual(layers.body.inks, ['light', 'dark']);
  assert.equal(
    layers.body.versions.light,
    tileVersion('light', 'test-build-1'),
  );
  assert.equal(layers.body.versions.dark, tileVersion('dark', 'test-build-1'));
  assert.equal(layers.body.tileUrl, '/api/rivers/v2/tile/{ink}/{z}/{x}/{y}');
  assert.equal(layers.body.maxZoom, 14);
  assert.equal(layers.body.bands.length, BANDS.length);
  assert.deepEqual(layers.body.regions, ['test']);

  const z = 6;
  const x = Math.floor(worldX(-55) * 2 ** z);
  const y = Math.floor(worldY(1) * 2 ** z);
  const version = layers.body.versions.light;
  const first = await call(`/tile/light/${z}/${x}/${y}?v=${version}`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  assert.equal(first.headers['cache-control'], 'private, max-age=86400');
  assert.equal(Number(first.headers['content-length']), first.body.length);
  const png = decodePng(first.body);
  let lit = 0;
  for (let px = 0; px < 256; px++)
    for (let py = 0; py < 256; py++) if (png.alpha(px, py)) lit++;
  assert.ok(lit > 256, 'the river is drawn across the tile');
  const cached = path.join(
    root,
    'tiles',
    'light',
    version,
    String(z),
    String(x),
    `${y}.png`,
  );
  assert.ok(fs.existsSync(cached), 'kept under the version');
  assert.deepEqual(fs.readFileSync(cached), first.body);
  const again = await service.tile('light', z, x, y);
  assert.equal(again.cached, true);

  // An old version in the URL is answered but not kept by the browser.
  const stale = await call(`/tile/light/${z}/${x}/${y}?v=000000000000`);
  assert.equal(stale.headers['cache-control'], 'no-store');

  // Outside the extent: the shared transparent tile, nothing on disk.
  const outside = await service.tile('dark', 3, 6, 3);
  assert.equal(outside.empty, true);
  assert.equal(outside.body, EMPTY_PNG);
  assert.ok(!fs.existsSync(path.join(root, 'tiles', 'dark')));
  // In the extent but without a river: transparent too.
  const ocean = await service.tile(
    'dark',
    14,
    Math.floor(worldX(-55) * 2 ** 14),
    Math.floor(worldY(1.05) * 2 ** 14),
  );
  assert.equal(ocean.empty, true);
  assert.equal(ocean.body, EMPTY_PNG);

  assert.equal((await call('/tile/blue/0/0/0')).statusCode, 404);
  assert.deepEqual((await call('/tile/blue/0/0/0')).body, {
    error: 'No such ink',
  });
  assert.equal((await call('/tile/light/15/0/0')).statusCode, 400);
  assert.equal((await call('/tile/light/1/2/0')).statusCode, 400);
  assert.equal((await call('/tile/../../etc/0/0')).nexted, true);
  assert.equal((await call('/tile/light/x/0/0')).nexted, true);
  assert.equal((await call('/nothing')).nexted, true);

  const none = callerFor(
    createRiversV2Handler({
      service: createRiversV2Service({ dir: path.join(root, 'missing') }),
    }),
  );
  const unbuilt = await none('/tile/light/0/0/0');
  assert.equal(unbuilt.statusCode, 503);
  assert.equal(unbuilt.body.error, NEEDS_BUILD);
  const status = await none('/layers');
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.message, NEEDS_BUILD);
  assert.equal(status.body.versions, undefined);
});

test('a rebuild changes the version, so old tiles are never served', async (t) => {
  const root = await tempRoot(t);
  writeTestBuild(root, { buildId: 'one' });
  let clock = 0;
  const service = createRiversV2Service({ dir: root, now: () => clock });
  const before = service.version('light');
  assert.equal(before, tileVersion('light', 'one'));
  await service.tile(
    'light',
    6,
    Math.floor(worldX(-55) * 64),
    Math.floor(worldY(1) * 64),
  );
  writeTestBuild(root, { buildId: 'two' });
  // A different size or mtime is noticed after the stat interval.
  fs.appendFileSync(path.join(root, 'manifest.json'), ' ');
  clock += 10_000;
  const after = service.version('light');
  assert.equal(after, tileVersion('light', 'two'));
  assert.notEqual(after, before);
  const answer = await service.tile(
    'light',
    6,
    Math.floor(worldX(-55) * 64),
    Math.floor(worldY(1) * 64),
  );
  assert.equal(answer.cached, undefined, 'drawn again under the new version');
  assert.equal(answer.version, after);
});

test('a broken build reads as not configured, with the reason', async (t) => {
  const root = await tempRoot(t);
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      buildId: 'x',
      levels: [{ level: 'z0', file: '../outside.bin' }],
    }),
  );
  const service = createRiversV2Service({ dir: root });
  const layers = await service.layers();
  assert.equal(layers.configured, false);
  assert.match(layers.message, /not readable: bad level path/);
  assert.equal((await service.tile('light', 0, 0, 0)).status, 503);
});
