import { rowsOfFlat, rowsOfRepeated } from '../overture/parquet.mjs';
import { dayOf } from '../../server/providers/property/file.js';
import {
  PRICE_FLOOR_USD,
  PRICE_SINCE_YEAR,
  propertyTypeCode,
} from '../../src/data/propertySales.js';
import { placeCheck } from '../../server/providers/property/counties.js';

/**
 * The property build's rows: the public-record columns of a
 * realestatedataset.com row group, read and cleaned into records. Only
 * these columns are read: the listing fields (status, list_price,
 * listing_type, hoa_fee, the amenities) and price_history's events other
 * than sales come from listing portals, and the publisher's CC0 cannot
 * cover them.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const FLAT_COLUMNS = Object.freeze([
  'street',
  'unit',
  'city',
  'state',
  'zip',
  'lat',
  'lng',
  'property_type',
  'beds',
  'baths',
  'sqft',
  'lot_sqft',
  'year_built',
  'last_sold_price',
  'last_sold_date',
  'parcel_apn',
  'county_fips',
]);
export const LIST_COLUMNS = Object.freeze([
  'price_history.list.element.date',
  'price_history.list.element.event',
  'price_history.list.element.price',
  'tax_history.list.element.year',
  'tax_history.list.element.amount',
  'tax_history.list.element.assessment',
]);
/** Tax years kept per record, the newest. */
export const TAX_YEARS_KEPT = 12;
/** Sales kept per record from its price history, the newest. */
export const SALES_KEPT = 10;
/** The first year a tax entry may have. */
export const FIRST_TAX_YEAR = 1990;
const PRICE_SINCE_DAY = dayOf(`${PRICE_SINCE_YEAR}-01-01`);
/** Days to 1901-01-01: a sale before it is the source's "1900" placeholder. */
const FIRST_SALE_DAY = dayOf('1901-01-01');

/** The NYC boroughs' digit in a BBL, by county FIPS. */
export const NYC_BOROUGHS = Object.freeze({
  36061: '1', // Manhattan (New York County)
  36005: '2', // Bronx
  36047: '3', // Brooklyn (Kings)
  36081: '4', // Queens
  36085: '5', // Staten Island (Richmond)
});
const COOK = '17031';

/**
 * A parcel number in its county's own form: Cook County's 14-digit PIN
 * (the source drops the trailing "0000" of most), as 12-34-567-890-1234;
 * New York City's BBL (the source gives block and lot without the
 * borough), as 1-00030-0018; elsewhere as given, trimmed.
 */
export function normalizeApn(apn, county) {
  const text = String(apn ?? '').trim();
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  if (county === COOK && /^\d{10}(\d{4})?$/.test(digits)) {
    const pin = digits.length === 10 ? `${digits}0000` : digits;
    return `${pin.slice(0, 2)}-${pin.slice(2, 4)}-${pin.slice(4, 7)}-${pin.slice(7, 10)}-${pin.slice(10)}`;
  }
  const borough = NYC_BOROUGHS[county];
  if (borough && /^\d{9,10}$/.test(digits)) {
    const bbl = digits.length === 9 ? `${borough}${digits}` : digits;
    if (bbl[0] === borough)
      return `${bbl[0]}-${bbl.slice(1, 6)}-${bbl.slice(6)}`;
  }
  return text.slice(0, 40);
}

