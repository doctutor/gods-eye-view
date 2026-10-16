/**
 * Upstream frames kept for as long as their publisher says they stay fresh,
 * so a camera panel refreshing every few seconds asks the upstream at most
 * once per freshness period (OpenCCTV stills: s-maxage=600, Windy's:
 * max-age=150) instead of once per refresh. Bounded by entry count and total
 * bytes, least recently used first out; frames with no freshness (no-store,
 * no-cache, no max-age) are never kept. Concurrent misses for one URL share
 * one upstream request.
 *
 * Personal fork; not part of upstream God's Eye View.
 */

export const FRAME_CACHE_MAX_ENTRIES = 500;
export const FRAME_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Longest a frame is kept, whatever the upstream says. */
export const FRAME_CACHE_MAX_TTL_MS = 60 * 60 * 1000;

/**
 * Freshness lifetime in ms from a Cache-Control header, as a shared cache
 * reads it: s-maxage over max-age; 0 when the response must not be reused.
 * @param {string} header
 */
export function freshnessMs(header) {
  const directives = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, value = ''] = part.trim().toLowerCase().split('=');
    if (name) directives.set(name, value.replace(/^"|"$/g, ''));
  }
  if (
    directives.has('no-store') ||
    directives.has('no-cache') ||
    directives.has('private')
  )
    return 0;
  const seconds = Number(
    directives.get('s-maxage') ?? directives.get('max-age'),
  );
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(FRAME_CACHE_MAX_TTL_MS, seconds * 1000);
}

/**
 * @param {{maxEntries?: number, maxBytes?: number, now?: () => number}} [options]
 */
export function createFrameCache({
  maxEntries = FRAME_CACHE_MAX_ENTRIES,
  maxBytes = FRAME_CACHE_MAX_BYTES,
  now = () => Date.now(),
} = {}) {
  /** url → {frame, expiresAt, bytes}; Map order is recency. */
  const entries = new Map();
  const inflight = new Map();
  let bytes = 0;

  function drop(url) {
    const entry = entries.get(url);
    if (!entry) return;
    entries.delete(url);
    bytes -= entry.bytes;
  }

  function store(url, frame) {
    const ttl = freshnessMs(frame.cacheControl);
    const size = frame.body?.length ?? 0;
    if (!ttl || size > maxBytes) return;
    drop(url);
    entries.set(url, { frame, expiresAt: now() + ttl, bytes: size });
    bytes += size;
    while (entries.size > maxEntries || bytes > maxBytes)
      drop(entries.keys().next().value);
  }

  /**
   * The frame for `url`: a fresh kept copy, else `load()` (shared by
   * concurrent callers), kept when it succeeds and says how long it lasts.
   * @param {string} url
   * @param {() => Promise<{ok: boolean, body: Buffer, contentType: string,
   *   cacheControl?: string}|null>} load
   */
  // Personal fork: for the status readout (cctv/status.js).
  let hits = 0;
  let misses = 0;

  async function get(url, load) {
    const held = entries.get(url);
    if (held && held.expiresAt > now()) {
      hits++;
      entries.delete(url);
      entries.set(url, held);
      return held.frame;
    }
    if (held) drop(url);
    if (inflight.has(url)) {
      hits++;
      return inflight.get(url);
    }
    misses++;
    const pending = Promise.resolve()
      .then(load)
      .then((frame) => {
        if (frame?.ok) store(url, frame);
        return frame;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
    return pending;
  }

  return {
    get,
    stats: () => ({ entries: entries.size, bytes, hits, misses }),
  };
}
