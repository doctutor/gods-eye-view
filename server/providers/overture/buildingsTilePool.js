// Personal fork: the Overture buildings tiles' worker pool, on the shared
// tile pool (../common/tilePool.js). Not part of upstream God's Eye View.
import { createTilePool as createPool } from '../common/tilePool.js';

/** Tiles to this zoom read the buckets' overviews (buildingsTiles.js). */
export const LOW_ZOOM = 4;

/**
 * Buildings tiles drawn in `size` worker threads, each with its own
 * createBuildingsTiles({dir}) (its open buckets and overviews). Tiles
 * z 0–LOW_ZOOM go to the first worker alone, ahead of the rest: they read
 * every bucket's overview, which that worker builds once (four workers
 * built it four times, behind the close tiles of a view loading).
 *
 * @param {{dir: string, size?: number}} options
 */
export function createTilePool({ dir, size = 4 }) {
  const pool = createPool({
    drawer: 'overture-buildings',
    options: { dir },
    size,
    lane: ([, , z]) => (z <= LOW_ZOOM ? 'low' : 'any'),
  });
  return {
    /** Draw a tile: {status, error?, version, body: Buffer|null}. */
    render: (mode, ink, z, x, y) => pool.render('tile', [mode, ink, z, x, y]),
    close: pool.close,
  };
}
