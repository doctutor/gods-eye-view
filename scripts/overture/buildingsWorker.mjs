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
import { decodePlacesRowGroup } from './placesParts.mjs';
import { decodeInfrastructureRowGroup } from './infrastructureParts.mjs';
import { mergePlacesBucket } from './placesMerge.mjs';
import { decodeRoadsRowGroup } from './roadsParts.mjs';
import { mergeRoadsContainer } from './roadsMerge.mjs';

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

/** The point builds' row-group decoders, by build (places.mjs POINT_BUILDS). */
const POINT_DECODERS = {
  places: decodePlacesRowGroup,
  infrastructure: decodeInfrastructureRowGroup,
};

/** A point build's row group: fetched (kept on the raw archive) and decoded into a part. */
async function placesPart({
  kind = 'places',
  entry,
  rawDir,
  partFile,
  dropRaw,
  userAgent,
}) {
  const decode = POINT_DECODERS[kind];
  if (!decode) throw new Error(`No decoder for ${kind}`);
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
  const { buckets, stats } = decode(readRowGroupFile(rawFile), footer);
  const bytes = writePart(
    partFile,
    { file: entry.file, group: entry.group, stats },
    buckets,
  );
  if (dropRaw) fs.rmSync(rawFile, { force: true });
  return { fetched, bytes, stats };
}

/** A roads row group: fetched (kept on the raw archive) and decoded into a part. */
async function roadsPart({
  entry,
  rawDir,
  partFile,
  region,
  earlier,
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
  const { buckets, stats } = decodeRoadsRowGroup(
    readRowGroupFile(rawFile),
    footer,
    { region, earlier },
  );
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
    const result =
      type === 'roads-part'
        ? await roadsPart(job)
        : type === 'roads-merge'
          ? mergeRoadsContainer(job)
          : type === 'part'
            ? await part(job)
            : type === 'places-part'
              ? await placesPart(job)
              : type === 'places-merge'
                ? mergePlacesBucket(job)
                : mergeBucket(job);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack || error) });
  }
});
