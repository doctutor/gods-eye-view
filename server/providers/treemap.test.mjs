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
  // Every unit filed in the one cell of zoom 0.
  fs.writeFileSync(
    path.join(areas, 'i.json'),
    JSON.stringify({ 0: { 0: units.map((unit, i) => i) } }),
  );
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
  assert.deepEqual(Object.keys(first.done), ['areas', 'people', 'labels']);
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
  // One file per table (the labelling's two): the forced rebuild replaced
  // its own.
  assert.equal(fs.readdirSync(path.join(dir, 'tables')).length, 5);

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

test('polity area: each period at its middle year, members inside a living parent left out', async () => {
  const { buildPolitiesTable, periodLabel, polityKey } =
    await import('../../scripts/treemap/polities.mjs');
  const { openTable } = await import('./treemap/table.js');
  const record = (name, from, to, area, extra = {}) => ({
    name,
    from,
    to,
    area,
    type: 'polity',
    box: [0, 0, 1, 1],
    ...extra,
  });
  const index = {
    records: [
      record('(Empire)', 1900, 1960, 30),
      record('Colony', 1880, 1990, 5, { memberOf: '(Empire)' }),
      record('Kingdom A/B', 1800, 2000, 10),
      record('Union', 1900, 2000, 99, { type: 'relation' }),
      record('Old', -60, 10, 2),
    ],
  };
  const { table, stats } = buildPolitiesTable({ index, lastYear: 2000 });
  const opened = openTable(JSON.parse(JSON.stringify(table)));
  const groupings = ['history.period', 'history.polity'];
  const at = (period) =>
    opened
      .node({ groupings, path: [period] })
      .children.map((c) => [c.key, c.label, c.value / 1e6]);
  // 1925: the empire holds its colony; 1975: the colony stands alone.
  assert.deepEqual(at('1900'), [
    ['(Empire)', 'Empire', 30],
    ['Kingdom A∕B', 'Kingdom A/B', 10],
  ]);
  assert.deepEqual(at('1950'), [
    ['Kingdom A∕B', 'Kingdom A/B', 10],
    ['Colony', 'Colony', 5],
  ]);
  // -50 to 1 BCE samples -25; 0 to 49 samples 25 (no year 0).
  assert.deepEqual(at('-50'), [['Old', 'Old', 2]]);
  assert.equal(opened.label('history.period', '-50'), '50 BCE–1 BCE');
  assert.equal(periodLabel(2000, 2000), '2000–2000');
  assert.equal(polityKey('a/b'), 'a∕b');
  assert.equal(stats.rows, opened.rowCount);
  assert.equal(table.exact, false);
});

test('the labeller: a point in its country, region and district, at sea none; a raster filled by pixel centres', async (t) => {
  const { fillRaster, createLabeller } = await import('./treemap/labeller.js');
  const raster = new Uint16Array(16);
  // A square from 1 to 3 on a 4 × 4 raster of unit pixels, a hole at 2.
  fillRaster(
    raster,
    [[Int32Array.from([1, 1, 3, 1, 3, 3, 1, 3])]],
    { x0: 0, y0: 0, step: 1, size: 4 },
    7,
  );
  assert.deepEqual(
    [...raster],
    [0, 0, 0, 0, 0, 7, 7, 0, 0, 7, 7, 0, 0, 0, 0, 0],
  );
  const { root } = await fixture(t);
  const labeller = createLabeller({
    areasDir: path.join(root, 'overture', 'build', 'areas'),
  });
  t.after(() => labeller.close());
  assert.deepEqual(labeller.label(0.5, 42), {
    country: 'FR',
    region: 'FR-A',
    district: 'fr-a1',
  });
  assert.deepEqual(labeller.label(2.5, 42), {
    country: 'FR',
    region: 'FR-B',
    district: null,
  });
  assert.deepEqual(labeller.label(3.2, 42), {
    country: 'FR',
    region: null,
    district: 'fr-x',
  });
  assert.equal(labeller.label(7.2, 43.2).country, 'MC');
  // ZZ has no continent but is still a country to the labeller.
  assert.equal(labeller.label(10.5, 10.5).country, 'ZZ');
  assert.equal(labeller.label(-30, 30), null);
  assert.equal(labeller.label(0, 89), null);
});

