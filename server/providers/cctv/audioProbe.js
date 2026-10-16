// Personal fork: probe whether a camera stream carries sound, paced and cached.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sameOriginHlsUrl } from './stream.js';
import { classifyPlaylist, segmentAudio } from './audioParse.js';
import { normalizeFeedType } from './normalize.js';

export const AUDIO_VALUES = Object.freeze([
  'audio',
  'silent',
  'likely',
  'unknown',
]);
export const AUDIO_CACHE_FILE = path.join('.gev-cache', 'cctv-audio.json');
export const AUDIO_TTL_MS = 7 * 86_400_000;
/** A probe that learned nothing is retried sooner. */
export const AUDIO_UNKNOWN_TTL_MS = 86_400_000;
/** At most one probe per host this often, and one in flight per host. */
export const AUDIO_HOST_INTERVAL_MS = 2000;
export const AUDIO_PLAYLIST_BYTES = 256 * 1024;
/** One segment, or the head of an MP4/WebM file. */
export const AUDIO_MEDIA_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CACHE = 20_000;
/** Hosts never probed: display-only stills whose terms or volume rule it out. */
const NEVER_PROBE = /(?:^|\.)(?:opencctv\.org|windy\.com)$/i;

function feedTypeOf(source) {
  return normalizeFeedType(source?.feedType);
}

/**
 * The answer that needs no request, or null: YouTube streams always carry an
 * audio track (it may be silence), and stills, MJPEG and links have none.
 */
export function staticAudio(source) {
  const feedType = feedTypeOf(source);
  if (source?.embed?.provider === 'youtube' || feedType === 'youtube')
    return 'likely';
  if (['image', 'mjpeg', 'link'].includes(feedType)) return 'silent';
  if (!['hls', 'mp4', 'webm'].includes(feedType)) return 'unknown';
  const url = probeUrl(source);
  if (!url) return 'unknown';
  if (NEVER_PROBE.test(new URL(url).hostname)) return 'unknown';
  return null;
}

/** The stream URL a probe may fetch, under the HLS relay's rules, or null. */
export function probeUrl(source) {
  let url;
  try {
    url = new URL(String(source?.url || ''));
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (feedTypeOf(source) === 'hls' && !/\.m3u8$/i.test(url.pathname))
    return null;
  return url.href;
}

/**
 * GET at most `maxBytes` (a longer body is cut, not refused: a server that
 * ignores Range still answers with the head of the file). No redirects.
 */
export async function fetchHead(
  url,
  { fetchImpl = fetch, maxBytes, headers = {}, signal } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
  timer.unref?.();
  let reader;
  try {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0', ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    reader = response.body?.getReader?.();
    if (!reader) {
      const all = new Uint8Array(await response.arrayBuffer());
      return all.subarray(0, maxBytes);
    }
    const chunks = [];
    let length = 0;
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const out = new Uint8Array(Math.min(length, maxBytes));
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.byteLength, out.length - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= out.length) break;
    }
    return out;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Probe one source's stream. HLS: the playlist, then (only without codec
 * information) one variant playlist and ONE segment or init section. MP4 and
 * WebM: the first 2 MB. Returns 'audio', 'silent' or 'unknown' and how many
 * requests it made.
 */
export async function probeStream(source, { fetchImpl = fetch, signal } = {}) {
  const url = probeUrl(source);
  const stats = { requests: 0 };
  const get = (target, maxBytes, headers) => {
    stats.requests++;
    return fetchHead(target, { fetchImpl, maxBytes, headers, signal });
  };
  if (!url) return { audio: 'unknown', ...stats };
  try {
    if (feedTypeOf(source) !== 'hls') {
      const head = await get(url, AUDIO_MEDIA_BYTES, {
        Range: `bytes=0-${AUDIO_MEDIA_BYTES - 1}`,
      });
      return { audio: segmentAudio(head), ...stats };
    }
    let base = url;
    let verdict = classifyPlaylist(
      Buffer.from(await get(base, AUDIO_PLAYLIST_BYTES)).toString('utf8'),
    );
    if (verdict.next?.kind === 'variant') {
      base = sameOriginHlsUrl(verdict.next.uri, base);
      verdict = classifyPlaylist(
        Buffer.from(await get(base, AUDIO_PLAYLIST_BYTES)).toString('utf8'),
      );
      if (verdict.next?.kind === 'variant')
        return { audio: 'unknown', ...stats };
    }
    if (verdict.result) return { audio: verdict.result, ...stats };
    const target = sameOriginHlsUrl(verdict.next.uri, base);
    return {
      audio: segmentAudio(await get(target, AUDIO_MEDIA_BYTES)),
      ...stats,
    };
  } catch {
    return { audio: 'unknown', ...stats };
  }
}

