// Personal fork: the property build (scripts/property/) on rows made here,
// not the Parquet file: cleaning, parcel numbers, units, the parts, the
// buildings a bucket keeps and the hexagons' medians.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as h3 from 'h3-js';
import {
  addressKey,
  cleanRow,
  normalizeApn,
  splitUnit,
} from '../../scripts/property/rows.mjs';
import { placeCheck } from '../../server/providers/property/counties.js';
import {
  compressSections,
  createSpill,
  eachSectionRecord,
  partitionRows,
  readSpill,
} from '../../scripts/property/parts.mjs';
import {
  collapseBuildings,
  mergePropertyBucket,
} from '../../scripts/property/merge.mjs';
import {
  aggregatePartition,
  binOf,
  coarseRows,
  histogramMedian,
  statColumns,
  tableOf,
} from '../../scripts/property/hexes.mjs';
import { parseGroups } from '../../scripts/property/build.mjs';
import {
  PIN_BYTES,
  PROPERTY_KIND,
  RecordReader,
  RecordWriter,
  dateOfDay,
  dayOf,
  decodePin,
  decodeRecord,
  detailBlockOf,
  eachBuildingRecords,
  encodeRecord,
  monthText,
  pinBlockOf,
} from '../../server/providers/property/file.js';
import {
  cellKey,
  keyToIndex,
  openHexFile,
  parentKey,
  queryHexCells,
  valueAt,
  writeHexFile,
} from '../../server/providers/property/hexFile.js';
import {
  bucketWriter,
  openBucket,
} from '../../server/providers/overture/buildingsFile.js';

const COUNTIES = {
  byGeoid: new Map([
    [
      '17031',
      { name: 'Cook County', st: 'IL', box: [-88.3, 41.4, -87.5, 42.2] },
    ],
    [
      '36047',
      { name: 'Kings County', st: 'NY', box: [-74.1, 40.5, -73.8, 40.8] },
    ],
  ]),
  byState: new Map([
    ['IL', [-91.6, 36.9, -87.0, 42.6]],
    ['NY', [-79.8, 40.4, -71.8, 45.1]],
  ]),
};
const TODAY = dayOf('2026-10-21');
const OPTIONS = { counties: COUNTIES, today: TODAY, thisYear: 2026 };

/** A row as readRows gives it, Cook County by default. */
const row = (fields = {}) => ({
  street: '444 Regent Dr',
  unit: null,
  city: 'Inverness',
  state: 'IL',
  zip: '60067',
  lat: 42.1,
  lng: -88.1,
  property_type: 'single_family',
  beds: 4,
  baths: 2.5,
  sqft: 2000,
  lot_sqft: 9000,
  year_built: 1988,
  last_sold_price: 450_000,
  last_sold_date: '2021-06-28',
  parcel_apn: '0305309008',
  county_fips: '17031',
  eventDates: [],
  events: [],
  eventPrices: [],
  taxYears: [],
  taxAmounts: [],
  taxAssessments: [],
  ...fields,
});

test('parcel numbers: Cook PINs get their 0000 back, New York gets its borough', () => {
  assert.equal(normalizeApn('0305309008', '17031'), '03-05-309-008-0000');
  assert.equal(normalizeApn('03053090080000', '17031'), '03-05-309-008-0000');
  assert.equal(normalizeApn('03053090081001', '17031'), '03-05-309-008-1001');
  assert.equal(normalizeApn('000300018', '36047'), '3-00030-0018');
  assert.equal(normalizeApn('000300018', '36061'), '1-00030-0018');
  assert.equal(normalizeApn('3000300018', '36047'), '3-00030-0018');
  // A 10-digit number of another borough is not rewritten.
  assert.equal(normalizeApn('1000300018', '36047'), '1000300018');
  assert.equal(normalizeApn(' 123-456-78 ', '06037'), '123-456-78');
  assert.equal(normalizeApn(null, '17031'), '');
});

