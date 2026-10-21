// Personal fork: where the property index lives, and what the build reads.
// Not part of upstream God's Eye View.
import path from 'node:path';

/** The source file's name under GEV_RAW_DIR/realestatedataset/. */
export const PROPERTY_SOURCE_FILE = 'realestatedataset-us-2026-09.parquet';
export const PROPERTY_SOURCE_DIR = 'realestatedataset';
export const NEEDS_BUILD =
  'Run npm run property:build for the Property sales layer';

/** The index's directory: PROPERTY_DIR, else .gev-cache/property. */
export function propertyCacheDir(
  env = process.env,
  sourceRoot = process.cwd(),
) {
  const dir = String(env.PROPERTY_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, '.gev-cache', 'property');
}
