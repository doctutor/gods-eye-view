import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BANDS,
  MAX_ORDER,
  quantBitsFor,
} from '../../server/providers/riversV2/bands.js';
import { createLevelWriter } from '../../server/providers/riversV2/levelFile.js';
import { cellKey } from '../../server/providers/riversV2/tileMath.js';
import { marginUnits, reachPieces } from './levels.mjs';
import { findRiverInputs, forEachReach } from './sources.mjs';

/**
 * The steps of a HydroSHEDS v2 rivers build (scripts/rivers/index.mjs):
 * read every reach of each region's RIV_STREAMS layer once, give it its
 * v1-equivalent order from its upstream area, and for each zoom band that
 * draws it, simplify, quantize and cut it into the band's cells. Pieces go
 * to row-stripe partition files first (the Americas do not fit in memory),
 * then each band's stripes are sorted by cell into one level file.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** Bump when the level files change shape or meaning (forces a rebuild). */
export const BUILD_FORMAT = 2;

export const PRODUCT = Object.freeze({
  name: 'HydroSHEDS v2 river network (RIV_STREAMS)',
  version: 'v2r0',
  resolution: '1 arc-second',
  license: 'CC BY 4.0',
  page: 'https://www.hydrosheds.org/products/hydrosheds-v2',
  downloads: 'https://www.hydrosheds.org/downloads-core-data-v2',
});

/** The files the build reads, as published (sizes from the server). */
export const DOWNLOADS = Object.freeze([
  {
    region: 'north-america',
    dir: 'north-america-riv-gdb',
    file: 'north-america_RIV_1s_v2r0.gdb.zip',
    url: 'https://data.hydrosheds.org/file/hydrosheds-v2/RIV/1s/north-america_RIV_1s_v2r0.gdb.zip',
    bytes: 3_391_450_146,
  },
  {
    region: 'south-america',
    dir: 'south-america-riv-gdb',
    file: 'south-america_RIV_1s_v2r0.gdb.zip',
    url: 'https://data.hydrosheds.org/file/hydrosheds-v2/RIV/1s/south-america_RIV_1s_v2r0.gdb.zip',
    bytes: 1_430_637_101,
  },
]);

export const USER_AGENT = 'gods-eye-view-personal-fork/0.1 rivers';

/**
 * The layout of the rivers cache. The downloads are under raw/ unless
 * `rawDir` says otherwise (the CLI's GEV_RAW_DIR/rivers/raw,
 * scripts/rawDir.mjs).
 */
