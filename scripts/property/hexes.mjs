import * as h3 from 'h3-js';
import {
  keyToIndex,
  parentKey,
} from '../../server/providers/property/hexFile.js';
import { MEDIAN_MIN_VALUES } from '../../src/data/propertySales.js';
import { PARTITION_RES, STAT_BYTES, STAT_RES, readSpill } from './parts.mjs';

/**
 * The property build's hexagons. Each resolution-3 cell's records (one
 * partition, from every part) give exact medians for it and its
 * descendants (resolutions 3–7); the coarser resolutions (0–2), whose
 * cells hold millions of records, are summed from histograms: prices and
 * prices per square foot in log bins (1.35% and 1.12% wide), years built
 * in one bin a year.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const FINE_RESOLUTIONS = Object.freeze([3, 4, 5, 6, 7]);
export const COARSE_RESOLUTIONS = Object.freeze([0, 1, 2]);
export const HISTOGRAM = Object.freeze({
  price: Object.freeze({ bins: 1024, low: 3, decades: 6 }), // $1k–$1B
  ppsf: Object.freeze({ bins: 1024, low: 0, decades: 5 }), // $1–$100k
  year: Object.freeze({ bins: 431, first: 1600 }), // 1600–2030
});

/** A value's histogram bin (log bins; years one a bin), or -1. */
export function binOf(kind, value) {
  if (!(value > 0)) return -1;
  const spec = HISTOGRAM[kind];
  if (kind === 'year') {
    const bin = Math.round(value) - spec.first;
    return bin >= 0 && bin < spec.bins ? bin : -1;
  }
  const t = (Math.log10(value) - spec.low) / spec.decades;
  return Math.min(spec.bins - 1, Math.max(0, Math.floor(t * spec.bins)));
}

/** A bin's value: its geometric middle (log bins) or its year. */
export function valueOfBin(kind, bin) {
  const spec = HISTOGRAM[kind];
  if (kind === 'year') return spec.first + bin;
  return 10 ** (spec.low + ((bin + 0.5) / spec.bins) * spec.decades);
}

/** A histogram's median (the lower middle), or NaN under MEDIAN_MIN_VALUES. */
export function histogramMedian(kind, counts) {
  let total = 0;
  for (const n of counts) total += n;
  if (total < MEDIAN_MIN_VALUES) return NaN;
  const want = Math.floor((total - 1) / 2) + 1;
  let seen = 0;
  for (let bin = 0; bin < counts.length; bin++) {
    seen += counts[bin];
    if (seen >= want) return valueOfBin(kind, bin);
  }
  return NaN;
}

/** The lower middle of a sorted list, or NaN under MEDIAN_MIN_VALUES. */
export function sortedMedian(sorted, from, to) {
  const n = to - from;
  if (n < MEDIAN_MIN_VALUES) return NaN;
  return sorted[from + Math.floor((n - 1) / 2)];
}

/** An empty set of coarse histograms. */
export const emptyHistograms = () => ({
  properties: 0,
  sales: 0,
  price: new Uint32Array(HISTOGRAM.price.bins),
  ppsf: new Uint32Array(HISTOGRAM.ppsf.bins),
  year: new Uint32Array(HISTOGRAM.year.bins),
});

/** Add one set of histograms into another. */
export function addHistograms(into, from) {
  into.properties += from.properties;
  into.sales += from.sales;
  for (const kind of ['price', 'ppsf', 'year'])
    for (let i = 0; i < from[kind].length; i++) into[kind][i] += from[kind][i];
  return into;
}

/** Stat records (STAT_BYTES each) as columns. */
export function statColumns(buffers) {
  let n = 0;
  for (const buf of buffers) n += buf.length / STAT_BYTES;
  const out = {
    key: new Float64Array(n),
    price: new Float32Array(n),
    ppsf: new Float32Array(n),
    year: new Uint16Array(n),
    sold: new Uint8Array(n),
  };
  let i = 0;
  for (const buf of buffers)
    for (let at = 0; at < buf.length; at += STAT_BYTES, i++) {
      out.key[i] = buf.readDoubleLE(at);
      out.price[i] = buf.readFloatLE(at + 8);
      out.ppsf[i] = buf.readFloatLE(at + 12);
      out.year[i] = buf.readUInt16LE(at + 16);
      out.sold[i] = buf[at + 18];
    }
  return out;
}

