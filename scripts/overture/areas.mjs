import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openParquet, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import {
  BANDS,
  quantBitsFor,
} from '../../server/providers/overtureBoundaries/bands.js';
import {
  AREA_INDEX_MAX_ZOOM,
  AREA_SUBTYPES,
  decodeAreaRecord,
  writeVarint,
} from '../../server/providers/overtureAreas/format.js';
import { OVERTURE_RELEASE } from '../../src/data/overtureDivisions.js';
import { projectPart, simplify } from '../rivers/levels.mjs';
import { boundaryPieces, marginUnits, toleranceFor } from './boundaries.mjs';
import { createLevelWriter } from '../../server/providers/riversV2/levelFile.js';

/**
 * The Overture division areas for the Administrative boundaries layer
 * (`npm run overture:areas`): Overture's division_area files, their land
 * areas of the country, dependency, region and county subtypes (and the
 * countries' and dependencies' territorial seas), decoded from GeoParquet
 * WKB, simplified per zoom band as the lines are, and written to
 * build/areas/ in the Overture cache:
 *
 * - `areas-<stamp>.bin`: each unit's polygons at every band's level, one
 *   record after another (format.js), read by offset;
 * - `units-<stamp>.json`: per unit its id, subtype, country, names, box
 *   and each level's offset and length;
 * - `index-<stamp>.json`: a multi-level grid, each unit in the cells (at
 *   most 2 × 2) of the deepest zoom up to AREA_INDEX_MAX_ZOOM where its box
 *   is that small, so a point or a tile looks in one cell or a few per
 *   zoom;
 * - `coasts-<stamp>/level-<band>.bin`: the countries' and dependencies'
 *   land outlines as lines, cut into cells per band exactly as the
 *   boundary lines are (scripts/overture/boundaries.mjs), so a tile reads
 *   only the cells under it;
 * - `manifest.json`, switched last.
 *
 * The server (server/providers/overtureAreas.js) answers which units hold a
 * point (a click's card) and draws their fills and the countries' coasts.
 *
 * Streaming: one row group at a time (the largest geometry chunk is 48 MB
 * compressed); a unit's geometry is simplified and written out at once, so
 * only its small metadata is held.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** Bump when the files change shape or meaning (forces a rebuild). */
export const AREAS_FORMAT = 1;
export const AREA_COLUMNS = Object.freeze([
  'id',
  'subtype',
  'is_land',
  'is_territorial',
  'country',
  'region',
  'names.primary',
  'names.common.key_value.key',
  'names.common.key_value.value',
  'geometry',
]);

/**
 * The division_area files: *.parquet (not .partial) in
 * <raw>/<release>/divisions/division_area/ of each raw directory given (the
 * first that has a file of that name wins).
 */
export function findAreaInputs(rawDirs, release = OVERTURE_RELEASE) {
  const found = new Map();
  for (const rawDir of rawDirs) {
    const dir = path.join(rawDir, release, 'divisions', 'division_area');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.parquet'));
    } catch {
      continue;
    }
    for (const name of names.sort())
      if (!found.has(name)) {
        const file = path.join(dir, name);
        found.set(name, { file, name, bytes: fs.statSync(file).size });
      }
  }
  return [...found.values()];
}

/**
 * A WKB Polygon or MultiPolygon as polygons of rings, each ring [lon, lat,
 * …] (closed as given), or null for anything else.
 * @param {Buffer} wkb
 * @returns {Float64Array[][]|null}
 */
