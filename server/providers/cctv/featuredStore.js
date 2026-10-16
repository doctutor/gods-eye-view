import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Files the featured-cam pack writes: the hand-checked list (live-cams.json,
 * when a stream restarts or a queued stream is accepted) and the review
 * queue under .gev-cache/cctv-featured/. Every write goes to a temporary file
 * in the same directory and is renamed over the target, so a reader never
 * sees half a file; writes to one file are serialized in this process.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

/** The hand-checked list, relative to the application root. */
export const DEFAULT_FEATURED_FILE =
  'src/data/local_data/cctv_featured/live-cams.json';
/** The review queue and its companions, relative to the application root. */
export const FEATURED_CACHE_DIR = path.join('.gev-cache', 'cctv-featured');

/** Where the hand-checked list lives (CCTV_FEATURED_FILE overrides). */
export function featuredCatalogPath(sourceRoot = process.cwd()) {
  const file = process.env.CCTV_FEATURED_FILE || DEFAULT_FEATURED_FILE;
  return path.isAbsolute(file) ? file : path.resolve(sourceRoot, file);
}

/** Read a JSON file; a missing or malformed one is `fallback`. */
export function readJsonFile(file, fallback, maxBytes = 2 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maxBytes) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically: a temporary sibling, then a rename over the target.
 * Windows can refuse the rename for a moment while another process has the
 * target open, so a refused rename is retried briefly.
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until);
    }
  }
}

/** Per-file promise chains, so read-modify-write cycles never interleave. */
const chains = new Map();

/**
 * Read, change and atomically rewrite a JSON file, one change at a time.
 * `change` edits the parsed document (or a copy of `fallback`) in place and
 * says whether to write it back and what to resolve with.
 * @template T
 * @param {string} file
 * @param {object} fallback - Document when the file is missing.
 * @param {(document: object) => {result: T, write: boolean}} change
 * @returns {Promise<T>}
 */
export function updateJsonFile(file, fallback, change) {
  const previous = chains.get(file) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      const document = readJsonFile(file, structuredClone(fallback));
      const { result, write } = change(document);
      if (write) writeJsonAtomic(file, document);
      return result;
    });
  chains.set(file, next);
  next.finally(() => {
    if (chains.get(file) === next) chains.delete(file);
  });
  return next;
}

/**
 * Point an entry of the hand-checked list at a restarted stream, if it
 * still names the old one. Keeps every other byte of the entry as it was.
 * @returns {Promise<boolean>} Whether the file changed.
 */
export function persistRestartedStream(
  sourceRoot,
  { entryId, fromVideoId, toVideoId },
) {
  return updateJsonFile(
    featuredCatalogPath(sourceRoot),
    { cams: [] },
    (document) => {
      const entry = (Array.isArray(document?.cams) ? document.cams : []).find(
        (row) => row?.id === entryId,
      );
      if (!entry?.youtube || entry.youtube.videoId !== fromVideoId)
        return { result: false, write: false };
      entry.youtube.videoId = toVideoId;
      return { result: true, write: true };
    },
  );
}
