// Personal fork: the HydroSHEDS v2 rivers build (scripts/rivers/): the ZIP,
// File Geodatabase and GeoPackage/WKB readers on tiny synthetic fixtures,
// band thinning and simplification, and a whole build served as tiles.
// The real data (4.8 GB) is never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import {
  listZipEntries,
  openZipEntry,
  readZipEntry,
} from '../../scripts/rivers/zip.mjs';
import {
  FIELD_TYPES,
  decodePolyline,
  forEachRow,
  liveRowOffsets,
  parseTableHeader,
  readVarInt,
  readVarUint,
  rowIdsByOffset,
} from '../../scripts/rivers/fileGdb.mjs';
import {
  decodeWkbLines,
  forEachGeoPackageReach,
  parseGpkgHeader,
} from '../../scripts/rivers/geopackage.mjs';
import {
  findRiverInputs,
  forEachReach,
  gdbCatalog,
  streamsTable,
} from '../../scripts/rivers/sources.mjs';
import {
  encodedReachPieces,
  marginUnits,
  projectPart,
  quantize,
  simplify,
  splitIntoCells,
  toleranceFor,
} from '../../scripts/rivers/levels.mjs';
import {
  buildSignature,
  fetchDownloads,
  runBuild,
} from '../../scripts/rivers/build.mjs';
import { parseArgs, riversDir, statusOf } from '../../scripts/rivers/index.mjs';
import {
  BANDS,
  bandForZoom,
  quantBitsFor,
} from '../../server/providers/riversV2/bands.js';
import { decodeCell } from '../../server/providers/riversV2/levelFile.js';
import { worldX, worldY } from '../../server/providers/riversV2/tileMath.js';
import { createRiversV2Service } from '../../server/providers/riversV2.js';

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-rivbuild-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

// --- fixtures ---------------------------------------------------------------

/**
 * A ZIP of { name: Buffer } entries, deflated or stored, written the ZIP64
 * way (sizes and offsets in the ZIP64 extra field, a ZIP64 end record), as
 * HydroSHEDS' multi-gigabyte archives are.
 */
function writeZip(file, entries, { zip64 = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, method = 8] of entries) {
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zip64 ? 0xffffffff : stored.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, stored);
    const extra = Buffer.alloc(zip64 ? 28 : 0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(stored.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : stored.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, nameBytes, extra);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, ...tail, end]));
}

const varuint = (value) => {
  const out = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};

/** FileGDB's signed varint: sign in bit 6 of the first byte. */
const varint = (value) => {
  let rest = Math.abs(value);
  const first = (rest % 64) | (value < 0 ? 0x40 : 0);
  rest = Math.floor(rest / 64);
  const out = [first | (rest ? 0x80 : 0)];
  while (rest) {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(byte | (rest ? 0x80 : 0));
  }
  return out;
};

const utf16Name = (name) =>
  Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'utf16le')]);

const GEOMETRY = { xOrigin: -400, yOrigin: -400, xyScale: 1e9 };

/** A polyline shape blob (type 3), parts of [lon, lat, …]. */
function polylineBlob(parts) {
  const scale = GEOMETRY.xyScale;
  const all = parts.flat();
  const xs = all
    .filter((_, i) => i % 2 === 0)
    .map((x) => Math.round((x - GEOMETRY.xOrigin) * scale));
  const ys = all
    .filter((_, i) => i % 2 === 1)
    .map((y) => Math.round((y - GEOMETRY.yOrigin) * scale));
  const bytes = [3, ...varuint(xs.length), ...varuint(parts.length)];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  bytes.push(
    ...varuint(minX),
    ...varuint(minY),
    ...varuint(Math.max(...xs) - minX),
    ...varuint(Math.max(...ys) - minY),
  );
  for (const part of parts.slice(0, -1))
    bytes.push(...varuint(part.length / 2));
  let px = 0;
  let py = 0;
  for (let i = 0; i < xs.length; i++) {
    bytes.push(...varint(xs[i] - px), ...varint(ys[i] - py));
    px = xs[i];
    py = ys[i];
  }
  return Buffer.from(bytes);
}

/**
 * A version-3 .gdbtable in the layout of HydroSHEDS' RIV_STREAMS (an
 * OBJECTID, a polyline Shape with Z and M flags, integer, string, double
 * and int16 fields, all nullable), with rows, a deleted row, and a
 * matching .gdbtablx.
 */
