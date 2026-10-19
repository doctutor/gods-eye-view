#!/usr/bin/env node
/**
 * Personal fork: build the river-name pack the Rivers layer labels with
 * (src/layers/earthEngine/riverNames.js):
 *
 *   src/data/local_data/natural_earth/river_names.json
 *     Natural Earth 10m rivers and lake centerlines (public domain): each
 *     named river's English, Spanish and Russian names, its scalerank and a
 *     few label points along it. No line geometry: Earth Engine draws the
 *     rivers.
 *
 * The source is the official Natural Earth download, pinned by SHA-256:
 *
 *   https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip
 *
 * Download it yourself into an empty directory (the script fetches nothing)
 * and pass its path:
 *
 *   node scripts/build-river-names-pack.mjs --zip <dir>/ne_10m_rivers_lake_centerlines.zip
 *
 * A rerun on the same zip rewrites the pack byte for byte.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'src/data/local_data/natural_earth/river_names.json';

export const SOURCE = Object.freeze({
  url: 'https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip',
  sha256: 'ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38',
  fetched: '2026-10-18',
});

/**
 * Label points: one every `spacingKm` along a part (at least one, at most
 * `maxPerPart`), at the middle of equal stretches; a point within
 * `mergeKm` of a kept point of the same name is dropped. Coordinates are
 * rounded to `decimals` (about 1 km).
 */
export const PARAMS = Object.freeze({
  spacingKm: 1500,
  maxPerPart: 6,
  mergeKm: 500,
  decimals: 2,
});

// ── zip / shapefile / dbf (as scripts/build-admin-packs.mjs reads them) ────

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

/** PolyLine records (shape type 3) as arrays of [lon, lat] parts. */
function readPolylines(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset < buffer.length) {
    const length = buffer.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    const type = buffer.readInt32LE(content);
    const parts = [];
    if (type === 3) {
      const numParts = buffer.readInt32LE(content + 36);
      const numPoints = buffer.readInt32LE(content + 40);
      const partsAt = content + 44;
      const pointsAt = partsAt + numParts * 4;
      for (let p = 0; p < numParts; p++) {
        const start = buffer.readInt32LE(partsAt + p * 4);
        const end =
          p + 1 < numParts
            ? buffer.readInt32LE(partsAt + (p + 1) * 4)
            : numPoints;
        const part = [];
        for (let i = start; i < end; i++)
          part.push([
            buffer.readDoubleLE(pointsAt + i * 16),
            buffer.readDoubleLE(pointsAt + i * 16 + 8),
          ]);
        parts.push(part);
      }
    } else if (type !== 0) {
      throw new Error(`shp: unsupported shape type ${type}`);
    }
    shapes.push(parts);
    offset = content + length;
  }
  return shapes;
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

// ── geometry ────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lengthKm(part) {
  let total = 0;
  for (let i = 1; i < part.length; i++)
    total += distanceKm(part[i - 1], part[i]);
  return total;
}

/** The point `at` km along a part (linear between its vertices). */
function pointAlong(part, at) {
  let walked = 0;
  for (let i = 1; i < part.length; i++) {
    const step = distanceKm(part[i - 1], part[i]);
    if (walked + step >= at && step > 0) {
      const t = (at - walked) / step;
      return [
        part[i - 1][0] + (part[i][0] - part[i - 1][0]) * t,
        part[i - 1][1] + (part[i][1] - part[i - 1][1]) * t,
      ];
    }
    walked += step;
  }
  return part[part.length - 1];
}

const round = (value, decimals) => Number(value.toFixed(decimals));

/** Label points along each part, spaced PARAMS.spacingKm apart. */
function labelPoints(parts) {
  const points = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    const length = lengthKm(part);
    const count = Math.min(
      PARAMS.maxPerPart,
      Math.max(1, Math.round(length / PARAMS.spacingKm)),
    );
    for (let i = 0; i < count; i++)
      points.push({
        point: pointAlong(part, (length * (i + 0.5)) / count),
        length,
      });
  }
  return points;
}

// ── the pack ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const zipPath = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : '';
if (!zipPath) {
  console.error(
    'usage: node scripts/build-river-names-pack.mjs --zip <path to ne_10m_rivers_lake_centerlines.zip>',
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
const base = 'ne_10m_rivers_lake_centerlines';
const version = String(files.get(`${base}.VERSION.txt`) || '').trim();
const shapes = readPolylines(files.get(`${base}.shp`));
const records = readDbf(files.get(`${base}.dbf`));
if (shapes.length !== records.length)
  throw new Error('shp and dbf record counts differ');

// Larger rivers first (scalerank), then longer parts, so a name's kept
// points are on its main stem.
const candidates = records
  .map((record, index) => ({ record, points: labelPoints(shapes[index]) }))
  .filter(
    ({ record, points }) => (record.name_en || record.name) && points.length,
  )
  .map(({ record, points }) => ({
    name: record.name_en || record.name,
    es: record.name_es,
    ru: record.name_ru,
    rank: Number(record.scalerank),
    points,
    length: Math.max(...points.map((p) => p.length)),
  }))
  .sort(
    (a, b) =>
      a.rank - b.rank || b.length - a.length || a.name.localeCompare(b.name),
  );

const byName = new Map();
for (const candidate of candidates) {
  const key = `${candidate.name}\n${candidate.es}\n${candidate.ru}`;
  let feature = byName.get(key);
  if (!feature) {
    feature = {
      name: candidate.name,
      ...(candidate.es && candidate.es !== candidate.name
        ? { es: candidate.es }
        : {}),
      ...(candidate.ru && candidate.ru !== candidate.name
        ? { ru: candidate.ru }
        : {}),
      rank: candidate.rank,
      at: [],
    };
    byName.set(key, feature);
  }
  for (const { point } of candidate.points) {
    if (feature.at.some((kept) => distanceKm(kept, point) < PARAMS.mergeKm))
      continue;
    feature.at.push([
      round(point[0], PARAMS.decimals),
      round(point[1], PARAMS.decimals),
    ]);
  }
}
const features = [...byName.values()];

const pack = {
  meta: {
    source: `Natural Earth 10m physical vectors: rivers and lake centerlines (${base}), version ${version}`,
    url: SOURCE.url,
    sha256: SOURCE.sha256,
    fetched: SOURCE.fetched,
    license:
      'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
    curation: {
      ...PARAMS,
      records: records.length,
      named: candidates.length,
      fields:
        'name (name_en, else name), es (name_es), ru (name_ru) when they differ, rank (scalerank), at ([lon, lat] label points)',
    },
  },
  features,
};
const text = JSON.stringify(pack) + '\n';
await writeFile(path.join(ROOT, OUT), text);
console.log(
  `${OUT}: ${features.length} names, ${features.reduce((n, f) => n + f.at.length, 0)} label points, ${Buffer.byteLength(text)} bytes`,
);