export function buildPaths(cacheDir, rawDir = null) {
  const v2 = path.join(cacheDir, 'v2');
  return {
    cacheDir,
    raw: rawDir || path.join(cacheDir, 'raw'),
    v2,
    manifest: path.join(v2, 'manifest.json'),
    runs: path.join(v2, 'runs.jsonl'),
    tiles: path.join(v2, 'tiles'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** What the build was made from: inputs, band table and format. */
export function buildSignature(inputs, bands = BANDS) {
  return {
    format: BUILD_FORMAT,
    bands,
    inputs: inputs.map((input) => ({
      region: input.region,
      name: path.basename(input.file),
      kind: input.kind,
      bytes: input.bytes,
    })),
  };
}

/**
 * Download the river files that are missing (or the wrong size), one at a
 * time, each into its own directory under raw/.
 */
export async function fetchDownloads({
  rawDir,
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  downloads = DOWNLOADS,
}) {
  const fetched = [];
  for (const download of downloads) {
    const dir = path.join(rawDir, download.dir);
    const file = path.join(dir, download.file);
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* missing */
    }
    if (size === download.bytes) {
      log(`${download.file}: present (${download.bytes} bytes)`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    log(
      `${download.file}: downloading ${(download.bytes / 1e9).toFixed(2)} GB`,
    );
    const response = await fetchImpl(download.url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
      redirect: 'follow',
    });
    if (!response.ok || !response.body)
      throw new Error(`${download.url} answered ${response.status}`);
    const temporary = `${file}.${process.pid}.tmp`;
    await new Promise((resolve, reject) => {
      const sink = fs.createWriteStream(temporary);
      const body = Readable.fromWeb(response.body);
      body.on('error', reject);
      sink.on('error', reject);
      sink.on('finish', resolve);
      body.pipe(sink);
    });
    const got = fs.statSync(temporary).size;
    if (got !== download.bytes) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`${download.file}: ${got} of ${download.bytes} bytes`);
    }
    fs.renameSync(temporary, file);
    fetched.push(download.file);
  }
  return fetched;
}

/**
 * Pieces of one band, appended to one file per row stripe of its cells:
 * each record is Uint32 cell key, Uint32 length, then the piece.
 */
function createPartitions(tmpDir, band) {
  const stripeZoom = Math.min(band.gridZoom, 7);
  const stripeShift = band.gridZoom - stripeZoom;
  const open = new Map();
  const FLUSH_AT = 4 << 20;
  const fileOf = (stripe) =>
    path.join(tmpDir, `${band.level}-${String(stripe).padStart(3, '0')}.part`);
  function partition(stripe) {
    let held = open.get(stripe);
    if (!held) {
      held = {
        fd: fs.openSync(fileOf(stripe), 'w'),
        buffer: Buffer.allocUnsafe(FLUSH_AT + (1 << 20)),
        used: 0,
      };
      open.set(stripe, held);
    }
    return held;
  }
  function flush(held) {
    let done = 0;
    while (done < held.used)
      done += fs.writeSync(held.fd, held.buffer, done, held.used - done);
    held.used = 0;
  }
  let pieces = 0;
  let vertices = 0;
  return {
    band,
    stripes: 2 ** stripeZoom,
    fileOf,
    get pieces() {
      return pieces;
    },
    get vertices() {
      return vertices;
    },
    /** Encode one piece straight into its stripe's buffer. */
    add(cx, cy, order, run, originX, originY) {
      const held = partition(cy >> stripeShift);
      const worst = 8 + 10 + run.length * 6;
      if (held.used + worst > held.buffer.length) {
        flush(held);
        if (worst > held.buffer.length) held.buffer = Buffer.allocUnsafe(worst);
      }
      const buffer = held.buffer;
      const start = held.used;
      buffer.writeUInt32LE(cellKey(cx, cy, band.gridZoom), start);
      let at = start + 8;
      const varuint = (value) => {
        let rest = value;
        while (rest >= 128) {
          buffer[at++] = (rest % 128) | 128;
          rest = Math.floor(rest / 128);
        }
        buffer[at++] = rest;
      };
      varuint(order);
      varuint(run.length / 2);
      let px = originX;
      let py = originY;
      for (let index = 0; index < run.length; index += 2) {
        const dx = run[index] - px;
        const dy = run[index + 1] - py;
        varuint(dx >= 0 ? dx * 2 : -dx * 2 - 1);
        varuint(dy >= 0 ? dy * 2 : -dy * 2 - 1);
        px = run[index];
        py = run[index + 1];
      }
      buffer.writeUInt32LE(at - start - 8, start + 4);
      held.used = at;
      pieces++;
      vertices += run.length / 2;
    },
    close() {
      for (const held of open.values()) {
        flush(held);
        fs.closeSync(held.fd);
      }
      return [...open.keys()].sort((a, b) => a - b);
    },
  };
}

/**
 * Sort a band's stripes by cell into its level file; the stripe files are
 * removed as they are used.
 */
function assembleLevel(partitions, stripes, file, header) {
  const writer = createLevelWriter(file);
  try {
    for (const stripe of stripes) {
      const part = partitions.fileOf(stripe);
      const data = fs.readFileSync(part);
      // Records: key, length, bytes. Sort (key, record order) in one Float64Array.
      const starts = [];
      const keys = [];
      for (let at = 0; at < data.length;) {
        keys.push(data.readUInt32LE(at));
        starts.push(at);
        at += 8 + data.readUInt32LE(at + 4);
      }
      const order = new Float64Array(keys.length);
      for (let index = 0; index < keys.length; index++)
        order[index] = keys[index] * 2 ** 26 + index;
      if (keys.length >= 2 ** 26)
        throw new Error(`stripe ${stripe} has too many pieces to sort`);
      order.sort();
      let index = 0;
      while (index < order.length) {
        const key = Math.floor(order[index] / 2 ** 26);
        const slices = [];
        while (
          index < order.length &&
          Math.floor(order[index] / 2 ** 26) === key
        ) {
          const record = order[index] % 2 ** 26;
          const start = starts[record];
          slices.push(
            data.subarray(start + 8, start + 8 + data.readUInt32LE(start + 4)),
          );
          index++;
        }
        writer.addCell(key, Buffer.concat(slices));
      }
      fs.rmSync(part, { force: true });
    }
    return writer.finish(header);
  } catch (error) {
    writer.abort();
    throw error;
  }
}

const elapsed = (start, now) => Math.round(now() - start);

/**
 * Build the level files and manifest from the inputs under raw/.
 * @param {{cacheDir: string, force?: boolean, limit?: number, log?: (line: string) => void,
 *   now?: () => number, inputs?: object[], bands?: object[]}} options
 */
export async function runBuild({
  cacheDir,
  rawDir,
  force = false,
  limit = Infinity,
  log = () => {},
  now = () => Date.now(),
  inputs,
  bands = BANDS,
}) {
  const paths = buildPaths(cacheDir, rawDir);
  const found = inputs || findRiverInputs(paths.raw);
  if (!found.length)
    throw new Error(
      `no HydroSHEDS v2 river files (*_RIV_*.gdb.zip or *.gpkg) under ${paths.raw}; run npm run rivers:fetch (4.8 GB) first`,
    );
  const signature = buildSignature(found, bands);
  const previous = readJson(paths.manifest, null);
  // Up to date: a complete build (no --limit) from the same inputs and bands.
  if (
    !force &&
    previous?.complete === true &&
    JSON.stringify(previous.signature) === JSON.stringify(signature)
  ) {
    log(`unchanged since ${previous.builtAt}; --force to rebuild`);
    return { skipped: true, manifest: previous };
  }
  const started = now();
  const stamp = `b${started.toString(36)}`;
  const levelsDir = path.join(paths.v2, `levels-${stamp}`);
  const tmpDir = path.join(paths.v2, `tmp-${stamp}`);
  fs.mkdirSync(levelsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const partitions = new Map(
    bands.map((band) => [band.level, createPartitions(tmpDir, band)]),
  );
  const byOrder = Array.from({ length: MAX_ORDER + 1 }, () => ({
    reaches: 0,
    km: 0,
  }));
  const extent = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };
  const sources = [];
  let reaches = 0;
  let vertices = 0;
  try {
    for (const input of found) {
      const readStart = now();
      let count = 0;
      const result = await forEachReach(input, (reach) => {
        const order = reachPieces(
          reach,
          (band, cx, cy, pieceOrder, run, originX, originY) =>
            partitions
              .get(band.level)
              .add(cx, cy, pieceOrder, run, originX, originY),
          bands,
        );
        byOrder[order].reaches++;
        byOrder[order].km += Number(reach.lengthKm) || 0;
        for (const part of reach.parts) {
          vertices += part.length / 2;
          for (let at = 0; at < part.length; at += 2) {
            const lon = part[at];
            const lat = part[at + 1];
            if (lon < extent.west) extent.west = lon;
            if (lon > extent.east) extent.east = lon;
            if (lat < extent.south) extent.south = lat;
            if (lat > extent.north) extent.north = lat;
          }
        }
        count++;
        if (count % 1_000_000 === 0)
          log(`${input.region}: ${(count / 1e6).toFixed(0)} M reaches`);
        return count < limit;
      });
      reaches += count;
      sources.push({
        region: input.region,
        file: path.basename(input.file),
        kind: input.kind,
        bytes: input.bytes,
        table: result.table,
        fields: result.fields,
        reaches: count,
        complete: !result.stopped,
        readMs: elapsed(readStart, now),
      });
      log(
        `${input.region}: ${count} reaches from ${result.table} in ${((now() - readStart) / 1000).toFixed(1)} s`,
      );
    }
    const writeStart = now();
    const levels = [];
    for (const band of bands) {
      const held = partitions.get(band.level);
      const stripes = held.close();
      const relative = `levels-${stamp}/level-${band.level}.bin`;
      const levelStart = now();
      const written = assembleLevel(
        held,
        stripes,
        path.join(paths.v2, ...relative.split('/')),
        {
          level: band.level,
          minZoom: band.minZoom,
          maxZoom: band.maxZoom,
          maxOrder: band.maxOrder,
          gridZoom: band.gridZoom,
          toleranceZoom: band.toleranceZoom,
          quantBits: quantBitsFor(band),
          marginUnits: marginUnits(band),
          pieces: held.pieces,
          vertices: held.vertices,
        },
      );
      levels.push({
        level: band.level,
        file: relative,
        minZoom: band.minZoom,
        maxZoom: band.maxZoom,
        maxOrder: band.maxOrder,
        gridZoom: band.gridZoom,
        bytes: written.bytes,
        cells: written.cells,
        pieces: held.pieces,
        vertices: held.vertices,
        writeMs: elapsed(levelStart, now),
      });
      log(
        `${band.level} (z${band.minZoom}–${band.maxZoom}, order ≤ ${band.maxOrder}): ${written.cells} cells, ${held.pieces} pieces, ${held.vertices} vertices, ${(written.bytes / 1_048_576).toFixed(1)} MB`,
      );
    }
    const buildId = crypto
      .createHash('sha256')
      .update(JSON.stringify({ signature, levels, stamp }))
      .digest('hex')
      .slice(0, 16);
    const manifest = {
      format: BUILD_FORMAT,
      product: PRODUCT,
      builtAt: new Date(now()).toISOString(),
      buildId,
      signature,
      complete: sources.every((source) => source.complete),
      sources,
      reaches,
      vertices,
      byOrder: byOrder
        .map((entry, order) => ({
          order,
          reaches: entry.reaches,
          km: Math.round(entry.km),
        }))
        .filter((entry) => entry.order >= 1),
      extent: reaches ? extent : null,
      levels,
      bytes: levels.reduce((sum, level) => sum + level.bytes, 0),
      timings: {
        readMs: sources.reduce((sum, source) => sum + source.readMs, 0),
        writeMs: elapsed(writeStart, now),
        totalMs: elapsed(started, now),
      },
    };
    const temporary = `${paths.manifest}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporary, paths.manifest);
    fs.appendFileSync(
      paths.runs,
      `${JSON.stringify({ builtAt: manifest.builtAt, buildId, reaches, bytes: manifest.bytes, timings: manifest.timings })}\n`,
    );
    // Older builds and their tiles (every tile version names the build).
    for (const entry of fs.readdirSync(paths.v2, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        /^levels-b[0-9a-z]+$/.test(entry.name) &&
        entry.name !== `levels-${stamp}`
      )
        try {
          fs.rmSync(path.join(paths.v2, entry.name), {
            recursive: true,
            force: true,
          });
        } catch (error) {
          log(
            `could not remove ${entry.name} yet (${error.code || error.message}); the next build will`,
          );
        }
    try {
      fs.rmSync(paths.tiles, { recursive: true, force: true });
    } catch {
      /* a server may hold one open; stale versions are never served */
    }
    return { skipped: false, manifest };
  } catch (error) {
    for (const held of partitions.values())
      try {
        held.close();
      } catch {
        /* already closed */
      }
    fs.rmSync(levelsDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