function writeGdbTable(rows, { deletedAfter = 0, hole = false } = {}) {
  const fields = [
    ['OBJECTID', FIELD_TYPES.OBJECTID],
    ['Shape', FIELD_TYPES.GEOMETRY],
    ['STRM_ID', FIELD_TYPES.INT32],
    ['STRM_UP', FIELD_TYPES.STRING],
    ['LENGTH_KM', FIELD_TYPES.FLOAT64],
    ['UPLAND_SKM', FIELD_TYPES.FLOAT64],
    ['ORD_STRAH', FIELD_TYPES.INT16],
  ];
  const parts = [];
  const u32 = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
  };
  const f64 = (value) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value);
    return b;
  };
  for (const [name, type] of fields) {
    parts.push(utf16Name(name), Buffer.from([0, type]));
    if (type === FIELD_TYPES.OBJECTID) parts.push(Buffer.from([4, 2]));
    else if (type === FIELD_TYPES.GEOMETRY) {
      const wkt = Buffer.from('GEOGCS["GCS_WGS_1984"]', 'utf16le');
      const length = Buffer.alloc(2);
      length.writeUInt16LE(wkt.length);
      parts.push(Buffer.from([0, 7]), length, wkt, Buffer.from([7]));
      for (const value of [
        -400, -400, 1e9, -100000, 10000, -100000, 10000, 8.98e-9, 0.001, 0.001,
        -70, -20, -50, 10,
      ])
        parts.push(f64(value));
      parts.push(Buffer.from([0, 1, 0, 0, 0]), f64(0.5));
    } else if (type === FIELD_TYPES.STRING)
      parts.push(u32(1000), Buffer.from([5, 0]));
    else
      parts.push(
        Buffer.from([
          type === FIELD_TYPES.INT16 ? 2 : type === FIELD_TYPES.INT32 ? 4 : 8,
          5,
          0,
        ]),
      );
  }
  const fieldBody = Buffer.concat([
    u32(4),
    u32(3),
    Buffer.from([fields.length, 0]),
    ...parts,
  ]);
  const fieldSection = Buffer.concat([u32(fieldBody.length), fieldBody]);
  const rowBuffers = [];
  for (const row of rows) {
    const nulls = Buffer.alloc(1);
    const values = [];
    // Nullable fields, in order: Shape 0, STRM_ID 1, STRM_UP 2, LENGTH_KM 3, UPLAND_SKM 4, ORD_STRAH 5.
    const blob = row.parts ? polylineBlob(row.parts) : null;
    if (blob) values.push(Buffer.from(varuint(blob.length)), blob);
    else nulls[0] |= 1;
    const id = Buffer.alloc(4);
    id.writeInt32LE(row.id);
    values.push(id);
    const up = Buffer.from(row.up ?? '');
    values.push(Buffer.from(varuint(up.length)), up);
    values.push(f64(row.lengthKm ?? 1));
    values.push(f64(row.upland));
    if (row.strahler === null) nulls[0] |= 32;
    else {
      const order = Buffer.alloc(2);
      order.writeInt16LE(row.strahler ?? 1);
      values.push(order);
    }
    const body = Buffer.concat([nulls, ...values]);
    rowBuffers.push(Buffer.concat([u32(body.length), body]));
  }
  // A deleted row: negated size, then that many (junk) bytes.
  const deleted = Buffer.alloc(4 + 9, 0xee);
  deleted.writeInt32LE(-9, 0);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(3, 0);
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(Math.max(...rowBuffers.map((b) => b.length)), 8);
  header.writeUInt32LE(5, 12);
  header.writeBigUInt64LE(40n, 32);
  const offsets = [];
  let at = 40 + fieldSection.length;
  const body = [];
  if (hole) {
    // A freed block whose size does not chain (as in the real
    // north_america_RIV_STREAMS_1s_v2r0_1): -44, then 48 bytes.
    const freed = Buffer.alloc(52, 0x41);
    freed.writeInt32LE(-44, 0);
    body.push(freed);
    at += freed.length;
  }
  rowBuffers.forEach((buffer, index) => {
    if (index === deletedAfter && deletedAfter) {
      body.push(deleted);
      at += deleted.length;
    }
    offsets.push(at);
    body.push(buffer);
    at += buffer.length;
  });
  header.writeBigUInt64LE(BigInt(at), 24);
  const table = Buffer.concat([header, fieldSection, ...body]);
  const tablx = Buffer.alloc(16 + 1024 * 5);
  tablx.writeUInt32LE(3, 0);
  tablx.writeUInt32LE(1, 4);
  tablx.writeUInt32LE(rows.length + 1, 8);
  tablx.writeUInt32LE(5, 12);
  // Row id 1 deleted (offset 0), the rows from id 2.
  offsets.forEach((offset, index) =>
    tablx.writeUIntLE(offset, 16 + (index + 1) * 5, 5),
  );
  return { table, tablx };
}

