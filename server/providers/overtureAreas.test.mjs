// Personal fork: the Overture division areas, from a division_area file to
// a click's units, the fill tiles and the coast tiles.
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
  REQUIRED,
  leaf,
  writeParquet,
} from '../../scripts/overture/parquetWriter.mjs';
import {
  areasStatus,
  clampToMercator,
  findAreaInputs,
  indexCells,
  keptArea,
  runAreasBuild,
  wkbPolygons,
} from '../../scripts/overture/areas.mjs';
import {
  createOvertureAreasHandler,
  createOvertureAreasService,
  unitColour,
} from './overtureAreas.js';
import { decodeAreaRecord, polygonsHold } from './overtureAreas/format.js';
import { encodeRgbaPng, fillPolygons } from './overtureAreas/fill.js';
import { EMPTY_PNG } from './riversV2/render.js';
import { worldX, worldY } from './riversV2/tileMath.js';

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-areas-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** A little-endian WKB Polygon (rings of [lon, lat]), or a MultiPolygon of several. */
function wkb(...polygons) {
  const polygon = (rings) => {
    const head = Buffer.alloc(9);
    head[0] = 1;
    head.writeUInt32LE(3, 1);
    head.writeUInt32LE(rings.length, 5);
    const parts = [head];
    for (const ring of rings) {
      const out = Buffer.alloc(4 + ring.length * 16);
      out.writeUInt32LE(ring.length, 0);
      ring.forEach(([lon, lat], i) => {
        out.writeDoubleLE(lon, 4 + i * 16);
        out.writeDoubleLE(lat, 12 + i * 16);
      });
      parts.push(out);
    }
    return Buffer.concat(parts);
  };
  if (polygons.length === 1) return polygon(polygons[0]);
  const head = Buffer.alloc(9);
  head[0] = 1;
  head.writeUInt32LE(6, 1);
  head.writeUInt32LE(polygons.length, 5);
  return Buffer.concat([head, ...polygons.map(polygon)]);
}

const box = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

const SCHEMA = [
  leaf('id'),
  leaf('geometry'),
  leaf('country'),
  leaf('subtype'),
  {
    name: 'names',
    repetition: OPTIONAL,
    children: [
      leaf('primary'),
      {
        name: 'common',
        repetition: OPTIONAL,
        children: [
          {
            name: 'key_value',
            repetition: REPEATED,
            children: [leaf('key', BYTES, REQUIRED), leaf('value')],
          },
        ],
      },
    ],
  },
  leaf('is_land', BOOLEAN),
  leaf('is_territorial', BOOLEAN),
  leaf('region'),
];

/** Rows → a GeoParquet-shaped division_area file. */
function areaFile(file, rows) {
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
  const keys = {
    type: BYTES,
    values: [],
    def: [],
    rep: [],
    maxDef: 3,
    maxRep: 1,
  };
  const vals = {
    type: BYTES,
    values: [],
    def: [],
    rep: [],
    maxDef: 4,
    maxRep: 1,
  };
  for (const row of rows) {
    const entries = Object.entries(row.common || {});
    if (!entries.length) {
      for (const c of [keys, vals]) {
        c.def.push(1);
        c.rep.push(0);
      }
      continue;
    }
    entries.forEach(([k, v], i) => {
      keys.values.push(k);
      keys.def.push(3);
      keys.rep.push(i ? 1 : 0);
      vals.values.push(v);
      vals.def.push(4);
      vals.rep.push(i ? 1 : 0);
    });
  }
  writeParquet(file, {
    rows: rows.length,
    codec: 6,
    schema: SCHEMA,
    columns: {
      id: flat((row) => row.id),
      geometry: flat((row) => row.geometry),
      country: flat((row) => row.country),
      subtype: flat((row) => row.subtype),
      'names.primary': flat((row) => row.name, BYTES, 2),
      'names.common.key_value.key': keys,
      'names.common.key_value.value': vals,
      is_land: flat((row) => row.land, BOOLEAN),
      is_territorial: flat((row) => row.territorial, BOOLEAN),
      region: flat((row) => row.region),
    },
  });
}

