// Personal fork: the treemap's buildings tables, count/buildings,
// m2/building-footprint and m3/building-volume, from the Overture buildings
// build's density cells (`npm run overture:build -- --buildings`): per
// z 10 tile 256 × 256 cells of about 150 m, each with its buildings, their
// footprint, Σ height × footprint and the footprint whose height is known;
// each cell labelled at its centre (labeller.js). Not part of upstream God's
// Eye View.
//
// The build covers the conterminous US and Europe only. A volume is the
// known heights' Σ height × footprint, plus the rest of the cell's
// footprint at the cell's mean known height, or at DEFAULT_HEIGHT_M where
// no height in the cell is known.
import fs from 'node:fs';
import path from 'node:path';
import {
  KIND,
  eachCell,
  openBucket,
} from '../../server/providers/overture/buildingsFile.js';
import {
  OCEAN_KEY,
  REST_KEY,
  encodeTable,
} from '../../server/providers/treemap/table.js';
import { continentOfCountry } from '../../src/data/treemapContinents.js';
import { adminKeys } from './areas.mjs';

export const BUILDINGS_TABLE_VERSION = 1;
/** The height given footprint in a cell where none is known (m). */
export const DEFAULT_HEIGHT_M = 5;
const DENSITY_LOCAL = 16; // z 10 tiles a z 6 bucket holds a side
const CELLS_SIDE = 256;
const WORLD_CELLS = 2 ** 18;
const DIMS = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'admin.district',
];

export function readBuildingsIndex(dir) {
  try {
    const { manifest: name } = JSON.parse(
      fs.readFileSync(path.join(dir, 'current.json'), 'utf8'),
    );
    return {
      dir,
      manifest: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    };
  } catch {
    return null;
  }
}

/**
 * @param {{buildings: {dir: string, manifest: object}, labeller: object,
 *   log?: Function}} options
 */
export function buildBuildingsTables({ buildings, labeller, log = () => {} }) {
  const { dir, manifest } = buildings;
  // "continent\tcountry\tregion\tdistrict" → [count, m², m³]
  const cube = new Map();
  let cells = 0;
  let count = 0;
  const entries = Object.values(manifest.buckets);
  entries.forEach((entry, i) => {
    const [bx, by] = entry.file.split('.')[0].split('-').map(Number);
    const bucket = openBucket(path.join(dir, 'buckets', entry.file));
    try {
      for (const block of bucket.entries.values()) {
        if (block.kind !== KIND.D18) continue;
        const tx = bx * DENSITY_LOCAL + (block.key % DENSITY_LOCAL);
        const ty = by * DENSITY_LOCAL + Math.floor(block.key / DENSITY_LOCAL);
        eachCell(
          bucket.block(block.kind, block.key),
          (cell, buildingsInCell, area, heightArea, knownArea) => {
            cells++;
            const x = (tx * CELLS_SIDE + (cell & 255) + 0.5) / WORLD_CELLS;
            const y = (ty * CELLS_SIDE + (cell >>> 8) + 0.5) / WORLD_CELLS;
            const units = labeller.labelWorld(x, y);
            const continent = units ? continentOfCountry(units.country) : null;
            const key = (
              continent
                ? [
                    continent,
                    units.country,
                    units.region || REST_KEY,
                    units.district || REST_KEY,
                  ]
                : [OCEAN_KEY, OCEAN_KEY, OCEAN_KEY, OCEAN_KEY]
            ).join('\t');
            const unknown = Math.max(0, area - knownArea);
            const mean =
              knownArea > 0 ? heightArea / knownArea : DEFAULT_HEIGHT_M;
            let sums = cube.get(key);
            if (!sums) cube.set(key, (sums = [0, 0, 0]));
            sums[0] += buildingsInCell;
            sums[1] += area;
            sums[2] += heightArea + unknown * mean;
            count += buildingsInCell;
          },
        );
      }
    } finally {
      bucket.close();
    }
    if ((i + 1) % 20 === 0)
      log(
        `  buildings: ${i + 1} of ${entries.length} buckets, ${Math.round(count)} buildings`,
      );
  });

  const { labels, geo } = adminKeys(labeller.units);
  for (const key of cube.keys()) {
    const region = key.split('\t')[2];
    if (!labels['admin.region'][region])
      labels['admin.region'][region] = region;
  }
  const regions = (manifest.regions || []).join(' and ');
  const table = (variable, pick, note) =>
    encodeTable({
      variable,
      dims: DIMS,
      rows: [...cube].map(([key, sums]) => ({
        keys: key.split('\t'),
        value: pick(sums),
        count: Math.round(sums[0]),
      })),
      labels,
      geo,
      exact: false,
      note: `Overture buildings in the ${regions} build only, in cells of about 150 m given to the unit holding each cell's centre${note}.`,
      attribution: manifest.attribution,
      asOf: manifest.release || undefined,
    });
  return {
    count: table('count/buildings', (sums) => Math.round(sums[0]), ''),
    footprint: table('m2/building-footprint', (sums) => sums[1], ''),
    volume: table(
      'm3/building-volume',
      (sums) => sums[2],
      `; a footprint of unknown height counts at its cell's mean known height, or ${DEFAULT_HEIGHT_M} m`,
    ),
    stats: { buildings: Math.round(count), cells, rows: cube.size },
  };
}
