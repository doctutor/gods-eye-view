#!/usr/bin/env node
/**
 * Personal fork: warm the Blocks pyramid's coarse levels for a box
 * (docs/BLOCKS-PLAN.md, milestone 5, decision 3).
 *
 *   npm run blocks:pyramid -- --bbox <w,s,e,n> --levels 1920,7680,30720
 *       [--pace <ms between Earth Engine requests, 500>] [--dry-run]
 *       [--server http://localhost:4173] [--concurrency 1|2|3|4]
 *       [--land-only]
 *
 * Asks the Elevation values of every lattice tile (src/layers/blocks/
 * lattice.js: 512 cells of the level a side, 256 at 480 and 1,920 m, the
 * boxes the Blocks source
 * asks, with the water plane where it does: source.js asksWater) over
 * the box at each level, one at a time, through the raster
 * values service as the app's server would: the same 30-day cache under
 * .gev-cache/raster-values (a tile already there costs nothing) and the
 * same Earth Engine day's budget (each fresh tile counts one). The count
 * is printed before anything is asked; more than MAX_REQUESTS, or more
 * than the day has left, and it stops there. --dry-run prints the count
 * and asks nothing. A 429 (the day used) stops it; other failures are
 * counted and the rest go on. Reads the Earth Engine key from .env as the
 * server does; prints none of it.
 *
 * --server asks a running app server instead (GET /api/raster/values and
 * /api/earth-engine/budget, nothing else): its cache, its budget, its
 * key; this process reads no .env and writes nothing. A tile is cached
 * when the server's X-Raster-Values-Cache says hit (a server without the
 * header: answered in under CACHED_MS). --concurrency asks that many at
 * once (1 by default). MAX_RECENT_FAILURES in the last FAILURE_WINDOW
 * answers stop the run. --land-only skips the tiles finer than
 * LAND_FROM_M whose ground is all sea in that level's tiles (asked first,
 * from the cache once that level is warm): the 120 m warm-up's open sea.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  latticeBox,
  latticeCells,
  latticeTilesOver,
} from '../src/layers/blocks/lattice.js';
import { BLOCK_PYRAMID_M } from '../src/layers/blocks/pyramid.js';
import { ELEVATION_LAYER, asksWater } from '../src/layers/blocks/source.js';
import { decodeRasterValues } from '../src/data/rasterValues.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The most tiles one run may ask. */
export const MAX_REQUESTS = 2000;
/** Milliseconds between two Earth Engine requests (a cached tile waits none). */
export const DEFAULT_PACE_MS = 500;
/** The most tiles asked at once (--concurrency). */
export const MAX_CONCURRENCY = 4;
/** A server answer this quick without X-Raster-Values-Cache is its cache's. */
export const CACHED_MS = 1000;
/** The level whose tiles say where the land is, for --land-only. */
export const LAND_FROM_M = 480;
/** The run stops when this many of the last FAILURE_WINDOW answers failed. */
export const MAX_RECENT_FAILURES = 10;
export const FAILURE_WINDOW = 40;

/**
 * The command line: {bbox: {west, south, east, north}, levels: number[],
 * paceMs, concurrency, server?, landOnly, dryRun}, or {error}.
 */
export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const numbers = (text) =>
    String(text ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
  const box = numbers(value('--bbox'));
  if (box.length !== 4 || !box.every(Number.isFinite))
    return { error: '--bbox west,south,east,north is required' };
  const [west, south, east, north] = box;
  if (west < -180 || east > 180 || !(west < east))
    return { error: '--bbox needs -180 ≤ west < east ≤ 180' };
  if (south < -90 || north > 90 || !(south < north))
    return { error: '--bbox needs -90 ≤ south < north ≤ 90' };
  const levels = numbers(value('--levels'));
  if (!levels.length) return { error: '--levels a,b,… is required' };
  const unknown = levels.filter((level) => !BLOCK_PYRAMID_M.includes(level));
  if (unknown.length)
    return {
      error: `--levels must be pyramid levels (${BLOCK_PYRAMID_M.join(', ')}): not ${unknown.join(', ')}`,
    };
  const pace = value('--pace');
  const paceMs = pace === undefined ? DEFAULT_PACE_MS : Number(pace);
  if (!(paceMs >= 0)) return { error: '--pace needs milliseconds ≥ 0' };
  const rawConcurrency = value('--concurrency');
  const concurrency = rawConcurrency === undefined ? 1 : Number(rawConcurrency);
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  )
    return { error: `--concurrency needs 1 to ${MAX_CONCURRENCY}` };
  const server = value('--server');
  if (server !== undefined && !/^https?:\/\/[^/]+$/.test(server))
    return { error: '--server needs an origin, as http://localhost:4173' };
  return {
    bbox: { west, south, east, north },
    levels: [...new Set(levels)].sort((a, b) => b - a),
    paceMs,
    concurrency,
    ...(server ? { server } : {}),
    landOnly: argv.includes('--land-only'),
    dryRun: argv.includes('--dry-run'),
  };
}