test('Wikipedia: articles and their bytes by country, region, language and kind; a secondary coordinate left out', async (t) => {
  const { root, env, dir } = await fixture(t);
  const { writeBucket } = await import('./overture/buildingsFile.js');
  const { POINT_KIND, encodeBlock } =
    await import('./wikipediaCoverage/pointsFile.js');
  const points = path.join(root, 'wikipedia', 'points');
  fs.mkdirSync(path.join(points, 'buckets'), { recursive: true });
  const grid = (lon, lat) => ({
    x: Math.floor(mx(lon) * 2 ** 28),
    y: Math.floor(my(lat) * 2 ** 28),
  });
  const article = (lon, lat, wiki, cls, bytes, flags = 0) => ({
    ...grid(lon, lat),
    page: 1,
    qid: 1,
    bytes,
    dim: 0,
    cls,
    flags,
    wiki,
    title: 't',
    type: '',
  });
  writeBucket(path.join(points, 'buckets', 'b.bin'), [
    {
      kind: POINT_KIND + 12,
      key: 0,
      count: 5,
      raw: encodeBlock([
        article(0.5, 42, 1, 1, 1000),
        article(0.6, 42, 3, 2, 300),
        article(2.5, 42, 1, 2, 50),
        article(2.5, 42.5, 1, 2, 99, 1),
        article(-30, 30, 1, 4, 7),
      ]),
    },
  ]);
  fs.writeFileSync(
    path.join(points, 'manifest-0123456789ab.json'),
    JSON.stringify({
      format: 3,
      version: 'w1',
      dump: { date: '2026-10-08' },
      buckets: { 0: { file: 'b.bin' } },
    }),
  );
  fs.writeFileSync(
    path.join(points, 'current.json'),
    JSON.stringify({ manifest: 'manifest-0123456789ab.json' }),
  );
  const wikiEnv = {
    ...env,
    WIKIPEDIA_COVERAGE_DIR: path.join(root, 'wikipedia'),
  };
  const built = await buildTreemap({ root, env: wikiEnv, only: ['wikipedia'] });
  assert.ok(built.done.wikipedia);
  const service = createTreemapService({ dir, sourceRoot: root, env });
  const languages = service.node({
    address: 'count/wikipedia-articles://wikipedia.language/admin.country',
  });
  assert.deepEqual(
    languages.body.children.map((c) => [c.key, c.label, c.value]),
    [
      ['en', 'English', 3],
      ['fr', 'French', 1],
    ],
  );
  const english = service.node({
    address: 'count/wikipedia-articles://wikipedia.language/admin.country',
    path: ['en'],
  });
  assert.deepEqual(
    english.body.children.map((c) => [c.key, c.value]),
    [
      ['FR', 2],
      [OCEAN_KEY, 1],
    ],
  );
  const text = service.node({
    address: 'byte/wikipedia-text://admin.country/wikipedia.class',
    path: ['FR'],
  });
  assert.deepEqual(
    text.body.children.map((c) => [c.key, c.label, c.value, c.count]),
    [
      ['place', 'Places', 1000, 1],
      ['landmark', 'Landmarks', 350, 2],
    ],
  );
  assert.equal(
    service.catalog().variables.find((v) => v.id === 'byte/wikipedia-text')
      .asOf,
    '2026-10-08',
  );
});

