// Personal fork: the Overture boundary lines (country, region, county),
// from a division_boundary file to the tiles the Administrative boundaries
// layer drapes in each set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BOOLEAN,
  BYTES,
  OPTIONAL,
  REPEATED,
  leaf,
  writeParquet,
} from '../../scripts/overture/parquetWriter.mjs';
import {
  boundariesStatus,
  findBoundaryInputs,
  runBoundariesBuild,
  wkbLines,
} from '../../scripts/overture/boundaries.mjs';
import { BANDS, DASH_OFF, DASH_ON } from './overtureBoundaries/bands.js';
import {
  dashedPolyline,
  renderTileCoverage,
} from './overtureBoundaries/tiles.js';
import { createCoverage, EMPTY_PNG } from './riversV2/render.js';
import { decodeCell, openLevel } from './riversV2/levelFile.js';
import { worldX, worldY } from './riversV2/tileMath.js';
import {
  NEEDS_BUILD,
  boundariesDir,
  createOvertureBoundariesHandler,
  createOvertureBoundariesService,
} from './overtureBoundaries.js';

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-boundaries-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** A little-endian WKB LineString, or a MultiLineString of several. */
function wkb(...lines) {
  const line = (points) => {
    const out = Buffer.alloc(9 + points.length * 16);
    out[0] = 1;
    out.writeUInt32LE(2, 1);
    out.writeUInt32LE(points.length, 5);
    points.forEach(([lon, lat], i) => {
      out.writeDoubleLE(lon, 9 + i * 16);
      out.writeDoubleLE(lat, 17 + i * 16);
    });
    return out;
  };
  if (lines.length === 1) return line(lines[0]);
  const head = Buffer.alloc(9);
  head[0] = 1;
  head.writeUInt32LE(5, 1);
  head.writeUInt32LE(lines.length, 5);
  return Buffer.concat([head, ...lines.map(line)]);
}

function wkbPoint(lon, lat) {
  const out = Buffer.alloc(21);
  out[0] = 1;
  out.writeUInt32LE(1, 1);
  out.writeDoubleLE(lon, 5);
  out.writeDoubleLE(lat, 13);
  return out;
}

// The division_boundary columns the build reads, in the file's shape.
const SCHEMA = [
  leaf('id'),
  leaf('geometry'),
  leaf('subtype'),
  leaf('class'),
  {
    name: 'perspectives',
    repetition: OPTIONAL,
    children: [
      leaf('mode'),
      {
        name: 'countries',
        repetition: OPTIONAL,
        children: [
          {
            name: 'list',
            repetition: REPEATED,
            children: [leaf('element')],
          },
        ],
      },
    ],
  },
  leaf('is_disputed', BOOLEAN),
  leaf('country'),
];

/** Rows → a GeoParquet-shaped file: {id, subtype, cls, disputed, geometry, perspective?}. */
function boundaryFile(file, rows) {
  const flat = (pick, type = BYTES, depth = 1) => {
    const values = [];
    const def = [];
    for (const row of rows) {
      const v = pick(row);
      if (v === null || v === undefined) def.push(depth - 1);
      else {
        values.push(v);
        def.push(depth);
      }
    }
    return { type, values, def, maxDef: depth, maxRep: 0 };
  };
  // perspectives.countries.list.element: def 4 an element, 1 no list.
  const countries = {
    type: BYTES,
    values: [],
    def: [],
    rep: [],
    maxDef: 4,
    maxRep: 1,
  };
  for (const row of rows) {
    const list = row.perspective?.countries;
    if (!list?.length) {
      countries.def.push(row.perspective ? 1 : 0);
      countries.rep.push(0);
      continue;
    }
    list.forEach((code, i) => {
      countries.values.push(code);
      countries.def.push(4);
      countries.rep.push(i ? 1 : 0);
    });
  }
  writeParquet(file, {
    rows: rows.length,
    codec: 6,
    schema: SCHEMA,
    columns: {
      id: flat((row) => row.id),
      geometry: flat((row) => row.geometry),
      subtype: flat((row) => row.subtype),
      class: flat((row) => row.cls),
      'perspectives.mode': flat((row) => row.perspective?.mode, BYTES, 2),
      'perspectives.countries.list.element': countries,
      is_disputed: flat((row) => row.disputed, BOOLEAN),
      country: flat((row) => row.country),
    },
  });
}

