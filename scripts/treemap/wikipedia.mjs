// Personal fork: the treemap's Wikipedia tables, count/wikipedia-articles
// and byte/wikipedia-text, from the Wikipedia points index (`npm run
// wikipedia:build -- --points`): every geotagged article of the eleven
// wikis at its primary coordinate, labelled with its country and region
// (labeller.js), by language and kind of article. Not part of upstream
// God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { openBucket } from '../../server/providers/overture/buildingsFile.js';
import {
  FLAG_SECONDARY,
  POINT_KIND,
  eachBlockPoint,
  recordBytesOf,
} from '../../server/providers/wikipediaCoverage/pointsFile.js';
import {
  OCEAN_KEY,
  REST_KEY,
  encodeTable,
} from '../../server/providers/treemap/table.js';
import { TREEMAP_LABELS } from '../../src/data/treemapCatalog.js';
import { continentOfCountry } from '../../src/data/treemapContinents.js';
import {
  WIKIPEDIA_POINTS_FULL_ZOOM,
  pointClassOfCode,
  pointWikiOfCode,
} from '../../src/data/wikipediaPoints.js';
import { adminKeys } from './areas.mjs';

export const WIKIPEDIA_TABLE_VERSION = 1;
const WORLD = 2 ** 28;
const DIMS = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'wikipedia.language',
  'wikipedia.class',
];
const ATTRIBUTION =
  'Wikipedia (CC BY-SA 4.0) via the GeoData and Wikidata dumps';

/** The points index current.json names: {dir, manifest}, or null. */
export function readWikipediaPoints(dir) {
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
 * @param {{points: {dir: string, manifest: object}, labeller: object,
 *   log?: Function}} options
 * @returns {{articles: object, text: object, stats: object}}
 */
export function buildWikipediaTables({ points, labeller, log = () => {} }) {
  const { dir, manifest } = points;
  const recordBytes = recordBytesOf(manifest.format);
  const kind = POINT_KIND + WIKIPEDIA_POINTS_FULL_ZOOM;
  // "continent\tcountry\tregion\tlang\tclass" → [articles, bytes]
  const cube = new Map();
  let articles = 0;
  let atSea = 0;
  const buckets = Object.values(manifest.buckets);
  buckets.forEach((entry, i) => {
    const bucket = openBucket(path.join(dir, 'buckets', entry.file));
    try {
      for (const block of bucket.entries.values()) {
        if (block.kind !== kind) continue;
        eachBlockPoint(
          bucket.block(block.kind, block.key),
          (point) => {
            if (point.flags & FLAG_SECONDARY) return;
            const units = labeller.labelWorld(point.x / WORLD, point.y / WORLD);
            const continent = units ? continentOfCountry(units.country) : null;
            const admin = continent
              ? [continent, units.country, units.region || REST_KEY]
              : [OCEAN_KEY, OCEAN_KEY, OCEAN_KEY];
            if (!continent) atSea++;
            const key = [
              ...admin,
              pointWikiOfCode(point.wiki).lang,
              pointClassOfCode(point.cls).key,
            ].join('\t');
            let cell = cube.get(key);
            if (!cell) cube.set(key, (cell = [0, 0]));
            cell[0] += 1;
            cell[1] += point.bytes;
            articles++;
          },
          recordBytes,
        );
      }
    } finally {
      bucket.close();
    }
    if ((i + 1) % 200 === 0)
      log(
        `  wikipedia: ${i + 1} of ${buckets.length} buckets, ${articles} articles`,
      );
  });

  const { labels, geo } = adminKeys(labeller.units);
  labels['wikipedia.language'] = { ...TREEMAP_LABELS.languages };
  labels['wikipedia.class'] = { ...TREEMAP_LABELS.articleClasses };
  for (const key of cube.keys()) {
    const region = key.split('\t')[2];
    if (!labels['admin.region'][region])
      labels['admin.region'][region] = region;
  }
  const table = (variable, pick) =>
    encodeTable({
      variable,
      dims: DIMS,
      rows: [...cube].map(([key, cell]) => ({
        keys: key.split('\t'),
        value: pick(cell),
        count: cell[0],
      })),
      labels,
      geo,
      exact: true,
      note: 'Geotagged articles of eleven Wikipedias at their primary coordinate, in the country and region that holds it.',
      attribution: ATTRIBUTION,
      asOf: manifest.dump?.date || undefined,
    });
  return {
    articles: table('count/wikipedia-articles', (cell) => cell[0]),
    text: table('byte/wikipedia-text', (cell) => cell[1]),
    stats: { articles, atSea, rows: cube.size, buckets: buckets.length },
  };
}
