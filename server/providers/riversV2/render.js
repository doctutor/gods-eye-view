// Personal fork: draws the self-hosted HydroSHEDS v2 rivers into 256 × 256
// PNG tiles, without a canvas library. Not part of upstream God's Eye View.
import zlib from 'node:zlib';

export const TILE_SIZE = 256;

/**
 * A coverage raster: each pixel keeps the largest coverage (0 to 1) any
 * line gives it, so joints and overlapping reaches do not darken. Lines
 * are capsules (round caps and joins), antialiased over a pixel.
 */
export function createCoverage(size = TILE_SIZE) {
  const values = new Float32Array(size * size);
  let touched = false;
  /** Max-composite one segment of a line `width` px wide. */
  function segment(x0, y0, x1, y1, width) {
    const radius = Math.max(1, width) / 2;
    const strength = Math.min(1, width);
    const reach = radius + 1;
    if (
      Math.max(x0, x1) < -reach ||
      Math.max(y0, y1) < -reach ||
      Math.min(x0, x1) > size + reach ||
      Math.min(y0, y1) > size + reach
    )
      return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;
    const left = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
    const right = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + reach));
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
    const bottom = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + reach));
    for (let py = top; py <= bottom; py++) {
      const cy = py + 0.5;
      const row = py * size;
      for (let px = left; px <= right; px++) {
        const cx = px + 0.5;
        let t =
          lengthSquared > 0
            ? ((cx - x0) * dx + (cy - y0) * dy) / lengthSquared
            : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = cx - (x0 + t * dx);
        const ey = cy - (y0 + t * dy);
        const distance = Math.sqrt(ex * ex + ey * ey);
        let cover = radius + 0.5 - distance;
        if (cover <= 0) continue;
        if (cover > 1) cover = 1;
        cover *= strength;
        if (cover > values[row + px]) {
          values[row + px] = cover;
          touched = true;
        }
      }
    }
  }
  return {
    size,
    values,
    get empty() {
      return !touched;
    },
    /**
     * A polyline in tile pixels; long segments are cut into pieces of at
     * most 8 px so each one's box stays small.
     */
    polyline(points, width) {
      for (let index = 2; index < points.length; index += 2) {
        const x0 = points[index - 2];
        const y0 = points[index - 1];
        const x1 = points[index];
        const y1 = points[index + 1];
        const length = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(length / 8));
        for (let step = 0; step < steps; step++)
          segment(
            x0 + ((x1 - x0) * step) / steps,
            y0 + ((y1 - y0) * step) / steps,
            x0 + ((x1 - x0) * (step + 1)) / steps,
            y0 + ((y1 - y0) * (step + 1)) / steps,
            width,
          );
      }
    },
  };
}

/** 'rrggbbaa' → [r, g, b, a]. */
export function parseInk(hex) {
  const match = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    String(hex),
  );
  if (!match) throw new Error(`bad ink ${hex}`);
  return match.slice(1).map((part) => parseInt(part, 16));
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

/**
 * A PNG of a coverage raster in one ink: gray + alpha when the ink is a
 * gray (both of the Rivers layer's are), RGBA otherwise; alpha is the
 * ink's alpha times the coverage.
 */
export function encodePng(coverage, ink) {
  const [r, g, b, a] = parseInk(ink);
  const gray = r === g && g === b;
  const channels = gray ? 2 : 4;
  const { size, values } = coverage;
  const stride = size * channels + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const cover = values[y * size + x];
      if (cover <= 0) continue;
      const alpha = Math.round(a * cover);
      const at = row + 1 + x * channels;
      if (gray) {
        raw[at] = r;
        raw[at + 1] = alpha;
      } else {
        raw[at] = r;
        raw[at + 1] = g;
        raw[at + 2] = b;
        raw[at + 3] = alpha;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = gray ? 4 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A fully transparent tile, made once. */
export const EMPTY_PNG = encodePng(createCoverage(), '00000000');
