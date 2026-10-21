// Personal fork: the MSFS renderer's camera path (scripts/msfs/cameraPath.mjs,
// `npm run msfs:path`): great-circle sampling, the rounded corners, the
// smoothing, heading/pitch/bank, the terrain clearance over a fake raster,
// the file's validation and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bankFor,
  bearing,
  buildCameraPath,
  checkRoute,
  clearanceProfile,
  densify,
  distance,
  headingDelta,
  interpolate,
  movingAverage,
  rasterTerrain,
  resample,
  sampleGrid,
  slopeLimit,
  trackHeadings,
  turnRadius,
  validatePath,
} from '../../scripts/msfs/cameraPath.mjs';
import { main, parsePathArgs, parsePoint } from '../../scripts/msfs/path.mjs';
import { encodeRasterValues } from '../data/rasterValues.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ?? ''} ${actual} vs ${expected} ± ${tolerance}`,
  );

test('great circles: distance, bearing, the way between', () => {
  near(
    distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }),
    111_195,
    5,
    'a degree on the equator',
  );
  near(
    distance({ lat: 39.2904, lon: -76.6122 }, { lat: 38.9072, lon: -77.0369 }),
    56_000,
    1_000,
    'Baltimore–Washington',
  );
  near(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-9, 'north');
  near(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-9, 'east');
  near(bearing({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }), 180, 1e-9, 'south');
  near(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }), 270, 1e-9, 'west');
  const mid = interpolate({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 0.5);
  near(mid.lat, 0, 1e-9);
  near(mid.lon, 45, 1e-9);
  // Between two points at 45° N the great circle runs poleward of the parallel.
  assert.ok(
    interpolate({ lat: 45, lon: 0 }, { lat: 45, lon: 90 }, 0.5).lat > 50,
  );
  assert.deepEqual(interpolate({ lat: 1, lon: 2 }, { lat: 1, lon: 2 }, 0.5), {
    lat: 1,
    lon: 2,
  });
  near(headingDelta(350, 10), 20, 1e-9, 'across north');
  near(headingDelta(10, 350), -20, 1e-9);
  near(headingDelta(0, 180), -180, 1e-9);
});

test('sampling: a sample every frame’s distance, the ends kept', () => {
  const line = [
    { lat: 39.29, lon: -76.61 },
    { lat: 39.3, lon: -76.61 },
    { lat: 39.3, lon: -76.59 },
  ];
  const spacing = 4 / 3; // 40 m/s at 30 fps
  const samples = resample(line, spacing);
  const total = distance(line[0], line[1]) + distance(line[1], line[2]);
  near(samples.length, Math.floor(total / spacing) + 2, 1, 'count');
  // Every step the frame's distance, but the one across the corner: its
  // chord is shorter than the way along the line.
  const off = samples
    .slice(1, -1)
    .filter((p, i) => Math.abs(distance(samples[i], p) - spacing) > 0.02);
  assert.ok(off.length <= 1, `${off.length} steps off`);
  assert.deepEqual(samples[0], line[0]);
  assert.deepEqual(samples.at(-1), line.at(-1));
  assert.throws(() => resample(line, 0), /positive/);
});

test('corners: rounded within the turn radius, so the heading turns gradually', () => {
  const points = [
    { lat: 39.29, lon: -76.61 },
    { lat: 39.3, lon: -76.61 },
    { lat: 39.3, lon: -76.59 },
  ];
  const radius = turnRadius(40, 25);
  near(radius, 349.9, 0.5, 'v² / (g tan 25°)');
  const line = densify(points, { step: 0.25, radius });
  // The via point is cut: a 90° fillet passes R(√2 − 1) from the corner.
  const closest = Math.min(...line.map((p) => distance(p, points[1])));
  near(closest, radius * (Math.SQRT2 - 1), 3, 'the arc’s nearest point');
  // On the arc the heading turns ds / R a frame: 1.33 m / 350 m = 0.218°.
  const headings = trackHeadings(resample(line, 4 / 3));
  const steps = headings
    .slice(1)
    .map((h, i) => Math.abs(headingDelta(headings[i], h)));
  near(
    Math.max(...steps),
    (4 / 3 / radius) * (180 / Math.PI),
    0.03,
    'the largest heading step',
  );
  near(
    steps.reduce((sum, s) => sum + s, 0),
    90,
    0.5,
    'the whole turn',
  );
  // Short legs: the arc tightens to keep its ends within 40% of them.
  const tight = densify(
    [points[0], { lat: 39.2905, lon: -76.61 }, { lat: 39.2905, lon: -76.6095 }],
    { step: 1, radius },
  );
  assert.ok(tight.length > 3);
  // Without rounding the turn is a single 90° step.
  const sharp = trackHeadings(resample(densify(points, { step: 5 }), 4 / 3));
  const sharpSteps = sharp
    .slice(1)
    .map((h, i) => Math.abs(headingDelta(sharp[i], h)));
  assert.ok(Math.max(...sharpSteps) > 45);
  assert.throws(() => densify([{ lat: 0, lon: 0 }]), /two points/);
});

