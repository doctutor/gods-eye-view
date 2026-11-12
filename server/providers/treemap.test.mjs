// Personal fork: the treemap navigator's build (scripts/treemap) and
// service (/api/treemap) on a small areas build and localities index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildTreemap, parseArgs } from '../../scripts/treemap/index.mjs';
import { createTreemapHandler } from './treemap.js';
import { EARTH_AREA_M2, lonLatRingArea } from './treemap/geodesy.js';
import { createTreemapService } from './treemap/service.js';
import { NEEDS_TREEMAP_BUILD, treemapDir } from './treemap/sources.js';
import { OCEAN_KEY, REST_KEY } from './treemap/table.js';
import { writeVarint } from './overtureAreas/format.js';

const BITS = [13, 16, 19, 24];
const mx = (lon) => (lon + 180) / 360;
const my = (lat) =>
  (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const boxRing = ([w, s, e, n]) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
];

/** One band's record of a polygon (lon/lat rings) quantized at `bits`. */
function record(rings, bits) {
  const bytes = [];
  const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
  writeVarint(bytes, 1);
  writeVarint(bytes, rings.length);
  for (const ring of rings) {
    writeVarint(bytes, ring.length);
    let px = 0;
    let py = 0;
    for (const [lon, lat] of ring) {
      const x = Math.round(mx(lon) * 2 ** bits);
      const y = Math.round(my(lat) * 2 ** bits);
      writeVarint(bytes, zig(x - px));
      writeVarint(bytes, zig(y - py));
      px = x;
      py = y;
    }
  }
  return Buffer.from(bytes);
}

const UNITS = [
  // France: two regions, A with one county over its west half, B with
  // none; a county outside every region; a sea area.
  ['fr', 'country', 'land', 'FR', null, [0, 40, 4, 44], 'France'],
  ['fr-sea', 'country', 'sea', 'FR', null, [-1, 39, 5, 45], 'France'],
  ['fr-a', 'region', 'land', 'FR', 'FR-A', [0, 40, 2, 44], 'Aa'],
  ['fr-b', 'region', 'land', 'FR', 'FR-B', [2, 40, 3, 44], 'Bb'],
  ['fr-a1', 'county', 'land', 'FR', 'FR-A', [0, 40, 1.2, 44], 'A one'],
  ['fr-x', 'county', 'land', 'FR', null, [3, 40, 3.5, 44], 'Loose'],
  ['mc', 'country', 'land', 'MC', null, [7, 43, 7.5, 43.5], 'Monaco'],
  // A code with no continent is left out.
  ['zz', 'country', 'land', 'ZZ', null, [10, 10, 11, 11], 'Nowhere'],
];

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-treemap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const areas = path.join(root, 'overture', 'build', 'areas');
  fs.mkdirSync(areas, { recursive: true });
  const chunks = [];
  let at = 0;
  const units = UNITS.map(([id, subtype, kind, country, region, box, name]) => {
    const offsets = [];
    const lengths = [];
    for (const bits of BITS) {
      const bytes = record([boxRing(box)], bits);
      offsets.push(at);
      lengths.push(bytes.length);
      chunks.push(bytes);
      at += bytes.length;
    }
    return {
      id,
      subtype,
      kind,
      country,
      region,
      name,
      nameEn: null,
      box: [mx(box[0]), my(box[3]), mx(box[2]), my(box[1])],
      offsets,
      lengths,
    };
  });
  fs.writeFileSync(path.join(areas, 'areas-t.bin'), Buffer.concat(chunks));
  fs.writeFileSync(path.join(areas, 'units-t.json'), JSON.stringify(units));
  fs.writeFileSync(
    path.join(areas, 'manifest.json'),
    JSON.stringify({
      buildId: 'areas-one',
      release: '2026-09-23.1',
      files: { areas: 'areas-t.bin', units: 'units-t.json', index: 'i.json' },
      levels: BITS.map((quantBits, i) => ({ level: `z${i}`, quantBits })),
    }),
  );

  // Localities: Paris-like and a village in FR-A, a town in no region,
  // a neighbourhood (not counted), Monaco.
  const build = path.join(root, 'overture', 'build', 'abcdefabcdef');
  fs.mkdirSync(build, { recursive: true });
  const places = [
    [1, 42, 1000, 1, 'Big', 'Q1', 'FR-A'],
    [1.5, 42, 50, 3, 'Small', '', 'FR-A'],
    [3.2, 42, 300, 2, 'Loose town', 'Q3', ''],
    [1, 42.1, 900, 9, 'Quarter', 'Q4', 'FR-A'],
    [7.2, 43.2, 40, 1, 'Monaco', 'Q5', ''],
  ];
  const points = Buffer.alloc(places.length * 24);
  const strings = [];
  let offset = 0;
  places.forEach(([lon, lat, population, kind, name, wikidata, region], i) => {
    const text = Buffer.from([name, '', '', '', wikidata, region].join('\0'));
    const o = i * 24;
    points.writeInt32LE(Math.round(lon * 1e7), o);
    points.writeInt32LE(Math.round(lat * 1e7), o + 4);
    points.writeUInt32LE(population, o + 8);
    points.writeUInt32LE(offset, o + 12);
    points.writeUInt16LE(text.length, o + 16);
    points[o + 20] = kind;
    points.writeUInt16LE(name === 'Monaco' ? 2 : 1, o + 21);
    strings.push(text);
    offset += text.length;
  });
  fs.writeFileSync(path.join(build, 'points.bin'), points);
  fs.writeFileSync(path.join(build, 'strings.bin'), Buffer.concat(strings));
  fs.writeFileSync(
    path.join(build, 'manifest.json'),
    JSON.stringify({ buildId: 'abcdefabcdef', countries: ['FR', 'MC'] }),
  );
  fs.writeFileSync(
    path.join(root, 'overture', 'build', 'current.json'),
    JSON.stringify({ buildId: 'abcdefabcdef' }),
  );
  const env = {
    OVERTURE_CACHE_DIR: path.join(root, 'overture'),
    TREEMAP_DIR: path.join(root, 'treemap'),
  };
  return { root, env, dir: treemapDir(env, root) };
}

