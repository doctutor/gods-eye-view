// Personal fork: the treemap's count/people table: the population Overture
// gives its settlements (city, town, village, hamlet, other localities),
// by continent, country, region, place and kind. Not part of upstream
// God's Eye View.
//
// Each region keeps its PLACES_PER_REGION largest places as tiles; the
// rest are one "Other places" tile per kind. Not a census: a figure is the
// one OpenStreetMap or Overture carries for the place, a town's may count
// its surroundings, and a locality inside a city can be counted twice.
import fs from 'node:fs';
import path from 'node:path';
import { REST_KEY, encodeTable } from '../../server/providers/treemap/table.js';
import { TREEMAP_LABELS } from '../../src/data/treemapCatalog.js';
import { continentOfCountry } from '../../src/data/treemapContinents.js';
import {
  OVERTURE_ATTRIBUTION,
  overtureKindOfCode,
} from '../../src/data/overtureDivisions.js';
import { adminKeys } from './areas.mjs';

export const PEOPLE_TABLE_VERSION = 1;
export const PLACES_PER_REGION = 100;
const RECORD_BYTES = 24;
/** The settlement kinds counted (codes in the localities index). */
const SETTLEMENT_KINDS = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'locality',
]);

/**
 * @param {{localitiesDir: string, units: object[], log?: Function}} options
 *   units: the areas build's units, for the admin labels and outlines
 */
export function buildPeopleTable({ localitiesDir, units, log = () => {} }) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(localitiesDir, 'manifest.json'), 'utf8'),
  );
  const countries = ['', ...(manifest.countries || [])];
  const points = fs.readFileSync(path.join(localitiesDir, 'points.bin'));
  const strings = fs.readFileSync(path.join(localitiesDir, 'strings.bin'));
  const total = points.length / RECORD_BYTES;
  // `${country}\t${region}` → places [{population, index, kind}]
  const byRegion = new Map();
  let skipped = 0;
  let kept = 0;
  for (let i = 0; i < total; i++) {
    const at = i * RECORD_BYTES;
    const population = points.readUInt32LE(at + 8);
    if (!population) continue;
    const kind = overtureKindOfCode(points[at + 20])?.kind;
    if (!SETTLEMENT_KINDS.has(kind)) continue;
    const country = countries[points.readUInt16LE(at + 21)] || '';
    if (!continentOfCountry(country)) {
      skipped++;
      continue;
    }
    const offset = points.readUInt32LE(at + 12);
    const length = points.readUInt16LE(at + 16);
    const parts = strings.toString('utf8', offset, offset + length).split('\0');
    const region = parts[5] || REST_KEY;
    const key = `${country}\t${region}`;
    let list = byRegion.get(key);
    if (!list) byRegion.set(key, (list = []));
    list.push({
      population,
      index: i,
      kind,
      name: parts[0],
      wikidata: parts[4],
    });
    kept++;
  }
  log(
    `  people: ${kept} settlements with a population, ${skipped} with no country`,
  );

  const { labels, geo } = adminKeys(units);
  labels['locality.place'] = { [REST_KEY]: TREEMAP_LABELS.otherPlaces };
  geo['locality.place'] = {};
  labels['locality.kind'] = { ...TREEMAP_LABELS.kinds };
  const rows = [];
  const usedKeys = new Set();
  for (const [key, list] of byRegion) {
    const [country, region] = key.split('\t');
    const continent = continentOfCountry(country);
    if (!labels['admin.region'][region])
      labels['admin.region'][region] = region;
    list.sort((a, b) => b.population - a.population || a.index - b.index);
    const others = new Map();
    list.forEach((place, rank) => {
      if (rank >= PLACES_PER_REGION) {
        const sum = others.get(place.kind) || { value: 0, count: 0 };
        sum.value += place.population;
        sum.count += 1;
        others.set(place.kind, sum);
        return;
      }
      let placeKey =
        /^Q\d+$/.test(place.wikidata) && !usedKeys.has(place.wikidata)
          ? place.wikidata
          : `n${place.index}`;
      usedKeys.add(placeKey);
      const at = place.index * RECORD_BYTES;
      const lon = points.readInt32LE(at) / 1e7;
      const lat = points.readInt32LE(at + 4) / 1e7;
      labels['locality.place'][placeKey] = place.name || placeKey;
      geo['locality.place'][placeKey] =
        `point:${lon.toFixed(5)},${lat.toFixed(5)}`;
      rows.push({
        keys: [continent, country, region, placeKey, place.kind],
        value: place.population,
        count: 1,
      });
    });
    for (const [kind, sum] of others)
      rows.push({
        keys: [continent, country, region, REST_KEY, kind],
        value: sum.value,
        count: sum.count,
      });
  }
  return {
    table: encodeTable({
      variable: 'count/people',
      dims: [
        'admin.continent',
        'admin.country',
        'admin.region',
        'locality.place',
        'locality.kind',
      ],
      rows,
      labels,
      geo,
      exact: false,
      note: 'People in mapped places: the population OpenStreetMap or Overture gives each city, town, village and hamlet, not a census; a town may count its surroundings and a place inside another can be counted twice.',
      attribution: OVERTURE_ATTRIBUTION,
      asOf: manifest.release || undefined,
    }),
    stats: { settlements: kept, rows: rows.length, buildId: manifest.buildId },
  };
}
