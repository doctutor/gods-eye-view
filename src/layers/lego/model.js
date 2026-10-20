// Personal fork: the pure parts of the Lego rendering mode (index.js): brick
// proportions and quantisation, the Lego palette and colour snapping, the
// cell budget for a view window, the columns of a values grid and the card
// a click opens. No Cesium here but the Cartesian3 factory a caller hands in.

/**
 * A classic 2×2 brick (LEGO 3003, the 300323 design): 16 mm square, 9.6 mm
 * tall (0.6 of its width), four studs 4.8 mm across (0.3 of the width) and
 * 1.7 mm high (about 0.1 of it). A raster cell is one brick's footprint.
 */
export const BRICK_HEIGHT_RATIO = 0.6;
export const STUD_DIAMETER_RATIO = 0.3;
export const STUD_HEIGHT_RATIO = 0.1;
/** Non-elevation rasters: the legend range spans this many bricks. */
export const MAX_VALUE_BRICKS = 40;
/** Elevation's exaggeration choices (default 1×). */
export const EXAGGERATIONS = Object.freeze([1, 2, 3, 4, 5]);
/** At most this many columns in a view, and this many cells a side. */
export const COLUMN_BUDGET = 200_000;
export const MAX_CELLS_PER_SIDE = 512;

/**
 * The classic solid Lego colours, as Rebrickable's colour table gives them
 * (https://rebrickable.com/colors/, downloadable as
 * https://cdn.rebrickable.com/media/downloads/colors.csv.gz, read
 * 2026-10-20; `id` is Rebrickable's, `lego` the official name). Light and
 * dark grey are the classic greys (to 2007), not the bluish ones.
 */
const legoColor = (name, lego, id, hex) =>
  Object.freeze({ name, lego, id, hex });
export const LEGO_PALETTE = Object.freeze([
  legoColor('White', 'White', 15, '#ffffff'),
  legoColor('Bright red', 'Bright Red', 4, '#c91a09'),
  legoColor('Bright blue', 'Bright Blue', 1, '#0055bf'),
  legoColor('Bright yellow', 'Bright Yellow', 14, '#f2cd37'),
  legoColor('Black', 'Black', 0, '#05131d'),
  legoColor('Dark green', 'Dark Green', 2, '#237841'),
  legoColor('Light grey', 'Grey', 7, '#9ba19d'),
  legoColor('Dark grey', 'Dark Grey', 8, '#6d6e5c'),
  legoColor('Tan', 'Brick Yellow', 19, '#e4cd9e'),
  legoColor('Orange', 'Bright Orange', 25, '#fe8a18'),
  legoColor('Brown', 'Earth Orange', 6, '#583927'),
  legoColor('Lime', 'Bright Yellowish Green', 27, '#bbe90b'),
  legoColor('Medium blue', 'Medium Blue', 73, '#5a93db'),
  legoColor('Dark red', 'Dark Red', 320, '#720e0f'),
  legoColor('Reddish brown', 'Reddish Brown', 70, '#582a12'),
  legoColor('Sand green', 'Sand Green', 378, '#a0bcac'),
]);

