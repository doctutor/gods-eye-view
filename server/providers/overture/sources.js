// Personal fork: what the Overture divisions build downloads and where it
// keeps it, shared by the build script and the server. Not part of
// upstream God's Eye View.
import path from 'node:path';
import { OVERTURE_RELEASE } from '../../../src/data/overtureDivisions.js';

/** Overture's public bucket, read over HTTPS (no account, no key). */
export const OVERTURE_BUCKET =
  'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com';
/** The divisions theme's point features: one GeoParquet file in this release. */
export const DIVISIONS = Object.freeze({
  release: OVERTURE_RELEASE,
  theme: 'divisions',
  type: 'division',
  prefix: `release/${OVERTURE_RELEASE}/theme=divisions/type=division/`,
});
/** The downloads may not add up to more than this. */
export const DOWNLOAD_CAP_BYTES = 5 * 1024 ** 3;

/**
 * Regions the build can keep (west, south, east, north), by name. The
 * default is the world: the division points are one 582 MB file.
 */
export const REGIONS = Object.freeze({
  world: Object.freeze([-180, -90, 180, 90]),
  'north-america': Object.freeze([-170, 5, -50, 84]),
  europe: Object.freeze([-32, 34, 45, 72]),
});

export const NEEDS_BUILD =
  'Run npm run overture:build for Overture places close in (OpenStreetMap through Overpass meanwhile)';

/** The Overture cache directory (OVERTURE_CACHE_DIR, else .gev-cache/overture). */
export function overtureCacheDir(
  env = process.env,
  sourceRoot = process.cwd(),
) {
  const dir = String(env.OVERTURE_CACHE_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, '.gev-cache', 'overture');
}
