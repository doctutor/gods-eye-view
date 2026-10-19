/**
 * The GeoPackage form of the HydroSHEDS v2 river network: a GeoPackage is
 * SQLite (read with Node's built-in node:sqlite), and each geometry is a
 * GeoPackage header followed by standard WKB, decoded here.
 *
 * The Americas' GeoPackages are 25.6 GB against 4.8 GB for the zipped
 * geodatabases of the same layer, so the build was made from the latter;
 * this reader lets a GeoPackage stand in for a region's .gdb.zip.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;
const WKB_COLLECTION = 7;

/** Bytes of envelope for each GeoPackage envelope indicator. */
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/**
 * Where a GeoPackage geometry blob's WKB starts, and its SRS id.
 * @returns {{wkbStart: number, srsId: number, empty: boolean}}
 */
export function parseGpkgHeader(blob) {
  if (!blob || blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50)
    throw new Error('not a GeoPackage geometry (no GP magic)');
  const flags = blob[3];
  const little = (flags & 1) === 1;
  const envelope = (flags >> 1) & 7;
  if (envelope >= ENVELOPE_BYTES.length)
    throw new Error(`bad GeoPackage envelope indicator ${envelope}`);
  const srsId = little ? blob.readInt32LE(4) : blob.readInt32BE(4);
  return {
    wkbStart: 8 + ENVELOPE_BYTES[envelope],
    srsId,
    empty: (flags & 0x10) !== 0,
  };
}

/** Base type and coordinate dimension of a WKB type (ISO and EWKB forms). */
function wkbType(raw) {
  let dims = 2;
  if (raw & 0x80000000) dims++;
  if (raw & 0x40000000) dims++;
  let type = raw & 0x1fffffff;
  if (type >= 3000) {
    dims = 4;
    type -= 3000;
  } else if (type >= 1000) {
    // 1000s are XYZ, 2000s XYM: three numbers a point either way.
    dims = 3;
    type %= 1000;
  }
  return { type, dims };
}

/**
 * WKB lines (and rings) as parts of [x, y, x, y, …]; points are skipped.
 * @returns {Float64Array[]}
 */
export function decodeWkbLines(buffer, start = 0) {
  const parts = [];
  const state = { at: start };
  const read = () => {
    const little = buffer[state.at] === 1;
    state.at += 1;
    const u32 = () => {
      const value = little
        ? buffer.readUInt32LE(state.at)
        : buffer.readUInt32BE(state.at);
      state.at += 4;
      return value;
    };
    const f64 = () => {
      const value = little
        ? buffer.readDoubleLE(state.at)
        : buffer.readDoubleBE(state.at);
      state.at += 8;
      return value;
    };
    const { type, dims } = wkbType(u32());
    if (type === WKB_COLLECTION) {
      const count = u32();
      for (let index = 0; index < count; index++) read();
      return;
    }
    if (type === WKB_POINT) {
      state.at += dims * 8;
      return;
    }
    const line = () => {
      const count = u32();
      const coords = new Float64Array(count * 2);
      for (let index = 0; index < count; index++) {
        coords[index * 2] = f64();
        coords[index * 2 + 1] = f64();
        state.at += (dims - 2) * 8;
      }
      if (count >= 2) parts.push(coords);
    };
    if (type === WKB_LINESTRING) return line();
    if (type === WKB_POLYGON) {
      const rings = u32();
      for (let index = 0; index < rings; index++) line();
      return;
    }
    if (
      type === WKB_MULTIPOINT ||
      type === WKB_MULTILINESTRING ||
      type === WKB_MULTIPOLYGON
    ) {
      const count = u32();
      for (let index = 0; index < count; index++) read();
      return;
    }
    throw new Error(`WKB type ${type} is not supported`);
  };
  read();
  return parts;
}

const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * The stream layer of a river GeoPackage: its table, geometry column,
 * extent and columns.
 */
export function geoPackageStreams(db) {
  const rows = db
    .prepare(
      `SELECT c.table_name AS name, g.column_name AS geom, g.srs_id AS srs,
              c.min_x AS minX, c.min_y AS minY, c.max_x AS maxX, c.max_y AS maxY
         FROM gpkg_contents c JOIN gpkg_geometry_columns g
           ON g.table_name = c.table_name
        WHERE c.data_type = 'features'`,
    )
    .all();
  const streams =
    rows.find((row) => /_RIV_STREAMS_/i.test(row.name)) ||
    rows.find((row) => /STREAMS/i.test(row.name)) ||
    (rows.length === 1 ? rows[0] : null);
  if (!streams) throw new Error('no stream layer in the GeoPackage');
  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(streams.name)})`)
    .all()
    .map((column) => column.name);
  return { ...streams, columns };
}

/**
 * Every reach of a river GeoPackage, in rowid order; onReach returning
 * false stops.
 * @param {string} file
 * @param {(reach: object) => void} onReach
 */
export async function forEachGeoPackageReach(file, onReach) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const layer = geoPackageStreams(db);
    const has = (name) => layer.columns.includes(name);
    if (!has('UPLAND_SKM'))
      throw new Error(`${layer.name} has no UPLAND_SKM column`);
    const select = [
      quoteIdentifier(layer.geom),
      'UPLAND_SKM',
      has('ORD_STRAH') ? 'ORD_STRAH' : 'NULL AS ORD_STRAH',
      has('LENGTH_KM') ? 'LENGTH_KM' : 'NULL AS LENGTH_KM',
    ].join(', ');
    const statement = db.prepare(
      `SELECT ${select} FROM ${quoteIdentifier(layer.name)}`,
    );
    let rows = 0;
    let stopped = false;
    for (const row of statement.iterate()) {
      rows++;
      const blob = row[layer.geom];
      if (!blob) continue;
      const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
      const header = parseGpkgHeader(buffer);
      if (header.empty) continue;
      const parts = decodeWkbLines(buffer, header.wkbStart);
      if (!parts.length) continue;
      const verdict = onReach({
        upland: Number(row.UPLAND_SKM),
        strahler: row.ORD_STRAH ?? null,
        lengthKm: row.LENGTH_KM ?? null,
        parts,
      });
      if (verdict === false) {
        stopped = true;
        break;
      }
    }
    return {
      table: layer.name,
      rows,
      stopped,
      fields: layer.columns,
      extent:
        layer.minX === null || layer.minX === undefined
          ? null
          : {
              xmin: layer.minX,
              ymin: layer.minY,
              xmax: layer.maxX,
              ymax: layer.maxY,
            },
    };
  } finally {
    db.close();
  }
}
