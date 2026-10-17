import fs from 'node:fs';
import path from 'node:path';
import { mergeCameras } from './merge.mjs';
import { decodeEntities, primaryCategory } from './adapters/opencctv.mjs';
import * as openeagleeye from './adapters/openeagleeye.mjs';
import * as pocketworld from './adapters/pocketworld.mjs';

/** Sources whose adapter turns its own candidates into catalog cameras. */
const ADAPTER_SOURCES = { openeagleeye, pocketworld };

/**
 * The catalog the server's camindex pack reads
 * (server/providers/cctv/camindex.js): every usable camera in the shape the
 * linked-webcam pack emits, with provenance, plus per-source counts.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const CATALOG_FILE = 'catalog.json';
export const CATALOG_VERSION = 1;

const clean = (value, max = 120) =>
  decodeEntities(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The directory's categories in the app's category words. */
export const OPENCCTV_CATEGORY_WORDS = Object.freeze({
  nature: 'nature',
  beach: 'beach',
  ski: 'ski',
  airport: 'airport',
  satellite: 'satellite',
  weather: 'meteo',
  traffic: 'traffic',
});

/**
 * One OpenCCTV candidate → a catalog camera. The directory publishes a still
 * per camera (its og:image); the app shows it and links the camera page. The
 * page's own player is not framed: opencctv.org refuses framing
 * (X-Frame-Options: SAMEORIGIN).
 */
export function openCctvToSource(candidate, record) {
  const category =
    OPENCCTV_CATEGORY_WORDS[primaryCategory(candidate.categories || [])] ||
    'webcam';
  const name = clean(candidate.name) || `OpenCCTV camera ${candidate.id}`;
  const status = record?.status;
  return {
    id: `opencctv-${candidate.id}`,
    name,
    city: clean(candidate.place || candidate.region, 80) || 'OpenCCTV',
    cityId: 'opencctv',
    provider: 'OpenCCTV',
    credit: 'opencctv.org',
    lat: candidate.lat,
    lon: candidate.lon,
    headingConfidence: 'low',
    rangeM: 150,
    sourceKind: 'opencctv',
    license:
      'Listed by opencctv.org, which publishes this still; the feed belongs to its operator',
    code: name.toUpperCase(),
    category,
    coordinatesQuality: 'site',
    operatorUrl: candidate.pageUrl,
    publishSignal: 'directory-still',
    licenseClass: 'display-only',
    feedType: 'image',
    url: candidate.stillUrl,
    snapshotUrl: candidate.stillUrl,
    liveStatus: status === 'live' ? 'live' : 'unknown',
    ...(record?.verifiedAt
      ? { verifiedAt: new Date(record.verifiedAt).toISOString() }
      : {}),
  };
}

/** Records that rule a camera out of the catalog. */
const unusable = (record) =>
  record?.status === 'dead' || record?.status === 'placeholder';

/**
 * @param {Record<string, {candidates: Array<object>, records: Record<string, object>}>} inputs
 *   opencctv, openeagleeye and pocketworld.
 * @param {{now?: () => number, onlyVerified?: boolean}} [options]
 */
export function buildCatalog(
  inputs,
  { now = () => Date.now(), onlyVerified = false } = {},
) {
  const sources = {};
  const cameras = [];
  const open = inputs.opencctv;
  if (open) {
    const usable = open.candidates.filter(
      (candidate) =>
        Number.isFinite(candidate.lat) &&
        Number.isFinite(candidate.lon) &&
        candidate.stillUrl &&
        !unusable(open.records[candidate.id]) &&
        (!onlyVerified || open.records[candidate.id]?.status === 'live'),
    );
    const records = Object.values(open.records);
    sources.opencctv = {
      found: open.candidates.length,
      verified: open.candidates.filter(
        (candidate) => open.records[candidate.id],
      ).length,
      live: records.filter((record) => record.status === 'live').length,
      dead: records.filter((record) => unusable(record)).length,
      served: usable.length,
    };
    for (const candidate of usable)
      cameras.push(openCctvToSource(candidate, open.records[candidate.id]));
  }
  for (const [name, adapter] of Object.entries(ADAPTER_SOURCES)) {
    const input = inputs[name];
    if (!input) continue;
    const records = input.records || {};
    const usable = input.candidates.filter(
      (candidate) =>
        Number.isFinite(candidate.lat) &&
        Number.isFinite(candidate.lon) &&
        !unusable(records[candidate.id]) &&
        (!onlyVerified || records[candidate.id]?.status === 'live'),
    );
    sources[name] = {
      found: input.candidates.length,
      verified: input.candidates.filter((candidate) => records[candidate.id])
        .length,
      served: usable.length,
    };
    for (const candidate of usable)
      cameras.push(adapter.toSource(candidate, records[candidate.id]));
  }
  const merged = mergeCameras(cameras);
  return {
    version: CATALOG_VERSION,
    generatedAt: new Date(now()).toISOString(),
    sources,
    cameras: merged,
  };
}

/**
 * Fold what viewers' frame fetches saw (observed.json, keyed by catalog id)
 * into verify records (keyed by source id), newer wins; errors say nothing
 * about a camera and are not folded.
 * @returns {number} records changed
 */
export function foldObserved(records, observed, prefix = 'opencctv-') {
  let changed = 0;
  for (const [id, seen] of Object.entries(observed || {})) {
    if (!id.startsWith(prefix)) continue;
    if (!['live', 'dead', 'placeholder'].includes(seen?.status)) continue;
    const key = id.slice(prefix.length);
    if ((records[key]?.verifiedAt ?? -Infinity) >= seen.at) continue;
    records[key] = {
      status: seen.status,
      verifiedAt: seen.at,
      ...(Number.isFinite(seen.bytes) ? { bytes: seen.bytes } : {}),
      ...(Number.isFinite(seen.httpStatus)
        ? { httpStatus: seen.httpStatus }
        : {}),
      by: 'observed',
    };
    changed += 1;
  }
  return changed;
}

/** Verify records -> observations, for the ids given (newer wins on merge). */
export function recordsToObserved(records, ids, prefix = 'opencctv-') {
  const out = {};
  for (const id of ids) {
    const record = records[id];
    if (!record || !Number.isFinite(record.verifiedAt)) continue;
    out[`${prefix}${id}`] = {
      status: record.status,
      at: record.verifiedAt,
      ...(Number.isFinite(record.bytes) ? { bytes: record.bytes } : {}),
      ...(Number.isFinite(record.httpStatus)
        ? { httpStatus: record.httpStatus }
        : {}),
    };
  }
  return out;
}

/** Write a JSON file whole or not at all. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
