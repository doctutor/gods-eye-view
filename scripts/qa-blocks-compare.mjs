#!/usr/bin/env node
/**
 * Personal fork: the Blocks milestone 1 comparison (docs/BLOCKS-PLAN.md).
 * Opens a production build headless at map=blank-black with the Elevation
 * layer on at Baltimore (lat 39.3214, lon -76.6292, alt 300, heading 0,
 * pitch -30), once in Render: Colour and once in Render: Blocks (`bk=1`),
 * and writes colour.png and blocks.png side by side for a person to judge.
 *
 * No server and no port: every request is answered by request interception.
 * The build's files come from --dist; /api/raster/values and the Elevation
 * layer's Earth Engine catalog and tiles come from a synthetic heightfield
 * (a hill and a river valley, 64 × 64 cells at 10 m, served at 1 m and
 * tiled by reflection out past the coarse ring), so
 * neither Earth Engine nor the local server is needed; the colour tiles
 * paint it in the PET rainbow over 0 to 100 m, the `cs` the hash asks
 * for; /api/overpass answers a few synthetic buildings north of the
 * camera (SYNTHETIC_BUILDINGS), so Blocks draws them. Every other /api/
 * route answers 404 and other hosts are refused.
 *
 *   node scripts/qa-blocks-compare.mjs --dist <vite build dir> --out <dir>
 *   node scripts/qa-blocks-compare.mjs --build --out <dir>   # builds first
 *   ... --views judgement,eye   # the default: both pairs (the eye pair
 *                               # 1.7 m above the ground, pitch -5)
 *
 * --build runs `vite build` into <out>/dist. --out must be outside the
 * repository (the PNGs are not committed). PUPPETEER_EXECUTABLE_PATH or
 * --chrome picks the browser.
 *
 *   ... --live http://localhost:4173   # real data from a running app server
 *
 * --live sends /api/raster/values, /api/overpass and the Earth Engine
 * routes (the Colour shots' catalog and tiles, so the pair compares the
 * same ground) to an app server that is already running; it never starts
 * one, and says so and stops when none answers. The build and every other
 * route stay intercepted. The eye-level view stands on the live ground
 * under the camera (one values probe from here). Every run also writes
 * report.json: each shot's status line, requests by kind, the server's
 * answers by status and the fresh ring's time.
 *
 *   ... --altitudes 300,5000,50000,500000,3000000   # Blocks at any scale
 *
 * In --build the Elevation layer's Blocks style (blocks-<cellM> tiles) is
 * flat terrain sand on the style's lattice (blocksStyleTile), so the drape
 * shows under and beyond coarse blocks; --live sends it to the server.
 *
 * --altitudes shoots Baltimore straight from each height (metres above the
 * ellipsoid) at pitch −45 and −90, in Colour and in Blocks, as
 * scale-<height>-p<pitch>-colour.png and -blocks.png (milestone 5 of
 * docs/BLOCKS-PLAN.md), instead of --views. report.json then also gives
 * each Blocks shot's level as its status line says it (the cell, the level
 * height, the chunks fine and coarse).
 *
 *   ... --altitudes 5000000 --place 44,-84   # another place than Baltimore
 *
 * --place shoots the --altitudes views over a latitude and longitude (the
 * Great Lakes, Lake Tahoe) instead of Baltimore; --pitches -15,-45 shoots
 * them at those pitches instead of -45 and -90.
 *
 *   ... --tiles-dir D:/gev-cache/blocks-tiles   # with --sequence or --altitudes
 *
 * --tiles-dir serves the precomputed Blocks tilesets from that folder, so
 * the shots draw tiles where a box holds them and live chunks beside them.
 *
 *   ... --sequence --panels   # Data Layers and Display open throughout
 *
 * Before each step (and before the --altitudes shots) the harness waits,
 * up to 10 minutes, while a unit suite, a tileset or pyramid build,
 * another harness or a vite build runs (CONCURRENT_JOBS); a step timed
 * beside one all the same names it (`concurrent`). --no-wait skips that.
 *
 * --prewarm-check (with --altitudes) holds the Blocks pre-warm's Models
 * at the first Blocks status and counts the pixels they change at the
 * canvas's centre, read back from the scene itself: none, if they never
 * show.
 *
 * --buildings-off opens the page with Blocks' Buildings off (bk=1.b0).
 *
 * --load-frames shoots each step 2, 5, 10 and 20 s after its flight's end
 * (with --altitudes: each Blocks shot 2 to 80 s from the page's load)
 * (<step>-load-<s>s.png) with the status line, the tiles' hole and the mesh
 * pool's counts then; for a check, not a timing run. With --altitudes,
 * each frame also keeps the camera, the shown tileset's selected tiles and
 * the tile top under the camera, and report.json each tile asked for (ms
 * from the page's start). --frame-eval <file> runs that file's function
 * (its source, `() => ...`) in the page at each of those frames and keeps
 * its answer: an experiment on the scene there; it runs once more as
 * those frames start (an experiment watching every frame starts there).
 * scripts/qa-blocks-timeline.js is one: the splash, the box drawn and
 * pending, and each gap in the drawn tiles' cover of the view.
 *
 * --panels opens the two panels before the steps, shoots each step 1.5 s
 * into its flight (<step>-flight.png) and, after the city, opens the
 * Elevation row's colour scale (<step>-grown.png), keeping the panels'
 * rectangles, overlaps and overflow each time (sequence.json, `panels`).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  M_PER_DEG,
  decodeRasterValues,
  encodeRasterValues,
  parseRasterValuesQuery,
  valueRange,
  windowGrid,
} from '../src/data/rasterValues.js';
import { encodeLayerStateParams } from '../src/data/layerState.js';
import { EARTH_ENGINE_LAYERS } from '../src/data/earthEngineLayers.js';
import { chromeExecutablePath } from './qa-chrome.mjs';
import { connectWithoutRace } from '../build/loopback.js';
import { blocksStyleZoomBand } from '../src/data/blocksStyle.js';
import { MATERIAL_COLORS } from '../src/layers/blocks/lighting.js';
import { MATERIALS } from '../src/layers/blocks/store.js';
import {
  BLOCKS_TILES_ROUTE,
  resolveBlocksTilesPath,
} from '../server/providers/blocksTiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'http://gev-blocks.test';
export const VIEW = Object.freeze({
  lat: 39.3214,
  lon: -76.6292,
  alt: 300,
  heading: 0,
  pitch: -30,
});
// The window: 1600 × 900, or --size <w>x<h> (a pane's, say, whose pixel
// footprint picks another level).
let WIDTH = 1600;
let HEIGHT = 900;

// ── The synthetic heightfield ───────────────────────────────────────────

export const FIELD_CELLS = 64;
export const FIELD_CELL_M = 10;
/** Where the field sits: centred 600 m north of the camera, in the view's middle. */
export const FIELD_CENTRE = Object.freeze({
  lat: VIEW.lat + 600 / M_PER_DEG,
  lon: VIEW.lon,
});
/** The field's base, metres above sea level (its low south-west corner). */
export const PLAIN_M = 12;

/**
 * The field: 64 × 64 heights at 10 m, row 0 the north row. A plain rising
 * gently to the north-east, a round hill to 80 m north-west of the middle,
 * a ridge spur off it, and a river valley meandering west to east south of
 * the middle, cut to 2 m, its banks rising over about 60 m.
 */
export function syntheticField() {
  const n = FIELD_CELLS;
  const heights = new Float32Array(n * n);
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const x = (col + 0.5) / n; // 0 west … 1 east
      const y = 1 - (row + 0.5) / n; // 0 south … 1 north
      let h = PLAIN_M + 10 * x + 14 * y;
      const hill = Math.exp(
        -((x - 0.35) ** 2 + (y - 0.68) ** 2) / (2 * 0.12 ** 2),
      );
      const spur = Math.exp(
        -(((x - 0.6) * 0.8 + (y - 0.75) * 0.6) ** 2) / (2 * 0.05 ** 2) -
          ((x - 0.6) * -0.6 + (y - 0.75) * 0.8) ** 2 / (2 * 0.18 ** 2),
      );
      h += 52 * hill + 18 * spur;
      const channel = 0.3 + 0.07 * Math.sin(x * Math.PI * 2.4);
      const fromRiver = Math.abs(y - channel) * n * FIELD_CELL_M; // metres
      const valley = Math.min(1, fromRiver / 60);
      h = 2 + (h - 2) * valley ** 1.5;
      heights[row * n + col] = h;
    }
  return heights;
}

/** The field's bounds in degrees. */
export function fieldBounds() {
  const half = (FIELD_CELLS * FIELD_CELL_M) / 2;
  const dLat = half / M_PER_DEG;
  const dLon =
    half / (M_PER_DEG * Math.cos((FIELD_CENTRE.lat * Math.PI) / 180));
  return {
    west: FIELD_CENTRE.lon - dLon,
    south: FIELD_CENTRE.lat - dLat,
    east: FIELD_CENTRE.lon + dLon,
    north: FIELD_CENTRE.lat + dLat,
  };
}

/**
 * The native cell the harness serves, metres: 1 m, as 3DEP's lidar is at
 * Baltimore, so the shots have the live block size and render distances
 * (R1 = 512 m, the coarse ring to 2 km).
 */
export const NATIVE_M = 1;

/**
 * Mirror a position in field cells into 0 … FIELD_CELLS: the field tiled
 * by reflection, so it is continuous everywhere (no seam) and covers the
 * coarse ring however far it reaches.
 */
export function mirrorCell(u) {
  const period = 2 * FIELD_CELLS;
  const t = ((u % period) + period) % period;
  return t > FIELD_CELLS ? period - t : t;
}

/**
 * A height at a place: the field read between its 10 m cell centres
 * (bilinear, as a finer DEM would show the same ground), tiled by
 * reflection beyond its edges.
 */
export function heightAt(lon, lat, field, bounds = fieldBounds()) {
  const u = mirrorCell(
    ((lon - bounds.west) / (bounds.east - bounds.west)) * FIELD_CELLS,
  );
  const v = mirrorCell(
    ((bounds.north - lat) / (bounds.north - bounds.south)) * FIELD_CELLS,
  );
  const x = Math.min(FIELD_CELLS - 1, Math.max(0, u - 0.5));
  const y = Math.min(FIELD_CELLS - 1, Math.max(0, v - 0.5));
  const c0 = Math.floor(x);
  const r0 = Math.floor(y);
  const c1 = Math.min(FIELD_CELLS - 1, c0 + 1);
  const r1 = Math.min(FIELD_CELLS - 1, r0 + 1);
  const fx = x - c0;
  const fy = y - r0;
  const at = (r, c) => field[r * FIELD_CELLS + c];
  return (
    (at(r0, c0) * (1 - fx) + at(r0, c1) * fx) * (1 - fy) +
    (at(r1, c0) * (1 - fx) + at(r1, c1) * fx) * fy
  );
}

/** A /api/raster/values answer for ee-elevation over the field, at NATIVE_M. */
export function rasterValuesBody(query, field) {
  const box = query.box;
  const { cols, rows, cellSizeM } = windowGrid(box, query.cells, NATIVE_M);
  const values = new Float32Array(cols * rows);
  const bounds = fieldBounds();
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const lon = box.west + ((col + 0.5) / cols) * (box.east - box.west);
      const lat = box.north - ((row + 0.5) / rows) * (box.north - box.south);
      values[row * cols + col] = heightAt(lon, lat, field, bounds);
    }
  const { min, max } = valueRange(values);
  return encodeRasterValues(
    {
      layer: query.layer,
      mode: query.mode,
      cols,
      rows,
      ...box,
      cellSizeM: Math.round(cellSizeM * 1000) / 1000,
      units: 'm',
      min,
      max,
      legendMin: 0,
      legendMax: 100,
      source: `Synthetic ${NATIVE_M} m`,
      version: 'blocks-compare',
      aggregation: 'mean',
    },
    values,
  );
}

// ── Buildings: a synthetic Overpass answer ─────────────────────────────

/**
 * A few buildings north of the camera, in view from both shots: where
 * (metres north and east of the camera), how big, and the tags Overpass
 * would give (a height, or storeys, or nothing; one starts 6 m up, so a
 * hollow shows under it at eye level).
 */
export const SYNTHETIC_BUILDINGS = Object.freeze([
  {
    id: 1,
    north: 170,
    east: -70,
    width: 30,
    depth: 20,
    tags: { height: '18' },
  },
  {
    id: 2,
    north: 210,
    east: 10,
    width: 24,
    depth: 40,
    tags: { 'building:levels': '6', min_height: '6' },
  },
  {
    id: 3,
    north: 270,
    east: -130,
    width: 40,
    depth: 40,
    tags: { height: '45 m' },
  },
  { id: 4, north: 330, east: 70, width: 20, depth: 20, tags: { height: '80' } },
  {
    id: 5,
    north: 150,
    east: 110,
    width: 50,
    depth: 15,
    tags: { 'building:levels': '2' },
  },
  {
    id: 6,
    north: 430,
    east: -20,
    width: 60,
    depth: 30,
    tags: { 'building:levels': '4' },
  },
  { id: 7, north: 240, east: 160, width: 18, depth: 18, tags: {} },
]);

