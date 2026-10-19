// Personal fork: Web Mercator tile maths for the self-hosted HydroSHEDS v2
// rivers. Not part of upstream God's Eye View.

/** Web Mercator's latitude limit. */
export const MAX_LATITUDE = 85.05112877980659;

/** Longitude (degrees) → world x in [0, 1). */
export const worldX = (lon) => (lon + 180) / 360;

/** Latitude (degrees) → world y in [0, 1], north at 0. */
export function worldY(lat) {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

/** World x → longitude. */
export const lonOf = (x) => x * 360 - 180;

/** World y → latitude. */
export const latOf = (y) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Whether z/x/y names a tile. */
export function validTile(z, x, y, maxZoom = 30) {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < 0 || z > maxZoom) return false;
  const limit = 2 ** z;
  return x >= 0 && y >= 0 && x < limit && y < limit;
}

/** A tile's box in world units: {x0, y0, x1, y1}. */
export function tileWorldBox(z, x, y) {
  const size = 1 / 2 ** z;
  return { x0: x * size, y0: y * size, x1: (x + 1) * size, y1: (y + 1) * size };
}

/** A tile's box in degrees: {west, south, east, north}. */
export function tileBounds(z, x, y) {
  const box = tileWorldBox(z, x, y);
  return {
    west: lonOf(box.x0),
    south: latOf(box.y1),
    east: lonOf(box.x1),
    north: latOf(box.y0),
  };
}

/** Whether two world boxes overlap. */
export const boxesOverlap = (a, b) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** A degrees box → a world box. */
export function worldBoxOfBounds({ west, south, east, north }) {
  return {
    x0: worldX(west),
    y0: worldY(north),
    x1: worldX(east),
    y1: worldY(south),
  };
}

/**
 * The cells of zoom `gridZoom` a world box touches: inclusive column and
 * row ranges, clamped to the world.
 */
export function cellRange(box, gridZoom) {
  const n = 2 ** gridZoom;
  const clamp = (value) => Math.max(0, Math.min(n - 1, value));
  return {
    cx0: clamp(Math.floor(box.x0 * n)),
    cy0: clamp(Math.floor(box.y0 * n)),
    cx1: clamp(Math.floor(box.x1 * n)),
    cy1: clamp(Math.floor(box.y1 * n)),
  };
}

/** A cell's key: row-major at its zoom (fits 32 bits to zoom 15). */
export const cellKey = (cx, cy, gridZoom) => cy * 2 ** gridZoom + cx;
