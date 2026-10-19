/**
 * A reader for Esri File Geodatabase tables (.gdbtable / .gdbtablx), enough
 * for the HydroSHEDS v2 river network: the field list, every row's
 * attributes and its polyline. Written from GDAL's openly documented
 * OpenFileGDB format notes (https://github.com/rouault/dump_gdbtable/wiki/FGDB-Spec);
 * no Esri software or library is involved.
 *
 * Rows are read in file order from a stream (an entry of the downloaded ZIP,
 * see zip.mjs), so the tables never need extracting. A deleted row is a
 * negative size followed by that many bytes; every live row is counted and
 * the count is checked against the header's.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const FIELD_TYPES = Object.freeze({
  INT16: 0,
  INT32: 1,
  FLOAT32: 2,
  FLOAT64: 3,
  STRING: 4,
  DATETIME: 5,
  OBJECTID: 6,
  GEOMETRY: 7,
  BINARY: 8,
  RASTER: 9,
  GUID: 10,
  GLOBALID: 11,
  XML: 12,
  INT64: 13,
  DATE: 14,
  TIME: 15,
  DATETIME_OFFSET: 16,
});

/** Unsigned LEB128, kept exact past 32 bits (Number, up to 2^53). */
export function readVarUint(buffer, state) {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (state.at >= buffer.length) throw new RangeError('varuint past end');
    const byte = buffer[state.at++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return value;
    scale *= 128;
  }
}

