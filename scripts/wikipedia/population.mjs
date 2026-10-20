import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_CELL_DEG,
  BASE_HEIGHT,
  BASE_WIDTH,
  openGrid,
  rowAreas,
} from '../../server/providers/wikipediaCoverage/grid.js';
import { openH3File } from '../../server/providers/wikipediaCoverage/h3.js';
import {
  openPopulationFile,
  writeCapitaFile,
  writePopulationFile,
} from '../../server/providers/wikipediaCoverage/population.js';
import {
  pixelGrid,
  readNpy,
  valuesExpression,
  valuesLayer,
} from '../../server/providers/rasterValues/earthEngineValues.js';
import { expressionFor } from '../../server/providers/earthEngine.js';
import {
  EARTH_ENGINE_LAYERS,
  POPULATION_EPOCH,
  layerVariants,
  populationDataset,
} from '../../src/data/earthEngineLayers.js';

/**
 * The people step of the Wikipedia coverage build (`npm run
 * wikipedia:build -- --population`): GHSL's 2020 population density, the
 * Population layer's own expression (people per km², without the map's
 * log ramp or floor), fetched from Earth Engine onto the grid's 0.05° base
 * with image:computePixels, in tiles of POPULATION_TILE cells a side (120
 * requests for the world, each counted against the day's Earth Engine
 * budget as a tile), times each cell's area: people per cell. Earth Engine
 * reads the pyramid level nearest 0.05° (GHSL's is MEAN), so a cell's
 * density is the mean of the 100 m pixels under it.
 *
 * Each tile is kept as it arrives (population-parts/), so a stopped run
 * repeats nothing; then population.bin (every level), the parts removed,
 * and capita.bin for the grid and hexagons on disk.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const POPULATION_TILE = 512;
export const POPULATION_MODE = `density-${POPULATION_EPOCH}`;

/** Degrees without the float noise of 0.05 steps (178.40000000000003). */
const degrees = (value) => Math.round(value * 1e9) / 1e9;

/** The tiles of the base grid: [{tx, ty, col, row, cols, rows, box}]. */
export function populationTiles(size = POPULATION_TILE) {
  const tiles = [];
  for (let row = 0; row < BASE_HEIGHT; row += size)
    for (let col = 0; col < BASE_WIDTH; col += size) {
      const cols = Math.min(size, BASE_WIDTH - col);
      const rows = Math.min(size, BASE_HEIGHT - row);
      tiles.push({
        tx: col / size,
        ty: row / size,
        col,
        row,
        cols,
        rows,
        box: {
          west: degrees(-180 + col * BASE_CELL_DEG),
          east: degrees(-180 + (col + cols) * BASE_CELL_DEG),
          north: degrees(90 - row * BASE_CELL_DEG),
          south: degrees(90 - (row + rows) * BASE_CELL_DEG),
        },
      });
    }
  return tiles;
}

/** The Population layer's density expression for an epoch's mode, as numbers (value and mask bands). */
export function populationExpression(mode = POPULATION_MODE) {
  const layer = EARTH_ENGINE_LAYERS.find(
    (entry) => entry.id === 'ee-population',
  );
  const plain = valuesLayer(layer);
  return valuesExpression(
    expressionFor(plain, layerVariants(plain)[0], undefined, mode),
  );
}

/**
 * Fetch the base people tile by tile and write population.bin.
 * @param {{dir: string, earthEngine: {computePixels: Function},
 *   log?: Function, now?: () => number}} options
 */
export async function buildPopulation({
  dir,
  earthEngine,
  log = () => {},
  now = () => Date.now(),
}) {
  const partsDir = path.join(dir, 'population-parts');
  fs.mkdirSync(partsDir, { recursive: true });
  const expression = populationExpression();
  const tiles = populationTiles();
  const areas = rowAreas(0);
  const base = new Float32Array(BASE_WIDTH * BASE_HEIGHT);
  const started = now();
  let fetched = 0;
  for (const tile of tiles) {
    const file = path.join(partsDir, `${tile.tx}-${tile.ty}.f32`);
    let people = null;
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      people = new Float32Array(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    } else {
      let answer = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        answer = await earthEngine.computePixels(
          'ee-population',
          expression,
          pixelGrid(tile.box, tile.cols, tile.rows),
        );
        if (answer.status === 200) break;
        if (![429, 500, 502, 503, 504].includes(answer.status)) break;
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * (attempt + 1)),
        );
      }
      if (answer.status !== 200)
        throw new Error(
          `tile ${tile.tx},${tile.ty}: ${answer.status} ${answer.error || ''}`,
        );
      const { rows, cols, bands } = readNpy(answer.body);
      if (rows !== tile.rows || cols !== tile.cols)
        throw new Error(
          `tile ${tile.tx},${tile.ty}: answered ${cols} × ${rows}`,
        );
      people = new Float32Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        const area = areas[tile.row + r];
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const density = bands.m[i] > 0 ? bands.v[i] : 0;
          people[i] = density > 0 ? density * area : 0;
        }
      }
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, Buffer.from(people.buffer));
      fs.renameSync(temporary, file);
      fetched += 1;
      if (fetched % 10 === 0)
        log(
          `population: ${fetched} tiles fetched, ${((now() - started) / 1000).toFixed(0)} s`,
        );
    }
    for (let r = 0; r < tile.rows; r++)
      base.set(
        people.subarray(r * tile.cols, (r + 1) * tile.cols),
        (tile.row + r) * BASE_WIDTH + tile.col,
      );
  }
  const dataset = populationDataset();
  const written = writePopulationFile(path.join(dir, 'population.bin'), {
    header: {
      builtAt: new Date(now()).toISOString(),
      source: {
        name: `GHSL P2023A ${POPULATION_EPOCH}`,
        asset: dataset.image || dataset.asset || null,
        band: dataset.band || null,
        expression: crypto
          .createHash('sha256')
          .update(JSON.stringify(expression))
          .digest('hex')
          .slice(0, 12),
      },
      tiles: tiles.length,
    },
    base,
  });
  // Written: the parts were only for a stopped run.
  fs.rmSync(partsDir, { recursive: true, force: true });
  log(
    `population: ${tiles.length} tiles (${fetched} fetched now) in ${((now() - started) / 1000).toFixed(0)} s; ${(written.header.total / 1e9).toFixed(3)} billion people; ${(written.bytes / 1_048_576).toFixed(1)} MB`,
  );
  return { ...written, fetched };
}

/**
 * Write capita.bin for the grid and hexagons on disk, when population.bin
 * is there; returns its header, or null.
 */
export function buildCapita({ dir, log = () => {} }) {
  const populationFile = path.join(dir, 'population.bin');
  const gridFile = path.join(dir, 'grid.bin');
  if (!fs.existsSync(populationFile) || !fs.existsSync(gridFile)) return null;
  const started = Date.now();
  const h3File = path.join(dir, 'h3.bin');
  const written = writeCapitaFile(path.join(dir, 'capita.bin'), {
    header: { builtAt: new Date().toISOString() },
    grid: openGrid(gridFile),
    hexes: fs.existsSync(h3File) ? openH3File(h3File) : null,
    population: openPopulationFile(populationFile),
  });
  log(
    `capita: ${(written.bytes / 1_048_576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return written.header;
}
