// Personal fork: the translucent fills of the Overture division areas, one
// colour per unit, rasterised into a 256 × 256 RGBA tile. Not part of
// upstream God's Eye View.
import zlib from 'node:zlib';

export const TILE_SIZE = 256;

/**
 * Fill polygons (rings of tile pixels, flat [x, y, …]) by the even-odd rule
 * into `rgba` (TILE_SIZE² × 4), in `colour` [r, g, b] at `alpha` (0–255),
 * pixel centres in or out. A unit drawn over another replaces it there.
 * @returns {number} pixels filled
 */
export function fillPolygons(rgba, polygons, colour, alpha, size = TILE_SIZE) {
  const edges = [];
  for (const rings of polygons)
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const y0 = ring[j * 2 + 1];
        const y1 = ring[i * 2 + 1];
        if (y0 === y1) continue;
        // Skip edges wholly above or below the tile.
        if ((y0 < 0 && y1 < 0) || (y0 >= size && y1 >= size)) continue;
        edges.push(ring[j * 2], y0, ring[i * 2], y1);
      }
    }
  if (!edges.length) return 0;
  let filled = 0;
  const crossings = [];
  for (let py = 0; py < size; py++) {
    const cy = py + 0.5;
    crossings.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const x0 = edges[e];
      const y0 = edges[e + 1];
      const x1 = edges[e + 2];
      const y1 = edges[e + 3];
      if (y0 > cy === y1 > cy) continue;
      crossings.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(size - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let px = from; px <= to; px++) {
        const at = (py * size + px) * 4;
        rgba[at] = colour[0];
        rgba[at + 1] = colour[1];
        rgba[at + 2] = colour[2];
        rgba[at + 3] = alpha;
        filled++;
      }
    }
  }
  return filled;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An RGBA raster (TILE_SIZE² × 4) as a PNG. */
export function encodeRgbaPng(rgba, size = TILE_SIZE) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * stride + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
