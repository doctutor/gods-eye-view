// Personal fork: the Overture divisions build and server
// (scripts/overture/, server/providers/overture.js): the Parquet reader on
// a small file written here, the kept points and their zooms, the index's
// thinning, and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  OVERTURE_MAX_ZOOM,
  OVERTURE_PLACE_LIMIT,
  overtureKind,
  overtureMinZoom,
  zoomForProminence,
} from './overtureDivisions.js';
import {
  openParquet,
  rowsOfFlat,
  rowsOfRepeated,
} from '../../scripts/overture/parquet.mjs';
import {
  parseListing,
  readDivisions,
  regionBoxes,
} from '../../scripts/overture/index.mjs';
import {
  columnsOf,
  openIndex,
  writeIndex,
} from '../../server/providers/overture/divisionsFile.js';
import { DIVISIONS } from '../../server/providers/overture/sources.js';
import {
  createOvertureHandler,
  createOvertureService,
  overtureVersion,
  parseDivisionsQuery,
} from '../../server/providers/overture.js';

// ── A small Parquet writer (Thrift compact, data pages v1) ──────────────

class Thrift {
  constructor() {
    this.bytes = [];
  }
  varint(value) {
    let v = BigInt(value);
    for (;;) {
      if (v < 0x80n) {
        this.bytes.push(Number(v));
        return;
      }
      this.bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
  }
  zigzag(value) {
    const v = BigInt(value);
    this.varint(v >= 0n ? v << 1n : (-v << 1n) - 1n);
  }
  /** fields: [[id, type, value]] with type i32 | i64 | binary | struct | list:<elem> */
  struct(fields) {
    let last = 0;
    for (const [id, type, value] of fields) {
      if (value === undefined) continue;
      const code =
        { bool: value ? 1 : 2, i32: 5, i64: 6, binary: 8, struct: 12 }[type] ??
        9;
      if (id - last > 0 && id - last <= 15)
        this.bytes.push(((id - last) << 4) | code);
      else {
        this.bytes.push(code);
        this.zigzag(id);
      }
      last = id;
      this.value(type, value);
    }
    this.bytes.push(0);
  }
  value(type, value) {
    if (type === 'bool') return;
    if (type === 'i32' || type === 'i64') return this.zigzag(value);
    if (type === 'binary') {
      const b = Buffer.from(value);
      this.varint(b.length);
      for (const x of b) this.bytes.push(x);
      return;
    }
    if (type === 'struct') return this.struct(value);
    const elem = type.slice(5);
    const code = { i32: 5, binary: 8, struct: 12 }[elem];
    if (value.length < 15) this.bytes.push((value.length << 4) | code);
    else {
      this.bytes.push(0xf0 | code);
      this.varint(value.length);
    }
    for (const item of value) this.value(elem, item);
  }
  buffer() {
    return Buffer.from(this.bytes);
  }
}

/** RLE runs of one value each (valid hybrid encoding). */
function rle(levels, width) {
  const out = [];
  for (const level of levels) {
    out.push(2);
    for (let b = 0; b < Math.ceil(width / 8); b++)
      out.push((level >> (8 * b)) & 0xff);
  }
  const body = Buffer.from(out);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function plain(type, values) {
  if (type === 1) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
    return b;
  }
  return Buffer.concat(
    values.map((v) => {
      const body = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      return Buffer.concat([length, body]);
    }),
  );
}

/**
 * Write a Parquet file. `schema` is the element tree; `columns` per leaf
 * path: {type, values (defined only), def, rep, maxDef, maxRep, dict?}.
 */
function writeParquet(file, { schema, columns, rows, codec = 0 }) {
  const parts = [Buffer.from('PAR1')];
  let offset = 4;
  const chunks = [];
  for (const [pathName, column] of Object.entries(columns)) {
    const start = offset;
    const pages = [];
    let dictionaryOffset;
    let encoding = 0;
    let body;
    if (column.dict) {
      const rawDict = plain(column.type, column.dict);
      const dict = codec === 6 ? zlib.zstdCompressSync(rawDict) : rawDict;
      const header = new Thrift();
      header.struct([
        [1, 'i32', 2],
        [2, 'i32', rawDict.length],
        [3, 'i32', dict.length],
        [
          7,
          'struct',
          [
            [1, 'i32', column.dict.length],
            [2, 'i32', 0],
          ],
        ],
      ]);
      dictionaryOffset = offset;
      pages.push(header.buffer(), dict);
      offset += header.buffer().length + dict.length;
      encoding = 8;
      const indices = column.values.map((v) => column.dict.indexOf(v));
      body = Buffer.concat([Buffer.from([8]), rle(indices, 8).subarray(4)]);
    } else body = plain(column.type, column.values);
    const levels = Buffer.concat([
      column.maxRep ? rle(column.rep, 8) : Buffer.alloc(0),
      column.maxDef ? rle(column.def, 8) : Buffer.alloc(0),
    ]);
    const raw = Buffer.concat([levels, body]);
    const page = codec === 6 ? zlib.zstdCompressSync(raw) : raw;
    const slots = column.maxDef ? column.def.length : column.values.length;
    const header = new Thrift();
    header.struct([
      [1, 'i32', 0],
      [2, 'i32', raw.length],
      [3, 'i32', page.length],
      [
        5,
        'struct',
        [
          [1, 'i32', slots],
          [2, 'i32', encoding],
          [3, 'i32', 3],
          [4, 'i32', 3],
        ],
      ],
    ]);
    const dataOffset = offset;
    pages.push(header.buffer(), page);
    offset += header.buffer().length + page.length;
    parts.push(...pages);
    chunks.push({
      path: pathName,
      type: column.type,
      start,
      size: offset - start,
      slots,
      dataOffset,
      dictionaryOffset,
      encoding,
    });
  }
  const elements = [];
  const walk = (node) => {
    elements.push([
      [1, 'i32', node.children ? undefined : node.type],
      [3, 'i32', node.repetition],
      [4, 'binary', node.name],
      [5, 'i32', node.children?.length],
    ]);
    for (const child of node.children || []) walk(child);
  };
  walk({ name: 'schema', children: schema });
  const meta = new Thrift();
  meta.struct([
    [1, 'i32', 1],
    [2, 'list:struct', elements],
    [3, 'i64', rows],
    [
      4,
      'list:struct',
      [
        [
          [
            1,
            'list:struct',
            chunks.map((chunk) => [
              [2, 'i64', chunk.start],
              [
                3,
                'struct',
                [
                  [1, 'i32', chunk.type],
                  [2, 'list:i32', [0, 3, ...(chunk.encoding ? [8] : [])]],
                  [3, 'list:binary', chunk.path.split('.')],
                  [4, 'i32', codec],
                  [5, 'i64', chunk.slots],
                  [6, 'i64', chunk.size],
                  [7, 'i64', chunk.size],
                  [9, 'i64', chunk.dataOffset],
                  [11, 'i64', chunk.dictionaryOffset],
                ],
              ],
            ]),
          ],
          [2, 'i64', offset],
          [3, 'i64', rows],
        ],
      ],
    ],
  ]);
  const footer = meta.buffer();
  const length = Buffer.alloc(4);
  length.writeUInt32LE(footer.length);
  parts.push(footer, length, Buffer.from('PAR1'));
  fs.writeFileSync(file, Buffer.concat(parts));
}

const BYTES = 6;
const INT32 = 1;
const OPTIONAL = 1;
const REPEATED = 2;
const REQUIRED = 0;
const leaf = (name, type = BYTES, repetition = OPTIONAL) => ({
  name,
  type,
  repetition,
});
const SCHEMA = [
  leaf('geometry'),
  leaf('country'),
  leaf('subtype'),
  leaf('class'),
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
  leaf('wikidata'),
  leaf('region'),
  leaf('population', INT32),
  {
    name: 'cartography',
    repetition: OPTIONAL,
    children: [leaf('prominence', INT32)],
  },
];

const wkbPoint = (lon, lat) => {
  const b = Buffer.alloc(21);
  b[0] = 1;
  b.writeUInt32LE(1, 1);
  b.writeDoubleLE(lon, 5);
  b.writeDoubleLE(lat, 13);
  return b;
};

/** Rows → columns for SCHEMA. */
function divisionsFile(file, rows, codec = 6) {
  const flat = (key, type = BYTES, depth = 1) => {
    const values = [];
    const def = [];
    for (const row of rows) {
      const v = row[key];
      if (v === null || v === undefined)
        def.push(key === 'primary' && !row.names ? 0 : depth - 1);
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
        c.def.push(row.common ? 2 : 1);
        c.rep.push(0);
      }
      continue;
    }
    entries.forEach(([k, v], i) => {
      keys.values.push(k);
      keys.def.push(3);
      keys.rep.push(i ? 1 : 0);
      vals.rep.push(i ? 1 : 0);
      if (v === null) vals.def.push(3);
      else {
        vals.values.push(v);
        vals.def.push(4);
      }
    });
  }
  const subtype = flat('subtype');
  subtype.dict = [...new Set(subtype.values)];
  writeParquet(file, {
    rows: rows.length,
    codec,
    schema: SCHEMA,
    columns: {
      geometry: flat('geometry'),
      country: flat('country'),
      subtype,
      class: flat('class'),
      'names.primary': flat('primary', BYTES, 2),
      'names.common.key_value.key': keys,
      'names.common.key_value.value': vals,
      wikidata: flat('wikidata'),
      region: flat('region'),
      population: flat('population', INT32),
      'cartography.prominence': flat('prominence', INT32, 2),
    },
  });
}

