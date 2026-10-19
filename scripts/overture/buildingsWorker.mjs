import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import {
  fetchRowGroup,
  fileFooter,
  readRowGroupFile,
  rowGroupFile,
} from './buildingsPlan.mjs';
import { decodeRowGroup, writePart } from './buildingsParts.mjs';
import { mergeBucket } from './buildingsMerge.mjs';

/**
 * A worker of the Overture buildings step: fetches and decodes row groups
 * into parts, or merges buckets (messages {id, type, job}).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const footers = new Map();

async function part({
  entry,
  rawDir,
  partFile,
  region,
  earlier,
  gapsOnly = false,
  dropRaw,
  userAgent,
}) {
  let fetched = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      fetched = await fetchRowGroup(entry, rawDir, { userAgent });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  const rawFile = rowGroupFile(rawDir, entry);
  let footer = footers.get(entry.file);
  if (!footer) {
    footer = await fileFooter(
      { name: entry.file, key: entry.key, size: entry.size },
      rawDir,
      { userAgent },
    );
    footers.clear();
    footers.set(entry.file, footer);
  }
  const { buckets, stats } = decodeRowGroup(readRowGroupFile(rawFile), footer, {
    region,
    earlier,
    gapsOnly,
  });
  const bytes = writePart(
    partFile,
    { file: entry.file, group: entry.group, stats },
    buckets,
  );
  if (dropRaw) fs.rmSync(rawFile, { force: true });
  return { fetched, bytes, stats };
}

parentPort.on('message', async ({ id, type, job }) => {
  try {
    const result = type === 'part' ? await part(job) : mergeBucket(job);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack || error) });
  }
});
