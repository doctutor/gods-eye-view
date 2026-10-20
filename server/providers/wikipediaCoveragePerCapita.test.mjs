// Personal fork: the Wikipedia coverage layer's per-capita variants
// (server/providers/wikipediaCoverage/population.js, scripts/wikipedia/
// population.mjs): the floor, the people per cell and per hexagon, the
// tiles and hexagons served, a stale join refused, and the Earth Engine
// step resumed from its parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as h3 from 'h3-js';

import {
  BASE_HEIGHT,
  BASE_WIDTH,
  buildPyramid,
  cellOf,
  createAccumulator,
  rowAreaKm2,
  variantDomains,
  writeGrid,
} from './wikipediaCoverage/grid.js';
import {
  buildResolutions,
  createH3Accumulator,
  writeH3File,
} from './wikipediaCoverage/h3.js';
import {
  PEOPLE_FLOOR,
  capitaValue,
  openPopulationFile,
  writeCapitaFile,
  writePopulationFile,
} from './wikipediaCoverage/population.js';
import { openGrid } from './wikipediaCoverage/grid.js';
import { openH3File } from './wikipediaCoverage/h3.js';
import {
  NEEDS_POPULATION,
  createWikipediaCoverageService,
} from './wikipediaCoverage.js';
import {
  buildPopulation,
  populationTiles,
} from '../../scripts/wikipedia/population.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wpc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Ten articles in the 0.05° cell at (0.025, 0.025), two in its neighbour
// east, none where a million people live far away.
const A = [0.025, 0.025];
const B = [0.025, 0.075];
const C = [40.025, 40.025];

function writeFixture(dir, { builtAt = '2026-10-17T12:00:00.000Z' } = {}) {
  const grid = createAccumulator({ text: true });
  const hexes = createH3Accumulator({ text: true });
  const add = ([lat, lon], n, size) => {
    for (let i = 0; i < n; i++) {
      grid.addBytes(grid.add(lat, lon), size);
      hexes.addBytes(hexes.add(lat, lon), size);
    }
  };
  add(A, 10, 5_000);
  add(B, 2, 1_000);
  const levels = buildPyramid({ counts: grid.counts, bytes: grid.bytes });
  writeGrid(path.join(dir, 'grid.bin'), {
    header: {
      builtAt,
      text: { included: true },
      domains: variantDomains(levels[0]),
    },
    levels,
  });
  writeH3File(path.join(dir, 'h3.bin'), {
    header: { builtAt, text: { included: true } },
    tables: buildResolutions(hexes),
  });
  const people = new Float32Array(BASE_WIDTH * BASE_HEIGHT);
  const put = ([lat, lon], n) => {
    const { row, col } = cellOf(lat, lon, 0);
    people[row * BASE_WIDTH + col] = n;
  };
  put(A, 50_000);
  put(B, 50); // under the floor
  put(C, 1_000_000);
  writePopulationFile(path.join(dir, 'population.bin'), {
    header: { builtAt: '2026-10-20T00:00:00.000Z', source: { name: 'test' } },
    base: people,
  });
  writeCapitaFile(path.join(dir, 'capita.bin'), {
    grid: openGrid(path.join(dir, 'grid.bin')),
    hexes: openH3File(path.join(dir, 'h3.bin')),
    population: openPopulationFile(path.join(dir, 'population.bin')),
  });
}

/** The value of the tile pixel holding a point, from the route's bytes. */
function pixel(body, z, lat, lon) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const values = new Float32Array(
    body.buffer.slice(body.byteOffset + 16, body.byteOffset + body.length),
  );
  const px = Math.floor((fx - Math.floor(fx)) * 256);
  const py = Math.floor((fy - Math.floor(fy)) * 256);
  return {
    tile: [Math.floor(fx), Math.floor(fy)],
    value: values[py * 256 + px],
  };
}

test('a per-capita value: articles per 100,000 people or bytes per person, nothing under the floor', () => {
  assert.equal(PEOPLE_FLOOR, 100);
  assert.equal(capitaValue('capita', 10, 0, 50_000), 20);
  assert.equal(capitaValue('textcapita', 10, 5_000, 50_000), 0.1);
  assert.equal(capitaValue('capita', 2, 0, 99), 0);
  assert.equal(capitaValue('capita', 2, 0, 0), 0);
});

