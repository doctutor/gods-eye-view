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
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  M_PER_DEG,
  encodeRasterValues,
  parseRasterValuesQuery,
  valueRange,
  windowGrid,
} from '../src/data/rasterValues.js';
import { encodeLayerStateParams } from '../src/data/layerState.js';
import { EARTH_ENGINE_LAYERS } from '../src/data/earthEngineLayers.js';
import { chromeExecutablePath } from './qa-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'http://gev-blocks.test';
export const VIEW = Object.freeze({
  lat: 39.3214,
  lon: -76.6292,
  alt: 300,
  heading: 0,
  pitch: -30,
});
const WIDTH = 1600;
const HEIGHT = 900;

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
  };
}

/**
 * The link: the view, the blank black map, no layer from the link's layer
 * list (Earth Engine layers are not in it: the page turns Elevation on),
 * the Elevation layer's colour scale PET 0–100 m; Blocks with bk=1.
 */
export function pageHash({ blocks, view = VIEW }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(view))
    params.set(key, String(value));
  params.set('map', 'blank-black');
  encodeLayerStateParams(params, { enabledLayerIds: [], options: {} });
  // The Elevation layer's colour scale: PET rainbow, 0 to 100 m, linear.
  params.set('cs', 'el.r.0.100.n');
  if (blocks) params.set('bk', '1');
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

/** Answer one intercepted request. */
function respond(request, { dist, field, log }) {
  const url = new URL(request.url());
  if (url.origin !== ORIGIN) return request.abort('blockedbyclient');
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
    log.values++;
    // By kind: the cells asked and the ground they cover (a probe, a
    // fine group at 1 m, a coarse supergroup at 4 m).
    const { box } = query;
    const lat = ((box.south + box.north) / 2) * (Math.PI / 180);
    const spanM = (box.east - box.west) * M_PER_DEG * Math.cos(lat);
    const kind = `${query.cells} cells over ${Math.round(spanM)} m`;
    log.kinds[kind] = (log.kinds[kind] || 0) + 1;
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
    log.overpass++;
    log.buildings += answer.elements.length;
    return json(200, answer);
  }
  const tile =
    /^\/api\/earth-engine\/tile\/ee-elevation\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)$/.exec(
      url.pathname,
    );
  if (tile) {
    log.tiles++;
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

async function shoot({ browser, dist, field, out, blocks, view, suffix }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const log = {
    values: 0,
    tiles: 0,
    buildings: 0,
    overpass: 0,
    kinds: {},
    missing: new Set(),
    errors: [],
  };
  page.on('pageerror', (error) =>
    log.errors.push(String(error?.message || error)),
  );
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    Promise.resolve(respond(request, { dist, field, log })).catch((error) =>
      log.errors.push(`respond: ${error?.message || error}`),
    );
  });
  const name = `${blocks ? 'blocks' : 'colour'}${suffix}`;
  await page.goto(`${ORIGIN}/${pageHash({ blocks, view })}`, {
    waitUntil: 'domcontentloaded',
  });
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
  // The fresh ring's time: from Elevation on (Blocks may start) until the
  // status line says nothing is loading any more.
  const ringStarted = Date.now();
  if (blocks)
    await page
      .waitForFunction(
        () => {
          const text =
            document.querySelector('.lego-render-status')?.textContent || '';
          return / cubes /.test(text) && !/loading/.test(text);
        },
        { timeout: 180_000, polling: 250 },
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
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
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
  await context.close();
  return { name, file, status, scene, ...log, missing: [...log.missing] };
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
      drapes: gev.viewer.imageryLayers.length,
    };
  });
}

export async function main(argv = process.argv.slice(2)) {
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
      [vite, 'build', '--outDir', dist, '--emptyOutDir'],
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
  const field = syntheticField();
  const results = [];
  try {
    const shots = views(field);
    const wanted = String(argValue(argv, '--views', 'judgement,eye'))
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of wanted) {
      const shot = shots[name];
      if (!shot) throw new Error(`unknown view ${name} (judgement, eye)`);
      for (const blocks of [false, true])
        results.push(
          await shoot({ browser, dist, field, out, blocks, ...shot }),
        );
    }
  } finally {
    await browser.close();
  }
  for (const result of results) {
    console.log(`${result.name}: ${result.file}`);
    console.log(`  status line: ${result.status || '(none)'}`);
    if (result.ringMs)
      console.log(`  fresh ring: ${(result.ringMs / 1000).toFixed(1)} s`);
    console.log(
      `  values answered: ${result.values}, colour tiles: ${result.tiles}, Overpass queries: ${result.overpass} (${result.buildings} buildings)`,
    );
    for (const [kind, count] of Object.entries(result.kinds))
      console.log(`    raster values, ${kind}: ${count}`);
    for (const seen of result.scene)
      console.log(`  scene: ${JSON.stringify(seen)}`);
    if (result.missing.length)
      console.log(`  404s: ${result.missing.join(', ')}`);
    for (const error of result.errors) console.log(`  page error: ${error}`);
  }
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
