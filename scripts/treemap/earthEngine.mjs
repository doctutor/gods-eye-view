// Personal fork: the treemap's phase 2 tables, from Earth Engine: land
// cover per country and region (ESA WorldCover, a second m2/surface-area
// table that answers the landcover.class cut) and m3/land-volume (cell area
// × mean elevation above the sea, from the DEM stack's far band), both on a
// coarse grid of about 2.5 km. Not part of upstream God's Eye View.
//
// The world is asked in BOX_DEGREES boxes of at most CELLS cells a side
// (image:computePixels through the server's own Earth Engine service, so
// each request is counted in its daily ledger), only boxes with land in
// the stored labelling, one at a time. Each box's answer is kept under
// the tables' directory (ee/), so a rebuild asks again only for what it
// does not have. A run stops once it has made `maxRequests`.
import fs from 'node:fs';
import path from 'node:path';
import { createEarthEngineService } from '../../server/providers/earthEngine.js';
import { createEarthEngineAdapter } from '../../server/providers/rasterValues/earthEngineValues.js';
import {
  EARTH_AREA_M2,
  sinAuthalic,
} from '../../server/providers/treemap/geodesy.js';
import { LABEL_TILE_ZOOM } from '../../server/providers/treemap/labeller.js';
import { REST_KEY, encodeTable } from '../../server/providers/treemap/table.js';
import {
  EARTH_ENGINE_LAYERS,
  LAND_COVER_CLASSES,
} from '../../src/data/earthEngineLayers.js';
import {
  TREEMAP_LABELS,
  treemapVariable,
} from '../../src/data/treemapCatalog.js';
import { continentOfCountry } from '../../src/data/treemapContinents.js';
import { adminKeys } from './areas.mjs';

export const EARTH_ENGINE_TABLES_VERSION = 3;
export const BOX_DEGREES = 15;
export const CELLS = 640;
/** A run stops after this many boxes fail one after another. */
const FAILURES_IN_A_ROW = 5;
/** The Mercator labelling stops here; Antarctica's land goes on to −90. */
const MERCATOR_LIMIT = 85.0511;
const NORTH = 84;
const SOUTH = -90;
const RA2 = EARTH_AREA_M2 / (4 * Math.PI);
const CLASS_KEYS = Object.keys(TREEMAP_LABELS.landCover);

/** The boxes (w, s, e, n) of the grid, north row first. */
export function gridBoxes() {
  const boxes = [];
  for (let north = NORTH; north > SOUTH; north -= BOX_DEGREES)
    for (let west = -180; west < 180; west += BOX_DEGREES)
      boxes.push({
        west,
        south: Math.max(SOUTH, north - BOX_DEGREES),
        east: west + BOX_DEGREES,
        north,
      });
  return boxes;
}

/** Whether the stored labelling has a tile under a box (land near). */
export function boxHasLand(box, labelsIndex) {
  if (box.south < -MERCATOR_LIMIT) return true;
  const n = 2 ** LABEL_TILE_ZOOM;
  const x = (lon) => Math.min(n - 1, Math.floor(((lon + 180) / 360) * n));
  const y = (lat) => {
    const clamped = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    return Math.min(
      n - 1,
      Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n),
    );
  };
  for (let ty = y(box.north); ty <= y(box.south); ty++)
    for (let tx = x(box.west); tx <= x(box.east - 1e-9); tx++)
      if (labelsIndex.tiles[ty * n + tx]) return true;
  return false;
}

/**
 * Ask (or read back) every land box's values for a layer.
 * @returns {Promise<{boxes: {box, cols, rows, values: Float32Array}[],
 *   requests: number, stopped: boolean}>}
 */
