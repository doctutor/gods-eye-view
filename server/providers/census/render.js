// Personal fork: draws census tract choropleth tiles (256 × 256 RGBA PNG)
// without a canvas library. Not part of upstream God's Eye View.
import zlib from 'node:zlib';
import { createCoverage } from '../riversV2/render.js';
import { COORD_SCALE } from './tractsFile.js';

export const TILE_SIZE = 256;
/** Rows sampled per pixel row: edges are antialiased vertically too. */
const SUB_ROWS = 4;

/** Web Mercator: degrees → pixels of a tile (z, x, y). */
export function tileProjector(z, x, y) {
  const world = TILE_SIZE * 2 ** z;
  return (lonMicro, latMicro) => {
    const lon = lonMicro / COORD_SCALE;
    const lat = Math.max(-85.0511, Math.min(85.0511, latMicro / COORD_SCALE));
    const s = Math.sin((lat * Math.PI) / 180);
    return [
      ((lon + 180) / 360) * world - x * TILE_SIZE,
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world -
        y * TILE_SIZE,
    ];
  };
}

/** A tile's bounds in degrees, with a pixel's margin. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lonOf = (px) => (px / n) * 360 - 180;
  const latOf = (py) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  const margin = 1 / TILE_SIZE;
  return {
    west: lonOf(x - margin),
    east: lonOf(x + 1 + margin),
    north: latOf(y - margin),
    south: latOf(y + 1 + margin),
  };
}

/**
 * The coverage (0 to 1) of one polygon's rings (even-odd) over the tile,
 * into `cover` (Float32Array, TILE_SIZE²), within its pixel box.
 * @returns {boolean} whether any pixel is covered.
 */
export function fillPolygon(rings, cover) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const ring of rings)
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < top) top = ring[i];
      if (ring[i] > bottom) bottom = ring[i];
    }
  const firstRow = Math.max(0, Math.floor(top));
  const lastRow = Math.min(TILE_SIZE - 1, Math.ceil(bottom));
  let any = false;
  const crossings = [];
  for (let row = firstRow; row <= lastRow; row++)
    for (let sub = 0; sub < SUB_ROWS; sub++) {
      const sy = row + (sub + 0.5) / SUB_ROWS;
      crossings.length = 0;
      for (const ring of rings) {
        const n = ring.length;
        for (let i = 0; i < n; i += 2) {
          const x0 = ring[i];
          const y0 = ring[i + 1];
          const j = i + 2 < n ? i + 2 : 0;
          const x1 = ring[j];
          const y1 = ring[j + 1];
          if (y0 <= sy === y1 <= sy) continue;
          crossings.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      const base = row * TILE_SIZE;
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, crossings[k]);
        const to = Math.min(TILE_SIZE, crossings[k + 1]);
        if (to <= from) continue;
        any = true;
        const left = Math.floor(from);
        const right = Math.min(TILE_SIZE - 1, Math.floor(to - 1e-9));
        for (let px = left; px <= right; px++) {
          const span = Math.min(px + 1, to) - Math.max(px, from);
          cover[base + px] += span / SUB_ROWS;
        }
      }
    }
  return any;
}

const hex = (color) => [
  parseInt(color.slice(0, 2), 16),
  parseInt(color.slice(2, 4), 16),
  parseInt(color.slice(4, 6), 16),
  color.length >= 8 ? parseInt(color.slice(6, 8), 16) / 255 : 1,
];

/**
 * A choropleth tile: each tract filled with its colour (RRGGBB[AA], or null
 * for none), source-over in order, then the outlines in `outline` at
 * `outlineWidth` px over all of them.
 * @param {Array<{rings: Array<Float64Array|number[]>, color: string|null}>} tracts
 *   rings in tile pixels.
 */
export function renderChoropleth(
  tracts,
  { outline = '00000040', outlineWidth = 0.6 } = {},
) {
  const size = TILE_SIZE;
  const rgba = new Float32Array(size * size * 4); // premultiplied
  const cover = new Float32Array(size * size);
  let drawn = false;
  for (const tract of tracts) {
    if (!tract.color) continue;
    cover.fill(0);
    if (!fillPolygon(tract.rings, cover)) continue;
    drawn = true;
    const [r, g, b, a] = hex(tract.color);
    for (let i = 0; i < cover.length; i++) {
      const c = Math.min(1, cover[i]);
      if (c <= 0) continue;
      const alpha = a * c;
      const at = i * 4;
      const keep = 1 - alpha;
      rgba[at] = r * alpha + rgba[at] * keep;
      rgba[at + 1] = g * alpha + rgba[at + 1] * keep;
      rgba[at + 2] = b * alpha + rgba[at + 2] * keep;
      rgba[at + 3] = alpha + rgba[at + 3] * keep;
    }
  }
  if (outline && outlineWidth > 0) {
    const lines = createCoverage(size);
    for (const tract of tracts)
      for (const ring of tract.rings) {
        const closed = new Float64Array(ring.length + 2);
        closed.set(ring);
        closed[ring.length] = ring[0];
        closed[ring.length + 1] = ring[1];
        lines.polyline(closed, outlineWidth);
      }
    if (!lines.empty) {
      drawn = true;
      const [r, g, b, a] = hex(outline);
      for (let i = 0; i < lines.values.length; i++) {
        const alpha = a * lines.values[i];
        if (alpha <= 0) continue;
        const at = i * 4;
        const keep = 1 - alpha;
        rgba[at] = r * alpha + rgba[at] * keep;
        rgba[at + 1] = g * alpha + rgba[at + 1] * keep;
        rgba[at + 2] = b * alpha + rgba[at + 2] * keep;
        rgba[at + 3] = alpha + rgba[at + 3] * keep;
      }
    }
  }
  return { rgba, empty: !drawn };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA PNG from a premultiplied float raster. */
export function encodeRgba({ rgba }, size = TILE_SIZE) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = rgba[i + 3];
      if (a <= 0) continue;
      const at = y * stride + 1 + x * 4;
      raw[at] = Math.round(Math.min(255, rgba[i] / a));
      raw[at + 1] = Math.round(Math.min(255, rgba[i + 1] / a));
      raw[at + 2] = Math.round(Math.min(255, rgba[i + 2] / a));
      raw[at + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
