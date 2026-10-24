// Personal fork: where the World history layer's index lives, and what its
// build reads. Not part of upstream God's Eye View.
import path from 'node:path';

/** Cliopatria's zip under GEV_RAW_DIR (or E:\gev-data) /cliopatria/raw/. */
export const CLIOPATRIA_SOURCE_DIR = path.join('cliopatria', 'raw');
export const CLIOPATRIA_SOURCE_FILE = 'cliopatria-v0.2.1.geojson.zip';
export const NEEDS_BUILD =
  'Run npm run world-history:build for the World history layer';

/** The index's directory: WORLD_HISTORY_DIR, else .gev-cache/world-history. */
export function worldHistoryCacheDir(
  env = process.env,
  sourceRoot = process.cwd(),
) {
  const dir = String(env.WORLD_HISTORY_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, '.gev-cache', 'world-history');
}