// Country A (0–10° E, 40–50° N) with its sea one degree around; its
// regions West (0–5°) and East (5–10°); a county in West (0–2.5°) with
// a hole (a lake, 1–1.5°); island country B (20–22° E, 40–42° N); and rows
// the build leaves out: a locality, and a region's territorial copy.
const ROWS = [
  {
    id: 'A',
    subtype: 'country',
    country: 'AA',
    name: 'Aland',
    land: true,
    territorial: false,
    geometry: wkb([box(0, 40, 10, 50)]),
  },
  {
    id: 'A-sea',
    subtype: 'country',
    country: 'AA',
    name: 'Aland',
    land: false,
    territorial: true,
    geometry: wkb([box(-1, 39, 11, 51)]),
  },
  {
    id: 'W',
    subtype: 'region',
    country: 'AA',
    region: 'AA-W',
    name: 'Westmark',
    common: { en: 'West March', fr: 'Marche' },
    land: true,
    territorial: true,
    geometry: wkb([box(0, 40, 5, 50)]),
  },
  {
    id: 'E',
    subtype: 'region',
    country: 'AA',
    region: 'AA-E',
    name: 'Eastmark',
    land: true,
    territorial: true,
    geometry: wkb([box(5, 40, 10, 50)]),
  },
  {
    id: 'E-sea',
    subtype: 'region',
    country: 'AA',
    region: 'AA-E',
    name: 'Eastmark',
    land: false,
    territorial: true,
    geometry: wkb([box(5, 39, 11, 51)]),
  },
  {
    id: 'C',
    subtype: 'county',
    country: 'AA',
    region: 'AA-W',
    name: 'Lakeshire',
    land: true,
    territorial: true,
    geometry: wkb([box(0, 40, 2.5, 50), box(1, 44, 1.5, 46)]),
  },
  {
    id: 'B',
    subtype: 'country',
    country: 'BB',
    name: 'Bisle',
    land: true,
    territorial: false,
    geometry: wkb([box(20, 40, 22, 42)], [box(23, 40, 23.5, 40.5)]),
  },
  {
    id: 'town',
    subtype: 'locality',
    country: 'AA',
    name: 'Town',
    land: true,
    territorial: true,
    geometry: wkb([box(1, 41, 1.1, 41.1)]),
  },
];

async function built(t, rows = ROWS) {
  const root = await tempRoot(t);
  const rawDir = path.join(root, 'raw');
  const dir = path.join(rawDir, '2026-09-23.1', 'divisions', 'division_area');
  fs.mkdirSync(dir, { recursive: true });
  areaFile(path.join(dir, 'part-00000.zstd.parquet'), rows);
  fs.writeFileSync(path.join(dir, 'part-00001.zstd.parquet.partial'), 'half');
  const outDir = path.join(root, 'build', 'areas');
  const inputs = findAreaInputs([rawDir]);
  return { root, outDir, inputs };
}

const tileAt = (lon, lat, z) => [
  z,
  Math.floor(worldX(lon) * 2 ** z),
  Math.floor(worldY(lat) * 2 ** z),
];