/**
 * One partition's cells: for each fine resolution its rows {key,
 * properties, sales, price, ppsf, year} (medians exact), and the
 * partition's own histograms for the coarse resolutions.
 */
export function aggregatePartition(columns) {
  const n = columns.key.length;
  const rows = {};
  // A parent's key never decreases with its child's, so one sort by the
  // resolution-7 key orders every resolution's cells.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => columns.key[a] - columns.key[b]);
  const parents = new Float64Array(n);
  for (const res of FINE_RESOLUTIONS) {
    for (let i = 0; i < n; i++)
      parents[i] =
        res === STAT_RES ? columns.key[i] : parentKey(columns.key[i], res);
    const out = [];
    const prices = [];
    const ppsf = [];
    const years = [];
    let start = 0;
    while (start < n) {
      const key = parents[order[start]];
      let end = start;
      let sales = 0;
      prices.length = 0;
      ppsf.length = 0;
      years.length = 0;
      while (end < n && parents[order[end]] === key) {
        const i = order[end];
        if (columns.sold[i]) sales += 1;
        if (columns.price[i] > 0) prices.push(columns.price[i]);
        if (columns.ppsf[i] > 0) ppsf.push(columns.ppsf[i]);
        if (columns.year[i] > 0) years.push(columns.year[i]);
        end += 1;
      }
      const median = (values) =>
        sortedMedian(
          values.sort((a, b) => a - b),
          0,
          values.length,
        );
      out.push({
        key,
        properties: end - start,
        sales,
        price: median(prices),
        ppsf: median(ppsf),
        year: median(years),
      });
      start = end;
    }
    rows[res] = out;
  }
  const histograms = emptyHistograms();
  histograms.properties = n;
  for (let i = 0; i < n; i++) {
    if (columns.sold[i]) histograms.sales += 1;
    const bins = [
      ['price', columns.price[i]],
      ['ppsf', columns.ppsf[i]],
      ['year', columns.year[i]],
    ];
    for (const [kind, value] of bins) {
      const bin = binOf(kind, value);
      if (bin >= 0) histograms[kind][bin] += 1;
    }
  }
  return { rows, histograms };
}

/** A partition's cells from its spill file. */
export function aggregatePartitionSpill(spill) {
  return aggregatePartition(statColumns(readSpill(spill)));
}

/**
 * The coarse resolutions' rows from each partition's histograms (Map
 * partition key → histograms): {0: rows, 1: rows, 2: rows}.
 */
export function coarseRows(partitionHistograms) {
  const out = {};
  for (const res of COARSE_RESOLUTIONS) {
    const cells = new Map();
    for (const [key, histograms] of partitionHistograms) {
      const parent = parentKey(key, res);
      if (!cells.has(parent)) cells.set(parent, emptyHistograms());
      addHistograms(cells.get(parent), histograms);
    }
    out[res] = [...cells].map(([key, h]) => ({
      key,
      properties: h.properties,
      sales: h.sales,
      price: histogramMedian('price', h.price),
      ppsf: histogramMedian('ppsf', h.ppsf),
      year: histogramMedian('year', h.year),
    }));
  }
  return out;
}

/** Rows of one resolution as a hex table (hexFile.js), sorted by key. */
export function tableOf(res, rows) {
  const sorted = [...rows].sort((a, b) => a.key - b.key);
  const n = sorted.length;
  const table = {
    res,
    key: new Float64Array(n),
    lat: new Float32Array(n),
    lon: new Float32Array(n),
    properties: new Uint32Array(n),
    sales: new Uint32Array(n),
    price: new Float32Array(n),
    ppsf: new Float32Array(n),
    year: new Float32Array(n),
  };
  sorted.forEach((row, i) => {
    const [lat, lon] = h3.cellToLatLng(keyToIndex(row.key, res));
    table.key[i] = row.key;
    table.lat[i] = lat;
    table.lon[i] = lon;
    table.properties[i] = row.properties;
    table.sales[i] = row.sales;
    table.price[i] = row.price;
    table.ppsf[i] = row.ppsf;
    table.year[i] = row.year;
  });
  return table;
}

export { PARTITION_RES };
