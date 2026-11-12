// Personal fork: where the treemap navigator's tables live, and the
// stores they are built from. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { overtureCacheDir } from '../overture/sources.js';

export const NEEDS_TREEMAP_BUILD =
  'Run npm run treemap:build to build the treemap tables';
export const TREEMAP_MANIFEST = 'manifest.json';
export const TREEMAP_MANIFEST_FORMAT = 1;

/** The tables' directory (TREEMAP_DIR, else .gev-cache/treemap). */
export function treemapDir(env = process.env, sourceRoot = process.cwd()) {
  const dir = String(env.TREEMAP_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, '.gev-cache', 'treemap');
}

/** The Overture division areas build (scripts/overture/areas.mjs). */
export const overtureAreasDir = (env, sourceRoot) =>
  path.join(overtureCacheDir(env, sourceRoot), 'build', 'areas');

/** The Overture localities build named by build/current.json, or null. */
export function overtureLocalitiesDir(env, sourceRoot) {
  const root = path.join(overtureCacheDir(env, sourceRoot), 'build');
  try {
    const { buildId } = JSON.parse(
      fs.readFileSync(path.join(root, 'current.json'), 'utf8'),
    );
    if (!/^[0-9a-f]{12}$/.test(String(buildId))) return null;
    return path.join(root, buildId);
  } catch {
    return null;
  }
}

/** A table's file name for a variable id: m2/surface-area → m2-surface-area. */
export const tableStem = (variable) => variable.replace(/\//g, '-');
