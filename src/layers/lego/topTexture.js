// Personal fork: photo-textured brick tops for "Photoreal on bricks" far out
// (photoreal.js). Lifting the photoreal mesh onto the bricks reads at city
// scale, but far out Google's triangles grow while the cells don't, and
// most of the frame is stretched "curtains". Beyond AUTO_TEXTURE_HEIGHT_M,
// each brick's top is textured instead with its cell's patch of satellite
// imagery: Esri World Imagery (the imagery the app's map stacks already
// use), its Web Mercator tiles fetched at the zoom that gives about
// TEXELS_PER_CELL texels a cell, stitched into one canvas cropped to the
// Lego window (at most MAX_TEXTURE_SIZE a side).
//
// The pure parts are exported for tests: the tile zoom, the stitching plan
// (which tiles, where each goes, the canvas's mercator extent; a window
// across a tile boundary or the antimeridian), the mercator UV of a point,
// and the switch between lifting and texturing. buildTopTexture does the
// fetching and drawing, async and cancellable.

/** Esri World Imagery's tiles (z/y/x), as src/maps/imagery.js uses them. */
export const ESRI_TILE_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_TOPS_CREDIT_HTML =
  'Brick tops: <a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a> — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const TILE_SIZE = 256;
/** Texels a cell aimed at (4 to 8 is the range asked for). */
export const TEXELS_PER_CELL = 6;
export const MIN_TEXELS_PER_CELL = 4;
/** The stitched canvas is at most this many pixels a side. */
export const MAX_TEXTURE_SIZE = 4096;
/** Esri's deepest level everywhere it has imagery. */
export const MAX_TILE_ZOOM = 18;
/** Tiles fetched at once. */
export const TILE_CONCURRENCY = 6;
/**
 * AUTO textures the tops above this camera height and lifts the tiles
 * below it, with HYSTERESIS either side so a hover there does not flap.
 * From the measured curtains (the share of the frame, bricks drawn): 24%
 * at 2 km, 29% at 20 km, 38% at 50 km; 30% falls at about 22 km.
 */
export const AUTO_TEXTURE_HEIGHT_M = 20_000;
export const AUTO_HYSTERESIS = 0.1;
/** B's modes: AUTO (by height), LIFT (the shader lift), TEXTURE (photo tops). */
export const BRICK_MODES = Object.freeze(['auto', 'lift', 'texture']);
/** The sides in TEXTURE: the layer's colour, or a darkened tint of the top. */
export const SIDE_MODES = Object.freeze(['tint', 'colour']);
/** The tint's darkening. */
export const SIDE_TINT = 0.55;

const MAX_LAT = 85.05112878;

/** Web Mercator x of a longitude, 0 to 1 west to east (unwrapped past 180). */
export const mercX = (lonDeg) => (lonDeg + 180) / 360;

/** Web Mercator y of a latitude, 0 to 1 north to south. */
export function mercY(latDeg) {
  const lat = (Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg)) * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI);
}

/**
 * A window's mercator box: x0 < x1 (x1 past 1 when the window crosses the
 * antimeridian, i.e. west > east), y0 (north) < y1 (south).
 */
export function mercBox({ west, south, east, north }) {
  const x0 = mercX(west);
  let x1 = mercX(east);
  if (east < west) x1 += 1;
  return { x0, x1, y0: mercY(north), y1: mercY(south) };
}

/**
 * The tile zoom for a window of `cells` across: the one whose pixels give
 * the window about `texels` texels a cell, lowered until the window fits
 * `maxSize` pixels a side; within 0 and MAX_TILE_ZOOM.
 */
export function zoomForWindow(
  box,
  cells,
  {
    texels = TEXELS_PER_CELL,
    maxSize = MAX_TEXTURE_SIZE,
    maxZoom = MAX_TILE_ZOOM,
  } = {},
) {
  const m = mercBox(box);
  const width = Math.max(1e-12, m.x1 - m.x0);
  const height = Math.max(1e-12, m.y1 - m.y0);
  const side = Math.max(width, height);
  let zoom = Math.round(
    Math.log2((Math.max(1, cells) * texels) / (side * TILE_SIZE)),
  );
  zoom = Math.max(0, Math.min(maxZoom, zoom));
  while (zoom > 0 && side * TILE_SIZE * 2 ** zoom > maxSize) zoom--;
  return zoom;
}

/**
 * Which tiles to stitch, and where: the canvas is the window's mercator box
 * at `zoom`, in whole pixels; each tile is drawn at (dx, dy) in it. Tile x
 * wraps round the antimeridian; y is clamped to the map.
 * @returns {{zoom: number, width: number, height: number, px0: number,
 *   py0: number, worldPx: number, tiles: {x: number, y: number, dx: number,
 *   dy: number}[], merc: {x0: number, y0: number, w: number, h: number}}}
 */
