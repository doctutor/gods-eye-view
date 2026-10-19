// Personal fork: Overture buildings for the Buildings layer outside Google
// Open Buildings (scripts/overture/buildings*.mjs,
// server/providers/overture/buildings*.js,
// src/layers/earthEngine/overtureBuildings.js): the row-group plan, the
// footprint encoding, the merge's density sums, the tiles and the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { BUILDINGS_MODES, BUILDINGS_PER_KM2 } from './earthEngineLayers.js';
import { OVERTURE_FOOTPRINT_ZOOM } from './overtureBuildings.js';
import {
  KIND,
  Writer,
  buildingSummary,
  eachBuilding,
  eachCell,
  encodeBuilding,
  openBucket,
  unitX,
  unitY,
} from '../../server/providers/overture/buildingsFile.js';
import {
  planRowGroups,
  rowGroupBox,
} from '../../scripts/overture/buildingsPlan.mjs';
import {
  buildingHeight,
  wkbPolygons,
  writePart,
} from '../../scripts/overture/buildingsParts.mjs';
import { mergeBucket } from '../../scripts/overture/buildingsMerge.mjs';
import {
  gapBoxes,
  openBuildingsDraws,
} from '../../scripts/overture/openBuildingsGaps.mjs';
import {
  cellColor,
  createBuildingsTiles,
  paletteColor,
} from '../../server/providers/overture/buildingsTiles.js';
import {
  createOvertureHandler,
  createOvertureService,
} from '../../server/providers/overture.js';
import {
  inOvertureBuildings,
  overtureBuildingsImageryOptions,
  toOvertureBuildingsStatus,
} from '../layers/earthEngine/overtureBuildings.js';
import { REGIONS } from '../../server/providers/overture/sources.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-ob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const double = (v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return b;
};

test('the plan: row groups meeting a region, outside Open Buildings, only the columns read', () => {
  const group = (box) => ({
    rows: 10,
    columns: [
      ...[
        'geometry',
        'height',
        'num_floors',
        'subtype',
        'class',
        'sources.list.element.dataset',
      ].map((p, i) => ({
        path: p,
        start: 1000 * i,
        compressedSize: 100 + i,
      })),
      { path: 'bbox.xmin', min: double(box[0]), max: double(box[2]) },
      { path: 'bbox.ymin', min: double(box[1]), max: double(box[3]) },
      { path: 'bbox.xmax', min: double(box[0]), max: double(box[2]) },
      { path: 'bbox.ymax', min: double(box[1]), max: double(box[3]) },
    ],
  });
  const footers = [
    {
      rowGroups: [
        group([-76.7, 39.2, -76.5, 39.4]), // Baltimore
        group([3.3, 6.4, 3.5, 6.6]), // Lagos: inside Open Buildings
        group([150, -34, 151, -33]), // Sydney: no region asked
      ],
    },
  ];
  assert.deepEqual(
    rowGroupBox(footers[0].rowGroups[0]),
    [-76.7, 39.2, -76.5, 39.4],
  );
  const plan = planRowGroups([{ name: 'part-00000-x', key: 'k' }], footers, [
    REGIONS['conterminous-us'],
    REGIONS.world,
  ]);
  assert.deepEqual(
    plan.map((p) => p.group),
    [0, 2],
  );
  assert.equal(plan[0].bytes, 100 + 101 + 102 + 103 + 104 + 105);
  assert.deepEqual(
    planRowGroups([{ name: 'part-00000-x', key: 'k' }], footers, [
      REGIONS['conterminous-us'],
    ]).map((p) => p.group),
    [0],
  );
});

const square = (lon, lat, side = 0.0001) => {
  const ring = [
    [lon, lat],
    [lon + side, lat],
    [lon + side, lat + side],
    [lon, lat + side],
    [lon, lat],
  ];
  const b = Buffer.alloc(9 + 4 + ring.length * 16);
  b[0] = 1;
  b.writeUInt32LE(3, 1);
  b.writeUInt32LE(1, 5);
  b.writeUInt32LE(ring.length, 9);
  ring.forEach(([x, y], i) => {
    b.writeDoubleLE(x, 13 + i * 16);
    b.writeDoubleLE(y, 21 + i * 16);
  });
  return b;
};