const area = (box) => lonLatRingArea(boxRing(box));
const near = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1, expected * 1e-4),
    `${what}: ${actual} against ${expected}`,
  );

test('the build: areas up the ISO links with remainders, people by place, and nothing twice', async (t) => {
  const { root, env, dir } = await fixture(t);
  const lines = [];
  const first = await buildTreemap({ root, env, log: (l) => lines.push(l) });
  assert.deepEqual(Object.keys(first.done), ['areas', 'people']);
  assert.ok(
    lines.some((l) => /no continent for ZZ/.test(l)),
    lines.join('\n'),
  );
  const again = await buildTreemap({ root, env });
  assert.deepEqual(again.done, {});
  const forced = await buildTreemap({
    root,
    env,
    only: ['people'],
    force: true,
  });
  assert.deepEqual(Object.keys(forced.done), ['people']);
  // One file per table: the forced rebuild replaced its own.
  assert.equal(fs.readdirSync(path.join(dir, 'tables')).length, 3);

  const service = createTreemapService({ dir, sourceRoot: root, env });
  const address =
    'm2/surface-area://admin.continent/admin.country/admin.region/admin.district';
  const top = service.node({ address });
  assert.equal(top.status, 200);
  near(top.body.total.value, EARTH_AREA_M2, 'the planet');
  const land = area([0, 40, 4, 44]) + area([7, 43, 7.5, 43.5]);
  const ocean = top.body.children.find((c) => c.key === OCEAN_KEY);
  near(ocean.value, EARTH_AREA_M2 - land, 'oceans and unclaimed');
  assert.equal(ocean.label, 'Oceans and unclaimed');
  assert.equal(ocean.hasChildren, false);

  const france = service.node({ address, path: ['europe', 'FR'] });
  const byKey = Object.fromEntries(france.body.children.map((c) => [c.key, c]));
  near(byKey['FR-A'].value, area([0, 40, 2, 44]), 'region A');
  near(byKey['FR-B'].value, area([2, 40, 3, 44]), 'region B');
  // The loose county and the part no division covers, under "No region".
  near(
    byKey[REST_KEY].value,
    area([3, 40, 4, 44]),
    'no region: the loose county and the rest',
  );
  assert.equal(byKey[REST_KEY].label, 'No region');
  assert.equal(byKey[REST_KEY].hasChildren, true);
  assert.equal(byKey['FR-B'].hasChildren, false);
  assert.equal(byKey['FR-A'].geo, 'area:fr-a');
  near(france.body.total.value, area([0, 40, 4, 44]), 'France');
  const regionA = service.node({ address, path: ['europe', 'FR', 'FR-A'] });
  assert.deepEqual(
    regionA.body.children.map((c) => [c.key, c.label]),
    [
      ['fr-a1', 'A one'],
      [REST_KEY, 'No district'],
    ],
  );

  const people = service.node({
    address:
      'count/people://admin.continent/admin.country/admin.region/locality.place',
    path: ['europe', 'FR'],
    depth: 2,
  });
  assert.equal(people.status, 200);
  assert.equal(people.body.exact, false);
  assert.match(people.body.note, /not a census/);
  // The neighbourhood is no settlement: 1000 + 50 + 300.
  assert.deepEqual(people.body.total, { value: 1350, count: 3 });
  assert.deepEqual(
    people.body.children.map((c) => [c.key, c.value]),
    [
      ['FR-A', 1050],
      [REST_KEY, 300],
    ],
  );
  assert.deepEqual(
    people.body.children[0].children.map((c) => [c.key, c.label, c.geo]),
    [
      ['Q1', 'Big', 'point:1.00000,42.00000'],
      ['n1', 'Small', 'point:1.50000,42.00000'],
    ],
  );
  const kinds = service.node({
    address: 'count/people://admin.country*locality.kind',
    path: ['FR'],
  });
  assert.deepEqual(
    kinds.body.children.map((c) => [c.key, c.label, c.value]),
    [
      ['city', 'Cities', 1000],
      ['town', 'Towns', 300],
      ['village', 'Villages', 50],
    ],
  );
  assert.equal(
    kinds.body.address,
    'count/people://admin.country*locality.kind',
  );
  assert.equal(kinds.body.mode, 'additive');
  assert.equal(kinds.body.unit, 'count');
  assert.deepEqual(kinds.body.level, {
    grouping: 'locality.kind',
    label: 'Kind of place',
  });
  assert.equal(parseArgs(['build', '--only', 'areas']).only[0], 'areas');
  assert.throws(() => parseArgs(['build', '--only', 'nope']), /unknown step/);
});

