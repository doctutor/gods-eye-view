#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFRESH_EVERY_DAYS, buildFiles, runBuild } from './build.mjs';
import { readGridHeader } from '../../server/providers/wikipediaCoverage/grid.js';
import { readArrayFileHeader } from '../../server/providers/wikipediaCoverage/arrayFile.js';
import {
  H3_MAGIC,
  H3_VERSION,
} from '../../server/providers/wikipediaCoverage/h3.js';

/**
 * Wikipedia coverage: where English Wikipedia has written about the Earth,
 * as a grid the app's ANALYSIS layer drapes on the globe.
 *
 *   node scripts/wikipedia/index.mjs build [--text] [--force] [--offline]
 *        [--limit N] [--dir DIR]
 *   node scripts/wikipedia/index.mjs status [--json] [--dir DIR]
 *
 * `build` downloads Wikimedia's GeoData dump (enwiki-latest-geo_tags.sql.gz,
 * about 53 MB) unless the server says it is unchanged, counts every primary
 * Earth coordinate into 0.05° cells with coarser levels above, and writes
 * `grid.bin`. With `--text` it also streams the page table once (about 2 GB,
 * never written to disk) for each article's size, so the layer can show text
 * per km² as well as articles per km². The dump refreshes about twice a
 * month; run `build` monthly (npm run wikipedia:build) and the ETag makes an
 * unchanged month a few seconds.
 *
 * Everything lives in WIKIPEDIA_COVERAGE_DIR (default .gev-cache/wikipedia in
 * the repository): the dump, geo_tags.meta.json (ETag, Last-Modified),
 * grid.bin and runs.jsonl. The dump and the grid are never committed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function parseArgs(argv) {
  const [command = 'status', ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--'))
      throw new Error(`unexpected argument ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith('--'))
      flags[name] = rest[++index];
    else flags[name] = true;
  }
  return { command, flags };
}

export function wikipediaDir(env = process.env, flags = {}) {
  const configured = flags.dir || env.WIKIPEDIA_COVERAGE_DIR;
  return configured
    ? path.resolve(ROOT, configured)
    : path.join(ROOT, '.gev-cache', 'wikipedia');
}

const limitOf = (value) => {
  if (value === undefined || value === true) return Infinity;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error('--limit must be a positive integer');
  return number;
};

/** What `status` reports: the grid's header, its age, and the dump's. */
export function statusOf(dir, now = () => Date.now()) {
  const files = buildFiles(dir);
  if (!fs.existsSync(files.grid))
    return { built: false, dir, hint: 'npm run wikipedia:build' };
  const { header } = readGridHeader(files.grid);
  const builtAt = Date.parse(header.builtAt);
  const ageDays = Number.isFinite(builtAt)
    ? Math.floor((now() - builtAt) / 86_400_000)
    : null;
  return {
    built: true,
    dir,
    builtAt: header.builtAt,
    ageDays,
    stale: ageDays !== null && ageDays > REFRESH_EVERY_DAYS,
    dump: header.dump,
    rows: header.rows,
    text: header.text,
    domains: header.domains,
    types: header.types,
    countries: header.countries,
    bytes: fs.statSync(files.grid).size,
    h3: h3StatusOf(files.h3),
  };
}

/** The H3 file's part of the status: built or not, its size, cells by resolution. */
export function h3StatusOf(file) {
  if (!fs.existsSync(file)) return { built: false };
  try {
    const { header } = readArrayFileHeader(file, H3_MAGIC, H3_VERSION);
    return {
      built: true,
      bytes: fs.statSync(file).size,
      builtAt: header.builtAt,
      text: Boolean(header.text?.included),
      resolutions: header.resolutions.map(({ res, cells }) => ({ res, cells })),
    };
  } catch (error) {
    return { built: false, error: String(error?.message || error) };
  }
}

function statusLines(status) {
  if (!status.built) return [`no grid in ${status.dir}; run ${status.hint}`];
  const number = (value) => Number(value || 0).toLocaleString('en-US');
  const lines = [
    `grid: ${status.dir}${path.sep}grid.bin (${(status.bytes / 1_048_576).toFixed(1)} MB)`,
    `built: ${status.builtAt} (${status.ageDays} days ago${status.stale ? '; older than a month, rebuild' : ''})`,
    `dump: ${status.dump.date || '?'} (${status.dump.lastModified || 'no Last-Modified'})`,
    `rows: ${number(status.rows.read)} read, ${number(status.rows.kept)} primary Earth coordinates kept, ${number(status.rows.otherGlobe)} other globes, ${number(status.rows.secondary)} secondary, ${number(status.rows.invalid)} invalid`,
    status.text.included
      ? `text: ${number(status.text.pagesMatched)} articles sized, ${number(status.text.bytes)} bytes`
      : 'text: not built (add --text)',
  ];
  for (const [variant, domain] of Object.entries(status.domains || {}))
    if (domain)
      lines.push(
        `${variant}: ${number(domain.cells)} cells, median ${domain.median.toPrecision(3)}, ramp ${domain.min.toPrecision(3)} to ${domain.max.toPrecision(3)}`,
      );
  if (status.types?.length)
    lines.push(
      `types: ${status.types.map(({ key, count }) => `${key} ${number(count)}`).join(', ')}`,
    );
  lines.push(
    status.h3?.built
      ? `h3: ${(status.h3.bytes / 1_048_576).toFixed(1)} MB, cells by resolution ${status.h3.resolutions.map(({ res, cells }) => `${res}:${number(cells)}`).join(' ')}${status.h3.text ? '' : ' (no article sizes)'}`
      : `h3: not built${status.h3?.error ? ` (${status.h3.error})` : ''}; run npm run wikipedia:build`,
  );
  return lines;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const dir = wikipediaDir(process.env, flags);
  const log = (line) => console.log(`[wikipedia] ${line}`);
  if (command === 'status') {
    const status = statusOf(dir);
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else for (const line of statusLines(status)) console.log(line);
    return status.built ? 0 : 1;
  }
  if (command === 'build') {
    const current = statusOf(dir);
    const result = await runBuild({
      dir,
      text: Boolean(flags.text),
      force: Boolean(flags.force),
      offline: Boolean(flags.offline),
      limit: limitOf(flags.limit),
      log,
      currentHeader: current.built
        ? readGridHeader(buildFiles(dir).grid).header
        : null,
    });
    if (!result.skipped)
      for (const line of statusLines(statusOf(dir))) log(line);
    return 0;
  }
  console.error(`unknown command ${command}; use build or status`);
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[wikipedia] ${error?.message || error}`);
      process.exit(1);
    },
  );
}
