/**
 * Personal fork: the targeted block (docs/BLOCKS-PLAN.md lessons 10–11,
 * Minecraft's F3 "Targeted Block"): which block of the Blocks world a ray
 * meets, and the facts about it the HUD's BLOCK line shows and the outline
 * carries (for a later click-to-dig). Pure; no Cesium.
 */
import { chunkKey } from '../layers/blocks/grid.js';
import { CHUNK_COLUMNS } from '../layers/blocks/grid.js';
import { MATERIALS, isSolid } from '../layers/blocks/store.js';

/** Material names, as the BLOCK line gives them. */
export const MATERIAL_NAMES = Object.freeze({
  [MATERIALS.TERRAIN]: 'terrain',
  [MATERIALS.WATER]: 'water',
  [MATERIALS.BUILDING]: 'building',
  [MATERIALS.GRASS]: 'grass',
  [MATERIALS.FOREST]: 'forest',
  [MATERIALS.ROAD]: 'road',
});

/**
 * The block a picked surface point belongs to: a hundredth of a block on
 * along the ray that picked it (into the surface), in region metres with
 * z above mean sea level. {i, j, y} in region columns (`blockM` metres)
 * and levels (`levelM`, blockM unless given).
 */
export function snapToBlock(point, direction, blockM, levelM = blockM) {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const step = (0.01 * Math.min(blockM, levelM)) / length;
  return {
    i: Math.floor((point.x + direction.x * step) / blockM),
    j: Math.floor((point.y + direction.y * step) / blockM),
    y: Math.floor((point.z + direction.z * step) / levelM),
  };
}

/**
 * What occupies a block of the world (region column i, j and level y):
 * a material id, or null where its chunk is not loaded.
 */
export function occupancyAt(world, i, j, y) {
  const N = CHUNK_COLUMNS;
  const ci = Math.floor(i / N);
  const cj = Math.floor(j / N);
  const chunk = world.chunkAt(ci, cj);
  return chunk ? chunk.occupancy(i - ci * N, j - cj * N, y) : null;
}

/**
 * The facts about a targeted block: its region column and level, its
 * chunk (and key), the place at its column's centre, its base and top
 * above mean sea level, its material, the face the ray came in through,
 * the block size (`blockM` across, `levelM` high) and the elevation
 * source's name. Null for a block that is not solid (or not loaded).
 */
export function blockFacts(world, hit, sourceName = '') {
  if (!hit) return null;
  const { region } = world;
  const blockM = region.blockM;
  const levelM = region.levelM > 0 ? region.levelM : blockM;
  const material = occupancyAt(world, hit.i, hit.j, hit.y);
  if (material === null || !isSolid(material)) return null;
  const ci = Math.floor(hit.i / CHUNK_COLUMNS);
  const cj = Math.floor(hit.j / CHUNK_COLUMNS);
  const centre = region.columnCentre(hit.i, hit.j);
  return {
    i: hit.i,
    j: hit.j,
    y: hit.y,
    level: hit.y,
    ci,
    cj,
    chunkKey: chunkKey(ci, cj),
    lon: centre.lon,
    lat: centre.lat,
    baseM: hit.y * levelM,
    topM: (hit.y + 1) * levelM,
    material,
    materialName: MATERIAL_NAMES[material] ?? `material ${material}`,
    face: hit.face ?? null,
    blockM,
    levelM,
    sourceName: sourceName || '',
  };
}

/** Whether two facts name the same block of the same material. */
export const sameBlock = (a, b) =>
  a === b ||
  Boolean(
    a &&
    b &&
    a.i === b.i &&
    a.j === b.j &&
    a.y === b.y &&
    a.material === b.material &&
    a.blockM === b.blockM &&
    a.levelM === b.levelM &&
    a.sourceName === b.sourceName,
  );
