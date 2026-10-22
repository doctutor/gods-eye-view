import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openParquet, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import {
  BANDS,
  MAX_WIDTH_PX,
  TOLERANCE_PX,
  quantBitsFor,
} from '../../server/providers/overtureBoundaries/bands.js';
import {
  createLevelWriter,
  encodePiece,
} from '../../server/providers/riversV2/levelFile.js';
import { cellKey } from '../../server/providers/riversV2/tileMath.js';
import { OVERTURE_RELEASE } from '../../src/data/overtureDivisions.js';
import {
  projectPart,
  quantize,
  simplify,
  splitIntoCells,
} from '../rivers/levels.mjs';

/**
 * The Overture country lines for the Administrative boundaries layer
 * (`npm run overture:boundaries`): Overture's division_boundary file, its
 * lines of the country subtype, decoded from GeoParquet WKB, simplified per
 * zoom band and cut into cells, written as the HydroSHEDS v2 rivers' level
 * files (server/providers/riversV2/levelFile.js) under build/boundaries/
 * in the Overture cache, with manifest.json. The server
 * (server/providers/overtureBoundaries.js) draws them.
 *
 * A piece's `order` field holds its line's class: an index into the level
 * header's `classes` (land or maritime, disputed or not, and a perspective
 * when Overture gives one), so a disputed line can be drawn dashed.
 *
 * The release has no dependency subtype among its lines (557 country
 * lines, 8,202 region, 78,771 county in 2026-09-23.1): borders of
 * dependencies are country lines there. It all fits in memory (2.6 M
 * points), so the build reads the file once on one thread.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** Bump when the level files change shape or meaning (forces a rebuild). */
export const BOUNDARIES_FORMAT = 1;
/** The subtypes kept. */
export const KEPT_SUBTYPES = Object.freeze(['country']);
/** The columns read (geometry only for row groups that hold a kept line). */
export const BOUNDARY_COLUMNS = Object.freeze([
  'id',
  'subtype',
  'class',
  'is_disputed',
  'perspectives.mode',
  'perspectives.countries.list.element',
  'geometry',
]);

/**
 * The division_boundary files: *.parquet in
 * <raw>/<release>/divisions/division_boundary/ of each raw directory given
 * (the first that has a file of that name wins).
 */