test('the catalogue says what is built; what cannot be answered is a 400 with the reason', async (t) => {
  const { root, env, dir } = await fixture(t);
  const empty = createTreemapService({ dir, sourceRoot: root, env });
  const before = empty.catalog();
  assert.equal(before.schema, 'treemap/1');
  assert.deepEqual(
    before.variables.find((v) => v.id === 'm2/surface-area'),
    {
      id: 'm2/surface-area',
      available: false,
      why: NEEDS_TREEMAP_BUILD,
      groupings: [
        'admin.continent',
        'admin.country',
        'admin.region',
        'admin.district',
        'landcover.class',
      ],
    },
  );
  await buildTreemap({ root, env });
  const service = createTreemapService({ dir, sourceRoot: root, env });
  const catalog = service.catalog();
  const of = (id) => catalog.variables.find((v) => v.id === id);
  assert.deepEqual(of('m2/surface-area'), {
    id: 'm2/surface-area',
    available: true,
    asOf: '2026-09-23.1',
    groupings: [
      'admin.continent',
      'admin.country',
      'admin.region',
      'admin.district',
    ],
  });
  assert.equal(of('count/people').available, true);
  assert.equal(of('count/places').available, false);
  assert.equal(of('count/aircraft').available, true);
  assert.deepEqual(
    catalog.groupings.find((g) => g.id === 'admin.country'),
    {
      id: 'admin.country',
      family: 'admin',
      level: 'country',
      kind: 'hierarchy',
      parent: 'admin.continent',
    },
  );
  const reasons = [
    ['m2/surface-area', /needs ":\/\/"/],
    ['m2/sea-area://admin.country', /no variable "m2\/sea-area"/],
    ['count/places://place.category', /not built/],
    ['count/aircraft://aircraft.class', /live layers/],
    [
      'm2/surface-area://admin.country*landcover.class',
      /cannot be cut by landcover.class/,
    ],
  ];
  for (const [address, reason] of reasons) {
    const answer = service.node({ address });
    assert.equal(answer.status, 400, address);
    assert.match(answer.body.error, reason, address);
  }
  assert.match(
    service.node({
      address: 'm2/surface-area://admin.country/admin.region',
      path: ['XX'],
    }).body.error,
    /no "XX"/,
  );
});