const ROWS = [
  {
    geometry: wkbPoint(-76.61, 39.29),
    country: 'US',
    subtype: 'locality',
    class: 'city',
    primary: 'Baltimore',
    names: true,
    common: { en: 'Baltimore', ru: 'Балтимор', fr: 'Baltimore' },
    wikidata: 'Q5092',
    region: 'US-MD',
    population: 585708,
    prominence: 69,
  },
  {
    geometry: wkbPoint(-76.6, 39.4),
    country: 'US',
    subtype: 'locality',
    class: 'town',
    primary: 'Towson',
    names: true,
    common: {},
    population: 55000,
    prominence: 40,
  },
  {
    geometry: wkbPoint(-76.62, 39.31),
    country: 'US',
    subtype: 'neighborhood',
    primary: 'Remington',
    names: true,
    common: null,
  },
  {
    // A region: not kept.
    geometry: wkbPoint(-76.8, 39.0),
    country: 'US',
    subtype: 'region',
    primary: 'Maryland',
    names: true,
    common: { en: 'Maryland' },
    population: 6_000_000,
  },
  {
    // A county without a population: not kept.
    geometry: wkbPoint(-76.6, 39.45),
    country: 'US',
    subtype: 'county',
    primary: 'Baltimore County',
    names: true,
    common: null,
  },
  {
    geometry: wkbPoint(2.3522, 48.8566),
    country: 'FR',
    subtype: 'locality',
    class: 'city',
    primary: 'Paris',
    names: true,
    common: { en: 'Paris', es: 'París', ru: 'Париж' },
    wikidata: 'Q90',
    region: 'FR-IDF',
    population: 2_100_000,
    prominence: 94,
  },
];

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-overture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the Parquet reader: levels, a map column, a dictionary, zstd', (t) => {
  const file = path.join(tmp(t), 'division.parquet');
  divisionsFile(file, ROWS);
  const parquet = openParquet(file);
  try {
    assert.equal(parquet.rows, ROWS.length);
    assert.equal(parquet.rowGroups[0].columns[0].codec, 'ZSTD');
    const flat = (p) => rowsOfFlat(parquet.column(0, p), parquet.leaf(p));
    assert.deepEqual(
      flat('subtype').map(String),
      ROWS.map((r) => r.subtype),
    );
    assert.deepEqual(
      flat('population'),
      ROWS.map((r) => r.population ?? null),
    );
    assert.deepEqual(
      flat('cartography.prominence'),
      ROWS.map((r) => r.prominence ?? null),
    );
    assert.deepEqual(parquet.leaf('names.common.key_value.value'), {
      path: 'names.common.key_value.value',
      type: 'BYTE_ARRAY',
      typeLength: 0,
      maxDef: 4,
      maxRep: 1,
    });
    const keys = rowsOfRepeated(
      parquet.column(0, 'names.common.key_value.key'),
      {
        ...parquet.leaf('names.common.key_value.key'),
        elementDef: 3,
      },
    );
    assert.deepEqual(
      keys.map((row) => row.map(String)),
      ROWS.map((r) => Object.keys(r.common || {})),
    );
  } finally {
    parquet.close();
  }
});

