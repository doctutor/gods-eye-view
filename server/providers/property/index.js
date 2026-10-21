// Personal fork: answers from the property index (`npm run property:build`)
// for the Property sales layer: hexagons, buildings, a building's records
// and the Lego mode's values. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import {
  WORLD_BITS,
  openBucket,
  unitX,
  unitY,
} from '../overture/buildingsFile.js';
import { spread } from '../overture/placesIndex.js';
import { H3_HEX_ACROSS_KM } from '../../../src/maps/h3Resolution.js';
import {
  PROPERTY_MAX_CELLS,
  PROPERTY_METRIC_KEYS,
  PROPERTY_POINT_LIMIT,
  PROPERTY_RESOLUTIONS,
  PROPERTY_UNIT_LIMIT,
  propertyTypeKey,
} from '../../../src/data/propertySales.js';
import {
  PIN_BYTES,
  PIN_ZOOM,
  PROPERTY_KIND,
  bucketOf,
  dateOfDay,
  decodePin,
  detailBlockOf,
  eachBuildingRecords,
  latOfUnitY,
  lonOfUnitX,
  monthText,
  pinBlockOf,
} from './file.js';
import { openHexFile, queryHexCells, valueAt } from './hexFile.js';
import { loadCounties } from './counties.js';
import { NEEDS_BUILD } from './sources.js';

const PIN_SHIFT = WORLD_BITS - PIN_ZOOM;
const ID = /^pr:(\d{1,9}):(\d{1,9}):(\d{1,6})$/;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** A building's id: its pin's position and its place in its records block. */
export const buildingId = (pin) => `pr:${pin.x}:${pin.y}:${pin.index}`;

/** An id's parts, or null. */
export function parseBuildingId(id) {
  const match = ID.exec(String(id || ''));
  if (!match) return null;
  const [x, y, index] = match.slice(1).map(Number);
  if (x >= 2 ** WORLD_BITS || y >= 2 ** WORLD_BITS) return null;
  return { x, y, index };
}

/** The resolution whose hexagons are about as wide as a cell (the Lego mode's columns). */
export function resolutionForCell(cellSizeM) {
  for (let res = PROPERTY_RESOLUTIONS.at(-1); res >= 0; res--)
    if (H3_HEX_ACROSS_KM[res] * 1000 >= cellSizeM) return res;
  return 0;
}

/** One record as the card reads it. */
function recordAnswer(record) {
  return {
    ...(record.street ? { street: record.street } : {}),
    ...(record.unit ? { unit: record.unit } : {}),
    ...(record.type ? { type: propertyTypeKey(record.type) } : {}),
    ...(record.beds !== undefined ? { beds: record.beds } : {}),
    ...(record.baths2 !== undefined ? { baths: record.baths2 / 2 } : {}),
    ...(record.sqft ? { sqft: record.sqft } : {}),
    ...(record.lot ? { lot: record.lot } : {}),
    ...(record.year ? { year: record.year } : {}),
    ...(record.apn ? { apn: record.apn } : {}),
    ...(record.soldPrice
      ? { sold: { price: record.soldPrice, date: dateOfDay(record.soldDay) } }
      : {}),
    ...(record.sales?.length
      ? {
          sales: record.sales.map((sale) => ({
            date: dateOfDay(sale.day),
            price: sale.price,
          })),
        }
      : {}),
    ...(record.tax?.length ? { tax: record.tax } : {}),
  };
}

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number,
 *   counties?: object}} options `dir`: the index (PROPERTY_DIR)
 */