test('smoothing and the slope limit: never below the floor, never steeper than the limit', () => {
  [...movingAverage([0, 0, 3, 0, 0], 1)].forEach((v, i) =>
    near(v, [0, 1, 1, 1, 0][i], 1e-9, `average ${i}`),
  );
  assert.deepEqual([...movingAverage([1, 2, 3], 0)], [1, 2, 3]);
  // A 100 m spike; 0.1 per metre at 1 m spacing climbs 0.1 a sample.
  const floor = new Float64Array(2001);
  floor[1000] = 100;
  const limited = slopeLimit(floor, 0.1, 1);
  assert.equal(limited[1000], 100);
  near(limited[900], 90, 1e-9, 'climbing ahead of the spike');
  near(limited[1100], 90, 1e-9, 'descending after it');
  near(limited[0], 0, 1e-9, 'the far end');
  for (let i = 1; i < limited.length; i++)
    assert.ok(Math.abs(limited[i] - limited[i - 1]) <= 0.1 + 1e-9);
  for (let i = 0; i < floor.length; i++) assert.ok(limited[i] >= floor[i]);
});

test('terrain clearance: every sample at least the AGL above the ground, climbs gentle', () => {
  // Rough terrain: a ridge, a cliff and a pinnacle.
  const terrain = Float64Array.from(
    { length: 6000 },
    (_, i) =>
      200 +
      150 * Math.sin(i / 300) +
      (i > 3000 ? 120 : 0) +
      (i === 4500 ? 400 : 0),
  );
  const ds = 4 / 3;
  const half = 120;
  const alt = clearanceProfile(terrain, { agl: 150, maxClimb: 0.08, ds, half });
  for (let i = 0; i < terrain.length; i++)
    assert.ok(
      alt[i] >= terrain[i] + 150 - 1e-6,
      `sample ${i}: ${alt[i]} under ${terrain[i] + 150}`,
    );
  for (let i = 1; i < alt.length; i++)
    assert.ok(
      Math.abs(alt[i] - alt[i - 1]) <= 0.08 * ds + 1e-6,
      `sample ${i} steeper than 8%`,
    );
  // Unknown heights count as sea level.
  assert.equal(
    clearanceProfile([NaN, NaN], { agl: 50, maxClimb: 0.1, ds: 1, half: 1 })[0],
    50.1,
  );
});

test('bank from the turn rate: none straight, a coordinated turn scaled and clamped', () => {
  const options = { maxBank: 25, bankScale: 0.5 };
  assert.equal(bankFor(40, 0, options), 0);
  // 40 m/s turning 3°/s: atan(40 × 0.0524 / 9.81) = 12.05°, halved.
  near(bankFor(40, 3, options), 6.03, 0.01);
  near(bankFor(40, -3, options), -6.03, 0.01, 'left');
  assert.equal(bankFor(200, 30, options), 25);
  assert.equal(bankFor(200, -30, options), -25);
});

