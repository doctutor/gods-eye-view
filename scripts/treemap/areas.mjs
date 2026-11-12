// Personal fork: the treemap's first table, m2/surface-area: the geodesic
// land area of every Overture division area (country, dependency, region,
// county) from the areas build's finest band, put up the stored ISO links
// (a county's region, a region's country, a country's continent), with the
// planet's remainder as one "oceans and unclaimed" tile; and the outline
// index /api/treemap/geo draws from. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { decodeAreaRecord } from '../../server/providers/overtureAreas/format.js';
import {
  EARTH_AREA_M2,
  mercatorPolygonsArea,
} from '../../server/providers/treemap/geodesy.js';
import {
  OCEAN_KEY,
  REST_KEY,
  encodeTable,
} from '../../server/providers/treemap/table.js';
import { TREEMAP_LABELS } from '../../src/data/treemapCatalog.js';
import {
  TREEMAP_CONTINENTS,
  continentOfCountry,
} from '../../src/data/treemapContinents.js';
import { OVERTURE_BOUNDARIES_ATTRIBUTION } from '../../src/data/overtureBoundaries.js';

/** Bumped when the table's rules change: every table rebuilds once. */
export const AREAS_TABLE_VERSION = 2;
/** A remainder smaller than this share of its parent is a seam, not a tile. */
const SLIVER = 0.001;
/** An outline is drawn from the coarsest band that gives it this many steps across. */
const OUTLINE_STEPS = 256;
const ADMIN_DIMS = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'admin.district',
];

export function readAreasBuild(dir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
  );
  const units = JSON.parse(
    fs.readFileSync(path.join(dir, manifest.files.units), 'utf8'),
  );
  return { manifest, units };
}

const nameOf = (unit) => unit.nameEn || unit.name || unit.id;
const isLand = (unit) => unit.kind === 'land' && unit.country;
const isCountry = (unit) =>
  unit.subtype === 'country' || unit.subtype === 'dependency';

/**
 * The labels and outlines of the admin keys, shared by every table cut by
 * admin.*: continents (a box), countries (ISO code, the largest land unit),
 * regions (ISO 3166-2 code where the area has one, else its id), districts
 * (the unit's id); and each remainder's label.
 * @param {object[]} units the areas build's units
 * @param {(unit: object) => number} [size] a unit's size, to pick the largest
 */
export function adminKeys(units, size = (unit) => boxSize(unit)) {
  const labels = Object.fromEntries(ADMIN_DIMS.map((dim) => [dim, {}]));
  const geo = Object.fromEntries(ADMIN_DIMS.map((dim) => [dim, {}]));
  for (const continent of TREEMAP_CONTINENTS) {
    labels['admin.continent'][continent.id] = continent.label;
    geo['admin.continent'][continent.id] = `box:${continent.box.join(',')}`;
  }
  const best = { 'admin.country': new Map(), 'admin.region': new Map() };
  for (const unit of units) {
    if (!isLand(unit)) continue;
    if (unit.subtype === 'county') {
      labels['admin.district'][unit.id] = nameOf(unit);
      geo['admin.district'][unit.id] = `area:${unit.id}`;
      continue;
    }
    const dim = isCountry(unit) ? 'admin.country' : 'admin.region';
    const key = dim === 'admin.country' ? unit.country : regionKey(unit);
    const held = best[dim].get(key);
    if (!held || size(unit) > size(held)) best[dim].set(key, unit);
  }
  for (const [dim, map] of Object.entries(best))
    for (const [key, unit] of map) {
      labels[dim][key] = nameOf(unit);
      geo[dim][key] = `area:${unit.id}`;
    }
  labels['admin.region'][REST_KEY] = TREEMAP_LABELS.noRegion;
  labels['admin.district'][REST_KEY] = TREEMAP_LABELS.noDistrict;
  for (const dim of ADMIN_DIMS) labels[dim][OCEAN_KEY] = TREEMAP_LABELS.ocean;
  return { labels, geo };
}

export const regionKey = (unit) => unit.region || unit.id;
const boxSize = (unit) =>
  (unit.box[2] - unit.box[0]) * (unit.box[3] - unit.box[1]);

/**
 * Build the surface-area table and the outline index.
 * @param {{areasDir: string, log?: (line: string) => void}} options
 */