test('footprints: WKB to units, encoded and read back, their area and height', () => {
  const polygons = wkbPolygons(square(-76.61, 39.29));
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0][0].length, 8, 'four vertices, not closed');
  assert.equal(
    wkbPolygons(Buffer.from([1, 1, 0, 0, 0])),
    null,
    'a point is not a building',
  );
  const tx = unitX(-76.61) >>> 14;
  const ty = unitY(39.29) >>> 14;
  const writer = new Writer(16);
  encodeBuilding(writer, { height: 12, polygons }, tx << 14, ty << 14);
  encodeBuilding(writer, { height: 0, polygons }, tx << 14, ty << 14);
  const back = [];
  eachBuilding(writer.done(), tx << 14, ty << 14, (b) => back.push(b));
  assert.equal(back.length, 2);
  assert.deepEqual([...back[0].polygons[0][0]], polygons[0][0]);
  assert.equal(back[0].height, 12);
  // 0.0001° a side at 39.29°N: 11.1 m × 8.6 m.
  const { area } = buildingSummary(back[0]);
  assert.ok(Math.abs(area - 11.13 * 8.61) < 3, `${area} m²`);
  assert.equal(buildingHeight(14.6, 3), 15);
  assert.equal(buildingHeight(null, 4), 12, 'three metres a floor');
  assert.equal(buildingHeight(null, null), 0);
});

/** A bucket built from buildings in one z 14 tile of Baltimore. */
function bucketWith(t, buildings) {
  const dir = tmp(t);
  const cx = unitX(-76.61);
  const cy = unitY(39.29);
  const tx = cx >>> 14;
  const ty = cy >>> 14;
  const writer = new Writer(16);
  for (const b of buildings) encodeBuilding(writer, b, tx << 14, ty << 14);
  const bucketKey = (cy >>> 22) * 64 + (cx >>> 22);
  const local = (ty % 256) * 256 + (tx % 256);
  const part = path.join(dir, 'a.part');
  writePart(
    part,
    { stats: {} },
    new Map([[bucketKey, new Map([[local, writer]])]]),
  );
  const header = JSON.parse(
    fs
      .readFileSync(part)
      .subarray(4, 4 + fs.readFileSync(part).readUInt32LE(0))
      .toString('utf8'),
  );
  const target = path.join(dir, 'b.bin');
  const result = mergeBucket({
    bucketKey,
    previous: null,
    parts: [
      {
        file: part,
        header: {
          ...header,
          bodyOffset: 4 + fs.readFileSync(part).readUInt32LE(0),
        },
      },
    ],
    target,
  });
  return { dir, target, result, bucketKey };
}

test('the merge: footprints by tile, density sums at two levels, regions adding up', (t) => {
  const polygons = wkbPolygons(square(-76.61, 39.29));
  const { target, result, bucketKey } = bucketWith(t, [
    { height: 10, polygons },
    { height: 0, polygons },
    { height: 30, polygons },
  ]);
  assert.equal(result.buildings, 3);
  const bucket = openBucket(target);
  t.after(() => bucket.close());
  const kinds = [...bucket.entries.values()].map((e) => e.kind).sort();
  assert.deepEqual(kinds, [KIND.F, KIND.D18, KIND.D14]);
  const sums = (kind) => {
    const entry = [...bucket.entries.values()].find((e) => e.kind === kind);
    const out = [];
    eachCell(bucket.block(kind, entry.key), (cell, ...v) => out.push(v));
    return out;
  };
  for (const kind of [KIND.D18, KIND.D14]) {
    const [cell] = sums(kind);
    assert.equal(cell[0], 3, 'buildings');
    assert.ok(Math.abs(cell[1] - 3 * 95.8) < 10, `built m² ${cell[1]}`);
    // Height known for two of the three, weighted by footprint.
    assert.ok(Math.abs(cell[2] / cell[3] - 20) < 0.01);
    assert.ok(Math.abs(cell[3] - (cell[1] * 2) / 3) < 1);
  }
  // A later region adds to the same bucket from the earlier file.
  const dir = path.dirname(target);
  const again = mergeBucket({
    bucketKey,
    previous: target,
    parts: [],
    target: path.join(dir, 'c.bin'),
  });
  assert.equal(again.buildings, 3);
});