/**
 * The probe service: answers from the shortcuts or the 7-day cache, else
 * probes lazily, at most once per camera at a time, paced per host, and
 * persists results to .gev-cache/cctv-audio.json.
 */
export function createAudioProbe({
  fetchImpl = (...args) => fetch(...args),
  cachePath = path.join(process.cwd(), AUDIO_CACHE_FILE),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hostIntervalMs = AUDIO_HOST_INTERVAL_MS,
  ttlMs = AUDIO_TTL_MS,
  logger = console,
} = {}) {
  /** id → {audio, url, checkedAt} */
  const cache = new Map();
  /** id → in-flight promise */
  const inflight = new Map();
  /** host → {tail, last} */
  const hosts = new Map();
  const stats = { probes: 0, requests: 0, byHost: {} };
  let loaded = null;
  let saveTimer = null;
  let saving = Promise.resolve();

  const ensureLoaded = () =>
    (loaded ||= fs
      .readFile(cachePath, 'utf8')
      .then((text) => {
        const rows = JSON.parse(text)?.cameras;
        for (const row of Array.isArray(rows) ? rows : [])
          if (
            typeof row?.id === 'string' &&
            AUDIO_VALUES.includes(row.audio) &&
            Number.isFinite(row.checkedAt)
          )
            cache.set(row.id, {
              audio: row.audio,
              url: String(row.url || ''),
              checkedAt: row.checkedAt,
            });
      })
      .catch(() => {}));

  function fresh(source) {
    const entry = cache.get(source?.id);
    if (!entry || entry.url !== probeUrl(source)) return null;
    const ttl =
      entry.audio === 'unknown' ? Math.min(ttlMs, AUDIO_UNKNOWN_TTL_MS) : ttlMs;
    return now() - entry.checkedAt < ttl ? entry.audio : null;
  }

  /** What is known now, without a request: a shortcut, a cached probe, or null. */
  function peek(source) {
    return staticAudio(source) ?? fresh(source);
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = saving
        .then(save)
        .catch((error) =>
          logger.warn?.('[CCTV:audio] cache not saved:', error?.message),
        );
    }, 1000);
    saveTimer.unref?.();
  }

  async function save() {
    const cutoff = now() - ttlMs;
    const rows = [...cache]
      .filter(([, entry]) => entry.checkedAt >= cutoff)
      .slice(-MAX_CACHE)
      .map(([id, entry]) => ({ id, ...entry }));
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, cameras: rows }));
    await fs.rename(temp, cachePath);
  }

  /** Run `task` for `host` after the previous one and at least the interval later. */
  function paced(host, task) {
    const lane = hosts.get(host) || {
      tail: Promise.resolve(),
      last: -Infinity,
    };
    hosts.set(host, lane);
    const run = lane.tail.then(async () => {
      const wait = lane.last + hostIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lane.last = now();
      return task();
    });
    lane.tail = run.catch(() => {});
    return run;
  }

  /** The camera's audio, probing it once if nothing is known yet. */
  async function request(source) {
    await ensureLoaded();
    const known = peek(source);
    if (known) return known;
    const id = source.id;
    if (inflight.has(id)) return inflight.get(id);
    const url = probeUrl(source);
    const host = new URL(url).host;
    const promise = paced(host, async () => {
      const again = fresh(source);
      if (again) return again;
      const result = await probeStream(source, { fetchImpl });
      stats.probes++;
      stats.requests += result.requests;
      stats.byHost[host] = (stats.byHost[host] || 0) + result.requests;
      cache.delete(id);
      cache.set(id, { audio: result.audio, url, checkedAt: now() });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      scheduleSave();
      return result.audio;
    }).finally(() => inflight.delete(id));
    inflight.set(id, promise);
    return promise;
  }

  /**
   * Probe every unprobed HLS/MP4/WebM source (CCTV_AUDIO_SWEEP=1), each host
   * at the per-host pace, hosts side by side. `onResult(id, audio)` reports.
   */
  async function sweep(sources, { onResult, signal } = {}) {
    await ensureLoaded();
    const due = (Array.isArray(sources) ? sources : []).filter(
      (source) => source?.id && peek(source) === null,
    );
    await Promise.all(
      due.map(async (source) => {
        if (signal?.aborted) return;
        const audio = await request(source).catch(() => 'unknown');
        if (!signal?.aborted) onResult?.(source.id, audio);
      }),
    );
    return due.length;
  }

  return {
    peek,
    request,
    sweep,
    load: ensureLoaded,
    flush: () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      return (saving = saving.then(save));
    },
    stats: () => ({ ...stats, byHost: { ...stats.byHost } }),
  };
}
