// Personal fork: the raster values of the layers the fork builds itself
// (Overture buildings, census tracts, Wikipedia coverage, property sales), for
// server/providers/rasterValues.js. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { createBuildingsTiles } from '../overture/buildingsTiles.js';
import { overtureCacheDir } from '../overture/sources.js';
import { censusTileVersion, createCensusService } from '../census.js';
import { censusCacheDir } from '../census/sources.js';
import {
  coverageGridFile,
  createWikipediaCoverageService,
} from '../wikipediaCoverage.js';
import { readGridHeader } from '../wikipediaCoverage/grid.js';
import { createPropertyIndex } from '../property/index.js';
import { openHexFile } from '../property/hexFile.js';
import { propertyCacheDir } from '../property/sources.js';

/** Where each build lives (no secrets: what a worker thread is handed). */
export function selfHostedDirs(env = process.env, sourceRoot = process.cwd()) {
  return {
    overtureDir: overtureCacheDir(env, sourceRoot),
    censusDir: censusCacheDir(env, sourceRoot),
    gridFile: coverageGridFile(env, sourceRoot),
    propertyDir: propertyCacheDir(env, sourceRoot),
  };
}

/**
 * The numbers: what the 'raster-values' tile pool's workers run
 * (../common/tileWorker.js), or this thread without a pool. Each source's
 * service is made when first asked for and kept.
 * @param {{overtureDir: string, censusDir: string, gridFile: string,
 *   propertyDir?: string}} dirs
 */
export function createSelfHostedValues({
  overtureDir,
  censusDir,
  gridFile,
  propertyDir,
}) {
  let buildings = null;
  let census = null;
  let wikipedia = null;
  let property = null;
  return {
    /**
     * @param {'overture-buildings'|'census'|'wikipedia'|'property'} source
     * @returns {{status: number, body?: Buffer, version?: string,
     *   aggregation?: string, error?: string}}
     */
    values(source, mode, box, cols, rows) {
      if (source === 'overture-buildings') {
        buildings ||= createBuildingsTiles({ dir: overtureDir });
        return buildings.values(mode, box, cols, rows);
      }
      if (source === 'census') {
        census ||= createCensusService({ dir: censusDir, env: {} });
        return census.values(mode, box, cols, rows);
      }
      if (source === 'wikipedia') {
        wikipedia ||= createWikipediaCoverageService({ gridFile, env: {} });
        return wikipedia.values(mode, box, cols, rows);
      }
      if (source === 'property' && propertyDir) {
        property ||= createPropertyIndex({ dir: propertyDir });
        return property.values(mode, box, cols, rows);
      }
      return { status: 404, error: `No source ${source}` };
    },
    close() {
      buildings?.close();
      census?.close();
      property?.close();
    },
  };
}

/**
 * A small file read again when it changes (stat'ed at most every 5 s), for
 * the builds' versions on the server's own thread.
 */
function watched(file, read, now) {
  let held = null;
  let checkedAt = -Infinity;
  return () => {
    if (now() - checkedAt < 5000 && held) return held.value;
    checkedAt = now();
    try {
      const stat = fs.statSync(file());
      if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
        return held.value;
      held = { value: read(file()), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      held = null;
    }
    return held?.value ?? null;
  };
}

/**
 * What each build is, read from its small files only: {version, …} or null
 * when it is not built.
 */
export function createSelfHostedStatus(
  { overtureDir, censusDir, gridFile, propertyDir = '' },
  { now = () => Date.now() } = {},
) {
  const buildingsRoot = path.join(overtureDir, 'buildings');
  const overturePointer = watched(
    () => path.join(buildingsRoot, 'current.json'),
    (file) => JSON.parse(fs.readFileSync(file, 'utf8')).manifest,
    now,
  );
  let manifest = null;
  const census = watched(
    () => path.join(censusDir, 'build', 'manifest.json'),
    (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    now,
  );
  const grid = watched(
    () => gridFile,
    (file) => readGridHeader(file).header,
    now,
  );
  // The property index: its manifest's version and the hexagons' domains.
  const property = watched(
    () => path.join(propertyDir, 'current.json'),
    (file) => {
      const { manifest: name } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name))) return null;
      const value = JSON.parse(
        fs.readFileSync(path.join(propertyDir, name), 'utf8'),
      );
      const { header } = openHexFile(path.join(propertyDir, value.hexes.file));
      return {
        version: String(value.version),
        domains: Object.fromEntries(
          header.resolutions.map((entry) => [entry.res, entry.domains]),
        ),
      };
    },
    now,
  );
  return {
    /** Overture buildings: {version, regionBoxes} or null. */
    overture() {
      const name = overturePointer();
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name))) return null;
      if (manifest?.name !== name)
        try {
          const value = JSON.parse(
            fs.readFileSync(path.join(buildingsRoot, name), 'utf8'),
          );
          manifest = {
            name,
            version: String(value.version),
            regionBoxes: value.regionBoxes || {},
          };
        } catch {
          return null;
        }
      return manifest;
    },
    /** A census mode: {version} or null (not built, or that mode's values not fetched). */
    census(mode) {
      const value = census();
      if (!value?.buildId || !value.values?.[mode]) return null;
      return { version: censusTileVersion(mode, value.buildId) };
    },
    /** A Wikipedia coverage variant: {version, domain} or null. */
    wikipedia(variant) {
      const header = grid();
      if (!header) return null;
      if (variant === 'text' && !header.text?.included) return null;
      return {
        version: String(header.builtAt || '').replace(/[^0-9A-Za-z]/g, ''),
        domain: header.domains?.[variant] || null,
      };
    },
    /** The property index: {version, domains by resolution} or null. */
    property: () => (propertyDir ? property() : null),
  };
}