// A land border along 45° N from 0° to 10° E, a disputed one in Kashmir
// (two parts, from India's perspective), a maritime one, a region's line
// and a county's in France, and a row the build leaves out: a country's
// point.
const ROWS = [
  {
    id: 'land',
    subtype: 'country',
    cls: 'land',
    disputed: false,
    geometry: wkb([
      [0, 45],
      [2.5, 45.2],
      [5, 45],
      [7.5, 44.8],
      [10, 45],
    ]),
  },
  {
    id: 'kashmir',
    subtype: 'country',
    cls: 'land',
    disputed: true,
    perspective: { mode: 'disputed_by', countries: ['IN', 'CN'] },
    geometry: wkb(
      [
        [77, 34],
        [78, 34],
      ],
      [
        [78, 34],
        [78, 35],
      ],
    ),
  },
  {
    id: 'strait',
    subtype: 'country',
    cls: 'maritime',
    disputed: false,
    geometry: wkb([
      [-5.6, 35.9],
      [-5.4, 36],
    ]),
  },
  {
    id: 'region',
    subtype: 'region',
    cls: 'land',
    disputed: false,
    country: 'FR',
    geometry: wkb([
      [1, 46],
      [2, 46],
    ]),
  },
  {
    id: 'county',
    subtype: 'county',
    cls: 'land',
    disputed: false,
    country: 'FR',
    geometry: wkb([
      [3, 47],
      [3, 48],
    ]),
  },
  {
    id: 'point',
    subtype: 'country',
    cls: 'land',
    disputed: false,
    geometry: wkbPoint(3, 3),
  },
];

/** A built tree: raw/<release>/divisions/division_boundary/ and build/boundaries. */
async function built(t, rows = ROWS) {
  const root = await tempRoot(t);
  const rawDir = path.join(root, 'raw');
  const dir = path.join(
    rawDir,
    '2026-09-23.1',
    'divisions',
    'division_boundary',
  );
  fs.mkdirSync(dir, { recursive: true });
  boundaryFile(path.join(dir, 'part-00000.zstd.parquet'), rows);
  const outDir = path.join(root, 'build', 'boundaries');
  const inputs = findBoundaryInputs([path.join(root, 'elsewhere'), rawDir]);
  return { root, rawDir, outDir, inputs };
}

const tileAt = (lon, lat, z) => [
  z,
  Math.floor(worldX(lon) * 2 ** z),
  Math.floor(worldY(lat) * 2 ** z),
];

test('WKB lines decode; anything else is null', () => {
  const [one] = wkbLines(
    wkb([
      [1, 2],
      [3, 4],
    ]),
  );
  assert.deepEqual([...one], [1, 2, 3, 4]);
  const two = wkbLines(
    wkb(
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [7, 8],
        [9, 10],
      ],
    ),
  );
  assert.deepEqual(
    two.map((line) => [...line]),
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8, 9, 10],
    ],
  );
  assert.equal(wkbLines(wkbPoint(1, 2)), null);
  assert.equal(
    wkbLines(
      wkb([
        [1, 2],
        [3, 4],
      ]).subarray(0, 20),
    ),
    null,
  );
  assert.equal(wkbLines(null), null);
});

