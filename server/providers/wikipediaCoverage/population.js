// Personal fork: the Wikipedia coverage layer's people, for its per-capita
// variants (server/providers/wikipediaCoverage.js). Not part of upstream
// God's Eye View.
import * as h3 from 'h3-js';
import { createPacker, openArrayFile } from './arrayFile.js';
import {
  BASE_CELL_DEG,
  BASE_HEIGHT,
  BASE_WIDTH,
  CAPITA_VARIANTS,
  PEOPLE_FLOOR,
  PER_PEOPLE,
  buildPyramid,
  capitaValue,
  quantile,
  rowAreas,
} from './grid.js';
import { cellKey } from './h3.js';

/**
 * Two files beside grid.bin:
 *
 * - `population.bin` ('WPOP'): people per cell of the grid, at every level
 *   (the 0.05° base from GHSL's 2020 density in Earth Engine, `npm run
 *   wikipedia:build -- --population`; coarser levels sum 2 × 2 blocks, as
 *   the articles do). It does not change with the dump.
 * - `capita.bin` ('WCAP'): what depends on both, made again by every build
 *   that has the population: the per-capita ramp domains of the grid, and
 *   the people of each hexagon in h3.bin, in its tables' order. Its header
 *   names the grid and hexagons it was made for; a per-capita answer from
 *   another build's tables is refused (stale).
 *
 * Per capita: articles per PER_PEOPLE people, or wikitext bytes per person,
 * where the people under a pixel or in a hexagon reach PEOPLE_FLOOR; under
 * it the value is 0 (drawn clear), so empty land does not explode.
 */

export const POPULATION_MAGIC = 'WPOP';
export const POPULATION_VERSION = 1;
export const CAPITA_MAGIC = 'WCAP';
export const CAPITA_VERSION = 1;
export { CAPITA_VARIANTS, PEOPLE_FLOOR, PER_PEOPLE, capitaValue };
/** Hexagons this fine or coarser sum the base cells whose centres they hold. */
export const SUMMED_UP_TO_RES = 5;

/** Write population.bin: the base people (Float32, BASE_WIDTH × BASE_HEIGHT) and its pyramid. */
export function writePopulationFile(file, { header, base }) {
  // Summed in Float64 (a 0.8° cell holds tens of millions), kept as Float32.
  const levels = buildPyramid({ counts: Float64Array.from(base) }).map(
    (level) => ({
      level: level.level,
      width: level.width,
      height: level.height,
      people: Float32Array.from(level.counts),
    }),
  );
  const packer = createPacker();
  let total = 0;
  for (const value of base) total += value;
  const full = {
    ...header,
    version: POPULATION_VERSION,
    cellDeg: BASE_CELL_DEG,
    total: Math.round(total),
    levels: levels.map((level) => ({
      level: level.level,
      width: level.width,
      height: level.height,
      arrays: { people: packer.place(level.people, 'f32') },
    })),
  };
  const { bytes } = packer.write(file, POPULATION_MAGIC, full);
  return { bytes, header: full };
}

/** Open population.bin: each level's people read when first asked for. */
export function openPopulationFile(file) {
  const { header, readArray } = openArrayFile(
    file,
    POPULATION_MAGIC,
    POPULATION_VERSION,
  );
  const held = new Map();
  return {
    header,
    /** @returns {Float32Array} the level's people per cell */
    level(index) {
      if (!held.has(index)) {
        const entry = header.levels.find((level) => level.level === index);
        if (!entry) throw new RangeError(`No population level ${index}`);
        held.set(index, readArray(entry.arrays.people));
      }
      return held.get(index);
    },
  };
}

const domainOf = (values) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return {
    min: quantile(values, 0.05),
    max: quantile(values, 0.995),
    median: quantile(values, 0.5),
    cells: values.length,
  };
};

/** The grid's per-capita domains from its base level and the base people. */
export function gridCapitaDomains(base, people) {
  const capita = [];
  const text = [];
  for (let i = 0; i < base.counts.length; i++) {
    const count = base.counts[i];
    if (!count || !(people[i] >= PEOPLE_FLOOR)) continue;
    capita.push(capitaValue('capita', count, 0, people[i]));
    if (base.bytes && base.bytes[i] > 0)
      text.push(capitaValue('textcapita', count, base.bytes[i], people[i]));
  }
  return { capita: domainOf(capita), textcapita: domainOf(text) };
}

/**
 * The people of every hexagon in the H3 tables, in each table's order.
 * Up to SUMMED_UP_TO_RES (about 250 km² and up, several base cells each) a
 * hexagon sums the base cells whose centres it holds; finer ones (36 km²,
 * 5 km²: a base cell is 31 km² on the equator) take the density of the
 * base cell under their centre times their area.
 * @param {{table: (res: number) => object, resolutions: number[]}} hexes an opened h3.bin
 * @param {Float32Array} people the base people, BASE_WIDTH × BASE_HEIGHT
 * @returns {Map<number, Float32Array>} res → people per table row
 */