test('units come off the street, and only real unit designators', () => {
  assert.deepEqual(splitUnit('929 W End Ave APT 4B'), {
    street: '929 W End Ave',
    unit: '4B',
  });
  assert.deepEqual(splitUnit('218 Plymouth St #3A'), {
    street: '218 Plymouth St',
    unit: '3A',
  });
  assert.deepEqual(splitUnit('510 E 5th St APT D'), {
    street: '510 E 5th St',
    unit: 'D',
  });
  assert.deepEqual(splitUnit('12 Lot Rd'), { street: '12 Lot Rd', unit: '' });
  assert.deepEqual(splitUnit('7 Union Street Ext'), {
    street: '7 Union Street Ext',
    unit: '',
  });
  assert.deepEqual(splitUnit('40 Main St', '2R'), {
    street: '40 Main St',
    unit: '2R',
  });
  assert.equal(
    addressKey('929 W End Ave', '10025-1234'),
    '929 W END AVE|10025',
  );
  assert.equal(addressKey('', '10025'), '');
});

test('coordinates are checked against the county, then the state', () => {
  assert.equal(
    placeCheck(COUNTIES, { lat: 42, lon: -88, county: '17031', state: 'IL' }),
    'county',
  );
  // Outside Cook but in Illinois: kept.
  assert.equal(
    placeCheck(COUNTIES, { lat: 40, lon: -89, county: '17031', state: 'IL' }),
    'state',
  );
  // An Illinois record in Toronto: dropped.
  assert.equal(
    placeCheck(COUNTIES, {
      lat: 43.7,
      lon: -79.4,
      county: '17031',
      state: 'IL',
    }),
    null,
  );
  assert.equal(
    placeCheck(COUNTIES, { lat: 41, lon: -75, county: '', state: '' }),
    'us',
  );
  assert.equal(
    placeCheck(COUNTIES, { lat: 51.5, lon: -0.1, county: '', state: '' }),
    null,
  );
});

test('a row keeps its public-record fields; placeholders, listings and strays go', () => {
  assert.equal(cleanRow(row({ lat: null }), OPTIONS).drop, 'noCoordinates');
  assert.equal(
    cleanRow(row({ lat: 43.7, lng: -79.4 }), OPTIONS).drop,
    'outside',
  );
  const cleaned = cleanRow(
    row({
      events: ['listed', 'sold', 'price_change', 'sold', 'sold', 'pending'],
      eventDates: [
        '2021-01-02',
        '2021-06-28',
        '2021-03-01',
        '1900-01-01',
        '2014-05-05',
        '2021-04-01',
      ],
      eventPrices: [499_000, 450_000, 479_000, 1, 300_000, 470_000],
      taxYears: [2024, 1985, 2023, 2024],
      taxAmounts: [9000, 100, 8800, 9100],
      taxAssessments: [150_000, 1000, 145_000, 151_000],
    }),
    OPTIONS,
  );
  const { record } = cleaned;
  assert.equal(record.apn, '03-05-309-008-0000');
  assert.equal(record.type, 1);
  assert.equal(record.baths2, 5);
  assert.equal(record.soldPrice, 450_000);
  assert.equal(dateOfDay(record.soldDay), '2021-06-28');
  // Only the sales, oldest first, without the 1900 placeholder.
  assert.deepEqual(
    record.sales.map((s) => [dateOfDay(s.day), s.price]),
    [
      ['2014-05-05', 300_000],
      ['2021-06-28', 450_000],
    ],
  );
  // One entry a year (the last given), from 1990, oldest first.
  assert.deepEqual(record.tax, [
    { year: 2023, amount: 8800, assessment: 145_000 },
    { year: 2024, amount: 9100, assessment: 151_000 },
  ]);
  for (const listing of ['status', 'list_price', 'listing_type', 'hoa_fee'])
    assert.equal(listing in record, false);
  assert.deepEqual(cleaned.stats, {
    price: 450_000,
    ppsf: 225,
    year: 1988,
    sold: true,
  });

  const placeholder = cleanRow(
    row({ last_sold_date: '1900-01-01', last_sold_price: 1 }),
    OPTIONS,
  );
  assert.equal(placeholder.placeholder, true);
  assert.equal('soldPrice' in placeholder.record, false);
  assert.equal(placeholder.stats.sold, false);
  // A sale before 2015 counts as a sale but not in the prices; so does a
  // nominal transfer.
  const old = cleanRow(row({ last_sold_date: '2012-03-13' }), OPTIONS);
  assert.deepEqual([old.stats.price, old.stats.sold], [0, true]);
  const nominal = cleanRow(row({ last_sold_price: 10 }), OPTIONS);
  assert.deepEqual([nominal.stats.price, nominal.stats.sold], [0, true]);
  const future = cleanRow(row({ last_sold_date: '2027-01-01' }), OPTIONS);
  assert.equal(future.record.soldPrice, undefined);
  assert.equal(future.placeholder, true);
  // A year built out of range is dropped, not clamped.
  assert.equal(
    cleanRow(row({ year_built: 0 }), OPTIONS).record.year,
    undefined,
  );
});