test('which points are kept, and the zoom each is named from', (t) => {
  assert.equal(overtureKind('locality', 'city').kind, 'city');
  assert.equal(overtureKind('locality', null).kind, 'locality');
  assert.equal(overtureKind('county', null, 0), null);
  assert.equal(overtureKind('localadmin', null, 1200).kind, 'localadmin');
  assert.equal(overtureKind('region', null, 6e6), null);
  assert.equal(overtureKind('country', null, 3e8), null);
  assert.deepEqual([100, 94, 50, 30, 10, 0].map(zoomForProminence), [
    2,
    3,
    9,
    12,
    15,
    OVERTURE_MAX_ZOOM,
  ]);
  // A prominent village comes in with its prominence; a faint city by its class.
  assert.equal(overtureMinZoom({ kind: 'village', prominence: 60 }), 8);
  assert.equal(overtureMinZoom({ kind: 'city', prominence: 10 }), 9);
  // A large neighbourhood sooner than a small one.
  assert.equal(overtureMinZoom({ kind: 'neighborhood' }), 14);
  assert.equal(
    overtureMinZoom({ kind: 'neighborhood', population: 150_000 }),
    12,
  );

  const file = path.join(tmp(t), 'division.parquet');
  divisionsFile(file, ROWS);
  const columns = readDivisions(file);
  assert.equal(columns.read, 6);
  assert.equal(
    columns.lon.length,
    4,
    'the region and the county without people are left out',
  );
  const texts = columns.text.map((text) => text.split('\0'));
  assert.deepEqual(texts[0], [
    'Baltimore',
    '',
    'Балтимор',
    '',
    'Q5092',
    'US-MD',
  ]);
  assert.deepEqual(texts[3], ['Paris', 'París', 'Париж', '', 'Q90', 'FR-IDF']);
  assert.deepEqual(columns.minZoom, [6, 10, 14, 3]);
  assert.deepEqual(columns.bySubtype, { city: 2, town: 1, neighborhood: 1 });
  // A region: Europe only.
  const europe = readDivisions(file, { boxes: regionBoxes('europe').boxes });
  assert.equal(europe.lon.length, 1);
  assert.throws(() => regionBoxes('atlantis'), /unknown region/);
});