export function findBoundaryInputs(rawDirs, release = OVERTURE_RELEASE) {
  const found = new Map();
  for (const rawDir of rawDirs) {
    const dir = path.join(rawDir, release, 'divisions', 'division_boundary');
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
 * A WKB LineString or MultiLineString's lines as [lon, lat, …] arrays, or
 * null for anything else.
 * @param {Buffer} wkb
 * @returns {Float64Array[]|null}
 */
export function wkbLines(wkb) {
  if (!wkb || wkb.length < 9) return null;
  let pos = 0;
  const line = () => {
    const little = wkb[pos] === 1;
    const type = little ? wkb.readUInt32LE(pos + 1) : wkb.readUInt32BE(pos + 1);
    if (type !== 2) return null;
    const count = little
      ? wkb.readUInt32LE(pos + 5)
      : wkb.readUInt32BE(pos + 5);
    pos += 9;
    if (pos + count * 16 > wkb.length) return null;
    const out = new Float64Array(count * 2);
    for (let i = 0; i < count * 2; i++, pos += 8)
      out[i] = little ? wkb.readDoubleLE(pos) : wkb.readDoubleBE(pos);
    return out;
  };
  const little = wkb[0] === 1;
  const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
  if (type === 2) {
    const one = line();
    return one ? [one] : null;
  }
  if (type !== 5) return null;
  const count = little ? wkb.readUInt32LE(5) : wkb.readUInt32BE(5);
  pos = 9;
  const lines = [];
  for (let i = 0; i < count; i++) {
    if (pos + 9 > wkb.length) return null;
    const one = line();
    if (!one) return null;
    lines.push(one);
  }
  return lines;
}

/**
 * Every kept line of a division_boundary file, as onBoundary({id, subtype,
 * cls, disputed, perspective, lines}); `perspective` is {mode, countries}
 * or null. Returns how many rows were read and kept.
 */
export function forEachBoundary(file, onBoundary, subtypes = KEPT_SUBTYPES) {
  const parquet = openParquet(file);
  const keep = new Set(subtypes);
  let rows = 0;
  let kept = 0;
  try {
    for (const name of BOUNDARY_COLUMNS)
      if (!parquet.leaf(name))
        throw new Error(`${path.basename(file)} has no column ${name}`);
    const flat = (group, name) =>
      rowsOfFlat(
        parquet.column(group, name),
        parquet.leaf(name),
        Number(parquet.rowGroups[group].rows),
      );
    for (let group = 0; group < parquet.rowGroups.length; group++) {
      const subtype = flat(group, 'subtype').map((value) =>
        value === null ? null : String(value),
      );
      rows += subtype.length;
      if (!subtype.some((value) => keep.has(value))) continue;
      const ids = flat(group, 'id');
      const cls = flat(group, 'class');
      const disputed = flat(group, 'is_disputed');
      const mode = flat(group, 'perspectives.mode');
      const countries = rowsOfRepeated(
        parquet.column(group, 'perspectives.countries.list.element'),
        parquet.leaf('perspectives.countries.list.element'),
      );
      const geometry = flat(group, 'geometry');
      for (let i = 0; i < subtype.length; i++) {
        if (!keep.has(subtype[i])) continue;
        const lines = wkbLines(geometry[i]);
        if (!lines) continue;
        kept++;
        onBoundary({
          id: ids[i] === null ? null : String(ids[i]),
          subtype: subtype[i],
          cls: cls[i] === null ? null : String(cls[i]),
          disputed: disputed[i] === true,
          perspective:
            mode[i] === null
              ? null
              : {
                  mode: String(mode[i]),
                  countries: (countries[i] || [])
                    .filter((code) => code !== null)
                    .map(String),
                },
          lines,
        });
      }
    }
  } finally {
    parquet.close();
  }
  return { rows, kept };
}

/**
 * A line's class: what the drawing tells apart. `classOf` hands out the
 * index a class gets in the level headers' `classes`.
 */
export function createClasses() {
  const table = [];
  const byKey = new Map();
  return {
    table,
    classOf({ cls, disputed, perspective }) {
      const entry = {
        class: cls || 'land',
        disputed: disputed === true,
        perspective: perspective
          ? {
              mode: perspective.mode,
              countries: [...perspective.countries].sort(),
            }
          : null,
      };
      const key = JSON.stringify(entry);
      let index = byKey.get(key);
      if (index === undefined) {
        index = table.length;
        table.push(entry);
        byKey.set(key, index);
      }
      return index;
    },
  };
}

/** A band's tolerance in world units. */
export const toleranceFor = (band) =>
  TOLERANCE_PX / (256 * 2 ** band.toleranceZoom);

/**
 * The margin a band's cells take in, in its quantized units: half the
 * widest line and a pixel of antialiasing at the band's shallowest zoom.
 */
export const marginUnits = (band) =>
  Math.ceil(
    ((MAX_WIDTH_PX / 2 + 1) / 256) * 2 ** (quantBitsFor(band) - band.minZoom),
  );

/**
 * The encoded pieces one line adds to every band, as onPiece(band, key,
 * bytes): projected, simplified for the band, quantized and cut into its
 * cells.
 * @param {Float64Array[]} lines [lon, lat, …] each
 */
export function boundaryPieces(lines, kind, onPiece, bands = BANDS) {
  const projected = lines.map(projectPart);
  for (const band of bands) {
    const quantBits = quantBitsFor(band);
    const cellShift = quantBits - band.gridZoom;
    const cellUnits = 2 ** cellShift;
    const tolerance = toleranceFor(band);
    const margin = marginUnits(band);
    for (const points of projected) {
      const coords = quantize(points, simplify(points, tolerance), quantBits);
      if (!coords) continue;
      splitIntoCells(
        coords,
        cellShift,
        (cx, cy, run) =>
          onPiece(
            band,
            cellKey(cx, cy, band.gridZoom),
            encodePiece(kind, run, cx * cellUnits, cy * cellUnits),
            run.length / 2,
          ),
        margin,
      );
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** What a build was made from: inputs, bands and format. */
export function boundariesSignature(inputs, bands = BANDS) {
  return {
    format: BOUNDARIES_FORMAT,
    subtypes: KEPT_SUBTYPES,
    bands,
    inputs: inputs.map(({ name, bytes }) => ({ name, bytes })),
  };
}

/**
 * Build the level files and manifest.json into `outDir` from the inputs.
 * An unchanged input and band table is skipped unless `force`.
 * @param {{outDir: string, inputs: {file: string, name: string, bytes: number}[],
 *   force?: boolean, log?: (line: string) => void, now?: () => number,
 *   bands?: object[], release?: string}} options
 */
export function runBoundariesBuild({
  outDir,
  inputs,
  force = false,
  log = () => {},
  now = () => Date.now(),
  bands = BANDS,
  release = OVERTURE_RELEASE,
}) {
  if (!inputs.length)
    throw new Error(
      `no Overture division_boundary file (raw/${release}/divisions/division_boundary/*.parquet); it is release/${release}/theme=divisions/type=division_boundary/ in Overture's bucket, 512 MB`,
    );
  const manifestFile = path.join(outDir, 'manifest.json');
  const signature = boundariesSignature(inputs, bands);
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
  const levelsDir = path.join(outDir, `levels-${stamp}`);
  fs.mkdirSync(levelsDir, { recursive: true });
  const classes = createClasses();
  /** band level → cell key → encoded pieces */
  const cells = new Map(bands.map((band) => [band.level, new Map()]));
  const counts = new Map(
    bands.map((band) => [band.level, { pieces: 0, vertices: 0 }]),
  );
  const byClass = {};
  let lines = 0;
  let disputed = 0;
  let vertices = 0;
  const sources = [];
  try {
    const readStart = now();
    for (const input of inputs) {
      const read = forEachBoundary(input.file, (boundary) => {
        const kind = classes.classOf(boundary);
        const label = `${boundary.cls || 'land'}${boundary.disputed ? ', disputed' : ''}`;
        byClass[label] = (byClass[label] || 0) + 1;
        lines++;
        if (boundary.disputed) disputed++;
        for (const line of boundary.lines) vertices += line.length / 2;
        boundaryPieces(
          boundary.lines,
          kind,
          (band, key, bytes, points) => {
            const held = cells.get(band.level);
            const list = held.get(key);
            if (list) list.push(bytes);
            else held.set(key, [bytes]);
            const count = counts.get(band.level);
            count.pieces++;
            count.vertices += points;
          },
          bands,
        );
      });
      sources.push({ file: input.name, bytes: input.bytes, ...read });
      log(`${input.name}: ${read.kept} lines of ${read.rows} rows`);
    }
    const readMs = Math.round(now() - readStart);
    const writeStart = now();
    const levels = [];
    for (const band of bands) {
      const relative = `levels-${stamp}/level-${band.level}.bin`;
      const writer = createLevelWriter(
        path.join(outDir, ...relative.split('/')),
      );
      const held = cells.get(band.level);
      const { pieces, vertices: points } = counts.get(band.level);
      let written;
      try {
        for (const key of [...held.keys()].sort((a, b) => a - b))
          writer.addCell(key, Buffer.concat(held.get(key)));
        written = writer.finish({
          level: band.level,
          minZoom: band.minZoom,
          maxZoom: band.maxZoom,
          gridZoom: band.gridZoom,
          toleranceZoom: band.toleranceZoom,
          quantBits: quantBitsFor(band),
          marginUnits: marginUnits(band),
          classes: classes.table,
          pieces,
          vertices: points,
        });
      } catch (error) {
        writer.abort();
        throw error;
      }
      levels.push({
        level: band.level,
        file: relative,
        minZoom: band.minZoom,
        maxZoom: band.maxZoom,
        gridZoom: band.gridZoom,
        bytes: written.bytes,
        cells: written.cells,
        pieces,
        vertices: points,
      });
      log(
        `${band.level} (z${band.minZoom}–${band.maxZoom}): ${written.cells} cells, ${pieces} pieces, ${points} vertices, ${(written.bytes / 1_048_576).toFixed(1)} MB`,
      );
    }
    const buildId = crypto
      .createHash('sha256')
      .update(JSON.stringify({ signature, levels, stamp }))
      .digest('hex')
      .slice(0, 16);
    const manifest = {
      format: BOUNDARIES_FORMAT,
      release,
      builtAt: new Date(now()).toISOString(),
      buildId,
      signature,
      sources,
      lines,
      disputed,
      vertices,
      byClass,
      classes: classes.table,
      levels,
      bytes: levels.reduce((sum, level) => sum + level.bytes, 0),
      timings: {
        readMs,
        writeMs: Math.round(now() - writeStart),
        totalMs: Math.round(now() - started),
      },
    };
    const temporary = `${manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporary, manifestFile);
    // Older builds and their tiles (every tile version names the build).
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        /^levels-b[0-9a-z]+$/.test(entry.name) &&
        entry.name !== `levels-${stamp}`
      )
        try {
          fs.rmSync(path.join(outDir, entry.name), {
            recursive: true,
            force: true,
          });
        } catch (error) {
          log(
            `could not remove ${entry.name} yet (${error.code || error.message}); the next build will`,
          );
        }
    try {
      fs.rmSync(path.join(outDir, 'tiles'), { recursive: true, force: true });
    } catch {
      /* a server may hold one open; stale versions are never served */
    }
    return { skipped: false, manifest };
  } catch (error) {
    fs.rmSync(levelsDir, { recursive: true, force: true });
    throw error;
  }
}

/** The build's status: its manifest's summary, or not built. */
export function boundariesStatus(outDir) {
  const manifest = readJson(path.join(outDir, 'manifest.json'), null);
  if (!manifest?.buildId) return { built: false, dir: outDir };
  return {
    built: true,
    dir: outDir,
    release: manifest.release,
    builtAt: manifest.builtAt,
    buildId: manifest.buildId,
    lines: manifest.lines,
    disputed: manifest.disputed,
    vertices: manifest.vertices,
    bytes: manifest.bytes,
    timings: manifest.timings,
  };
}