export function wkbPolygons(wkb) {
  if (!wkb || wkb.length < 9) return null;
  let pos = 0;
  const polygon = () => {
    const little = wkb[pos] === 1;
    const u32 = (at) => (little ? wkb.readUInt32LE(at) : wkb.readUInt32BE(at));
    const f64 = (at) => (little ? wkb.readDoubleLE(at) : wkb.readDoubleBE(at));
    if (u32(pos + 1) !== 3) return null;
    const count = u32(pos + 5);
    pos += 9;
    const rings = [];
    for (let r = 0; r < count; r++) {
      if (pos + 4 > wkb.length) return null;
      const points = u32(pos);
      pos += 4;
      if (pos + points * 16 > wkb.length) return null;
      const ring = new Float64Array(points * 2);
      for (let i = 0; i < points * 2; i++, pos += 8) ring[i] = f64(pos);
      rings.push(ring);
    }
    return rings;
  };
  const little = wkb[0] === 1;
  const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
  if (type === 3) {
    const one = polygon();
    return one ? [one] : null;
  }
  if (type !== 6) return null;
  const count = little ? wkb.readUInt32LE(5) : wkb.readUInt32BE(5);
  pos = 9;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (pos + 9 > wkb.length) return null;
    const one = polygon();
    if (!one) return null;
    out.push(one);
  }
  return out;
}

/** Web Mercator's latitude limit: the tiles' and the index's. */
export const MERCATOR_MAX_LAT = 85.05112878;

/**
 * Latitudes clamped to Web Mercator's (in place): Antarctica's land reaches
 * -90°, where a Mercator y is infinite.
 */
export function clampToMercator(polygons) {
  for (const rings of polygons)
    for (const ring of rings)
      for (let i = 1; i < ring.length; i += 2)
        if (ring[i] > MERCATOR_MAX_LAT) ring[i] = MERCATOR_MAX_LAT;
        else if (ring[i] < -MERCATOR_MAX_LAT) ring[i] = -MERCATOR_MAX_LAT;
  return polygons;
}

/** Whether a row is kept: a land unit of a kept subtype, or a country's or dependency's sea. */
export function keptArea({ subtype, land, territorial }) {
  if (!AREA_SUBTYPES.includes(subtype)) return null;
  if (land) return 'land';
  if (territorial && (subtype === 'country' || subtype === 'dependency'))
    return 'sea';
  return null;
}

/**
 * Every kept area of a division_area file, as onArea({id, subtype, kind
 * ('land' or 'sea'), country, region, name, nameEn, polygons}). Returns how
 * many rows were read and kept.
 */
export function forEachArea(file, onArea) {
  const parquet = openParquet(file);
  let rows = 0;
  let kept = 0;
  try {
    for (const name of AREA_COLUMNS)
      if (!parquet.leaf(name))
        throw new Error(`${path.basename(file)} has no column ${name}`);
    const flat = (group, name) =>
      rowsOfFlat(
        parquet.column(group, name),
        parquet.leaf(name),
        Number(parquet.rowGroups[group].rows),
      );
    const repeated = (group, name) =>
      rowsOfRepeated(parquet.column(group, name), parquet.leaf(name));
    const text = (value) =>
      value === null || value === undefined ? null : String(value);
    for (let group = 0; group < parquet.rowGroups.length; group++) {
      const subtype = flat(group, 'subtype').map(text);
      const land = flat(group, 'is_land');
      const territorial = flat(group, 'is_territorial');
      rows += subtype.length;
      const wanted = subtype.map((s, i) =>
        keptArea({
          subtype: s,
          land: land[i] === true,
          territorial: territorial[i] === true,
        }),
      );
      if (!wanted.some(Boolean)) continue;
      const ids = flat(group, 'id');
      const country = flat(group, 'country');
      const region = flat(group, 'region');
      const primary = flat(group, 'names.primary');
      const keys = repeated(group, 'names.common.key_value.key');
      const values = repeated(group, 'names.common.key_value.value');
      const geometry = flat(group, 'geometry');
      for (let i = 0; i < subtype.length; i++) {
        if (!wanted[i]) continue;
        const polygons = wkbPolygons(geometry[i]);
        if (!polygons) continue;
        clampToMercator(polygons);
        const enAt = (keys[i] || []).findIndex((key) => text(key) === 'en');
        kept++;
        onArea({
          id: text(ids[i]),
          subtype: subtype[i],
          kind: wanted[i],
          country: text(country[i]),
          region: text(region[i]),
          name: text(primary[i]),
          nameEn: enAt >= 0 ? text(values[i]?.[enAt]) : null,
          polygons,
        });
      }
      // Let the row group's buffers go before the next is read.
      geometry.length = 0;
    }
  } finally {
    parquet.close();
  }
  return { rows, kept };
}