export function createPropertyIndex({
  dir,
  now = () => Date.now(),
  maxOpen = 64,
  counties = null,
}) {
  const pointer = path.join(dir, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  let hexes = null;
  let names = counties;
  const open = new Map();

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
    hexes = null;
  }

  function manifest() {
    if (now() - checkedAt < 5000 && (held || lastError))
      return held?.manifest || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      held = null;
      lastError = null;
      closeAll();
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.manifest;
    try {
      const { manifest: name } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name)))
        throw new Error('current.json names no manifest');
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      closeAll();
      hexes = openHexFile(path.join(dir, value.hexes.file));
      held = { manifest: value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      held = null;
      closeAll();
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Property] index not readable:', lastError);
    }
    return held?.manifest || null;
  }

  const unbuilt = () => ({ status: 503, error: lastError || NEEDS_BUILD });

  function bucket(m, key) {
    const entry = m.buckets[String(key)];
    if (!entry) return null;
    const file = path.join(dir, 'buckets', entry.file);
    let b = open.get(file);
    if (b) {
      open.delete(file);
      open.set(file, b);
      return b;
    }
    b = openBucket(file);
    open.set(file, b);
    if (open.size > maxOpen) {
      const [oldest, value] = open.entries().next().value;
      value.close();
      open.delete(oldest);
    }
    return b;
  }

  const countyOf = (fips) => {
    if (!fips) return null;
    names ||= loadCounties();
    const county = names.byGeoid.get(fips);
    return county ? { fips, name: county.name, state: county.st } : { fips };
  };

  return {
    /** The build: {configured, version, …, domains by resolution}. */
    status() {
      const m = manifest();
      if (!m)
        return {
          configured: false,
          ...(lastError ? { message: lastError } : {}),
        };
      return {
        configured: true,
        version: m.version,
        builtAt: m.builtAt,
        records: m.records,
        buildings: m.buildings,
        source: m.source,
        attribution: m.attribution,
        priceSinceYear: hexes.header.priceSinceYear,
        priceFloorUsd: hexes.header.priceFloorUsd,
        domains: Object.fromEntries(
          hexes.resolutions.map((res) => [res, hexes.domains(res)]),
        ),
      };
    },

    /**
     * A metric's hexagons of a resolution in a box: {res, metric, domain,
     * cells: [[index, value]]}; 413 past PROPERTY_MAX_CELLS.
     */
    hexes({ res, metric, box }) {
      const m = manifest();
      if (!m) return unbuilt();
      if (!hexes.resolutions.includes(res))
        return { status: 404, error: 'No such resolution' };
      if (!PROPERTY_METRIC_KEYS.includes(metric))
        return { status: 404, error: 'No such metric' };
      const table = hexes.table(res);
      const answer = queryHexCells(table, metric, box, {
        maxCells: PROPERTY_MAX_CELLS,
      });
      if (answer.tooMany)
        return {
          status: 413,
          error: `More than ${PROPERTY_MAX_CELLS} hexagons at resolution ${res}`,
        };
      return {
        status: 200,
        version: m.version,
        body: {
          res,
          metric,
          domain: table.domains[metric],
          count: answer.cells.length,
          cells: answer.cells,
        },
      };
    },

    /**
     * The buildings in a box: every one when there are at most
     * `limit`, else `limit` of them spread over the box by a hash of their
     * position (the same ones as the view pans), `saturated`.
     */
    buildings({ west, south, east, north, limit = PROPERTY_POINT_LIMIT }) {
      const m = manifest();
      if (!m) return unbuilt();
      const x0 = unitX(west);
      const x1 = unitX(east);
      const y0 = unitY(north);
      const y1 = unitY(south);
      const candidates = [];
      for (let ty = y0 >>> PIN_SHIFT; ty <= y1 >>> PIN_SHIFT; ty++)
        for (let tx = x0 >>> PIN_SHIFT; tx <= x1 >>> PIN_SHIFT; tx++) {
          const cx = tx << PIN_SHIFT;
          const cy = ty << PIN_SHIFT;
          const b = bucket(m, bucketOf(cx, cy));
          const raw = b?.block(PROPERTY_KIND.P, pinBlockOf(cx, cy));
          if (!raw) continue;
          for (let at = 0; at < raw.length; at += PIN_BYTES) {
            const x = raw.readUInt32LE(at);
            const y = raw.readUInt32LE(at + 4);
            if (x < x0 || x > x1 || y < y0 || y > y1) continue;
            candidates.push({ raw, at, rank: spread(x, y) });
          }
        }
      let kept = candidates;
      if (candidates.length > limit) {
        candidates.sort((a, b) => a.rank - b.rank);
        kept = candidates.slice(0, limit);
      }
      const buildings = kept.map(({ raw, at }) => {
        const pin = decodePin(raw, at);
        return {
          id: buildingId(pin),
          at: [
            round6(lonOfUnitX(pin.x + 0.5)),
            round6(latOfUnitY(pin.y + 0.5)),
          ],
          units: pin.units,
          ...(pin.type ? { type: propertyTypeKey(pin.type) } : {}),
          ...(pin.price
            ? { price: pin.price, sold: monthText(pin.month) }
            : {}),
          recent: pin.flags === 1,
          ...(pin.year ? { year: pin.year } : {}),
          ...(pin.sqft ? { sqft: pin.sqft } : {}),
        };
      });
      return {
        status: 200,
        version: m.version,
        body: {
          count: buildings.length,
          candidates: candidates.length,
          saturated: candidates.length > buildings.length,
          buildings,
        },
      };
    },

    /** One building's records (at most PROPERTY_UNIT_LIMIT) for its card. */
    building({ id }) {
      const m = manifest();
      if (!m) return unbuilt();
      const parsed = parseBuildingId(id);
      if (!parsed) return { status: 400, error: 'Not a building id' };
      const b = bucket(m, bucketOf(parsed.x, parsed.y));
      // The pin must be there: an id from another build is not answered.
      const pins = b?.block(PROPERTY_KIND.P, pinBlockOf(parsed.x, parsed.y));
      let pin = null;
      for (let at = 0; pins && at < pins.length; at += PIN_BYTES)
        if (
          pins.readUInt32LE(at) === parsed.x &&
          pins.readUInt32LE(at + 4) === parsed.y &&
          pins.readUInt32LE(at + 8) === parsed.index
        ) {
          pin = decodePin(pins, at);
          break;
        }
      const details =
        pin && b.block(PROPERTY_KIND.D, detailBlockOf(parsed.x, parsed.y));
      let records = null;
      if (details)
        eachBuildingRecords(
          details,
          (index, list) => {
            records = list;
            return true;
          },
          { want: parsed.index },
        );
      if (!records) return { status: 404, error: 'No such building' };
      const first = records[0];
      return {
        status: 200,
        version: m.version,
        body: {
          id,
          at: [
            round6(lonOfUnitX(pin.x + 0.5)),
            round6(latOfUnitY(pin.y + 0.5)),
          ],
          units: records.length,
          address: {
            street: first.street || '',
            city: first.city || '',
            state: first.state || '',
            zip: first.zip || '',
          },
          // Different streets: records the source put at one point.
          stacked: new Set(records.map((r) => r.street || '')).size > 1,
          county: countyOf(first.county),
          records: records.slice(0, PROPERTY_UNIT_LIMIT).map(recordAnswer),
          more: Math.max(0, records.length - PROPERTY_UNIT_LIMIT),
        },
      };
    },

    /**
     * The Lego mode's values: a metric for each cell of a cols × rows grid
     * over the box (north row first), from the hexagons about a cell wide.
     */
    values(mode, box, cols, rows) {
      const m = manifest();
      if (!m) return unbuilt();
      const metric = PROPERTY_METRIC_KEYS.includes(mode) ? mode : 'price';
      const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
      const cellM =
        (((box.east - box.west) / cols) * 111_320 * Math.cos(midLat) +
          ((box.north - box.south) / rows) * 110_574) /
        2;
      const table = hexes.table(resolutionForCell(cellM));
      const out = new Float32Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        const lat = box.north - ((r + 0.5) / rows) * (box.north - box.south);
        for (let c = 0; c < cols; c++) {
          const lon = box.west + ((c + 0.5) / cols) * (box.east - box.west);
          out[r * cols + c] = valueAt(table, metric, lat, lon);
        }
      }
      return {
        status: 200,
        aggregation: 'sample',
        body: Buffer.from(out.buffer),
      };
    },

    close: closeAll,
  };
}
