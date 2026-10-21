// Personal fork: the Property sales layer's H3 hexagon tables, written by
// `npm run property:build` and read by /api/property. Not part of upstream
// God's Eye View.
import * as h3 from 'h3-js';
import { createPacker, openArrayFile } from '../wikipediaCoverage/arrayFile.js';
import { cellKey, keyToIndex, lonInside } from '../wikipediaCoverage/h3.js';
import { quantile } from '../wikipediaCoverage/grid.js';
import {
  PROPERTY_METRIC_KEYS,
  propertyMetric,
} from '../../../src/data/propertySales.js';

/**
 * One table per resolution (0–7), its non-empty cells sorted by key (the
 * index's low 52 bits, wikipediaCoverage/h3.js cellKey):
 *
 *   key                f64  the cell's key
 *   lat, lon           f32  its centre
 *   properties         u32  records in it (parcels, and units where listed)
 *   sales              u32  records with a sale, any year
 *   price              f32  median last-sale price since 2015 (NaN: too few)
 *   ppsf               f32  median price per square foot, likewise
 *   year               f32  median year built (NaN: too few)
 *
 * The header keeps each resolution's ramp domains.
 */

export const HEX_MAGIC = 'PRH3';
export const HEX_VERSION = 1;
export { cellKey, keyToIndex };

/**
 * The key of a cell's parent: the digits below the parent's resolution
 * set to 7 (unused), with arithmetic, since the key passes 32 bits.
 */
export function parentKey(key, res) {
  const low = 2 ** ((15 - res) * 3);
  return Math.floor(key / low) * low + low - 1;
}

/** A metric's value in a table's row (NaN where there is none). */
export function metricValue(table, metric, i) {
  switch (metric) {
    case 'price':
      return table.price[i];
    case 'ppsf':
      return table.ppsf[i];
    case 'year':
      return table.year[i];
    case 'sales':
      return table.sales[i] || NaN;
    case 'properties':
      return table.properties[i] || NaN;
    default:
      throw new RangeError(`No metric ${metric}`);
  }
}

/** A table's ramp domains, one per metric, from its non-empty cells. */
export function tableDomains(table) {
  const out = {};
  for (const metric of PROPERTY_METRIC_KEYS) {
    const values = [];
    for (let i = 0; i < table.key.length; i++) {
      const value = metricValue(table, metric, i);
      if (Number.isFinite(value) && value > 0) values.push(value);
    }
    values.sort((a, b) => a - b);
    const linear = propertyMetric(metric).scale === 'linear';
    out[metric] = values.length
      ? {
          min: quantile(values, linear ? 0.02 : 0.05),
          max: quantile(values, linear ? 0.98 : 0.995),
          median: quantile(values, 0.5),
          cells: values.length,
        }
      : null;
  }
  return out;
}

/**
 * Write the tables: [{res, key, lat, lon, properties, sales, price, ppsf,
 * year}], each sorted by key.
 */
export function writeHexFile(file, { header, tables }) {
  const packer = createPacker();
  const resolutions = tables.map((table) => ({
    res: table.res,
    cells: table.key.length,
    domains: tableDomains(table),
    arrays: {
      key: packer.place(table.key, 'f64'),
      lat: packer.place(table.lat, 'f32'),
      lon: packer.place(table.lon, 'f32'),
      properties: packer.place(table.properties, 'u32'),
      sales: packer.place(table.sales, 'u32'),
      price: packer.place(table.price, 'f32'),
      ppsf: packer.place(table.ppsf, 'f32'),
      year: packer.place(table.year, 'f32'),
    },
  }));
  const full = { ...header, version: HEX_VERSION, resolutions };
  const { bytes } = packer.write(file, HEX_MAGIC, full);
  return { bytes, header: full };
}

/** Open a hex file: its header, each resolution's table read when first asked. */
export function openHexFile(file) {
  const { header, readArray } = openArrayFile(file, HEX_MAGIC, HEX_VERSION);
  const held = new Map();
  return {
    header,
    resolutions: header.resolutions.map((entry) => entry.res),
    domains: (res) =>
      header.resolutions.find((entry) => entry.res === res)?.domains || null,
    table(res) {
      if (!held.has(res)) {
        const entry = header.resolutions.find((item) => item.res === res);
        if (!entry) throw new RangeError(`No resolution ${res}`);
        const table = { res, cells: entry.cells, domains: entry.domains };
        for (const [name, array] of Object.entries(entry.arrays))
          table[name] = readArray(array);
        held.set(res, table);
      }
      return held.get(res);
    },
  };
}

/**
 * The cells of a resolution whose centres lie in a box, with a metric's
 * value: [[index, value]], or {tooMany} past `maxCells`.
 */
export function queryHexCells(table, metric, box, { maxCells = 20_000 } = {}) {
  const cells = [];
  const res = table.res;
  for (let i = 0; i < table.key.length; i++) {
    const lat = table.lat[i];
    if (lat < box.south || lat > box.north) continue;
    if (!lonInside(table.lon[i], box.west, box.east)) continue;
    const value = metricValue(table, metric, i);
    if (!Number.isFinite(value)) continue;
    if (cells.length >= maxCells) return { tooMany: cells.length + 1 };
    cells.push([keyToIndex(table.key[i], res), value]);
  }
  return { cells };
}

/** A table's row for a key (binary search), or -1. */
export function rowOfKey(table, key) {
  let lo = 0;
  let hi = table.key.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = table.key[mid];
    if (at === key) return mid;
    if (at < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** A metric's value at a point (its cell at the table's resolution), or NaN. */
export function valueAt(table, metric, lat, lon) {
  const row = rowOfKey(table, cellKey(h3.latLngToCell(lat, lon, table.res)));
  return row < 0 ? NaN : metricValue(table, metric, row);
}
