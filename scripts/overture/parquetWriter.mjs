// Personal fork: a small Parquet writer (Thrift compact, data pages v1,
// plain or dictionary values, optional ZSTD) for the tests of the Overture
// builds: files small enough to write by hand, read back by parquet.mjs.
// Not used by the builds themselves; not part of upstream God's Eye View.
import fs from 'node:fs';
import zlib from 'node:zlib';

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
  // BOOLEAN: bit-packed, the first value in the lowest bit.
  if (type === 0) {
    const b = Buffer.alloc(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
      if (v) b[i >> 3] |= 1 << (i & 7);
    });
    return b;
  }
  if (type === 1) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
    return b;
  }
  if (type === 4) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeFloatLE(v, i * 4));
    return b;
  }
  if (type === 5) {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => b.writeDoubleLE(v, i * 8));
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
export function writeParquet(file, { schema, columns, rows, codec = 0 }) {
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

export const BOOLEAN = 0;
export const BYTES = 6;
export const INT32 = 1;
export const FLOAT = 4;
export const DOUBLE = 5;
export const OPTIONAL = 1;
export const REPEATED = 2;
export const REQUIRED = 0;
export const leaf = (name, type = BYTES, repetition = OPTIONAL) => ({
  name,
  type,
  repetition,
});
