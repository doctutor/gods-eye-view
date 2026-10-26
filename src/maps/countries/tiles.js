// Personal fork: the Countries basemap painted on imagery tiles. A tile is a
// 256 × 256 canvas in the geographic tiling (every longitude, both poles):
// the country fills (one path per colour, holes cut by the even-odd rule) at
// the basemap's opacity, then their outlines; the subdivisions style adds the
// first-level units' outlines on tiles fine enough; the hex style paints the
// H3 cells of the resolution its tile level stands for. Pure: no Cesium, the
// canvas context is passed in, so tests paint on a recording context.
//
// Levels and heights. A level-z tile pixel is 180 / (256 · 2^z) degrees,
// 78.3 km / 2^z at the equator; with the camera's height / 700 metres a
// pixel looking down (maps/h3Resolution.js), a level stands for a camera
// height of 54,800 km / 2^z. The subdivisions ceiling (5,000 km) becomes a
// level that way. The hex style paints the resolution of the camera height
// (h3ResolutionForHeight) on every tile, so one size of hex fills the
// screen whatever level each tile is.

import {
  cellToLatLng,
  getHexagonEdgeLengthAvg,
  latLngToCell,
  polygonToCells,
} from 'h3-js';
import { allCells, cellRing } from '../h3Cells.js';
import { h3ResolutionForHeight } from '../h3Resolution.js';
import { SUBDIVISIONS_MAX_HEIGHT_M } from './catalog.js';
import { featureAt, featureContains, partsInRectangle } from './geometry.js';
import { COUNTRY_THEMES, fillFor } from './palette.js';

export const TILE_SIZE = 256;
/** Past this the tiles are magnified: the 10m packs hold nothing finer. */
export const MAXIMUM_LEVEL = 12;
/** A tile on which the hexes would be narrower than this (px) paints the countries instead. */
export const MIN_HEX_PX = 8;
/** The camera height (m) a level-0 tile's pixel matches. */
export const LEVEL0_HEIGHT_M = 54_800_000;

/** The camera height a tile level stands for, metres. */
export const levelHeightM = (level) => LEVEL0_HEIGHT_M / 2 ** level;

/** Whether a level's tiles paint the first-level units (subdivisions style). */
export const subdivisionsAtLevel = (level) =>
  levelHeightM(level) < SUBDIVISIONS_MAX_HEIGHT_M;

/** The H3 resolution a level's tiles paint (hex style). */
export const hexResolutionForLevel = (level) =>
  h3ResolutionForHeight(levelHeightM(level));

