// Personal fork: an article's summary (extract and thumbnail) from
// Wikipedia's REST API, fetched when the Wikipedia layer's card is opened,
// never before. Not part of upstream God's Eye View.

import { pointWikiOfKey } from '../../../src/data/wikipediaPoints.js';

export const SUMMARY_ORIGIN = 'https://en.wikipedia.org';
/** A wiki's REST origin (WIKIPEDIA_POINT_WIKIS), or null for one not listed. */
export function summaryOrigin(wikiKey = 'enwiki') {
  const wiki = pointWikiOfKey(String(wikiKey || 'enwiki'));
  return wiki ? `https://${wiki.host}` : null;
}
/** Wikimedia asks API clients to name themselves with a way to reach them. */
export const SUMMARY_USER_AGENT =
  'gods-eye-view-personal-fork/0.1 wikipedia-layer (+https://github.com/doctutor/gods-eye-view)';
export const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_MISS_TTL_MS = 10 * 60 * 1000;
export const SUMMARY_TIMEOUT_MS = 8000;
const MAX_HELD = 500;
const EXTRACT_CHARS = 600;

/** A title the route accepts: a page title, not a path. */
export function isSummaryTitle(title) {
  const text = String(title ?? '');
  return (
    text.length > 0 &&
    text.length <= 255 &&
    !/[#<>[\]{}|\u0000-\u001f]/.test(text) &&
    !text.startsWith('/') &&
    !text.includes('..')
  );
}

/** The REST answer, checked: only its text and an upload.wikimedia.org image. */
export function toSummary(body) {
  const thumb = body?.thumbnail;
  const source = String(thumb?.source || '');
  let image = null;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && url.hostname === 'upload.wikimedia.org')
      image = {
        source: url.href,
        width: Number(thumb.width) || 0,
        height: Number(thumb.height) || 0,
      };
  } catch {
    /* no usable thumbnail */
  }
  const text = (value, max) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  return {
    title: text(body?.title, 255),
    description: text(body?.description, 200),
    extract: text(body?.extract, EXTRACT_CHARS),
    thumbnail: image,
  };
}

/**
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createSummaryFetcher({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const held = new Map(); // "wiki title" → {at, ttl, answer}
  const inflight = new Map();

  async function load(origin, title) {
    const path = encodeURIComponent(title.replace(/ /g, '_'));
    let response;
    try {
      response = await fetchImpl(`${origin}/api/rest_v1/page/summary/${path}`, {
        headers: {
          'User-Agent': SUMMARY_USER_AGENT,
          Accept: 'application/json',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
    } catch {
      return { status: 502, error: 'Wikipedia did not answer', ttl: 0 };
    }
    if (response.status === 404)
      return {
        status: 404,
        error: 'No such article',
        ttl: SUMMARY_MISS_TTL_MS,
      };
    if (!response.ok)
      return { status: 502, error: `Wikipedia ${response.status}`, ttl: 0 };
    const body = await response.json().catch(() => null);
    if (!body) return { status: 502, error: 'Not a summary', ttl: 0 };
    return { status: 200, body: toSummary(body), ttl: SUMMARY_TTL_MS };
  }

  return {
    /**
     * An article's summary on its wiki (enwiki unless named, one of
     * WIKIPEDIA_POINT_WIKIS): {status, body?, error?}, kept a day.
     */
    async summary(title, wikiKey = 'enwiki') {
      if (!isSummaryTitle(title))
        return { status: 400, error: 'Not an article title' };
      const origin = summaryOrigin(wikiKey);
      if (!origin) return { status: 400, error: 'Not a wiki this index has' };
      const key = `${origin} ${title}`;
      const kept = held.get(key);
      if (kept && now() - kept.at < kept.ttl) return kept.answer;
      let pending = inflight.get(key);
      if (!pending) {
        pending = load(origin, title).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const { ttl, ...answer } = await pending;
      if (ttl > 0) {
        held.delete(key);
        held.set(key, { at: now(), ttl, answer });
        if (held.size > MAX_HELD) held.delete(held.keys().next().value);
      }
      return answer;
    },
  };
}