/**
 * An area's record: per band, its polygons projected, simplified for the
 * band and quantized at the band's bits (rings of under three points
 * dropped), as format.js encodes them; and its box in world units.
 */
export function encodeArea(polygons, bands = BANDS) {
  const projected = polygons.map((rings) => rings.map(projectPart));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rings of projected)
    for (let i = 0; rings[0] && i < rings[0].length; i += 2) {
      const x = rings[0][i];
      const y = rings[0][i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  const levels = bands.map((band) => {
    const bits = quantBitsFor(band);
    const scale = 2 ** bits;
    const tolerance = toleranceFor(band);
    const bytes = [];
    const kept = [];
    for (const rings of projected) {
      const out = [];
      for (const ring of rings) {
        const keep = simplify(ring, tolerance);
        const coords = [];
        let lastX = NaN;
        let lastY = NaN;
        for (let k = 0; k < keep.length; k++) {
          if (!keep[k]) continue;
          const x = Math.round(ring[k * 2] * scale);
          const y = Math.round(ring[k * 2 + 1] * scale);
          if (x === lastX && y === lastY) continue;
          coords.push(x, y);
          lastX = x;
          lastY = y;
        }
        if (coords.length >= 6) out.push(coords);
        else if (!out.length) break; // the outer ring is gone: so is the polygon
      }
      if (out.length) kept.push(out);
    }
    writeVarint(bytes, kept.length);
    for (const rings of kept) {
      writeVarint(bytes, rings.length);
      for (const coords of rings) {
        writeVarint(bytes, coords.length / 2);
        let px = 0;
        let py = 0;
        for (let k = 0; k < coords.length; k += 2) {
          writeVarint(bytes, zigzag(coords[k] - px));
          writeVarint(bytes, zigzag(coords[k + 1] - py));
          px = coords[k];
          py = coords[k + 1];
        }
      }
    }
    return Buffer.from(bytes);
  });
  return { box: [x0, y0, x1, y1], levels };
}

const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

/** The class of every coast piece (the level headers' `classes`). */
export const COAST_CLASSES = Object.freeze([
  Object.freeze({
    subtype: 'coast',
    class: 'coast',
    disputed: false,
    perspective: null,
  }),
]);

/** The deepest zoom (up to `maxZoom`) whose cells a box spans at most 2 × 2 of, and those cells. */
export function indexCells([x0, y0, x1, y1], maxZoom = AREA_INDEX_MAX_ZOOM) {
  for (let z = maxZoom; z >= 0; z--) {
    const n = 2 ** z;
    const cx0 = Math.max(0, Math.floor(x0 * n));
    const cx1 = Math.min(n - 1, Math.floor(x1 * n));
    const cy0 = Math.max(0, Math.floor(y0 * n));
    const cy1 = Math.min(n - 1, Math.floor(y1 * n));
    if (cx1 - cx0 <= 1 && cy1 - cy0 <= 1) {
      const cells = [];
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) cells.push(cy * n + cx);
      return { zoom: z, cells };
    }
  }
  return { zoom: 0, cells: [0] };
}