test('tiles and hexagons per capita; the floor leaves sparse cells clear; a stale join is refused', async (t) => {
  const dir = tempDir(t);
  writeFixture(dir);
  const people = openPopulationFile(path.join(dir, 'population.bin'));
  assert.equal(people.header.total, 1_050_050);
  // The pyramid sums people as it sums articles.
  assert.equal(
    people.level(4).reduce((a, b) => a + b, 0),
    1_050_050,
  );
  const service = createWikipediaCoverageService({
    gridFile: path.join(dir, 'grid.bin'),
    env: {},
  });
  const layers = await service.layers();
  const capita = layers.variants.find((v) => v.key === 'capita');
  assert.equal(capita.available, true);
  // One cell with people and articles: its value is the whole domain.
  assert.ok(Math.abs(capita.domain.median - 20) < 1e-9);
  assert.deepEqual(layers.population, {
    built: true,
    source: 'test',
    total: 1_050_050,
    builtAt: '2026-10-20T00:00:00.000Z',
    floor: 100,
    perPeople: 100_000,
  });
  // z 9: a 0.05° cell is about 18 pixels; A reads 20 per 100k, B (50
  // people) nothing, C (no articles) nothing.
  const at = (point, variant = 'capita', z = 9) => {
    const { tile } = pixel(Buffer.alloc(16 + 256 * 256 * 4), z, ...point);
    return service
      .tile(variant, z, ...tile)
      .then((answer) => pixel(answer.body, z, ...point).value);
  };
  assert.ok(Math.abs((await at(A)) - 20) < 1e-4);
  assert.equal(await at(B), 0);
  assert.equal(await at(C), 0);
  // 10 articles of 5,000 bytes for 50,000 people: 1 byte a person.
  assert.ok(Math.abs((await at(A, 'textcapita')) - 1) < 1e-6);
  // z 2: A and B under one pixel: 12 articles over 50,050 people.
  assert.ok(Math.abs((await at(A, 'capita', 2)) - (12 / 50_050) * 1e5) < 1e-3);
  // Hexagons: resolution 7 takes the density of the cell under its
  // centre times its area; resolution 2 sums the cells it holds.
  const box = { west: -1, south: -1, east: 1, north: 1 };
  const fine = await service.h3(7, 'capita', box);
  assert.equal(fine.status, 200);
  const hexA = h3.latLngToCell(A[0], A[1], 7);
  const expected =
    (10 /
      ((50_000 / rowAreaKm2(0, cellOf(...A, 0).row)) *
        h3.cellArea(hexA, 'km2'))) *
    1e5;
  const cellA = fine.body.cells.find(([index]) => index === hexA);
  assert.ok(Math.abs(cellA[1] - expected) / expected < 1e-5, String(cellA[1]));
  // B's hexagon has under 100 people: left out.
  assert.equal(
    fine.body.cells.some(([index]) => index === h3.latLngToCell(B[0], B[1], 7)),
    false,
  );
  const coarse = await service.h3(2, 'capita', box);
  assert.equal(coarse.body.cells.length, 1);
  assert.ok(Math.abs(coarse.body.cells[0][1] - (12 / 50_050) * 1e5) < 1e-3);
  assert.ok(coarse.body.domain.median > 0);
  // The existing variants answer as before.
  const articles = await service.h3(7, 'articles', box);
  assert.equal(articles.body.cells.length, 2);
  // A rebuilt grid (another builtAt) without capita.bin again: refused.
  writeFixture(dir, { builtAt: '2026-11-17T12:00:00.000Z' });
  fs.rmSync(path.join(dir, 'capita.bin'));
  const later = createWikipediaCoverageService({
    gridFile: path.join(dir, 'grid.bin'),
    env: {},
  });
  const stale = await later.layers();
  assert.equal(stale.variants.find((v) => v.key === 'capita').available, false);
  assert.equal(stale.population.built, false);
  assert.equal((await later.tile('capita', 2, 2, 1)).status, 503);
  assert.equal((await later.tile('capita', 2, 2, 1)).error, NEEDS_POPULATION);
  assert.equal((await later.h3(2, 'capita', box)).status, 503);
  assert.equal((await later.tile('articles', 2, 2, 1)).status, 200);
});

test('the Earth Engine step: 120 tiles of the base, people from density × area, a stopped run resumed from its parts', async (t) => {
  const dir = tempDir(t);
  const tiles = populationTiles();
  assert.equal(tiles.length, 120);
  assert.deepEqual(tiles[0].box, {
    west: -180,
    east: -154.4,
    north: 90,
    south: 64.4,
  });
  assert.equal(tiles.at(-1).box.west, 178.4);
  let asked = 0;
  const npy = (rows, cols, density) => {
    let header = `{'descr': [('v', '<f4'), ('m', '<f4')], 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
    header += ' '.repeat(64 - ((10 + header.length + 1) % 64)) + '\n';
    const head = Buffer.alloc(10);
    head[0] = 0x93;
    head.write('NUMPY', 1, 'latin1');
    head[6] = 1;
    head.writeUInt16LE(header.length, 8);
    const body = Buffer.alloc(rows * cols * 8);
    for (let i = 0; i < rows * cols; i++) {
      body.writeFloatLE(density, i * 8);
      body.writeFloatLE(density > 0 ? 1 : 0, i * 8 + 4);
    }
    return Buffer.concat([head, Buffer.from(header, 'latin1'), body]);
  };
  const earthEngine = {
    async computePixels(layerId, expression, grid) {
      asked += 1;
      assert.equal(layerId, 'ee-population');
      assert.doesNotMatch(JSON.stringify(expression), /Image\.log10/);
      const { width, height } = grid.dimensions;
      // Ten people per km² in the tile holding the equator and the meridian.
      const box = grid.affineTransform;
      const holds = box.translateX <= 0 && box.translateX + width * 0.05 > 0;
      return {
        status: 200,
        body: npy(
          height,
          width,
          holds && box.translateY > 0 && box.translateY - height * 0.05 < 0
            ? 10
            : 0,
        ),
      };
    },
  };
  // Stopped after 50 tiles (Earth Engine went away)…
  const failing = {
    computePixels: (...args) =>
      asked >= 50
        ? Promise.resolve({ status: 403, error: 'gone' })
        : earthEngine.computePixels(...args),
  };
  await assert.rejects(buildPopulation({ dir, earthEngine: failing }), /403/);
  assert.equal(asked, 50);
  assert.equal(fs.readdirSync(path.join(dir, 'population-parts')).length, 50);
  // …and run again: only the other 70 are fetched; the parts then go.
  const first = await buildPopulation({ dir, earthEngine });
  assert.equal(asked, 120);
  assert.equal(first.fetched, 70);
  assert.equal(fs.existsSync(path.join(dir, 'population-parts')), false);
  const people = openPopulationFile(path.join(dir, 'population.bin'));
  const { row, col } = cellOf(0.025, 0.025, 0);
  const value = people.level(0)[row * BASE_WIDTH + col];
  assert.ok(Math.abs(value - 10 * rowAreaKm2(0, row)) < 1e-3, String(value));
});
