import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The one way camindex reads the web: robots.txt first, one request at a time
 * per host with a minimum gap, every answer kept on disk and served from
 * there until it is a week old, bounded size and time. Pages are untrusted
 * data: bodies are stored and returned as text or bytes, never run.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 camindex (+https://github.com/doctutor/gods-eye-view)';
/** A cached answer is reused until it is this old. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ROBOTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MIN_INTERVAL_MS = 1500;
export const DEFAULT_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Longest wait a Retry-After header may ask for. */
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Consecutive failures after which a host is left alone for the run. */
export const HOST_FAILURE_LIMIT = 5;
const MAX_REDIRECTS = 3;
/** Network errors (not HTTP answers) are retried this often, waiting longer each time. */
export const NETWORK_RETRIES = 2;
const RETRY_WAIT_MS = 5000;

export class HostBlockedError extends Error {
  constructor(host, reason) {
    super(`${host}: ${reason}`);
    this.name = 'HostBlockedError';
    this.host = host;
  }
}

export class RobotsDisallowedError extends Error {
  constructor(url) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
    this.url = url;
  }
}

/** Stable cache key for a URL plus anything that changes its answer. */
export function cacheKey(url, variant = '') {
  return createHash('sha1').update(`${url}\n${variant}`).digest('hex');
}

/**
 * Parse robots.txt into the rule list that applies to `agent` (the most
 * specific matching group, else `*`).
 * @returns {Array<{allow: boolean, path: string}>}
 */
export function parseRobots(text, agent = 'camindex') {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const token = agent.toLowerCase();
  const named = groups.filter((group) =>
    group.agents.some((name) => name !== '*' && token.includes(name)),
  );
  const chosen = named.length
    ? named
    : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

function ruleMatches(rulePath, target) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(target);
}

