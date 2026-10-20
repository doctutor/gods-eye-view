import { readPartBucket } from './buildingsParts.mjs';
import {
  bucketWriter,
  openBucket,
} from '../../server/providers/overture/buildingsFile.js';
import {
  ROADS_KIND,
  blocksPerContainer,
  blockSide,
  containerOf,
  decodeRoadBlock,
  encodeRoadBlock,
} from '../../server/providers/overture/roadsFile.js';
import { ROAD_LEVELS } from '../../src/data/overtureRoads.js';

/**
 * The last part of the Overture roads step: one container's file (a level's
 * blocks in one z `container` tile) from its earlier file (a region added
 * before reached it) and the new parts, block by block. On the coarse
 * levels a segment that the grid made the same as another (short ones
 * snapped onto the same points) is kept once.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const recordKey = (s) =>
  `${s.code},${s.flags},${s.surface},${s.speed},${s.subclass},${s.source},${s.name}|${s.points.join(',')}`;

/**
 * @param {{key: number, previous: string|null, parts: Array<{file: string,
 *   header: object}>, target: string}} job
 * @returns {{segments: number, bytes: number}}
 */
export function mergeRoadsContainer({ key, previous, parts, target }) {
  const { level, cx, cy } = containerOf(key);
  const per = blocksPerContainer(level);
  const side = blockSide(level);
  const dedupe = level < ROAD_LEVELS.length - 1;
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
        if (entry.kind === ROADS_KIND)
          add(entry.key, old.block(ROADS_KIND, entry.key));
    } finally {
      old.close();
    }
  }
  for (const { file, header } of parts)
    for (const { local, bytes } of readPartBucket(file, header, key))
      add(local, bytes);
  const writer = bucketWriter(target, pieces.size);
  let segments = 0;
  try {
    for (const local of [...pieces.keys()].sort((a, b) => a - b)) {
      const x0 = (cx * per + (local % per)) * side;
      const y0 = (cy * per + Math.floor(local / per)) * side;
      let list = [];
      for (const bytes of pieces.get(local))
        for (const segment of decodeRoadBlock(bytes, x0, y0))
          list.push(segment);
      pieces.delete(local);
      if (dedupe) {
        const seen = new Set();
        list = list.filter((s) => {
          const k = recordKey(s);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      segments += list.length;
      writer.add(ROADS_KIND, local, encodeRoadBlock(list, x0, y0), list.length);
    }
  } catch (error) {
    writer.abort();
    throw error;
  }
  const bytes = writer.finish();
  return { segments, bytes };
}
