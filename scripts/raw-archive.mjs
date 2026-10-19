#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RAW_DIR_ENV, checkRawDir, rawRoot } from './rawDir.mjs';

/**
 * Move the builds' raw downloads out of the cache onto the raw archive
 * (GEV_RAW_DIR, say a NAS share), leaving the derived builds where they are:
 *
 *   npm run raw:archive -- [--dry-run] [--to DIR] [--cache DIR] [--only a,b]
 *
 * What moves (each build's raw/ as GEV_RAW_DIR/<build>/raw):
 *   rivers/raw (the HydroSHEDS v2 ZIPs), overture/raw (the divisions file,
 *   the buildings footers, any --keep-raw row groups), census/raw (the
 *   boundaries ZIP), and the Wikipedia dump with its metadata.
 *
 * Each file is copied to a temp name beside its destination, checked for
 * size, renamed into place with its time kept, and only then removed from
 * the cache. A file already there at its size is not copied again, so a
 * stopped or repeated run picks up where it was (idempotent). A copy that
 * makes no progress for STALL_MS is abandoned with a message, and the
 * archive is checked (in a child process, with a time limit) before
 * anything moves, so a slow or absent share never hangs the command.
 * Files being written (*.partial, *.tmp) are left alone.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A copy that moves no bytes for this long is abandoned. */
export const STALL_MS = 60_000;

/** The raw folders and files of each build, under the cache. */
export function rawSources(cache) {
  return [
    { build: 'rivers', dir: path.join(cache, 'rivers', 'raw') },
    { build: 'overture', dir: path.join(cache, 'overture', 'raw') },
    { build: 'census', dir: path.join(cache, 'census', 'raw') },
    {
      build: 'wikipedia',
      dir: path.join(cache, 'wikipedia'),
      // The dump, its metadata, and the page dump if one was kept; not
      // the grid or the H3 file, which the build makes.
      only: /^(enwiki-latest-[a-z_]+\.sql\.gz|[a-z_]+\.meta\.json)$/,
    },
  ];
}

const inProgress = (name) =>
  /\.(partial|tmp)$/.test(name) || /\.\d+\.tmp$/.test(name);

/** Every file to move: {build, from, to, size, mtimeMs}. */
export function planArchive({ cache, to, only = null }) {
  const moves = [];
  const skipped = [];
  for (const source of rawSources(cache)) {
    if (only && !only.includes(source.build)) continue;
    if (!fs.existsSync(source.dir)) continue;
    const target = path.join(to, source.build, 'raw');
    const walk = (dir, rel, top) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const from = path.join(dir, entry.name);
        const name = path.join(rel, entry.name);
        if (entry.isDirectory()) {
          if (top && source.only) continue;
          walk(from, name, false);
        } else if (entry.isFile()) {
          if (top && source.only && !source.only.test(entry.name)) continue;
          if (inProgress(entry.name)) {
            skipped.push(from);
            continue;
          }
          const stat = fs.statSync(from);
          moves.push({
            build: source.build,
            from,
            to: path.join(target, name),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        }
      }
    };
    walk(source.dir, '', true);
  }
  return { moves, skipped };
}

/** Whether a destination already holds the file (its size). */
function alreadyThere(move) {
  try {
    return fs.statSync(move.to).size === move.size;
  } catch {
    return false;
  }
}

/** Copy one file to its destination, atomically, abandoning a stalled copy. */
export async function copyFile(move, { stallMs = STALL_MS } = {}) {
  fs.mkdirSync(path.dirname(move.to), { recursive: true });
  const temporary = `${move.to}.${process.pid}.partial`;
  let moved = 0;
  let last = 0;
  const watch = new Transform({
    transform(chunk, _encoding, done) {
      moved += chunk.length;
      done(null, chunk);
    },
  });
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (moved === last)
      controller.abort(
        new Error(`no progress for ${Math.round(stallMs / 1000)} s`),
      );
    last = moved;
  }, stallMs);
  try {
    await pipeline(
      fs.createReadStream(move.from),
      watch,
      fs.createWriteStream(temporary),
      {
        signal: controller.signal,
      },
    );
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error(
      `${move.from} → ${move.to}: ${error?.cause?.message || error?.message || error}`,
    );
  } finally {
    clearInterval(timer);
  }
  const size = fs.statSync(temporary).size;
  if (size !== move.size) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`${move.to}: ${size} bytes copied, expected ${move.size}`);
  }
  fs.renameSync(temporary, move.to);
  const time = new Date(move.mtimeMs);
  fs.utimesSync(move.to, time, time);
}