test('colours: the Open Buildings ramps, the same quantity at every zoom', () => {
  const [count, cover, height] = BUILDINGS_MODES;
  assert.equal(count.key, 'count');
  assert.equal(BUILDINGS_PER_KM2, 4_000_000);
  // 100 buildings on 1 km²: log10 = 2, the palette's middle stop.
  assert.deepEqual(
    cellColor('count', [100, 1, 0, 0], 1),
    paletteColor(count.vis.palette, 0, 4, 2),
  );
  assert.deepEqual(paletteColor(count.vis.palette, 0, 4, 2), [247, 104, 161]);
  // Under one a km² is masked, as Open Buildings' COUNT.
  assert.equal(cellColor('count', [0.5, 1, 0, 0], 1), null);
  // Sum then divide: four cells of 25 read as one of 100 on four times the ground.
  assert.deepEqual(
    cellColor('count', [400, 1, 0, 0], 4),
    cellColor('count', [100, 1, 0, 0], 1),
  );
  assert.deepEqual(
    cellColor('cover', [10, 350_000, 0, 0], 1),
    paletteColor(cover.vis.palette, 0, 0.5, 0.35),
  );
  assert.equal(
    cellColor('cover', [1, 10_000, 0, 0], 1),
    null,
    'under 2% built',
  );
  assert.deepEqual(
    cellColor('height', [10, 200_000, 3_000_000, 200_000], 1),
    paletteColor(height.vis.palette, 0, 30, 15),
  );
  assert.equal(
    cellColor('height', [10, 200_000, 100_000, 10_000], 1),
    null,
    'height known for under a quarter',
  );
  assert.equal(
    cellColor('height', [1, 20_000, 300_000, 20_000], 1),
    null,
    'under 5% built',
  );
});

function service(t, buildings) {
  const { dir, target, bucketKey, result } = bucketWith(t, buildings);
  const root = path.join(dir, 'buildings');
  fs.mkdirSync(path.join(root, 'buckets'), { recursive: true });
  fs.renameSync(target, path.join(root, 'buckets', 'b.bin'));
  const manifest = {
    version: 'abcdef012345',
    release: '2026-09-23.1',
    regions: ['conterminous-us'],
    regionBoxes: { 'conterminous-us': REGIONS['conterminous-us'] },
    buckets: { [bucketKey]: { file: 'b.bin', buildings: result.buildings } },
    buildings: result.buildings,
    attribution: '© OpenStreetMap contributors, Overture Maps Foundation',
    license: 'ODbL 1.0',
  };
  fs.writeFileSync(
    path.join(root, 'manifest-abcdef012345.json'),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(root, 'current.json'),
    JSON.stringify({ manifest: 'manifest-abcdef012345.json' }),
  );
  return dir;
}

const tileOf = (lon, lat, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const phi = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  );
  return [x, y];
};
const pixels = (png) => {
  // IDAT → raw RGBA rows (filter byte + 256 × 4).
  let at = 8;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const opaque = [];
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++)
      if (raw[y * 1025 + 1 + x * 4 + 3])
        opaque.push([
          x,
          y,
          ...raw.subarray(y * 1025 + 1 + x * 4, y * 1025 + 5 + x * 4),
        ]);
  return opaque;
};

test('tiles: density from orbit to the street, footprints in the ink from z 15', (t) => {
  const polygons = wkbPolygons(square(-76.61, 39.29, 0.0002));
  const dir = service(
    t,
    Array.from({ length: 5 }, () => ({ height: 9, polygons })),
  );
  const tiles = createBuildingsTiles({ dir });
  t.after(() => tiles.close());
  assert.equal(tiles.status().configured, true);
  // From orbit five buildings are under one a km² of a z 3 cell: masked.
  const [ox, oy] = tileOf(-76.61, 39.29, 3);
  assert.equal(tiles.tile('count', 'light', 3, ox, oy).body, null);
  for (const z of [6, 8, 10, 12, 14]) {
    const [x, y] = tileOf(-76.61, 39.29, z);
    const answer = tiles.tile('count', 'light', z, x, y);
    assert.equal(answer.status, 200);
    const lit = pixels(answer.body);
    assert.ok(lit.length >= 1, `z ${z} draws`);
    // In the COUNT ramp (RdPu: red over 180), opaque, not premultiplied twice.
    assert.ok(lit[0][2] > 180 && lit[0][5] === 255, `z ${z}: ${lit[0]}`);
    // A single cell (z ≤ 11) or a z 11-sized block of them closer in.
    assert.equal(lit.length, z <= 11 ? 1 : 4 ** (z - 11), `z ${z}`);
  }
  // Far from the buildings: nothing.
  const [ex, ey] = tileOf(-100, 40, 12);
  assert.equal(tiles.tile('count', 'light', 12, ex, ey).body, null);
  // z 15: the outline in the light ink over the density.
  const [fx, fy] = tileOf(-76.61, 39.29, OVERTURE_FOOTPRINT_ZOOM);
  const lit = pixels(
    tiles.tile('cover', 'light', OVERTURE_FOOTPRINT_ZOOM, fx, fy).body,
  );
  assert.ok(
    lit.some(([, , r, g, b]) => g > 60 && b > 150),
    'a light outline (antialiased) over the dark COVER fill',
  );
});