/** A minimal system catalog naming one stream table as row id 3. */
function writeCatalog(streamsName) {
  const names = ['GDB_SystemCatalog', 'GDB_DBTune', streamsName];
  const u32 = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
  };
  const fieldBody = Buffer.concat([
    u32(4),
    u32(0),
    Buffer.from([3, 0]),
    utf16Name('ID'),
    Buffer.from([0, FIELD_TYPES.OBJECTID, 4, 2]),
    utf16Name('Name'),
    Buffer.from([0, FIELD_TYPES.STRING]),
    u32(160),
    Buffer.from([4, 0]),
    utf16Name('FileFormat'),
    Buffer.from([0, FIELD_TYPES.INT32, 4, 4, 0]),
  ]);
  const fieldSection = Buffer.concat([u32(fieldBody.length), fieldBody]);
  // Rows written in reverse id order: the tablx maps them back.
  const rows = names.map((name, index) => {
    const bytes = Buffer.from(name);
    const body = Buffer.concat([
      Buffer.from(varuint(bytes.length)),
      bytes,
      u32(index === 1 ? 2 : 0),
    ]);
    return Buffer.concat([u32(body.length), body]);
  });
  const order = [2, 1, 0];
  const header = Buffer.alloc(40);
  header.writeUInt32LE(3, 0);
  header.writeUInt32LE(names.length, 4);
  header.writeBigUInt64LE(40n, 32);
  const tablx = Buffer.alloc(16 + 1024 * 5);
  tablx.writeUInt32LE(3, 0);
  tablx.writeUInt32LE(1, 4);
  tablx.writeUInt32LE(names.length, 8);
  tablx.writeUInt32LE(5, 12);
  let at = 40 + fieldSection.length;
  const body = [];
  for (const index of order) {
    tablx.writeUIntLE(at, 16 + index * 5, 5);
    body.push(rows[index]);
    at += rows[index].length;
  }
  return { table: Buffer.concat([header, fieldSection, ...body]), tablx };
}

/** Synthetic reaches: a big river along 1°N with a tributary and a creek. */
const REACHES = [
  {
    id: 1,
    upland: 2_500_000,
    strahler: 9,
    lengthKm: 900,
    parts: [[-60, 1, -57, 1.2, -55, 1]],
  },
  {
    id: 2,
    upland: 12_000,
    strahler: 5,
    lengthKm: 120,
    parts: [[-57, 1.2, -57.5, 3]],
  },
  {
    id: 3,
    upland: 2.5,
    strahler: 1,
    lengthKm: 1.2,
    parts: [
      [-57.5, 3, -57.51, 3.01],
      [-57.6, 3.1, -57.61, 3.12],
    ],
  },
  {
    id: 4,
    upland: 40,
    strahler: null,
    lengthKm: 3,
    parts: [[-56, 2, -56.02, 2.03]],
  },
];

function writeGdbZip(file, rows = REACHES) {
  const name = 'test_RIV_STREAMS_1s_v2r0';
  const catalog = writeCatalog(name);
  const streams = writeGdbTable(rows, { deletedAfter: 1 });
  writeZip(file, [
    ['test_RIV_1s_v2r0.gdb/a00000001.gdbtable', catalog.table],
    ['test_RIV_1s_v2r0.gdb/a00000001.gdbtablx', catalog.tablx, 0],
    ['test_RIV_1s_v2r0.gdb/a00000003.gdbtable', streams.table],
    ['test_RIV_1s_v2r0.gdb/a00000003.gdbtablx', streams.tablx],
    ['test_RIV_1s_v2r0.gdb/gdb', Buffer.from([5, 0, 0, 0])],
  ]);
  return streams;
}

/** A GeoPackage geometry: GP header (little-endian, XY envelope) + WKB. */
function gpkgBlob(wkb, { bigEndianHeader = false } = {}) {
  const header = Buffer.alloc(8 + 32);
  header.write('GP', 0, 'latin1');
  header[2] = 0;
  header[3] = bigEndianHeader ? 0b010 : 0b011;
  if (bigEndianHeader) header.writeInt32BE(4326, 4);
  else header.writeInt32LE(4326, 4);
  return Buffer.concat([header, wkb]);
}