export function buildAreasTable({ areasDir, log = () => {} }) {
  const { manifest, units } = readAreasBuild(areasDir);
  const finest = manifest.levels.length - 1;
  const scale = 2 ** manifest.levels[finest].quantBits;
  const fd = fs.openSync(path.join(areasDir, manifest.files.areas), 'r');
  const area = new Map();
  let points = 0;
  try {
    let done = 0;
    for (const unit of units) {
      if (!isLand(unit)) continue;
      const bytes = Buffer.alloc(unit.lengths[finest]);
      fs.readSync(fd, bytes, 0, bytes.length, unit.offsets[finest]);
      const polygons = decodeAreaRecord(bytes);
      for (const rings of polygons)
        for (const ring of rings) points += ring.length / 2;
      area.set(unit.id, mercatorPolygonsArea(polygons, scale));
      if (++done % 5000 === 0) log(`  areas: ${done} units`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const { labels, geo } = adminKeys(units, (unit) => area.get(unit.id) || 0);
  // Country → {own, regions: Map(regionKey → {own, districts: Map})}.
  const countries = new Map();
  const countryOf = (code) => {
    let entry = countries.get(code);
    if (!entry)
      countries.set(
        code,
        (entry = { own: 0, regions: new Map(), loose: new Map() }),
      );
    return entry;
  };
  const regionOf = (country, key) => {
    let entry = country.regions.get(key);
    if (!entry)
      country.regions.set(key, (entry = { own: 0, districts: new Map() }));
    return entry;
  };
  const unknown = new Set();
  for (const unit of units) {
    if (!isLand(unit)) continue;
    if (!continentOfCountry(unit.country)) {
      unknown.add(unit.country);
      continue;
    }
    const value = area.get(unit.id) || 0;
    const country = countryOf(unit.country);
    if (isCountry(unit)) country.own += value;
    else if (unit.subtype === 'region')
      regionOf(country, regionKey(unit)).own += value;
    else if (unit.region)
      regionOf(country, unit.region).districts.set(unit.id, value);
    else country.loose.set(unit.id, value);
  }
  if (unknown.size)
    log(`  areas: no continent for ${[...unknown].join(', ')} (left out)`);

  const rows = [];
  let land = 0;
  const remainder = (own, covered) =>
    own - covered > SLIVER * own ? own - covered : 0;
  for (const [code, country] of countries) {
    const continent = continentOfCountry(code);
    const row = (region, district, value, count) => {
      if (value > 0)
        rows.push({ keys: [continent, code, region, district], value, count });
    };
    let covered = 0;
    for (const [key, region] of country.regions) {
      let inRegion = 0;
      for (const [id, value] of region.districts) {
        row(key, id, value, 1);
        inRegion += value;
      }
      const own = Math.max(region.own, inRegion);
      if (region.districts.size)
        row(key, REST_KEY, remainder(own, inRegion), 0);
      else row(key, REST_KEY, own, 1);
      covered += own;
    }
    for (const [id, value] of country.loose) {
      row(REST_KEY, id, value, 1);
      covered += value;
    }
    const own = Math.max(country.own, covered);
    row(
      REST_KEY,
      REST_KEY,
      covered ? remainder(own, covered) : own,
      covered ? 0 : 1,
    );
    land += own;
  }
  rows.push({
    keys: [OCEAN_KEY, OCEAN_KEY, OCEAN_KEY, OCEAN_KEY],
    value: Math.max(0, EARTH_AREA_M2 - land),
    count: 0,
  });

  // The outlines: per land unit, the coarsest band drawing it in
  // OUTLINE_STEPS steps or more.
  const outlineUnits = {};
  for (const unit of units) {
    if (!isLand(unit)) continue;
    const span = Math.max(unit.box[2] - unit.box[0], unit.box[3] - unit.box[1]);
    let level = manifest.levels.findIndex(
      (band) => span * 2 ** band.quantBits >= OUTLINE_STEPS,
    );
    if (level < 0) level = finest;
    outlineUnits[unit.id] = [level, unit.offsets[level], unit.lengths[level]];
  }

  return {
    table: encodeTable({
      variable: 'm2/surface-area',
      dims: ADMIN_DIMS,
      rows,
      labels,
      geo,
      exact: true,
      note: 'Land area of the Overture division areas on the WGS84 ellipsoid; a "No region" or "No district" tile is the part of its parent no smaller division covers. Continents are the UN M49 regions with the Americas split at Panama: Russia is wholly in Europe, Turkey and Cyprus in Asia.',
      attribution: OVERTURE_BOUNDARIES_ATTRIBUTION,
      asOf: manifest.release || undefined,
    }),
    outlines: {
      format: 1,
      areasBuildId: manifest.buildId,
      file: manifest.files.areas,
      quantBits: manifest.levels.map((band) => band.quantBits),
      units: outlineUnits,
    },
    stats: { units: area.size, points, rows: rows.length, land },
  };
}
