// Personal fork: the level of detail and the style of the self-hosted
// HydroSHEDS v2 rivers (server/providers/riversV2.js). Not part of upstream
// God's Eye View.
import crypto from 'node:crypto';

/**
 * HydroSHEDS v2's reaches carry no discharge, so no v1 RIV_ORD. They do
 * carry UPLAND_SKM, the area upstream, and v1's RIV_ORD is a decade of
 * long-term discharge (1 = over 100,000 m³/s, 2 = 10,000 to 100,000, … ,
 * 6 = 1 to 10, 7 = 0.1 to 1, …). At the world's mean runoff, about
 * 0.01 m³/s per km² (some 315 mm a year), each discharge decade is an area
 * decade: order k ⇔ at least 10^(8−k) km² upstream. So order 2 is a basin
 * of a million km² or more (the Amazon, Mississippi, Paraná, Mackenzie),
 * order 6 at least 100 km², order 8 the smallest v2 streams (1 km², v2's
 * threshold). Wet basins (the Orinoco) rank a step lower than by discharge
 * and dry ones (the Colorado) a step higher; the drawing is the same idea.
 */
export const MIN_ORDER = 1;
export const MAX_ORDER = 8;

/** The v1-equivalent order of a reach from its upstream area in km². */
export function orderForUpland(km2) {
  const area = Number(km2);
  if (!Number.isFinite(area) || area <= 0) return MAX_ORDER;
  const order = Math.ceil(8 - Math.log10(area) - 1e-9);
  return Math.min(MAX_ORDER, Math.max(MIN_ORDER, order));
}

/** The smallest upstream area (km²) an order holds. */
export const minUplandForOrder = (order) => 10 ** (8 - order);

/**
 * Zoom bands: from each zoom, the reaches of order ≤ maxOrder are drawn,
 * from a level simplified to half a pixel at `toleranceZoom` and cut into
 * cells of zoom `gridZoom`. A band keeps the gap between drawn rivers at
 * roughly 5 to 15 pixels (a basin of 10^n km² is about √(10^n) km across).
 * The last band holds every reach, simplified for zoom 12 (half a pixel
 * is 19 m at the equator, under the 30 m of v2's 1″ grid, whose stair
 * steps it smooths) and drawn as is to zoom 14.
 */
export const BANDS = Object.freeze(
  [
    { level: 'z0', minZoom: 0, maxZoom: 2, maxOrder: 3, gridZoom: 2 },
    { level: 'z3', minZoom: 3, maxZoom: 4, maxOrder: 4, gridZoom: 3 },
    { level: 'z5', minZoom: 5, maxZoom: 6, maxOrder: 5, gridZoom: 5 },
    { level: 'z7', minZoom: 7, maxZoom: 8, maxOrder: 6, gridZoom: 7 },
    { level: 'z9', minZoom: 9, maxZoom: 10, maxOrder: 7, gridZoom: 9 },
    {
      level: 'z11',
      minZoom: 11,
      maxZoom: 14,
      maxOrder: 8,
      gridZoom: 11,
      toleranceZoom: 12,
    },
  ].map((band) =>
    Object.freeze({
      ...band,
      toleranceZoom: band.toleranceZoom ?? band.maxZoom,
      minUplandKm2: minUplandForOrder(band.maxOrder),
    }),
  ),
);

export const MIN_ZOOM = 0;
export const MAX_ZOOM = BANDS[BANDS.length - 1].maxZoom;

/** The band a zoom draws from, or null past the last. */
export function bandForZoom(z) {
  return BANDS.find((band) => z >= band.minZoom && z <= band.maxZoom) || null;
}

/** Simplification tolerance: half a pixel at the band's tolerance zoom. */
export const TOLERANCE_PX = 0.5;

/**
 * Quantization bits of a level's coordinates (world units per side):
 * a quarter of a pixel at the deepest zoom it serves, at most 2^28.
 */
export const quantBitsFor = (band) => Math.min(28, band.maxZoom + 8 + 2);

/**
 * NETWORK styling: the line width (px) of an order at a zoom. The smallest
 * order drawn at that zoom is 0.75 px; each order bigger adds 0.55 px, up
 * to 4 px. Under a pixel the line is drawn a pixel wide and fainter.
 */
export function widthFor(order, z) {
  const band = bandForZoom(z) || BANDS[BANDS.length - 1];
  const steps = Math.max(0, band.maxOrder - order);
  return Math.min(4, 0.75 + 0.55 * steps);
}

/** The widest line, for the padding a tile reads around itself. */
export const MAX_WIDTH_PX = 4;

/** The inks: the Rivers layer's light and dark ('rrggbbaa'). */
export const INKS = Object.freeze({
  light: 'ffffffcc',
  dark: '1a1a1acc',
});

/** Bump to invalidate every rendered tile when the renderer changes. */
export const RENDERER_VERSION = 1;

/** What a tile in an ink looks like, as data (hashed into its version). */
export function styleSpec(ink) {
  return {
    renderer: RENDERER_VERSION,
    ink: INKS[ink],
    tileSize: 256,
    bands: BANDS,
    widths: { base: 0.75, step: 0.55, max: 4 },
  };
}

/**
 * A tile version: the hash of the style in an ink and of the data build.
 * The disk cache keeps tiles under it and the client puts it in the URL,
 * so neither a style change nor a rebuild serves an old tile.
 */
export function tileVersion(ink, buildId) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ style: styleSpec(ink), build: String(buildId) }))
    .digest('hex')
    .slice(0, 12);
}