/** An "#rrggbb" colour at an alpha, as CSS. */
export function withAlpha(css, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(css));
  if (!hex) return css;
  const n = parseInt(hex[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Add rings to the context's path in a tile's pixels, each shifted by
 * whole turns of longitude to reach the tile (a hex ring runs on past
 * ±180); points under half a pixel apart add nothing. Whether any ring
 * has an area there.
 */
function traceRings(context, rings, rect, size) {
  const sx = size / (rect.east - rect.west);
  const sy = size / (rect.north - rect.south);
  let any = false;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let west = Infinity;
    let east = -Infinity;
    for (const [lon] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
    for (const shift of [0, -360, 360]) {
      if (east + shift < rect.west || west + shift > rect.east) continue;
      let lastX = NaN;
      let lastY = NaN;
      let count = 0;
      for (const [lon, lat] of ring) {
        const x = (lon + shift - rect.west) * sx;
        const y = (rect.north - lat) * sy;
        if (count && Math.abs(x - lastX) < 0.5 && Math.abs(y - lastY) < 0.5)
          continue;
        if (count) context.lineTo(x, y);
        else context.moveTo(x, y);
        lastX = x;
        lastY = y;
        count++;
      }
      if (count >= 3) {
        context.closePath();
        any = true;
      }
    }
  }
  return any;
}

/** Fill groups of rings by colour, then stroke the outlines over them. */
function paintGroups(context, groups, rect, size) {
  let painted = 0;
  for (const [style, rings] of groups) {
    context.beginPath();
    if (!traceRings(context, rings, rect, size)) continue;
    context.fillStyle = style;
    context.fill('evenodd');
    painted++;
  }
  return painted;
}

/**
 * An edge Natural Earth adds where it cuts a ring (along ±180°, or along a
 * pole): no border, so no outline.
 */
const SEAM = 179.9999;
export const seamEdge = ([lonA, latA], [lonB, latB]) =>
  (Math.abs(lonA) >= SEAM && Math.abs(lonB) >= SEAM && lonA === lonB) ||
  (Math.abs(latA) >= 89.9999 && latA === latB);

/**
 * Add rings to the path as open outlines, broken at their seam edges, each
 * shifted by whole turns of longitude as in traceRings; whether any was
 * added.
 */
function traceOutlines(context, rings, rect, size) {
  const sx = size / (rect.east - rect.west);
  const sy = size / (rect.north - rect.south);
  let any = false;
  for (const ring of rings) {
    if (ring.length < 2) continue;
    let west = Infinity;
    let east = -Infinity;
    for (const [lon] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
    for (const shift of [0, -360, 360]) {
      if (east + shift < rect.west || west + shift > rect.east) continue;
      let lastX = NaN;
      let lastY = NaN;
      let drawing = false;
      for (let i = 0; i <= ring.length; i++) {
        const point = ring[i % ring.length];
        const x = (point[0] + shift - rect.west) * sx;
        const y = (rect.north - point[1]) * sy;
        const seam = i > 0 && seamEdge(ring[i - 1], point);
        if (!drawing || seam) {
          context.moveTo(x, y);
          drawing = true;
        } else if (
          Math.abs(x - lastX) >= 0.5 ||
          Math.abs(y - lastY) >= 0.5 ||
          i === ring.length
        ) {
          context.lineTo(x, y);
          any = true;
        } else continue;
        lastX = x;
        lastY = y;
      }
    }
  }
  return any;
}

function strokeRings(context, rings, rect, size, colour, width) {
  if (!rings.length || !(width > 0)) return false;
  context.beginPath();
  if (!traceOutlines(context, rings, rect, size)) return false;
  context.lineWidth = width;
  context.lineJoin = 'round';
  context.strokeStyle = colour;
  context.stroke();
  return true;
}

/**
 * Paint the simple or subdivisions style on a tile.
 * @param {CanvasRenderingContext2D} context
 * @param {{ features: object[], units?: object[] | null, rect: object,
 *   level: number, theme: 'dark' | 'light', style: string, opacity: number,
 *   size?: number, outline?: boolean }} options `rect` the tile in degrees;
 *   `outline` false leaves the country outlines off.
 * @returns {number} the parts painted
 */
export function paintCountriesTile(
  context,
  {
    features,
    units = null,
    rect,
    level,
    theme,
    style,
    opacity,
    size = TILE_SIZE,
    outline = true,
  },
) {
  const colours = COUNTRY_THEMES[theme] || COUNTRY_THEMES.dark;
  const parts = partsInRectangle(features, rect);
  if (!parts.length) return 0;
  const groups = new Map();
  const outlines = [];
  for (const { feature, polygon } of parts) {
    const fill = withAlpha(fillFor(feature, { theme, style }), opacity);
    if (!groups.has(fill)) groups.set(fill, []);
    groups.get(fill).push(polygon.outer, ...polygon.holes);
    outlines.push(polygon.outer);
  }
  if (opacity > 0) paintGroups(context, groups, rect, size);
  if (units && style === 'subdivisions' && subdivisionsAtLevel(level))
    strokeRings(
      context,
      partsInRectangle(units, rect).map(({ polygon }) => polygon.outer),
      rect,
      size,
      colours.admin1Outline,
      colours.admin1OutlineWidth,
    );
  if (outline)
    strokeRings(
      context,
      outlines,
      rect,
      size,
      colours.outline,
      colours.outlineWidth,
    );
  return parts.length;
}

/**
 * The land cells of the hex style at one resolution, shared by every tile:
 * a cell is land when its centre is in a country (the first in pack order),
 * and every country too small to hold a centre gets the cell of a point of
 * its own, so Iceland is there from orbit and Monaco nearer in.
 */
export function createHexLand(features) {
  const cellFeature = new Map(); // cell → feature | null
  const extras = new Map(); // res → Map(cell → feature)
  const rings = new Map(); // cell → its boundary, for every tile it crosses

  function ringOf(cell) {
    let ring = rings.get(cell);
    if (!ring) rings.set(cell, (ring = cellRing(cell)));
    return ring;
  }

  function landOf(cell) {
    if (cellFeature.has(cell)) return cellFeature.get(cell);
    const [lat, lon] = cellToLatLng(cell);
    const feature = featureAt(features, lon, lat);
    cellFeature.set(cell, feature);
    return feature;
  }

  /** A point inside a feature: its largest part's centroid when inside, else a vertex. */
  function representativePoint(feature) {
    if (feature.rep) return feature.rep;
    let best = feature.polygons[0];
    for (const polygon of feature.polygons)
      if (polygon.outer.length > (best?.outer.length || 0)) best = polygon;
    const outer = best?.outer || [];
    let lon = 0;
    let lat = 0;
    for (const [x, y] of outer) {
      lon += x;
      lat += y;
    }
    const centroid = outer.length
      ? [lon / outer.length, lat / outer.length]
      : null;
    feature.rep =
      centroid && featureContains(feature, centroid[0], centroid[1])
        ? centroid
        : outer[0] || null;
    return feature.rep;
  }

  /** Whether a feature holds a cell centre at a resolution. */
  function holdsCentre(feature, res, acrossDeg) {
    const { box } = feature;
    // Wider than a few cells every way: it holds one.
    if (
      box.east - box.west > 3 * acrossDeg &&
      box.north - box.south > 3 * acrossDeg
    )
      return true;
    for (const polygon of feature.polygons) {
      const rings = [polygon.outer, ...polygon.holes].map((ring) =>
        ring.map(([lon, lat]) => [lat, lon]),
      );
      try {
        for (const cell of polygonToCells(rings, res))
          if (landOf(cell) === feature) return true;
      } catch {
        /* a degenerate ring: none */
      }
    }
    return false;
  }

  /** The small countries' own cells at a resolution. */
  function extrasAt(res) {
    if (extras.has(res)) return extras.get(res);
    const acrossDeg =
      (Math.sqrt(3) * getHexagonEdgeLengthAvg(res, 'km')) / 111.32;
    const own = new Map();
    if (res <= 2) {
      const seen = new Set();
      for (const cell of allCells(res)) {
        const feature = landOf(cell);
        if (feature) seen.add(feature);
      }
      for (const feature of features) {
        if (seen.has(feature)) continue;
        const point = representativePoint(feature);
        if (!point) continue;
        const cell = latLngToCell(point[1], point[0], res);
        if (!landOf(cell) && !own.has(cell)) own.set(cell, feature);
      }
    } else {
      for (const feature of features) {
        if (holdsCentre(feature, res, acrossDeg)) continue;
        const point = representativePoint(feature);
        if (!point) continue;
        const cell = latLngToCell(point[1], point[0], res);
        if (!landOf(cell) && !own.has(cell)) own.set(cell, feature);
      }
    }
    extras.set(res, own);
    return own;
  }

  return { features, landOf, extrasAt, ringOf, representativePoint };
}

/** The cells of a resolution that may cross a tile (its rectangle widened by a cell). */
export function cellsNearTile(rect, res) {
  if (res <= 1 || rect.east - rect.west > 90) return allCells(res);
  const pad = (Math.sqrt(3) * getHexagonEdgeLengthAvg(res, 'km')) / 111.32;
  const poleward = Math.max(Math.abs(rect.south), Math.abs(rect.north));
  const padLon = pad / Math.max(0.1, Math.cos((poleward * Math.PI) / 180));
  const west = Math.max(-180, rect.west - padLon);
  const east = Math.min(180, rect.east + padLon);
  const south = Math.max(-89.9, rect.south - pad);
  const north = Math.min(89.9, rect.north + pad);
  const cells = new Set(
    polygonToCells(
      [
        [south, west],
        [south, east],
        [north, east],
        [north, west],
      ],
      res,
    ),
  );
  // A tile at ±180 also reaches cells whose rings run past it.
  for (const lon of [west <= -179 ? 180 : null, east >= 179 ? -180 : null])
    if (lon !== null)
      for (let lat = south; lat <= north; lat += pad / 2)
        cells.add(latLngToCell(lat, lon, res));
  return [...cells];
}

/**
 * Paint the hex style on a tile, at one resolution for the whole screen
 * (`res`, from the camera height: tiles of several levels side by side
 * would otherwise mix hexes of several sizes), else the tile level's.
 * @param {CanvasRenderingContext2D} context
 * @param {{ land: ReturnType<typeof createHexLand>, rect: object,
 *   level: number, res?: number, theme: 'dark' | 'light', opacity: number,
 *   cellFills?: Map<string, string>, size?: number }} options
 * @returns {number} the cells painted
 */
export function paintHexTile(
  context,
  {
    land,
    rect,
    level,
    res = hexResolutionForLevel(level),
    theme,
    opacity,
    cellFills = new Map(),
    size = TILE_SIZE,
  },
) {
  const colours = COUNTRY_THEMES[theme] || COUNTRY_THEMES.dark;
  // A coarse tile (towards the horizon) would hold thousands of hexes too
  // small to see: the countries in their hex colours read the same there.
  const acrossDeg =
    (Math.sqrt(3) * getHexagonEdgeLengthAvg(res, 'km')) / 111.32;
  if ((acrossDeg / (rect.east - rect.west)) * size < MIN_HEX_PX)
    return paintCountriesTile(context, {
      features: land.features,
      rect,
      level,
      theme,
      style: 'hex',
      opacity,
      size,
      outline: false,
    });
  const extras = land.extrasAt(res);
  const groups = new Map();
  const outlines = [];
  const add = (cell, feature) => {
    const css =
      cellFills.get(cell) || fillFor(feature, { theme, style: 'hex' });
    const fill = withAlpha(css, opacity);
    const ring = land.ringOf ? land.ringOf(cell) : cellRing(cell);
    if (!groups.has(fill)) groups.set(fill, []);
    groups.get(fill).push(ring);
    outlines.push(ring);
  };
  for (const cell of cellsNearTile(rect, res)) {
    const feature = land.landOf(cell) || extras.get(cell);
    if (feature) add(cell, feature);
  }
  if (!outlines.length) return 0;
  if (opacity > 0) paintGroups(context, groups, rect, size);
  strokeRings(
    context,
    outlines,
    rect,
    size,
    colours.hexOutline,
    colours.hexOutlineWidth,
  );
  return outlines.length;
}