/** Remove the source folders the move emptied (never the cache's build folders). */
function removeEmpty(dir, stopAt) {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (fs.readdirSync(current).length) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/**
 * @param {{cache: string, to: string, dryRun?: boolean, only?: string[]|null,
 *   log?: Function, check?: Function, stallMs?: number}} options
 */
export async function archive({
  cache,
  to,
  dryRun = false,
  only = null,
  log = console.log,
  check = checkRawDir,
  stallMs,
}) {
  const { moves, skipped } = planArchive({ cache, to, only });
  const total = moves.reduce((sum, m) => sum + m.size, 0);
  const there = moves.filter(alreadyThere);
  log(
    `[raw] ${moves.length} files, ${(total / 1e9).toFixed(2)} GB, from ${cache} to ${to}` +
      (there.length
        ? `; ${there.length} already there (${(there.reduce((s, m) => s + m.size, 0) / 1e9).toFixed(2)} GB)`
        : ''),
  );
  for (const file of skipped) log(`[raw] left alone (being written): ${file}`);
  const byBuild = {};
  for (const move of moves) {
    const entry = (byBuild[move.build] ||= { files: 0, bytes: 0 });
    entry.files += 1;
    entry.bytes += move.size;
  }
  for (const [build, entry] of Object.entries(byBuild))
    log(
      `[raw]   ${build}: ${entry.files} files, ${(entry.bytes / 1e9).toFixed(2)} GB → ${path.join(to, build, 'raw')}`,
    );
  if (dryRun) {
    for (const move of moves)
      log(
        `[raw] ${alreadyThere(move) ? 'there, would remove' : 'would move'}: ${move.from} → ${move.to}`,
      );
    return { moves: moves.length, bytes: total, moved: 0, dryRun: true };
  }
  if (!moves.length) return { moves: 0, bytes: 0, moved: 0 };
  check(to);
  const started = Date.now();
  let moved = 0;
  let copied = 0;
  for (const move of moves) {
    if (!alreadyThere(move)) {
      await copyFile(move, { stallMs });
      copied += move.size;
    }
    fs.rmSync(move.from);
    moved += 1;
    removeEmpty(path.dirname(move.from), cache);
    if (move.size > 100e6 || moved % 200 === 0)
      log(
        `[raw] ${moved} of ${moves.length} files, ${(copied / 1e9).toFixed(2)} GB copied, ${((Date.now() - started) / 1000).toFixed(0)} s`,
      );
  }
  log(
    `[raw] moved ${moved} files (${(copied / 1e9).toFixed(2)} GB copied) in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  return { moves: moves.length, bytes: total, moved, copied };
}

export function parseArgs(argv) {
  const flags = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--to') flags.to = argv[++i];
    else if (argv[i] === '--cache') flags.cache = argv[++i];
    else if (argv[i] === '--only')
      flags.only = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const configured = rawRoot();
  const to = flags.to ? path.resolve(flags.to) : configured;
  if (!to)
    throw new Error(`Say where: --to DIR, or set ${RAW_DIR_ENV} in .env`);
  const cache = flags.cache
    ? path.resolve(flags.cache)
    : path.join(ROOT, '.gev-cache');
  await archive({ cache, to, dryRun: flags.dryRun, only: flags.only || null });
  if (!flags.dryRun && configured !== to)
    console.log(
      `[raw] Set ${RAW_DIR_ENV}=${to} in .env so the builds read their raw files from there.`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[raw] ${error?.message || error}`);
    process.exitCode = 1;
  });