/** '#rrggbb' (or 'rrggbb') as [r, g, b] 0–255. */
export function hexToRgb(hex) {
  const text = String(hex || '').replace(/^#/, '');
  const value = parseInt(text.slice(0, 6).padEnd(6, '0'), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** [r, g, b] 0–255 as '#rrggbb'. */
export function rgbToHex([r, g, b]) {
  return `#${[r, g, b]
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** sRGB → CIE L*a*b* (D65). */
export function rgbToLab([r, g, b]) {
  const linear = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const PALETTE_LAB = LEGO_PALETTE.map((entry) => rgbToLab(hexToRgb(entry.hex)));
const snapCache = new Map();

/** The Lego colour nearest a colour (CIE76 distance in L*a*b*). */
export function snapToLego(hex) {
  const key = String(hex).toLowerCase();
  const hit = snapCache.get(key);
  if (hit) return hit;
  const [L, A, B] = rgbToLab(hexToRgb(key));
  let best = 0;
  let bestDistance = Infinity;
  PALETTE_LAB.forEach(([l, a, b], index) => {
    const distance = (L - l) ** 2 + (A - a) ** 2 + (B - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  const entry = LEGO_PALETTE[best];
  if (snapCache.size > 4096) snapCache.clear();
  snapCache.set(key, entry);
  return entry;
}

/** A brick's height (m) on a cell `cellSizeM` across. */
export function brickHeightM(cellSizeM) {
  return BRICK_HEIGHT_RATIO * Number(cellSizeM);
}

/**
 * Elevation in bricks: the true height (× exaggeration) over the brick
 * height, to the nearest whole brick; nothing at or below sea level.
 */
export function elevationBricks(valueM, cellSizeM, exaggeration = 1) {
  const value = Number(valueM);
  const brick = brickHeightM(cellSizeM);
  if (!Number.isFinite(value) || value <= 0 || !(brick > 0)) return 0;
  return Math.max(0, Math.round((value * Math.max(1, exaggeration)) / brick));
}

/** Where a value sits in a range, 0 to 1, on a linear, sqrt or log scale; NaN if it cannot. */
export function scalePosition(value, min, max, scale = 'linear') {
  const v = Number(value);
  if (!Number.isFinite(v) || !(max > min)) return NaN;
  let t;
  if (scale === 'log') {
    if (!(v > 0) || !(min > 0)) return NaN;
    t = (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min));
  } else if (scale === 'sqrt') {
    t =
      (Math.sqrt(Math.max(0, v)) - Math.sqrt(Math.max(0, min))) /
      (Math.sqrt(max) - Math.sqrt(Math.max(0, min)));
  } else t = (v - min) / (max - min);
  return Math.min(1, Math.max(0, t));
}

/**
 * Any other raster in bricks: its legend range onto 1 to MAX_VALUE_BRICKS
 * (nearest whole brick); nodata and zero are no column.
 */
export function valueBricks(value, legendMin, legendMax, scale = 'linear') {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return 0;
  const t = scalePosition(v, legendMin, legendMax, scale);
  if (!Number.isFinite(t)) return 0;
  return 1 + Math.round(t * (MAX_VALUE_BRICKS - 1));
}

/** A palette's colour at a position 0–1, interpolated between its stops. */
export function paletteColor(palette, t) {
  const stops = (palette || []).map(hexToRgb);
  if (!stops.length || !Number.isFinite(t)) return null;
  if (stops.length === 1) return rgbToHex(stops[0]);
  const scaled = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  return rgbToHex([0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * frac));
}

/**
 * A column's Lego colour: the layer's own ramp at the value, snapped to the
 * palette. `spec` {palette, min, max, scale} (see layerSpecs.js).
 */
export function columnColor(spec, value) {
  const t = scalePosition(value, spec.min, spec.max, spec.scale);
  const color = paletteColor(spec.palette, Number.isFinite(t) ? t : 0);
  return snapToLego(color || '#9ba19d');
}

/**
 * How many cells a window is cut into: native resolution where the budget
 * allows, coarser as the window grows, at most MAX_CELLS_PER_SIDE a side
 * and COLUMN_BUDGET in all.
 * @param {{widthM: number, heightM: number, nativeM?: number,
 *   budget?: number, maxSide?: number}} window
 * @returns {{cols: number, rows: number, cellSizeM: number}}
 */
export function cellsForWindow({
  widthM,
  heightM,
  nativeM = 0,
  budget = COLUMN_BUDGET,
  maxSide = MAX_CELLS_PER_SIDE,
}) {
  const w = Math.max(1, Number(widthM));
  const h = Math.max(1, Number(heightM));
  // The coarsest cell the budget allows, square in metres.
  let cell = Math.max(Math.sqrt((w * h) / budget), w / maxSide, h / maxSide);
  if (nativeM > 0) cell = Math.max(cell, nativeM);
  const cols = Math.max(1, Math.min(maxSide, Math.round(w / cell)));
  const rows = Math.max(1, Math.min(maxSide, Math.round(h / cell)));
  return { cols, rows, cellSizeM: Math.max(w / cols, h / rows) };
}

const EARTH_RADIUS_M = 6_371_000;

/**
 * Lego's window: a square LEGO_WINDOW_FACTOR camera heights across around
 * the point under the middle of the view, at least LEGO_MIN_WINDOW_M. On a
 * 1,600 × 900 canvas (Cesium's 60° field of view across the width) a
 * camera at height h looking straight down sees 1.15 h × 0.65 h of ground;
 * tilted to −45° it sees from 0.49 h before the middle point to 0.96 h past
 * it, 1.27 h to each side at the far edge. A square of 2.5 h (1.25 h each
 * way) holds both; only the far corners of the tilted view fall outside.
 */
export const LEGO_WINDOW_FACTOR = 2.5;
export const LEGO_MIN_WINDOW_M = 10_000;
/** Past this half-side the window is the planet's view (legoWindow returns null). */
const LEGO_WORLD_HALF_M = 5_000_000;

/** The window's half-side in metres for a camera height. */
export const legoHalfM = (heightM) =>
  Math.max(LEGO_MIN_WINDOW_M, LEGO_WINDOW_FACTOR * Number(heightM)) / 2;

/** The window around a point for a camera height, in degrees, or null for a planet-wide view. */
export function legoWindow(lat, lon, heightM) {
  const half = legoHalfM(heightM);
  if (!Number.isFinite(half) || half >= LEGO_WORLD_HALF_M) return null;
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return {
    west: Math.max(-180, lon - dLon),
    south: Math.max(-85, lat - dLat),
    east: Math.min(180, lon + dLon),
    north: Math.min(85, lat + dLat),
  };
}

/**
 * Whether the view has left the one a window was built for: its height
 * doubled or halved, or its middle point past the window's middle half
 * (the Earth Engine overlays' rule, on Lego's window).
 */
export function legoViewMoved(made, now) {
  if (!made) return true;
  if (!Number.isFinite(now.height) || !Number.isFinite(made.height))
    return true;
  const ratio = now.height / made.height;
  if (ratio > 2 || ratio < 0.5) return true;
  const half = legoHalfM(made.height);
  const toRad = Math.PI / 180;
  const dy = (now.lat - made.lat) * toRad * EARTH_RADIUS_M;
  const dx =
    (now.lon - made.lon) * toRad * EARTH_RADIUS_M * Math.cos(made.lat * toRad);
  return Math.max(Math.abs(dx), Math.abs(dy)) > half / 2;
}

/** A lat/lon box's width and height in metres (at its middle latitude). */
export function boxSizeM({ west, south, east, north }) {
  const toRad = Math.PI / 180;
  const midLat = ((south + north) / 2) * toRad;
  const span = ((east - west + 360) % 360 || 360) * (east === west ? 0 : 1);
  return {
    widthM: EARTH_RADIUS_M * Math.cos(midLat) * span * toRad,
    heightM: EARTH_RADIUS_M * (north - south) * toRad,
  };
}

/**
 * The columns of a values grid: one per cell with at least one brick.
 * `base` (optional) is the elevation grid of the same window and cells: on
 * photoreal or terrain each column stands on the ground height of its cell.
 * @param {{header: object, values: Float32Array}} grid
 * @param {{spec: object, elevation?: boolean, exaggeration?: number,
 *   base?: {values: Float32Array}|null}} options
 * @returns {Array<{index: number, col: number, row: number, west: number,
 *   south: number, east: number, north: number, bricks: number,
 *   value: number, baseM: number, color: object}>}
 */
export function gridColumns(
  grid,
  { spec, elevation = false, exaggeration = 1, base = null },
) {
  const { header, values } = grid;
  const { cols, rows, west, south, east, north } = header;
  const cellSizeM = Number(header.cellSizeM);
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;
  const columns = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const value = values[index];
      const bricks = elevation
        ? elevationBricks(value, cellSizeM, exaggeration)
        : valueBricks(value, header.legendMin, header.legendMax, spec.scale);
      if (!bricks) continue;
      const baseValue = base?.values?.[index];
      columns.push({
        index,
        col,
        row,
        west: west + col * dLon,
        east: west + (col + 1) * dLon,
        north: north - row * dLat,
        south: north - (row + 1) * dLat,
        bricks,
        value,
        // Elevation's own column is the height: it always rises from the
        // ellipsoid. Any other stands on its cell's ground height.
        baseM: !elevation && Number.isFinite(baseValue) ? baseValue : 0,
        color: columnColor(spec, value),
      });
    }
  }
  return columns;
}

/** A value in the layer's units for the card: 2–4 significant figures. */
export function formatValue(value, units = '') {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const text =
    abs >= 1000
      ? Math.round(v).toLocaleString('en-US')
      : abs >= 10
        ? String(Math.round(v * 10) / 10)
        : String(Math.round(v * 100) / 100);
  return units ? `${text} ${units}` : text;
}

/** A coordinate pair for the card: 4 decimals, hemisphere letters. */
export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

/**
 * The card beside a clicked column (a world-overlay 'card' entry).
 * @param {{column: object, header: object, title: string, details: string[],
 *   cesium: object, topM: number}} input - `topM`: the column top's height,
 *   where the card stands.
 */
export function columnCardEntry({ column, title, details, cesium, topM = 0 }) {
  const lon = (column.west + column.east) / 2;
  const lat = (column.south + column.north) / 2;
  return {
    id: 'lego-card',
    variant: 'card',
    position: cesium.Cartesian3.fromDegrees(lon, lat, topM),
    title,
    details,
    accent: column.color.hex,
    priority: 1000,
    protected: true,
    collisionGroup: 'lego-card',
    interactive: false,
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    placement: 'above',
    accessibilityLabel: `${title}: ${details.join(', ')}`,
  };
}
