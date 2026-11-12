// Personal fork: the treemap's count/places table: Overture's places by
// category, country, region and district, from the places index's H3
// resolution 7 counts (`npm run overture:build -- --places`), each cell
// labelled at its centre (labeller.js). Not part of upstream God's Eye View.
//
// A resolution 7 cell is about 5 km²: a cell astride a border goes whole
// to the unit holding its centre. Every place the index keeps counts
// (confidence 0.5 and up).
import fs from 'node:fs';
import path from 'node:path';
import { openBucket } from '../../server/providers/overture/buildingsFile.js';
import {
  PLACE_KIND,
  eachCountCell,
  slotOf,
} from '../../server/providers/overture/placesFile.js';
import {
  OCEAN_KEY,
  REST_KEY,
  encodeTable,
} from '../../server/providers/treemap/table.js';
import { TREEMAP_LABELS } from '../../src/data/treemapCatalog.js';
import { continentOfCountry } from '../../src/data/treemapContinents.js';
import {
  OTHER_CATEGORY,
  PLACE_CATEGORIES,
} from '../../src/data/overturePlaces.js';
import { OVERTURE_ATTRIBUTION } from '../../src/data/overtureDivisions.js';
import { adminKeys } from './areas.mjs';

export const PLACES_TABLE_VERSION = 1;
export const PLACES_RESOLUTION = 7;
const DIMS = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'admin.district',
  'place.category',
];
const CATEGORY_KEYS = new Map([
  ...PLACE_CATEGORIES.map((category) => [category.code, category.key]),
  [OTHER_CATEGORY, 'other'],
]);

/** The places index current.json names: {dir, manifest}, or null. */
export function readPlacesIndex(dir) {
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
 * @param {{places: {dir: string, manifest: object}, labeller: object,
 *   log?: Function}} options
 */
export function buildPlacesTable({ places, labeller, log = () => {} }) {
  const { dir, manifest } = places;
  const cube = new Map();
  let cells = 0;
  let total = 0;
  const buckets = Object.values(manifest.buckets);
  buckets.forEach((entry, i) => {
    const bucket = openBucket(path.join(dir, 'buckets', entry.file));
    try {
      // One block of the bucket's cells per resolution: kind H, key res.
      const raw = bucket.block(PLACE_KIND.H, PLACES_RESOLUTION);
      if (raw)
        eachCountCell(raw, (cell, lat, lon, counts) => {
          cells++;
          const units = labeller.label(lon, lat);
          const continent = units ? continentOfCountry(units.country) : null;
          const admin = continent
            ? [
                continent,
                units.country,
                units.region || REST_KEY,
                units.district || REST_KEY,
              ]
            : [OCEAN_KEY, OCEAN_KEY, OCEAN_KEY, OCEAN_KEY];
          for (const [code, key] of CATEGORY_KEYS) {
            const n = counts.get(slotOf(code, 0)) || 0;
            if (!n) continue;
            const id = [...admin, key].join('\t');
            cube.set(id, (cube.get(id) || 0) + n);
            total += n;
          }
        });
    } finally {
      bucket.close();
    }
    if ((i + 1) % 200 === 0)
      log(`  places: ${i + 1} of ${buckets.length} buckets, ${total} places`);
  });

  const { labels, geo } = adminKeys(labeller.units);
  labels['place.category'] = { ...TREEMAP_LABELS.placeCategories };
  for (const key of cube.keys()) {
    const region = key.split('\t')[2];
    if (!labels['admin.region'][region])
      labels['admin.region'][region] = region;
  }
  return {
    table: encodeTable({
      variable: 'count/places',
      dims: DIMS,
      rows: [...cube].map(([key, value]) => ({
        keys: key.split('\t'),
        value,
        count: value,
      })),
      labels,
      geo,
      exact: false,
      note: 'Overture places (confidence 0.5 and up) counted in H3 cells of about 5 km², each cell given whole to the unit holding its centre.',
      attribution: OVERTURE_ATTRIBUTION,
      asOf: manifest.release || undefined,
    }),
    stats: { places: total, cells, rows: cube.size },
  };
}
