// Personal fork: Overture infrastructure (scripts/overture/infrastructure
// Parts.mjs and the point build in places.mjs, server/providers/overture/
// placesIndex.js and the /api/overture/infrastructure routes, Street
// assets' client): a small GeoParquet file written here, decoded, merged
// and answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latLngToCell } from 'h3-js';

import {
  INFRASTRUCTURE_CLASSES,
  infrastructureClass,
  infrastructureCode,
} from './overtureInfrastructure.js';
import {
  BYTES,
  FLOAT,
  OPTIONAL,
  REPEATED,
  leaf,
  writeParquet,
} from '../../scripts/overture/parquetWriter.mjs';
import { footerFromTail } from '../../scripts/overture/parquet.mjs';
import {
  boxCentre,
  decodeInfrastructureRowGroup,
} from '../../scripts/overture/infrastructureParts.mjs';
import {
  readPartHeader,
  writePart,
} from '../../scripts/overture/buildingsParts.mjs';
import { mergePlacesBucket } from '../../scripts/overture/placesMerge.mjs';
import {
  POINT_BUILDS,
  writeGlobalCounts,
} from '../../scripts/overture/places.mjs';
import { INFRASTRUCTURE_COLUMNS } from '../../server/providers/overture/sources.js';
import { createInfrastructureIndex } from '../../server/providers/overture/placesIndex.js';
import {
  createOvertureHandler,
  createOvertureService,
  parseInfrastructureCountsQuery,
  parseInfrastructureQuery,
} from '../../server/providers/overture.js';
import {
  createInfrastructureSource,
  normalizeInfrastructurePoint,
} from '../layers/streetAssets/infrastructureSource.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-infra-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Overture's infrastructure columns the build reads, in the file's shape.
const SCHEMA = [
  {
    name: 'sources',
    repetition: OPTIONAL,
    children: [
      {
        name: 'list',
        repetition: REPEATED,
        children: [
          {
            name: 'element',
            repetition: OPTIONAL,
            children: [leaf('dataset')],
          },
        ],
      },
    ],
  },
  { name: 'names', repetition: OPTIONAL, children: [leaf('primary')] },
  leaf('subtype'),
  leaf('class'),
  {
    name: 'bbox',
    repetition: OPTIONAL,
    children: ['xmin', 'xmax', 'ymin', 'ymax'].map((n) => leaf(n, FLOAT)),
  },
];

