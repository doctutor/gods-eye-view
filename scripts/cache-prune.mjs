#!/usr/bin/env node
/**
 * Personal fork: list the raster values cache's superseded versions, and
 * with --delete remove them (docs/PERSONAL-FORK.md, Raster values).
 *
 *   npm run cache:prune [-- --delete] [--root <checkout>]
 *
 * The cache keeps an answer under
 * .gev-cache/raster-values/<layer>/<mode>/<version>/<hash>.bin, the version
 * a hash of the expression or the build that made it, so a changed
 * expression starts a new folder and the old one is never read again. A
 * version folder is current when one of its answers, asked again as its
 * header says (layer, mode, box, cells, water plane), would be kept in it
 * today: the service's cacheFile, from the plan alone, nothing asked of
 * Earth Engine. It is superseded when every answer in it would be kept in
 * another version; one with an answer that cannot be planned (a build not
 * on this machine, a header that does not read) and none current is kept
 * and listed as unknown. A dry run by default: --delete removes the
 * superseded folders and nothing else, never a current or unknown one,
 * never anything outside raster-values. --root is the checkout whose
 * .gev-cache and .env to use (this one by default); the .env is read as
 * the server reads it, for the self-hosted builds' folders, and none of
 * it is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The cache's folder under a checkout, as the server keeps it. */
export const CACHE_SUBDIR = path.join('.gev-cache', 'raster-values');
/** A header longer than this is not one of ours. */
const MAX_HEADER_BYTES = 1 << 16;
/** A layer, mode or version folder's name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseArgs(argv) {
  const args = { delete: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--delete') args.delete = true;
    else if (arg === '--root' && argv[i + 1])
      args.root = path.resolve(argv[++i]);
    else return { error: `Unknown argument: ${arg}` };
  }
  return args;
}

/** A kept answer's header (raster-values/1), or null when it does not read. */
export function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return null;
    const length = head.readUInt32LE(0);
    if (length < 2 || length > MAX_HEADER_BYTES) return null;
    const text = Buffer.alloc(length);
    if (fs.readSync(fd, text, 0, length, 4) < length) return null;
    const header = JSON.parse(text.toString('utf8'));
    return header && typeof header === 'object' ? header : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The values request a kept answer's header answers. */
export function requestOf(header) {
  return {
    layer: String(header.layer),
    mode: String(header.mode ?? ''),
    west: String(header.west),
    south: String(header.south),
    east: String(header.east),
    north: String(header.north),
    cells: String(Math.max(header.cols, header.rows)),
    ...(header.planes?.includes('water') ? { water: '1' } : {}),
  };
}

/** The sub-folders of a folder whose names are cache names. */
function folders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every version folder under the cache, each current, superseded or
 * unknown (see the file's comment). `cacheFile(request)` is the service's:
 * {file} or {status, error}.
 * @returns {Array<{layer: string, mode: string, version: string, dir:
 *   string, answers: number, bytes: number, newestMs: number, state:
 *   'current'|'superseded'|'unknown', now: string[]}>} `now`: the versions
 *   a superseded folder's answers would be kept in today.
 */
export function selectVersions(cacheDir, cacheFile) {
  const versions = [];
  for (const layer of folders(cacheDir))
    for (const mode of folders(path.join(cacheDir, layer)))
      for (const version of folders(path.join(cacheDir, layer, mode))) {
        const dir = path.join(cacheDir, layer, mode, version);
        let answers = 0;
        let bytes = 0;
        let newestMs = 0;
        const files = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const stat = fs.statSync(path.join(dir, entry.name));
          bytes += stat.size;
          if (!entry.name.endsWith('.bin')) continue;
          answers++;
          newestMs = Math.max(newestMs, stat.mtimeMs);
          files.push(entry.name);
        }
        let current = false;
        let unknown = files.length === 0;
        const now = new Set();
        for (const name of files.sort()) {
          const header = readHeader(path.join(dir, name));
          const located = header ? cacheFile(requestOf(header)) : null;
          if (!located?.file) {
            unknown = true;
            continue;
          }
          const [atLayer, atMode, atVersion] = path
            .dirname(located.file)
            .split(/[\\/]/)
            .slice(-3);
          if (atLayer === layer && atMode === mode && atVersion === version) {
            current = true;
            break;
          }
          now.add(`${atLayer}/${atMode}/${atVersion}`);
        }
        versions.push({
          layer,
          mode,
          version,
          dir,
          answers,
          bytes,
          newestMs,
          state: current ? 'current' : unknown ? 'unknown' : 'superseded',
          now: current ? [] : [...now].sort(),
        });
      }
  return versions;
}

/**
 * Remove the superseded folders, each checked to be a version folder
 * straight under the cache. @returns {number} the bytes removed
 */
export function pruneVersions(cacheDir, versions) {
  const base = path.resolve(cacheDir);
  let removed = 0;
  for (const entry of versions) {
    if (entry.state !== 'superseded') continue;
    const names = [entry.layer, entry.mode, entry.version];
    const dir = path.resolve(entry.dir);
    if (
      !names.every((name) => NAME.test(name)) ||
      dir !== path.join(base, ...names)
    )
      throw new Error(`Not a version folder of the cache: ${entry.dir}`);
    fs.rmSync(dir, { recursive: true });
    removed += entry.bytes;
  }
  return removed;
}

const megabytes = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(bytes / 1e6, bytes > 0 ? 0.1 : 0).toFixed(1)} MB`;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

/** The listing, per layer and mode. */
export function report(versions) {
  const lines = [];
  const groups = new Map();
  for (const entry of versions) {
    const key = `${entry.layer}/${entry.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const [key, entries] of groups) {
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    lines.push(`${key}: ${entries.length} versions, ${megabytes(bytes)}`);
    for (const entry of entries)
      lines.push(
        `  ${entry.state.padEnd(10)} ${entry.version.padEnd(22)} ` +
          `${String(entry.answers).padStart(6)} answers ` +
          `${megabytes(entry.bytes).padStart(9)}  newest ${day(entry.newestMs)}` +
          (entry.now.length
            ? `  (now ${entry.now.map((at) => at.split('/')[2]).join(', ')})`
            : ''),
      );
  }
  const old = versions.filter((entry) => entry.state === 'superseded');
  lines.push(
    `superseded: ${old.length} versions, ` +
      `${old.reduce((sum, entry) => sum + entry.answers, 0)} answers, ` +
      `${megabytes(old.reduce((sum, entry) => sum + entry.bytes, 0))}`,
  );
  return lines;
}

export async function main({
  argv = process.argv.slice(2),
  log = console.log,
  service = null,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const cacheDir = path.join(args.root, CACHE_SUBDIR);
  let made = null;
  if (!service) {
    const envFile = path.join(args.root, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    const { createRasterValuesService } =
      await import('../server/providers/rasterValues.js');
    service = made = createRasterValuesService({ sourceRoot: args.root });
  }
  try {
    const versions = selectVersions(cacheDir, (request) =>
      service.cacheFile(request),
    );
    log(`${cacheDir}`);
    for (const line of report(versions)) log(line);
    if (!args.delete) {
      log('dry run: nothing deleted (--delete removes the superseded ones)');
      return 0;
    }
    log(`deleted ${megabytes(pruneVersions(cacheDir, versions))}`);
    return 0;
  } finally {
    await made?.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().then((code) => process.exit(code));