test('a path: a sample a frame, altitude over the terrain, pitch with the climb, heading with the track', async () => {
  // Terrain rising 300 m from south to north over the route's 5 km.
  const terrain = async (points) =>
    points.map((p) => ((p.lat - 39.29) * 300) / 0.045);
  const route = {
    from: { lat: 39.29, lon: -76.61 },
    to: { lat: 39.335, lon: -76.61 },
  };
  const file = await buildCameraPath(
    route,
    { speed: 50, fps: 25, agl: 120, terrainName: 'fake' },
    terrain,
  );
  assert.equal(file.version, 1);
  assert.equal(file.fps, 25);
  const { samples, meta } = file;
  near(meta.distance_m, 5004, 5, 'length');
  near(
    samples.length,
    Math.round(meta.distance_m / 2) + 1,
    2,
    'a sample every 2 m (50 m/s at 25 fps)',
  );
  near(samples[1].t - samples[0].t, 0.04, 1e-9);
  assert.equal(samples.at(-1).t, (samples.length - 1) / 25);
  const heights = await terrain(samples);
  samples.forEach((s, i) =>
    assert.ok(s.alt_m >= heights[i] + 120 - 0.1, `sample ${i} too low`),
  );
  near(samples[1000].heading_deg, 0, 0.01, 'north');
  // 300 m over 5 km is a 6% climb: pitch about 3.4° up, no bank.
  near(samples[1200].pitch_deg, 3.4, 0.3, 'pitch');
  assert.equal(samples[1200].bank_deg, 0);
  assert.equal(samples[0].fov_deg, 60);
  assert.equal(meta.terrain, 'fake');
  assert.deepEqual(validatePath(file), []);
  // Looking down subtracts from the pitch.
  const down = await buildCameraPath(
    route,
    { speed: 50, fps: 25, agl: 120, lookDown: 15 },
    terrain,
  );
  near(down.samples[1200].pitch_deg, 3.4 - 15, 0.3);
});

test('a path: road mode says it follows straight legs; bad input refused', async () => {
  const route = {
    from: { lat: 0, lon: 0 },
    via: [{ lat: 0.01, lon: 0.01 }],
    to: { lat: 0.02, lon: 0 },
  };
  const file = await buildCameraPath(route, { mode: 'road' });
  assert.match(
    file.meta.warnings.join(' '),
    /no routing over the Overture roads/,
  );
  assert.match(file.meta.warnings.join(' '), /no terrain/);
  assert.equal(file.samples[0].alt_m >= 150, true);
  assert.ok(
    file.samples.some((s) => Math.abs(s.bank_deg) > 1),
    'banks through the via point',
  );
  await assert.rejects(
    buildCameraPath(route, { mode: 'rail' }),
    /no mode rail/,
  );
  await assert.rejects(
    buildCameraPath(route, { speed: 0 }),
    /speed must be positive/,
  );
  await assert.rejects(
    buildCameraPath({ from: { lat: 95, lon: 0 }, to: { lat: 0, lon: 0 } }),
    /not a point/,
  );
  await assert.rejects(
    buildCameraPath(route, { speed: 0.5, fps: 120, maxSamples: 1000 }),
    /past 1000/,
  );
  assert.throws(() => checkRoute([{ lat: 0, lon: 0 }]), /start and an end/);
});

test('validation: the file’s problems listed', () => {
  assert.deepEqual(
    validatePath({
      version: 2,
      fps: 0,
      samples: [
        {
          t: 0,
          lat: 0,
          lon: 0,
          alt_m: 1,
          heading_deg: 0,
          pitch_deg: 0,
          bank_deg: 0,
          fov_deg: 60,
        },
        {
          t: 0,
          lat: 100,
          lon: 0,
          alt_m: 'x',
          heading_deg: 0,
          pitch_deg: 0,
          bank_deg: 0,
          fov_deg: 200,
        },
      ],
    }),
    [
      'version 2 is not 1',
      'fps must be positive',
      'sample 1: t 0 does not increase',
      'sample 1: lat/lon out of range',
      'sample 1: alt_m is not a number',
      'sample 1: fov_deg out of range',
    ],
  );
  assert.ok(
    validatePath({ version: 1, fps: 30, samples: [] }).includes(
      'fewer than two samples',
    ),
  );
});

/** A raster values grid: cols × rows over a box, the value of each cell from fn(lat, lon) at its centre. */
function grid(box, cols, rows, fn) {
  const values = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const lat = box.north - ((r + 0.5) / rows) * (box.north - box.south);
      const lon = box.west + ((c + 0.5) / cols) * (box.east - box.west);
      values[r * cols + c] = fn(lat, lon);
    }
  return { header: { cols, rows, ...box }, values };
}