export function stitchPlan(box, zoom) {
  const m = mercBox(box);
  const worldPx = TILE_SIZE * 2 ** zoom;
  const px0 = Math.floor(m.x0 * worldPx);
  const px1 = Math.max(px0 + 1, Math.ceil(m.x1 * worldPx));
  const py0 = Math.max(0, Math.floor(m.y0 * worldPx));
  const py1 = Math.min(worldPx, Math.max(py0 + 1, Math.ceil(m.y1 * worldPx)));
  const n = 2 ** zoom;
  const tiles = [];
  for (
    let ty = Math.floor(py0 / TILE_SIZE);
    ty <= Math.floor((py1 - 1) / TILE_SIZE);
    ty++
  )
    for (
      let tx = Math.floor(px0 / TILE_SIZE);
      tx <= Math.floor((px1 - 1) / TILE_SIZE);
      tx++
    )
      tiles.push({
        x: ((tx % n) + n) % n,
        y: ty,
        dx: tx * TILE_SIZE - px0,
        dy: ty * TILE_SIZE - py0,
      });
  return {
    zoom,
    width: px1 - px0,
    height: py1 - py0,
    px0,
    py0,
    worldPx,
    tiles,
    // The canvas's extent in mercator units, for the shader's UVs.
    merc: {
      x0: px0 / worldPx,
      y0: py0 / worldPx,
      w: (px1 - px0) / worldPx,
      h: (py1 - py0) / worldPx,
    },
  };
}

/**
 * A point's UV in the stitched canvas (u east, v down from the north
 * edge), as the brick shader computes it; `west` unwraps a longitude for a
 * window across the antimeridian.
 */
export function topUv(lonDeg, latDeg, plan, west = -180) {
  const lon = lonDeg < west ? lonDeg + 360 : lonDeg;
  return {
    u: (mercX(lon) - plan.merc.x0) / plan.merc.w,
    v: (mercY(latDeg) - plan.merc.y0) / plan.merc.h,
  };
}

/** A tile's URL. */
export const tileUrl = (tile, zoom, template = ESRI_TILE_URL) =>
  template
    .replace('{z}', String(zoom))
    .replace('{y}', String(tile.y))
    .replace('{x}', String(tile.x));

/** GPU bytes of a texture (RGBA8, with mipmaps a third more). */
export const textureBytes = (width, height, { mipmaps = true } = {}) =>
  Math.round(width * height * 4 * (mipmaps ? 4 / 3 : 1));

/**
 * The representation B draws now: 'lift' or 'texture'. AUTO follows the
 * camera height with hysteresis about AUTO_TEXTURE_HEIGHT_M (`previous`
 * keeps its side inside the band).
 */
export function brickRepresentation(mode, heightM, previous = 'lift') {
  if (mode === 'lift' || mode === 'texture') return mode;
  const up = AUTO_TEXTURE_HEIGHT_M * (1 + AUTO_HYSTERESIS);
  const down = AUTO_TEXTURE_HEIGHT_M * (1 - AUTO_HYSTERESIS);
  if (!Number.isFinite(heightM)) return previous;
  if (heightM >= up) return 'texture';
  if (heightM <= down) return 'lift';
  return previous === 'texture' ? 'texture' : 'lift';
}

function documentCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function browserTile(url, signal) {
  const response = await fetch(url, { signal, mode: 'cors' });
  if (!response.ok) throw new Error(`tile ${response.status}`);
  return createImageBitmap(await response.blob());
}

/**
 * Fetch and stitch a window's tiles into one canvas. Cancellable: an
 * aborted `signal` stops fetching, and the promise rejects with an
 * AbortError. A tile that fails is left blank (counted in `failed`).
 * @param {{box: object, cells: number, signal?: AbortSignal,
 *   fetchTile?: (url: string, signal?: AbortSignal) => Promise<object>,
 *   createCanvas?: (width: number, height: number) => object,
 *   template?: string, maxSize?: number, texels?: number,
 *   concurrency?: number}} options
 * @returns {Promise<{canvas: object, plan: object, fetched: number,
 *   failed: number, bytes: number, ms: number}>}
 */
export async function buildTopTexture({
  box,
  cells,
  signal,
  fetchTile = browserTile,
  createCanvas = documentCanvas,
  template = ESRI_TILE_URL,
  maxSize = MAX_TEXTURE_SIZE,
  texels = TEXELS_PER_CELL,
  concurrency = TILE_CONCURRENCY,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
}) {
  const started = now();
  const abort = () => {
    const error = new Error('The texture build was cancelled');
    error.name = 'AbortError';
    return error;
  };
  if (signal?.aborted) throw abort();
  const zoom = zoomForWindow(box, cells, { texels, maxSize });
  const plan = stitchPlan(box, zoom);
  const canvas = createCanvas(plan.width, plan.height);
  const context = canvas.getContext('2d');
  let fetched = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < plan.tiles.length) {
      if (signal?.aborted) throw abort();
      const tile = plan.tiles[next++];
      try {
        const image = await fetchTile(tileUrl(tile, zoom, template), signal);
        if (signal?.aborted) throw abort();
        context.drawImage(image, tile.dx, tile.dy, TILE_SIZE, TILE_SIZE);
        image.close?.();
        fetched++;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abort();
        failed++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, plan.tiles.length) }, worker),
  );
  if (signal?.aborted) throw abort();
  return {
    canvas,
    plan,
    fetched,
    failed,
    bytes: textureBytes(plan.width, plan.height),
    ms: Math.round(now() - started),
  };
}
