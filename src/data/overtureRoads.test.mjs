// Personal fork: Overture roads for the Roads layer and Street assets' bike
// lanes (scripts/overture/roads*.mjs, server/providers/overture/roads*.js,
// server/providers/overtureRoads.js): the classes and levels, a road's
// pieces on each level, the merge, the tiles, the click and the bike lanes,
// and the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  ROAD_BLOCK_MARGIN,
  ROAD_FLAGS,
  ROAD_LEVELS,
  roadClassByKey,
  roadLevelForZoom,
  roadWidth,
  segmentColor,
  segmentMinZoom,
  speedColor,
  speedLabel,
} from './overtureRoads.js';
import {
  levelPieces,
  placeRoad,
  simplify,
  wkbLine,
} from '../../scripts/overture/roadsParts.mjs';
import { mergeRoadsContainer } from '../../scripts/overture/roadsMerge.mjs';
import {
  readPartHeader,
  writePart,
} from '../../scripts/overture/buildingsParts.mjs';
import { rowsOfNested } from '../../scripts/overture/parquet.mjs';
import {
  blockSide,
  containerOf,
  decodeRoadBlock,
  encodeRoadBlock,
} from '../../server/providers/overture/roadsFile.js';
import {
  createRoadsTiles,
  lonLatToUnits,
} from '../../server/providers/overture/roadsTiles.js';
import {
  createOvertureRoadsHandler,
  createOvertureRoadsService,
  parseBikeQuery,
  parseNearestQuery,
} from '../../server/providers/overtureRoads.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-roads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A WKB LineString of [lon, lat] points. */
function wkb(points) {
  const out = Buffer.alloc(9 + points.length * 16);
  out[0] = 1;
  out.writeUInt32LE(2, 1);
  out.writeUInt32LE(points.length, 5);
  points.forEach(([lon, lat], i) => {
    out.writeDoubleLE(lon, 9 + i * 16);
    out.writeDoubleLE(lat, 17 + i * 16);
  });
  return out;
}

const road = (key, extra = {}) => ({
  code: roadClassByKey(key).code,
  flags: 0,
  surface: 1,
  speed: 0,
  subclass: 0,
  source: 0,
  name: '',
  ...extra,
});

/**
 * A small build: an interstate across Baltimore, a street and a cycleway in
 * it, written as the build would (parts, merge, manifest) into `dir`.
 */
function buildFixture(dir) {
  const buckets = new Map();
  const roads = [
    [
      [
        [-76.75, 39.3],
        [-76.62, 39.31],
        [-76.5, 39.32],
      ],
      road('motorway', {
        name: 'I-95',
        speed: 55,
        flags: ROAD_FLAGS.mph,
        surface: 1,
      }),
    ],
    [
      [
        [-76.6122, 39.2905],
        [-76.6102, 39.2905],
      ],
      road('residential', {
        name: 'East Lombard Street',
        speed: 25,
        flags: ROAD_FLAGS.mph,
        surface: 5,
      }),
    ],
    [
      [
        [-76.6122, 39.2915],
        [-76.6102, 39.2915],
      ],
      road('cycleway', {
        name: 'Jones Falls Trail',
        flags: ROAD_FLAGS.bikeDesignated,
        source: 1,
      }),
    ],
    [
      [
        [-76.6122, 39.292],
        [-76.6102, 39.292],
      ],
      road('footway', { flags: ROAD_FLAGS.bikeAllowed }),
    ],
  ];
  for (const [points, attributes] of roads)
    placeRoad(buckets, wkbLine(wkb(points)), attributes);
  const partFile = path.join(dir, 'parts', 'a.part');
  writePart(partFile, { stats: {} }, buckets);
  const header = readPartHeader(partFile);
  const containers = {};
  for (const key of Object.keys(header.buckets)) {
    const { level, cx, cy } = containerOf(Number(key));
    const file = `${level}/${cx}-${cy}.test.bin`;
    fs.mkdirSync(path.join(dir, 'containers', String(level)), {
      recursive: true,
    });
    const result = mergeRoadsContainer({
      key: Number(key),
      previous: null,
      parts: [{ file: partFile, header }],
      target: path.join(dir, 'containers', file),
    });
    containers[key] = { file, segments: result.segments, bytes: result.bytes };
  }
  const manifest = {
    format: 1,
    version: 'abcdef123456',
    release: '2026-09-23.1',
    regions: ['conterminous-us'],
    regionBoxes: { 'conterminous-us': [-125, 24.4, -66.8, 49.5] },
    containers,
    segments: roads.length,
    attribution: 'test',
  };
  fs.writeFileSync(
    path.join(dir, 'manifest-abcdef123456.json'),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(dir, 'current.json'),
    JSON.stringify({ manifest: 'manifest-abcdef123456.json' }),
  );
  return manifest;
}