/** Longest matching rule wins; Allow wins a tie; no match allows. */
export function robotsAllows(rules, url) {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}`;
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, target)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    )
      best = rule;
  }
  return best ? best.allow : true;
}

function retryAfterMs(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

function oversize(maxBytes) {
  const error = new Error(`body larger than ${maxBytes} bytes`);
  error.oversize = true;
  return error;
}

/** Read a response body, refusing more than `maxBytes`. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw oversize(maxBytes);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw oversize(maxBytes);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: a tee'd body settles its cancel only with its twin.
      reader.cancel().catch(() => {});
      throw oversize(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {{cacheDir: string, transport?: typeof fetch, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, userAgent?: string,
 *   minIntervalMs?: number|Record<string, number>, maxAgeMs?: number,
 *   timeoutMs?: number, maxBytes?: number, log?: (line: string) => void}} options
 */
export function createFetcher({
  cacheDir,
  transport = (...args) => fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  userAgent = USER_AGENT,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  log = () => {},
} = {}) {
  if (!cacheDir) throw new Error('createFetcher needs a cacheDir');
  /** host → {lastAt, pauseUntil, failures, chain} */
  const hosts = new Map();
  const robots = new Map();
  const stats = { network: 0, cached: 0, bytes: 0, errors: 0, refused: 0 };

  const intervalFor = (host) =>
    typeof minIntervalMs === 'number'
      ? minIntervalMs
      : (minIntervalMs[host] ?? DEFAULT_MIN_INTERVAL_MS);

  function hostState(host) {
    if (!hosts.has(host))
      hosts.set(host, {
        lastAt: -Infinity,
        pauseUntil: 0,
        failures: 0,
        extraGap: 0,
        chain: Promise.resolve(),
      });
    return hosts.get(host);
  }

  function paths(key) {
    return {
      meta: path.join(cacheDir, key.slice(0, 2), `${key}.json`),
      body: path.join(cacheDir, key.slice(0, 2), `${key}.body`),
    };
  }

  function readCache(key, wantBody) {
    const files = paths(key);
    try {
      const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
      if (!Number.isFinite(meta?.fetchedAt)) return null;
      if (wantBody && meta.stored) {
        meta.body = fs.readFileSync(files.body);
      }
      return meta;
    } catch {
      return null;
    }
  }

  function writeCache(key, meta, body) {
    const files = paths(key);
    fs.mkdirSync(path.dirname(files.meta), { recursive: true });
    if (body) fs.writeFileSync(files.body, body);
    fs.writeFileSync(files.meta, JSON.stringify(meta));
  }

  /** Run `task` in the host's queue, after the pacing gap. */
  function paced(host, task) {
    const state = hostState(host);
    const run = state.chain.then(async () => {
      if (state.failures >= HOST_FAILURE_LIMIT)
        throw new HostBlockedError(host, 'too many consecutive failures');
      const gap = intervalFor(host) + state.extraGap;
      const wait = Math.max(state.lastAt + gap, state.pauseUntil) - now();
      if (wait > 0) await sleep(wait);
      state.lastAt = now();
      try {
        return await task(state);
      } finally {
        state.lastAt = now();
      }
    });
    state.chain = run.catch(() => {});
    return run;
  }

  /** rawFetch, retrying network errors (a dropped connection, a timeout). */
  async function rawFetchRetrying(url, headers, limit) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await rawFetch(url, headers, limit);
      } catch (error) {
        if (
          error instanceof HostBlockedError ||
          error?.oversize ||
          attempt >= NETWORK_RETRIES
        )
          throw error;
        log(`${url}: ${error?.message || error}; retrying`);
        await sleep(RETRY_WAIT_MS * (attempt + 1));
      }
    }
  }

  async function rawFetch(url, headers, limit) {
    const host = new URL(url).host;
    return paced(host, async (state) => {
      stats.network += 1;
      let response;
      try {
        response = await transport(url, {
          headers: { 'User-Agent': userAgent, ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        state.failures += 1;
        stats.errors += 1;
        throw error;
      }
      const status = response.status;
      if (status === 429 || status === 503) {
        state.failures += 1;
        // Back off: honour Retry-After and widen the gap for the rest of the run.
        const wait = Math.min(
          MAX_RETRY_AFTER_MS,
          retryAfterMs(response.headers?.get?.('retry-after'), now()) ||
            30 * 1000,
        );
        state.pauseUntil = now() + wait;
        state.extraGap = Math.min(60 * 1000, state.extraGap * 2 || 2000);
        response.body?.cancel?.().catch?.(() => {});
        log(`${host} answered ${status}; pausing ${Math.round(wait / 1000)} s`);
        return { status, headers: response.headers, body: null };
      }
      let body = null;
      try {
        body = await readCapped(response, limit);
      } catch (error) {
        stats.errors += 1;
        if (!error.oversize) state.failures += 1;
        throw error;
      }
      if (status >= 500) state.failures += 1;
      else state.failures = 0;
      stats.bytes += body.length;
      return { status, headers: response.headers, body };
    });
  }

  async function robotsFor(origin) {
    const held = robots.get(origin);
    if (held) return held;
    const pending = (async () => {
      const url = `${origin}/robots.txt`;
      const key = cacheKey(url);
      const cached = readCache(key, true);
      if (cached && now() - cached.fetchedAt < ROBOTS_MAX_AGE_MS)
        return cached.status === 200
          ? parseRobots(cached.body.toString('utf8'), userAgent)
          : cached.status >= 400 && cached.status < 500
            ? []
            : [{ allow: false, path: '/' }];
      try {
        const answer = await rawFetch(url, {}, 512 * 1024);
        const fetchedAt = now();
        if (answer.status !== 429 && answer.status < 500)
          writeCache(
            key,
            { url, status: answer.status, fetchedAt, stored: true },
            answer.body || Buffer.alloc(0),
          );
        if (answer.status === 200)
          return parseRobots(answer.body.toString('utf8'), userAgent);
        // No robots.txt: everything is allowed. A server error: nothing is.
        if (
          answer.status >= 400 &&
          answer.status < 500 &&
          answer.status !== 429
        )
          return [];
        return [{ allow: false, path: '/' }];
      } catch {
        return [{ allow: false, path: '/' }];
      }
    })();
    robots.set(origin, pending);
    return pending;
  }

  /** Whether robots.txt lets camindex read `url`. */
  async function allowed(url) {
    const parsed = new URL(url);
    return robotsAllows(await robotsFor(parsed.origin), url);
  }

  /**
   * Read one URL through the cache.
   * @param {string} url
   * @param {{maxAgeMs?: number, store?: boolean, headers?: object,
   *   variant?: string, maxBytes?: number, offline?: boolean}} [options]
   *   `store: false` keeps only the answer's metadata (status, type, size,
   *   hash), for stills that are checked, not kept. `offline` never touches
   *   the network.
   * @returns {Promise<{url: string, status: number, contentType: string,
   *   bytes: number, sha1: string, fetchedAt: number, fromCache: boolean,
   *   body: Buffer|null, finalUrl: string}|null>} null when offline and
   *   nothing is cached.
   */
  async function get(url, options = {}) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol))
      throw new Error(`refusing ${parsed.protocol} URL`);
    const store = options.store !== false;
    const key = cacheKey(url, options.variant || '');
    const age = options.maxAgeMs ?? maxAgeMs;
    const cached = readCache(key, store);
    if (cached && (options.offline || now() - cached.fetchedAt < age)) {
      if (!store || cached.stored || !cached.ok) {
        stats.cached += 1;
        return { ...cached, body: cached.body || null, fromCache: true };
      }
    }
    if (options.offline) return null;
    let target = url;
    for (let hop = 0; ; hop += 1) {
      if (!(await allowed(target))) {
        stats.refused += 1;
        throw new RobotsDisallowedError(target);
      }
      const answer = await rawFetchRetrying(
        target,
        options.headers || {},
        options.maxBytes ?? maxBytes,
      );
      const location = answer.headers?.get?.('location');
      if (answer.status >= 300 && answer.status < 400 && location) {
        const next = new URL(location, target);
        // Same host only; a directory redirecting elsewhere is not followed.
        if (next.host !== parsed.host || hop >= MAX_REDIRECTS) {
          return finish(url, key, store, { ...answer, body: null }, target);
        }
        target = next.href;
        continue;
      }
      return finish(url, key, store, answer, target);
    }
  }

  function finish(url, key, store, answer, finalUrl) {
    const body = answer.body;
    const meta = {
      url,
      finalUrl,
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      contentType: String(answer.headers?.get?.('content-type') || ''),
      bytes: body ? body.length : 0,
      sha1: body ? createHash('sha1').update(body).digest('hex') : '',
      fetchedAt: now(),
      stored: Boolean(store && body),
    };
    // Rate limits and server errors are not remembered; anything else is.
    if (answer.status !== 429 && answer.status < 500)
      writeCache(key, meta, store ? body : null);
    return { ...meta, body: store ? body : null, fromCache: false };
  }

  return { get, allowed, stats, hostState };
}