/** A building's ring (closed, lat/lon) around its centre. */
function buildingRing({ north, east, width, depth }) {
  const mLon = M_PER_DEG * Math.cos((VIEW.lat * Math.PI) / 180);
  const at = (dn, de) => ({
    lat: Math.round((VIEW.lat + (north + dn) / M_PER_DEG) * 1e7) / 1e7,
    lon: Math.round((VIEW.lon + (east + de) / mLon) * 1e7) / 1e7,
  });
  const ring = [
    at(-depth / 2, -width / 2),
    at(-depth / 2, width / 2),
    at(depth / 2, width / 2),
    at(depth / 2, -width / 2),
  ];
  return [...ring, ring[0]];
}

/**
 * The answer to an Overpass query from the Blocks buildings source
 * (structures.js groupQuery): the synthetic buildings in the query's
 * box, as `out geom` ways.
 */
export function overpassAnswer(query) {
  const box = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(
    String(query),
  );
  if (!box) return { elements: [] };
  const [south, west, north, east] = box.slice(1).map(Number);
  const elements = [];
  for (const building of SYNTHETIC_BUILDINGS) {
    const geometry = buildingRing(building);
    const inside = geometry.some(
      (p) => p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east,
    );
    if (inside)
      elements.push({
        type: 'way',
        id: building.id,
        tags: { building: 'yes', ...building.tags },
        geometry,
      });
  }
  return { elements };
}

// ── The colour tiles: PET rainbow, 0 to 100 m ───────────────────────────

