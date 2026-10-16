import { createHash } from 'node:crypto';
import { HostBlockedError, RobotsDisallowedError } from './fetch.mjs';

/**
 * Check that a candidate still publishes a real picture: one fetch of its
 * still (through the paced, cached fetcher; only the answer's metadata is
 * kept), which must be an image of at least 1 KB that is not a placeholder.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const MIN_STILL_BYTES = 1024;
export const MAX_STILL_BYTES = 3 * 1024 * 1024;
/** Stills re-checked no sooner than this. */
export const VERIFY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Byte-identical stills shared by this many cameras are a placeholder card
 * ("camera offline"), not a view.
 */
export const PLACEHOLDER_SHARED_BY = 3;
/** SHA-1s of placeholder images seen in the wild, by source. */
export const KNOWN_PLACEHOLDERS = Object.freeze({ opencctv: [] });

/** Maryland, for the first verification pass (lat 37.9–39.8, lon −79.5 to −75.0). */
export const MARYLAND_BOX = Object.freeze({
  south: 37.9,
  north: 39.8,
  west: -79.5,
  east: -75.0,
});

export function inBox(candidate, box = MARYLAND_BOX) {
  return (
    candidate.lat >= box.south &&
    candidate.lat <= box.north &&
    candidate.lon >= box.west &&
    candidate.lon <= box.east
  );
}

/** One still answer → a verification record. */
export function judgeStill(answer, { placeholders = [] } = {}) {
  const base = {
    verifiedAt: answer.fetchedAt,
    httpStatus: answer.status,
    contentType: answer.contentType,
    bytes: answer.bytes,
    sha1: answer.sha1,
  };
  if (!answer.ok)
    return { ...base, status: 'dead', reason: `HTTP ${answer.status}` };
  if (!/^image\//i.test(answer.contentType))
    return { ...base, status: 'dead', reason: 'not an image' };
  if (answer.bytes < MIN_STILL_BYTES)
    return { ...base, status: 'dead', reason: 'under 1 KB' };
  if (placeholders.includes(answer.sha1))
    return { ...base, status: 'placeholder', reason: 'known placeholder' };
  return { ...base, status: 'live' };
}

/**
 * Mark stills that several cameras share byte for byte as placeholders.
 * @param {Record<string, object>} records - id → verification record.
 */
export function markSharedPlaceholders(
  records,
  sharedBy = PLACEHOLDER_SHARED_BY,
) {
  const byHash = new Map();
  for (const [id, record] of Object.entries(records)) {
    if (record.status !== 'live' || !record.sha1) continue;
    if (!byHash.has(record.sha1)) byHash.set(record.sha1, []);
    byHash.get(record.sha1).push(id);
  }
  const hashes = [];
  for (const [hash, ids] of byHash) {
    if (ids.length < sharedBy) continue;
    hashes.push(hash);
    for (const id of ids)
      records[id] = {
        ...records[id],
        status: 'placeholder',
        reason: `same image as ${ids.length - 1} other cameras`,
      };
  }
  return hashes;
}

/** Verification order: Maryland first, then scenic, then the rest; oldest check first. */
export function verifyOrder(candidates, records) {
  const score = (candidate) =>
    (inBox(candidate) ? 0 : 2) +
    ((candidate.categories || []).some((category) => category !== 'traffic')
      ? 0
      : 1);
  // Past the oldest check, a stable shuffle, so a limited run samples every
  // category instead of the first listing read.
  const shuffle = (candidate) =>
    createHash('sha1').update(String(candidate.id)).digest().readUInt32BE(0);
  return [...candidates].sort(
    (a, b) =>
      score(a) - score(b) ||
      (records[a.id]?.verifiedAt ?? 0) - (records[b.id]?.verifiedAt ?? 0) ||
      shuffle(a) - shuffle(b),
  );
}

/**
 * Verify up to `limit` candidates that are unchecked or due.
 * @param {{get: Function}} fetcher
 * @param {Array<object>} candidates - each with id and stillUrl.
 * @param {Record<string, object>} records - existing id → record (updated in place).
 * @param {{limit?: number, now?: () => number, source?: string,
 *   log?: (line: string) => void, onRecord?: () => void}} [options]
 */
export async function verifyCandidates(
  fetcher,
  candidates,
  records,
  options = {},
) {
  const {
    limit = Infinity,
    now = () => Date.now(),
    source = 'opencctv',
    log = () => {},
    onRecord = () => {},
  } = options;
  const due = verifyOrder(
    candidates.filter(
      (candidate) =>
        candidate.stillUrl &&
        !(
          now() - (records[candidate.id]?.verifiedAt ?? -Infinity) <
          VERIFY_MAX_AGE_MS
        ),
    ),
    records,
  );
  const run = { checked: 0, fromNetwork: 0, stoppedBy: 'complete' };
  const placeholders = KNOWN_PLACEHOLDERS[source] || [];
  for (const candidate of due) {
    if (run.checked >= limit) {
      run.stoppedBy = 'limit';
      break;
    }
    try {
      const answer = await fetcher.get(candidate.stillUrl, {
        store: false,
        maxBytes: MAX_STILL_BYTES,
        maxAgeMs: VERIFY_MAX_AGE_MS,
        headers: { Accept: 'image/*' },
      });
      if (!answer.fromCache) run.fromNetwork += 1;
      records[candidate.id] = judgeStill(answer, { placeholders });
    } catch (error) {
      if (
        error instanceof HostBlockedError ||
        error instanceof RobotsDisallowedError
      ) {
        run.stoppedBy = error.message;
        log(`stopped: ${error.message}`);
        break;
      }
      records[candidate.id] = {
        status: 'error',
        reason: String(error?.message || error).slice(0, 120),
        verifiedAt: now(),
      };
    }
    run.checked += 1;
    onRecord();
    if (run.checked % 50 === 0)
      log(`verified ${run.checked}/${Math.min(due.length, limit)}`);
  }
  run.placeholderHashes = markSharedPlaceholders(records);
  return run;
}
