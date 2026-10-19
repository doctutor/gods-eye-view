#!/usr/bin/env node
/**
 * Personal fork: build the populated-places pack the Localities layer
 * labels with from orbit to regional scale (src/layers/localities/):
 *
 *   src/data/local_data/natural_earth/populated_places.json
 *     Natural Earth 10m populated places (public domain): each place's
 *     English, Spanish and Russian names, scalerank, Natural Earth's own
 *     label min_zoom, largest population, capital class and country, at
 *     about 100 m. Nothing else: the layer draws dots and labels.
 *
 * The source is the official Natural Earth download, pinned by SHA-256:
 *
 *   https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip
 *
 * Download it yourself into an empty directory (the script fetches nothing)
 * and pass its path:
 *
 *   node scripts/build-populated-places-pack.mjs --zip <dir>/ne_10m_populated_places.zip
 *
 * A rerun on the same zip rewrites the pack byte for byte.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'src/data/local_data/natural_earth/populated_places.json';

export const SOURCE = Object.freeze({
  url: 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip',
  sha256: 'cd149186f03d2603e0410da399b980a4357d0ac32d3a2305a49ed3dffcc41d7b',
  fetched: '2026-10-19',
});

/** Coordinates rounded to this many decimals (about 100 m). */
const DECIMALS = 3;

// ── zip / dbf (as scripts/build-river-names-pack.mjs reads them) ──────────

function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** dBASE records; Natural Earth pads its fields with NULs. */
function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buffer[at] !== 0x0d; at += 32)
    fields.push({
      name: buffer.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      length: buffer[at + 16],
    });
  const records = [];
  for (let r = 0; r < count; r++) {
    let at = headerLength + r * recordLength + 1;
    const record = {};
    for (const field of fields) {
      record[field.name] = buffer
        .toString('utf8', at, at + field.length)
        .replace(/\0+/g, '')
        .trim();
      at += field.length;
    }
    records.push(record);
  }
  return records;
}

// ── the pack ────────────────────────────────────────────────────────────

/**
 * The capital class: 'country' for a national capital (ADM0CAP, or one of
 * the alternative capitals), 'region' for a first-level one, else none.
 */
function capitalOf(record) {
  const kind = String(record.FEATURECLA || '').toLowerCase();
  if (record.ADM0CAP === '1' || kind.startsWith('admin-0 capital'))
    return 'country';
  if (kind.startsWith('admin-1') || kind.startsWith('admin-0 region'))
    return 'region';
  return '';
}

const round = (value) => Number(Number(value).toFixed(DECIMALS));

const args = process.argv.slice(2);
const zipPath = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : '';
if (!zipPath) {
  console.error(
    'usage: node scripts/build-populated-places-pack.mjs --zip <path to ne_10m_populated_places.zip>',
  );
  process.exit(2);
}
const bytes = await readFile(path.resolve(zipPath));
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SOURCE.sha256)
  throw new Error(
    `SHA-256 ${digest} does not match the pinned ${SOURCE.sha256}`,
  );
const files = unzip(bytes);
const base = 'ne_10m_populated_places';
const version = String(files.get(`${base}.VERSION.txt`) || '').trim();
const records = readDbf(files.get(`${base}.dbf`));

// Countries once, by index: the card names a place's country.
const countries = [
  ...new Set(records.map((record) => record.ADM0NAME).filter(Boolean)),
].sort();
const countryIndex = new Map(countries.map((name, i) => [name, i]));

const places = records
  .filter((record) => (record.NAME_EN || record.NAME) && record.LATITUDE)
  .map((record) => {
    const name = record.NAME_EN || record.NAME;
    const capital = capitalOf(record);
    const pop = Math.max(0, Math.round(Number(record.POP_MAX) || 0));
    return {
      name,
      ...(record.NAME_ES && record.NAME_ES !== name
        ? { es: record.NAME_ES }
        : {}),
      ...(record.NAME_RU && record.NAME_RU !== name
        ? { ru: record.NAME_RU }
        : {}),
      rank: Number(record.SCALERANK),
      z: Number(record.MIN_ZOOM),
      ...(pop ? { pop } : {}),
      ...(capital ? { cap: capital } : {}),
      c: countryIndex.get(record.ADM0NAME) ?? -1,
      at: [round(record.LONGITUDE), round(record.LATITUDE)],
    };
  })
  // Most prominent first: the layer keeps this order within a band.
  .sort(
    (a, b) =>
      a.z - b.z ||
      a.rank - b.rank ||
      (b.pop || 0) - (a.pop || 0) ||
      a.name.localeCompare(b.name),
  );

const pack = {
  meta: {
    source: `Natural Earth 10m cultural vectors: populated places (${base}), version ${version}`,
    url: SOURCE.url,
    sha256: SOURCE.sha256,
    fetched: SOURCE.fetched,
    license:
      'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
    curation: {
      records: records.length,
      decimals: DECIMALS,
      fields:
        'name (NAME_EN, else NAME), es (NAME_ES) and ru (NAME_RU) when they differ, rank (SCALERANK), z (MIN_ZOOM), pop (POP_MAX), cap (country | region), c (index into countries: ADM0NAME), at ([lon, lat])',
    },
  },
  countries,
  places,
};
const text = JSON.stringify(pack) + '\n';
await writeFile(path.join(ROOT, OUT), text);
console.log(
  `${OUT}: ${places.length} places, ${Buffer.byteLength(text)} bytes`,
);
