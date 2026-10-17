import { createHash } from 'node:crypto';
import { HostBlockedError, RobotsDisallowedError } from './fetch.mjs';
import { NON_TRAFFIC, parsePrimary } from './adapters/opencctv.mjs';

/**
 * Resolve OpenCCTV cameras to the feed their page's own player loads (the
 * operator's YouTube stream, HLS playlist, MJPEG stream or image), so the
 * app can play the camera itself instead of the directory's rate-limited
 * still; and check that the YouTube ones are still live.
 *
 * Camera pages are read under SOURCES.md's rules (robots-allowed, cached a
 * week), at one per 2 s. A page that names no operator feed is recorded as
 * such; the still stays the camera's picture either way.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const RESOLVE_FILE = 'resolve.json';
/** A camera page is read again no sooner than this. */
export const RESOLVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Between camera pages on opencctv.org. */
export const RESOLVE_GAP_MS = 2000;
/** A scheduled run stops after this long and resumes the next night. */
export const RESOLVE_MAX_MINUTES = 30;
/** Never-resolved cameras this close to a viewed place come first. */
export const RESOLVE_NEAR_VIEW_KM = 50;
const RECENT_VIEWS = 200;

/** YouTube liveness: one videos.list (1 unit) per 50 ids, at most this many units a day. */
export const LIVENESS_DAILY_UNITS = 200;
export const LIVENESS_FEATURE = 'camindex-youtube';
const IDS_PER_CALL = 50;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const roughKm = (aLat, aLon, bLat, bLon) => {
  const rad = Math.PI / 180;
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return Math.hypot(x, y) * 6371;
};
const shuffleKey = (id) =>
  createHash('sha1').update(String(id)).digest().readUInt32BE(0);