/** A lattice tile's values query, as the Blocks source asks it. */
export function tileQuery(level, ti, tj) {
  const box = latticeBox(level, ti, tj);
  return {
    layer: ELEVATION_LAYER,
    mode: '',
    west: String(box.west),
    south: String(box.south),
    east: String(box.east),
    north: String(box.north),
    cells: String(latticeCells(level)),
    ...(asksWater(level) ? { water: '1' } : {}),
  };
}

/** The values requests for a box at some levels: coarsest level first. */
export function planRequests(bbox, levels) {
  const requests = [];
  for (const level of levels)
    for (const { ti, tj } of latticeTilesOver(bbox, level))
      requests.push({ level, query: tileQuery(level, ti, tj) });
  return requests;
}

/**
 * A values answer's land as a mask: 1 where a cell is above 0 m (the sea,
 * and ground at or below it, is 0 m in the server's means; nodata is not
 * land). {west, south, east, north, cols, rows, land: Uint8Array}.
 */
export function landMask({ header, values }) {
  const land = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) land[i] = values[i] > 0 ? 1 : 0;
  const { west, south, east, north, cols, rows } = header;
  return { west, south, east, north, cols, rows, land };
}

/** Whether a mask has land in a box: a land cell whose centre is in it. */
export function landIn(mask, box) {
  const { west, south, east, north, cols, rows, land } = mask;
  const dx = (east - west) / cols;
  const dy = (north - south) / rows;
  const c0 = Math.max(0, Math.ceil((box.west - west) / dx - 0.5));
  const c1 = Math.min(cols - 1, Math.floor((box.east - west) / dx - 0.5));
  const r0 = Math.max(0, Math.ceil((north - box.north) / dy - 0.5));
  const r1 = Math.min(rows - 1, Math.floor((north - box.south) / dy - 0.5));
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (land[r * cols + c]) return true;
  return false;
}

/**
 * The requests without the tiles finer than LAND_FROM_M whose ground is
 * all sea in that level's tiles; `ask(query)` gives a decoded answer
 * ({header, values}) or null. A tile whose land tiles cannot be read is
 * kept. Each land tile is asked once.
 * @returns {Promise<{kept: object[], skipped: number, asked: number}>}
 */
export async function landRequests(requests, ask) {
  const masks = new Map(); // ti:tj → Promise<mask | null>
  const kept = [];
  let skipped = 0;
  for (const request of requests) {
    if (request.level >= LAND_FROM_M) {
      kept.push(request);
      continue;
    }
    const box = Object.fromEntries(
      ['west', 'south', 'east', 'north'].map((key) => [
        key,
        Number(request.query[key]),
      ]),
    );
    let land = false;
    let unknown = false;
    for (const { ti, tj } of latticeTilesOver(box, LAND_FROM_M)) {
      const key = `${ti}:${tj}`;
      if (!masks.has(key))
        masks.set(
          key,
          Promise.resolve()
            .then(() => ask(tileQuery(LAND_FROM_M, ti, tj)))
            .then(
              (answer) => (answer ? landMask(answer) : null),
              () => null,
            ),
        );
      const mask = await masks.get(key);
      if (!mask) unknown = true;
      else if (landIn(mask, box)) {
        land = true;
        break;
      }
    }
    if (land || unknown) kept.push(request);
    else skipped++;
  }
  return { kept, skipped, asked: masks.size };
}

/**
 * A running app server as the service and the budget (--server): GET
 * only. values(query) → {status, body?, cached?, error?}; a request that
 * gets no answer is status 0.
 */
export function serverService(
  origin,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
) {
  return {
    async values(query) {
      const started = now();
      try {
        const response = await fetchImpl(
          `${origin}/api/raster/values?${new URLSearchParams(query)}`,
        );
        const body = new Uint8Array(await response.arrayBuffer());
        if (!response.ok) {
          let error = '';
          try {
            error = JSON.parse(new TextDecoder().decode(body)).error || '';
          } catch {
            /* not JSON */
          }
          return { status: response.status, error };
        }
        const said = response.headers.get('x-raster-values-cache');
        return {
          status: 200,
          body,
          cached: said ? said === 'hit' : now() - started < CACHED_MS,
        };
      } catch (error) {
        return { status: 0, error: String(error?.message || error) };
      }
    },
    async budget() {
      const response = await fetchImpl(`${origin}/api/earth-engine/budget`);
      return response.ok ? response.json() : null;
    },
  };
}

