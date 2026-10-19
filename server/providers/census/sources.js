// Personal fork: what the census tract build reads, shared by the build
// script and the tile server. Not part of upstream God's Eye View.
import path from 'node:path';

/** The Census Bureau's 2024 cartographic boundary tracts (1:500,000). */
export const BOUNDARIES = Object.freeze({
  year: 2024,
  file: 'cb_2024_us_tract_500k.zip',
  url: 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_tract_500k.zip',
});

/** ACS 5-year 2020–2024: median household income in 2024 dollars. */
export const ACS = Object.freeze({
  year: 2024,
  dataset: 'acs/acs5',
  variable: 'B19013_001E',
});

export const CENSUS_KEY_ENV = 'CENSUS_API_KEY';
export const NEEDS_KEY =
  'Set CENSUS_API_KEY in .env (a free key from api.census.gov/data/key_signup.html), then run npm run census:build';
export const NEEDS_LST =
  'Run npm run census:build with Earth Engine set up to compute the summer surface temperatures (about an hour of Earth Engine time, once)';
export const NEEDS_BUILD = 'Run npm run census:build to draw the census tracts';

/** The census cache directory (CENSUS_CACHE_DIR, else .gev-cache/census). */
export function censusCacheDir(env = process.env, sourceRoot = process.cwd()) {
  const dir = String(env.CENSUS_CACHE_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, '.gev-cache', 'census');
}