test('the raster: bilinear between cell centres, nodata handled, outside is NaN', () => {
  const box = { west: 0, south: 0, east: 1, north: 1 };
  // A plane, which bilinear interpolation reproduces exactly.
  const { header, values } = grid(
    box,
    4,
    4,
    (lat, lon) => 100 * lat + 10 * lon,
  );
  near(sampleGrid(header, values, { lat: 0.5, lon: 0.5 }), 55, 1e-4);
  near(sampleGrid(header, values, { lat: 0.3, lon: 0.6 }), 36, 1e-4);
  // The edge half-cell: the nearest centre's row/column.
  near(
    sampleGrid(header, values, { lat: 0.99, lon: 0.5 }),
    100 * 0.875 + 5,
    1e-4,
  );
  assert.ok(Number.isNaN(sampleGrid(header, values, { lat: 1.5, lon: 0.5 })));
  const holes = Float32Array.from(values);
  holes[5] = NaN;
  assert.ok(
    Number.isFinite(sampleGrid(header, holes, { lat: 0.6, lon: 0.3 })),
    'a missing corner: the known ones',
  );
});

test('terrain from the raster values client: one request per window, the right layer and box', async () => {
  const asked = [];
  const client = {
    get: async (request) => {
      asked.push(request);
      return grid(request.box, 8, 8, (lat) => lat * 1000);
    },
  };
  const terrain = rasterTerrain(client, { chunkDeg: 0.2, cells: 64 });
  const points = [
    { lat: 39.29, lon: -76.61 },
    { lat: 39.31, lon: -76.61 },
    { lat: 39.41, lon: -76.61 }, // the next window north
  ];
  const heights = await terrain(points);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0], {
    layer: 'ee-elevation',
    box: {
      south: 39.2,
      north: 39.400000000000006,
      west: -76.80000000000001,
      east: -76.60000000000001,
    },
    cells: 64,
  });
  near(heights[0], 39290, 15, 'bilinear on a north–south ramp');
  near(heights[2], 39410, 15);
});

test('the command line: points, flags, the file written; terrain through the app’s raster values', async (t) => {
  assert.deepEqual(parsePoint('39.29, -76.61'), { lat: 39.29, lon: -76.61 });
  assert.throws(() => parsePoint('39.29'), /lat,lon/);
  assert.throws(() => parsePoint('91,0'), /lat,lon/);
  const args = parsePathArgs(
    [
      '--from',
      '39.29,-76.61',
      '--to=39.33,-76.62',
      '--via',
      '39.30,-76.60;39.31,-76.60',
      '--speed',
      '30',
      '--agl=200',
      '--out',
      'x.json',
    ],
    { GEV_URL: 'http://localhost:9999' },
  );
  assert.equal(args.route.via.length, 2);
  assert.equal(args.options.speed, 30);
  assert.equal(args.options.agl, 200);
  assert.equal(args.server, 'http://localhost:9999');
  assert.equal(args.terrain, 'ee-elevation');
  assert.throws(() => parsePathArgs(['--to', '0,0', '--out', 'x']), /--from/);
  assert.throws(() => parsePathArgs(['--from', '0,0', '--to', '0,1']), /--out/);
  assert.throws(
    () =>
      parsePathArgs([
        '--from',
        '0,0',
        '--to',
        '0,1',
        '--out',
        'x',
        '--speed',
        'fast',
      ]),
    /number/,
  );
  assert.throws(
    () =>
      parsePathArgs(['--from', '0,0', '--to', '0,1', '--out', 'x', '--warp']),
    /unknown option/,
  );
  assert.throws(
    () =>
      parsePathArgs([
        '--from',
        '0,0',
        '--to',
        '0,1',
        '--out',
        'x',
        '--server',
        'ftp://x',
      ]),
    /http/,
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'path.json');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url, 'http://x').searchParams;
    const box = Object.fromEntries(
      ['west', 'south', 'east', 'north'].map((k) => [k, Number(q.get(k))]),
    );
    const { header, values } = grid(box, 16, 16, () => 75);
    const body = encodeRasterValues(
      { ...header, layer: q.get('layer'), mode: '' },
      values,
    );
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  const lines = [];
  const file = await main(
    [
      '--from',
      '39.29,-76.61',
      '--to',
      '39.295,-76.61',
      '--server',
      'http://localhost:9999',
      '--out',
      out,
    ],
    {
      env: {},
      fetchImpl,
      log: (line) => lines.push(line),
    },
  );
  assert.match(
    urls[0],
    /^http:\/\/localhost:9999\/api\/raster\/values\?layer=ee-elevation&/,
  );
  assert.ok(file.samples.every((s) => s.alt_m >= 75 + 150));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(out, 'utf8')).meta.terrain,
    'ee-elevation',
  );
  assert.match(
    lines[0],
    /samples at 30 fps, 0\.56 km .* 150 m above ee-elevation/,
  );
});