test('the build keeps the country, region and county lines with their classes, each from its zoom, and skips an unchanged input', async (t) => {
  const { outDir, inputs } = await built(t);
  assert.equal(inputs.length, 1);
  const lines = [];
  let clock = Date.parse('2026-10-22T12:00:00Z');
  const first = runBoundariesBuild({
    outDir,
    inputs,
    log: (line) => lines.push(line),
    now: () => clock++,
  });
  assert.equal(first.skipped, false);
  const { manifest } = first;
  assert.equal(manifest.release, '2026-09-23.1');
  assert.equal(
    manifest.lines,
    5,
    'two land lines, a maritime one, a region and a county',
  );
  assert.equal(manifest.disputed, 1);
  assert.deepEqual(manifest.byClass, {
    'country land': 1,
    'country land, disputed': 1,
    'country maritime': 1,
    'region land': 1,
    'county land': 1,
  });
  assert.deepEqual(manifest.classes, [
    { subtype: 'country', class: 'land', disputed: false, perspective: null },
    {
      subtype: 'country',
      class: 'land',
      disputed: true,
      perspective: { mode: 'disputed_by', countries: ['CN', 'IN'] },
    },
    {
      subtype: 'country',
      class: 'maritime',
      disputed: false,
      perspective: null,
    },
    { subtype: 'region', class: 'land', disputed: false, perspective: null },
    { subtype: 'county', class: 'land', disputed: false, perspective: null },
  ]);
  assert.deepEqual(manifest.bySubtype, {
    country: { lines: 3, vertices: 11 },
    region: { lines: 1, vertices: 2 },
    county: { lines: 1, vertices: 2 },
  });
  assert.deepEqual(manifest.byCountry, {
    region: { FR: 1 },
    county: { FR: 1 },
  });
  // Where Overture has each level: the z 6 cells its lines cross.
  assert.equal(manifest.coverage.gridZoom, 6);
  assert.deepEqual(manifest.coverage.region.length, 1);
  assert.deepEqual(manifest.coverage.county.length, 1);
  assert.deepEqual(manifest.sources, [
    {
      file: 'part-00000.zstd.parquet',
      bytes: inputs[0].bytes,
      rows: 6,
      kept: 5,
    },
  ]);
  // A region line from the z 4 band on, a county line from z 7.
  const kindsIn = (entry) => {
    const level = openLevel(path.join(outDir, ...entry.file.split('/')));
    const kinds = new Set();
    for (let index = 0; index < level.count; index++)
      decodeCell(level.readCell(index), 0, 0, (kind) => kinds.add(kind));
    level.close();
    return [...kinds].map((kind) => manifest.classes[kind].subtype);
  };
  assert.deepEqual(
    manifest.levels.map((entry) => [
      entry.level,
      [...new Set(kindsIn(entry))].sort(),
    ]),
    [
      ['z0', ['country']],
      ['z4', ['country', 'region']],
      ['z7', ['country', 'county', 'region']],
      ['z10', ['country', 'county', 'region']],
    ],
  );
  assert.deepEqual(
    manifest.levels.map((level) => level.level),
    BANDS.map((band) => band.level),
  );
  for (const entry of manifest.levels) {
    const level = openLevel(path.join(outDir, ...entry.file.split('/')));
    assert.deepEqual(level.header.classes, manifest.classes);
    assert.ok(level.count >= 1, `${entry.level} has cells`);
    level.close();
  }
  assert.ok(lines.some((line) => /5 lines of 6 rows/.test(line)));
  assert.equal(boundariesStatus(outDir).lines, 5);
  assert.deepEqual(boundariesStatus(outDir).coverage, { region: 1, county: 1 });
  assert.equal(boundariesStatus(path.join(outDir, 'none')).built, false);

  const again = runBoundariesBuild({ outDir, inputs, now: () => clock++ });
  assert.equal(again.skipped, true);
  const forced = runBoundariesBuild({
    outDir,
    inputs,
    force: true,
    now: () => clock++,
  });
  assert.notEqual(forced.manifest.buildId, manifest.buildId);
  assert.deepEqual(
    fs.readdirSync(outDir).filter((name) => name.startsWith('levels-')),
    [forced.manifest.levels[0].file.split('/')[0]],
    'the older levels are removed',
  );
  assert.throws(
    () => runBoundariesBuild({ outDir, inputs: [] }),
    /division_boundary/,
  );
});