function wkbLine(coords, { type = 2, little = true, dims = 2 } = {}) {
  const count = coords.length / 2;
  const out = Buffer.alloc(9 + count * dims * 8);
  out[0] = little ? 1 : 0;
  const u32 = little
    ? out.writeUInt32LE.bind(out)
    : out.writeUInt32BE.bind(out);
  const f64 = little
    ? out.writeDoubleLE.bind(out)
    : out.writeDoubleBE.bind(out);
  u32(type, 1);
  u32(count, 5);
  for (let i = 0; i < count; i++) {
    f64(coords[i * 2], 9 + i * dims * 8);
    f64(coords[i * 2 + 1], 9 + i * dims * 8 + 8);
    if (dims === 3) f64(123, 9 + i * dims * 8 + 16);
  }
  return out;
}

function wkbMultiLine(lines) {
  const head = Buffer.alloc(9);
  head[0] = 1;
  head.writeUInt32LE(5, 1);
  head.writeUInt32LE(lines.length, 5);
  return Buffer.concat([head, ...lines.map((line) => wkbLine(line))]);
}

async function writeGeoPackage(file, reaches = REACHES) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
    CREATE TABLE test_RIV_STREAMS_1s_v2r0 (fid INTEGER PRIMARY KEY, geom BLOB, STRM_ID INTEGER, UPLAND_SKM REAL, ORD_STRAH INTEGER, LENGTH_KM REAL);
    INSERT INTO gpkg_contents VALUES ('test_RIV_STREAMS_1s_v2r0', 'features', -61, 0, -55, 4);
    INSERT INTO gpkg_geometry_columns VALUES ('test_RIV_STREAMS_1s_v2r0', 'geom', 'MULTILINESTRING', 4326, 0, 0);
  `);
  const insert = db.prepare(
    'INSERT INTO test_RIV_STREAMS_1s_v2r0 (geom, STRM_ID, UPLAND_SKM, ORD_STRAH, LENGTH_KM) VALUES (?, ?, ?, ?, ?)',
  );
  for (const reach of reaches)
    insert.run(
      gpkgBlob(
        reach.parts.length > 1
          ? wkbMultiLine(reach.parts)
          : wkbLine(reach.parts[0]),
      ),
      reach.id,
      reach.upland,
      reach.strahler,
      reach.lengthKm,
    );
  db.close();
}

// --- ZIP --------------------------------------------------------------------

test('the ZIP reader lists ZIP64 entries and streams stored and deflated ones', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'a.zip');
  const big = Buffer.alloc(300_000, 7);
  writeZip(file, [
    ['x/deflated.bin', big],
    ['x/stored.txt', Buffer.from('hello'), 0],
  ]);
  const entries = listZipEntries(file);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.method, entry.size]),
    [
      ['x/deflated.bin', 8, 300_000],
      ['x/stored.txt', 0, 5],
    ],
  );
  assert.ok(entries[0].compressedSize < 2000);
  assert.deepEqual(await readZipEntry(file, entries[0]), big);
  assert.equal((await readZipEntry(file, entries[1])).toString(), 'hello');
  await assert.rejects(
    readZipEntry(file, entries[0], { maxBytes: 10 }),
    /too large/,
  );
  const plain = path.join(root, 'b.zip');
  writeZip(plain, [['one', Buffer.from('1')]], { zip64: false });
  assert.equal(listZipEntries(plain)[0].size, 1);
  fs.writeFileSync(path.join(root, 'c.zip'), 'nope');
  assert.throws(() => listZipEntries(path.join(root, 'c.zip')), /not a ZIP/);
});

// --- File Geodatabase -------------------------------------------------------

test('FileGDB varints keep values past 32 bits and carry the sign', () => {
  const state = { at: 0 };
  const big = 3_500_000_000_000_000;
  assert.equal(readVarUint(Buffer.from(varuint(big)), state), big);
  for (const value of [0, 1, -1, 63, -63, 64, -64, 1e12, -1e12]) {
    const s = { at: 0 };
    assert.equal(
      readVarInt(Buffer.from(varint(value)), s),
      value,
      String(value),
    );
  }
});

test('a gdbtable header gives the fields, nullability and geometry grid', () => {
  const { table } = writeGdbTable(REACHES);
  const header = parseTableHeader(table);
  assert.equal(header.rows, REACHES.length);
  assert.deepEqual(
    header.fields.map((field) => [field.name, field.type, field.nullable]),
    [
      ['OBJECTID', 6, false],
      ['Shape', 7, true],
      ['STRM_ID', 1, true],
      ['STRM_UP', 4, true],
      ['LENGTH_KM', 3, true],
      ['UPLAND_SKM', 3, true],
      ['ORD_STRAH', 0, true],
    ],
  );
  assert.equal(header.nullableCount, 6);
  assert.equal(header.geometry.field, 'Shape');
  assert.equal(header.geometry.hasZ, true);
  assert.equal(header.geometry.xyScale, 1e9);
  assert.deepEqual(header.geometry.extent, {
    xmin: -70,
    ymin: -20,
    xmax: -50,
    ymax: 10,
  });
  const v4 = Buffer.from(table);
  v4.writeUInt32LE(4, 0);
  assert.throws(() => parseTableHeader(v4), /version 4/);
});

test('rows stream in any chunking, skip deleted rows and decode polylines', async () => {
  const { table } = writeGdbTable(REACHES, { deletedAfter: 2 });
  for (const chunkSize of [7, 64, table.length]) {
    const chunks = [];
    for (let at = 0; at < table.length; at += chunkSize)
      chunks.push(table.subarray(at, at + chunkSize));
    const seen = [];
    const result = await forEachRow(
      Readable.from(chunks),
      (values, header, offset) => {
        seen.push({
          values,
          parts: decodePolyline(values.Shape, header.geometry),
          offset,
        });
      },
    );
    assert.equal(result.rows, REACHES.length, `chunks of ${chunkSize}`);
    assert.equal(result.deleted, 1);
    assert.deepEqual(
      seen.map((row) => row.values.STRM_ID),
      [1, 2, 3, 4],
    );
    assert.equal(seen[3].values.ORD_STRAH, null, 'a null by the bitmap');
    assert.equal(seen[0].values.UPLAND_SKM, 2_500_000);
    assert.equal(seen[2].parts.length, 2, 'two parts');
    for (const [index, reach] of REACHES.entries())
      reach.parts.forEach((part, p) =>
        part.forEach((value, i) =>
          assert.ok(
            Math.abs(seen[index].parts[p][i] - value) < 1e-8,
            `${index}.${p}.${i}`,
          ),
        ),
      );
  }
  let stoppedAt = 0;
  const stopped = await forEachRow(
    Readable.from([table]),
    () => ++stoppedAt < 2,
  );
  assert.equal(stopped.stopped, true);
  assert.equal(stoppedAt, 2);
  // A header claiming more rows than there are fails loudly.
  const lying = Buffer.from(table);
  lying.writeUInt32LE(REACHES.length + 1, 4);
  await assert.rejects(
    forEachRow(Readable.from([lying]), () => {}),
    /header says 5 rows, 4 were read/,
  );
});

test('the tablx maps file offsets to row ids', () => {
  const { tablx } = writeGdbTable(REACHES);
  const ids = rowIdsByOffset(tablx);
  assert.equal(ids.size, REACHES.length);
  assert.deepEqual([...ids.values()], [2, 3, 4, 5]);
  const offsets = liveRowOffsets(tablx);
  assert.deepEqual(
    [...offsets],
    [...ids.keys()].sort((a, b) => a - b),
  );
});

test('with the tablx, rows are read past freed blocks that do not chain', async () => {
  const { table, tablx } = writeGdbTable(REACHES, {
    hole: true,
    deletedAfter: 2,
  });
  await assert.rejects(forEachRow(Readable.from([table]), () => {}));
  const offsets = liveRowOffsets(tablx);
  for (const chunkSize of [5, 33, table.length]) {
    const chunks = [];
    for (let at = 0; at < table.length; at += chunkSize)
      chunks.push(table.subarray(at, at + chunkSize));
    const ids = [];
    const result = await forEachRow(
      Readable.from(chunks),
      (values) => ids.push(values.STRM_ID),
      { offsets },
    );
    assert.deepEqual(ids, [1, 2, 3, 4], `chunks of ${chunkSize}`);
    assert.equal(result.rows, 4);
  }
  // A limit stops early either way.
  const some = await forEachRow(Readable.from([table]), () => false, {
    offsets,
  });
  assert.equal(some.stopped, true);
  assert.equal(some.rows, 1);
});

test('the canonical stream table wins over an edited copy', () => {
  const entry = { name: 'x' };
  assert.equal(
    streamsTable([
      { id: 17, name: 'north_america_RIV_STREAMS_1s_v2r0_1', entry },
      { id: 18, name: 'north_america_RIV_NODES_1s_v2r0', entry },
      { id: 19, name: 'north_america_RIV_STREAMS_1s_v2r0', entry },
    ]).id,
    19,
  );
  assert.equal(streamsTable([{ id: 3, name: 'a_RIV_STREAMS_x', entry }]).id, 3);
  assert.equal(
    streamsTable([{ id: 3, name: 'a_RIV_NODES_1s_v2r0', entry }]),
    null,
  );
});

test('a zipped geodatabase is found through its catalog and read reach by reach', async (t) => {
  const root = await tempRoot(t);
  const raw = path.join(root, 'raw');
  fs.mkdirSync(path.join(raw, 'test-riv-gdb'), { recursive: true });
  const file = path.join(raw, 'test-riv-gdb', 'test_RIV_1s_v2r0.gdb.zip');
  writeGdbZip(file);
  const catalog = await gdbCatalog(file);
  assert.deepEqual(
    catalog.map((table) => [table.id, table.name, table.entry?.name ?? null]),
    [
      [1, 'GDB_SystemCatalog', 'test_RIV_1s_v2r0.gdb/a00000001.gdbtable'],
      [
        3,
        'test_RIV_STREAMS_1s_v2r0',
        'test_RIV_1s_v2r0.gdb/a00000003.gdbtable',
      ],
    ],
    'the FileFormat 2 table is left out; ids follow the tablx, not file order',
  );
  const inputs = findRiverInputs(raw);
  assert.deepEqual(
    inputs.map((input) => [input.region, input.kind]),
    [['test', 'gdb-zip']],
  );
  const reaches = [];
  const result = await forEachReach(inputs[0], (reach) => reaches.push(reach));
  assert.equal(result.table, 'test_RIV_STREAMS_1s_v2r0');
  assert.equal(result.rows, 4);
  assert.deepEqual(
    reaches.map((reach) => reach.upland),
    [2_500_000, 12_000, 2.5, 40],
  );
  assert.equal(reaches[0].strahler, 9);
});

// --- GeoPackage and WKB -----------------------------------------------------

test('GeoPackage headers and WKB lines decode, Z and big-endian included', () => {
  const little = gpkgBlob(wkbLine([1, 2, 3, 4]));
  const header = parseGpkgHeader(little);
  assert.deepEqual(header, { wkbStart: 40, srsId: 4326, empty: false });
  assert.deepEqual(
    decodeWkbLines(little, header.wkbStart).map((p) => [...p]),
    [[1, 2, 3, 4]],
  );
  assert.equal(
    parseGpkgHeader(gpkgBlob(wkbLine([0, 0, 1, 1]), { bigEndianHeader: true }))
      .srsId,
    4326,
  );
  const big = wkbLine([5, 6, 7, 8], { little: false });
  assert.deepEqual(
    decodeWkbLines(big).map((p) => [...p]),
    [[5, 6, 7, 8]],
  );
  const z = wkbLine([1, 1, 2, 2], { type: 1002, dims: 3 });
  assert.deepEqual(
    decodeWkbLines(z).map((p) => [...p]),
    [[1, 1, 2, 2]],
    'ISO Z skips z',
  );
  const multi = wkbMultiLine([
    [0, 0, 1, 1],
    [2, 2, 3, 3],
  ]);
  assert.equal(decodeWkbLines(multi).length, 2);
  assert.throws(() => parseGpkgHeader(Buffer.from('nope----')), /GP magic/);
});

test('a river GeoPackage reads to the same reaches as the geodatabase', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'test_RIV_1s_v2r0.gpkg');
  await writeGeoPackage(file);
  const reaches = [];
  const result = await forEachGeoPackageReach(file, (reach) =>
    reaches.push(reach),
  );
  assert.equal(result.table, 'test_RIV_STREAMS_1s_v2r0');
  assert.equal(result.rows, 4);
  assert.deepEqual(result.extent, { xmin: -61, ymin: 0, xmax: -55, ymax: 4 });
  assert.deepEqual(
    reaches.map((reach) => reach.upland),
    [2_500_000, 12_000, 2.5, 40],
  );
  assert.equal(reaches[2].parts.length, 2);
  assert.deepEqual([...reaches[0].parts[0]], REACHES[0].parts[0]);
  assert.equal(reaches[3].strahler, null);
});

// --- thinning, simplification, cells ----------------------------------------

test('each band holds only the orders it draws', () => {
  const byBand = new Map(BANDS.map((band) => [band.level, new Set()]));
  for (const reach of REACHES)
    encodedReachPieces(
      { ...reach, parts: reach.parts.map((part) => new Float64Array(part)) },
      (band, cx, cy, bytes) => {
        const cellUnits = 2 ** (quantBitsFor(band) - band.gridZoom);
        decodeCell(bytes, cx * cellUnits, cy * cellUnits, (order) =>
          byBand.get(band.level).add(order),
        );
      },
    );
  // Orders: 2 (2.5 M km²), 4 (12,000), 6 (40 km² → 7), 8 (2.5 km²).
  assert.deepEqual([...byBand.get('z0')].sort(), [2]);
  assert.deepEqual([...byBand.get('z3')].sort(), [2, 4]);
  assert.deepEqual([...byBand.get('z7')].sort(), [2, 4]);
  assert.deepEqual([...byBand.get('z9')].sort(), [2, 4, 7]);
  assert.deepEqual([...byBand.get('z11')].sort(), [2, 4, 7, 8]);
});

test('Douglas–Peucker keeps the ends and anything past the tolerance', () => {
  const wobble = new Float64Array([0, 0, 1, 0.01, 2, -0.01, 3, 0]);
  assert.deepEqual([...simplify(wobble, 0.1)], [1, 0, 0, 1]);
  assert.deepEqual([...simplify(wobble, 0.005)], [1, 1, 1, 1]);
  const spike = new Float64Array([0, 0, 1, 0, 2, 3, 3, 0, 4, 0]);
  assert.deepEqual([...simplify(spike, 5)], [1, 0, 0, 0, 1]);
  assert.equal(simplify(spike, 0.1)[2], 1, 'the spike stays');
  const loop = new Float64Array([0, 0, 1, 0, 0, 0]);
  assert.deepEqual(
    [...simplify(loop, 0.5)],
    [1, 1, 1],
    'a closed line keeps its far point',
  );
  assert.deepEqual([...simplify(new Float64Array([1, 1, 1, 1]), 1)], [1, 1]);
  const band = bandForZoom(0);
  assert.equal(toleranceFor(band), 0.5 / (256 * 4));
});

test('quantizing drops repeats and lines shorter than a unit', () => {
  const points = new Float64Array([0.1, 0.1, 0.1000001, 0.1, 0.2, 0.2]);
  assert.deepEqual(
    quantize(points, new Uint8Array([1, 1, 1]), 8),
    [26, 26, 51, 51],
  );
  assert.equal(
    quantize(
      new Float64Array([0.5, 0.5, 0.5001, 0.5]),
      new Uint8Array([1, 1]),
      8,
    ),
    null,
  );
  const projected = projectPart(new Float64Array([-180, 0, 0, 0]));
  assert.deepEqual([...projected], [0, 0.5, 0.5, 0.5]);
});

test('a line is cut into the cells its segments touch, sharing edge segments', () => {
  const runs = [];
  splitIntoCells([10, 10, 20, 20], 6, (cx, cy, run) =>
    runs.push([cx, cy, run]),
  );
  assert.deepEqual(runs, [[0, 0, [10, 10, 20, 20]]], 'one cell, as is');
  const cut = [];
  splitIntoCells([10, 10, 50, 10, 70, 10, 80, 10, 130, 10], 6, (cx, cy, run) =>
    cut.push([cx, cy, run]),
  );
  assert.deepEqual(cut, [
    [0, 0, [10, 10, 50, 10, 70, 10]],
    [1, 0, [50, 10, 70, 10, 80, 10, 130, 10]],
    [2, 0, [80, 10, 130, 10]],
  ]);
  // With a margin, a line just inside a cell edge also goes to the neighbour.
  const near = [];
  splitIntoCells([10, 60, 50, 60], 6, (cx, cy, run) => near.push([cx, cy]), 8);
  assert.deepEqual(near, [
    [0, 0],
    [0, 1],
  ]);
  const far = [];
  splitIntoCells([10, 30, 50, 30], 6, (cx, cy) => far.push([cx, cy]), 8);
  assert.deepEqual(far, [[0, 0]]);
  // The margin is half the widest line plus a pixel at the band's shallowest zoom.
  const band = bandForZoom(5);
  assert.equal(
    marginUnits(band),
    Math.ceil((3 / 256) * 2 ** (quantBitsFor(band) - 5)),
  );
});

// --- the whole build ---------------------------------------------------------

test('a build from a zipped geodatabase serves its rivers as tiles', async (t) => {
  const root = await tempRoot(t);
  const raw = path.join(root, 'raw', 'test-riv-gdb');
  fs.mkdirSync(raw, { recursive: true });
  writeGdbZip(path.join(raw, 'test_RIV_1s_v2r0.gdb.zip'));
  const lines = [];
  const { manifest } = await runBuild({
    cacheDir: root,
    log: (line) => lines.push(line),
  });
  assert.equal(manifest.reaches, 4);
  assert.equal(manifest.sources[0].complete, true);
  assert.deepEqual(
    manifest.levels.map((level) => level.level),
    BANDS.map((band) => band.level),
  );
  assert.ok(manifest.extent.west <= -60 && manifest.extent.north >= 3.1);
  assert.equal(manifest.byOrder.find((entry) => entry.order === 2).reaches, 1);
  assert.ok(fs.existsSync(path.join(root, 'v2', 'manifest.json')));
  assert.equal(
    fs
      .readdirSync(path.join(root, 'v2'))
      .filter((name) => name.startsWith('tmp-')).length,
    0,
    'temporary files removed',
  );

  const status = statusOf(root);
  assert.equal(status.built, true);
  assert.equal(status.reaches, 4);
  assert.match(status.versions.light, /^[0-9a-f]{12}$/);

  // Unchanged inputs: skipped; --force: rebuilt into a new folder, the old one gone.
  assert.equal((await runBuild({ cacheDir: root })).skipped, true);
  const again = await runBuild({
    cacheDir: root,
    force: true,
    now: () => Date.now() + 1000,
  });
  assert.notEqual(again.manifest.buildId, manifest.buildId);
  const folders = fs
    .readdirSync(path.join(root, 'v2'))
    .filter((name) => name.startsWith('levels-'));
  assert.equal(folders.length, 1);

  const service = createRiversV2Service({ dir: path.join(root, 'v2') });
  const z = 7;
  const tile = await service.tile(
    'light',
    z,
    Math.floor(worldX(-58) * 2 ** z),
    Math.floor(worldY(1.1) * 2 ** z),
  );
  assert.equal(tile.status, 200);
  assert.equal(tile.empty, undefined, 'the main river is drawn');
  const far = await service.tile('light', 7, 10, 40);
  assert.equal(far.empty, true);
});

test('a GeoPackage stands in for a region, and --limit builds a sample', async (t) => {
  const root = await tempRoot(t);
  const raw = path.join(root, 'raw', 'test-riv-gpkg');
  fs.mkdirSync(raw, { recursive: true });
  await writeGeoPackage(path.join(raw, 'test_RIV_1s_v2r0.gpkg'));
  const { manifest } = await runBuild({ cacheDir: root, limit: 2 });
  assert.equal(manifest.reaches, 2);
  assert.equal(manifest.sources[0].kind, 'gpkg');
  assert.equal(manifest.sources[0].complete, false);
  // A partial build never counts as up to date.
  assert.equal((await runBuild({ cacheDir: root })).skipped, false);
  await assert.rejects(
    runBuild({ cacheDir: path.join(root, 'empty') }),
    /rivers:fetch/,
  );
});

test('signature, fetch skipping and the command line', async (t) => {
  const root = await tempRoot(t);
  const signature = buildSignature([
    { region: 'r', file: '/x/r_RIV_a.gdb.zip', kind: 'gdb-zip', bytes: 5 },
  ]);
  assert.deepEqual(signature.inputs, [
    { region: 'r', name: 'r_RIV_a.gdb.zip', kind: 'gdb-zip', bytes: 5 },
  ]);
  const dir = path.join(root, 'raw', 'r-riv-gdb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'r_RIV.gdb.zip'), 'abc');
  const calls = [];
  const fetched = await fetchDownloads({
    rawDir: path.join(root, 'raw'),
    downloads: [
      {
        dir: 'r-riv-gdb',
        file: 'r_RIV.gdb.zip',
        url: 'https://example.test/a',
        bytes: 3,
      },
      {
        dir: 's-riv-gdb',
        file: 's_RIV.gdb.zip',
        url: 'https://example.test/b',
        bytes: 4,
      },
    ],
    fetchImpl: async (url, options) => {
      calls.push([url, options.headers['User-Agent']]);
      return new Response('wxyz');
    },
  });
  assert.deepEqual(fetched, ['s_RIV.gdb.zip']);
  assert.equal(calls.length, 1, 'a file at its size is not fetched again');
  assert.match(calls[0][1], /gods-eye-view-personal-fork/);
  assert.equal(
    fs.readFileSync(
      path.join(root, 'raw', 's-riv-gdb', 's_RIV.gdb.zip'),
      'utf8',
    ),
    'wxyz',
  );
  await assert.rejects(
    fetchDownloads({
      rawDir: path.join(root, 'raw'),
      downloads: [
        { dir: 't', file: 't.zip', url: 'https://example.test/c', bytes: 10 },
      ],
      fetchImpl: async () => new Response('short'),
    }),
    /5 of 10 bytes/,
  );
  assert.deepEqual(parseArgs(['build', '--force', '--limit', '5']), {
    command: 'build',
    flags: { force: true, limit: '5' },
  });
  assert.equal(riversDir({ RIVERS_CACHE_DIR: root }, {}), path.resolve(root));
  assert.equal(riversDir({}, { dir: root }), path.resolve(root));
  assert.match(riversDir({}, {}), /\.gev-cache[\\/]rivers$/);
  assert.equal(statusOf(path.join(root, 'nothing')).built, false);
});