test('records round-trip, prices past 2^32 and missing tax amounts included', () => {
  const writer = new RecordWriter(8);
  const records = [
    {
      street: '1 Main St',
      unit: '4B',
      zip: '10001',
      type: 2,
      soldPrice: 12_500_000_000,
      soldDay: dayOf('2019-05-01'),
      tax: [
        { year: 2020, amount: null, assessment: 5_000_000_000 },
        { year: 2021, amount: 120_000, assessment: 4_900_000_000 },
      ],
      sales: [
        { day: dayOf('2001-01-01'), price: 900_000 },
        { day: dayOf('2019-05-01'), price: 12_500_000_000 },
      ],
    },
    { street: 'Café ✓ Rd' },
  ];
  for (const record of records) encodeRecord(writer, record);
  const reader = new RecordReader(writer.done());
  assert.deepEqual(decodeRecord(reader), records[0]);
  assert.deepEqual(decodeRecord(reader), records[1]);
  assert.equal(reader.pos, writer.done().length);
  assert.equal(monthText(0), '');
});

test('a parent key matches H3 at every resolution', () => {
  for (const [lat, lon] of [
    [40.69, -73.99],
    [41.88, -87.63],
    [21.3, -157.85],
    [61.2, -149.9],
  ]) {
    const cell = h3.latLngToCell(lat, lon, 7);
    for (let res = 0; res <= 7; res++)
      assert.equal(
        keyToIndex(parentKey(cellKey(cell), res), res),
        h3.cellToParent(cell, res),
      );
  }
});

/** Rows for one block of Brooklyn: a building of units, a house, a stack. */
function brooklynRows() {
  const base = {
    city: 'Brooklyn',
    state: 'NY',
    zip: '11201',
    county_fips: '36047',
    property_type: 'condo',
    last_sold_price: null,
    last_sold_date: null,
  };
  return [
    row({
      ...base,
      street: '218 Plymouth St #3A',
      lat: 40.70321,
      lng: -73.98612,
      parcel_apn: '000311004',
    }),
    row({
      ...base,
      street: '218 Plymouth St #4B',
      lat: 40.70321,
      lng: -73.98612,
      parcel_apn: '000311007',
      last_sold_price: 1_200_000,
      last_sold_date: '2019-05-29',
      sqft: 1000,
    }),
    // The same building's unit, geocoded a little apart: joined by address.
    row({
      ...base,
      street: '218 Plymouth St #5A',
      lat: 40.70323,
      lng: -73.9861,
      parcel_apn: '000311008',
    }),
    row({
      ...base,
      street: '52 Jay St',
      property_type: 'single_family',
      lat: 40.70299,
      lng: -73.98668,
      parcel_apn: '000300018',
      last_sold_price: 2_000_000,
      last_sold_date: '2004-12-20',
      year_built: 1899,
    }),
    // Two addresses at one point: one stack.
    row({ ...base, street: '1 Water St', lat: 40.7035, lng: -73.9873 }),
    row({ ...base, street: '3 Water St', lat: 40.7035, lng: -73.9873 }),
  ];
}

