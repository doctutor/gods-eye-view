// Personal fork: the Overture divisions index that `npm run overture:build`
// writes and the server reads. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import {
  OVERTURE_MAX_ZOOM,
  OVERTURE_SAME_PLACE_KM,
  overtureKindOfCode,
} from '../../../src/data/overtureDivisions.js';

/**
 * The index: the kept division points of a build, in three files of a
 * build directory (build/<buildId>/), so the server never reads a build
 * being written:
 *
 * - points.bin, 24 bytes a point, sorted by CELL_DEGREES cell, then by
 *   the zoom it is named from, then by prominence and population, so a
 *   view reads only a prefix of each cell:
 *     0 Int32 longitude × 1e7   4 Int32 latitude × 1e7
 *     8 Uint32 population       12 Uint32 offset in strings.bin
 *     16 Uint16 strings length  18 Uint8 min zoom   19 Uint8 prominence
 *     20 Uint8 kind code        21 Uint16 country (index into the
 *     manifest's countries, 0 none)   23 unused
 * - strings.bin: per point, UTF-8 "name\0es\0ru\0local\0wikidata\0region".
 * - cells.bin: per non-empty cell, Uint32 × (2 + OVERTURE_MAX_ZOOM + 1):
 *     the cell's key (row × CELL_COLUMNS + column), its first point, and
 *     how many of its points are named by zoom 0, 1, … OVERTURE_MAX_ZOOM.
 */

export const INDEX_FORMAT = 1;
export const CELL_DEGREES = 0.5;
const CELL_COLUMNS = 360 / CELL_DEGREES;
const CELL_ROWS = 180 / CELL_DEGREES;
const RECORD_BYTES = 24;
const CELL_WORDS = 2 + OVERTURE_MAX_ZOOM + 1;
/** A cell yields at most this many points to one answer (its most prominent). */
const CELL_READ_LIMIT = 20_000;
const EARTH_RADIUS_KM = 6371;

const cellColumn = (lon) =>
  Math.min(
    CELL_COLUMNS - 1,
    Math.max(0, Math.floor((lon + 180) / CELL_DEGREES)),
  );
const cellRow = (lat) =>
  Math.min(CELL_ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL_DEGREES)));
export const cellKey = (lon, lat) =>
  cellRow(lat) * CELL_COLUMNS + cellColumn(lon);

/** A point's strings as stored: "name\0es\0ru\0local\0wikidata\0region". */
export function joinText(point) {
  return [
    point.name,
    point.es,
    point.ru,
    point.local,
    point.wikidata,
    point.region,
  ]
    .map((value) => String(value || '').replace(/\0/g, ''))
    .join('\0');
}

/** Points (objects) as the columns writeIndex takes. */
export function columnsOf(points) {
  const count = points.length;
  return {
    count,
    lon: Float64Array.from(points, (p) => p.lon),
    lat: Float64Array.from(points, (p) => p.lat),
    minZoom: Uint8Array.from(points, (p) => p.minZoom),
    prominence: Uint8Array.from(points, (p) => p.prominence || 0),
    kindCode: Uint8Array.from(points, (p) => p.kindCode),
    population: Uint32Array.from(points, (p) =>
      Math.min(0xffffffff, Math.max(0, Math.round(p.population || 0))),
    ),
    country: points.map((p) => p.country || ''),
    text: points.map(joinText),
  };
}

/**
 * Write a build's index files into `dir`, from columns (columnsOf):
 * `count` points, each with lon, lat, minZoom, prominence, kindCode,
 * population, country (ISO 3166-1 alpha-2) and text (joinText).
 * @returns {{points: number, cells: number, countries: string[], bytes: object}}
 */
export function writeIndex(dir, columns) {
  fs.mkdirSync(dir, { recursive: true });
  const { count, lon, lat, minZoom, prominence, population } = columns;
  const cell = new Uint32Array(count);
  for (let i = 0; i < count; i++) cell[i] = cellKey(lon[i], lat[i]);
  // By cell, named sooner first, more prominent, larger.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort(
    (a, b) =>
      cell[a] - cell[b] ||
      minZoom[a] - minZoom[b] ||
      prominence[b] - prominence[a] ||
      population[b] - population[a] ||
      a - b,
  );
  const countries = [...new Set(columns.country.filter(Boolean))].sort();
  const countryIndex = new Map(countries.map((code, i) => [code, i + 1]));
  const lengths = new Uint32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    lengths[i] = Math.min(0xffff, Buffer.byteLength(columns.text[i], 'utf8'));
    total += lengths[i];
  }
  const strings = Buffer.alloc(total);
  const records = Buffer.alloc(count * RECORD_BYTES);
  const cells = [];
  let current = null;
  let offset = 0;
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const length = lengths[i];
    if (length) {
      const text = Buffer.from(columns.text[i], 'utf8');
      text.copy(strings, offset, 0, length);
    }
    const at = k * RECORD_BYTES;
    records.writeInt32LE(Math.round(lon[i] * 1e7), at);
    records.writeInt32LE(Math.round(lat[i] * 1e7), at + 4);
    records.writeUInt32LE(population[i], at + 8);
    records.writeUInt32LE(offset, at + 12);
    records.writeUInt16LE(length, at + 16);
    records.writeUInt8(minZoom[i], at + 18);
    records.writeUInt8(prominence[i], at + 19);
    records.writeUInt8(columns.kindCode[i], at + 20);
    records.writeUInt16LE(countryIndex.get(columns.country[i]) || 0, at + 21);
    offset += length;
    if (!current || current.key !== cell[i]) {
      current = {
        key: cell[i],
        start: k,
        byZoom: new Array(OVERTURE_MAX_ZOOM + 1).fill(0),
      };
      cells.push(current);
    }
    current.byZoom[Math.min(OVERTURE_MAX_ZOOM, minZoom[i])] += 1;
  }
  const cellWords = new Uint32Array(cells.length * CELL_WORDS);
  cells.forEach((entry, n) => {
    const base = n * CELL_WORDS;
    cellWords[base] = entry.key;
    cellWords[base + 1] = entry.start;
    let sum = 0;
    for (let z = 0; z <= OVERTURE_MAX_ZOOM; z++) {
      sum += entry.byZoom[z];
      cellWords[base + 2 + z] = sum;
    }
  });
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    return body.length;
  };
  const bytes = {
    points: write('points.bin', records),
    strings: write('strings.bin', strings),
    cells: write('cells.bin', Buffer.from(cellWords.buffer)),
  };
  return { points: count, cells: cells.length, countries, bytes };
}

