// Personal fork: a paced Overpass client for layers that ask about the view
// (Localities' places, Street assets). It goes through the app's own
// /api/overpass proxy (server/providers/overpass.js: its upstreams, from
// OVERPASS_UPSTREAMS, its query bounds, its 24 h memory and 7-day disk
// cache) and adds the pacing a view-following layer needs: one request at a
// time, at least `minGapMs` between two, and nothing until a rate limit's
// Retry-After has passed. A newer query aborts the one in flight.

export const OVERPASS_VIEW_URL = '/api/overpass';
/** The least time between two requests from one client. */
export const OVERPASS_MIN_GAP_MS = 1_500;
/** How long to wait after a refusal that names no Retry-After. */
export const OVERPASS_DEFAULT_BACKOFF_MS = 30_000;

/** A failed Overpass answer: `code` is 'unconfigured', 'limited' or 'failed'. */
export class OverpassViewError extends Error {
  constructor(code, message, retryAfterMs = 0) {
    super(message);
    this.name = 'OverpassViewError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, url?: string, now?: () => number,
 *   wait?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   minGapMs?: number}} [options]
 */
export function createOverpassViewClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = OVERPASS_VIEW_URL,
  now = () => Date.now(),
  wait = defaultWait,
  minGapMs = OVERPASS_MIN_GAP_MS,
} = {}) {
  let lastAt = -Infinity;
  let blockedUntil = 0;
  let inflight = null;
  let chain = Promise.resolve();

  async function send(query, signal) {
    const ready = Math.max(lastAt + minGapMs, blockedUntil);
    if (ready > now()) await wait(ready - now(), signal);
    signal?.throwIfAborted();
    lastAt = now();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    const body = await response.json().catch(() => null);
    if (response.ok && Array.isArray(body?.elements) && !body.remark)
      return {
        elements: body.elements,
        stale: response.headers?.get?.('x-overpass-cache') === 'STALE',
      };
    if (body?.code === 'OVERPASS_NOT_CONFIGURED')
      throw new OverpassViewError(
        'unconfigured',
        'Detailed OpenStreetMap queries are not configured',
      );
    if (
      response.status === 429 ||
      response.status === 406 ||
      body?.code === 'OVERPASS_UNAVAILABLE'
    ) {
      const retryAfterMs =
        Number(body?.retryAfterMs) ||
        Number(response.headers?.get?.('retry-after')) * 1000 ||
        OVERPASS_DEFAULT_BACKOFF_MS;
      blockedUntil = now() + retryAfterMs;
      throw new OverpassViewError(
        'limited',
        'Overpass rate-limited',
        retryAfterMs,
      );
    }
    throw new OverpassViewError(
      'failed',
      body?.error ||
        (response.ok
          ? 'Overpass returned an incomplete answer'
          : `Overpass ${response.status}`),
    );
  }

  return {
    /**
     * Ask Overpass; a newer call aborts the one in flight.
     * @param {string} query Overpass QL, bounded by a box (the proxy checks).
     * @returns {Promise<{elements: Array<object>, stale: boolean}>}
     */
    query(query) {
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      const run = chain.then(() => send(query, controller.signal));
      chain = run.catch(() => {});
      return run.finally(() => {
        if (inflight === controller) inflight = null;
      });
    },
    /** Abort the request in flight, if any. */
    abort() {
      inflight?.abort();
      inflight = null;
    },
    /** When the next request may go (ms epoch). */
    readyAt: () => Math.max(lastAt + minGapMs, blockedUntil),
  };
}

function defaultWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