const UNIT_TAIL =
  /^(.*\S)\s+(?:(?:APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|RM|ROOM|BLDG|PH|SPC|SPACE|LOT|TRLR|DEPT)\.?\s*#?\s*|#\s*)([A-Z]?\d[A-Z0-9-]*|[A-Z])$/i;

/**
 * A street and unit apart: the unit column when given, else a unit
 * designator at the end of the street ("929 W End Ave APT 4B", "218
 * Plymouth St #3A", how the source writes New York's units).
 */
export function splitUnit(street, unit) {
  const text = String(street ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const given = String(unit ?? '').trim();
  const match = UNIT_TAIL.exec(text);
  if (match && match[1].includes(' ')) {
    return { street: match[1], unit: given || match[2].toUpperCase() };
  }
  return { street: text, unit: given };
}

/** The key that groups a building's records: the street without unit, and the ZIP. */
export function addressKey(street, zip) {
  const base = String(street || '')
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base ? `${base}|${String(zip || '').slice(0, 5)}` : '';
}

const intIn = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : null;

/**
 * One row's record, cleaned, or {drop: reason}. `today` is a day count
 * (dayOf): later sales are dropped as well as the "1900" placeholders.
 * Returns {record, lat, lon, key, stats: {price, ppsf, year, sold}}.
 */
export function cleanRow(row, { counties, today, thisYear }) {
  const lat = row.lat;
  const lon = row.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return { drop: 'noCoordinates' };
  const county = /^\d{5}$/.test(String(row.county_fips || ''))
    ? row.county_fips
    : '';
  const state = /^[A-Z]{2}$/.test(String(row.state || '')) ? row.state : '';
  if (!placeCheck(counties, { lat, lon, county, state }))
    return { drop: 'outside' };
  const { street, unit } = splitUnit(row.street, row.unit);
  const record = {
    street,
    unit,
    city: String(row.city || '')
      .trim()
      .slice(0, 60),
    state,
    zip: String(row.zip || '')
      .trim()
      .slice(0, 10),
    apn: normalizeApn(row.parcel_apn, county),
    county,
    type: propertyTypeCode(row.property_type),
    beds: intIn(row.beds, 0, 99),
    baths2: intIn(Number(row.baths) * 2, 0, 198),
    sqft: intIn(row.sqft, 100, 2_000_000),
    lot: intIn(row.lot_sqft, 1, 1e9),
    year: intIn(row.year_built, 1600, thisYear + 2),
    soldPrice: null,
    soldDay: null,
    tax: [],
    sales: [],
  };
  if (!record.type) delete record.type;
  const soldDay = dayOf(row.last_sold_date);
  const soldPrice = intIn(row.last_sold_price, 1, 1e11);
  let placeholder = false;
  if (soldDay !== null && soldPrice !== null) {
    if (soldDay >= FIRST_SALE_DAY && soldDay <= today) {
      record.soldDay = soldDay;
      record.soldPrice = soldPrice;
    } else placeholder = true;
  }
  // The price history's sales only; every other event is a listing's.
  const sales = new Map();
  const events = row.events || [];
  for (let i = 0; i < events.length; i++) {
    if (events[i] !== 'sold') continue;
    const day = dayOf(row.eventDates[i]);
    const price = intIn(row.eventPrices[i], 1, 1e11);
    if (day === null || price === null || day < FIRST_SALE_DAY || day > today)
      continue;
    sales.set(`${day}|${price}`, { day, price });
  }
  record.sales = [...sales.values()]
    .sort((a, b) => a.day - b.day)
    .slice(-SALES_KEPT);
  const tax = new Map();
  const years = row.taxYears || [];
  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    if (!(year >= FIRST_TAX_YEAR && year <= thisYear + 1)) continue;
    tax.set(year, {
      year,
      amount: intIn(row.taxAmounts[i], 0, 1e11),
      assessment: intIn(row.taxAssessments[i], 0, 1e12),
    });
  }
  record.tax = [...tax.values()]
    .sort((a, b) => a.year - b.year)
    .slice(-TAX_YEARS_KEPT);
  for (const name of Object.keys(record))
    if (record[name] === null || record[name] === '') delete record[name];
  const recent =
    record.soldDay >= PRICE_SINCE_DAY && record.soldPrice >= PRICE_FLOOR_USD;
  const ppsf = recent && record.sqft ? record.soldPrice / record.sqft : NaN;
  return {
    record,
    lat,
    lon,
    key: addressKey(street, record.zip),
    placeholder,
    stats: {
      price: recent ? record.soldPrice : 0,
      ppsf: ppsf >= 1 && ppsf <= 100_000 ? ppsf : 0,
      year: record.year || 0,
      sold: record.soldDay !== undefined || record.sales.length > 0,
    },
  };
}

const text = (value) =>
  value === null || value === undefined ? null : Buffer.from(value).toString();

/**
 * A row group's rows, as plain objects of the columns read (strings
 * decoded, lists per row).
 * @param {{rowGroups: Array, leaf: Function, column: Function}} parquet openParquet's
 */
export function readRows(parquet, group) {
  const n = parquet.rowGroups[group].rows;
  const flat = {};
  for (const path of FLAT_COLUMNS)
    flat[path] = rowsOfFlat(parquet.column(group, path), parquet.leaf(path), n);
  const lists = {};
  for (const path of LIST_COLUMNS)
    lists[path] = rowsOfRepeated(
      parquet.column(group, path),
      parquet.leaf(path),
    );
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      street: text(flat.street[i]),
      unit: text(flat.unit[i]),
      city: text(flat.city[i]),
      state: text(flat.state[i]),
      zip: text(flat.zip[i]),
      lat: flat.lat[i],
      lng: flat.lng[i],
      property_type: text(flat.property_type[i]),
      beds: flat.beds[i],
      baths: flat.baths[i],
      sqft: flat.sqft[i],
      lot_sqft: flat.lot_sqft[i],
      year_built: flat.year_built[i],
      last_sold_price: flat.last_sold_price[i],
      last_sold_date: text(flat.last_sold_date[i]),
      parcel_apn: text(flat.parcel_apn[i]),
      county_fips: text(flat.county_fips[i]),
      eventDates: (lists['price_history.list.element.date'][i] || []).map(text),
      events: (lists['price_history.list.element.event'][i] || []).map(text),
      eventPrices: lists['price_history.list.element.price'][i] || [],
      taxYears: lists['tax_history.list.element.year'][i] || [],
      taxAmounts: lists['tax_history.list.element.amount'][i] || [],
      taxAssessments: lists['tax_history.list.element.assessment'][i] || [],
    };
  }
  return rows;
}
