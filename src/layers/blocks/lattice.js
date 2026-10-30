// Personal fork: the Blocks pyramid's request lattice (docs/BLOCKS-PLAN.md,
// milestone 5). The Elevation values for a level are asked in tiles of a
// global equal-angle lattice, latticeCells(blockM) cells of the level a
// side (`blockM` of latitude a cell), from 180° W and 90° S. A tile's box is the
// same for every view, so the server's 30-day cache answers any region at
// that level, whatever the camera anchored it at, and a warm-up
// (scripts/blocks-pyramid.mjs) can fill it ahead of time. Pure: no fetch.

/** Cells a lattice tile asks for a side: the server's most. */
export const LATTICE_CELLS = 512;
/**
 * The levels whose tiles are half that a side, metres: a fresh 512-cell
 * tile there reads 256 pixels a cell of FABDEM (at 30 m, or its 120 m
 * pyramid level) and took 55 to 111 s, at times past the server's 120 s
 * (a 503, asked again just as heavy); 256 cells answered in 6 to 12 s.
 */
export const HALF_LATTICE_M = Object.freeze([480, 1920]);
/** Cells a lattice tile of a level asks for a side. */
export const latticeCells = (blockM) =>
  HALF_LATTICE_M.includes(blockM) ? LATTICE_CELLS / 2 : LATTICE_CELLS;
/**
 * A tile's share of a 512-cell tile's memory (its area): what the Blocks
 * source's tile cache counts.
 */
export const latticeWeight = (blockM) =>
  (latticeCells(blockM) / LATTICE_CELLS) ** 2;
const M_PER_DEG = 111_319.49;
/** Box edges are rounded to this many degrees, so a URL says them exactly. */
const EDGE_DEG = 1e-9;

const roundEdge = (deg) => Math.round(deg / EDGE_DEG) * EDGE_DEG;

/** A lattice tile's side in degrees at a level (a cell of `blockM`, latticeCells a side). */
export const latticeSideDeg = (blockM) =>
  (latticeCells(blockM) * blockM) / M_PER_DEG;

/** How many tiles span the longitudes and the latitudes at a level. */
export function latticeSpan(blockM) {
  const side = latticeSideDeg(blockM);
  return { cols: Math.ceil(360 / side), rows: Math.ceil(180 / side) };
}

/** The tile a place is in at a level: {ti, tj}, clamped to the globe. */
export function latticeIndex(blockM, lon, lat) {
  const side = latticeSideDeg(blockM);
  const { cols, rows } = latticeSpan(blockM);
  const clamp = (value, top) => Math.max(0, Math.min(top - 1, value));
  return {
    ti: clamp(Math.floor((lon + 180) / side), cols),
    tj: clamp(Math.floor((lat + 90) / side), rows),
  };
}

/** A tile's box in degrees, cut at the antimeridian and the poles. */
export function latticeBox(blockM, ti, tj) {
  const side = latticeSideDeg(blockM);
  return {
    west: roundEdge(Math.max(-180, -180 + ti * side)),
    south: roundEdge(Math.max(-90, -90 + tj * side)),
    east: roundEdge(Math.min(180, -180 + (ti + 1) * side)),
    north: roundEdge(Math.min(90, -90 + (tj + 1) * side)),
  };
}

/** A tile's key: level and indices. */
export const latticeKey = (blockM, ti, tj) => `${blockM}|${ti}:${tj}`;

/** The tiles a box in degrees overlaps at a level, west to east, south to north. */
export function latticeTilesOver(box, blockM) {
  const low = latticeIndex(blockM, box.west, box.south);
  const high = latticeIndex(blockM, box.east, box.north);
  const tiles = [];
  for (let tj = low.tj; tj <= high.tj; tj++)
    for (let ti = low.ti; ti <= high.ti; ti++) tiles.push({ ti, tj });
  return tiles;
}