test('WKB polygons decode, holes and parts kept; latitudes clamp to Mercator; rows kept by subtype and land', () => {
  const [one] = wkbPolygons(wkb([box(0, 0, 1, 1), box(0.2, 0.2, 0.4, 0.4)]));
  assert.equal(one.length, 2, 'outer ring and hole');
  assert.deepEqual([...one[0].subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(
    wkbPolygons(wkb([box(0, 0, 1, 1)], [box(2, 2, 3, 3)])).length,
    2,
  );
  assert.equal(wkbPolygons(Buffer.from([1, 1, 0, 0, 0])), null);
  const polar = clampToMercator([
    [Float64Array.from([0, -90, 10, -90, 10, -60])],
  ]);
  assert.equal(polar[0][0][1], -85.05112878);
  assert.equal(
    keptArea({ subtype: 'county', land: true, territorial: true }),
    'land',
  );
  assert.equal(
    keptArea({ subtype: 'country', land: false, territorial: true }),
    'sea',
  );
  assert.equal(
    keptArea({ subtype: 'region', land: false, territorial: true }),
    null,
    "a region's sea is not kept",
  );
  assert.equal(
    keptArea({ subtype: 'locality', land: true, territorial: true }),
    null,
  );
  // The index: the deepest zoom whose cells the box spans at most 2 × 2 of.
  const small = indexCells([0.5, 0.5, 0.5001, 0.5001]);
  assert.equal(small.zoom, 10);
  assert.equal(
    indexCells([0, 0, 1, 1]).zoom,
    1,
    'the world spans 2 × 2 at z 1',
  );
  assert.ok(indexCells([0.1, 0.1, 0.3, 0.3]).cells.length <= 4);
});

test('the build keeps the land units and the countries’ seas, simplified per band, and skips an unchanged input', async (t) => {
  const { outDir, inputs } = await built(t);
  assert.deepEqual(
    inputs.map((i) => i.name),
    ['part-00000.zstd.parquet'],
    'not the .partial',
  );
  const first = runAreasBuild({ outDir, inputs });
  const { manifest } = first;
  assert.equal(first.skipped, false);
  assert.equal(manifest.units, 6);
  assert.deepEqual(manifest.bySubtype, {
    'country land': 2,
    'country sea': 1,
    'region land': 2,
    'county land': 1,
  });
  assert.deepEqual(manifest.sources, [
    {
      file: 'part-00000.zstd.parquet',
      bytes: inputs[0].bytes,
      rows: 8,
      kept: 6,
    },
  ]);
  assert.deepEqual(
    manifest.levels.map((l) => l.level),
    ['z0', 'z4', 'z7', 'z10'],
  );
  assert.equal(manifest.coasts.length, 4, 'a coast level per band');
  const units = JSON.parse(
    fs.readFileSync(path.join(outDir, manifest.files.units), 'utf8'),
  );
  const west = units.find((u) => u.id === 'W');
  assert.equal(west.name, 'Westmark');
  assert.equal(west.nameEn, 'West March');
  assert.equal(units.find((u) => u.id === 'E').nameEn, null);
  // A record decodes to its rings, the county's hole kept at the finest level.
  const county = units.find((u) => u.id === 'C');
  const bytes = Buffer.alloc(county.lengths[3]);
  const fd = fs.openSync(path.join(outDir, manifest.files.areas), 'r');
  fs.readSync(fd, bytes, 0, bytes.length, county.offsets[3]);
  fs.closeSync(fd);
  const [rings] = decodeAreaRecord(bytes);
  assert.equal(rings.length, 2);
  assert.equal(areasStatus(outDir).units, 6);
  assert.equal(areasStatus(path.join(outDir, 'none')).built, false);
  assert.equal(runAreasBuild({ outDir, inputs }).skipped, true);
  const again = runAreasBuild({ outDir, inputs, force: true });
  assert.notEqual(again.manifest.buildId, manifest.buildId);
  assert.deepEqual(
    fs
      .readdirSync(outDir)
      .filter((n) => /^(areas|units|index|coasts)-/.test(n))
      .sort(),
    Object.values(again.manifest.files).sort(),
    'the older files are removed',
  );
  assert.throws(() => runAreasBuild({ outDir, inputs: [] }), /division_area/);
});

test('identify: the county, region and country under a point; a lake is no county; at sea, the territorial sea', async (t) => {
  const { outDir, inputs } = await built(t);
  runAreasBuild({ outDir, inputs });
  const service = createOvertureAreasService({ dir: outDir });
  t.after(() => service.close());
  const at = (lat, lon) => service.identify(lat, lon).body;
  const inCounty = at(42, 1);
  assert.equal(inCounty.land, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(inCounty.units).map(([k, u]) => [k, u.name]),
    ),
    { country: 'Aland', region: 'Westmark', county: 'Lakeshire' },
  );
  assert.equal(inCounty.units.region.nameEn, 'West March');
  assert.equal(inCounty.units.country.country, 'AA');
  const lake = at(45, 1.25);
  assert.equal(lake.units.county, undefined, 'the hole');
  assert.equal(lake.units.region.name, 'Westmark');
  const east = at(45, 7);
  assert.equal(east.units.region.name, 'Eastmark');
  assert.equal(east.units.county, undefined);
  const sea = at(45, 10.5);
  assert.equal(sea.land, false);
  assert.equal(sea.sea.name, 'Aland');
  const ocean = at(0, -30);
  assert.deepEqual([ocean.land, ocean.sea, ocean.units], [false, null, {}]);
  assert.equal(
    at(40.2, 23.2).units.country.name,
    'Bisle',
    "an island country's second island",
  );
  assert.equal(service.identify(91, 0).status, 400);
  assert.equal(service.identify(Number.NaN, 0).status, 400);
});

test('fill tiles fill the set’s units in their colours; coast tiles draw the countries’ outlines; the routes serve them', async (t) => {
  const { outDir, inputs } = await built(t);
  runAreasBuild({ outDir, inputs });
  const service = createOvertureAreasService({ dir: outDir });
  t.after(() => service.close());
  const handler = createOvertureAreasHandler({ service });
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
  assert.match(layers.body.versions.fill.regions, /^[0-9a-f]{12}$/);
  assert.notEqual(
    layers.body.versions.fill.regions,
    layers.body.versions.fill.districts,
  );
  assert.match(layers.body.versions.coast.light, /^[0-9a-f]{12}$/);
  assert.match(layers.body.attribution, /OpenStreetMap.*Overture.*ODbL/);

  const identify = await call('/identify?lat=42&lon=1');
  assert.equal(identify.body.units.county.name, 'Lakeshire');
  assert.equal((await call('/identify?lat=x&lon=1')).statusCode, 400);

  // Inside West at z 6: every pixel the region's colour, at the fills' alpha.
  const png = service.drawFill('regions', ...tileAt(2, 45, 6));
  assert.ok(png);
  const tile = await call(
    `/fill/regions/${tileAt(2, 45, 6).join('/')}?v=${layers.body.versions.fill.regions}`,
  );
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['cache-control'], 'private, max-age=86400');
  assert.ok(
    fs.existsSync(
      path.join(
        outDir,
        'tiles',
        'fill',
        'regions',
        layers.body.versions.fill.regions,
        ...tileAt(2, 45, 6).map(String).slice(0, 2),
        `${tileAt(2, 45, 6)[2]}.png`,
      ),
    ),
  );
  assert.equal(
    (await service.fill('regions', ...tileAt(2, 45, 6))).cached,
    true,
  );
  // Districts: the county only; the east region has none.
  assert.ok(service.drawFill('districts', ...tileAt(1, 42, 8)));
  assert.equal(service.drawFill('districts', ...tileAt(8, 45, 8)), null);
  assert.equal(
    (await service.fill('districts', ...tileAt(8, 45, 8))).body,
    EMPTY_PNG,
  );
  // Coasts: around island B, nothing over the open sea.
  assert.ok(service.drawCoast('light', ...tileAt(21, 42, 7)));
  assert.equal(service.drawCoast('light', ...tileAt(-30, 0, 7)), null);
  const coast = await call(`/coast/dark/${tileAt(21, 42, 7).join('/')}`);
  assert.equal(coast.statusCode, 200);
  assert.notEqual(coast.body, EMPTY_PNG);
  assert.equal((await call('/coast/blue/0/0/0')).statusCode, 404);
  assert.equal((await call('/fill/regions/15/0/0')).statusCode, 400);
  assert.equal((await call('/fill/towns/1/0/0')).nexted, true);
  assert.equal((await call('/nothing')).nexted, true);
  // A unit keeps its colour.
  assert.deepEqual(unitColour('W'), unitColour('W'));
});