/** Distinct recent view centres (views.log), newest first. */
function recentCentres(views) {
  const centres = [];
  const seen = new Set();
  for (let i = views.length - 1; i >= 0 && centres.length < RECENT_VIEWS; i--) {
    const view = views[i];
    if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon)) continue;
    const key = `${view.lat.toFixed(1)},${view.lon.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    centres.push(view);
  }
  return centres;
}

/** Whether a resolve record is fresh: read within the week, not an error. */
export function resolveDue(record, now = Date.now()) {
  if (!record) return true;
  if (record.status === 'error') return true;
  return !(now - (record.resolvedAt ?? -Infinity) < RESOLVE_MAX_AGE_MS);
}

/**
 * The cameras to resolve, in order: (a) near the places viewed recently
 * (views.log), nearest first; (b) non-traffic cameras; (c) the rest; within
 * each, least recently resolved first. With `near`, only cameras within
 * `radiusKm` of one of those points.
 * @param {{candidates: Array<object>, records: Record<string, object>,
 *   views?: Array<{lat: number, lon: number}>, now?: number,
 *   near?: Array<{lat: number, lon: number}>, radiusKm?: number}} input
 */
export function resolveQueue({
  candidates,
  records,
  views = [],
  now = Date.now(),
  near = [],
  radiusKm = 20,
}) {
  const centres = recentCentres(views);
  const groups = [[], [], []];
  for (const candidate of candidates) {
    if (
      !candidate?.pageUrl ||
      !Number.isFinite(candidate.lat) ||
      !Number.isFinite(candidate.lon)
    )
      continue;
    if (
      near.length &&
      !near.some(
        (point) =>
          roughKm(candidate.lat, candidate.lon, point.lat, point.lon) <=
          radiusKm,
      )
    )
      continue;
    const record = records[candidate.id];
    if (!resolveDue(record, now)) continue;
    const last = record?.resolvedAt ?? -Number.MAX_VALUE;
    let nearest = Infinity;
    for (const centre of centres)
      nearest = Math.min(
        nearest,
        roughKm(candidate.lat, candidate.lon, centre.lat, centre.lon),
      );
    if (nearest <= RESOLVE_NEAR_VIEW_KM) {
      groups[0].push({ candidate, key: nearest });
      continue;
    }
    const scenic = (candidate.categories || []).some((category) =>
      NON_TRAFFIC.includes(category),
    );
    groups[scenic ? 1 : 2].push({ candidate, key: last });
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

/** One camera page answer → a resolve record. */
export function judgePage(answer, html, now) {
  const base = { resolvedAt: answer?.fetchedAt ?? now };
  if (!answer) return { ...base, status: 'error', reason: 'no answer' };
  if (answer.status === 404 || answer.status === 410)
    return { ...base, status: 'gone', httpStatus: answer.status };
  if (!answer.ok || typeof html !== 'string')
    return { ...base, status: 'error', httpStatus: answer.status };
  const primary = parsePrimary(html);
  return primary
    ? { ...base, status: 'resolved', primary }
    : { ...base, status: 'none' };
}

/**
 * Read the queued cameras' pages, one at a time (the fetcher paces them),
 * until `limit` pages, `maxMs` of wall clock, or the queue ends. A host
 * that blocks or a robots.txt that closes stops the run, unrecorded.
 * @param {{get: Function}} fetcher
 * @param {Array<object>} queue - From resolveQueue.
 * @param {Record<string, object>} records - id → record, updated in place.
 * @param {{limit?: number, maxMs?: number, now?: () => number,
 *   log?: (line: string) => void, onRecord?: (candidate: object) => void}} [options]
 */
export async function resolveCandidates(fetcher, queue, records, options = {}) {
  const {
    limit = Infinity,
    maxMs = Infinity,
    now = () => Date.now(),
    log = () => {},
    onRecord = () => {},
  } = options;
  const started = now();
  const run = {
    read: 0,
    fromNetwork: 0,
    resolved: 0,
    byKind: {},
    stoppedBy: 'complete',
  };
  for (const candidate of queue) {
    if (run.read >= limit) {
      run.stoppedBy = 'limit';
      break;
    }
    if (now() - started >= maxMs) {
      run.stoppedBy = 'time';
      break;
    }
    let answer;
    try {
      answer = await fetcher.get(candidate.pageUrl, {
        maxAgeMs: RESOLVE_MAX_AGE_MS,
      });
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
        resolvedAt: now(),
      };
      run.read += 1;
      onRecord(candidate);
      continue;
    }
    run.read += 1;
    if (!answer?.fromCache) run.fromNetwork += 1;
    const record = judgePage(
      answer,
      answer?.body ? answer.body.toString('utf8') : null,
      now(),
    );
    records[candidate.id] = record;
    if (record.primary) {
      run.resolved += 1;
      run.byKind[record.primary.kind] =
        (run.byKind[record.primary.kind] || 0) + 1;
    }
    onRecord(candidate);
    if (run.read % 50 === 0)
      log(`resolved ${run.resolved} of ${run.read} pages read`);
  }
  return run;
}

/** What videos.list says about one video, as an observation status. */
export function youtubeStatus(item) {
  if (!item) return 'dead';
  if (
    item.status?.privacyStatus !== 'public' ||
    item.status?.embeddable === false
  )
    return 'dead';
  const broadcast = item.snippet?.liveBroadcastContent;
  if (broadcast === 'live') return 'live';
  if (broadcast === 'upcoming') return 'upcoming';
  // Ended, or never a stream: nothing live to watch.
  return 'offline';
}

/**
 * Check the YouTube cameras the catalog resolved, 50 ids a call, within the
 * day's LIVENESS_DAILY_UNITS for this feature (and the shared key's budget).
 * @param {{cameras: Array<object>, youtube: {call: Function, hasKey: Function},
 *   quota: {usedBy: Function, exhausted: Function}, now?: () => number,
 *   cap?: number, log?: (line: string) => void}} input
 * @returns {Promise<{observations: Record<string, object>, checked: number,
 *   units: number, stoppedBy: string}>} observations keyed by catalog id.
 */
export async function checkYoutubeLiveness({
  cameras,
  youtube,
  quota,
  now = () => Date.now(),
  cap = LIVENESS_DAILY_UNITS,
  log = () => {},
}) {
  const byVideo = new Map();
  for (const camera of cameras || []) {
    const videoId = String(camera?.embed?.videoId || '');
    if (camera?.feedType !== 'youtube' || !VIDEO_ID.test(videoId)) continue;
    if (!byVideo.has(videoId)) byVideo.set(videoId, []);
    byVideo.get(videoId).push(camera.id);
  }
  const ids = [...byVideo.keys()];
  const observations = {};
  const run = { checked: 0, units: 0, stoppedBy: 'complete' };
  if (!ids.length) return { observations, ...run };
  if (!youtube.hasKey()) return { observations, ...run, stoppedBy: 'no key' };
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    if (quota.usedBy(LIVENESS_FEATURE) + 1 > cap) {
      run.stoppedBy = 'daily cap';
      break;
    }
    if (quota.exhausted()) {
      run.stoppedBy = 'budget';
      break;
    }
    const batch = ids.slice(i, i + IDS_PER_CALL);
    let items;
    try {
      items = await youtube.call('videos', {
        part: 'snippet,status',
        id: batch.join(','),
        maxResults: String(IDS_PER_CALL),
      });
    } catch (error) {
      run.stoppedBy = String(error?.message || error).slice(0, 120);
      log(`liveness: ${run.stoppedBy}`);
      break;
    }
    run.units += 1;
    const found = new Map(items.map((item) => [item?.id, item]));
    const at = now();
    for (const videoId of batch) {
      const status = youtubeStatus(found.get(videoId));
      for (const id of byVideo.get(videoId))
        observations[id] = { status, at, by: 'youtube' };
      run.checked += 1;
    }
  }
  return { observations, ...run };
}
