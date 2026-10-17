import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
/**
 * Gap between uncached still requests, by host. opencctv.org answered 503
 * (Retry-After 600 s) after ~50 uncached stills in ~3 minutes, and again
 * after 159 stills at one per 17 s (45 minutes), on 2026-10-16: a bucket of
 * about 50 that refills about one per 25 s. One per 30 s (20 per 10 minutes)
 * stays under the refill, so a run never drains it. --gap-ms can only slow
 * these down.
 */
export const STILL_MIN_INTERVAL_MS = Object.freeze({ 'opencctv.org': 30_000 });

/** Per-host pacing for a verify run whose general gap is `gapMs`. */
export function stillPacing(gapMs) {
  const pacing = { '*': gapMs };
  for (const [host, ms] of Object.entries(STILL_MIN_INTERVAL_MS))
    pacing[host] = Math.max(ms, gapMs);
  return pacing;
}

/** SHA-1s of placeholder images seen in the wild, by source (shared with the server). */
export const PLACEHOLDERS_FILE = fileURLToPath(
  new URL('./placeholders.json', import.meta.url),
);

/** The known placeholder SHA-1s for one source. */
export function knownPlaceholders(source, file = PLACEHOLDERS_FILE) {
  try {
    const hashes = JSON.parse(fs.readFileSync(file, 'utf8'))?.hashes?.[source];
    return Array.isArray(hashes)
      ? hashes.filter((hash) => /^[0-9a-f]{40}$/.test(String(hash)))
      : [];
  } catch {
    return [];
  }
}

/** Rolling runs check at most this many stills. */
export const ROLLING_LIMIT = 200;
/** Never-checked cameras this close to a viewed place come before the rest. */
export const NEAR_VIEW_KM = 50;
/** The most recent distinct view centres considered. */
const RECENT_VIEWS = 200;

const roughKm = (aLat, aLon, bLat, bLon) => {
  const rad = Math.PI / 180;
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return Math.hypot(x, y) * 6371;
};
const shuffleKey = (id) =>
  createHash('sha1').update(String(id)).digest().readUInt32BE(0);

/**
 * The rolling verification queue, in order:
 * (a) cameras whose last observation (observed.json) is over a week old;
 * (b) never-checked cameras within NEAR_VIEW_KM of a place viewed recently
 *     (views.log), nearest first;
 * (c) everything else that is due, least recently checked first.
 * A camera checked (by verify or by a viewer's frame) within the week is not
 * due; one whose last check was an error always is.
 * @param {{candidates: Array<object>, records: Record<string, object>,
 *   observed?: Record<string, {status: string, at: number}>,
 *   views?: Array<{lat: number, lon: number}>, now?: number,
 *   observedId?: (candidate: object) => string}} input
 */
export function rollingQueue({
  candidates,
  records,
  observed = {},
  views = [],
  now = Date.now(),
  observedId = (candidate) => `opencctv-${candidate.id}`,
}) {
  const centres = [];
  const seenCentres = new Set();
  for (let i = views.length - 1; i >= 0 && centres.length < RECENT_VIEWS; i--) {
    const key = `${views[i].lat.toFixed(1)},${views[i].lon.toFixed(1)}`;
    if (seenCentres.has(key)) continue;
    seenCentres.add(key);
    centres.push(views[i]);
  }
  const groups = [[], [], []];
  for (const candidate of candidates) {
    if (
      !candidate.stillUrl ||
      !Number.isFinite(candidate.lat) ||
      !Number.isFinite(candidate.lon)
    )
      continue;
    const record = records[candidate.id];
    const seen = observed[observedId(candidate)];
    // Never checked counts as checked longest ago.
    const lastAt = Math.max(
      record?.verifiedAt ?? -Infinity,
      seen?.at ?? -Infinity,
    );
    const lastStatus =
      (seen?.at ?? -Infinity) >= (record?.verifiedAt ?? -Infinity)
        ? seen?.status
        : record?.status;
    const due = lastStatus === 'error' || !(now - lastAt < VERIFY_MAX_AGE_MS);
    if (!due) continue;
    if (seen && now - seen.at >= VERIFY_MAX_AGE_MS) {
      groups[0].push({ candidate, key: seen.at });
      continue;
    }
    if (!record && !seen && centres.length) {
      let nearest = Infinity;
      for (const centre of centres)
        nearest = Math.min(
          nearest,
          roughKm(candidate.lat, candidate.lon, centre.lat, centre.lon),
        );
      if (nearest <= NEAR_VIEW_KM) {
        groups[1].push({ candidate, key: nearest });
        continue;
      }
    }
    groups[2].push({
      candidate,
      key: Number.isFinite(lastAt) ? lastAt : -Number.MAX_VALUE,
    });
  }
  return groups.flatMap((group) =>
    group
      .sort(
        (a, b) =>
          a.key - b.key ||
          shuffleKey(a.candidate.id) - shuffleKey(b.candidate.id),
      )
      .map((entry) => entry.candidate),
  );
}

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
  // Rate limits and server errors say nothing about the camera.
  if (answer.status === 429 || answer.status >= 500)
    return { ...base, status: 'error', reason: `HTTP ${answer.status}` };
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
 *   log?: (line: string) => void, onRecord?: (candidate: object) => void,
 *   queue?: Array<object>, placeholders?: Array<string>}} [options]
 *   `queue` replaces the default choice and order (rollingQueue).
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
  const due =
    options.queue ||
    verifyOrder(
      candidates.filter(
        (candidate) =>
          candidate.stillUrl &&
          // A camera with no place is never served, so never checked.
          Number.isFinite(candidate.lat) &&
          Number.isFinite(candidate.lon) &&
          (records[candidate.id]?.status === 'error' ||
            !(
              now() - (records[candidate.id]?.verifiedAt ?? -Infinity) <
              VERIFY_MAX_AGE_MS
            )),
      ),
      records,
    );
  const run = { checked: 0, fromNetwork: 0, stoppedBy: 'complete' };
  const placeholders = options.placeholders || knownPlaceholders(source);
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
    onRecord(candidate);
    if (run.checked % 50 === 0)
      log(`verified ${run.checked}/${Math.min(due.length, limit)}`);
  }
  run.placeholderHashes = markSharedPlaceholders(records);
  return run;
}