test('the spill keeps each record once by bucket and once by hexagon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const packed = compressSections(partitionRows(brooklynRows(), OPTIONS));
    assert.equal(packed.stats.kept, 6);
    assert.equal(packed.stats.withUnit, 3);
    // Held under a tiny budget, the spill writes as it goes; the files
    // hold each row group's sections in the order they came.
    const spill = createSpill(dir, { budgetBytes: 1 });
    spill.add(packed);
    spill.add(
      compressSections(partitionRows(brooklynRows().slice(0, 1), OPTIONS)),
    );
    const spilled = spill.finish();
    assert.equal(spill.held(), 0);
    assert.equal(spilled.buckets.size, 1);
    const [[, bucket]] = spilled.buckets;
    assert.equal(bucket.count, 7);
    const sections = readSpill(bucket.file);
    assert.equal(sections.length, 2);
    const seen = [];
    eachSectionRecord(sections[0], (x, y, key) => seen.push(key));
    assert.deepEqual(seen.slice(0, 3), [
      '218 PLYMOUTH ST|11201',
      '218 PLYMOUTH ST|11201',
      '218 PLYMOUTH ST|11201',
    ]);
    const counted = [...spilled.cells.values()].reduce(
      (sum, c) => sum + c.count,
      0,
    );
    assert.equal(counted, 7);
    assert.ok(spilled.bytes > 0);
    // A torn spill file says so.
    fs.writeFileSync(
      path.join(dir, 'torn.spill'),
      Buffer.from([9, 0, 0, 0, 1]),
    );
    assert.throws(() => readSpill(path.join(dir, 'torn.spill')), /torn/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('units collapse by point or by address, transitively', () => {
  const entries = [
    { x: 1, y: 1, key: 'A' },
    { x: 1, y: 1, key: 'B' },
    { x: 2, y: 2, key: 'B' },
    { x: 3, y: 3, key: 'C' },
    { x: 4, y: 4, key: '' },
    { x: 5, y: 5, key: '' },
  ];
  assert.deepEqual(collapseBuildings(entries), [[0, 1, 2], [3], [4], [5]]);
});

test('a bucket keeps buildings as pins and their records, units in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const spill = createSpill(path.join(dir, 'spill'));
    spill.add(compressSections(partitionRows(brooklynRows(), OPTIONS)));
    const [[, spilled]] = spill.finish().buckets;
    const target = path.join(dir, 'bucket.bin');
    const result = mergePropertyBucket({ spill: spilled.file, target });
    assert.equal(result.records, 6);
    assert.equal(result.buildings, 3);
    const bucket = openBucket(target);
    try {
      const pins = [];
      for (const entry of bucket.entries.values()) {
        if (entry.kind !== PROPERTY_KIND.P) continue;
        const raw = bucket.block(PROPERTY_KIND.P, entry.key);
        for (let at = 0; at < raw.length; at += PIN_BYTES)
          pins.push({ ...decodePin(raw, at), block: entry.key });
      }
      assert.equal(pins.length, 3);
      const plymouth = pins.find((pin) => pin.units === 3);
      assert.equal(plymouth.type, 2);
      assert.equal(plymouth.price, 1_200_000);
      assert.equal(monthText(plymouth.month), '2019-05');
      assert.equal(plymouth.flags, 1);
      assert.equal(plymouth.sqft, 1000);
      assert.equal(pinBlockOf(plymouth.x, plymouth.y), plymouth.block);
      const records = [];
      eachBuildingRecords(
        bucket.block(PROPERTY_KIND.D, detailBlockOf(plymouth.x, plymouth.y)),
        (index, list) => {
          if (index === plymouth.index) records.push(...list);
          return index === plymouth.index;
        },
      );
      assert.deepEqual(
        records.map((r) => [r.unit, r.apn]),
        [
          ['3A', '3-00031-1004'],
          ['4B', '3-00031-1007'],
          ['5A', '3-00031-1008'],
        ],
      );
      const house = pins.find((pin) => pin.type === 1);
      assert.equal(house.units, 1);
      // A 2004 sale is the last sale, but not a recent one.
      assert.equal(house.flags, 0);
      assert.equal(house.year, 1899);
      const stack = pins.find((pin) => pin.units === 2);
      assert.equal(stack.price, 0);
    } finally {
      bucket.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Stat records as a part's section holds them. */
function stats(list) {
  const writer = new RecordWriter();
  for (const s of list) {
    writer.f64(s.key);
    writer.f32(s.price || 0);
    writer.f32(s.ppsf || 0);
    writer.u16(s.year || 0);
    writer.byte(s.sold ? 1 : 0);
    writer.byte(0);
  }
  return writer.done();
}

test('hexagon medians: prices from recent sales, counts over every record', () => {
  const a = cellKey(h3.latLngToCell(40.7, -73.99, 7));
  const b = cellKey(h3.latLngToCell(40.75, -73.9, 7));
  const columns = statColumns([
    stats([
      { key: a, price: 100_000, ppsf: 1, year: 1900, sold: true },
      { key: a, price: 300_000, ppsf: 3, year: 1950, sold: true },
      { key: a, price: 200_000, ppsf: 2, year: 2000, sold: true },
      { key: a, year: 1920, sold: true }, // an old sale: no price
      { key: a }, // no sale
    ]),
    stats([
      { key: b, price: 500_000, sold: true },
      { key: b, price: 700_000, sold: true },
    ]),
  ]);
  const { rows, histograms } = aggregatePartition(columns);
  const at7 = new Map(rows[7].map((r) => [r.key, r]));
  assert.deepEqual(at7.get(a), {
    key: a,
    properties: 5,
    sales: 4,
    price: 200_000,
    ppsf: 2,
    year: 1920,
  });
  // Two prices are too few for a median.
  assert.equal(Number.isNaN(at7.get(b).price), true);
  assert.equal(at7.get(b).properties, 2);
  // A coarser cell takes both: the median of 100k, 200k, 300k, 500k, 700k.
  const parent = parentKey(a, 3);
  if (parentKey(b, 3) === parent) {
    const at3 = rows[3].find((r) => r.key === parent);
    assert.equal(at3.price, 300_000);
    assert.equal(at3.properties, 7);
  }
  assert.equal(histograms.properties, 7);
  assert.equal(histograms.sales, 6);
  const coarse = coarseRows(new Map([[parent, histograms]]));
  const at0 = coarse[0][0];
  assert.equal(at0.properties, 7);
  // The histograms' median is within a bin of the exact one.
  assert.ok(
    Math.abs(histogramMedian('price', histograms.price) - 300_000) <
      300_000 * 0.02,
  );
  assert.equal(at0.year, 1920);
  assert.equal(binOf('year', 1599), -1);
  assert.equal(binOf('price', 0), -1);
});

test('the hex file answers a box and a point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const cell = h3.latLngToCell(40.7, -73.99, 7);
    const table = tableOf(7, [
      {
        key: cellKey(cell),
        properties: 9,
        sales: 4,
        price: 650_000,
        ppsf: 700,
        year: 1931,
      },
    ]);
    const file = path.join(dir, 'hexes.bin');
    writeHexFile(file, { header: { builtAt: 'now' }, tables: [table] });
    const hexes = openHexFile(file);
    const opened = hexes.table(7);
    const box = { west: -74.1, south: 40.6, east: -73.9, north: 40.8 };
    assert.deepEqual(queryHexCells(opened, 'price', box).cells, [
      [cell, 650_000],
    ]);
    assert.deepEqual(queryHexCells(opened, 'properties', box).cells, [
      [cell, 9],
    ]);
    assert.deepEqual(
      queryHexCells(opened, 'price', { ...box, west: 0, east: 1 }).cells,
      [],
    );
    assert.equal(valueAt(opened, 'year', 40.7, -73.99), 1931);
    assert.equal(Number.isNaN(valueAt(opened, 'year', 41.7, -73.99)), true);
    assert.equal(hexes.domains(7).price.median, 650_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bucket written with room for more blocks says how many came', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const file = path.join(dir, 'b.bin');
    const writer = bucketWriter(file, 10, { atMost: true });
    writer.add(PROPERTY_KIND.P, 3, Buffer.from('three'), 1);
    writer.add(PROPERTY_KIND.D, 7, Buffer.from('seven'), 1);
    writer.finish();
    const bucket = openBucket(file);
    assert.equal(bucket.entries.size, 2);
    assert.equal(bucket.block(PROPERTY_KIND.D, 7).toString(), 'seven');
    bucket.close();
    const exact = bucketWriter(path.join(dir, 'c.bin'), 2);
    exact.add(PROPERTY_KIND.P, 1, Buffer.from('x'), 1);
    assert.throws(() => exact.finish(), /1 of 2 blocks/);
    exact.abort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('row groups from a spec', () => {
  assert.deepEqual(parseGroups('0-1', 1184), [0, 1]);
  assert.deepEqual(parseGroups('3,0-1,1', 1184), [0, 1, 3]);
  assert.deepEqual(parseGroups('', 3), [0, 1, 2]);
  assert.deepEqual(parseGroups('1180-1190', 1184), [1180, 1181, 1182, 1183]);
  assert.throws(() => parseGroups('b-a', 10));
});
