import fs from 'node:fs';
import path from 'node:path';
import {
  decodePolyline,
  forEachRow,
  liveRowOffsets,
  rowIdsByOffset,
} from './fileGdb.mjs';
import { forEachGeoPackageReach } from './geopackage.mjs';
import { listZipEntries, openZipEntry, readZipEntry } from './zip.mjs';

/**
 * The HydroSHEDS v2 river network inputs of a build: each region's
 * RIV_STREAMS layer, from the zipped File Geodatabase (what the build was
 * made from, 4.8 GB for the Americas) or from the GeoPackage (25.6 GB, the
 * same layer). Both give the same reach: its upstream area, its Strahler
 * order and its polyline parts in degrees.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** The stream layer's name inside either container. */
export const STREAMS_LAYER = /_RIV_STREAMS_/i;

/**
 * The river inputs under a raw directory, one directory deep: every
 * `*_RIV_*.gdb.zip` and `*_RIV_*.gpkg`, a region once (a .gpkg beside a
 * .gdb.zip of the same region is skipped).
 * @returns {{file: string, region: string, kind: 'gdb-zip'|'gpkg', bytes: number}[]}
 */
export function findRiverInputs(rawDir) {
  const found = new Map();
  const consider = (file) => {
    const name = path.basename(file);
    const match = /^([a-z-]+)_RIV_.*\.(gdb\.zip|gpkg)$/i.exec(name);
    if (!match) return;
    const region = match[1].toLowerCase();
    const kind = match[2].toLowerCase() === 'gpkg' ? 'gpkg' : 'gdb-zip';
    if (found.has(region) && found.get(region).kind === 'gdb-zip') return;
    found.set(region, { file, region, kind, bytes: fs.statSync(file).size });
  };
  if (!fs.existsSync(rawDir)) return [];
  for (const entry of fs.readdirSync(rawDir, { withFileTypes: true })) {
    const full = path.join(rawDir, entry.name);
    if (entry.isFile()) consider(full);
    else if (entry.isDirectory())
      for (const inner of fs.readdirSync(full, { withFileTypes: true }))
        if (inner.isFile()) consider(path.join(full, inner.name));
  }
  return [...found.values()].sort((a, b) => a.region.localeCompare(b.region));
}

/**
 * The geodatabase's tables by name, from its system catalog (a00000001):
 * a table's row id there names its file, a<id as 8 hex digits>.gdbtable.
 */
export async function gdbCatalog(zipFile, entries = listZipEntries(zipFile)) {
  const find = (suffix) =>
    entries.find((entry) => entry.name.toLowerCase().endsWith(suffix));
  const table = find('/a00000001.gdbtable');
  const tablx = find('/a00000001.gdbtablx');
  if (!table || !tablx)
    throw new Error(`${path.basename(zipFile)}: no geodatabase catalog`);
  const ids = rowIdsByOffset(await readZipEntry(zipFile, tablx));
  const prefix = table.name.slice(0, -'a00000001.gdbtable'.length);
  const tables = [];
  await forEachRow(openZipEntry(zipFile, table), (values, _header, offset) => {
    const id = ids.get(offset);
    if (!id || values.FileFormat !== 0) return;
    const file = `${prefix}a${id.toString(16).padStart(8, '0')}.gdbtable`;
    const entry = entries.find((candidate) => candidate.name === file);
    tables.push({ id, name: String(values.Name), entry });
  });
  return tables.sort((a, b) => a.id - b.id);
}

/**
 * The stream table among a catalog's: the one named <region>_RIV_STREAMS_
 * <resolution>_<version>. The North American geodatabase also holds an
 * earlier copy, north_america_RIV_STREAMS_1s_v2r0_1 (same rows, edited
 * after a field was dropped), which is passed over.
 */
export function streamsTable(tables) {
  const candidates = tables.filter(
    (table) => STREAMS_LAYER.test(table.name) && table.entry,
  );
  return (
    candidates.find((table) =>
      /_RIV_STREAMS_[^_]+_v\d+r\d+$/i.test(table.name),
    ) ||
    candidates[0] ||
    null
  );
}

/** A row's reach, or null without a line. */
function toReach(values, parts) {
  if (!parts || !parts.length) return null;
  return {
    upland: Number(values.UPLAND_SKM),
    strahler: values.ORD_STRAH ?? null,
    lengthKm: values.LENGTH_KM ?? null,
    parts,
  };
}

/**
 * Every reach of an input, in file order; onReach returning false stops.
 * @param {{file: string, kind: string}} input
 * @param {(reach: {upland: number, strahler: number|null, lengthKm: number|null, parts: Float64Array[]}) => boolean|void} onReach
 * @returns {Promise<{table: string, rows: number, fields: string[], extent: object|null}>}
 */
export async function forEachReach(input, onReach) {
  if (input.kind === 'gpkg') return forEachGeoPackageReach(input.file, onReach);
  const entries = listZipEntries(input.file);
  const streams = streamsTable(await gdbCatalog(input.file, entries));
  if (!streams)
    throw new Error(`${path.basename(input.file)}: no RIV_STREAMS table`);
  // The row index says where each live row starts (57 MB for North America).
  const tablxName = streams.entry.name.replace(/\.gdbtable$/, '.gdbtablx');
  const tablx = entries.find((entry) => entry.name === tablxName);
  const offsets = tablx
    ? liveRowOffsets(await readZipEntry(input.file, tablx))
    : null;
  const result = await forEachRow(
    openZipEntry(input.file, streams.entry),
    (values, header) => {
      const reach = toReach(
        values,
        decodePolyline(values[header.geometry.field], header.geometry),
      );
      if (reach) return onReach(reach);
      return undefined;
    },
    { offsets },
  );
  return {
    table: streams.name,
    rows: result.rows,
    stopped: Boolean(result.stopped),
    fields: result.header.fields.map((field) => field.name),
    extent: result.header.geometry?.extent || null,
  };
}
