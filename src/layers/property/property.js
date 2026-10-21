// Personal fork: the pure parts of the Property sales layer (index.js): a
// metric's colour, the answers checked on the way in, the query box, and a
// tax history as a sparkline. No Cesium, no DOM.

import { RAMP_STOPS, rampColor } from '../wikipediaCoverage/ramp.js';
import {
  PROPERTY_METRIC_KEYS,
  PROPERTY_TYPES,
  propertyMetric,
} from '../../data/propertySales.js';

export { RAMP_STOPS };
export { pinQueryBox, boxCovers } from '../places/places.js';

/**
 * Where a value sits on a metric's ramp, 0 to 1 (log for prices and
 * counts, linear for years), or NaN when it draws nothing.
 */
export function metricPosition(metric, value, domain) {
  if (!(value > 0) || !domain || !(domain.max > domain.min)) return NaN;
  const linear = propertyMetric(metric)?.scale === 'linear';
  if (!linear && !(domain.min > 0)) return NaN;
  const t = linear
    ? (value - domain.min) / (domain.max - domain.min)
    : (Math.log(value) - Math.log(domain.min)) /
      (Math.log(domain.max) - Math.log(domain.min));
  return Math.min(1, Math.max(0, t));
}

/** A metric value's colour, [r, g, b, a] in 0–255 (transparent for none). */
export function metricColor(metric, value, domain) {
  return rampColor(metricPosition(metric, value, domain));
}

/** `#rrggbb` for a ramp position. */
export const rampHex = (t) => {
  const [r, g, b] = rampColor(t);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Legend stops for a metric's domain: five swatches at equal steps on its
 * scale, with their values.
 * @returns {Array<{value: number, color: string}>}
 */
export function legendValues(metric, domain) {
  if (!domain || !(domain.max > domain.min)) return [];
  const linear = propertyMetric(metric)?.scale === 'linear';
  if (!linear && !(domain.min > 0)) return [];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const value = linear
      ? domain.min + t * (domain.max - domain.min)
      : Math.exp(
          Math.log(domain.min) +
            t * (Math.log(domain.max) - Math.log(domain.min)),
        );
    out.push({ value, color: rampHex(t) });
  }
  return out;
}

/** A building's value for a metric (the pin's own numbers). */
export function buildingValue(metric, building) {
  switch (metric) {
    case 'price':
      return building.recent ? building.price : NaN;
    case 'ppsf':
      return building.recent && building.sqft
        ? building.price / building.sqft
        : NaN;
    case 'year':
      return building.year || NaN;
    case 'sales':
      return building.price ? 1 : NaN;
    case 'properties':
      return building.units;
    default:
      return NaN;
  }
}

const TYPE_KEYS = new Set(PROPERTY_TYPES.map((type) => type.key));
const short = (value, max) =>
  typeof value === 'string' && value.length <= max ? value : '';
const count = (value, max = 1e12) =>
  Number.isFinite(value) && value >= 0 && value <= max ? value : null;

/** A server building (pin), checked, or null. */
export function normalizeBuilding(raw) {
  const id = short(raw?.id, 40);
  const [lon, lat] = Array.isArray(raw?.at) ? raw.at.map(Number) : [];
  if (
    !/^pr:\d+:\d+:\d+$/.test(id) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return {
    id,
    at: [lon, lat],
    units: count(raw.units, 65535) || 1,
    type: TYPE_KEYS.has(raw.type) ? raw.type : '',
    price: count(raw.price) || 0,
    sold: /^\d{4}-\d{2}$/.test(String(raw.sold || '')) ? raw.sold : '',
    recent: raw.recent === true,
    year: count(raw.year, 2100) || 0,
    sqft: count(raw.sqft) || 0,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One record of a building's answer, checked. */
function normalizeRecord(raw) {
  const sale = (entry) =>
    entry && DATE.test(String(entry.date)) && count(entry.price)
      ? { date: entry.date, price: entry.price }
      : null;
  return {
    street: short(raw?.street, 200),
    unit: short(raw?.unit, 40),
    type: TYPE_KEYS.has(raw?.type) ? raw.type : '',
    beds: count(raw?.beds, 99),
    baths: count(raw?.baths, 99),
    sqft: count(raw?.sqft),
    lot: count(raw?.lot),
    year: count(raw?.year, 2100),
    apn: short(raw?.apn, 40),
    sold: sale(raw?.sold),
    sales: (Array.isArray(raw?.sales) ? raw.sales : [])
      .map(sale)
      .filter(Boolean),
    tax: (Array.isArray(raw?.tax) ? raw.tax : [])
      .filter((entry) => Number.isInteger(entry?.year))
      .map((entry) => ({
        year: entry.year,
        amount: count(entry.amount),
        assessment: count(entry.assessment),
      })),
  };
}

/** A building's answer, checked, or null. */
export function normalizeBuildingDetail(raw) {
  const pin = normalizeBuilding({ ...raw, units: raw?.units });
  if (!pin) return null;
  const records = (Array.isArray(raw.records) ? raw.records : []).map(
    normalizeRecord,
  );
  if (!records.length) return null;
  const county = raw.county || {};
  // The building's type: its records' most common.
  const types = new Map();
  for (const record of records)
    if (record.type) types.set(record.type, (types.get(record.type) || 0) + 1);
  const type = [...types].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return {
    ...pin,
    type,
    address: {
      street: short(raw.address?.street, 200),
      city: short(raw.address?.city, 60),
      state: short(raw.address?.state, 2),
      zip: short(raw.address?.zip, 10),
    },
    stacked: raw.stacked === true,
    county: /^\d{5}$/.test(String(county.fips || ''))
      ? {
          fips: county.fips,
          name: short(county.name, 80),
          state: short(county.state, 2),
        }
      : null,
    records,
    more: count(raw.more) || 0,
  };
}

const BARS = '▁▂▃▄▅▆▇█';

/**
 * Assessments (or any values) as a text sparkline, one bar a year, the
 * lowest ▁ and the highest █; '' with fewer than two values.
 */
export function sparkline(values) {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length < 2) return '';
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return ' ';
      const t = high > low ? (v - low) / (high - low) : 0.5;
      return BARS[Math.min(BARS.length - 1, Math.round(t * (BARS.length - 1)))];
    })
    .join('');
}

/** The metric keys, for the chips. */
export const METRIC_KEYS = PROPERTY_METRIC_KEYS;