async function fetchLayer({
  layerId,
  mode,
  boxes,
  cacheDir,
  earthEngine,
  budget,
  log,
}) {
  const layer = EARTH_ENGINE_LAYERS.find((entry) => entry.id === layerId);
  const adapter = createEarthEngineAdapter(layer, earthEngine);
  const dir = path.join(cacheDir, `${layerId}-${mode || 'default'}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  let failed = 0;
  let inARow = 0;
  for (const [i, box] of boxes.entries()) {
    const stem = path.join(dir, `${box.west}_${box.north}_${CELLS}`);
    if (fs.existsSync(`${stem}.json`)) {
      const meta = JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8'));
      const bytes = fs.readFileSync(`${stem}.f32`);
      out.push({
        box,
        cols: meta.cols,
        rows: meta.rows,
        values: new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.length / 4,
        ),
      });
      continue;
    }
    if (budget.used >= budget.max) {
      log(`  ${layerId}: stopped at ${budget.used} requests (the cap)`);
      return { boxes: out, stopped: true, failed };
    }
    const plan = adapter.plan(mode, box, CELLS);
    const answer = await plan.run();
    if (answer.status !== 200) {
      failed++;
      inARow++;
      log(
        `  ${layerId}: box ${box.west},${box.south}: ${answer.status} ${String(answer.error || '').slice(0, 160)}`,
      );
      if (
        answer.status === 429 ||
        (answer.status === 503 && /key/i.test(answer.error || ''))
      )
        return { boxes: out, stopped: true, failed };
      if (inARow >= FAILURES_IN_A_ROW) {
        log(`  ${layerId}: ${inARow} boxes failed in a row; stopped`);
        return { boxes: out, stopped: true, failed };
      }
      continue;
    }
    inARow = 0;
    const values = Float32Array.from(answer.values);
    fs.writeFileSync(`${stem}.f32`, Buffer.from(values.buffer));
    fs.writeFileSync(
      `${stem}.json`,
      JSON.stringify({
        cols: plan.cols,
        rows: plan.rows,
        box,
        source: plan.source,
        aggregation: answer.aggregation || plan.aggregation,
      }),
    );
    out.push({ box, cols: plan.cols, rows: plan.rows, values });
    if ((i + 1) % 10 === 0)
      log(
        `  ${layerId}: ${i + 1} of ${boxes.length} boxes, ${budget.used} requests so far`,
      );
  }
  return { boxes: out, stopped: false, failed };
}

/**
 * Visit every cell of the boxes: (value, area m², units|null).
 * @param {{boxes: object[]}} fetched
 * @param {object} labeller
 */
function eachCell(fetched, labeller, visit) {
  for (const { box, cols, rows, values } of fetched.boxes) {
    const dLon = ((box.east - box.west) / cols) * (Math.PI / 180);
    const dLat = (box.north - box.south) / rows;
    for (let r = 0; r < rows; r++) {
      const top = box.north - r * dLat;
      const bottom = top - dLat;
      const lat = top - dLat / 2;
      const area =
        RA2 *
        dLon *
        Math.abs(
          sinAuthalic((top * Math.PI) / 180) -
            sinAuthalic((bottom * Math.PI) / 180),
        );
      for (let c = 0; c < cols; c++) {
        const value = values[r * cols + c];
        if (!Number.isFinite(value)) continue;
        const lon = box.west + ((c + 0.5) / cols) * (box.east - box.west);
        const units =
          lat < -MERCATOR_LIMIT
            ? { country: 'AQ', region: null, district: null }
            : labeller.label(lon, lat);
        visit(value, area, units);
      }
    }
  }
}

/**
 * Build the land cover and land volume tables.
 * @param {{root: string, env: object, cacheDir: string, labeller: object,
 *   labelsIndex: object, units: object[], landByCountry: Map<string,
 *   number>, maxRequests: number, log: Function}} options
 */
export async function buildEarthEngineTables({
  root,
  env,
  cacheDir,
  labeller,
  labelsIndex,
  units,
  landByCountry,
  elevation: withElevation = true,
  maxRequests,
  log,
}) {
  const service = createEarthEngineService({ sourceRoot: root, env });
  const budget = { used: 0, max: maxRequests };
  // Every computePixels the adapters make, counted here as well as in the
  // service's daily ledger.
  const earthEngine = {
    computePixels: (...args) => {
      budget.used++;
      return service.computePixels(...args);
    },
  };
  const boxes = gridBoxes().filter((box) => boxHasLand(box, labelsIndex));
  const complete = (fetched, asked) =>
    !fetched.stopped &&
    !fetched.failed &&
    fetched.boxes.length === asked.length;
  log(`  earth engine: ${boxes.length} land boxes of ${gridBoxes().length}`);
  const cover = await fetchLayer({
    layerId: 'ee-land-cover',
    mode: 'v200',
    boxes,
    cacheDir,
    earthEngine,
    budget,
    log,
  });
  // Elevation only where land cover found land: the labelling has tiles
  // over open sea (a large unit's box spans it), land cover does not.
  const landBoxes = cover.boxes
    .filter((entry) => entry.values.some(Number.isFinite))
    .map((entry) => entry.box);
  const elevation =
    !withElevation || !complete(cover, boxes)
      ? { boxes: [], stopped: true, failed: 0 }
      : await fetchLayer({
          layerId: 'ee-elevation',
          mode: '',
          boxes: landBoxes,
          cacheDir,
          earthEngine,
          budget,
          log,
        });

  const { labels, geo } = adminKeys(units);
  const admin = (found) => {
    const continent = found ? continentOfCountry(found.country) : null;
    return continent
      ? [continent, found.country, found.region || REST_KEY]
      : null;
  };

  let coverTable = null;
  if (complete(cover, boxes)) {
    // country → region → class → m²
    const sums = new Map();
    eachCell(cover, labeller, (value, area, found) => {
      const keys = admin(found);
      const klass = CLASS_KEYS[Math.round(value)];
      if (!keys || !klass) return;
      const id = [...keys, klass].join('\t');
      sums.set(id, (sums.get(id) || 0) + area);
    });
    // Scaled so a country's classes add up to its land in the areas table.
    const byCountry = new Map();
    for (const [id, area] of sums) {
      const country = id.split('\t')[1];
      byCountry.set(country, (byCountry.get(country) || 0) + area);
    }
    const rows = [...sums].map(([id, area]) => {
      const keys = id.split('\t');
      const land = landByCountry.get(keys[1]);
      const scale = land ? land / byCountry.get(keys[1]) : 1;
      return { keys, value: area * scale, count: 0 };
    });
    for (const key of sums.keys()) {
      const region = key.split('\t')[2];
      if (!labels['admin.region'][region])
        labels['admin.region'][region] = region;
    }
    coverTable = encodeTable({
      variable: 'm2/surface-area',
      dims: [
        'admin.continent',
        'admin.country',
        'admin.region',
        'landcover.class',
      ],
      rows,
      labels: { ...labels, 'landcover.class': { ...TREEMAP_LABELS.landCover } },
      geo,
      exact: false,
      note: "ESA WorldCover 2021 sampled every ~2.5 km (its pyramid's most common class), each country's classes scaled to its land in the areas table. WorldCover stops at 60° S: Antarctica has no land cover, so the land here is about 137 of the 150 million km².",
      attribution:
        'ESA WorldCover 2021 (CC BY 4.0), through Google Earth Engine',
      asOf: '2021',
    });
  }

  let volumeTable = null;
  if (complete(elevation, landBoxes)) {
    const sums = new Map();
    eachCell(elevation, labeller, (value, area, found) => {
      const keys = admin(found);
      if (!keys) return;
      const id = keys.join('\t');
      const entry = sums.get(id) || [0, 0];
      entry[0] += area * Math.max(0, value);
      entry[1] += area;
      sums.set(id, entry);
    });
    for (const key of sums.keys()) {
      const region = key.split('\t')[2];
      if (!labels['admin.region'][region])
        labels['admin.region'][region] = region;
    }
    volumeTable = encodeTable({
      variable: 'm3/land-volume',
      dims: ['admin.continent', 'admin.country', 'admin.region'],
      rows: [...sums].map(([id, [volume, area]]) => ({
        keys: id.split('\t'),
        value: volume,
        count: 0,
        base: area,
      })),
      base: {
        label: 'land area',
        unit: 'm2',
        intensive: treemapVariable('m3/land-volume').product.intensive,
        intensiveUnit: 'm',
      },
      labels,
      geo,
      exact: false,
      note: "Land above sea level, from cells of about 2.5 km: each cell's area times its mean elevation above the sea (the DEM stack's far band: GMTED2010, ArcticDEM over Greenland, the polar stack over Antarctica; ice surfaces included), summed. A tile's mean elevation is its volume over its land area.",
      attribution:
        'GMTED2010 (USGS and NGA), ArcticDEM and REMA (Polar Geospatial Center), through Google Earth Engine',
    });
  }
  return {
    cover: coverTable,
    volume: volumeTable,
    stats: {
      boxes: boxes.length,
      requests: budget.used,
      coverBoxes: cover.boxes.length,
      landBoxes: landBoxes.length,
      elevationBoxes: elevation.boxes.length,
      failed: cover.failed + elevation.failed,
    },
  };
}
