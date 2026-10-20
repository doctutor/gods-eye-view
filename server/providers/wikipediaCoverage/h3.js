// Personal fork: the Wikipedia coverage layer's H3 hexagon tables
// (server/providers/wikipediaCoverage.js). Not part of upstream God's Eye View.
import * as h3 from 'h3-js';
import { createPacker, openArrayFile } from './arrayFile.js';
import { CAPITA_VARIANTS, capitaValue, quantile } from './grid.js';

/**
 * The same articles as the grid, aggregated into H3 hexagons so a "per
 * km²" can follow the viewer's perspective: every kept coordinate goes to
 * its resolution-7 cell (about 5 km²), and each coarser resolution down to
 * 0 (about 4 million km²) sums its children. Only non-empty cells are kept,
 * sorted by index, one table per resolution in `h3.bin`:
 *
 *   indexHi, indexLo  uint32  the H3 index's two halves
 *   articles          uint32  primary geotagged articles in the cell
 *   bytes             f64     their wikitext size (when the build had it)
 *   lat, lon          f32     the cell's centre
 *   area              f32     cellArea(cell, 'km2')
 *
 * A cell key, inside one resolution, is the index's low 52 bits (base
 * cell and digits): the top 12 bits are the mode and the resolution, the
 * same for every cell of a table, so the key fits a Number exactly and
 * the tables sort by it as they would by the full index.
 */

export const H3_MAGIC = 'WH3G';
export const H3_VERSION = 1;
export const H3_BASE_RES = 7;
export const RESOLUTIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
export const H3_VARIANTS = Object.freeze(['articles', 'text', 'count']);
const TWO_32 = 4294967296;
const MODE_CELL = 0x08000000;

/** A cell's key: its index's low 52 bits as a Number. */
export function cellKey(index) {
  const [lo, hi] = h3.h3IndexToSplitLong(index);
  return ((hi >>> 0) & 0xfffff) * TWO_32 + (lo >>> 0);
}

/** The H3 index for a key at a resolution. */
export function keyToIndex(key, res) {
  const hi = Math.floor(key / TWO_32);
  const lo = key - hi * TWO_32;
  return h3.splitLongToH3Index(lo, MODE_CELL | (res << 20) | hi);
}

/**
 * A resolution-7 accumulator: counts, and bytes when the build keeps them.
 * @param {{text?: boolean}} [options]
 */
export function createH3Accumulator({ text = false } = {}) {
  const counts = new Map();
  const bytes = text ? new Map() : null;
  return {
    counts,
    bytes,
    /** Count one article; returns its resolution-7 key, or -1 outside. */
    add(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return -1;
      const key = cellKey(h3.latLngToCell(lat, lon, H3_BASE_RES));
      counts.set(key, (counts.get(key) || 0) + 1);
      return key;
    },
    addBytes(key, size) {
      if (!bytes || !(key >= 0) || !(size > 0)) return;
      bytes.set(key, (bytes.get(key) || 0) + size);
    },
  };
}

/**
 * Every resolution's table from the accumulator, finest first in the
 * rollup but returned coarsest first: [{res, keys, articles, bytes, lat,
 * lon, area}], each sorted by key.
 */
export function buildResolutions({ counts, bytes = null }) {
  const tables = [];
  let current = { counts, bytes };
  for (let res = H3_BASE_RES; res >= 0; res--) {
    const keys = Float64Array.from(current.counts.keys()).sort();
    const n = keys.length;
    const table = {
      res,
      keys,
      articles: new Uint32Array(n),
      bytes: current.bytes ? new Float64Array(n) : null,
      lat: new Float32Array(n),
      lon: new Float32Array(n),
      area: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      const key = keys[i];
      const index = keyToIndex(key, res);
      table.articles[i] = current.counts.get(key);
      if (table.bytes) table.bytes[i] = current.bytes.get(key) || 0;
      const [lat, lon] = h3.cellToLatLng(index);
      table.lat[i] = lat;
      table.lon[i] = lon;
      table.area[i] = h3.cellArea(index, 'km2');
    }
    tables.push(table);
    if (res === 0) break;
    // The next coarser resolution sums each cell into its parent.
    const parentCounts = new Map();
    const parentBytes = current.bytes ? new Map() : null;
    for (let i = 0; i < n; i++) {
      const parent = cellKey(
        h3.cellToParent(keyToIndex(keys[i], res), res - 1),
      );
      parentCounts.set(
        parent,
        (parentCounts.get(parent) || 0) + table.articles[i],
      );
      if (parentBytes)
        parentBytes.set(
          parent,
          (parentBytes.get(parent) || 0) + table.bytes[i],
        );
    }
    current = { counts: parentCounts, bytes: parentBytes };
  }
  return tables.reverse();
}

/** A resolution's ramp domains, from its non-empty cells. */
export function tableDomains(table) {
  const density = [];
  const textDensity = [];
  const counts = [];
  for (let i = 0; i < table.keys.length; i++) {
    counts.push(table.articles[i]);
    density.push(table.articles[i] / table.area[i]);
    if (table.bytes && table.bytes[i] > 0)
      textDensity.push(table.bytes[i] / table.area[i]);
  }
  const ascending = (a, b) => a - b;
  const domain = (values) =>
    values.length
      ? {
          min: quantile(values.sort(ascending), 0.05),
          max: quantile(values, 0.995),
          median: quantile(values, 0.5),
          cells: values.length,
        }
      : null;
  return {
    articles: domain(density),
    text: domain(textDensity),
    count: domain(counts),
  };
}