test('without a build: not configured, and the routes say what to run', async (t) => {
  const root = await tempRoot(t);
  const service = createOvertureAreasService({ dir: path.join(root, 'none') });
  assert.equal((await service.layers()).configured, false);
  assert.match((await service.layers()).message, /npm run overture:areas/);
  assert.equal(service.identify(1, 1).status, 503);
  assert.equal((await service.fill('regions', 0, 0, 0)).status, 503);
});

test('the rasteriser fills by the even-odd rule, and the PNG is RGBA', () => {
  const rgba = new Uint8Array(256 * 256 * 4);
  const square = Float64Array.from([10, 10, 100, 10, 100, 100, 10, 100]);
  const hole = Float64Array.from([40, 40, 60, 40, 60, 60, 40, 60]);
  const filled = fillPolygons(rgba, [[square, hole]], [1, 2, 3], 90);
  assert.equal(filled, 90 * 90 - 20 * 20);
  const at = (x, y) => [
    ...rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4),
  ];
  assert.deepEqual(at(20, 20), [1, 2, 3, 90]);
  assert.deepEqual(at(50, 50), [0, 0, 0, 0], 'the hole');
  assert.deepEqual(at(150, 150), [0, 0, 0, 0]);
  const png = encodeRgbaPng(rgba);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png[25], 6, 'colour type RGBA');
  assert.equal(polygonsHold([[square, hole]], 20, 20), true);
  assert.equal(polygonsHold([[square, hole]], 50, 50), false);
});
