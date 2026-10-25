// Personal fork: the record format of the Overture division areas build
// (scripts/overture/areas.mjs), and what the server
// (server/providers/overtureAreas.js) does with a record. Not part of
// upstream God's Eye View.

/** The subtypes kept, from the country down to the county. */
export const AREA_SUBTYPES = Object.freeze([
  'country',
  'dependency',
  'region',
  'county',
]);
/** The index's deepest zoom (a z 10 cell is about 39 km at the equator). */
export const AREA_INDEX_MAX_ZOOM = 10;

/** An unsigned varint onto an array of bytes. */
export function writeVarint(bytes, value) {
  let n = value;
  while (n >= 0x80) {
    bytes.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  bytes.push(n);
}

/**
 * One level of a unit's record: polygons of rings, each ring the quantized
 * [x, y, …] (absolute, world units × 2^bits).
 * @param {Buffer|Uint8Array} bytes
 * @returns {Int32Array[][]}
 */
export function decodeAreaRecord(bytes) {
  let pos = 0;
  const read = () => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = bytes[pos++];
      value += (byte & 0x7f) * shift;
      if (byte < 0x80) return value;
      shift *= 0x80;
    }
  };
  const unzig = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const polygons = [];
  const count = read();
  for (let p = 0; p < count; p++) {
    const rings = [];
    const ringCount = read();
    for (let r = 0; r < ringCount; r++) {
      const points = read();
      const ring = new Int32Array(points * 2);
      let x = 0;
      let y = 0;
      for (let k = 0; k < points; k++) {
        x += unzig(read());
        y += unzig(read());
        ring[k * 2] = x;
        ring[k * 2 + 1] = y;
      }
      rings.push(ring);
    }
    polygons.push(rings);
  }
  return polygons;
}

/** Whether a ring (flat [x, y, …]) holds a point, by the even-odd rule. */
function ringHolds(ring, x, y) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Whether decoded polygons hold a point (in their units): in an outer ring and none of its holes. */
export function polygonsHold(polygons, x, y) {
  for (const [outer, ...holes] of polygons)
    if (
      outer &&
      ringHolds(outer, x, y) &&
      !holes.some((h) => ringHolds(h, x, y))
    )
      return true;
  return false;
}

/** FNV-1a of a string: a unit keeps its colour across builds. */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