/** The PET rainbow's stops (src/maps/colourScale.js 'pet'). */
export const PET_STOPS = Object.freeze([
  '000000',
  '3c0050',
  '5a00a0',
  '0000ff',
  '0080ff',
  '00c0c0',
  '00c000',
  'ffff00',
  'ff8000',
  'ff0000',
  'ffffff',
]);
export function petColour(value, floor = 0, ceiling = 100) {
  const t = Math.max(0, Math.min(1, (value - floor) / (ceiling - floor)));
  const at = t * (PET_STOPS.length - 1);
  const i = Math.min(PET_STOPS.length - 2, Math.floor(at));
  const f = at - i;
  const rgb = (hex) => [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  const a = rgb(PET_STOPS[i]);
  const b = rgb(PET_STOPS[i + 1]);
  return a.map((c, k) => Math.round(c + (b[k] - c) * f));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** An RGBA image as a PNG. */
export function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A web-mercator tile of the field in the PET rainbow (the plain too). */
export function colourTile(z, x, y, field, size = 256) {
  const rgba = new Uint8Array(size * size * 4);
  const bounds = fieldBounds();
  const scale = 2 ** z;
  for (let py = 0; py < size; py++) {
    const merc = Math.PI * (1 - (2 * (y + (py + 0.5) / size)) / scale);
    const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
    for (let px = 0; px < size; px++) {
      const lon = ((x + (px + 0.5) / size) / scale) * 360 - 180;
      const [r, g, b] = petColour(heightAt(lon, lat, field, bounds));
      const at = (py * size + px) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/** The Blocks lattice's metres a degree (lattice.js, the server's style grid). */
const LATTICE_M_PER_DEG = 111_319.49;
/** The style's cell edges: the westmost and southmost eighth of a cell. */
export const STYLE_EDGE_PARTS = 8;
/** How much darker an edge is than the cell. */
const STYLE_EDGE_SHADE = 0.72;

/**
 * A tile of the Elevation layer's Blocks style for --build (the server's
 * is Earth Engine's, server/providers/earthEngine.js): flat terrain sand
 * on the style's lattice, equal-angle cells of `cellM` from 180° W and, in
 * whole cells, from 90° S, each edged on its westmost and southmost
 * eighth; below the level's zoom band (blocksStyleZoomBand) transparent,
 * as the server answers it.
 */
export function blocksStyleTile(cellM, z, x, y, size = 256) {
  const rgba = new Uint8Array(size * size * 4);
  if (z < blocksStyleZoomBand(cellM).min) return encodePng(size, size, rgba);
  const cellDeg = cellM / LATTICE_M_PER_DEG;
  const top = -90 + Math.ceil(180 / cellDeg) * cellDeg;
  const [r, g, b] = MATERIAL_COLORS[MATERIALS.TERRAIN];
  const edge = 1 / STYLE_EDGE_PARTS;
  const scale = 2 ** z;
  for (let py = 0; py < size; py++) {
    const merc = Math.PI * (1 - (2 * (y + (py + 0.5) / size)) / scale);
    const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
    const down = (top - lat) / cellDeg;
    const south = down - Math.floor(down) > 1 - edge;
    for (let px = 0; px < size; px++) {
      const lon = ((x + (px + 0.5) / size) / scale) * 360 - 180;
      const across = (lon + 180) / cellDeg;
      const shade =
        south || across - Math.floor(across) < edge ? STYLE_EDGE_SHADE : 1;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r * shade);
      rgba[at + 1] = Math.round(g * shade);
      rgba[at + 2] = Math.round(b * shade);
      rgba[at + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/** The Earth Engine catalog with the Elevation layer alone, every variant ready. */
export function earthEngineCatalog() {
  const record = EARTH_ENGINE_LAYERS.find(
    (layer) => layer.id === 'ee-elevation',
  );
  const variants = (record.variants || []).map((variant) => ({
    key: variant.key,
    ready: true,
    ...(variant.auto ? { auto: true } : {}),
    ...(Number.isFinite(variant.minHeightM)
      ? { minHeightM: variant.minHeightM }
      : {}),
    ...(Number.isFinite(variant.maxHeightM)
      ? { maxHeightM: variant.maxHeightM }
      : {}),
  }));
  variants.push({ key: 'zoom', minZoom: 0, ready: true });
  return {
    configured: true,
    tiles: { used: 0, budget: 20_000 },
    layers: [
      {
        id: record.id,
        name: record.name,
        kind: record.kind,
        tileUrl: `/api/earth-engine/tile/${record.id}/{variant}/{ink}/{z}/{x}/{y}`,
        maxZoom: record.maxZoom ?? 12,
        variants,
        inks: ['default'],
        legend: record.legend || [],
        attribution: 'Synthetic heightfield (qa-blocks-compare)',
        tilesToday: 0,
        error: null,
      },
    ],
  };
}

// ── The page ────────────────────────────────────────────────────────────

/** A person's eye above the ground they stand on, metres. */
export const EYE_HEIGHT_M = 1.7;

/**
 * The eye-level view: the judgement view's place and heading, the camera
 * 1.7 m above the top of the block under it (the ground's level, a whole
 * block, and its top face one block up), looking 5° down.
 */
export function eyeView(field) {
  const ground = heightAt(VIEW.lon, VIEW.lat, field);
  const top = (Math.floor(ground / NATIVE_M) + 1) * NATIVE_M;
  return {
    ...VIEW,
    alt: Math.round((top + EYE_HEIGHT_M) * 10) / 10,
    pitch: -5,
  };
}

/** The views a run can shoot: name → {view, suffix} (the PNGs' names). */
export function views(field) {
  return {
    judgement: { view: VIEW, suffix: '' },
    eye: { view: eyeView(field), suffix: '-eye' },
    // Walk in third person, behind the walker, looking a little down into
    // the town (Blocks only: blocks-third.png).
    third: {
      view: { ...eyeView(field), pitch: -8 },
      suffix: '-third',
      nav: 'walk',
      viewMode: 'back',
      blocksOnly: true,
    },
  };
}

/** The pitches each --altitudes height is shot at. */
export const SCALE_PITCHES = Object.freeze([-45, -90]);

/** A height for a file name: 300m, 5km, 3000km. */
export const heightLabel = (metres) =>
  metres >= 1000 && metres % 1000 === 0
    ? `${metres / 1000}km`
    : `${Math.round(metres)}m`;

/**
 * The --altitudes views: Baltimore (the judgement view's place, heading
 * north), or `place` ({lat, lon}, --place), from each height at each of
 * SCALE_PITCHES (or `pitches`, --pitches), Colour and Blocks.
 */
export function scaleViews(altitudes, place = null, pitches = SCALE_PITCHES) {
  const out = {};
  for (const alt of altitudes)
    for (const pitch of pitches) {
      const prefix = `scale-${heightLabel(alt)}-p${Math.abs(pitch)}`;
      out[prefix] = { view: { ...VIEW, ...place, alt, pitch }, prefix };
    }
  return out;
}

/**
 * --pitches: the pitches (degrees, down negative) each --altitudes height
 * is shot at instead of SCALE_PITCHES; a shallow one (-15) looks out to
 * where the tiles meet the live chunks, past what -45 shows.
 */
export function parsePitches(value) {
  if (!value) return SCALE_PITCHES;
  const pitches = String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((deg) => Number.isFinite(deg) && deg < 0 && deg >= -90);
  if (!pitches.length) throw new Error(`--pitches: none in ${value}`);
  return pitches;
}

/** --place's latitude and longitude, or null for Baltimore. */
export function parsePlace(value) {
  if (!value) return null;
  const [lat, lon] = String(value).split(',').map(Number);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180))
    throw new Error(`--place: not a lat,lon: ${value}`);
  return { lat, lon };
}

/** The heights --altitudes asks for, metres; [] for none. */
export function parseAltitudes(value) {
  if (!value) return [];
  const heights = String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((metres) => Number.isFinite(metres) && metres > 0);
  if (!heights.length) throw new Error(`--altitudes: no heights in ${value}`);
  return heights;
}

/** "1.9 km" or "60 m" as metres. */
const sizeM = (number, unit) =>
  Number(number.replace(/,/g, '')) * (unit === 'km' ? 1000 : 1);

/**
 * What a Blocks status line says about the level (src/layers/lego/
 * presentation.js blocksStatusText): {state, blockM, levelM, relief,
 * chunks, coarse, source}, the sizes as written (1.9 km is 1,900 m).
 */
export function parseBlocksStatus(text = '') {
  const out = { state: 'other', text };
  const ceiling = /come below ([\d,.]+) km/.exec(text);
  if (ceiling)
    return { ...out, state: 'too-high', ceilingKm: sizeM(ceiling[1], 'm') };
  const head = /^Blocks: ([\d,.]+) (m|km) (cubes|cells)/.exec(text);
  if (!head) return out;
  const blockM = sizeM(head[1], head[2]);
  const level = /· ([\d,.]+) (m|km) levels/.exec(text);
  const relief = /· relief ×([\d.]+)/.exec(text);
  const counts =
    /· ([\d,]+) \+ ([\d,]+) coarse/.exec(text) ||
    /· ([\d,]+) chunks/.exec(text);
  return {
    ...out,
    state: /loading/.test(text) ? 'loading' : 'ready',
    blockM,
    levelM: level ? sizeM(level[1], level[2]) : blockM,
    relief: relief ? Number(relief[1]) : 1,
    chunks: counts ? Number(counts[1].replace(/,/g, '')) : null,
    coarse: counts?.[2] ? Number(counts[2].replace(/,/g, '')) : 0,
  };
}

/**
 * The link: the view, the blank black map, no layer from the link's layer
 * list (Earth Engine layers are not in it: the page turns Elevation on),
 * the Elevation layer's colour scale PET 0–100 m; Blocks with bk=1.
 */
export function pageHash({
  blocks,
  view = VIEW,
  nav = null,
  buildingsOff = false,
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(view))
    params.set(key, String(value));
  params.set('map', 'blank-black');
  encodeLayerStateParams(params, { enabledLayerIds: [], options: {} });
  // The Elevation layer's colour scale: PET rainbow, 0 to 100 m, linear.
  params.set('cs', 'el.r.0.100.n');
  // --buildings-off: Blocks without its buildings (renderMode.js b0).
  if (blocks) params.set('bk', buildingsOff ? '1.b0' : '1');
  // Walk or Fly from the link (src/navigation/store.js).
  if (nav) params.set('nav', nav);
  return `#${params.toString()}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
};

function staticFile(dist, pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(dist, clean || 'index.html');
  if (!file.startsWith(path.resolve(dist))) return null;
  try {
    if (statSync(file).isFile())
      return {
        body: readFileSync(file),
        contentType:
          MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      };
  } catch {
    /* not there */
  }
  return null;
}

/** The routes --live sends to the running server. */
export const LIVE_ROUTES = Object.freeze([
  '/api/raster/values',
  '/api/overpass',
  '/api/earth-engine/',
  // The location search (--sequence types into it).
  '/api/geocode',
  '/api/google/',
]);
export const isLiveRoute = (pathname) =>
  LIVE_ROUTES.some((route) =>
    route.endsWith('/') ? pathname.startsWith(route) : pathname === route,
  );

/**
 * Connection failures a GET is asked again after, once: a keep-alive
 * socket the server had just closed (Node's 5 s keep-alive), seen as
 * "fetch failed" though the server answered every other request.
 */
const RESET_CAUSES = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * Pass an intercepted request to the live server and answer with its
 * reply. A GET whose connection is reset is asked once more; a failure
 * after the shot's page closed (`log.closedAt`) is a request the shot no
 * longer waits for: counted in `log.cutOff`, not an error.
 */
export async function proxy(request, url, live, log, fetchImpl = fetch) {
  const started = Date.now();
  const route = url.pathname.startsWith('/api/earth-engine/')
    ? '/api/earth-engine/'
    : url.pathname;
  try {
    const headers = {};
    const type = request.headers()['content-type'];
    if (type) headers['content-type'] = type;
    const ask = () =>
      fetchImpl(`${live}${url.pathname}${url.search}`, {
        method: request.method(),
        headers,
        body: request.method() === 'GET' ? undefined : request.postData(),
      });
    let answer;
    try {
      answer = await ask();
    } catch (error) {
      const code = error?.cause?.code;
      if (request.method() !== 'GET' || !RESET_CAUSES.has(code)) throw error;
      log.retried = (log.retried || 0) + 1;
      answer = await ask();
    }
    const body = Buffer.from(await answer.arrayBuffer());
    const stat = (log.live[route] ||= {
      count: 0,
      ms: 0,
      bytes: 0,
      status: {},
    });
    stat.count++;
    stat.ms += Date.now() - started;
    // Each answer when and how long (a step's warm or cold cache).
    log.liveTimes?.push({
      at: started,
      path: url.pathname,
      ms: Date.now() - started,
      status: answer.status,
    });
    stat.bytes += body.length;
    stat.status[answer.status] = (stat.status[answer.status] || 0) + 1;
    // Answered after the shot: its page is gone, so nothing to answer.
    if (log.closedAt) return undefined;
    return request.respond({
      status: answer.status,
      contentType:
        answer.headers.get('content-type') || 'application/octet-stream',
      body,
    });
  } catch (error) {
    // The shot is over: nothing waits for this one, and its page is gone.
    if (log.closedAt) {
      log.cutOff = (log.cutOff || 0) + 1;
      return undefined;
    }
    const cause = error?.cause?.code || error?.cause?.message || '';
    log.errors.push(
      `live ${url.pathname}: ${error?.message || error}${cause ? ` (${cause})` : ''}, ${Date.now() - log.started} ms into the shot`,
    );
    log.liveTimes?.push({
      at: started,
      path: url.pathname,
      ms: Date.now() - started,
      status: 'failed',
    });
    return request.respond({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The live server did not answer' }),
    });
  }
}

/** Whether an app server answers at `origin` (its Earth Engine catalog). */
export async function liveServerUp(origin, fetchImpl = fetch) {
  try {
    const answer = await fetchImpl(`${origin}/api/earth-engine/layers`, {
      signal: AbortSignal.timeout(5000),
    });
    return answer.status < 500;
  } catch {
    return false;
  }
}

/**
 * The eye-level view over live ground: the height under the camera from
 * the running server's values (a 4 m probe), the camera 1.7 m above the
 * top of the block holding it (1 m blocks, sea level on the ellipsoid, as
 * the flat ground of the harness draws it).
 */
export async function liveEyeView(origin, fetchImpl = fetch) {
  const d = 2 / M_PER_DEG;
  const dLon = d / Math.cos((VIEW.lat * Math.PI) / 180);
  const query = new URLSearchParams({
    layer: 'ee-elevation',
    mode: '',
    west: String(VIEW.lon - dLon),
    south: String(VIEW.lat - d),
    east: String(VIEW.lon + dLon),
    north: String(VIEW.lat + d),
    cells: '2',
  });
  const answer = await fetchImpl(`${origin}/api/raster/values?${query}`);
  if (!answer.ok) throw new Error(`live values ${answer.status}`);
  const { values } = decodeRasterValues(await answer.arrayBuffer());
  const finite = [...values].filter(Number.isFinite);
  if (!finite.length) throw new Error('no ground under the camera');
  const ground = Math.max(...finite);
  const top = Math.floor(ground) + 1;
  return {
    ...VIEW,
    alt: Math.round((top + EYE_HEIGHT_M) * 10) / 10,
    pitch: -5,
  };
}

/**
 * Count a request the shots make of the data routes: raster values by kind
 * (the cells asked and the ground they cover: a probe, a fine group at
 * 1 m, a coarse supergroup at 4 m), Overpass queries, colour tiles.
 */
function countRequest(url, log) {
  if (url.pathname === '/api/raster/values') {
    log.values++;
    const query = parseRasterValuesQuery(url.searchParams);
    if (!query.ok) return;
    const { box } = query;
    const lat = ((box.south + box.north) / 2) * (Math.PI / 180);
    const spanM = (box.east - box.west) * M_PER_DEG * Math.cos(lat);
    const kind = `${query.cells} cells over ${Math.round(spanM)} m`;
    log.kinds[kind] = (log.kinds[kind] || 0) + 1;
    // In order, with the box's centre: which anchors asked what, and when.
    log.trail.push({
      ms: Date.now() - log.started,
      kind,
      lat: Math.round(((box.south + box.north) / 2) * 100) / 100,
      lon: Math.round(((box.west + box.east) / 2) * 100) / 100,
    });
  } else if (url.pathname === '/api/overpass') log.overpass++;
  else if (url.pathname.startsWith('/api/earth-engine/tile/')) log.tiles++;
}

/** Answer one intercepted request. */
function respond(request, { dist, field, log, live, tilesDir = null }) {
  const url = new URL(request.url());
  if (url.origin !== ORIGIN) return request.abort('blockedbyclient');
  if (log.requests && url.pathname.startsWith('/api/')) {
    const entry = { at: Date.now(), path: url.pathname };
    if (url.pathname === '/api/raster/values') {
      // The cell asked for, metres (north to south over the rows).
      const query = parseRasterValuesQuery(url.searchParams);
      if (query.ok) {
        const { box, cells } = query;
        entry.cellM = Math.round(((box.north - box.south) * M_PER_DEG) / cells);
        entry.cells = cells;
      }
    }
    log.requests.push(entry);
  }
  // --tiles-dir: the precomputed Blocks tilesets from disk, read-only, by
  // the server's own rules (server/providers/blocksTiles.js), until the
  // app server serves them.
  if (tilesDir && url.pathname.startsWith(`${BLOCKS_TILES_ROUTE}/`)) {
    // Each tile asked, with when (a shot's log keeps them in order).
    log.tileRequests?.push([
      Date.now(),
      url.pathname.slice(BLOCKS_TILES_ROUTE.length + 1),
    ]);
    const answer = resolveBlocksTilesPath(
      tilesDir,
      url.pathname.slice(BLOCKS_TILES_ROUTE.length),
    );
    if (answer.filePath)
      return request.respond({
        status: 200,
        contentType: answer.contentType,
        body: readFileSync(answer.filePath),
      });
    return request.respond({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify(answer.json || { error: answer.error }),
    });
  }
  if (live && isLiveRoute(url.pathname)) {
    countRequest(url, log);
    return proxy(request, url, live, log);
  }
  const json = (status, body) =>
    request.respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  if (url.pathname === '/api/raster/values') {
    const query = parseRasterValuesQuery(url.searchParams);
    if (!query.ok) return json(query.status, { error: query.error });
    if (query.layer !== 'ee-elevation')
      return json(404, { error: 'Unknown layer' });
    countRequest(url, log);
    return request.respond({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(rasterValuesBody(query, field)),
    });
  }
  if (url.pathname === '/api/earth-engine/layers')
    return json(200, earthEngineCatalog());
  if (url.pathname === '/api/overpass') {
    // The buildings source's queries (POST data=…): the synthetic town.
    const body = new URLSearchParams(request.postData() || '');
    const answer = overpassAnswer(body.get('data') || '');
    countRequest(url, log);
    log.buildings += answer.elements.length;
    return json(200, answer);
  }
  // The Elevation layer's Blocks style (moded: blocks-<cellM>/<variant>/<ink>).
  const style =
    /^\/api\/earth-engine\/tile\/ee-elevation\/blocks-(\d+)\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)$/.exec(
      url.pathname,
    );
  if (style) {
    countRequest(url, log);
    const [cellM, z, x, y] = style.slice(1).map(Number);
    return request.respond({
      status: 200,
      contentType: 'image/png',
      body: blocksStyleTile(cellM, z, x, y),
    });
  }
  const tile =
    /^\/api\/earth-engine\/tile\/ee-elevation\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)$/.exec(
      url.pathname,
    );
  if (tile) {
    countRequest(url, log);
    return request.respond({
      status: 200,
      contentType: 'image/png',
      body: colourTile(
        Number(tile[1]),
        Number(tile[2]),
        Number(tile[3]),
        field,
      ),
    });
  }
  if (url.pathname.startsWith('/api/')) {
    log.missing.add(url.pathname);
    return json(404, { error: 'Not served by qa-blocks-compare' });
  }
  const found =
    staticFile(dist, url.pathname) || staticFile(dist, '/index.html');
  if (!found) return request.respond({ status: 404, body: '' });
  return request.respond({
    status: 200,
    contentType: found.contentType,
    body: found.body,
  });
}

function argValue(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}

/**
 * --prewarm-check: the Blocks pre-warm's Models (src/app/blocksTiles.js
 * prewarmPrograms), held by the probe at the first Blocks status, must not
 * show: the same frame rendered with them hidden and shown, the pixels
 * that differ counted in a 64 px box at the centre (where they stand, 10 m
 * ahead) and over the whole canvas; both frames kept.
 */
async function prewarmCheck(page, out, name) {
  const found = await page
    .waitForFunction(
      () => {
        const now = window.__gevBlocksProbe?.tiles?.prewarmNow?.();
        return (
          now?.state === 'under way' &&
          now.models.length > 0 &&
          now.models.every((model) => model.ready)
        );
      },
      { timeout: 60_000, polling: 50 },
    )
    .then(() => true)
    .catch(() => false);
  if (!found) {
    await page.evaluate(() => {
      window.__gevBlocksProbe.holdPrewarm = false;
    });
    return { found: false };
  }
  // The scene itself, not the page (the loading splash animates over it):
  // rendered and read back in one task, a 64 px box at the canvas's
  // centre, hidden, shown and hidden again (the scene's own change).
  const result = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    const gl = scene.context._gl;
    const models = window.__gevBlocksProbe.tiles.prewarmNow().models;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const read = (shown) => {
      for (const model of models) model.show = shown;
      scene.render();
      const pixels = new Uint8Array(64 * 64 * 4);
      gl.readPixels(
        Math.floor(w / 2) - 32,
        Math.floor(h / 2) - 32,
        64,
        64,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      return pixels;
    };
    const differ = (a, b) => {
      let n = 0;
      for (let k = 0; k < a.length; k += 4)
        if (
          Math.abs(a[k] - b[k]) > 2 ||
          Math.abs(a[k + 1] - b[k + 1]) > 2 ||
          Math.abs(a[k + 2] - b[k + 2]) > 2
        )
          n++;
      return n;
    };
    const hidden = read(false);
    const shown = read(true);
    const again = read(false);
    // The control: the same Models scaled to 100 m must show.
    for (const model of models) model.scale = 1e5;
    const large = read(true);
    for (const model of models) model.scale = 1;
    for (const model of models) model.show = true;
    let light = 0;
    for (let k = 0; k < hidden.length; k += 4)
      light += hidden[k] + hidden[k + 1] + hidden[k + 2];
    return {
      centre: differ(hidden, shown),
      scene: differ(hidden, again),
      control: differ(hidden, large),
      meanLight: Math.round(light / (hidden.length / 4) / 3),
      models: models.length,
    };
  });
  await page.evaluate(() => {
    window.__gevBlocksProbe.holdPrewarm = false;
  });
  return { found: true, ...result };
}

async function shoot({
  browser,
  dist,
  field,
  out,
  blocks,
  view,
  suffix,
  live = null,
  nav = null,
  viewMode = null,
  prefix = null,
  isolate = false,
  tilesDir = null,
  checkPrewarm = false,
  loadFramesOn = false,
  buildingsOff = false,
  frameEval = null,
}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  // --isolate reads the renderer through the app's QA probe; and
  // --prewarm-check holds the pre-warm's Models through it, and
  // --load-frames reads the status, the tiles' hole and loads.
  if (isolate || (checkPrewarm && blocks) || (loadFramesOn && blocks))
    await page.evaluateOnNewDocument(
      (hold) => {
        window.__gevBlocksProbe = hold ? { holdPrewarm: true } : {};
      },
      Boolean(checkPrewarm && blocks),
    );
  // Third person is kept in this browser (gev.nav.view), not in the link.
  if (viewMode)
    await page.evaluateOnNewDocument((mode) => {
      try {
        localStorage.setItem('gev.nav.view', mode);
      } catch {
        /* no storage */
      }
    }, viewMode);
  const log = {
    values: 0,
    tiles: 0,
    buildings: 0,
    overpass: 0,
    kinds: {},
    live: {},
    missing: new Set(),
    errors: [],
    // The values requests in order, and each status line as it changed.
    started: Date.now(),
    trail: [],
    statusTrail: [],
    tileRequests: [],
  };
  page.on('pageerror', (error) =>
    log.errors.push(String(error?.message || error)),
  );
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    Promise.resolve(
      respond(request, { dist, field, log, live, tilesDir }),
    ).catch((error) => log.errors.push(`respond: ${error?.message || error}`));
  });
  const mode = blocks ? 'blocks' : 'colour';
  const name = prefix ? `${prefix}-${mode}` : `${mode}${suffix}`;
  await page.goto(
    `${ORIGIN}/${pageHash({ blocks, view, nav, buildingsOff })}`,
    {
      waitUntil: 'domcontentloaded',
    },
  );
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 120_000,
  });
  // The Elevation layer on, once the layers are registered.
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers?.has?.('ee-elevation'),
    { timeout: 120_000 },
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('ee-elevation', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => window.__godsEyeView.dataManager.isEnabled('ee-elevation') === true,
    { timeout: 60_000 },
  );
  const prewarm =
    checkPrewarm && blocks ? await prewarmCheck(page, out, name) : null;
  // --load-frames: the page loading at the place (not a flight), shot at
  // SHOT_LOAD_FRAMES_MS from Elevation on, with what the status says then.
  const loadFrames = [];
  if (loadFramesOn && blocks) {
    const from = Date.now();
    // --frame-eval once at the start too, so an experiment that watches
    // every frame (a timeline) starts before the first shot.
    if (frameEval)
      await page.evaluate(`(${frameEval})()`).catch(() => undefined);
    for (const at of SHOT_LOAD_FRAMES_MS) {
      const wait = from + at - Date.now();
      if (wait > 0)
        await page.evaluate(
          (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          wait,
        );
      const frame = path.join(out, `${name}-load-${at / 1000}s.png`);
      await page.screenshot({ path: frame });
      // --frame-eval: a function's source, run in the page at each frame
      // (an experiment on the scene there), its answer kept.
      const probed = frameEval
        ? await page
            .evaluate(`(${frameEval})()`)
            .catch((error) => `failed: ${error?.message || error}`)
        : undefined;
      loadFrames.push({
        at,
        file: frame,
        ...(probed !== undefined ? { probed } : {}),
        ...(await page.evaluate(() => {
          const status = window.__gevBlocksProbe?.controller?.getStatus?.();
          const tiles = window.__gevBlocksProbe?.tiles?.getState?.();
          return {
            status:
              document.querySelector('.lego-render-status')?.textContent || '',
            state: status?.state ?? null,
            pending: status?.pending ?? null,
            tiles: status?.tiles?.mode ?? 'off',
            holeM: status?.tiles?.hole?.radiusM ?? null,
            tilesLoaded: tiles?.tilesLoaded ?? null,
            tileLoads: tiles?.tileLoads ?? null,
            tilesReady: tiles?.tilesReady ?? null,
            tilesSelected: tiles?.tilesSelected ?? null,
            box: status?.tiles?.box ?? null,
            fog: status?.tiles?.fog ?? null,
            // The camera inside a tile (the tiles' own hole about it).
            inside: tiles?.inside ?? null,
            // The shown tileset's selected tiles and the tile top under
            // the camera (Cesium's own, for a far ground missing).
            selected: (() => {
              const scene = window.__godsEyeView?.viewer?.scene;
              const primitives = scene?.primitives;
              let shown = null;
              for (let i = 0; i < (primitives?.length || 0); i++) {
                const each = primitives.get(i);
                if (each?.isCesium3DTileset && each.show) shown = each;
              }
              if (!shown) return null;
              const camera = scene.camera.positionCartographic;
              // sampleHeight's list is of objects to leave out: the
              // others are hidden for the one call instead.
              const hidden = [];
              for (let i = 0; i < primitives.length; i++) {
                const each = primitives.get(i);
                if (each !== shown && each?.show) {
                  each.show = false;
                  hidden.push(each);
                }
              }
              let top = null;
              try {
                top = scene.sampleHeight(camera);
              } catch {
                top = null;
              } finally {
                for (const each of hidden) each.show = true;
              }
              return {
                topM: Number.isFinite(top) ? Math.round(top) : null,
                tiles: (shown._selectedTiles || []).map((tile) => {
                  const uri =
                    tile._contentResource?.url || tile._header?.content?.uri;
                  return `${String(uri || '?')
                    .split('/')
                    .slice(-2)
                    .join('/')
                    .replace(/\?.*$/, '')} ge ${tile.geometricError}`;
                }),
              };
            })(),
            // Where the camera is (a page load may still be settling it).
            camera: (() => {
              const camera = window.__godsEyeView?.viewer?.camera;
              const at = camera?.positionCartographic;
              return at
                ? {
                    heightM: Math.round(at.height),
                    pitchDeg: Math.round((camera.pitch * 180) / Math.PI),
                  }
                : null;
            })(),
          };
        })),
      });
    }
  }
  // The fresh ring's time: from Elevation on (Blocks may start) until the
  // status line says nothing is loading any more.
  const ringStarted = Date.now();
  // Each distinct status line, with the camera's height, as it changes.
  const watch = setInterval(() => {
    page
      .evaluate(() => ({
        text: document.querySelector('.lego-render-status')?.textContent || '',
        heightM: Math.round(
          window.__godsEyeView?.viewer?.camera?.positionCartographic?.height ??
            NaN,
        ),
      }))
      .then(({ text, heightM }) => {
        if (text !== log.statusTrail.at(-1)?.text)
          log.statusTrail.push({ ms: Date.now() - log.started, text, heightM });
      })
      .catch(() => {});
  }, 250);
  if (blocks)
    await page
      .waitForFunction(
        (alt) => {
          const text =
            document.querySelector('.lego-render-status')?.textContent || '';
          // Settled: nothing loading, the buildings counted; or held
          // above the ceiling (a source without levels, high up) once the
          // camera has landed on the view (the page opens at orbit and
          // flies there, and orbit is held too).
          const camera = window.__godsEyeView.viewer.camera;
          const height = camera.positionCartographic.height;
          const landed =
            !camera._currentFlight &&
            Math.abs(height - alt) <= Math.max(100, alt * 0.05);
          return (
            (/ (cubes|cells) /.test(text) &&
              !/loading/.test(text) &&
              !/buildings…/.test(text)) ||
            (landed && /come below/.test(text))
          );
        },
        { timeout: 180_000, polling: 250 },
        view.alt,
      )
      .then(() => (log.ringMs = Date.now() - ringStarted))
      .catch(() => log.errors.push('Blocks did not settle in 3 minutes'));
  // Frames until the globe's tiles are in, then a few more.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const viewer = window.__godsEyeView.viewer;
        let calm = 0;
        let frames = 0;
        const step = () => {
          viewer.scene.requestRender?.();
          calm = viewer.scene.globe.tilesLoaded ? calm + 1 : 0;
          if (calm > 60 || ++frames > 3000) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  const status = await page.evaluate(
    () => document.querySelector('.lego-render-status')?.textContent || '',
  );
  clearInterval(watch);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  // --isolate: the frame again without each kind of chunk (the fine disc,
  // the coarse ring, the rings), to see which draws what.
  if (blocks && isolate)
    for (const kind of ['fine', 'coarse', 'ring']) {
      await page.evaluate((hide) => {
        const collection = window.__gevBlocksProbe?.renderer?.getCollection?.();
        const kindOf = (owner) => {
          const key = owner?.key ?? owner?.build?.keys?.[0] ?? '';
          return /^L/.test(key) ? 'ring' : /^c:/.test(key) ? 'coarse' : 'fine';
        };
        for (const model of collection?._primitives || [])
          model.show = kindOf(model.blocksOwner) !== hide;
        window.__godsEyeView.viewer.scene.requestRender();
      }, kind);
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      );
      await page.screenshot({ path: path.join(out, `${name}-no-${kind}.png`) });
    }
  if (blocks && isolate) {
    await page.evaluate(() => {
      const collection = window.__gevBlocksProbe?.renderer?.getCollection?.();
      for (const model of collection?._primitives || []) model.show = true;
      // And without the block edges and dither: the geometry alone.
      window.__gevBlocksProbe?.renderer?.setStyle?.({
        edges: false,
        dither: false,
      });
      window.__godsEyeView.viewer.scene.requestRender();
    });
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 500)),
    );
    await page.screenshot({ path: path.join(out, `${name}-no-edges.png`) });
    await page.evaluate(() =>
      window.__gevBlocksProbe?.renderer?.setStyle?.({
        edges: true,
        dither: true,
      }),
    );
  }
  // What the shot itself cost, before the harness's own leave-Blocks probe.
  log.tilesAtShot = log.tiles;
  const scene = [await probe(page)];
  if (blocks) {
    // Leave Blocks from the drop-down, the camera still: the globe comes
    // back and the Elevation layer drapes again without a move.
    await page.evaluate(() => {
      const select = document.querySelector('.lego-render-select');
      select.value = 'colour';
      select.dispatchEvent(new Event('change'));
    });
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 3000)),
    );
    scene.push({ after: 'Render: Colour', ...(await probe(page)) });
  }
  log.closedAt = Date.now();
  await context.close();
  return {
    name,
    file,
    status,
    scene,
    ...log,
    missing: [...log.missing],
    ...(prewarm ? { prewarm } : {}),
    ...(loadFrames.length ? { loadFrames } : {}),
  };
}

/**
 * What the page shows now: the globe, the Elevation row's line, the HUD's
 * floor note, and how many imagery layers drape on the globe.
 */
function probe(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const entry = gev.dataManager.layers.get('ee-elevation');
    let row = '';
    try {
      row = entry?.module?.getRowControls?.()?.info || '';
    } catch {
      /* no row */
    }
    return {
      globeShown: gev.viewer.scene.globe.show,
      elevationRow: row,
      floorNote:
        document.getElementById('hud-cam-agl-floor')?.textContent || '',
      // The floor the HUD computes now (its note refreshes only while shown).
      hudFloor: (() => {
        try {
          return gev.styleManager?.hud?.cameraPrecision?.()?.floor?.name || '';
        } catch {
          return '';
        }
      })(),
      hudShown: gev.styleManager?.hud?._visible ?? null,
      // Walk and Fly: the stored view and the MODE line.
      navView: (() => {
        try {
          return localStorage.getItem('gev.nav.view');
        } catch {
          return null;
        }
      })(),
      navLine: document.getElementById('hud-nav')?.textContent || '',
      drapes: gev.viewer.imageryLayers.length,
    };
  });
}

// ── --sequence: location and scope changes in one session ─────────────

/**
 * The steps --sequence flies, in order: what is typed into the location
 * search, and the view flown to by camera if the search does not fly
 * (no geocoder in --build). Names are the frames' (never the query).
 */
export const SEQUENCE_STEPS = Object.freeze([
  {
    name: 'step1-continent',
    query: 'Europe',
    view: { lat: 50, lon: 10, alt: 5_000_000 },
  },
  {
    name: 'step2-country',
    query: 'United States',
    view: { lat: 39.5, lon: -98.35, alt: 5_000_000 },
  },
  {
    name: 'step3-lake',
    query: 'Lake Tahoe, California',
    view: { lat: 39.09, lon: -120.03, alt: 50_000 },
    // The pick at the view's centre lands on the lake.
    pickWater: true,
  },
  {
    name: 'step4-city',
    query: 'Baltimore, Maryland',
    view: { lat: 39.29, lon: -76.61, alt: 20_000 },
  },
  {
    name: 'step5-street',
    // The user's street address: given with --street-query, never kept.
    query: null,
    view: { lat: 39.326, lon: -76.633, alt: 400 },
    pickWater: false,
  },
]);

/** The opening link: a whole-hemisphere view, Blocks and Elevation on. */
export function sequenceHash() {
  const params = new URLSearchParams({
    lat: '30',
    lon: '-40',
    alt: '15000000',
    heading: '0',
    pitch: '-90',
    map: 'blank-black',
    bk: '1',
    lo: 'f.e.1',
    hv: '1',
    hud: 'tactical',
    cs: 'el.u..5000.n',
  });
  return `#${params.toString()}`;
}

/** What --sequence installs in the page before the app loads. */
function sequencePageProbe() {
  window.__gevBlocksProbe = {};
  const qa = { longTasks: [], frames: [], heap: [], events: [] };
  window.__qa = qa;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        qa.longTasks.push([
          performance.timeOrigin + entry.startTime,
          entry.duration,
        ]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* no long-task timing */
  }
  const frame = () => {
    qa.frames.push(Date.now());
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => {
    if (performance.memory)
      qa.heap.push([Date.now(), performance.memory.usedJSHeapSize]);
  }, 500);
  // The shader programs linked: how many, how many are the Blocks shader's
  // (its blocks_inHole), how many distinct, and the main thread's time in
  // linkProgram and in getProgramParameter (where it waits for the link).
  const programs = {
    links: 0,
    blocksLinks: 0,
    linkMs: 0,
    waitMs: 0,
    waits: 0,
    sources: new Set(),
    blocksSources: new Set(),
    byKind: {},
    kindOf: new WeakMap(),
    blocksDefines: new Map(),
    blocksText: new Map(),
  };
  qa.programs = programs;
  for (const Context of [
    window.WebGL2RenderingContext,
    window.WebGLRenderingContext,
  ]) {
    if (!Context) continue;
    const link = Context.prototype.linkProgram;
    const parameter = Context.prototype.getProgramParameter;
    Context.prototype.linkProgram = function (program) {
      let source = '';
      try {
        source = (this.getAttachedShaders(program) || [])
          .map((shader) => this.getShaderSource(shader) || '')
          .join('|');
      } catch {
        source = '';
      }
      // A cheap key for the pair's text: its length and a rolling hash.
      let hash = 0;
      for (let k = 0; k < source.length; k += 7)
        hash = (hash * 31 + source.charCodeAt(k)) | 0;
      const key = `${source.length}:${hash}`;
      const blocks = source.includes('blocks_inHole');
      // What the program draws, by names its source carries.
      const kind = blocks
        ? 'blocks'
        : source.includes('czm_modelMaterial')
          ? 'model'
          : source.includes('u_dayTextureTranslationAndScale') ||
              source.includes('u_initialColor')
            ? 'globe'
            : source.includes('computeAtmosphereColor') ||
                source.includes('czm_skyAtmosphere')
              ? 'atmosphere'
              : source.includes('a_positionHighAndScale') ||
                  source.includes('a_compressedAttribute')
                ? 'billboard'
                : source.includes('colorTexture')
                  ? 'post-process'
                  : 'other';
      const pick = source.includes('czm_pickColor') ? ' pick' : '';
      // A Blocks variant cut by clipping planes (the tiles about the hole).
      const clip =
        blocks && /#define HAS_CLIPPING_PLANES/.test(source) ? ' clip' : '';
      // A Blocks program's defines, to tell its variants apart.
      // --program-sources: each Blocks program's text, to tell variants apart.
      if (blocks && window.__qaProgramSources && !programs.blocksText.has(key))
        programs.blocksText.set(key, source);
      if (blocks && !programs.blocksDefines.has(key))
        programs.blocksDefines.set(
          key,
          [...new Set(source.match(/#define [A-Z_0-9]+/g) || [])]
            .map((line) => line.slice(8))
            .sort(),
        );
      const tag = `${kind}${clip}${pick}`;
      const byKind = (programs.byKind[tag] ||= {
        links: 0,
        sources: new Set(),
        waitMs: 0,
      });
      byKind.links++;
      byKind.sources.add(key);
      programs.kindOf.set(program, tag);
      programs.links++;
      programs.sources.add(key);
      if (blocks) {
        programs.blocksLinks++;
        programs.blocksSources.add(key);
      }
      const start = performance.now();
      const result = link.call(this, program);
      programs.linkMs += performance.now() - start;
      return result;
    };
    Context.prototype.getProgramParameter = function (...args) {
      const start = performance.now();
      const result = parameter.apply(this, args);
      const ms = performance.now() - start;
      programs.waitMs += ms;
      programs.waits++;
      const tag = programs.kindOf.get(args[0]);
      if (tag && programs.byKind[tag]) programs.byKind[tag].waitMs += ms;
      return result;
    };
  }
}

/** Wrap the Blocks renderer and controller, and the camera, to log events. */
function sequenceInstrument() {
  const probe = window.__gevBlocksProbe;
  const ev = window.__qa.events;
  if (!probe?.renderer || !probe?.controller || window.__qa.wired) return false;
  window.__qa.wired = true;
  // What the panel layout's observers would hear (src/ui/
  // panelLayoutController.js): the rails' subtrees and the HUD's classes,
  // counted by target, so a step says which mutations re-ran the layout.
  const mutations = new Map();
  window.__qa.mutations = mutations;
  const where = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const owner = element?.closest?.('[id]');
    const cls = String(element?.className?.baseVal ?? element?.className ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.');
    return `${owner?.id || '?'}${cls ? ` .${cls}` : ''}`;
  };
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      const key = `${record.type}${record.attributeName ? `[${record.attributeName}]` : ''} ${where(record.target)}`;
      mutations.set(key, (mutations.get(key) || 0) + 1);
    }
  });
  for (const id of ['right-context-rail', 'left-panel-stack']) {
    const stack = document.getElementById(id);
    if (stack)
      watch.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'data-variant'],
      });
  }
  const hud = document.getElementById('intel-hud');
  if (hud)
    watch.observe(hud, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'data-variant'],
    });
  const renderer = probe.renderer;
  for (const name of [
    'upsert',
    'remove',
    'setRegion',
    'setRegions',
    'setRingHoles',
    'setVisible',
  ]) {
    const original = renderer[name];
    if (typeof original !== 'function') continue;
    renderer[name] = function (...args) {
      const detail =
        name === 'upsert' || name === 'remove'
          ? String(args[0])
          : name === 'setRegion'
            ? (args[0]?.blockM ?? null)
            : name === 'setRegions'
              ? [...(args[0] instanceof Map ? args[0].values() : args[0] || [])]
                  .map((r) => r?.blockM)
                  .join(',')
              : '';
      ev.push([Date.now(), name, detail]);
      return original.apply(this, args);
    };
  }
  // The precomputed tiles' loads (src/app/blocksTiles.js), when any.
  probe.tiles?.onTileLoad?.(() => ev.push([Date.now(), 'tileLoad']));
  probe.controller.subscribe((st) =>
    ev.push([
      Date.now(),
      'status',
      st.state,
      st.blockM ?? null,
      st.chunks ?? null,
      st.coarse ?? null,
      st.pending ?? null,
    ]),
  );
  const camera = window.__godsEyeView.viewer.camera;
  camera.moveStart.addEventListener(() => ev.push([Date.now(), 'moveStart']));
  camera.moveEnd.addEventListener(() => ev.push([Date.now(), 'moveEnd']));
  let flying = false;
  setInterval(() => {
    const now = Boolean(camera._currentFlight);
    if (now !== flying)
      ev.push([Date.now(), now ? 'flightStart' : 'flightEnd']);
    flying = now;
  }, 50);
  return true;
}

/** What the page shows now: the status line, the HUD's readouts, the camera. */
function sequenceReadout() {
  const gev = window.__godsEyeView;
  // The panel layout's mutations since the last step's readout, top 12.
  const counted = window.__qa?.mutations;
  const mutations = counted
    ? [...counted.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([key, count]) => ({ key, count }))
    : null;
  counted?.clear();
  // The shader programs linked since the last step's readout.
  const linked = window.__qa?.programs;
  const programs = linked
    ? {
        links: linked.links,
        blocksLinks: linked.blocksLinks,
        distinct: linked.sources.size,
        blocksDistinct: linked.blocksSources.size,
        linkMs: Math.round(linked.linkMs),
        waitMs: Math.round(linked.waitMs),
        waits: linked.waits,
        cached:
          gev.viewer?.scene?.context?.shaderCache?.numberOfShaders ?? null,
        blocksDefines: [...linked.blocksDefines.values()],
        ...(linked.blocksText.size
          ? { blocksText: [...linked.blocksText.values()] }
          : {}),
        byKind: Object.fromEntries(
          Object.entries(linked.byKind).map(([tag, held]) => [
            tag,
            {
              links: held.links,
              distinct: held.sources.size,
              waitMs: Math.round(held.waitMs),
            },
          ]),
        ),
      }
    : null;
  if (linked) {
    linked.links = 0;
    linked.blocksLinks = 0;
    linked.linkMs = 0;
    linked.waitMs = 0;
    linked.waits = 0;
    linked.sources.clear();
    linked.blocksSources.clear();
    linked.byKind = {};
    linked.blocksDefines.clear();
    linked.blocksText.clear();
  }
  const carto = gev.viewer.camera.positionCartographic;
  const text = (id) => document.getElementById(id)?.textContent?.trim() || '';
  let floor = '';
  try {
    floor = gev.styleManager?.hud?.cameraPrecision?.()?.floor?.name || '';
  } catch {
    floor = '';
  }
  return {
    status: document.querySelector('.lego-render-status')?.textContent || '',
    heightM: Math.round(carto.height),
    lat: Math.round((carto.latitude * 18000) / Math.PI) / 100,
    lon: Math.round((carto.longitude * 18000) / Math.PI) / 100,
    hud: {
      alt: text('hud-cam-alt'),
      agl: text('hud-cam-agl'),
      px: text('hud-cam-px'),
      floorNote: text('hud-cam-agl-floor'),
      floor,
    },
    globeShown: gev.viewer.scene.globe.show,
    drapes: gev.viewer.imageryLayers.length,
    mutations,
    programs,
    // The precomputed tiles: the controller's plan and what is shown.
    tiles: (() => {
      const probe = window.__gevBlocksProbe;
      const plan = probe?.controller?.getStatus?.()?.tiles;
      const state = probe?.tiles?.getState?.();
      return plan
        ? {
            mode: plan.mode,
            box: plan.box,
            floorM: plan.floorM,
            holeM: plan.hole?.radiusM ?? null,
            tileLoads: state?.tileLoads ?? null,
            tilesLoaded: state?.tilesLoaded ?? null,
            // The cache guard (src/app/blocksTiles.js guardTilesCache).
            heldError: state?.heldError ?? null,
            guardHolds: state?.guardHolds ?? null,
            memoryMB: state?.memoryMB ?? null,
            tileUnloads: state?.tileUnloads ?? null,
            screenError: state?.screenError ?? null,
            tilesSelected: state?.tilesSelected ?? null,
            tilesReady: state?.tilesReady ?? null,
            unloadTrail: state?.unloadTrail ?? null,
          }
        : { mode: 'off' };
    })(),
  };
}

/** The Earth Engine tiles used today, from the catalog (null when not said). */
async function budgetUsed(page) {
  return page.evaluate(async () => {
    try {
      const answer = await fetch('/api/earth-engine/layers', {
        cache: 'no-store',
      });
      const body = await answer.json();
      return Number.isFinite(body?.tiles?.used) ? body.tiles.used : null;
    } catch {
      return null;
    }
  });
}

/** A step's numbers from the page's events and the requests between `from` and `to`. */
export function stepMetrics(
  { events, requests, longTasks, frames, heap },
  from,
  flightEnd,
  to,
) {
  const inStep = (at) => at >= from && at <= to;
  const after = (at) => at >= flightEnd && at <= to;
  const evs = events.filter(([at]) => inStep(at));
  const upserts = evs.filter((e) => e[1] === 'upsert');
  const tileLoads = evs.filter((e) => e[1] === 'tileLoad');
  // The first picture: a live chunk drawn or a tile loaded.
  const firstAfter = [...upserts, ...tileLoads]
    .filter(([at]) => at >= flightEnd)
    .sort((a, b) => a[0] - b[0])[0];
  const statuses = evs.filter((e) => e[1] === 'status');
  const levels = [];
  for (const st of statuses)
    if (Number.isFinite(st[3]) && st[3] !== levels.at(-1)) levels.push(st[3]);
  const reqs = requests.filter(({ at }) => inStep(at));
  const kind = (test) => reqs.filter(({ path }) => test(path)).length;
  const tasks = longTasks.filter(([at]) => after(at));
  const frameTimes = frames.filter((at) => after(at));
  const seconds = Math.max(0.001, (to - flightEnd) / 1000);
  const gaps = frameTimes.slice(1).map((at, n) => at - frameTimes[n]);
  const heapIn = heap.filter(([at]) => inStep(at)).map(([, bytes]) => bytes);
  return {
    firstBlocksMs: firstAfter ? firstAfter[0] - flightEnd : null,
    settledMs: to - flightEnd,
    levels,
    levelChanges: Math.max(0, levels.length - 1),
    upserts: upserts.length,
    tileLoads: tileLoads.length,
    upsertKeys: new Set(upserts.map((e) => e[2])).size,
    removes: evs.filter((e) => e[1] === 'remove').length,
    anchors: statuses.filter((e) => e[2] === 'anchoring').length,
    setRegions: evs.filter((e) => e[1] === 'setRegions' || e[1] === 'setRegion')
      .length,
    ringHoles: evs.filter((e) => e[1] === 'setRingHoles').length,
    flights: evs.filter((e) => e[1] === 'flightStart').length,
    requests: {
      values: kind((path) => path === '/api/raster/values'),
      styleTiles: kind((path) => /\/tile\/ee-elevation\/blocks-/.test(path)),
      elevationTiles: kind(
        (path) =>
          path.startsWith('/api/earth-engine/tile/ee-elevation/') &&
          !/\/blocks-/.test(path),
      ),
      otherTiles: kind(
        (path) =>
          path.startsWith('/api/earth-engine/tile/') &&
          !path.startsWith('/api/earth-engine/tile/ee-elevation/'),
      ),
      overpass: kind((path) => path === '/api/overpass'),
      blocksTiles: kind((path) => path.startsWith('/api/blocks/tiles/')),
      search: kind(
        (path) => path === '/api/geocode' || path.startsWith('/api/google/'),
      ),
      total: reqs.length,
    },
    longTasks: {
      count: tasks.length,
      totalMs: Math.round(tasks.reduce((sum, [, ms]) => sum + ms, 0)),
      maxMs: Math.round(Math.max(0, ...tasks.map(([, ms]) => ms))),
    },
    fps: Math.round((frameTimes.length / seconds) * 10) / 10,
    worstFrameMs: Math.round(Math.max(0, ...gaps)),
    heapMaxMB: heapIn.length
      ? Math.round(Math.max(...heapIn) / 1e5) / 10
      : null,
  };
}

/**
 * A CPU profile's main-thread self time by function (CDP Profiler): the
 * top `limit` as {fn, ms}, and the total sampled.
 */
export function profileSelfTime(profile, limit = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const { samples = [], timeDeltas = [] } = profile;
  for (let n = 0; n < samples.length; n++) {
    const node = byId.get(samples[n]);
    if (!node) continue;
    const frame = node.callFrame;
    const file = String(frame.url || '')
      .split('/')
      .pop()
      .split('?')[0];
    const fn = `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}` : ''}`;
    self.set(fn, (self.get(fn) || 0) + (timeDeltas[n] || 0) / 1000);
  }
  const total = [...self.values()].reduce((sum, ms) => sum + ms, 0);
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
  return { totalMs: Math.round(total), top };
}

/** The DOM reads and layouts the UI layout pass is made of (profile leaves). */
const DOM_LEAVES = new Set([
  'querySelectorAll',
  'querySelector',
  'getBoundingClientRect',
  'getComputedStyle',
  'getPropertyValue',
  'matchMedia',
  'get offsetHeight',
  'get offsetWidth',
  'get clientHeight',
  'get clientWidth',
  'get scrollHeight',
  '(layout)',
  'Layout',
]);

/**
 * Who asks the DOM (CDP profile): the time of samples whose leaf is a DOM
 * read or layout (DOM_LEAVES), by the first three named script frames
 * above it (`fn file:line < caller < its caller`), the top `limit`.
 */
export function profileDomCallers(profile, limit = 15) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes)
    for (const child of node.children || []) parent.set(child, node.id);
  const name = (node) => {
    const frame = node.callFrame;
    const file = String(frame.url || '')
      .split('/')
      .pop()
      .split('?')[0];
    return `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}` : ''}`;
  };
  const chains = new Map();
  let totalMs = 0;
  const { samples = [], timeDeltas = [] } = profile;
  for (let n = 0; n < samples.length; n++) {
    const leaf = byId.get(samples[n]);
    if (!leaf || !DOM_LEAVES.has(leaf.callFrame.functionName)) continue;
    const ms = (timeDeltas[n] || 0) / 1000;
    totalMs += ms;
    const names = [];
    let id = parent.get(leaf.id);
    while (id !== undefined && names.length < 3) {
      const node = byId.get(id);
      if (node.callFrame.url && node.callFrame.functionName)
        names.push(name(node));
      id = parent.get(id);
    }
    const key = `${leaf.callFrame.functionName} ← ${names.join(' < ') || '(none)'}`;
    chains.set(key, (chains.get(key) || 0) + ms);
  }
  const top = [...chains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([chain, ms]) => ({ chain, ms: Math.round(ms) }));
  return { totalMs: Math.round(totalMs), top };
}

