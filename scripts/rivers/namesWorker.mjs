import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import {
  createWayIndex,
  localProjector,
  matchReach,
  toleranceForOrder,
} from './namesMatch.mjs';
import { readLineSpill } from './namesSpill.mjs';

/**
 * A worker of the river names build: one 1° cell's reaches matched against
 * the cell's OSM pieces (messages {id, type, job}).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** A cell's matches: Int32Array of [reach, group, coverage × 1000] triples. */
export function matchCell({ osmFile, reachFile, lat0, maxSamples }) {
  const project = localProjector(lat0);
  const ways = [];
  if (osmFile && fs.existsSync(osmFile))
    readLineSpill(osmFile, (group, _tag, coords) =>
      ways.push({ group, coords }),
    );
  if (!ways.length) return { matches: new Int32Array(0), reaches: 0 };
  const index = createWayIndex(ways, { project });
  const out = [];
  let reaches = 0;
  readLineSpill(reachFile, (reach, strahler, coords) => {
    reaches += 1;
    const match = matchReach(coords, index, {
      tolerance: toleranceForOrder(strahler),
      maxSamples,
    });
    if (match) out.push(reach, match.group, Math.round(match.coverage * 1000));
  });
  return { matches: Int32Array.from(out), reaches };
}

if (parentPort)
  parentPort.on('message', ({ id, type, job }) => {
    try {
      if (type !== 'names-cell') throw new Error(`no job ${type}`);
      const result = matchCell(job);
      parentPort.postMessage({ id, result }, [result.matches.buffer]);
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.stack || error) });
    }
  });
