import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchCctvImageFromUpstream } from './media.js';

/**
 * Lazy verification: the frame a viewer actually opens is the check. When
 * the frame route fetches a still for a display-only camera (camindex,
 * Windy, linked, USGS, NPS: any source with a `licenseClass`), the answer is
 * classified and kept in .gev-cache/camindex/observed.json as
 * {id: {status, at, bytes?, httpStatus?}}:
 *
 * - live         an image of at least 1 KB that is not a known placeholder;
 * - placeholder  an image whose SHA-1 is in scripts/camindex/placeholders.json;
 * - dead         404/410, a non-image answer, or an image under 1 KB;
 * - error        anything else (rate limit, server error, timeout): says
 *                nothing about the camera.
 *
 * Writes are batched: at most one write per 30 s, merged into the file on
 * disk and replaced atomically. The camindex pack drops dead and placeholder
 * cameras when it loads the file, and `camindex build` folds it into
 * verify.json. The same directory holds views.log, the centres of recent
 * proximity queries, which tells `camindex verify --rolling` where to look
 * first.
 *
 * Personal fork; not part of upstream God's Eye View.
 */

export const CAMINDEX_DIR = path.join('.gev-cache', 'camindex');
export const OBSERVED_FILE = 'observed.json';
export const VIEWS_FILE = 'views.log';
export const PLACEHOLDERS_FILE = path.join(
  'scripts',
  'camindex',
  'placeholders.json',
);
export const OBSERVED_WRITE_INTERVAL_MS = 30 * 1000;
export const MIN_LIVE_BYTES = 1024;
export const VIEWS_MAX_LINES = 1000;
const STATUSES = new Set(['live', 'dead', 'placeholder', 'error']);

/** camindex's directory: CAMINDEX_DIR (relative to the source root) or the default. */
export function camindexDir(sourceRoot, env = process.env) {
  const dir = String(env.CAMINDEX_DIR || '').trim();
  return dir
    ? path.resolve(sourceRoot, dir)
    : path.join(sourceRoot, CAMINDEX_DIR);
}

/** The SHA-1s listed in placeholders.json ({source: [sha1, …]}), as one set. */
export function readPlaceholders(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hashes = Object.values(parsed?.hashes || {}).flat();
    return new Set(
      hashes.filter((hash) => /^[0-9a-f]{40}$/.test(String(hash))),
    );
  } catch {
    return new Set();
  }
}

/**
 * One upstream answer → an observation.
 * @param {{status: number, contentType: string, body: Buffer|null}} answer
 * @param {Set<string>} placeholders
 * @param {number} at
 */
export function classifyAnswer(answer, placeholders, at) {
  const status = Number(answer?.status) || 0;
  const image = /^image\//i.test(String(answer?.contentType || ''));
  const bytes = answer?.body?.length ?? 0;
  const base = { at, httpStatus: status };
  if (status >= 200 && status < 300 && image && answer.body) {
    if (bytes < MIN_LIVE_BYTES) return { ...base, status: 'dead', bytes };
    const sha1 = createHash('sha1').update(answer.body).digest('hex');
    return {
      ...base,
      status: placeholders.has(sha1) ? 'placeholder' : 'live',
      bytes,
    };
  }
  if (status === 404 || status === 410) return { ...base, status: 'dead' };
  if (status >= 200 && status < 300 && !image)
    return { ...base, status: 'dead' };
  return { ...base, status: 'error' };
}

/** observed.json as {id: observation}; unreadable or malformed → {}. */
export function readObserved(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const out = {};
    for (const [id, entry] of Object.entries(parsed))
      if (STATUSES.has(entry?.status) && Number.isFinite(entry?.at))
        out[id] = entry;
    return out;
  } catch {
    return {};
  }
}

/** Merge observations into the file on disk (newer wins), atomically. */
export function mergeObserved(file, observations) {
  const current = readObserved(file);
  for (const [id, entry] of Object.entries(observations))
    if (!(current[id]?.at > entry.at)) current[id] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(current));
  fs.renameSync(temporary, file);
  return current;
}

/** Whether the frame route should record what a camera's still answered. */
export function isObservable(source) {
  return Boolean(
    source?.id &&
    source.licenseClass &&
    String(source.feedType || '').toLowerCase() === 'image',
  );
}

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   intervalMs?: number, setTimer?: (fn: () => void, ms: number) => unknown,
 *   fetchFrame?: typeof fetchCctvImageFromUpstream}} [options]
 */
export function createFrameObserver({
  sourceRoot = process.cwd(),
  env = process.env,
  now = () => Date.now(),
  intervalMs = OBSERVED_WRITE_INTERVAL_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(),
  fetchFrame = fetchCctvImageFromUpstream,
  flushOnExit = true,
} = {}) {
  const file = path.join(camindexDir(sourceRoot, env), OBSERVED_FILE);
  const placeholdersFile = path.join(sourceRoot, PLACEHOLDERS_FILE);
  let placeholders = null;
  let placeholdersAt = 0;
  let pending = {};
  let timer = null;
  let lastWriteAt = -Infinity;

  function knownPlaceholders() {
    // Re-read at most once a minute, so an added hash applies without a restart.
    if (!placeholders || now() - placeholdersAt > 60 * 1000) {
      placeholders = readPlaceholders(placeholdersFile);
      placeholdersAt = now();
    }
    return placeholders;
  }

  function flush() {
    timer = null;
    if (!Object.keys(pending).length) return;
    const batch = pending;
    pending = {};
    lastWriteAt = now();
    try {
      mergeObserved(file, batch);
    } catch (error) {
      console.warn('[CCTV] observed.json not written:', error?.message);
    }
  }

  // A server stopping inside the 30 s window still keeps what it saw.
  if (flushOnExit) process.once('exit', () => flush());

  function record(id, observation) {
    pending[id] = observation;
    if (timer) return;
    const wait = Math.max(0, lastWriteAt + intervalMs - now());
    timer = setTimer(flush, wait || intervalMs) ?? true;
  }

  /**
   * Fetch a source's still the way the frame route does, recording what the
   * upstream answered when the source is observable.
   */
  function fetch(source, url) {
    if (!isObservable(source)) return fetchFrame(url);
    return fetchFrame(url, {
      onAnswer: (answer) => {
        try {
          record(source.id, classifyAnswer(answer, knownPlaceholders(), now()));
        } catch {
          /* observing never breaks a frame */
        }
      },
    });
  }

  return { fetch, record, flush, file, pending: () => ({ ...pending }) };
}

