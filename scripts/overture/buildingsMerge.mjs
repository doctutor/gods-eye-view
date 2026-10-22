import {
  BLOCK_ZOOM,
  BUCKET_ZOOM,
  DENSITY_ZOOM,
  FINE_DENSITY_ZOOM,
  KIND,
  WORLD_BITS,
  addToDense,
  bucketWriter,
  buildingSummary,
  denseCells,
  eachBuilding,
  encodeDense,
  openBucket,
} from '../../server/providers/overture/buildingsFile.js';
import { readPartBucket } from './buildingsParts.mjs';

/**
 * The last part of the Overture buildings step: one bucket's file from
 * its earlier file (when a region added before reached it) and the new
 * parts: the footprints by z 14 tile (F), and the density sums at the
 * z 10 tiles' cells (D18) and the bucket's own (D14), from each building's
 * centre, footprint and height. Personal fork: and the z 11 tiles' cells
 * (D19), which the tiles from z 11 read instead of the footprints.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const LOCAL = 2 ** (BLOCK_ZOOM - BUCKET_ZOOM);
const DENSITY_LOCAL = 2 ** (DENSITY_ZOOM - BUCKET_ZOOM);
const CELL18_SHIFT = WORLD_BITS - DENSITY_ZOOM - 8;
const CELL14_SHIFT = WORLD_BITS - BUCKET_ZOOM - 8;
const FINE_LOCAL = 2 ** (FINE_DENSITY_ZOOM - BUCKET_ZOOM);
const CELL19_SHIFT = WORLD_BITS - FINE_DENSITY_ZOOM - 8;
const FINE_TILE_SHIFT = WORLD_BITS - FINE_DENSITY_ZOOM;
const BLOCK_SHIFT = WORLD_BITS - BLOCK_ZOOM;

/**
 * @param {{bucketKey: number, previous: string|null, parts: Array<{file: string, header: object}>, target: string}} job
 * @returns {{buildings: number, bytes: number, d19: true}}
 */
export function mergeBucket({ bucketKey, previous, parts, target }) {
  const bx = bucketKey % 2 ** BUCKET_ZOOM;
  const by = Math.floor(bucketKey / 2 ** BUCKET_ZOOM);
  const pieces = new Map(); // local → [Buffer]
  const add = (local, bytes) => {
    let list = pieces.get(local);
    if (!list) pieces.set(local, (list = []));
    list.push(bytes);
  };
  if (previous) {
    const old = openBucket(previous);
    try {
      for (const entry of old.entries.values())
        if (entry.kind === KIND.F) add(entry.key, old.block(KIND.F, entry.key));
    } finally {
      old.close();
    }
  }
  for (const { file, header } of parts)
    for (const { local, bytes } of readPartBucket(file, header, bucketKey))
      add(local, bytes);
  // One z 10 tile at a time (its 16 × 16 z 14 blocks), into one reused
  // dense grid: a dense bucket's cells never all sit in memory at once.
  const groups = new Map(); // z 10 local → [local]
  for (const local of pieces.keys()) {
    const lx = local % LOCAL;
    const ly = Math.floor(local / LOCAL);
    const per = LOCAL / DENSITY_LOCAL;
    const key = Math.floor(ly / per) * DENSITY_LOCAL + Math.floor(lx / per);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(local);
  }
  // A z 10 tile's four z 11 tiles may each hold a D19 block.
  const writer = bucketWriter(target, pieces.size + groups.size * 5 + 1, {
    atMost: true,
  });
  const d18 = denseCells();
  const d14 = denseCells();
  const d19 = [denseCells(), denseCells(), denseCells(), denseCells()];
  let buildings = 0;
  try {
    for (const [dKey, locals] of [...groups].sort((a, b) => a[0] - b[0])) {
      d18.fill(0);
      for (const dense of d19) dense.fill(0);
      for (const local of locals.sort((a, b) => a - b)) {
        const list = pieces.get(local);
        pieces.delete(local);
        const raw = list.length === 1 ? list[0] : Buffer.concat(list);
        const tx = bx * LOCAL + (local % LOCAL);
        const ty = by * LOCAL + Math.floor(local / LOCAL);
        let count = 0;
        eachBuilding(raw, tx << BLOCK_SHIFT, ty << BLOCK_SHIFT, (building) => {
          const { x, y, area } = buildingSummary(building);
          count += 1;
          addToDense(
            d18,
            ((y >>> CELL18_SHIFT) & 255) * 256 + ((x >>> CELL18_SHIFT) & 255),
            area,
            building.height,
          );
          addToDense(
            d14,
            ((y >>> CELL14_SHIFT) & 255) * 256 + ((x >>> CELL14_SHIFT) & 255),
            area,
            building.height,
          );
          addToDense(
            d19[
              (((y >>> FINE_TILE_SHIFT) & 1) << 1) |
                ((x >>> FINE_TILE_SHIFT) & 1)
            ],
            ((y >>> CELL19_SHIFT) & 255) * 256 + ((x >>> CELL19_SHIFT) & 255),
            area,
            building.height,
          );
        });
        buildings += count;
        writer.add(KIND.F, local, raw, count);
      }
      const [cells, n] = encodeDense(d18);
      writer.add(KIND.D18, dKey, cells, n);
      const fx = (dKey % DENSITY_LOCAL) * 2;
      const fy = Math.floor(dKey / DENSITY_LOCAL) * 2;
      d19.forEach((dense, quarter) => {
        const [fine, count] = encodeDense(dense);
        if (count)
          writer.add(
            KIND.D19,
            (fy + (quarter >> 1)) * FINE_LOCAL + fx + (quarter & 1),
            fine,
            count,
          );
      });
    }
    const [cells, n] = encodeDense(d14);
    writer.add(KIND.D14, 0, cells, n);
  } catch (error) {
    writer.abort();
    throw error;
  }
  const bytes = writer.finish();
  return { buildings, bytes, d19: true };
}
