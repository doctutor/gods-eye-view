import { readColumnChunk, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import {
  WORLD_BITS,
  Writer,
  unitX,
  unitY,
} from '../../server/providers/overture/buildingsFile.js';
import {
  PLACE_BLOCK_ZOOM,
  PLACE_BUCKET_ZOOM,
  encodeText,
} from '../../server/providers/overture/placesFile.js';
import {
  PLACE_MIN_CONFIDENCE,
  categoryCode,
} from '../../src/data/overturePlaces.js';

/**
 * The first half of the Overture places step: one fetched row group → one
 * part (the buildings' part file, buildingsParts.mjs writePart), its places
 * grouped by bucket (z 6 tile) and z 12 tile. A place is kept with a name,
 * a confidence of PLACE_MIN_CONFIDENCE or more, and not marked permanently
 * closed. Per place: Uint32 x and y, Uint8 confidence × 250, Uint8
 * category, then its text (placesFile.js encodeText).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const BLOCK_SHIFT = WORLD_BITS - PLACE_BLOCK_ZOOM;
const BUCKET_SHIFT = WORLD_BITS - PLACE_BUCKET_ZOOM;
const LOCAL = 2 ** (PLACE_BLOCK_ZOOM - PLACE_BUCKET_ZOOM);
const text = (v) => (v == null ? '' : String(v));

/** A WKB point's [lon, lat], or null. */
export function wkbPoint(wkb) {
  if (!wkb || wkb.length < 21) return null;
  const little = wkb[0] === 1;
  const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
  if (type !== 1) return null;
  const lon = little ? wkb.readDoubleLE(5) : wkb.readDoubleBE(5);
  const lat = little ? wkb.readDoubleLE(13) : wkb.readDoubleBE(13);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/**
 * Add a place to a part's buckets (bucket key → z 12 tile key → bytes):
 * Uint32 x and y, Uint8 confidence × 250, Uint8 category, then its text.
 */
export function appendPlace(
  buckets,
  { x, y, confidence, category, text: fields },
) {
  const bucketKey =
    (y >>> BUCKET_SHIFT) * 2 ** PLACE_BUCKET_ZOOM + (x >>> BUCKET_SHIFT);
  const local =
    ((y >>> BLOCK_SHIFT) % LOCAL) * LOCAL + ((x >>> BLOCK_SHIFT) % LOCAL);
  let blocks = buckets.get(bucketKey);
  if (!blocks) buckets.set(bucketKey, (blocks = new Map()));
  let writer = blocks.get(local);
  if (!writer) blocks.set(local, (writer = new Writer(4096)));
  const head = Buffer.alloc(10);
  head.writeUInt32LE(x, 0);
  head.writeUInt32LE(y, 4);
  head.writeUInt8(Math.min(250, Math.round(confidence * 250)), 8);
  head.writeUInt8(category, 9);
  writer.bytes(head);
  encodeText(writer, fields);
}

/**
 * Decode a fetched row group (buildingsPlan.mjs readRowGroupFile) into a
 * part's buckets.
 */
export function decodePlacesRowGroup(group, footer) {
  const meta = footer.rowGroups[group.header.group];
  const column = (p) => {
    const chunk = meta.columns.find((c) => c.path === p);
    const leaf = footer.leaves.find((l) => l.path === p);
    return { raw: readColumnChunk(group.chunk(p), chunk, leaf), leaf };
  };
  const flat = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfFlat(raw, leaf);
  };
  const list = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfRepeated(raw, { ...leaf, elementDef: leaf.maxDef - 1 });
  };
  const geometry = flat('geometry');
  const confidence = flat('confidence');
  const names = flat('names.primary');
  const basic = flat('basic_category');
  const hierarchy = list('taxonomy.hierarchy.list.element');
  const websites = list('websites.list.element');
  const phones = list('phones.list.element');
  const brands = flat('brand.names.primary');
  const datasets = list('sources.list.element.dataset');
  const status = flat('operating_status');
  const rows = geometry.length;
  for (const [name, values] of Object.entries({
    confidence,
    names,
    basic,
    hierarchy,
    websites,
    phones,
    brands,
    datasets,
    status,
  }))
    if (values.length !== rows)
      throw new Error(
        `${group.header.file} row group ${group.header.group}: ${name} has ${values.length} of ${rows} rows`,
      );
  const buckets = new Map();
  const stats = {
    read: rows,
    kept: 0,
    lowConfidence: 0,
    closed: 0,
    unnamed: 0,
    byDataset: {},
    byCategory: {},
    withWebsite: 0,
    withPhone: 0,
  };
  for (let i = 0; i < rows; i++) {
    const c = Number(confidence[i]);
    if (!(c >= PLACE_MIN_CONFIDENCE)) {
      stats.lowConfidence += 1;
      continue;
    }
    if (text(status[i]) === 'permanently_closed') {
      stats.closed += 1;
      continue;
    }
    const name = text(names[i]).trim();
    if (!name) {
      stats.unnamed += 1;
      continue;
    }
    const at = wkbPoint(geometry[i]);
    if (!at) continue;
    const x = unitX(at[0]);
    const y = unitY(at[1]);
    const hierarchyNames = (hierarchy[i] || []).map(text);
    const category = categoryCode(text(basic[i]), hierarchyNames);
    const source = text(datasets[i]?.[0]) || 'unknown';
    const website = text(websites[i]?.[0]);
    const phone = text(phones[i]?.[0]);
    stats.kept += 1;
    stats.byDataset[source] = (stats.byDataset[source] || 0) + 1;
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    if (website) stats.withWebsite += 1;
    if (phone) stats.withPhone += 1;
    appendPlace(buckets, {
      x,
      y,
      confidence: c,
      category,
      text: {
        name: name.slice(0, 200),
        basic: text(basic[i]).slice(0, 60),
        website: website.slice(0, 200),
        phone: phone.slice(0, 40),
        brand: text(brands[i]).slice(0, 100),
        source: source.slice(0, 40),
      },
    });
  }
  return { buckets, stats };
}