test('outlines: an area from its band, a box, a point, an H3 cell', async (t) => {
  const { root, env, dir } = await fixture(t);
  await buildTreemap({ root, env });
  const service = createTreemapService({ dir, sourceRoot: root, env });
  const france = service.geo('area:fr');
  assert.equal(france.status, 200);
  assert.equal(france.body.geometry.type, 'MultiPolygon');
  const ring = france.body.geometry.coordinates[0][0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  for (const [lon, lat] of ring) {
    assert.ok(
      [0, 4].some((v) => Math.abs(lon - v) < 0.05),
      String(lon),
    );
    assert.ok(
      [40, 44].some((v) => Math.abs(lat - v) < 0.05),
      String(lat),
    );
  }
  assert.equal(service.geo('area:nope').status, 404);
  assert.deepEqual(service.geo('point:2.5,48.1').body.geometry, {
    type: 'Point',
    coordinates: [2.5, 48.1],
  });
  assert.equal(
    service.geo('box:170,-10,-170,10').body.geometry.type,
    'MultiPolygon',
  );
  assert.equal(service.geo('box:0,10,1,5').status, 400);
  const cell = service.geo('h3:871fb4662ffffff');
  assert.equal(cell.status, 200);
  assert.equal(cell.body.geometry.coordinates[0].length, 7);
  assert.equal(service.geo('h3:nothex').status, 400);
  assert.equal(service.geo('somewhere').status, 400);
});

function call(handler, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: body ? JSON.parse(body) : null,
        });
      },
    };
    handler(
      {
        method,
        url,
        headers: { host: 'localhost:4173', ...headers },
        socket: {},
      },
      res,
      () => resolve({ status: 'next' }),
    );
  });
}

test('the routes: parameters checked, a repeated node a 304, other paths passed on', async (t) => {
  const { root, env, dir } = await fixture(t);
  await buildTreemap({ root, env });
  const handler = createTreemapHandler({
    service: createTreemapService({ dir, sourceRoot: root, env }),
  });
  const catalog = await call(handler, '/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.schema, 'treemap/1');
  const address = encodeURIComponent(
    'm2/surface-area://admin.continent/admin.country',
  );
  const url = `/node?address=${address}&path=europe&limit=1`;
  const node = await call(handler, url);
  assert.equal(node.status, 200);
  assert.deepEqual(
    node.body.children.map((c) => c.key),
    ['FR'],
  );
  assert.equal(node.body.rest.count, 1);
  const again = await call(handler, url, {
    headers: { 'if-none-match': node.headers.etag },
  });
  assert.equal(again.status, 304);
  for (const bad of ['&depth=3', '&limit=0', '&offset=-1', '&path=europe//FR'])
    assert.equal(
      (await call(handler, `/node?address=${address}${bad}`)).status,
      400,
      bad,
    );
  assert.equal((await call(handler, '/geo?ref=point:1,2')).status, 200);
  assert.equal(
    (await call(handler, '/catalog', { method: 'POST' })).status,
    405,
  );
  assert.equal((await call(handler, '/elsewhere')).status, 'next');
});