/** Rows → a GeoParquet-shaped file: {cls, subtype, name?, box?: [w, s, e, n]}. */
function infrastructureFile(file, rows) {
  const flat = (pick, depth = 1, type = BYTES) => {
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
  const box = (i) => flat((row) => row.box?.[i], 2, FLOAT);
  const datasets = {
    type: BYTES,
    values: rows.map(() => 'OpenStreetMap'),
    def: rows.map(() => 4),
    rep: rows.map(() => 0),
    maxDef: 4,
    maxRep: 1,
  };
  writeParquet(file, {
    rows: rows.length,
    codec: 6,
    schema: SCHEMA,
    columns: {
      'sources.list.element.dataset': datasets,
      'names.primary': flat((row) => row.name, 2),
      subtype: flat((row) => row.subtype),
      class: flat((row) => row.cls),
      'bbox.xmin': box(0),
      'bbox.xmax': box(2),
      'bbox.ymin': box(1),
      'bbox.ymax': box(3),
    },
  });
}

const point = (lon, lat) => [lon, lat, lon, lat];
const BALTIMORE = [
  {
    cls: 'traffic_signals',
    subtype: 'transportation',
    box: point(-76.6122, 39.2904),
  },
  {
    cls: 'traffic_signals',
    subtype: 'transportation',
    box: point(-76.615, 39.291),
  },
  {
    cls: 'fire_hydrant',
    subtype: 'emergency',
    box: point(-76.61, 39.292),
  },
  { cls: 'street_lamp', subtype: 'transportation', box: point(-76.611, 39.29) },
  // A crossing, a bench: not kept.
  { cls: 'crossing', subtype: 'transportation', box: point(-76.612, 39.29) },
  { cls: 'bench', subtype: 'pedestrian', box: point(-76.613, 39.29) },
  // A charging station mapped as an area: the centre of its box.
  {
    cls: 'charging_station',
    subtype: 'transportation',
    name: 'Harbor Garage',
    box: [-76.602, 39.284, -76.6, 39.286],
  },
  // A hydrant with no box: not placed.
  { cls: 'fire_hydrant', subtype: 'emergency' },
];

/** The rows as the step decodes them: {buckets, stats}. */
function decoded(t, rows) {
  const file = path.join(tmp(t), 'part-00000-test.zstd.parquet');
  infrastructureFile(file, rows);
  const bytes = fs.readFileSync(file);
  const footer = footerFromTail(bytes);
  const meta = footer.rowGroups[0];
  const group = {
    header: { file: 'part-00000-test.zstd.parquet', group: 0 },
    chunk: (p) => {
      const c = meta.columns.find((x) => x.path === p);
      return bytes.subarray(c.start, c.start + c.compressedSize);
    },
  };
  return decodeInfrastructureRowGroup(group, footer);
}

/** An index of these rows in dir/infrastructure, as the step writes it. */
function buildIndex(t, rows) {
  const dir = tmp(t);
  const root = path.join(dir, 'infrastructure');
  fs.mkdirSync(path.join(root, 'buckets'), { recursive: true });
  const { buckets, stats } = decoded(t, rows);
  const partFile = path.join(dir, 'a.part');
  writePart(partFile, { stats }, buckets);
  const header = readPartHeader(partFile);
  const manifestBuckets = {};
  for (const key of Object.keys(header.buckets)) {
    const name = `${key}.bin`;
    const result = mergePlacesBucket({
      bucketKey: Number(key),
      parts: [{ file: partFile, header }],
      target: path.join(root, 'buckets', name),
    });
    manifestBuckets[key] = { file: name, places: result.places };
  }
  const counts = writeGlobalCounts(
    Object.values(manifestBuckets).map((b) =>
      path.join(root, 'buckets', b.file),
    ),
    path.join(root, 'counts.abcd1234.bin'),
  );
  fs.writeFileSync(
    path.join(root, 'manifest-0123456789ab.json'),
    JSON.stringify({
      version: '0123456789ab',
      release: '2026-09-23.1',
      places: stats.kept,
      buckets: manifestBuckets,
      counts: { file: 'counts.abcd1234.bin', ...counts },
      stats,
    }),
  );
  fs.writeFileSync(
    path.join(root, 'current.json'),
    JSON.stringify({ manifest: 'manifest-0123456789ab.json' }),
  );
  return dir;
}

test('the classes kept, and the box centre as a feature’s point', () => {
  assert.deepEqual(
    INFRASTRUCTURE_CLASSES.map((c) => `${c.code} ${c.key} ${c.class}`),
    [
      '1 hydrant fire_hydrant',
      '2 lamp street_lamp',
      '3 signals traffic_signals',
      '4 charging charging_station',
    ],
  );
  assert.equal(infrastructureCode('fire_hydrant'), 1);
  assert.equal(infrastructureCode('crossing'), 0);
  assert.equal(infrastructureClass('signals').class, 'traffic_signals');
  assert.equal(infrastructureClass('all'), null);
  assert.deepEqual(boxCentre(-76.61, -76.61, 39.29, 39.29), [-76.61, 39.29]);
  assert.deepEqual(boxCentre(0, 2, 10, 12), [1, 11]);
  assert.equal(boxCentre(2, 0, 10, 12), null, 'an inverted box');
  assert.equal(boxCentre(null, 0, 10, 12), null);
  // The build reads eight columns, the box in place of the geometry.
  assert.deepEqual(POINT_BUILDS.infrastructure.columns, INFRASTRUCTURE_COLUMNS);
  assert.ok(!INFRASTRUCTURE_COLUMNS.includes('geometry'));
  assert.equal(POINT_BUILDS.infrastructure.source.theme, 'base');
});

test('a row group decoded: the four classes kept with their points, the rest counted out', (t) => {
  const { buckets, stats } = decoded(t, BALTIMORE);
  assert.deepEqual(stats, {
    read: 8,
    kept: 5,
    named: 1,
    unplaced: 1,
    byClass: {
      traffic_signals: 2,
      fire_hydrant: 1,
      street_lamp: 1,
      charging_station: 1,
    },
    byDataset: { OpenStreetMap: 5 },
  });
  assert.equal(buckets.size, 1, 'one z 6 tile');
});

test('the index and the routes: pins by class, spread and capped; counts per H3 cell', async (t) => {
  const dir = buildIndex(t, BALTIMORE);
  const index = createInfrastructureIndex({ dir });
  t.after(() => index.close());
  assert.equal(index.status().places, 5);
  assert.deepEqual(index.status().byClass.traffic_signals, 2);
  const box = { west: -76.7, south: 39.2, east: -76.5, north: 39.4 };
  const pins = (category, limit = 2000) =>
    index.pins({ ...box, category, minConfidence: 0.5, limit }).body;
  assert.equal(pins('all').places.length, 5);
  assert.equal(pins('signals').places.length, 2);
  const [hydrant] = pins('hydrant').places;
  assert.equal(hydrant.category, 'hydrant');
  assert.equal(hydrant.basic, 'fire_hydrant');
  assert.equal(hydrant.source, 'OpenStreetMap');
  assert.match(hydrant.id, /^in:\d+:\d+:\d+$/);
  assert.ok(Math.abs(hydrant.at[0] + 76.61) < 1e-4);
  const [garage] = pins('charging').places;
  assert.equal(garage.name, 'Harbor Garage');
  assert.ok(Math.abs(garage.at[1] - 39.285) < 1e-4, 'the area’s centre');
  const capped = pins('all', 2);
  assert.equal(capped.places.length, 2);
  assert.equal(capped.saturated, true);
  // Counts: resolution 7 per bucket, 3 from the global file.
  const r7 = index.counts({
    res: 7,
    window: box,
    category: 'signals',
    minConfidence: 0.5,
  }).body;
  assert.equal(r7.total, 2);
  assert.ok(r7.cells.some(([c]) => c === latLngToCell(39.2904, -76.6122, 7)));
  assert.equal(
    index.counts({ res: 3, window: null, category: 'all', minConfidence: 0.5 })
      .body.total,
    5,
  );

  // The routes.
  const service = createOvertureService({ dir });
  t.after(() => service.close());
  const handle = createOvertureHandler({ service });
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
    return {
      status: res.statusCode,
      json: JSON.parse(res.body || 'null'),
      cache: res.headers['cache-control'],
    };
  };
  const layers = await call('/layers');
  assert.equal(layers.json.infrastructure.configured, true);
  assert.equal(layers.json.infrastructure.version, '0123456789ab');
  const answer = await call(
    '/infrastructure?west=-76.7&south=39.2&east=-76.5&north=39.4&zoom=15&class=lamp&v=0123456789ab',
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.cache, 'private, max-age=86400');
  assert.equal(answer.json.places.length, 1);
  assert.equal(answer.json.saturated, false);
  const counts = await call('/infrastructure/counts?res=5&class=all');
  assert.equal(counts.json.total, 5);
  assert.equal(counts.cache, 'no-store');
  for (const bad of [
    '/infrastructure?west=-78&south=39&east=-76&north=40',
    '/infrastructure?west=-76.7&south=39.2&east=-76.5&north=39.4&class=crossing',
    '/infrastructure?west=-76.7&south=39.2&east=-76.5&north=39.4&zoom=40',
    '/infrastructure/counts?res=8',
  ])
    assert.equal((await call(bad)).status, 400, bad);
  // Without the build: 503, said in /layers.
  const bare = createOvertureService({ dir: tmp(t) });
  t.after(() => bare.close());
  const none = createOvertureHandler({ service: bare });
  const res = {
    headers: {},
    setHeader() {},
    end(b) {
      this.body = b;
    },
  };
  await none(
    {
      method: 'GET',
      url: '/infrastructure?west=-76.7&south=39.2&east=-76.5&north=39.4',
      headers: { host: 'localhost' },
    },
    res,
  );
  assert.equal(res.statusCode, 503);
});

