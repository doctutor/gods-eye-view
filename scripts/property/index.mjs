import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../project-root.mjs';
import { rawRoot } from '../rawDir.mjs';
import {
  PROPERTY_SOURCE_DIR,
  PROPERTY_SOURCE_FILE,
  propertyCacheDir,
} from '../../server/providers/property/sources.js';
import { buildProperty, propertyStatus } from './build.mjs';

/**
 * The Property sales layer's index:
 *
 *   node scripts/property/index.mjs build [--file F] [--dir DIR] [--tmp DIR]
 *     [--groups 0-1,7] [--workers N] [--merges N] [--force] [--keep-spill]
 *   node scripts/property/index.mjs status [--json] [--dir DIR]
 *
 * `build` reads realestatedataset.com's Parquet file (`--file`, else
 * PROPERTY_PARQUET, else GEV_RAW_DIR/realestatedataset/) and writes the
 * index into PROPERTY_DIR (else .gev-cache/property). Its temporary
 * spill (about half the source's size) goes under `--tmp`, else
 * GEV_RAW_DIR/property/tmp, else the index's tmp/. `--groups` builds
 * from some row groups only (a sample, to try the writer).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = projectRoot(import.meta.url);

export function parseArgs(argv) {
  const flags = { command: argv[0] || 'status' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') flags.file = argv[++i];
    else if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--groups') flags.groups = argv[++i];
    else if (arg === '--workers') flags.workers = Number(argv[++i]);
    else if (arg === '--merges') flags.merges = Number(argv[++i]);
    else if (arg === '--force') flags.force = true;
    else if (arg === '--tmp') flags.tmp = argv[++i];
    else if (arg === '--keep-spill') flags.keepSpill = true;
    else if (arg === '--json') flags.json = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return flags;
}

/** The source file: --file, PROPERTY_PARQUET, or under GEV_RAW_DIR. */
export function sourceFile(flags, env = process.env) {
  const given = flags.file || String(env.PROPERTY_PARQUET || '').trim();
  if (given) return path.resolve(ROOT, given);
  const raw = rawRoot(env, { root: ROOT });
  if (!raw)
    throw new Error(
      'Give the realestatedataset.com file with --file or PROPERTY_PARQUET, or set GEV_RAW_DIR',
    );
  return path.join(raw, PROPERTY_SOURCE_DIR, PROPERTY_SOURCE_FILE);
}

/** Where the spill goes: --tmp, else GEV_RAW_DIR/property/tmp, else ''. */
export function spillDir(flags, env = process.env) {
  if (flags.tmp) return path.resolve(ROOT, flags.tmp);
  const raw = rawRoot(env, { root: ROOT });
  return raw ? path.join(raw, 'property', 'tmp') : '';
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = flags.dir
    ? path.resolve(ROOT, flags.dir)
    : propertyCacheDir(process.env, ROOT);
  if (flags.command === 'build') {
    await buildProperty({
      file: sourceFile(flags),
      dir,
      groups: flags.groups || '',
      ...(flags.workers ? { workers: flags.workers } : {}),
      ...(flags.merges ? { merges: flags.merges } : {}),
      force: Boolean(flags.force),
      tmpDir: spillDir(flags),
      keepSpill: Boolean(flags.keepSpill),
    });
    return;
  }
  if (flags.command === 'status') {
    const status = propertyStatus(dir);
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(
      status.built
        ? `Property sales ${status.version} of ${status.builtAt}: ${status.buildings.toLocaleString('en')} buildings of ${status.records.toLocaleString('en')} records, ${(status.bytes / 1e9).toFixed(2)} GB in ${status.buckets} buckets`
        : 'Property sales: not built. Run npm run property:build.',
    );
    return;
  }
  throw new Error(`unknown command ${flags.command} (build, status)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[property] ${error?.message || error}`);
    process.exitCode = 1;
  });