const toRadians = (degrees) => (degrees * Math.PI) / 180;
function distanceKm(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The column ranges a box covers (two across the antimeridian). */
function columnRanges(west, east) {
  if (west <= east) return [[cellColumn(west), cellColumn(east)]];
  return [
    [cellColumn(west), CELL_COLUMNS - 1],
    [0, cellColumn(east)],
  ];
}

const inLon = (lon, west, east) =>
  west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;

/**
 * Open a build directory's index.
 * @param {string} dir
 * @param {{countries: string[]}} manifest
 */
export function openIndex(dir, manifest) {
  const cellBytes = fs.readFileSync(path.join(dir, 'cells.bin'));
  const cells = new Uint32Array(
    cellBytes.buffer,
    cellBytes.byteOffset,
    cellBytes.length / 4,
  );
  const cellCount = cells.length / CELL_WORDS;
  const cellAt = new Map();
  for (let i = 0; i < cellCount; i++) cellAt.set(cells[i * CELL_WORDS], i);
  const pointsFd = fs.openSync(path.join(dir, 'points.bin'), 'r');
  const stringsFd = fs.openSync(path.join(dir, 'strings.bin'), 'r');
  const countries = ['', ...(manifest?.countries || [])];

  function readRecords(start, count) {
    const buffer = Buffer.alloc(count * RECORD_BYTES);
    fs.readSync(pointsFd, buffer, 0, buffer.length, start * RECORD_BYTES);
    return buffer;
  }

  return {
    cells: cellCount,
    /**
     * The places named at `zoom` in a box: the most prominent first (then
     * the larger), one per name within OVERTURE_SAME_PLACE_KM, at most
     * `limit`.
     * @returns {{places: object[], candidates: number, saturated: boolean}}
     */
    query({ west, south, east, north, zoom, limit }) {
      const z = Math.max(0, Math.min(OVERTURE_MAX_ZOOM, Math.floor(zoom)));
      const candidates = [];
      for (let row = cellRow(south); row <= cellRow(north); row++)
        for (const [from, to] of columnRanges(west, east))
          for (let column = from; column <= to; column++) {
            const i = cellAt.get(row * CELL_COLUMNS + column);
            if (i === undefined) continue;
            const base = i * CELL_WORDS;
            const count = Math.min(CELL_READ_LIMIT, cells[base + 2 + z]);
            if (!count) continue;
            const start = cells[base + 1];
            const records = readRecords(start, count);
            for (let r = 0; r < count; r++) {
              const at = r * RECORD_BYTES;
              const lon = records.readInt32LE(at) / 1e7;
              const lat = records.readInt32LE(at + 4) / 1e7;
              if (lat < south || lat > north || !inLon(lon, west, east))
                continue;
              candidates.push({
                index: start + r,
                lon,
                lat,
                population: records.readUInt32LE(at + 8),
                offset: records.readUInt32LE(at + 12),
                length: records.readUInt16LE(at + 16),
                minZoom: records.readUInt8(at + 18),
                prominence: records.readUInt8(at + 19),
                kindCode: records.readUInt8(at + 20),
                country: countries[records.readUInt16LE(at + 21)] || '',
              });
            }
          }
      candidates.sort(
        (a, b) =>
          b.prominence - a.prominence ||
          a.minZoom - b.minZoom ||
          b.population - a.population ||
          a.index - b.index,
      );
      const places = [];
      const kept = new Map(); // lowercased name → [{lat, lon}]
      let saturated = false;
      for (const candidate of candidates) {
        if (places.length >= limit) {
          saturated = true;
          break;
        }
        const text = Buffer.alloc(candidate.length);
        fs.readSync(stringsFd, text, 0, candidate.length, candidate.offset);
        const [name, es, ru, local, wikidata, region] = text
          .toString('utf8')
          .split('\0');
        if (!name) continue;
        const key = name.trim().toLowerCase();
        const same = kept.get(key) || [];
        if (
          same.some(
            (p) =>
              distanceKm(p.lat, p.lon, candidate.lat, candidate.lon) <=
              OVERTURE_SAME_PLACE_KM,
          )
        )
          continue;
        same.push(candidate);
        kept.set(key, same);
        places.push({
          id: `ov:${candidate.index}`,
          name,
          ...(es ? { es } : {}),
          ...(ru ? { ru } : {}),
          ...(local ? { local } : {}),
          kind: overtureKindOfCode(candidate.kindCode)?.kind || 'locality',
          ...(candidate.population ? { pop: candidate.population } : {}),
          ...(candidate.prominence ? { prominence: candidate.prominence } : {}),
          ...(wikidata ? { wikidata } : {}),
          ...(candidate.country ? { country: candidate.country } : {}),
          ...(region ? { region } : {}),
          at: [candidate.lon, candidate.lat],
        });
      }
      return {
        places,
        candidates: candidates.length,
        saturated,
      };
    },
    close() {
      fs.closeSync(pointsFd);
      fs.closeSync(stringsFd);
    },
  };
}