/**
 * Run: plan (less the all-sea tiles with --land-only), check the count
 * against MAX_REQUESTS and the day's budget, then ask them, `concurrency`
 * at a time.
 * @param {{argv: string[], service?: {values: Function, close?: Function},
 *   budget?: () => {dailyTiles: number, total: number}, sleep?: Function,
 *   log?: Function, now?: Function}} options service and budget: the
 *   app's (or --server's) unless given.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  service,
  budget,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  now = () => Date.now(),
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const started = now();
  let requests = planRequests(args.bbox, args.levels);
  const perLevel = () =>
    args.levels
      .map(
        (level) =>
          `${level} m: ${requests.filter((entry) => entry.level === level).length}`,
      )
      .join(', ');
  log(
    `${requests.length} tiles to ask (${perLevel()}); a cached one costs nothing`,
  );
  const filtering =
    args.landOnly && requests.some((entry) => entry.level < LAND_FROM_M);
  if (!filtering && requests.length > MAX_REQUESTS) {
    log(`more than ${MAX_REQUESTS}: stopping (a smaller box, or fewer levels)`);
    return 1;
  }
  if (!service && args.server) {
    const remote = serverService(args.server);
    service = remote;
    budget ||= () => remote.budget();
  }
  if (filtering) {
    if (!service) {
      log('--land-only needs --server (or a service)');
      return 2;
    }
    const { kept, skipped, asked } = await landRequests(
      requests,
      async (query) => {
        const answer = await service.values(query);
        return answer.status === 200 && answer.body
          ? decodeRasterValues(answer.body)
          : null;
      },
    );
    requests = kept;
    log(
      `--land-only: ${skipped} all-sea tiles skipped (read from ${asked} tiles at ${LAND_FROM_M} m); ${requests.length} left (${perLevel()})`,
    );
    if (requests.length > MAX_REQUESTS) {
      log(
        `more than ${MAX_REQUESTS}: stopping (a smaller box, or fewer levels)`,
      );
      return 1;
    }
  }
  if (args.dryRun) return 0;
  if (!service) {
    const envFile = path.join(ROOT, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    const { createRasterValuesService } =
      await import('../server/providers/rasterValues.js');
    const { sharedEarthEngineService } =
      await import('../server/providers/earthEngine.js');
    service = createRasterValuesService({ sourceRoot: ROOT });
    budget ||= () => sharedEarthEngineService(ROOT).budget();
  }
  const today = await budget?.();
  if (today) {
    const left = Math.max(0, today.dailyTiles - today.total);
    log(
      `Earth Engine today: ${today.total} of ${today.dailyTiles} used, ${left} left`,
    );
    if (requests.length > left) {
      log(`more tiles than the day has left: stopping (or run it tomorrow)`);
      await service.close?.();
      return 1;
    }
  }
  const tally = { cached: 0, fetched: 0, failed: 0 };
  const seconds = () => Math.round((now() - started) / 1000);
  const recent = []; // the last FAILURE_WINDOW answers: true for a failure
  let next = 0;
  let done = 0;
  let stopped = null;
  const answered = (failed) => {
    done++;
    recent.push(failed);
    if (recent.length > FAILURE_WINDOW) recent.shift();
    if (!stopped && recent.filter(Boolean).length >= MAX_RECENT_FAILURES)
      stopped = `${MAX_RECENT_FAILURES} of the last ${recent.length} answers failed: stopped at ${done} of ${requests.length}`;
    if (done % 25 === 0 || done === requests.length)
      log(
        `${done} of ${requests.length}: ${tally.fetched} fetched, ${tally.cached} cached, ${tally.failed} failed, ${seconds()} s`,
      );
  };
  // Each worker takes the next tile; a fresh one is followed by the pace.
  const worker = async () => {
    while (!stopped && next < requests.length) {
      const index = next++;
      const { level, query } = requests[index];
      const answer = await service.values(query);
      if (answer.status === 429) {
        stopped ||= `the day's Earth Engine budget is used: stopped at ${done} of ${requests.length}`;
        return;
      }
      if (answer.status !== 200) {
        tally.failed++;
        log(
          `tile ${index + 1} (${level} m): ${answer.status} ${answer.error ?? ''}`.trim(),
        );
        answered(true);
      } else if (answer.cached) {
        tally.cached++;
        answered(false);
      } else {
        tally.fetched++;
        answered(false);
        if (next < requests.length) await sleep(args.paceMs);
      }
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(args.concurrency, requests.length) },
        worker,
      ),
    );
  } finally {
    await service.close?.();
  }
  if (stopped) {
    log(stopped);
    return 1;
  }
  const after = today ? await budget?.() : null;
  log(
    `done: ${requests.length} asked, ${tally.fetched + tally.cached} answered (${tally.fetched} fetched, ${tally.cached} cached), ${tally.failed} failed, ${seconds()} s` +
      (after ? `; Earth Engine ${today.total} → ${after.total} today` : ''),
  );
  return tally.failed ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().then((code) => process.exit(code));