/**
 * Write the tables to a file.
 * @param {string} file
 * @param {{header: object, tables: Array<object>}} input
 * @returns {{bytes: number, header: object}}
 */
export function writeH3File(file, { header, tables }) {
  const packer = createPacker();
  const resolutions = tables.map((table) => {
    const n = table.keys.length;
    const indexHi = new Uint32Array(n);
    const indexLo = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const hi = Math.floor(table.keys[i] / TWO_32);
      indexHi[i] = MODE_CELL | (table.res << 20) | hi;
      indexLo[i] = table.keys[i] - hi * TWO_32;
    }
    return {
      res: table.res,
      cells: n,
      domains: tableDomains(table),
      arrays: {
        indexHi: packer.place(indexHi, 'u32'),
        indexLo: packer.place(indexLo, 'u32'),
        articles: packer.place(table.articles, 'u32'),
        ...(table.bytes ? { bytes: packer.place(table.bytes, 'f64') } : {}),
        lat: packer.place(table.lat, 'f32'),
        lon: packer.place(table.lon, 'f32'),
        area: packer.place(table.area, 'f32'),
      },
    };
  });
  const full = {
    ...header,
    version: H3_VERSION,
    baseRes: H3_BASE_RES,
    resolutions,
  };
  const { bytes } = packer.write(file, H3_MAGIC, full);
  return { bytes, header: full };
}

/** Open an H3 file: its header, and each resolution's table read when first asked. */
export function openH3File(file) {
  const { header, readArray } = openArrayFile(file, H3_MAGIC, H3_VERSION);
  const held = new Map();
  const hasText = header.resolutions.every((entry) => entry.arrays.bytes);
  return {
    header,
    hasText,
    resolutions: header.resolutions.map((entry) => entry.res),
    /** @returns {{res: number, cells: number, domains: object, indexHi, indexLo, articles, bytes, lat, lon, area}} */
    table(res) {
      if (!held.has(res)) {
        const entry = header.resolutions.find((item) => item.res === res);
        if (!entry) throw new RangeError(`No resolution ${res}`);
        const read = (name) =>
          entry.arrays[name] ? readArray(entry.arrays[name]) : null;
        held.set(res, {
          res,
          cells: entry.cells,
          domains: entry.domains,
          indexHi: read('indexHi'),
          indexLo: read('indexLo'),
          articles: read('articles'),
          bytes: read('bytes'),
          lat: read('lat'),
          lon: read('lon'),
          area: read('area'),
        });
      }
      return held.get(res);
    },
    loaded: () => [...held.keys()].sort(),
  };
}

/** Whether a longitude lies in [west, east], which crosses the antimeridian when west > east. */
export function lonInside(lon, west, east) {
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

/** A bounding box from query strings, or null when it is not one. */
export function parseBbox(query) {
  const read = (name) => {
    const value = query?.[name];
    if (value === undefined || value === null || value === '') return NaN;
    return Number(value);
  };
  const box = {
    west: read('west'),
    south: read('south'),
    east: read('east'),
    north: read('north'),
  };
  if (!Object.values(box).every(Number.isFinite)) return null;
  if (box.south > box.north || box.south < -90 || box.north > 90) return null;
  if (box.west < -180 || box.west > 180 || box.east < -180 || box.east > 180)
    return null;
  return box;
}

/**
 * The cells of a resolution whose centres lie in a bounding box, with the
 * variant's value: a scan of the table's centres (typed arrays, a few ms
 * for the 1.26 M cells of resolution 7), so an ocean-sized box costs the
 * same as a city and nothing is enumerated that is empty.
 * The per-capita variants need `people` (capita.bin's, in the table's
 * order) and leave out the cells under the floor.
 * @returns {{cells: Array<[string, number]>}|{tooMany: number}}
 */
export function queryCells(
  table,
  variant,
  box,
  { maxCells = 20_000, people = null } = {},
) {
  const capita = CAPITA_VARIANTS.includes(variant);
  if (!H3_VARIANTS.includes(variant) && !capita)
    throw new RangeError(`No variant ${variant}`);
  if ((variant === 'text' || variant === 'textcapita') && !table.bytes)
    throw new RangeError('The tables were built without article sizes');
  if (capita && people?.length !== table.lat.length)
    throw new RangeError('No people for these hexagons');
  const cells = [];
  const n = table.lat.length;
  for (let i = 0; i < n; i++) {
    const lat = table.lat[i];
    if (lat < box.south || lat > box.north) continue;
    if (!lonInside(table.lon[i], box.west, box.east)) continue;
    if (capita) {
      const value = capitaValue(
        variant,
        table.articles[i],
        table.bytes?.[i] || 0,
        people[i],
      );
      if (!(value > 0)) continue;
      if (cells.length >= maxCells) return { tooMany: cells.length + 1 };
      cells.push([
        h3.splitLongToH3Index(table.indexLo[i], table.indexHi[i]),
        value,
      ]);
      continue;
    }
    if (cells.length >= maxCells) return { tooMany: cells.length + 1 };
    const value =
      variant === 'count'
        ? table.articles[i]
        : variant === 'text'
          ? table.bytes[i] / table.area[i]
          : table.articles[i] / table.area[i];
    cells.push([
      h3.splitLongToH3Index(table.indexLo[i], table.indexHi[i]),
      value,
    ]);
  }
  return { cells };
}