/** A tile's pixel (RGBA) from its PNG (8-bit RGBA, filter bytes 0). */
function pngPixels(png) {
  let at = 8;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return (x, y) => {
    const i = y * (256 * 4 + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
}

/** The tile (z, x, y) holding a point, and its pixel there. */
function tileOf(lon, lat, z) {
  const [ux, uy] = lonLatToUnits(lon, lat, z + 8);
  return {
    x: Math.floor(ux / 256),
    y: Math.floor(uy / 256),
    px: Math.floor(ux % 256),
    py: Math.floor(uy % 256),
  };
}

test('classes start at their zooms; links with the secondary roads', () => {
  assert.equal(segmentMinZoom(roadClassByKey('motorway').code, 0), 0);
  assert.equal(segmentMinZoom(roadClassByKey('primary').code, 0), 7);
  assert.equal(segmentMinZoom(roadClassByKey('tertiary').code, 0), 9);
  assert.equal(segmentMinZoom(roadClassByKey('residential').code, 0), 12);
  assert.equal(segmentMinZoom(roadClassByKey('footway').code, 0), 14);
  assert.equal(
    segmentMinZoom(roadClassByKey('motorway').code, ROAD_FLAGS.link),
    9,
  );
  // Every zoom has a level, and a level holds what its zooms draw.
  for (let z = 0; z <= 17; z++) {
    const level = roadLevelForZoom(z);
    assert.ok(z >= level.from && z <= level.to, String(z));
    assert.ok(level.block <= level.from || level.block === 2);
  }
  assert.equal(ROAD_LEVELS.at(-1).bits, 28);
  // Widths grow with the zoom; motorways are the widest.
  const motorway = roadClassByKey('motorway').code;
  assert.ok(roadWidth(motorway, 17) > roadWidth(motorway, 10));
  assert.ok(
    roadWidth(motorway, 15) > roadWidth(roadClassByKey('path').code, 15),
  );
});

test('colours: classes by ink, speed ramp in km/h whatever the unit, surface groups', () => {
  const motorway = { code: 1, flags: 0, surface: 0, speed: 0 };
  assert.equal(segmentColor('network', 'light', motorway), 'ff7a45');
  assert.equal(segmentColor('network', 'dark', motorway), 'd9481c');
  // 55 mph is 88.5 km/h: the same colour as 88.5 km/h.
  assert.equal(
    segmentColor('speed', 'light', {
      ...motorway,
      speed: 55,
      flags: ROAD_FLAGS.mph,
    }),
    speedColor(55 * 1.609344),
  );
  assert.equal(segmentColor('speed', 'light', motorway), '8c8c8c');
  assert.equal(
    segmentColor('surface', 'light', { ...motorway, surface: 5 }),
    'e69a4d',
  );
  assert.equal(speedLabel(55, ROAD_FLAGS.mph), '55 mph');
  assert.equal(speedLabel(50, 0), '50 km/h');
  assert.equal(speedLabel(0, 0), '');
});

test('a line on a level: on its grid, simplified, cut into pieces no longer than asked', () => {
  // A straight line with a wiggle smaller than the tolerance loses it.
  assert.deepEqual(simplify([0, 0, 5, 1, 10, 0], 2), [0, 0, 10, 0]);
  assert.deepEqual(simplify([0, 0, 5, 4, 10, 0], 2), [0, 0, 5, 4, 10, 0]);
  const line = wkbLine(
    wkb([
      [0, 0],
      [1, 0],
    ]),
  );
  assert.ok(Math.abs(line[0] - 0.5) < 1e-12 && Math.abs(line[1] - 0.5) < 1e-12);
  const pieces = levelPieces(line, 20, 1, 100);
  // 1° at 2^20 units: 2,912.7 units, in pieces of 100.
  assert.equal(pieces.length, 30);
  for (const piece of pieces) {
    const length = Math.hypot(piece.at(-2) - piece[0], piece.at(-1) - piece[1]);
    assert.ok(length <= 100.5, String(length));
  }
  // Pieces join end to end.
  for (let i = 1; i < pieces.length; i++)
    assert.deepEqual(pieces[i].slice(0, 2), pieces[i - 1].slice(-2));
  // A road shorter than a grid cell vanishes from a coarse level.
  const short = wkbLine(
    wkb([
      [10, 10],
      [10.00001, 10],
    ]),
  );
  assert.deepEqual(levelPieces(short, 14, 1, 1000), []);
  assert.equal(wkbLine(Buffer.from([1, 1, 0, 0, 0])), null);
});

test('a block round-trips its roads and names', () => {
  const segments = [
    {
      ...road('primary', { name: 'Main St', speed: 30 }),
      points: [100, 200, 130, 260],
    },
    { ...road('service'), points: [150, 150, 140, 160, 120, 190] },
    { ...road('primary', { name: 'Main St' }), points: [130, 260, 170, 300] },
  ];
  const decoded = decodeRoadBlock(encodeRoadBlock(segments, 64, 128), 64, 128);
  assert.deepEqual(
    decoded.map(({ name, code, speed, points }) => ({
      name,
      code,
      speed,
      points,
    })),
    segments.map(({ name, code, speed, points }) => ({
      name,
      code,
      speed,
      points,
    })),
  );
});

test('nested lists: each outer element with its own inner values', () => {
  // Three rows: [[a, b], [c]], [], [[], [d]] (outer element at def 2, value at 4).
  const raw = {
    values: ['a', 'b', 'c', 'd'],
    def: Uint8Array.from([4, 4, 4, 0, 2, 4]),
    rep: Uint8Array.from([0, 2, 1, 0, 0, 1]),
  };
  assert.deepEqual(rowsOfNested(raw, { maxDef: 4, repeatedDefs: [2, 3] }), [
    [['a', 'b'], ['c']],
    [],
    [[], ['d']],
  ]);
});

test('the build: every level that draws a class holds it; a merge keeps coarse duplicates once', (t) => {
  const dir = tempDir(t);
  const manifest = buildFixture(dir);
  const levels = new Map();
  for (const [key, entry] of Object.entries(manifest.containers)) {
    const { level } = containerOf(Number(key));
    levels.set(level, (levels.get(level) || 0) + entry.segments);
  }
  // The interstate on all six levels; the street from z 12; the paths from z 14.
  assert.deepEqual([...levels.keys()].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(levels.get(0), 1);
  assert.ok(levels.get(5) >= 4);
  // Every piece fits the margin a tile reads around its blocks.
  assert.equal(ROAD_BLOCK_MARGIN, 1 / 8);
  assert.ok(blockSide(5) > 0);
});

test('tiles: the interstate from orbit, the street close in, empty where nothing is', (t) => {
  const dir = tempDir(t);
  buildFixture(dir);
  const tiles = createRoadsTiles({ dir });
  t.after(() => tiles.close());
  assert.equal(tiles.status().configured, true);
  // z 5: the interstate is drawn, in the light ink's orange.
  const far = tileOf(-76.62, 39.31, 5);
  const z5 = tiles.tile('network', 'light', 5, far.x, far.y);
  assert.equal(z5.status, 200);
  assert.ok(z5.body, 'a z 5 tile with the interstate');
  const pixel = pngPixels(z5.body)(far.px, far.py);
  assert.ok(pixel[3] > 0, 'drawn where the interstate is');
  // z 10: the street is not drawn yet (residential from z 12).
  const streetFar = tileOf(-76.6112, 39.2905, 10);
  const z10 = tiles.tile('network', 'light', 10, streetFar.x, streetFar.y);
  const p10 = z10.body
    ? pngPixels(z10.body)(streetFar.px, streetFar.py)
    : [0, 0, 0, 0];
  assert.equal(p10[3], 0);
  // z 16: the street, in the residential grey on a dark map.
  const near = tileOf(-76.6112, 39.2905, 16);
  const z16 = tiles.tile('network', 'light', 16, near.x, near.y);
  const p16 = pngPixels(z16.body)(near.px, near.py);
  assert.ok(p16[3] > 200);
  assert.deepEqual(p16.slice(0, 3), [0xd9, 0xd9, 0xd9]);
  // SURFACE: the gravel street is unpaved brown.
  const surface = tiles.tile('surface', 'light', 16, near.x, near.y);
  assert.deepEqual(
    pngPixels(surface.body)(near.px, near.py).slice(0, 3),
    [0xe6, 0x9a, 0x4d],
  );
  // Nothing in the Pacific.
  assert.equal(tiles.tile('network', 'light', 8, 10, 100).body, null);
  assert.equal(tiles.tile('nope', 'light', 1, 0, 0).status, 404);
});

test('a click finds the road drawn at its zoom; bike lanes are cycleways and signed paths', (t) => {
  const dir = tempDir(t);
  buildFixture(dir);
  const tiles = createRoadsTiles({ dir });
  t.after(() => tiles.close());
  const street = tiles.nearest({ lon: -76.6112, lat: 39.29052, zoom: 16 });
  assert.equal(street.body.segment.name, 'East Lombard Street');
  assert.equal(street.body.segment.class, 'residential');
  assert.equal(street.body.segment.speedLabel, '25 mph');
  assert.equal(street.body.segment.surface, 'gravel');
  assert.ok(street.body.segment.distanceM < 5);
  assert.ok(street.body.segment.line.length >= 2);
  // From far out the street is not drawn: the click finds nothing there.
  const far = tiles.nearest({ lon: -76.6112, lat: 39.29052, zoom: 9 });
  assert.equal(far.body.segment, null);
  // The interstate is found from far out.
  const interstate = tiles.nearest({ lon: -76.62, lat: 39.312, zoom: 9 });
  assert.equal(interstate.body.segment.name, 'I-95');
  assert.equal(interstate.body.segment.speedKmh, 89);
  const bike = tiles.bikeLines({
    west: -76.62,
    south: 39.28,
    east: -76.6,
    north: 39.3,
  });
  assert.deepEqual(bike.body.lines.map((l) => l.kind).sort(), [
    'cycleway',
    'shared-path',
  ]);
  assert.equal(
    bike.body.lines.find((l) => l.kind === 'cycleway').name,
    'Jones Falls Trail',
  );
  const points = tiles.bikeLines({
    west: -76.62,
    south: 39.28,
    east: -76.6,
    north: 39.3,
    points: true,
  });
  assert.equal(points.body.points.length, 2);
  assert.ok(
    Math.abs(points.body.points[0][1] - 39.2915) < 0.001 ||
      Math.abs(points.body.points[1][1] - 39.2915) < 0.001,
  );
});

test('the route: tiles kept by version, the click, the bike box, same-site, not built', async (t) => {
  const dir = tempDir(t);
  buildFixture(dir);
  const service = createOvertureRoadsService({ dir, env: {} });
  t.after(() => service.close());
  const handler = createOvertureRoadsHandler({ service });
  const call = async (url, { method = 'GET', headers = {} } = {}) => {
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
        headers: { host: 'localhost:4173', ...headers },
        socket: {},
      },
      res,
    );
    return res;
  };
  const layers = await call('/layers');
  assert.equal(layers.body.configured, true);
  assert.equal(layers.body.version, 'abcdef123456');
  const near = tileOf(-76.6112, 39.2905, 16);
  const tile = await call(
    `/tile/network/light/16/${near.x}/${near.y}?v=abcdef123456`,
  );
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['content-type'], 'image/png');
  assert.equal(tile.headers['cache-control'], 'private, max-age=86400');
  assert.ok(
    fs.existsSync(
      path.join(
        dir,
        'tiles',
        'abcdef123456',
        'network',
        'light',
        '16',
        String(near.x),
        `${near.y}.png`,
      ),
    ),
  );
  assert.equal((await call('/tile/network/light/18/0/0')).statusCode, 400);
  const click = await call('/nearest?lon=-76.6112&lat=39.29052&zoom=16');
  assert.equal(click.body.segment.name, 'East Lombard Street');
  assert.equal((await call('/nearest?lon=x&lat=1&zoom=3')).statusCode, 400);
  const bike = await call(
    '/bike?west=-76.62&south=39.28&east=-76.6&north=39.3',
  );
  assert.equal(bike.body.lines.length, 2);
  assert.equal(
    (await call('/bike?west=-77&south=39&east=-75&north=40')).statusCode,
    400,
  );
  assert.equal((await call('/layers', { method: 'POST' })).statusCode, 405);
  assert.equal(
    (await call('/layers', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  // Not built: 503 for a tile, configured false for the status.
  const empty = createOvertureRoadsService({ dir: tempDir(t), env: {} });
  t.after(() => empty.close());
  assert.equal((await empty.layers()).configured, false);
  assert.equal((await empty.tile('network', 'light', 3, 1, 2)).status, 503);
  assert.deepEqual(
    parseNearestQuery(new URLSearchParams('lon=1&lat=2&zoom=3.7')),
    {
      lon: 1,
      lat: 2,
      zoom: 3,
    },
  );
  assert.equal(
    parseBikeQuery(
      new URLSearchParams('west=1&south=1&east=1.5&north=1.5&points=1'),
    ).points,
    true,
  );
});