/** FileGDB's signed varint: 6 bits and a sign bit in the first byte, then 7 per byte. */
export function readVarInt(buffer, state) {
  if (state.at >= buffer.length) throw new RangeError('varint past end');
  let byte = buffer[state.at++];
  const negative = (byte & 0x40) !== 0;
  let value = byte & 0x3f;
  let scale = 64;
  while (byte & 0x80) {
    if (state.at >= buffer.length) throw new RangeError('varint past end');
    byte = buffer[state.at++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  }
  return negative ? -value : value;
}

const utf16 = (buffer, at, chars) =>
  buffer.toString('utf16le', at, at + chars * 2);

/**
 * The table header (40 bytes) and its field descriptions.
 * @returns {{version: number, rows: number, maxRowSize: number, fileSize: number,
 *   fields: object[], geometry: object|null, nullableCount: number, rowsStart: number}}
 */
export function parseTableHeader(buffer) {
  if (buffer.length < 40) throw new RangeError('table header past end');
  const version = buffer.readUInt32LE(0);
  if (version !== 3)
    throw new Error(
      `gdbtable version ${version} is not supported (only 3, ArcGIS 10.x)`,
    );
  const rows = buffer.readUInt32LE(4);
  const maxRowSize = buffer.readUInt32LE(8);
  const fileSize = Number(buffer.readBigUInt64LE(24));
  const fieldsOffset = Number(buffer.readBigUInt64LE(32));
  const headerSize = buffer.readUInt32LE(fieldsOffset);
  const rowsStart = fieldsOffset + 4 + headerSize;
  if (buffer.length < rowsStart) throw new RangeError('field section past end');
  let at = fieldsOffset + 8;
  const layerFlags = buffer.readUInt32LE(at);
  at += 4;
  const fieldCount = buffer.readUInt16LE(at);
  at += 2;
  const fields = [];
  let geometry = null;
  let nullableCount = 0;
  for (let index = 0; index < fieldCount; index++) {
    const nameChars = buffer[at++];
    const name = utf16(buffer, at, nameChars);
    at += nameChars * 2;
    const aliasChars = buffer[at++];
    at += aliasChars * 2;
    const type = buffer[at++];
    const field = { name, type, nullable: false };
    if (type === FIELD_TYPES.OBJECTID) {
      at += 2;
    } else if (type === FIELD_TYPES.STRING) {
      field.width = buffer.readUInt32LE(at);
      const flags = buffer[at + 4];
      field.nullable = (flags & 1) !== 0;
      const state = { at: at + 5 };
      const defaultLength = readVarUint(buffer, state);
      at = state.at + defaultLength;
    } else if (type === FIELD_TYPES.GEOMETRY) {
      const flags = buffer[at + 1];
      field.nullable = (flags & 1) !== 0;
      at += 2;
      const wktBytes = buffer.readUInt16LE(at);
      at += 2;
      const wkt = buffer.toString('utf16le', at, at + wktBytes);
      at += wktBytes;
      const geomFlags = buffer[at++];
      const hasM = (geomFlags & 2) !== 0;
      const hasZ = (geomFlags & 4) !== 0;
      const double = () => {
        const value = buffer.readDoubleLE(at);
        at += 8;
        return value;
      };
      geometry = {
        field: name,
        type: layerFlags & 0xff,
        wkt,
        hasM,
        hasZ,
        xOrigin: double(),
        yOrigin: double(),
        xyScale: double(),
      };
      if (hasM) {
        geometry.mOrigin = double();
        geometry.mScale = double();
      }
      if (hasZ) {
        geometry.zOrigin = double();
        geometry.zScale = double();
      }
      geometry.xyTolerance = double();
      if (hasM) double();
      if (hasZ) double();
      geometry.extent = {
        xmin: double(),
        ymin: double(),
        xmax: double(),
        ymax: double(),
      };
      // Then optional Z/M extents, then 0x00 n 0x00 0x00 0x00 and the n
      // spatial-index grid sizes (GDAL looks for that pattern the same way).
      for (;;) {
        if (at + 5 > rowsStart) throw new Error('geometry field past end');
        if (
          buffer[at] === 0 &&
          buffer[at + 1] >= 1 &&
          buffer[at + 1] <= 3 &&
          buffer[at + 2] === 0 &&
          buffer[at + 3] === 0 &&
          buffer[at + 4] === 0
        ) {
          const grids = buffer[at + 1];
          at += 5 + grids * 8;
          break;
        }
        at += 8;
      }
    } else if (type === FIELD_TYPES.RASTER) {
      throw new Error(`raster field ${name} is not supported`);
    } else if (
      [
        FIELD_TYPES.BINARY,
        FIELD_TYPES.GUID,
        FIELD_TYPES.GLOBALID,
        FIELD_TYPES.XML,
      ].includes(type)
    ) {
      field.nullable = (buffer[at + 1] & 1) !== 0;
      at += 2;
    } else if (type <= FIELD_TYPES.DATETIME || type >= FIELD_TYPES.INT64) {
      field.width = buffer[at];
      field.nullable = (buffer[at + 1] & 1) !== 0;
      const defaultLength = buffer[at + 2];
      at += 3 + defaultLength;
    } else {
      throw new Error(`field ${name} has unknown type ${type}`);
    }
    if (field.nullable) field.nullIndex = nullableCount++;
    fields.push(field);
  }
  return {
    version,
    rows,
    maxRowSize,
    fileSize,
    fields,
    geometry,
    nullableCount,
    rowsStart,
  };
}

/**
 * One row's values by field name; the geometry as its raw blob (decode it
 * with decodePolyline). The OBJECTID is not stored in the row.
 */
export function decodeRow(buffer, start, end, header) {
  const nullBytes = (header.nullableCount + 7) >> 3;
  const nulls = start;
  const state = { at: start + nullBytes };
  const values = {};
  for (const field of header.fields) {
    if (field.type === FIELD_TYPES.OBJECTID) continue;
    if (
      field.nullable &&
      buffer[nulls + (field.nullIndex >> 3)] & (1 << (field.nullIndex & 7))
    ) {
      values[field.name] = null;
      continue;
    }
    const at = state.at;
    switch (field.type) {
      case FIELD_TYPES.INT16:
        values[field.name] = buffer.readInt16LE(at);
        state.at += 2;
        break;
      case FIELD_TYPES.INT32:
        values[field.name] = buffer.readInt32LE(at);
        state.at += 4;
        break;
      case FIELD_TYPES.FLOAT32:
        values[field.name] = buffer.readFloatLE(at);
        state.at += 4;
        break;
      case FIELD_TYPES.FLOAT64:
      case FIELD_TYPES.DATETIME:
      case FIELD_TYPES.DATE:
      case FIELD_TYPES.TIME:
        values[field.name] = buffer.readDoubleLE(at);
        state.at += 8;
        break;
      case FIELD_TYPES.INT64:
        values[field.name] = Number(buffer.readBigInt64LE(at));
        state.at += 8;
        break;
      case FIELD_TYPES.DATETIME_OFFSET:
        values[field.name] = buffer.readDoubleLE(at);
        state.at += 10;
        break;
      case FIELD_TYPES.GUID:
      case FIELD_TYPES.GLOBALID:
        values[field.name] = buffer.toString('hex', at, at + 16);
        state.at += 16;
        break;
      case FIELD_TYPES.STRING:
      case FIELD_TYPES.XML: {
        const length = readVarUint(buffer, state);
        values[field.name] = buffer.toString(
          'utf8',
          state.at,
          state.at + length,
        );
        state.at += length;
        break;
      }
      case FIELD_TYPES.GEOMETRY:
      case FIELD_TYPES.BINARY: {
        const length = readVarUint(buffer, state);
        values[field.name] = buffer.subarray(state.at, state.at + length);
        state.at += length;
        break;
      }
      default:
        throw new Error(`field ${field.name} has unknown type ${field.type}`);
    }
    if (state.at > end) throw new RangeError(`row overruns at ${field.name}`);
  }
  return values;
}

/** Shape types whose base is a polyline or polygon (rings read the same way). */
const LINEAR = new Set([3, 10, 13, 23, 5, 15, 19, 25, 50, 51]);

/**
 * A polyline (or polygon) blob as parts of [lon, lat, lon, lat, …].
 * Z, M and curve descriptions after the XY are not read.
 * @returns {Float64Array[]|null} null for an empty or non-linear shape
 */
export function decodePolyline(blob, geometry) {
  if (!blob || blob.length === 0) return null;
  const state = { at: 0 };
  const shapeType = readVarUint(blob, state) % 2 ** 32;
  const base = shapeType & 0xff;
  if (base === 0 || !LINEAR.has(base)) return null;
  const hasCurves = base >= 50 && (shapeType & 0x20000000) !== 0;
  const points = readVarUint(blob, state);
  if (points === 0) return null;
  const partCount = readVarUint(blob, state);
  if (hasCurves) readVarUint(blob, state);
  for (let corner = 0; corner < 4; corner++) readVarUint(blob, state);
  const sizes = [];
  let counted = 0;
  for (let part = 0; part < partCount - 1; part++) {
    const size = readVarUint(blob, state);
    sizes.push(size);
    counted += size;
  }
  sizes.push(points - counted);
  const { xOrigin, yOrigin, xyScale } = geometry;
  const parts = [];
  let dx = 0;
  let dy = 0;
  for (const size of sizes) {
    if (size <= 0) continue;
    const coords = new Float64Array(size * 2);
    for (let index = 0; index < size; index++) {
      dx += readVarInt(blob, state);
      dy += readVarInt(blob, state);
      coords[index * 2] = dx / xyScale + xOrigin;
      coords[index * 2 + 1] = dy / xyScale + yOrigin;
    }
    parts.push(coords);
  }
  return parts;
}

/**
 * Every live row of a .gdbtable stream, in file order, as `onRow(values,
 * header, offset)` (offset: where the row starts in the file); the header
 * is parsed from the stream's first bytes. onRow returning false stops the
 * read (and destroys the stream) after that row.
 *
 * With `offsets` (liveRowOffsets of the table's .gdbtablx) only the rows
 * the index names are read and everything between them is skipped: an
 * edited table keeps freed blocks (a dropped field's old description, a
 * deleted row) whose sizes do not chain. Without it, rows are chained from
 * the field section and a negative size is a deleted row of that many bytes.
 * @param {AsyncIterable<Buffer>} stream
 * @param {(values: object, header: object, offset: number) => boolean|void} onRow
 * @param {{offsets?: Float64Array}} [options]
 * @returns {Promise<{header: object, rows: number, deleted: number, bytes: number, stopped?: boolean}>}
 */
export async function forEachRow(stream, onRow, { offsets = null } = {}) {
  let pending = Buffer.alloc(0);
  let header = null;
  let rows = 0;
  let deleted = 0;
  let skip = 0;
  let stopped = false;
  let next = 0;
  // The file offset of buffer[0].
  let base = 0;
  for await (const chunk of stream) {
    let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    if (skip) {
      const dropped = Math.min(skip, buffer.length);
      skip -= dropped;
      at = dropped;
    }
    if (!header) {
      try {
        header = parseTableHeader(buffer);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        pending = buffer;
        continue;
      }
      at = header.rowsStart;
    }
    while (!skip) {
      if (offsets) {
        if (next >= offsets.length) {
          stopped = true;
          break;
        }
        const target = offsets[next] - base;
        if (target < at) throw new Error('gdbtablx offsets overlap a row');
        if (target > buffer.length) {
          skip = target - buffer.length;
          at = buffer.length;
          break;
        }
        at = target;
      }
      if (at + 4 > buffer.length) break;
      const size = buffer.readInt32LE(at);
      if (size < 0) {
        if (offsets) throw new Error('gdbtablx names a deleted row');
        deleted++;
        const available = buffer.length - (at + 4);
        if (-size > available) {
          skip = -size - available;
          at = buffer.length;
          break;
        }
        at += 4 - size;
        continue;
      }
      if (at + 4 + size > buffer.length) break;
      const verdict = onRow(
        decodeRow(buffer, at + 4, at + 4 + size, header),
        header,
        base + at,
      );
      rows++;
      next++;
      at += 4 + size;
      if (verdict === false) {
        stopped = true;
        break;
      }
    }
    base += at;
    pending =
      at < buffer.length ? Buffer.from(buffer.subarray(at)) : Buffer.alloc(0);
    buffer = null;
    if (stopped) break;
  }
  if (!header)
    throw new Error('not a gdbtable: the stream ended in the header');
  const complete = offsets ? next >= offsets.length : !stopped;
  if (stopped) stream.destroy?.();
  if (!complete) return { header, rows, deleted, bytes: base, stopped: true };
  if (!offsets && pending.length >= 4 && pending.some((byte) => byte !== 0))
    // A trailing partial row is only acceptable as zero padding.
    throw new Error(
      `gdbtable ended inside a row (${pending.length} bytes left)`,
    );
  if (rows !== header.rows)
    throw new Error(
      `gdbtable header says ${header.rows} rows, ${rows} were read (${deleted} deleted)`,
    );
  return { header, rows, deleted, bytes: base + pending.length };
}

/** The 5- or 6-byte offsets of a .gdbtablx, one per row id (0: deleted). */
function forEachTablxOffset(tablx, onOffset) {
  const blocks = tablx.readUInt32LE(4);
  const total = tablx.readUInt32LE(8);
  const width = tablx.readUInt32LE(12);
  if (blocks * 1024 < total)
    throw new Error('sparse gdbtablx (block bitmap) is not supported');
  if (tablx.length < 16 + total * width)
    throw new Error('gdbtablx is shorter than its row count');
  for (let index = 0; index < total; index++) {
    let offset = 0;
    for (let byte = width - 1; byte >= 0; byte--)
      offset = offset * 256 + tablx[16 + index * width + byte];
    onOffset(offset, index);
  }
}

/** Where the live rows of a table start, ascending (for forEachRow). */
export function liveRowOffsets(tablx) {
  const offsets = new Float64Array(tablx.readUInt32LE(8));
  let count = 0;
  forEachTablxOffset(tablx, (offset) => {
    if (offset) offsets[count++] = offset;
  });
  return offsets.subarray(0, count).sort();
}

/**
 * The OBJECTID → offset table (.gdbtablx): which row ids are live. Only
 * dense tables (no block bitmap) are read; the catalog always is.
 * @returns {Map<number, number>} file offset → 1-based row id, live rows only
 */
export function rowIdsByOffset(tablx) {
  const ids = new Map();
  forEachTablxOffset(tablx, (offset, index) => {
    if (offset) ids.set(offset, index + 1);
  });
  return ids;
}
