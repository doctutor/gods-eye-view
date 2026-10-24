import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rawDirFor } from '../rawDir.mjs';
import {
  CLIOPATRIA_SOURCE_FILE,
  worldHistoryCacheDir,
} from '../../server/providers/worldHistory/sources.js';
import { buildWorldHistory, worldHistoryStatus } from './build.mjs';

/**
 * The World history layer's index:
 *
 *   node scripts/worldHistory/index.mjs build [--file F] [--dir DIR] [--force]
 *   node scripts/worldHistory/index.mjs status [--json] [--dir DIR]
 *
 * `build` streams Cliopatria's zip (`--file`, else CLIOPATRIA_ZIP, else
 * GEV_RAW_DIR/cliopatria/raw/) with data/cottereau/matches.json and
 * tracks.json into WORLD_HISTORY_DIR (else .gev-cache/world-history), and
 * switches `current.json` over when it is whole.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function parseArgs(argv) {
  const flags = { command: argv[0] || 'status' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') flags.file = argv[++i];
    else if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['build', 'status'].includes(flags.command))
    throw new Error(`unknown command ${flags.command} (build or status)`);
  return flags;
}

/** Cliopatria's zip: --file, CLIOPATRIA_ZIP, or under GEV_RAW_DIR. */
export function sourceFile(flags, env = process.env) {
  const given = flags.file || String(env.CLIOPATRIA_ZIP || '').trim();
  if (given) return path.resolve(ROOT, given);
  const raw = rawDirFor('cliopatria', '', env, { root: ROOT });
  if (!raw)
    throw new Error(
      "Give Cliopatria's zip with --file or CLIOPATRIA_ZIP, or set GEV_RAW_DIR",
    );
  return path.join(raw, CLIOPATRIA_SOURCE_FILE);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = flags.dir
    ? path.resolve(ROOT, flags.dir)
    : worldHistoryCacheDir(process.env, ROOT);
  if (flags.command === 'build') {
    await buildWorldHistory({
      cliopatria: sourceFile(flags),
      matches: path.join(ROOT, 'data', 'cottereau', 'matches.json'),
      tracks: path.join(ROOT, 'data', 'cottereau', 'tracks.json'),
      dir,
      force: Boolean(flags.force),
      log: (line) => console.log(line),
    });
    return;
  }
  const status = worldHistoryStatus(dir);
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`World history index: ${status.dir}`);
  if (!status.id) {
    console.log('  not built (npm run world-history:build)');
    return;
  }
  console.log(
    `  build ${status.id}, ${status.builtAt} (${status.seconds} s), ${(status.bytes / 1e6).toFixed(1)} MB`,
  );
  console.log(
    `  ${status.records} records, ${status.polities} polities, ${status.spans} Cottereau spans`,
  );
  for (const lod of status.lods || [])
    console.log(`  level ${lod.tolerance}°: ${lod.vertices} vertices`);
  if (status.missing.length)
    console.log(`  missing: ${status.missing.join(', ')} (build again)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