/** Appends to a file in large writes. */
function createAppender(file) {
  const fd = fs.openSync(file, 'w');
  let held = [];
  let heldBytes = 0;
  let written = 0;
  const flush = () => {
    if (!heldBytes) return;
    fs.writeSync(fd, Buffer.concat(held, heldBytes));
    held = [];
    heldBytes = 0;
  };
  return {
    /** Appends `buffer`; returns where it starts. */
    add(buffer) {
      const at = written + heldBytes;
      held.push(buffer);
      heldBytes += buffer.length;
      if (heldBytes >= 8 * 1024 * 1024) {
        written += heldBytes;
        flush();
      }
      return at;
    },
    close() {
      written += heldBytes;
      flush();
      fs.closeSync(fd);
      return written;
    },
    abort() {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    },
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** What a build was made from. */
export function areasSignature(inputs, bands = BANDS) {
  return {
    format: AREAS_FORMAT,
    subtypes: AREA_SUBTYPES,
    bands: bands.map(({ level, toleranceZoom, maxZoom }) => ({
      level,
      toleranceZoom,
      maxZoom,
    })),
    indexMaxZoom: AREA_INDEX_MAX_ZOOM,
    inputs: inputs.map(({ name, bytes }) => ({ name, bytes })),
  };
}

/**
 * Build the areas into `outDir` from the inputs; an unchanged input set is
 * skipped unless `force`.
 * @param {{outDir: string, inputs: {file: string, name: string, bytes: number}[],
 *   force?: boolean, log?: (line: string) => void, now?: () => number,
 *   bands?: object[], release?: string, onMemory?: () => void}} options
 */
export function runAreasBuild({
  outDir,
  inputs,
  force = false,
  log = () => {},
  now = () => Date.now(),
  bands = BANDS,
  release = OVERTURE_RELEASE,
  onMemory = () => {},
}) {
  if (!inputs.length)
    throw new Error(
      `no Overture division_area file (raw/${release}/divisions/division_area/*.parquet); it is release/${release}/theme=divisions/type=division_area/ in Overture's bucket, 4.5 GB`,
    );
  fs.mkdirSync(outDir, { recursive: true });
  const manifestFile = path.join(outDir, 'manifest.json');
  const signature = areasSignature(inputs, bands);
  const previous = readJson(manifestFile, null);
  if (
    !force &&
    JSON.stringify(previous?.signature) === JSON.stringify(signature)
  ) {
    log(`unchanged since ${previous.builtAt}; --force to rebuild`);
    return { skipped: true, manifest: previous };
  }
  const started = now();
  const stamp = `b${started.toString(36)}`;
  const files = {
    areas: `areas-${stamp}.bin`,
    units: `units-${stamp}.json`,
    index: `index-${stamp}.json`,
    coasts: `coasts-${stamp}`,
  };
  /** band level → cell key → encoded coast pieces */
  const coastCells = new Map(bands.map((band) => [band.level, new Map()]));
  const coastCounts = new Map(
    bands.map((band) => [band.level, { pieces: 0, vertices: 0 }]),
  );
  const appender = createAppender(path.join(outDir, files.areas));
  const units = [];
  /** zoom → cell → unit indexes */
  const index = new Map();
  const bySubtype = {};
  const sources = [];
  let points = 0;
  try {
    for (const input of inputs) {
      const read = forEachArea(input.file, (area) => {
        const { box, levels } = encodeArea(area.polygons, bands);
        if (!Number.isFinite(box[0])) return;
        for (const rings of area.polygons)
          for (const ring of rings) points += ring.length / 2;
        const offsets = levels.map((bytes) => appender.add(bytes));
        const unit = units.length;
        units.push({
          id: area.id,
          subtype: area.subtype,
          kind: area.kind,
          country: area.country,
          region: area.region,
          name: area.name,
          nameEn: area.nameEn && area.nameEn !== area.name ? area.nameEn : null,
          box: box.map((v) => Math.round(v * 1e9) / 1e9),
          offsets,
          lengths: levels.map((bytes) => bytes.length),
        });
        const key = `${area.subtype} ${area.kind}`;
        bySubtype[key] = (bySubtype[key] || 0) + 1;
        // A country's or dependency's land outline: its coast (and its land
        // borders, which the boundary lines draw too).
        if (
          area.kind === 'land' &&
          (area.subtype === 'country' || area.subtype === 'dependency')
        )
          boundaryPieces(
            area.polygons.flat(),
            0,
            (band, cell, piece, vertices) => {
              const held = coastCells.get(band.level);
              const list = held.get(cell);
              if (list) list.push(piece);
              else held.set(cell, [piece]);
              const count = coastCounts.get(band.level);
              count.pieces++;
              count.vertices += vertices;
            },
            bands,
          );
        const { zoom, cells } = indexCells(box);
        let atZoom = index.get(zoom);
        if (!atZoom) index.set(zoom, (atZoom = new Map()));
        for (const cell of cells) {
          const list = atZoom.get(cell);
          if (list) list.push(unit);
          else atZoom.set(cell, [unit]);
        }
        onMemory();
      });
      sources.push({ file: input.name, bytes: input.bytes, ...read });
      log(`${input.name}: ${read.kept} areas of ${read.rows} rows`);
    }
    const bytes = appender.close();
    // The coast level files.
    fs.mkdirSync(path.join(outDir, files.coasts), { recursive: true });
    const coasts = [];
    for (const band of bands) {
      const relative = `${files.coasts}/level-${band.level}.bin`;
      const writer = createLevelWriter(
        path.join(outDir, ...relative.split('/')),
      );
      const held = coastCells.get(band.level);
      const { pieces, vertices } = coastCounts.get(band.level);
      let written;
      try {
        for (const cell of [...held.keys()].sort((a, b) => a - b))
          writer.addCell(cell, Buffer.concat(held.get(cell)));
        written = writer.finish({
          level: band.level,
          minZoom: band.minZoom,
          maxZoom: band.maxZoom,
          gridZoom: band.gridZoom,
          toleranceZoom: band.toleranceZoom,
          quantBits: quantBitsFor(band),
          marginUnits: marginUnits(band),
          classes: COAST_CLASSES,
          pieces,
          vertices,
        });
      } catch (error) {
        writer.abort();
        throw error;
      }
      held.clear();
      coasts.push({
        level: band.level,
        file: relative,
        minZoom: band.minZoom,
        maxZoom: band.maxZoom,
        gridZoom: band.gridZoom,
        bytes: written.bytes,
        cells: written.cells,
        pieces,
        vertices,
      });
    }
    const levels = bands.map((band, k) => ({
      level: band.level,
      minZoom: band.minZoom,
      maxZoom: band.maxZoom,
      quantBits: quantBitsFor(band),
      bytes: units.reduce((sum, unit) => sum + unit.lengths[k], 0),
    }));
    fs.writeFileSync(path.join(outDir, files.units), JSON.stringify(units));
    fs.writeFileSync(
      path.join(outDir, files.index),
      JSON.stringify(
        Object.fromEntries(
          [...index].map(([zoom, cells]) => [zoom, Object.fromEntries(cells)]),
        ),
      ),
    );
    const buildId = crypto
      .createHash('sha256')
      .update(JSON.stringify({ signature, stamp, units: units.length, bytes }))
      .digest('hex')
      .slice(0, 16);
    const manifest = {
      format: AREAS_FORMAT,
      release,
      builtAt: new Date(now()).toISOString(),
      buildId,
      signature,
      sources,
      files,
      units: units.length,
      bySubtype,
      points,
      levels,
      coasts,
      bytes: bytes + coasts.reduce((sum, level) => sum + level.bytes, 0),
      timings: { totalMs: Math.round(now() - started) },
    };
    const temporary = `${manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporary, manifestFile);
    // Older builds' files and their tiles.
    for (const name of fs.readdirSync(outDir))
      if (
        /^((areas|units|index)-b[0-9a-z]+\.(bin|json)|coasts-b[0-9a-z]+)$/.test(
          name,
        ) &&
        !Object.values(files).includes(name)
      )
        try {
          fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
        } catch (error) {
          log(`could not remove ${name} yet (${error.code || error.message})`);
        }
    try {
      fs.rmSync(path.join(outDir, 'tiles'), { recursive: true, force: true });
    } catch {
      /* a server may hold one open; stale versions are never served */
    }
    return { skipped: false, manifest };
  } catch (error) {
    appender.abort();
    for (const name of Object.values(files))
      fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    throw error;
  }
}

/** The build's status: its manifest's summary, or not built. */
export function areasStatus(outDir) {
  const manifest = readJson(path.join(outDir, 'manifest.json'), null);
  if (!manifest?.buildId) return { built: false, dir: outDir };
  return {
    built: true,
    dir: outDir,
    release: manifest.release,
    builtAt: manifest.builtAt,
    buildId: manifest.buildId,
    units: manifest.units,
    bySubtype: manifest.bySubtype,
    bytes: manifest.bytes,
    inputs: manifest.sources.length,
    timings: manifest.timings,
  };
}

export { decodeAreaRecord };