test('the route and the layer’s side: versioned tiles, the status, the regions', async (t) => {
  const polygons = wkbPolygons(square(-76.61, 39.29));
  const dir = service(t, [{ height: 9, polygons }]);
  const handle = createOvertureHandler({
    service: createOvertureService({ dir }),
  });
  const call = async (url) => {
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(b) {
        this.body = b;
      },
    };
    await handle({ method: 'GET', url, headers: { host: 'localhost' } }, res);
    return res;
  };
  const layers = JSON.parse((await call('/layers')).body);
  const status = toOvertureBuildingsStatus(layers);
  assert.equal(status.configured, true);
  assert.equal(status.version, 'abcdef012345');
  assert.equal(inOvertureBuildings(status, 39.29, -76.61), true);
  assert.equal(inOvertureBuildings(status, 48.85, 2.35), false);
  const options = overtureBuildingsImageryOptions(status, 'height', 'dark');
  assert.equal(
    options.url,
    '/api/overture/buildings/tile/height/dark/{z}/{x}/{y}?v=abcdef012345',
  );
  assert.equal(overtureBuildingsImageryOptions(status, 'nope', 'dark'), null);
  assert.equal(
    overtureBuildingsImageryOptions(
      toOvertureBuildingsStatus({}),
      'count',
      'light',
    ),
    null,
  );
  const [x, y] = tileOf(-76.61, 39.29, 12);
  const tile = await call(
    `/buildings/tile/count/light/12/${x}/${y}?v=abcdef012345`,
  );
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['content-type'], 'image/png');
  assert.equal(tile.headers['cache-control'], 'private, max-age=86400');
  // Kept on disk under the version; the ink only names footprint tiles.
  assert.ok(
    fs.existsSync(
      path.join(
        dir,
        'buildings',
        'tiles',
        'abcdef012345',
        'count',
        'any',
        '12',
        String(x),
        `${y}.png`,
      ),
    ),
  );
  const stale = await call(
    `/buildings/tile/count/light/12/${x}/${y}?v=000000000000`,
  );
  assert.equal(stale.headers['cache-control'], 'no-store');
  assert.equal(
    (await call('/buildings/tile/count/purple/12/1/1')).statusCode,
    404,
  );
  assert.equal(
    (await call('/buildings/tile/count/light/18/1/1')).statusCode,
    400,
  );
});

test('inside Open Buildings boxes, the land Google has no data for is Overture’s', () => {
  const where = (lat, lon) =>
    openBuildingsDraws(lat, lon) ? 'ob' : 'overture';
  // Across the US–Mexico border, in the same S2 cells.
  assert.equal(where(32.72, -117.16), 'overture', 'San Diego');
  assert.equal(where(32.52, -117.03), 'ob', 'Tijuana');
  assert.equal(where(31.76, -106.49), 'overture', 'El Paso');
  assert.equal(where(31.69, -106.42), 'ob', 'Ciudad Juárez');
  assert.equal(where(25.76, -80.19), 'overture', 'Miami');
  assert.equal(where(25.05, -77.35), 'ob', 'Nassau');
  // Across the Strait of Gibraltar and the Sicilian channel.
  assert.equal(where(36.72, -4.42), 'overture', 'Málaga');
  assert.equal(where(35.76, -5.83), 'ob', 'Tangier');
  assert.equal(where(37.5, 15.09), 'overture', 'Catania');
  assert.equal(where(36.8, 10.18), 'ob', 'Tunis');
  // Outside every box: Open Buildings draws nothing anyway.
  assert.equal(where(39.29, -76.61), 'overture', 'Baltimore');
  assert.equal(where(6.45, 3.39), 'ob', 'Lagos');
  // The plan keeps a row group wholly inside a box with gap land.
  const sanDiegoBox = gapBoxes().find(
    ([w, s, e, n]) => w <= -117.16 && e >= -117.16 && s <= 32.72 && n >= 32.72,
  );
  assert.ok(sanDiegoBox);
});