test('the bucket listing: only the release’s division files, checked', () => {
  const name =
    'part-00000-8b67a992-99db-52a1-aeb0-1b049a9a125c-c000.zstd.parquet';
  const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>
    <Contents><Key>${DIVISIONS.prefix}${name}</Key><Size>581868458</Size><ETag>&quot;718d-9&quot;</ETag></Contents>
    <Contents><Key>${DIVISIONS.prefix}../../evil.parquet</Key><Size>10</Size></Contents>
    <Contents><Key>release/other/${name}</Key><Size>10</Size></Contents>
  </ListBucketResult>`;
  assert.deepEqual(parseListing(xml), [
    {
      key: `${DIVISIONS.prefix}${name}`,
      name,
      size: 581868458,
      etag: '718d-9',
    },
  ]);
  assert.throws(
    () => parseListing('<IsTruncated>true</IsTruncated>'),
    /truncated/,
  );
});

function grid() {
  // A city, then a field of villages and neighbourhoods around Baltimore.
  const points = [
    {
      lon: -76.61,
      lat: 39.29,
      minZoom: 9,
      prominence: 69,
      kindCode: 1,
      population: 585708,
      country: 'US',
      name: 'Baltimore',
      ru: 'Балтимор',
      wikidata: 'Q5092',
    },
    {
      lon: -76.615,
      lat: 39.295,
      minZoom: 12,
      prominence: 0,
      kindCode: 7,
      population: 850000,
      country: 'US',
      name: 'Baltimore',
    },
  ];
  for (let i = 0; i < 900; i++)
    points.push({
      lon: -76.9 + (i % 30) * 0.02,
      lat: 39.0 + Math.floor(i / 30) * 0.02,
      minZoom: i % 2 ? 13 : 14,
      prominence: i % 2 ? 20 + (i % 7) : 0,
      kindCode: i % 2 ? 3 : 9,
      population: i,
      country: 'US',
      name: `Place ${i}`,
    });
  return points;
}

test('the index: by zoom, the most prominent first, one per name within 5 km, capped', (t) => {
  const dir = tmp(t);
  const written = writeIndex(dir, columnsOf(grid()));
  assert.equal(written.points, 902);
  const index = openIndex(dir, { countries: written.countries });
  t.after(() => index.close());
  const box = { west: -77, south: 38.9, east: -76.2, north: 39.7 };
  const far = index.query({ ...box, zoom: 10, limit: OVERTURE_PLACE_LIMIT });
  assert.deepEqual(
    far.places.map((p) => p.name),
    ['Baltimore'],
  );
  assert.deepEqual(far.places[0], {
    id: far.places[0].id,
    name: 'Baltimore',
    ru: 'Балтимор',
    kind: 'city',
    pop: 585708,
    prominence: 69,
    wikidata: 'Q5092',
    country: 'US',
    at: [-76.61, 39.29],
  });
  // z 12: the county of the same name 600 m away is the same place.
  const z12 = index.query({ ...box, zoom: 12, limit: OVERTURE_PLACE_LIMIT });
  assert.equal(z12.places.filter((p) => p.name === 'Baltimore').length, 1);
  // z 13: the villages, prominent first; z 14 the neighbourhoods too, capped.
  const z13 = index.query({ ...box, zoom: 13, limit: OVERTURE_PLACE_LIMIT });
  assert.equal(z13.places.length, 451);
  assert.ok(z13.places.slice(1).every((p) => p.kind === 'village'));
  const z14 = index.query({ ...box, zoom: 14, limit: 600 });
  assert.equal(z14.places.length, 600);
  assert.equal(z14.saturated, true);
  assert.equal(z14.places.at(-1).kind, 'neighborhood');
  // Outside the box nothing; across the antimeridian no error.
  assert.equal(
    index.query({
      west: 10,
      south: 10,
      east: 11,
      north: 11,
      zoom: 14,
      limit: 10,
    }).places.length,
    0,
  );
  assert.equal(
    index.query({
      west: 179,
      south: -10,
      east: -179,
      north: 10,
      zoom: 14,
      limit: 10,
    }).places.length,
    0,
  );
});

test('the routes: status, a view’s places under a version, bad boxes refused', async (t) => {
  const dir = tmp(t);
  const handler = (service) => {
    const run = createOvertureHandler({ service });
    return async (url) => {
      const res = {
        headers: {},
        statusCode: 0,
        body: '',
        setHeader(k, v) {
          this.headers[k.toLowerCase()] = v;
        },
        end(b) {
          this.body = String(b ?? '');
        },
      };
      await run({ method: 'GET', url, headers: { host: 'localhost' } }, res);
      return {
        status: res.statusCode,
        cache: res.headers['cache-control'],
        json: JSON.parse(res.body || 'null'),
      };
    };
  };
  const service = createOvertureService({ dir });
  const get = handler(service);
  const before = await get('/layers');
  assert.equal(before.json.configured, false);
  assert.match(before.json.message, /npm run overture:build/);
  assert.equal(
    (await get('/divisions?west=-77&south=39&east=-76&north=40&zoom=12'))
      .status,
    503,
  );

  const buildId = 'abcdef012345';
  const build = path.join(dir, 'build', buildId);
  const written = writeIndex(build, columnsOf(grid()));
  fs.writeFileSync(
    path.join(build, 'manifest.json'),
    JSON.stringify({
      buildId,
      release: '2026-09-23.1',
      points: written.points,
      countries: written.countries,
      regions: ['world'],
      attribution: '© OpenStreetMap contributors, Overture Maps Foundation',
      license: 'ODbL 1.0',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'build', 'current.json'),
    JSON.stringify({ buildId }),
  );
  const fresh = handler(createOvertureService({ dir }));
  const status = await fresh('/layers');
  assert.equal(status.json.configured, true);
  assert.equal(status.json.version, overtureVersion(buildId));
  assert.equal(status.json.places, 902);
  const v = status.json.version;
  const answer = await fresh(
    `/divisions?west=-77&south=38.9&east=-76.2&north=39.7&zoom=10&v=${v}`,
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.cache, 'private, max-age=86400');
  assert.deepEqual(
    answer.json.places.map((p) => p.name),
    ['Baltimore'],
  );
  const stale = await fresh(
    '/divisions?west=-77&south=38.9&east=-76.2&north=39.7&zoom=10&v=000000000000',
  );
  assert.equal(stale.cache, 'no-store');
  for (const bad of [
    'west=-77&south=39&east=-76&north=40',
    'west=-100&south=30&east=-70&north=40&zoom=8',
    'west=-77&south=40&east=-76&north=39&zoom=8',
    'west=x&south=39&east=-76&north=40&zoom=8',
  ])
    assert.equal((await fresh(`/divisions?${bad}`)).status, 400, bad);
  assert.deepEqual(
    parseDivisionsQuery(
      new URLSearchParams('west=179&south=0&east=-179&north=1&zoom=13.6'),
    ),
    { west: 179, south: 0, east: -179, north: 1, zoom: 13 },
  );
});
