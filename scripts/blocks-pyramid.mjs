#!/usr/bin/env node
/**
 * Personal fork: warm the Blocks pyramid's coarse levels for a box
 * (docs/BLOCKS-PLAN.md, milestone 5, decision 3).
 *
 *   npm run blocks:pyramid -- --bbox <w,s,e,n> --levels 1920,7680,30720
 *       [--pace <ms between Earth Engine requests, 500>] [--dry-run]
 *
 * Asks the Elevation values of every lattice tile (src/layers/blocks/
 * lattice.js: 512 cells of the level a side, the boxes the Blocks source
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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LATTICE_CELLS,
  latticeBox,
  latticeTilesOver,
} from '../src/layers/blocks/lattice.js';
import { BLOCK_PYRAMID_M } from '../src/layers/blocks/pyramid.js';
import { ELEVATION_LAYER, asksWater } from '../src/layers/blocks/source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The most tiles one run may ask. */
export const MAX_REQUESTS = 2000;
/** Milliseconds between two Earth Engine requests (a cached tile waits none). */
export const DEFAULT_PACE_MS = 500;

/**
 * The command line: {bbox: {west, south, east, north}, levels: number[],
 * paceMs, dryRun}, or {error}.
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
  return {
    bbox: { west, south, east, north },
    levels: [...new Set(levels)].sort((a, b) => b - a),
    paceMs,
    dryRun: argv.includes('--dry-run'),
  };
}

/** The values requests for a box at some levels: coarsest level first. */
export function planRequests(bbox, levels) {
  const requests = [];
  for (const level of levels)
    for (const { ti, tj } of latticeTilesOver(bbox, level)) {
      const box = latticeBox(level, ti, tj);
      requests.push({
        level,
        query: {
          layer: ELEVATION_LAYER,
          mode: '',
          west: String(box.west),
          south: String(box.south),
          east: String(box.east),
          north: String(box.north),
          cells: String(LATTICE_CELLS),
          ...(asksWater(level) ? { water: '1' } : {}),
        },
      });
    }
  return requests;
}

/**
 * Run: plan, check the count against MAX_REQUESTS and the day's budget,
 * then ask each in turn.
 * @param {{argv: string[], service?: {values: Function, close?: Function},
 *   budget?: () => {dailyTiles: number, total: number}, sleep?: Function,
 *   log?: Function}} options service and budget: the app's unless given.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  service,
  budget,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const requests = planRequests(args.bbox, args.levels);
  const perLevel = args.levels
    .map(
      (level) =>
        `${level} m: ${requests.filter((entry) => entry.level === level).length}`,
    )
    .join(', ');
  log(
    `${requests.length} tiles to ask (${perLevel}); a cached one costs nothing`,
  );
  if (requests.length > MAX_REQUESTS) {
    log(`more than ${MAX_REQUESTS}: stopping (a smaller box, or fewer levels)`);
    return 1;
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
  try {
    for (const [index, { query }] of requests.entries()) {
      const answer = await service.values(query);
      if (answer.status === 429) {
        log(
          `the day's Earth Engine budget is used: stopped at ${index} of ${requests.length}`,
        );
        return 1;
      }
      if (answer.status !== 200) {
        tally.failed++;
        log(`tile ${index + 1}: ${answer.status} ${answer.error ?? ''}`.trim());
      } else if (answer.cached) tally.cached++;
      else {
        tally.fetched++;
        if (index < requests.length - 1) await sleep(args.paceMs);
      }
      if ((index + 1) % 25 === 0 || index === requests.length - 1)
        log(
          `${index + 1} of ${requests.length}: ${tally.fetched} fetched, ${tally.cached} cached, ${tally.failed} failed`,
        );
    }
  } finally {
    await service.close?.();
  }
  return tally.failed ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().then((code) => process.exit(code));
