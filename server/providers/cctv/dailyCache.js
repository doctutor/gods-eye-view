import fs from 'node:fs';
import path from 'node:path';

/**
 * A camera list fetched at most once a day and kept on disk
 * (.gev-cache/cctv-packs/<name>.json), for small agency packs whose lists
 * change slowly (nps.js, usgs.js). A failed refresh keeps serving the old
 * copy and waits before trying again; concurrent callers share one fetch.
 *
 * Personal-fork helper; not part of upstream God's Eye View.
 */

export const PACK_CACHE_DIR = path.join('.gev-cache', 'cctv-packs');
/** A cached list is refetched after this long. */
export const DAILY_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, the next attempt waits this long. */
export const DAILY_RETRY_MS = 30 * 60 * 1000;

/**
 * @param {{name: string, fetcher: () => Promise<Array<object>>,
 *   now?: () => number, cacheDir?: string, ttlMs?: number,
 *   retryMs?: number}} options
 * @returns {(sourceRoot?: string) => Promise<Array<object>>}
 */
export function createDailyCachedList({
  name,
  fetcher,
  now = () => Date.now(),
  cacheDir,
  ttlMs = DAILY_TTL_MS,
  retryMs = DAILY_RETRY_MS,
}) {
  let held = null;
  let retryAt = -Infinity;
  let inflight = null;

  const fileFor = (sourceRoot) =>
    path.join(
      cacheDir || path.join(sourceRoot, PACK_CACHE_DIR),
      `${name}.json`,
    );

  function readCache(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isFinite(parsed?.at) || !Array.isArray(parsed?.sources))
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeCache(file, payload) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(payload));
    } catch (error) {
      console.warn(`[CCTV] ${name} cache not written:`, error?.message);
    }
  }

  async function refresh(file, disk, t) {
    try {
      const sources = await fetcher();
      held = { at: t, sources };
      writeCache(file, held);
      console.log(`[CCTV] Loaded ${name} cameras: ${sources.length}`);
      return sources;
    } catch (error) {
      retryAt = t + retryMs;
      console.warn(
        `[CCTV] ${name} cameras unavailable (${error?.message}); ` +
          (disk ? `serving ${disk.sources.length} cached` : 'none cached'),
      );
      if (disk) held = disk;
      return disk?.sources || [];
    }
  }

  return async function get(sourceRoot = process.cwd()) {
    const t = now();
    if (held && t - held.at < ttlMs) return held.sources;
    const file = fileFor(sourceRoot);
    const disk = held || readCache(file);
    if (disk && t - disk.at < ttlMs) {
      held = disk;
      return disk.sources;
    }
    if (retryAt > t) return disk?.sources || [];
    if (!inflight)
      inflight = refresh(file, disk, t).finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