/**
 * Sources with observations applied: an image camera seen dead or showing a
 * placeholder is left out, one seen live is marked live with `observedAt`;
 * errors, unobserved cameras and other feed kinds pass unchanged.
 * @param {Array<object>} sources
 * @param {Record<string, {status: string, at: number}>} observed
 */
export function applyObservations(sources, observed) {
  const out = [];
  let changed = false;
  for (const source of sources) {
    // Only image fetches are observed; a camera since reclassified (an
    // image card that proved to be a page, now a link) is not judged by them.
    const seen =
      String(source?.feedType || 'image').toLowerCase() === 'image'
        ? observed[source?.id]
        : undefined;
    if (seen?.status === 'dead' || seen?.status === 'placeholder') {
      changed = true;
      continue;
    }
    if (seen?.status === 'live') {
      changed = true;
      out.push({
        ...source,
        liveStatus: 'live',
        observedAt: new Date(seen.at).toISOString(),
      });
    } else {
      out.push(source);
    }
  }
  // The same list when no camera in it was observed, so callers that rely
  // on identity (single-flight loaders, tests) see no change.
  return changed ? out : sources;
}

/** observed.json per file, re-read only when it changes. */
const observedFiles = new Map();

function currentObservations(sourceRoot, env) {
  const file = path.join(camindexDir(sourceRoot, env), OBSERVED_FILE);
  let key;
  try {
    const stat = fs.statSync(file);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {};
  }
  const held = observedFiles.get(file);
  if (held?.key === key) return held.observed;
  const observed = readObserved(file);
  observedFiles.set(file, { key, observed });
  return observed;
}

/**
 * A pack's list with what viewers' frame fetches saw applied
 * (applyObservations), keeping the list's own properties (`everything`,
 * `available`, `proximityOnly`, …); `everything` is filtered the same way.
 * The list itself is returned when nothing has been observed.
 * @param {Array<object>} list
 * @param {string} [sourceRoot]
 * @param {object} [env]
 */
export function withObservations(
  list,
  sourceRoot = process.cwd(),
  env = process.env,
) {
  if (!Array.isArray(list)) return list;
  const observed = currentObservations(sourceRoot || process.cwd(), env);
  let any = false;
  for (const id in observed) {
    any = true;
    break;
  }
  if (!any) return list;
  const out = applyObservations(list, observed);
  const everything = Array.isArray(list.everything)
    ? applyObservations(list.everything, observed)
    : null;
  if (out === list && (everything === null || everything === list.everything))
    return list;
  // A changed `everything` on an unchanged (often empty) capped list still
  // needs a fresh array to carry the new property.
  const target = out === list ? [...list] : out;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(list),
  )) {
    if (key === 'length' || /^\d+$/.test(key)) continue;
    Object.defineProperty(
      target,
      key,
      key === 'everything' && Array.isArray(list.everything)
        ? {
            value: everything,
            enumerable: descriptor.enumerable,
            configurable: true,
          }
        : descriptor,
    );
  }
  return target;
}

/**
 * A per-query source (Windy) whose near() answers pass through
 * withObservations; everything else is the source's own.
 */
export function withObservedNear(source, sourceRoot) {
  return Object.assign(Object.create(source), {
    near: async (...args) =>
      withObservations(await source.near(...args), sourceRoot),
  });
}

/**
 * Centres of recent proximity queries, one "at lat lon radiusKm" line each,
 * newest last, at most VIEWS_MAX_LINES. A centre within ~1 km of the last one
 * is not repeated.
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   maxLines?: number}} [options]
 */
export function createViewLog({
  sourceRoot = process.cwd(),
  env = process.env,
  now = () => Date.now(),
  maxLines = VIEWS_MAX_LINES,
} = {}) {
  const file = path.join(camindexDir(sourceRoot, env), VIEWS_FILE);
  let last = '';
  let appended = 0;
  return {
    file,
    record(lat, lon, radiusKm) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const key = `${lat.toFixed(2)} ${lon.toFixed(2)}`;
      if (key === last) return;
      last = key;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(
          file,
          `${now()} ${lat.toFixed(5)} ${lon.toFixed(5)} ${Math.round(Number(radiusKm) || 0)}\n`,
        );
        // Trim now and then, not on every line.
        if (++appended % 50 === 1) trimViews(file, maxLines);
      } catch {
        /* the view log is a hint; never break a query */
      }
    },
  };
}

/** Keep the newest `maxLines` lines of the view log. */
export function trimViews(file, maxLines = VIEWS_MAX_LINES) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= maxLines) return;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${lines.slice(-maxLines).join('\n')}\n`);
  fs.renameSync(temporary, file);
}

/** The view log as [{at, lat, lon, radiusKm}], newest last. */
export function readViews(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        ([at, lat, lon]) =>
          Number.isFinite(at) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180,
      )
      .map(([at, lat, lon, radiusKm]) => ({ at, lat, lon, radiusKm }));
  } catch {
    return [];
  }
}