export function hexPeople(hexes, people) {
  const sums = new Map(); // res → Map(key → people)
  for (let res = 0; res <= SUMMED_UP_TO_RES; res++) sums.set(res, new Map());
  const finest = sums.get(SUMMED_UP_TO_RES);
  for (let row = 0; row < BASE_HEIGHT; row++) {
    const lat = 90 - (row + 0.5) * BASE_CELL_DEG;
    const start = row * BASE_WIDTH;
    for (let col = 0; col < BASE_WIDTH; col++) {
      const value = people[start + col];
      if (!(value > 0)) continue;
      const lon = -180 + (col + 0.5) * BASE_CELL_DEG;
      const key = cellKey(h3.latLngToCell(lat, lon, SUMMED_UP_TO_RES));
      finest.set(key, (finest.get(key) || 0) + value);
    }
  }
  // Coarser resolutions from the finest summed one, a parent per key.
  for (const [key, value] of finest) {
    let index = keyIndex(key, SUMMED_UP_TO_RES);
    for (let res = SUMMED_UP_TO_RES - 1; res >= 0; res--) {
      index = h3.cellToParent(index, res);
      const map = sums.get(res);
      const parent = cellKey(index);
      map.set(parent, (map.get(parent) || 0) + value);
    }
  }
  const areas = rowAreas(0);
  const out = new Map();
  for (const res of hexes.resolutions) {
    const table = hexes.table(res);
    const n = table.lat.length;
    const values = new Float32Array(n);
    if (res <= SUMMED_UP_TO_RES) {
      const map = sums.get(res);
      for (let i = 0; i < n; i++)
        values[i] =
          map.get(
            (table.indexHi[i] & 0xfffff) * 4294967296 + table.indexLo[i],
          ) || 0;
    } else
      for (let i = 0; i < n; i++) {
        const row = Math.min(
          BASE_HEIGHT - 1,
          Math.max(0, Math.floor((90 - table.lat[i]) / BASE_CELL_DEG)),
        );
        const col = Math.min(
          BASE_WIDTH - 1,
          Math.max(0, Math.floor((table.lon[i] + 180) / BASE_CELL_DEG)),
        );
        values[i] =
          (people[row * BASE_WIDTH + col] / areas[row]) * table.area[i];
      }
    out.set(res, values);
  }
  return out;
}

/** The H3 index of a key at a resolution (h3.js keyToIndex, without the import cycle). */
function keyIndex(key, res) {
  const hi = Math.floor(key / 4294967296);
  const lo = key - hi * 4294967296;
  return h3.splitLongToH3Index(lo, 0x08000000 | (res << 20) | hi);
}

/** A resolution's per-capita domains from its articles, bytes and people. */
export function hexCapitaDomains(table, people) {
  const capita = [];
  const text = [];
  for (let i = 0; i < people.length; i++) {
    if (!(people[i] >= PEOPLE_FLOOR)) continue;
    capita.push(capitaValue('capita', table.articles[i], 0, people[i]));
    if (table.bytes && table.bytes[i] > 0)
      text.push(
        capitaValue('textcapita', table.articles[i], table.bytes[i], people[i]),
      );
  }
  return { capita: domainOf(capita), textcapita: domainOf(text) };
}

/**
 * Write capita.bin for a grid and its hexagons.
 * @param {string} file
 * @param {{header: object, grid: {header: object, level: Function},
 *   hexes: object|null, population: {header: object, level: Function}}} input
 */
export function writeCapitaFile(
  file,
  { header = {}, grid, hexes, population },
) {
  const base = grid.level(0);
  const people = population.level(0);
  const packer = createPacker();
  const peopleByRes = hexes ? hexPeople(hexes, people) : new Map();
  const full = {
    ...header,
    version: CAPITA_VERSION,
    floor: PEOPLE_FLOOR,
    perPeople: PER_PEOPLE,
    gridBuiltAt: grid.header.builtAt || null,
    h3BuiltAt: hexes?.header?.builtAt || null,
    population: {
      builtAt: population.header.builtAt || null,
      source: population.header.source || null,
      total: population.header.total || 0,
    },
    domains: gridCapitaDomains(base, people),
    resolutions: [...peopleByRes].map(([res, values]) => ({
      res,
      cells: values.length,
      domains: hexCapitaDomains(hexes.table(res), values),
      arrays: { people: packer.place(values, 'f32') },
    })),
  };
  const { bytes } = packer.write(file, CAPITA_MAGIC, full);
  return { bytes, header: full };
}

/** Open capita.bin: its header, and a resolution's hexagon people when first asked. */
export function openCapitaFile(file) {
  const { header, readArray } = openArrayFile(
    file,
    CAPITA_MAGIC,
    CAPITA_VERSION,
  );
  const held = new Map();
  return {
    header,
    /** @returns {Float32Array|null} */
    people(res) {
      if (!held.has(res)) {
        const entry = header.resolutions.find((item) => item.res === res);
        held.set(res, entry ? readArray(entry.arrays.people) : null);
      }
      return held.get(res);
    },
  };
}
