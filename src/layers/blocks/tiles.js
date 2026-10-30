// Personal fork: the precomputed Blocks tilesets (docs/BLOCKS-PLAN.md,
// milestone 6, decisions 2 and 3): where each built box's tiles reach and
// which of them a view is drawn from. Pure: the index comes from the
// server (/api/blocks/tiles/index.json, server/providers/blocksTiles.js);
// the controller (index.js) asks plan() each tick, and the app's tiles
// layer (src/app/blocksTiles.js) draws what it says.
//
// A box's tree is 4 × 4 chunk groups a level, every level on one anchor
// (the build's map: grid.js createRegion, curved for continental builds).
// A point is drawn from the finest level whose groups hold it (a fill
// tile is a leaf of the level above), so its "floor" is that level; the
// coarsest level's groups bound the tree.

import { CHUNK_COLUMNS, createRegion } from './grid.js';
import { formatNumber, t } from '../../i18n/index.js';

/** The server's route and index. */
export const TILES_ROUTE = '/api/blocks/tiles';
export const TILES_INDEX_URL = `${TILES_ROUTE}/index.json`;
/** Chunks a group side (the build's chunkGroup). */
const GROUP = 4;

/** A box's name for people: "lower48-480" → "lower 48". */
export function boxLabel(name) {
  return String(name || '')
    .replace(/-\d+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .trim();
}

/**
 * An index entry ready to ask: its regions and group sets by level, its
 * label and month, and its tileset's URL for a variant.
 * @param {object} entry the index's box ({name, built, anchor, curved,
 *   levelsM, finestM, variants, bbox, groups: {<level>: [[gi, gj]…]}})
 */
export function tilesBox(entry, { route = TILES_ROUTE } = {}) {
  const levelsM = [...(entry.levelsM || [])].sort((a, b) => a - b);
  const regions = new Map();
  const groups = new Map();
  for (const level of levelsM) {
    regions.set(
      level,
      createRegion({
        lon0: entry.anchor.lon0,
        lat0: entry.anchor.lat0,
        blockM: level,
        ...(entry.curved ? { curved: true } : {}),
      }),
    );
    groups.set(
      level,
      new Set(
        (entry.groups?.[String(level)] || []).map(([gi, gj]) => `${gi}:${gj}`),
      ),
    );
  }
  const variant = (name) =>
    entry.variants?.find((each) => each.name === name)?.file || null;
  return {
    name: entry.name,
    label: boxLabel(entry.name),
    // The month it was built: "2026-10".
    month: String(entry.built || '').slice(0, 7),
    finestM: Math.min(...levelsM),
    levelsM,
    bbox: entry.bbox || null,
    /** The finest level whose groups hold the point, or null outside the tree. */
    floorAt(lon, lat) {
      for (const level of levelsM) {
        const local = regions.get(level).toLocal(lon, lat);
        const groupM = CHUNK_COLUMNS * GROUP * level;
        const gi = Math.floor(local.x / groupM);
        const gj = Math.floor(local.y / groupM);
        if (groups.get(level).has(`${gi}:${gj}`)) return level;
      }
      return null;
    },
    /**
     * The tileset's URL: the ground-only variant with the Buildings switch
     * off where the box has one, else the default.
     */
    url({ buildings = true } = {}) {
      const file =
        (!buildings && variant('ground')) ||
        variant('buildings') ||
        variant('default') ||
        'tileset.json';
      return `${route}/${encodeURIComponent(entry.name)}/${file}`;
    },
  };
}

/** Every box of an index, ready to ask. */
export const tilesBoxes = (index, options) =>
  (index?.boxes || [])
    .filter((entry) => entry?.anchor)
    .map((entry) => tilesBox(entry, options));

/**
 * What a view is drawn from:
 * - 'tiles': a box reaches the view's level under the camera
 *   (floor ≤ wantedM) and holds every ground point the view shows
 *   (`samples`): the tiles draw it all, the live controller nothing;
 * - 'hybrid': a box holds the view but under the camera reaches only a
 *   coarser level than the view's (or the view has no level: Walk and
 *   Fly): the live controller draws the levels finer than its floor, the
 *   tiles the rest outside a hole;
 * - 'off': no box holds the view; live as before.
 * Of several boxes the one with the finest floor under the camera wins.
 * @param {ReturnType<typeof tilesBox>[]} boxes
 * @param {{lon: number, lat: number, wantedM: number,
 *   samples?: {lon: number, lat: number}[]}} view the camera's ground, the
 *   cell the view wants (NaN for none), and the ground the view shows
 * @returns {{mode: 'tiles'|'hybrid'|'off', box?: object, floorM?: number}}
 */
export function planTiles(boxes, { lon, lat, wantedM, samples = [] }) {
  let tiles = null;
  let hybrid = null;
  for (const box of boxes) {
    const floorM = box.floorAt(lon, lat);
    if (floorM === null) continue;
    if (!samples.every((point) => box.floorAt(point.lon, point.lat) !== null))
      continue;
    if (wantedM > 0 && floorM <= wantedM) {
      if (!tiles || floorM < tiles.floorM) tiles = { box, floorM };
    } else if (!hybrid || floorM < hybrid.floorM) hybrid = { box, floorM };
  }
  if (tiles) return { mode: 'tiles', ...tiles };
  if (hybrid) return { mode: 'hybrid', ...hybrid };
  return { mode: 'off' };
}

/**
 * The HUD's name for the tiles: "Blocks tiles 2026-10 · lower 48 · 480 m".
 */
export function tilesSourceText(box, sizeText = (m) => `${formatNumber(m)} m`) {
  if (!box) return '';
  return [
    t('Blocks tiles {month}', { month: box.month }),
    box.label,
    sizeText(box.finestM),
  ]
    .filter(Boolean)
    .join(' · ');
}