test('query parsing: a box under a degree, a class, an optional zoom', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(
    parseInfrastructureQuery(
      q('west=1&south=2&east=1.5&north=2.5&class=hydrant'),
    ),
    {
      west: 1,
      south: 2,
      east: 1.5,
      north: 2.5,
      category: 'hydrant',
      minConfidence: 0.5,
      limit: 2000,
    },
  );
  assert.equal(
    parseInfrastructureQuery(q('west=1&south=2&east=1.5&north=2.5')).category,
    'all',
  );
  assert.match(
    parseInfrastructureQuery(q('west=179.8&south=2&east=-179.8&north=2.5'))
      .error,
    /wider|antimeridian/,
  );
  assert.deepEqual(parseInfrastructureCountsQuery(q('res=6&class=signals')), {
    res: 6,
    window: null,
    category: 'signals',
    minConfidence: 0.5,
  });
});

test('the client: the infrastructure route, its class, pins checked on the way in', async () => {
  const asked = [];
  const source = createInfrastructureSource({
    fetchImpl: async (url) => {
      asked.push(String(url));
      const body = String(url).startsWith('/api/overture/layers')
        ? {
            infrastructure: {
              configured: true,
              version: '0123456789ab',
              places: 5,
            },
          }
        : String(url).includes('/counts')
          ? {
              cells: [
                ['872a1072bffffff', 4],
                ['bogus', 3],
              ],
            }
          : {
              places: [
                { id: 'in:1:2:3', at: [-76.61, 39.29], category: 'hydrant' },
                { id: 'pl:1:2:3', at: [-76.61, 39.29] },
                { id: 'in:1:2:4', at: [500, 39.29] },
              ],
              saturated: false,
            };
      return { ok: true, status: 200, json: async () => body };
    },
  });
  assert.equal((await source.status()).version, '0123456789ab');
  const answer = await source.pins({
    box: { west: -76.7, south: 39.2, east: -76.5, north: 39.4 },
    category: 'hydrant',
    minConfidence: 0.5,
    version: '0123456789ab',
  });
  assert.deepEqual(answer.places, [
    { id: 'in:1:2:3', at: [-76.61, 39.29], category: 'hydrant' },
  ]);
  assert.match(
    asked[1],
    /^\/api\/overture\/infrastructure\?class=hydrant&v=0123456789ab&west=/,
  );
  assert.doesNotMatch(asked[1], /minConfidence/);
  const cells = await source.counts({
    res: 7,
    category: 'lamp',
    version: null,
  });
  assert.deepEqual([...cells], [['872a1072bffffff', 4]]);
  assert.match(
    asked[2],
    /^\/api\/overture\/infrastructure\/counts\?class=lamp&res=7$/,
  );
  assert.equal(normalizeInfrastructurePoint({ id: 'in:1', at: [0, 91] }), null);
});