/**
 * A sampling heap profile's live bytes by allocation site (the frame that
 * allocated, with its caller): the top `limit` as {site, mb}.
 */
export function heapSites(profile, limit = 20) {
  const sites = new Map();
  const walk = (node, parent) => {
    const frame = node.callFrame;
    const file = String(frame.url || '')
      .split('/')
      .pop()
      .split('?')[0];
    const name = `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}` : ''}`;
    if (node.selfSize) {
      const site = parent ? `${name} ← ${parent}` : name;
      sites.set(site, (sites.get(site) || 0) + node.selfSize);
    }
    for (const child of node.children || []) walk(child, name);
  };
  walk(profile.head, null);
  return [...sites.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([site, bytes]) => ({ site, mb: Math.round(bytes / 1e5) / 10 }));
}

/** What the controller and renderer hold now (the QA probe). */
function sequenceHoldings() {
  const probe = window.__gevBlocksProbe;
  const st = probe?.controller?._state?.();
  const rs = probe?.renderer?.getState?.();
  const ringChunks = st
    ? [...st.rings.values()].reduce((n, ring) => n + ring.chunks.size, 0)
    : null;
  return {
    controller: st
      ? {
          fine: st.chunks.size,
          coarse: st.coarse.size,
          ringChunks,
          rings: [...st.rings.keys()],
          blockM: st.region?.blockM ?? null,
        }
      : null,
    renderer: rs
      ? {
          chunks: rs.chunks,
          batches: rs.batches,
          stats: rs.stats ?? null,
          // Models made and not drawn yet (the Model renderer).
          loadingModels: rs.loadingModels ?? null,
          glbStore: rs.glbStore ?? null,
        }
      : null,
    // The mesh workers: jobs taken back (timeouts) and meshed in-thread.
    meshPool: probe?.meshPool?.() ?? null,
    primitives: window.__godsEyeView?.viewer?.scene?.primitives?.length ?? null,
    imageryLayers: window.__godsEyeView?.viewer?.imageryLayers?.length ?? null,
  };
}

/**
 * The view held still for three seconds, a frame requested on every
 * animation frame: frames drawn a second, scene.render's main-thread ms
 * (median and 95th percentile), the commands the last frame drew and the
 * Blocks Models: the cost of drawing apart from loading. Then a pick at
 * the view's centre and the chunk the renderer names for it (pickedChunk;
 * null before the Model renderer).
 */
async function sequenceStill() {
  const scene = window.__godsEyeView.viewer.scene;
  const probe = window.__gevBlocksProbe;
  const renderMs = [];
  const render = scene.render;
  scene.render = function (...args) {
    const start = performance.now();
    const result = render.apply(this, args);
    renderMs.push(performance.now() - start);
    return result;
  };
  let frames = 0;
  const removeListener = scene.postRender.addEventListener(() => frames++);
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      scene.requestRender();
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve();
    };
    tick();
  });
  removeListener();
  scene.render = render;
  const commands = scene.frameState?.commandList?.length ?? null;
  const sorted = renderMs.slice().sort((a, b) => a - b);
  const quantile = (q) =>
    sorted.length
      ? Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] *
            10,
        ) / 10
      : null;
  const canvas = scene.canvas;
  const picked = scene.pick({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
  });
  const chunk = probe?.renderer?.pickedChunk?.(picked) ?? null;
  return {
    fps: Math.round((frames / 3) * 10) / 10,
    renderMs: { median: quantile(0.5), p95: quantile(0.95) },
    commands,
    blocksModels: probe?.renderer?.getState?.()?.primitives ?? null,
    pick: {
      hit: Boolean(picked),
      chunk,
      drawn: chunk ? probe.renderer.keys().includes(chunk.key) : null,
    },
  };
}

/**
 * --sequence: one page, the steps of SEQUENCE_STEPS in order through the
 * app's location search (else a camera flight to the step's view), each
 * timed from the flight's end to its first blocks and to settled (no chunk
 * upsert for 2 s, nothing loading), with its requests, budget, long tasks,
 * frame rate and heap, and a frame with the HUD.
 */
/**
 * --panels: the panels' rectangles in both rails (each shown panel's id,
 * top, bottom and whether collapsed), with the overlaps between a rail's
 * neighbours and the panels past the viewport's bottom, to see that the
 * rails keep their layout while Blocks flies and when a panel grows.
 */
function sequencePanelRects() {
  const rails = {};
  let overlaps = 0;
  let offscreen = 0;
  for (const id of ['left-panel-stack', 'right-context-rail']) {
    const stack = document.getElementById(id);
    if (!stack) continue;
    const panels = [...stack.querySelectorAll(':scope > [data-panel-id]')]
      .filter((panel) => !panel.hidden && panel.getClientRects().length)
      .map((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          id: panel.id,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          collapsed: panel.classList.contains('collapsed'),
        };
      })
      .sort((a, b) => a.top - b.top);
    for (let k = 1; k < panels.length; k++)
      if (panels[k].top < panels[k - 1].bottom - 1) overlaps++;
    for (const panel of panels)
      if (panel.bottom > window.innerHeight + 1) offscreen++;
    rails[id] = panels;
  }
  return { rails, overlaps, offscreen };
}

/** --panels: open Data Layers and Display (their collapse buttons). */
function sequenceOpenPanels() {
  for (const id of ['data-panel', 'pp-toggles']) {
    const panel = document.getElementById(id);
    if (!panel?.classList.contains('collapsed')) continue;
    document
      .querySelector(`.panel-collapse-btn[data-collapse-target="${id}"]`)
      ?.click();
  }
}

/** --panels: the Elevation row's colour scale opened or closed; whether it was found. */
function sequenceToggleElevationScale() {
  const toggle = document.querySelector(
    '[data-layer-id="ee-elevation"] .data-scale-toggle',
  );
  if (!toggle) return false;
  toggle.click();
  return true;
}

/**
 * The jobs that load the machine enough to skew a run's timings: a unit
 * suite, a tileset or pyramid build, another harness, a vite build. Two
 * --panels runs read Lake Tahoe's long tasks at 10 to 11 s against 2.5 s
 * quiet (2026-10-30), a build or suite unnoticed beside them.
 */
export const CONCURRENT_JOBS = Object.freeze([
  ['unit suite', /run-unit-tests/],
  ['tileset build', /blocks-tileset\.mjs/],
  ['pyramid build', /blocks-pyramid\.mjs/],
  ['another harness', /qa-blocks-compare\.mjs/],
  ['vite build', /vite(\.js)?["']?\s+build/],
]);

/**
 * How long a job is waited for at most (ms), when not the full maxMs: a
 * pyramid warm-up competes on the app server and the CPU only lightly, and
 * runs for hours, so it is waited for 2 minutes, then recorded.
 */
export const CONCURRENT_JOB_WAIT_MS = Object.freeze({
  'pyramid build': 120_000,
});

/**
 * The concurrent jobs in a process list (`pid<space>command line` a line),
 * leaving out this process: their names, each once.
 */
export function concurrentJobs(lines, ownPid = process.pid) {
  const found = new Set();
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === ownPid) continue;
    for (const [name, pattern] of CONCURRENT_JOBS)
      if (pattern.test(match[2])) found.add(name);
  }
  return [...found];
}

/** This machine's node processes as `pid command line` lines. */
function nodeProcessLines() {
  const run =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  return String(run.stdout || '').split(/\r?\n/);
}

/**
 * Wait, up to `maxMs`, until no concurrent job runs; the jobs still
 * running then (the run goes on and its steps say so), else none.
 */
export async function waitQuiet({
  maxMs = 600_000,
  pollMs = 15_000,
  list = nodeProcessLines,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (text) => console.log(text),
  waitCaps = CONCURRENT_JOB_WAIT_MS,
  now = () => Date.now(),
} = {}) {
  const start = now();
  // The jobs still worth waiting for: each up to its own cap.
  const waitingFor = (jobs) =>
    jobs.filter(
      (job) => now() - start < Math.min(maxMs, waitCaps[job] ?? maxMs),
    );
  let jobs = concurrentJobs(list());
  if (jobs.length) log(`waiting for: ${jobs.join(', ')}`);
  while (waitingFor(jobs).length) {
    await sleep(pollMs);
    jobs = concurrentJobs(list());
  }
  if (jobs.length) log(`going on beside: ${jobs.join(', ')}`);
  return jobs;
}

/** --load-frames with --altitudes: the frames' times from the page's load (ms). */
export const SHOT_LOAD_FRAMES_MS = Object.freeze([
  2000, 5000, 10000, 20000, 40000, 80000,
]);

/** --load-frames: the frames' times after a flight's end (ms). */
export const LOAD_FRAMES_MS = Object.freeze([2000, 5000, 10000, 20000]);

/**
 * A Chrome trace's main-thread time by event (the renderer's main thread,
 * complete events): style, layout, paint and compositing beside script, in
 * ms, the top `limit`, with the number of each.
 */
export function traceMainThread(trace, limit = 20) {
  const events = trace?.traceEvents || [];
  const main = new Set(
    events
      .filter(
        (e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain',
      )
      .map((e) => `${e.pid}:${e.tid}`),
  );
  const by = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || !main.has(`${e.pid}:${e.tid}`)) continue;
    const held = by.get(e.name) || { ms: 0, count: 0 };
    held.ms += (e.dur || 0) / 1000;
    held.count++;
    by.set(e.name, held);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([name, { ms, count }]) => ({ name, ms: Math.round(ms), count }));
}

/** --no-blur: every backdrop filter off (to measure the panels' blur). */
function sequenceNoBlur() {
  const add = () => {
    const style = document.createElement('style');
    style.textContent =
      '*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';
    document.head.append(style);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add, { once: true });
}

async function runSequence({
  browser,
  dist,
  live,
  out,
  streetQuery,
  only = null,
  heapChurn = false,
  tilesDir = null,
  panels = false,
  traceStep = null,
  noBlur = false,
  quiet = true,
  programSources = false,
  loadFramesOn = false,
}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(sequencePageProbe);
  if (noBlur) await page.evaluateOnNewDocument(sequenceNoBlur);
  if (programSources)
    await page.evaluateOnNewDocument(() => {
      window.__qaProgramSources = true;
    });
  const log = {
    values: 0,
    tiles: 0,
    buildings: 0,
    overpass: 0,
    kinds: {},
    live: {},
    missing: new Set(),
    errors: [],
    started: Date.now(),
    trail: [],
    statusTrail: [],
    requests: [],
    liveTimes: [],
  };
  // The page's Blocks warnings (a Model or a mesh that failed).
  page.on('console', (message) => {
    const text = message.text();
    if (/\[blocks\]|\[Blocks\]/.test(text))
      log.errors.push(`console ${message.type()}: ${text.slice(0, 300)}`);
  });
  page.on('pageerror', (error) =>
    log.errors.push(String(error?.message || error)),
  );
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.setRequestInterception(true);
  const field = syntheticField();
  page.on('request', (request) => {
    Promise.resolve(
      respond(request, { dist, field, log, live, tilesDir }),
    ).catch((error) => log.errors.push(`respond: ${error?.message || error}`));
  });
  await page.goto(`${ORIGIN}/${sequenceHash()}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers?.has?.('ee-elevation'),
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.isEnabled('ee-elevation'))
      dm.setEnabled('ee-elevation', true, { origin: 'user' });
  });
  await page.waitForFunction(() => window.__gevBlocksProbe?.controller, {
    timeout: 120_000,
  });
  await page.waitForFunction(sequenceInstrument, { timeout: 30_000 });
  // The main thread's CPU and the heap's live allocations, a step at a time.
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('HeapProfiler.enable');
  // --heap-churn: the sampling profile keeps what the collector took too,
  // so its sites are where the heap's peak came from, not what stayed.
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 65_536,
    ...(heapChurn
      ? {
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        }
      : {}),
  });
  // The JS heap and the ArrayBuffers' backing stores apart, every 500 ms:
  // performance.memory gives one number and does not say which.
  const heapPolls = [];
  const heapPoller = setInterval(() => {
    cdp
      .send('Runtime.getHeapUsage')
      .then(({ usedSize, backingStorageSize }) =>
        heapPolls.push([Date.now(), usedSize, backingStorageSize ?? null]),
      )
      .catch(() => {});
  }, 500);
  // The opening view settles before the first step.
  await page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 8000)),
  );
  const wait = (ms) =>
    page.evaluate((t) => new Promise((resolve) => setTimeout(resolve, t)), ms);
  if (panels) {
    await page.evaluate(sequenceOpenPanels);
    await wait(1000);
  }
  const results = [];
  // --steps: only these, in their order (a check of one finding).
  const steps = only
    ? SEQUENCE_STEPS.filter((step) => only.includes(step.name))
    : SEQUENCE_STEPS;
  for (const step of steps) {
    // No step timed beside a build or a suite; one that has to be says so.
    const concurrent = quiet ? await waitQuiet() : [];
    const query = step.query ?? streetQuery;
    const from = Date.now();
    await cdp.send('Profiler.start');
    const budgetBefore = await budgetUsed(page);
    let via = 'search';
    if (query)
      await page.evaluate((q) => {
        const input = document.getElementById('location-search');
        input.value = q;
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      }, query);
    const flew = query
      ? await page
          .waitForFunction(
            () => Boolean(window.__godsEyeView.viewer.camera._currentFlight),
            { timeout: 20_000, polling: 50 },
          )
          .then(() => true)
          .catch(() => false)
      : false;
    if (!flew) {
      via = 'camera';
      await page.evaluate(({ lat, lon, alt }) => {
        const viewer = window.__godsEyeView.viewer;
        const Cesium = window.Cesium;
        const destination =
          viewer.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: (lon * Math.PI) / 180,
            latitude: (lat * Math.PI) / 180,
            height: alt,
          });
        void Cesium;
        viewer.camera.flyTo({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          duration: 3,
        });
      }, step.view);
    }
    // --trace <step>: 4 s of Chrome's own timeline from 1 s into the flight.
    let traced = null;
    if (traceStep === step.name) {
      await wait(1000);
      const traceFile = path.join(out, `${step.name}-trace.json`);
      await page.tracing.start({
        path: traceFile,
        categories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'blink',
          'cc',
          'gpu',
        ],
      });
      await wait(4000);
      await page.tracing.stop();
      traced = traceMainThread(JSON.parse(readFileSync(traceFile, 'utf8')));
    }
    // --panels: the rails mid-flight, Blocks updating its status as it goes.
    let flightPanels = null;
    if (panels) {
      await wait(1500);
      flightPanels = await page.evaluate(sequencePanelRects);
      await page.screenshot({
        path: path.join(out, `${step.name}-flight.png`),
      });
    }
    // The flight's end: the first flight end after this step began, with no
    // flight for 1 s after it (an arrival correction may follow). Taking the
    // last end seen could catch the previous step's before the poller (50 ms)
    // logged this one's.
    const flightEnd = await page
      .waitForFunction(
        (since) => {
          const ev = window.__qa.events;
          if (window.__godsEyeView.viewer.camera._currentFlight) return false;
          const ends = ev.filter((e) => e[1] === 'flightEnd' && e[0] >= since);
          const last = ends.at(-1);
          return last && Date.now() - last[0] > 1000 ? last[0] : false;
        },
        { timeout: 120_000, polling: 100 },
        from,
      )
      .then((handle) => handle.jsonValue())
      .catch(() => Date.now());
    // --load-frames: the view while it loads, 2, 5, 10 and 20 s after the
    // flight's end, each with its status line, the tiles' hole and the mesh
    // pool's counts (a band undrawn between the live chunks and the tiles).
    const loadFrames = [];
    if (loadFramesOn) {
      for (const at of LOAD_FRAMES_MS) {
        const wait = flightEnd + at - Date.now();
        if (wait > 0)
          await page.evaluate(
            (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            wait,
          );
        const file = path.join(out, `${step.name}-load-${at / 1000}s.png`);
        await page.screenshot({ path: file });
        loadFrames.push({
          at,
          file,
          ...(await page.evaluate(() => {
            const probe = window.__gevBlocksProbe;
            const status = probe?.controller?.getStatus?.();
            return {
              status:
                document.querySelector('.lego-render-status')?.textContent ||
                '',
              state: status?.state ?? null,
              chunks: status?.chunks ?? null,
              coarse: status?.coarse ?? null,
              pending: status?.pending ?? null,
              tiles: status?.tiles?.mode ?? 'off',
              holeM: status?.tiles?.hole?.radiusM ?? null,
              meshPool: probe?.meshPool?.() ?? null,
            };
          })),
        });
      }
    }
    // Already drawn at the flight's end: the tiles shown and every one the
    // view wants loaded (in flight, or before the step).
    const tilesAtEnd = await page.evaluate(() => {
      const state = window.__gevBlocksProbe?.tiles?.getState?.();
      return Boolean(state?.shown && state.tilesLoaded);
    });
    // Settled: past the controller's wait to anchor (2 s still, then a
    // tick), no renderer or status event for 2 s, nothing loading,
    // anchoring or flying.
    const settled = await page
      .waitForFunction(
        (end) => {
          if (Date.now() - end < 4500) return false;
          const ev = window.__qa.events;
          const quiet = new Set([
            'upsert',
            'remove',
            'status',
            'setRegion',
            'setRegions',
            'setRingHoles',
            'tileLoad',
          ]);
          const last = ev.filter((e) => quiet.has(e[1])).at(-1)?.[0] ?? 0;
          const text =
            document.querySelector('.lego-render-status')?.textContent || '';
          const tiles = window.__gevBlocksProbe?.tiles?.getState?.();
          const busy =
            /loading|finding|waiting|buildings…/.test(text) ||
            tiles?.tilesLoaded === false;
          return !busy && Date.now() - last > 2000;
        },
        { timeout: 240_000, polling: 250 },
        flightEnd,
      )
      .then(() => true)
      .catch(() => false);
    const qa = await page.evaluate(() => ({
      events: window.__qa.events,
      longTasks: window.__qa.longTasks,
      frames: window.__qa.frames,
      heap: window.__qa.heap,
    }));
    // The last chunk drawn or tile loaded: when the view was whole.
    const lastUpsert =
      qa.events
        .filter(
          (e) =>
            (e[1] === 'upsert' || e[1] === 'tileLoad') && e[0] >= flightEnd,
        )
        .at(-1)?.[0] ?? flightEnd;
    const to = settled ? lastUpsert : Date.now();
    const readout = await page.evaluate(sequenceReadout);
    const { profile } = await cdp.send('Profiler.stop');
    const cpu = {
      ...profileSelfTime(profile),
      dom: profileDomCallers(profile),
    };
    // What stays: after a full collection, the heap and its live sites.
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const { profile: heap } = await cdp.send('HeapProfiler.getSamplingProfile');
    const holdings = await page.evaluate(sequenceHoldings);
    const still = await page.evaluate(sequenceStill);
    // A step that says what its centre is: the pick names a drawn chunk
    // and its water flag.
    if (settled && typeof step.pickWater === 'boolean' && still.pick.chunk)
      still.pick.expected =
        still.pick.drawn && still.pick.chunk.water === step.pickWater;
    const file = path.join(out, `${step.name}.png`);
    await page.screenshot({ path: file });
    // --panels: after the city, a panel's content grows (the Elevation
    // row's colour scale opened) and the rails make room; closed again.
    let grownPanels = null;
    if (panels && step.name === 'step4-city') {
      const before = await page.evaluate(sequencePanelRects);
      const opened = await page.evaluate(sequenceToggleElevationScale);
      await wait(800);
      const after = await page.evaluate(sequencePanelRects);
      await page.screenshot({ path: path.join(out, `${step.name}-grown.png`) });
      if (opened) {
        await page.evaluate(sequenceToggleElevationScale);
        await wait(500);
      }
      grownPanels = { opened, before, after };
    }
    const budgetAfter = await budgetUsed(page);
    const metrics = stepMetrics(
      { ...qa, requests: log.requests },
      from,
      flightEnd,
      to,
    );
    if (metrics.firstBlocksMs === null && tilesAtEnd) metrics.firstBlocksMs = 0;
    results.push({
      name: step.name,
      via,
      settled,
      ...(concurrent.length ? { concurrent } : {}),
      ...(panels
        ? { panels: { flight: flightPanels, grown: grownPanels } }
        : {}),
      ...(traced ? { trace: traced } : {}),
      ...(loadFrames.length ? { loadFrames } : {}),
      flightSeconds: Math.round((flightEnd - from) / 100) / 10,
      ...metrics,
      budget:
        budgetBefore !== null && budgetAfter !== null
          ? budgetAfter - budgetBefore
          : null,
      readout,
      cpu,
      heapAfterGcMB: Math.round(usedSize / 1e5) / 10,
      heapSites: heapSites(heap),
      holdings,
      still,
      // Peaks in the step: the JS heap and the ArrayBuffers' backing stores.
      heapPeaksMB: (() => {
        const inStep = heapPolls.filter(([at]) => at >= from);
        const peak = (k) =>
          inStep.length
            ? Math.round(Math.max(...inStep.map((row) => row[k] ?? 0)) / 1e5) /
              10
            : null;
        return { jsHeap: peak(1), backingStores: peak(2) };
      })(),
      // The live server's answers in the step: values mean ms (a warm cache
      // answers in under a second), and proxied fetches that failed.
      live: (() => {
        const inStep = log.liveTimes.filter(
          ({ at }) => at >= from && at <= Date.now(),
        );
        const values = inStep.filter(
          ({ path: route, status }) =>
            route === '/api/raster/values' && status !== 'failed',
        );
        return {
          values: values.length,
          valuesMeanMs: values.length
            ? Math.round(
                values.reduce((sum, { ms }) => sum + ms, 0) / values.length,
              )
            : null,
          failed: inStep.filter(({ status }) => status === 'failed').length,
        };
      })(),
      valuesByCell: Object.fromEntries(
        Object.entries(
          log.requests
            .filter((r) => r.at >= from && r.at <= to && r.cellM)
            .reduce((acc, r) => {
              const key = `${r.cellM} m × ${r.cells}`;
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {}),
        ),
      ),
      file,
    });
    // A breath between steps, as a person would take.
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 2000)),
    );
  }
  const qa = await page.evaluate(() => ({
    events: window.__qa.events,
    heap: window.__qa.heap,
  }));
  clearInterval(heapPoller);
  await context.close();
  return {
    results,
    events: qa.events,
    requests: log.requests,
    heapMaxMB: qa.heap.length
      ? Math.round(Math.max(...qa.heap.map(([, b]) => b)) / 1e5) / 10
      : null,
    errors: log.errors,
    live: log.live,
  };
}