test('places by category from the H3 counts; buildings, footprint and volume from the density cells', async (t) => {
  const { root, env, dir } = await fixture(t);
  const { KIND, writeBucket, encodeCells } =
    await import('./overture/buildingsFile.js');
  const { PLACE_KIND, encodeCounts, slotOf } =
    await import('./overture/placesFile.js');
  const overture = path.join(root, 'overture');
  // Places: two res 7 cells in region A (food 3 and 1 at ≥ 0.8; shopping 2),
  // one at sea.
  const places = path.join(overture, 'places');
  fs.mkdirSync(path.join(places, 'buckets'), { recursive: true });
  const counts = (entries) => {
    const vector = new Uint32Array(24);
    for (const [slot, n] of entries) vector[slot] = n;
    return vector;
  };
  writeBucket(path.join(places, 'buckets', 'p.bin'), [
    {
      kind: PLACE_KIND.H,
      key: 7,
      count: 3,
      raw: encodeCounts(
        new Map([
          [
            '871fb4662ffffff',
            {
              lat: 42,
              lon: 0.5,
              counts: counts([
                [slotOf(1, 0), 3],
                [slotOf(1, 1), 1],
                [slotOf(2, 0), 2],
              ]),
            },
          ],
          [
            '871fb4663ffffff',
            { lat: 42.5, lon: 1.5, counts: counts([[slotOf(1, 0), 4]]) },
          ],
          [
            '871fb4664ffffff',
            { lat: 30, lon: -30, counts: counts([[slotOf(11, 0), 1]]) },
          ],
        ]),
      ),
    },
  ]);
  fs.writeFileSync(
    path.join(places, 'manifest-aaaaaaaaaaaa.json'),
    JSON.stringify({
      version: 'p1',
      release: 'r',
      buckets: { a: { file: 'p.bin' } },
    }),
  );
  fs.writeFileSync(
    path.join(places, 'current.json'),
    JSON.stringify({ manifest: 'manifest-aaaaaaaaaaaa.json' }),
  );
  // Buildings: one z 10 tile's cells in region B, one cell with heights
  // known for half its footprint, one with none.
  const buildings = path.join(overture, 'buildings');
  fs.mkdirSync(path.join(buildings, 'buckets'), { recursive: true });
  const tx = Math.floor(mx(2.5) * 1024);
  const ty = Math.floor(my(42) * 1024);
  const bx = tx >> 4;
  const by = ty >> 4;
  const cellAt = (lon, lat) => {
    const cx = Math.floor(mx(lon) * 2 ** 18) - tx * 256;
    const cy = Math.floor(my(lat) * 2 ** 18) - ty * 256;
    return cy * 256 + cx;
  };
  const here = cellAt(2.5, 42);
  writeBucket(path.join(buildings, 'buckets', `${bx}-${by}.b.bin`), [
    {
      kind: KIND.D18,
      key: (ty % 16) * 16 + (tx % 16),
      count: 2,
      raw: encodeCells(
        new Map([
          [here, Float64Array.from([4, 100, 500, 50])],
          [here + 1, Float64Array.from([1, 20, 0, 0])],
        ]),
      ),
    },
  ]);
  fs.writeFileSync(
    path.join(buildings, 'manifest-bbbbbbbbbbbb.json'),
    JSON.stringify({
      version: 'b1',
      regions: ['europe'],
      attribution: 'Overture',
      buckets: { [`${bx}-${by}`]: { file: `${bx}-${by}.b.bin` } },
    }),
  );
  fs.writeFileSync(
    path.join(buildings, 'current.json'),
    JSON.stringify({ manifest: 'manifest-bbbbbbbbbbbb.json' }),
  );

  await buildTreemap({ root, env, only: ['places', 'buildings'] });
  const service = createTreemapService({ dir, sourceRoot: root, env });
  const categories = service.node({
    address: 'count/places://place.category/admin.country/admin.region',
  });
  assert.deepEqual(
    categories.body.children.map((c) => [c.key, c.label, c.value]),
    [
      ['food', 'Food and drink', 7],
      ['shopping', 'Shopping', 2],
      ['other', 'Services and other', 1],
    ],
  );
  const food = service.node({
    address: 'count/places://place.category/admin.country/admin.region',
    path: ['food', 'FR'],
  });
  assert.deepEqual(
    food.body.children.map((c) => [c.key, c.value]),
    [['FR-A', 7]],
  );
  const count = service.node({
    address: 'count/buildings://admin.country/admin.region',
    path: ['FR'],
  });
  assert.deepEqual(
    count.body.children.map((c) => [c.key, c.value]),
    [['FR-B', 5]],
  );
  const footprint = service.node({
    address: 'm2/building-footprint://admin.country',
  });
  assert.equal(footprint.body.total.value, 120);
  assert.equal(footprint.body.total.count, 5);
  // 500 known, 50 m² more at the cell's mean of 10 m, 20 m² at 5 m.
  const volume = service.node({
    address: 'm3/building-volume://admin.country',
  });
  assert.equal(volume.body.total.value, 500 + 50 * 10 + 20 * 5);
  assert.match(volume.body.note, /europe build only/);
});

test('POST /label: live points to their units in order, at sea null; the body checked', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { root, env, dir } = await fixture(t);
  // Before the labelling is built, /label says what to build.
  const before = createTreemapService({ dir, sourceRoot: root, env });
  assert.equal(before.label({ points: [] }).status, 503);
  const built = await buildTreemap({ root, env, only: ['labels'] });
  assert.ok(built.done.labels.tiles >= 1);
  assert.ok(built.done.labels.dataBytes > 0);
  const service = createTreemapService({ dir, sourceRoot: root, env });
  const handler = createTreemapHandler({ service });
  const post = (body, method = 'POST') =>
    new Promise((resolve) => {
      const req = new EventEmitter();
      Object.assign(req, {
        method,
        url: '/label',
        headers: { host: 'localhost:4173' },
        socket: {},
      });
      const res = {
        statusCode: 200,
        setHeader() {},
        end(text) {
          resolve({ status: this.statusCode, body: JSON.parse(text) });
        },
      };
      handler(req, res, () => resolve({ status: 'next' }));
      if (method === 'POST') {
        req.emit('data', Buffer.from(body));
        req.emit('end');
      }
    });
  const answer = await post(
    JSON.stringify({ points: [[0.5, 42], [-30, 30], 'x', [2.5, 42]] }),
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    units: [
      { country: 'FR', region: 'FR-A', district: 'fr-a1' },
      null,
      null,
      { country: 'FR', region: 'FR-B', district: null },
    ],
  });
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('{"points": 3}')).status, 400);
  assert.equal(
    (await post(JSON.stringify({ points: new Array(20_001).fill([0, 0]) })))
      .status,
    400,
  );
  assert.equal((await post('', 'GET')).status, 405);
  // The stored labelling answers as the drawn one does.
  const { createLabeller } = await import('./treemap/labeller.js');
  const drawn = createLabeller({
    areasDir: path.join(root, 'overture', 'build', 'areas'),
  });
  t.after(() => drawn.close());
  for (let lon = -1; lon <= 12; lon += 0.37)
    for (let lat = 39; lat <= 45; lat += 0.41)
      assert.deepEqual(
        service.label({ points: [[lon, lat]] }).body.units[0],
        drawn.label(lon, lat),
        `${lon}, ${lat}`,
      );
  assert.equal(
    (await buildTreemap({ root, env, only: ['labels'] })).done.labels,
    undefined,
  );
});
