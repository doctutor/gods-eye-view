import { parentPort } from 'node:worker_threads';
import { openParquet } from '../overture/parquet.mjs';
import { dayOf } from '../../server/providers/property/file.js';
import { loadCounties } from '../../server/providers/property/counties.js';
import { readRows } from './rows.mjs';
import { compressSections, partitionRows } from './parts.mjs';
import { mergePropertyBucket } from './merge.mjs';
import { aggregatePartitionSpill } from './hexes.mjs';

/**
 * A worker of the property build (messages {id, type, job}): a row group
 * into its compressed sections, a bucket's merge, or a hexagon
 * partition's medians.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

let counties = null;
let parquet = null;

const JOBS = {
  'property-part'({ file, group, today }) {
    counties ||= loadCounties();
    if (parquet?.file !== file) {
      parquet?.close();
      parquet = { file, ...openParquet(file) };
    }
    const started = Date.now();
    const rows = readRows(parquet, group);
    const read = Date.now() - started;
    const day = dayOf(today);
    const sections = partitionRows(rows, {
      counties,
      today: day,
      thisYear: Number(today.slice(0, 4)),
    });
    const packed = compressSections(sections);
    return {
      result: { ...packed, readMs: read, ms: Date.now() - started },
      transfer: [...packed.buckets, ...packed.cells].map(
        ([, body]) => body.buffer,
      ),
    };
  },
  'property-merge': (job) => mergePropertyBucket(job),
  'property-hexes': ({ spill }) => aggregatePartitionSpill(spill),
};

parentPort.on('message', async ({ id, type, job }) => {
  try {
    const run = JOBS[type];
    if (!run) throw new Error(`no job ${type}`);
    const answer = await run(job);
    // A part's sections go back moved, not copied.
    if (answer?.transfer)
      parentPort.postMessage({ id, result: answer.result }, answer.transfer);
    else parentPort.postMessage({ id, result: answer });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack || error) });
  }
});