export async function main(argv = process.argv.slice(2)) {
  // The proxy's fetches to the live server: its own address, not
  // localhost's race, which a busy harness loses (build/loopback.js).
  connectWithoutRace(net);
  const size = /^(\d+)x(\d+)$/.exec(argValue(argv, '--size') || '');
  if (size) [WIDTH, HEIGHT] = [Number(size[1]), Number(size[2])];
  const out = path.resolve(argValue(argv, '--out', ''));
  if (!argValue(argv, '--out'))
    throw new Error('--out <dir outside the repository> is required');
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`))
    throw new Error(`--out must be outside the repository (${ROOT})`);
  mkdirSync(out, { recursive: true });
  let dist = argValue(argv, '--dist');
  if (argv.includes('--build')) {
    dist = path.join(out, 'dist');
    const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const built = spawnSync(
      process.execPath,
      [
        vite,
        'build',
        '--outDir',
        dist,
        '--emptyOutDir',
        // --no-minify: function names survive for --sequence's CPU profiles.
        ...(argv.includes('--no-minify') ? ['--minify', 'false'] : []),
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    if (built.status !== 0)
      throw new Error(`vite build failed (${built.status})`);
  }
  if (!dist || !existsSync(path.join(dist, 'index.html')))
    throw new Error('--dist <a vite build with index.html>, or --build');
  // Real data from a running app server: never started here.
  const live = argValue(argv, '--live')?.replace(/\/+$/, '') || null;
  if (live && !(await liveServerUp(live)))
    throw new Error(
      `--live: no app server answers at ${live} (this script never starts one; start it and run again)`,
    );
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: argValue(argv, '--chrome') || chromeExecutablePath(),
    protocolTimeout: 600_000,
    args: [
      `--window-size=${WIDTH},${HEIGHT}`,
      '--use-angle=d3d11',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  if (argv.includes('--sequence')) {
    try {
      const run = await runSequence({
        browser,
        dist,
        live,
        out,
        streetQuery: argValue(argv, '--street-query'),
        heapChurn: argv.includes('--heap-churn'),
        panels: argv.includes('--panels'),
        traceStep: argValue(argv, '--trace') || null,
        noBlur: argv.includes('--no-blur'),
        // --no-wait: time the steps beside a build or a suite all the same.
        quiet: !argv.includes('--no-wait'),
        // --program-sources: keep each Blocks program's text (large).
        programSources: argv.includes('--program-sources'),
        // --load-frames: each step shot while it loads.
        loadFramesOn: argv.includes('--load-frames'),
        // The precomputed Blocks tilesets served from this folder.
        tilesDir: argValue(argv, '--tiles-dir') || null,
        only:
          argValue(argv, '--steps')
            ?.split(',')
            .map((name) => name.trim())
            .filter(Boolean) ?? null,
      });
      writeFileSync(
        path.join(out, 'sequence.json'),
        `${JSON.stringify(run, null, 2)}\n`,
      );
      for (const step of run.results)
        console.log(
          `${step.name} (${step.via}${step.settled ? '' : ', not settled'}): first blocks ${step.firstBlocksMs} ms, settled ${step.settledMs} ms, levels ${step.levels.join(' → ')}, upserts ${step.upserts}, tiles ${step.readout?.tiles?.mode ?? 'off'}${step.readout?.tiles?.box ? ` ${step.readout.tiles.box} from ${step.readout.tiles.floorM} m${step.readout.tiles.holeM ? `, hole ${Math.round(step.readout.tiles.holeM)} m` : ''}` : ''} (${step.tileLoads} loads, ${step.requests.blocksTiles} requests${step.readout?.tiles?.memoryMB ? `, ${step.readout.tiles.memoryMB} MB` : ''}${step.readout?.tiles?.tileUnloads ? `, ${step.readout.tiles.tileUnloads} unloads` : ''}${step.readout?.tiles?.screenError ? `, ${step.readout.tiles.screenError} px, ${step.readout.tiles.tilesSelected} drawn of ${step.readout.tiles.tilesReady} loaded` : ''}${step.readout?.tiles?.guardHolds ? `, guard ${step.readout.tiles.guardHolds}× at ${Number(step.readout.tiles.heldError ?? 0).toFixed(1)} px` : ''}), anchors ${step.anchors}${step.holdings?.meshPool ? `, mesh jobs ${step.holdings.meshPool.slow ?? 0} slow, ${step.holdings.meshPool.timeouts ?? 0} taken back` : ''}, values ${step.requests.values}, budget ${step.budget}, long tasks ${step.longTasks.count}/${step.longTasks.totalMs} ms, ${step.fps} fps, heap ${step.heapMaxMB} MB (JS ${step.heapPeaksMB?.jsHeap}, buffers ${step.heapPeaksMB?.backingStores}); still ${step.still?.fps} fps, render ${step.still?.renderMs?.median}/${step.still?.renderMs?.p95} ms, ${step.still?.commands} commands, pick ${step.still?.pick?.chunk ? `${step.still.pick.chunk.key}${step.still.pick.chunk.water ? ' water' : ''}` : 'none'}${step.still?.pick?.expected === false ? ' (NOT as expected)' : ''}`,
        );
      console.log(`sequence: ${path.join(out, 'sequence.json')}`);
      return run;
    } finally {
      await browser.close();
    }
  }
  const field = syntheticField();
  const results = [];
  const altitudes = parseAltitudes(argValue(argv, '--altitudes'));
  const shots = altitudes.length
    ? scaleViews(
        altitudes,
        parsePlace(argValue(argv, '--place')),
        parsePitches(argValue(argv, '--pitches')),
      )
    : views(field);
  try {
    if (live && shots.eye) shots.eye.view = await liveEyeView(live);
    const wanted = altitudes.length
      ? Object.keys(shots)
      : String(argValue(argv, '--views', 'judgement,eye'))
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
    // No shot taken beside a build or a suite (--no-wait: all the same).
    if (!argv.includes('--no-wait')) await waitQuiet();
    for (const name of wanted) {
      const shot = shots[name];
      if (!shot) throw new Error(`unknown view ${name} (judgement, eye)`);
      for (const blocks of shot.blocksOnly ? [true] : [false, true])
        results.push(
          await shoot({
            browser,
            dist,
            field,
            out,
            blocks,
            live,
            isolate: argv.includes('--isolate'),
            checkPrewarm: argv.includes('--prewarm-check'),
            loadFramesOn: argv.includes('--load-frames'),
            buildingsOff: argv.includes('--buildings-off'),
            tilesDir: argValue(argv, '--tiles-dir') || null,
            // The function's source, without the statement's semicolon.
            frameEval: argValue(argv, '--frame-eval')
              ? readFileSync(argValue(argv, '--frame-eval'), 'utf8')
                  .trim()
                  .replace(/;$/, '')
              : null,
            ...shot,
          }),
        );
    }
  } finally {
    await browser.close();
  }
  for (const result of results) {
    console.log(`${result.name}: ${result.file}`);
    console.log(`  status line: ${result.status || '(none)'}`);
    for (const frame of result.loadFrames || [])
      console.log(
        `  +${frame.at / 1000}s: ${frame.state}, ${frame.pending ?? '-'} loading, tiles ${frame.tiles}${frame.holeM ? ` hole ${Math.round(frame.holeM)} m` : ''}, ${frame.tileLoads ?? '-'} tile loads${frame.tilesLoaded ? ', all in' : ''}`,
      );
    if (result.prewarm)
      console.log(
        `  pre-warm: ${result.prewarm.found ? `${result.prewarm.models} Models, ${result.prewarm.centre} of 4,096 px differ at the centre shown against hidden (${result.prewarm.scene} hidden against hidden; scaled to 100 m, ${result.prewarm.control}; mean light ${result.prewarm.meanLight})` : 'not caught'}`,
      );
    if (result.name.endsWith('blocks'))
      console.log(
        `  level: ${JSON.stringify(parseBlocksStatus(result.status))}`,
      );
    if (result.ringMs)
      console.log(`  fresh ring: ${(result.ringMs / 1000).toFixed(1)} s`);
    console.log(
      `  values answered: ${result.values}, colour tiles: ${result.tiles} (${result.tilesAtShot} by the shot), Overpass queries: ${result.overpass} (${result.buildings} buildings)`,
    );
    for (const [kind, count] of Object.entries(result.kinds))
      console.log(`    raster values, ${kind}: ${count}`);
    for (const seen of result.scene)
      console.log(`  scene: ${JSON.stringify(seen)}`);
    if (result.missing.length)
      console.log(`  404s: ${result.missing.join(', ')}`);
    for (const [route, stat] of Object.entries(result.live))
      console.log(
        `  live ${route}: ${stat.count} answers ${JSON.stringify(stat.status)}, ${Math.round(stat.ms / Math.max(1, stat.count))} ms each, ${(stat.bytes / 1e6).toFixed(1)} MB`,
      );
    for (const error of result.errors) console.log(`  page error: ${error}`);
    if (result.retried)
      console.log(
        `  live requests asked again after a reset: ${result.retried}`,
      );
    if (result.cutOff)
      console.log(
        `  live requests still out when the shot ended (not errors): ${result.cutOff}`,
      );
  }
  // The run's numbers beside the PNGs.
  const report = {
    at: new Date().toISOString(),
    live,
    views: Object.fromEntries(
      Object.entries(shots).map(([name, shot]) => [name, shot.view]),
    ),
    shots: results.map((result) => ({
      name: result.name,
      file: result.file,
      status: result.status,
      // The level chosen and the chunks, as the status line says them.
      ...(result.name.endsWith('blocks')
        ? { level: parseBlocksStatus(result.status) }
        : {}),
      ringMs: result.ringMs ?? null,
      values: result.values,
      valuesByKind: result.kinds,
      overpass: result.overpass,
      colourTiles: result.tiles,
      colourTilesAtShot: result.tilesAtShot ?? null,
      live: result.live,
      scene: result.scene,
      trail: result.trail,
      statusTrail: result.statusTrail,
      errors: result.errors,
      liveRetried: result.retried || 0,
      liveCutOff: result.cutOff || 0,
      // --load-frames, and each tile asked (ms from the page's start).
      ...(result.loadFrames ? { loadFrames: result.loadFrames } : {}),
      ...(result.tileRequests?.length
        ? {
            tileRequests: result.tileRequests.map(([at, tile]) => [
              at - result.started,
              tile,
            ]),
          }
        : {}),
    })),
  };
  writeFileSync(
    path.join(out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`report: ${path.join(out, 'report.json')}`);
  return results;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