test('disputed lines are dashed along the longer axis, the same in every tile', () => {
  const coverage = createCoverage(256);
  // A horizontal line through row 100, from x 0 to 256, in a tile whose
  // corner is at world pixel x 2.
  dashedPolyline(coverage, [0, 100.5, 256, 100.5], 1, 2, 0);
  const lit = [];
  for (let x = 0; x < 256; x++) lit.push(coverage.values[100 * 256 + x] > 0.5);
  const period = DASH_ON + DASH_OFF;
  for (let x = 2; x < 250; x++) {
    const phase = (x + 2) % period;
    if (phase >= 1 && phase < DASH_ON - 1)
      assert.equal(lit[x], true, `pixel ${x} in a dash`);
    if (phase >= DASH_ON + 1 && phase < period - 1)
      assert.equal(lit[x], false, `pixel ${x} in a gap`);
  }
  // Drawn the other way round, the dashes fall in the same place.
  const reverse = createCoverage(256);
  dashedPolyline(reverse, [256, 100.5, 0, 100.5], 1, 2, 0);
  assert.deepEqual(reverse.values, coverage.values);
});

test('tiles draw the lines (dashed where disputed) and the route serves them in an ink', async (t) => {
  const { outDir, inputs } = await built(t);
  const { manifest } = runBoundariesBuild({ outDir, inputs });
  const service = createOvertureBoundariesService({ dir: outDir });
  const handler = createOvertureBoundariesHandler({ service });
  const call = async (url) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = /json/.test(this.headers['content-type'] || '')
          ? JSON.parse(body)
          : body;
      },
    };
    await handler(
      { url, method: 'GET', headers: { host: 'localhost:4176' }, socket: {} },
      res,
      () => (res.nexted = true),
    );
    return res;
  };

  const layers = await call('/layers');
  assert.equal(layers.body.configured, true);
  assert.equal(layers.body.buildId, manifest.buildId);
  assert.equal(layers.body.lines, 5);
  // The region and district sets: their versions and where they have lines.
  assert.deepEqual(Object.keys(layers.body.sets), ['regions', 'districts']);
  assert.deepEqual(layers.body.sets.regions.cells, manifest.coverage.region);
  assert.deepEqual(layers.body.sets.districts.cells, manifest.coverage.county);
  assert.equal(layers.body.coverage.gridZoom, 6);
  const versions = new Set([
    layers.body.versions.light,
    layers.body.sets.regions.versions.light,
    layers.body.sets.districts.versions.light,
  ]);
  assert.equal(versions.size, 3, 'each set its own tiles');
  assert.equal(layers.body.maxZoom, 14);
  assert.match(layers.body.attribution, /OpenStreetMap.*Overture.*ODbL/);
  assert.match(layers.body.versions.light, /^[0-9a-f]{12}$/);
  assert.notEqual(layers.body.versions.light, layers.body.versions.dark);

  // The land line across a z 6 tile; its Kashmir neighbour dashed at z 9.
  const [z, x, y] = tileAt(5, 45, 6);
  const tile = await call(
    `/tile/light/${z}/${x}/${y}?v=${layers.body.versions.light}`,
  );
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['content-type'], 'image/png');
  assert.equal(tile.headers['cache-control'], 'private, max-age=86400');
  assert.notEqual(tile.body, EMPTY_PNG);
  const kept = path.join(
    outDir,
    'tiles',
    'light',
    layers.body.versions.light,
    String(z),
    String(x),
    `${y}.png`,
  );
  assert.ok(fs.existsSync(kept));
  assert.equal((await service.tile('light', z, x, y)).cached, true);
  const stale = await call(`/tile/light/${z}/${x}/${y}?v=000000000000`);
  assert.equal(stale.headers['cache-control'], 'no-store');

  const open = new Map(
    manifest.levels.map((entry) => [
      entry.level,
      openLevel(path.join(outDir, ...entry.file.split('/'))),
    ]),
  );
  t.after(() => open.forEach((level) => level.close()));
  const row = (coverage, py) =>
    [...coverage.values.subarray(py * 256, py * 256 + 256)].map((v) => v > 0.5);
  const [kz, kx, ky] = tileAt(77.5, 34, 9);
  const disputed = renderTileCoverage(open, kz, kx, ky).coverage;
  const py = Math.floor((worldY(34) * 2 ** kz - ky) * 256);
  const lit = row(disputed, py);
  assert.ok(lit.some(Boolean) && !lit.every(Boolean), 'dashed');
  const [lz, lx, ly] = tileAt(5, 45, 9);
  const solid = renderTileCoverage(open, lz, lx, ly).coverage;
  // It crosses the tile from side to side: every column has a pixel lit.
  for (let px = 0; px < 256; px++) {
    let any = false;
    for (let at = 0; at < 256 && !any; at++)
      any = solid.values[at * 256 + px] > 0.5;
    assert.ok(any, `the undisputed line is solid (column ${px})`);
  }
  // The maritime line is drawn too; the region's line only in the region
  // and district sets, the county's only in the district set.
  const [mz, mx, my] = tileAt(-5.5, 35.95, 10);
  assert.equal(renderTileCoverage(open, mz, mx, my).coverage.empty, false);
  const [rz, rx, ry] = tileAt(1.5, 46, 10);
  assert.equal(renderTileCoverage(open, rz, rx, ry).coverage.empty, true);
  assert.equal(
    renderTileCoverage(open, rz, rx, ry, 'regions').coverage.empty,
    false,
  );
  assert.equal(
    renderTileCoverage(open, rz, rx, ry, 'districts').coverage.empty,
    false,
  );
  const [cz, cx, cy] = tileAt(3, 47.5, 10);
  assert.equal(
    renderTileCoverage(open, cz, cx, cy, 'regions').coverage.empty,
    true,
  );
  assert.equal(
    renderTileCoverage(open, cz, cx, cy, 'districts').coverage.empty,
    false,
  );
  // Counties are not drawn from far out (not in the z 4 band): there the
  // district set draws what the region set does.
  const [fz, fx, fy] = tileAt(3, 47.5, 5);
  assert.deepEqual(
    renderTileCoverage(open, fz, fx, fy, 'districts').coverage.values,
    renderTileCoverage(open, fz, fx, fy, 'regions').coverage.values,
  );
  // The routes: a set's tile, and none of a set that is not one.
  const district = await call(
    `/tile/districts/light/${cz}/${cx}/${cy}?v=${layers.body.sets.districts.versions.light}`,
  );
  assert.equal(district.statusCode, 200);
  assert.notEqual(district.body, EMPTY_PNG);
  assert.equal(
    (await call(`/tile/regions/light/${cz}/${cx}/${cy}`)).body,
    EMPTY_PNG,
  );
  assert.equal(
    (await call('/tile/towns/light/0/0/0')).nexted,
    true,
    'not a tile route',
  );
  assert.equal((await service.tile('light', 0, 0, 0, 'towns')).status, 404);

  // Away from every line: the shared transparent tile, nothing kept.
  const ocean = await service.tile('dark', ...tileAt(-30, -30, 8));
  assert.equal(ocean.empty, true);
  assert.equal(ocean.body, EMPTY_PNG);

  assert.equal((await call('/tile/blue/0/0/0')).statusCode, 404);
  assert.equal((await call('/tile/light/15/0/0')).statusCode, 400);
  assert.equal((await call('/tile/light/1/2/0')).statusCode, 400);
  assert.equal((await call('/nothing')).nexted, true);

  const none = createOvertureBoundariesHandler({
    service: createOvertureBoundariesService({
      dir: path.join(outDir, 'missing'),
    }),
  });
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await none(
    {
      url: '/tile/light/0/0/0',
      method: 'GET',
      headers: { host: 'localhost:4176' },
      socket: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, NEEDS_BUILD);
});

test('the build lives in build/boundaries of the Overture cache', () => {
  const root = path.resolve('/repo');
  assert.equal(
    boundariesDir({}, root),
    path.join(root, '.gev-cache', 'overture', 'build', 'boundaries'),
  );
  assert.equal(
    boundariesDir({ OVERTURE_CACHE_DIR: 'D:/cache/overture' }, root),
    path.join(path.resolve('D:/cache/overture'), 'build', 'boundaries'),
  );
});
