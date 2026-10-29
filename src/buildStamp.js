/**
 * The page's side of the build stamp (build/buildStamp.js): the document
 * carries the stamp of the code it was served with in a `<meta>`, and the
 * server answers its current stamp at BUILD_STAMP_PATH. The watcher asks
 * now and then (every CHECK_INTERVAL_MS, and when the page comes back into
 * view or gains focus) and, when the answer differs, reloads the page: at
 * once while it is hidden, otherwise once its user has left it alone for
 * IDLE_MS (a reload under a hand mid-flight would lose the gesture; the
 * view itself lives in the URL hash and survives). An answer that is
 * missing, not JSON or not a stamp never reloads anything: a static host
 * without the file, a proxy, an outage.
 *
 * A reload that does not bring the newer stamp (a cache serving the old
 * document) is not repeated: the stamp reloaded for is kept in session
 * storage and compared on the next load, and the watcher stays off for
 * that page when it still does not match.
 */

/** Where the server answers `{ stamp }` (build/buildStamp.js writes it). */
export const BUILD_STAMP_PATH = '/build-stamp.json';
/** The document's `<meta name>` carrying its stamp. */
export const BUILD_STAMP_META = 'gev-build-stamp';
/** How often the server is asked, ms. */
export const CHECK_INTERVAL_MS = 60_000;
/** A reload deferred for a busy user is tried again after this, ms. */
export const RETRY_MS = 5_000;
/** How long since the last pointer or key before a visible page reloads, ms. */
export const IDLE_MS = 15_000;
/** Session storage: the stamp the page last reloaded for. */
export const RELOAD_KEY = 'gev:build-stamp-reload';

/** The stamp the document was served with, or null when it carries none. */
export function readBuildStamp(document = globalThis.document) {
  const meta = document?.querySelector?.(`meta[name="${BUILD_STAMP_META}"]`);
  const stamp = meta?.getAttribute?.('content');
  return typeof stamp === 'string' && stamp ? stamp : null;
}

/** Pointer and key events that count as the user being at the page. */
const INPUT_EVENTS = Object.freeze(['pointerdown', 'keydown', 'wheel']);

/**
 * A watcher for one page. `stamp` is the page's own; everything else is
 * the page's environment, injectable for tests.
 * @returns {{start(): boolean, stop(): void, check(): Promise<string>}}
 *   check() resolves to 'current', 'unavailable', 'reloading' or 'deferred'.
 */
export function createBuildStampWatcher({
  stamp,
  fetch = globalThis.fetch?.bind(globalThis),
  document = globalThis.document,
  window = globalThis.window,
  storage = window?.sessionStorage,
  now = Date.now,
  timers = globalThis,
  interval = CHECK_INTERVAL_MS,
  retry = RETRY_MS,
  idleMs = IDLE_MS,
  reload = () => window.location.reload(),
  log = console,
} = {}) {
  if (typeof stamp !== 'string' || !stamp)
    throw new Error('A build stamp watcher needs the page’s stamp');
  let lastInput = now();
  let pending = null;
  let inFlight = null;
  let ticker = null;
  let retryTimer = null;
  let listening = false;

  const read = (key) => {
    try {
      return storage?.getItem?.(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      if (value === null) storage?.removeItem?.(key);
      else storage?.setItem?.(key, value);
    } catch {
      // Storage refused (private mode, quota): the guard just does not hold.
    }
  };

  const idle = () => Boolean(document?.hidden) || now() - lastInput >= idleMs;

  const attempt = () => {
    retryTimer = null;
    if (pending === null) return 'current';
    if (!idle()) {
      retryTimer = timers.setTimeout(attempt, retry);
      return 'deferred';
    }
    const target = pending;
    pending = null;
    write(RELOAD_KEY, target);
    log?.info?.(`[build] the server now serves ${target}; reloading`);
    reload();
    return 'reloading';
  };

  const check = async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let current;
      try {
        const response = await fetch(BUILD_STAMP_PATH, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response?.ok) return 'unavailable';
        current = (await response.json())?.stamp;
      } catch {
        return 'unavailable';
      }
      if (typeof current !== 'string' || !current) return 'unavailable';
      if (current === stamp) {
        pending = null;
        return 'current';
      }
      pending = current;
      if (retryTimer !== null) return 'deferred';
      return attempt();
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const onInput = () => {
    lastInput = now();
  };
  const onVisible = () => {
    if (!document?.hidden) check();
  };

  const start = () => {
    if (listening) return true;
    const reloadedFor = read(RELOAD_KEY);
    if (reloadedFor !== null) {
      write(RELOAD_KEY, null);
      if (reloadedFor !== stamp) {
        log?.warn?.(
          `[build] reloaded for ${reloadedFor} but the page still carries ${stamp}; not reloading again`,
        );
        return false;
      }
    }
    listening = true;
    for (const type of INPUT_EVENTS)
      window?.addEventListener?.(type, onInput, { passive: true });
    document?.addEventListener?.('visibilitychange', onVisible);
    window?.addEventListener?.('focus', onVisible);
    ticker = timers.setInterval(check, interval);
    return true;
  };

  const stop = () => {
    if (!listening) return;
    listening = false;
    for (const type of INPUT_EVENTS)
      window?.removeEventListener?.(type, onInput);
    document?.removeEventListener?.('visibilitychange', onVisible);
    window?.removeEventListener?.('focus', onVisible);
    if (ticker !== null) timers.clearInterval(ticker);
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    ticker = retryTimer = null;
    pending = null;
  };

  return { start, stop, check };
}

/**
 * Watch this page's build stamp; null when the document carries none (a
 * host that did not serve it through the plugin).
 */
export function startBuildStampWatcher(options = {}) {
  const document = options.document ?? globalThis.document;
  const stamp = options.stamp ?? readBuildStamp(document);
  if (!stamp) return null;
  const watcher = createBuildStampWatcher({ ...options, document, stamp });
  return watcher.start() ? watcher : null;
}
