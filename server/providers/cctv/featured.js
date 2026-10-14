import fs from 'node:fs';
import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * Featured live cams: public-interest streams (nest cams, wildlife, nature,
 * reefs) that their operators publish on YouTube.
 *
 * The list is data, hand-checked: every entry is placed at the precision its
 * operator publishes and never finer, so a nest an operator describes only as
 * "near Decorah, Iowa" stays a town-level pin. Playback is YouTube's own
 * embedded player in the panel; the scene only ever sees the thumbnail
 * YouTube publishes for the stream.
 *
 * Liveness comes from the YouTube Data API (`videos.list`, 1 quota unit per 50
 * videos). Operators restart long streams under new video ids, so an entry
 * whose stream has ended is looked for again among its channel's most recent
 * uploads (`playlistItems.list` on the uploads playlist, also 1 unit), matched
 * by title. `search.list` is never used: it costs 100 units and, as measured
 * on 2026-10-14, its live filter missed every one of these streams.
 *
 * Without YOUTUBE_API_KEY the cams are still served on their configured video
 * ids, with liveness unknown.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

/** The hand-checked list, relative to the application root. */
export const DEFAULT_FEATURED_FILE =
  'src/data/local_data/cctv_featured/live-cams.json';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const IDS_PER_CALL = 50;
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;
/** A channel is re-scanned for a restarted stream at most this often. */
export const CHANNEL_RESCAN_MS = 60 * 60 * 1000;

export const COORDINATE_QUALITIES = Object.freeze([
  // The operator names the exact spot (a building, a dock, a falls).
  'site',
  // The operator names a town, park or island; the pin is its centre.
  'area',
  // The operator names only a region ("the Chesapeake Bay in Maryland").
  'region',
  // The operator's own geotag on the stream.
  'operator-geotag',
]);

/** The statuses a featured cam can carry, from the API or its absence. */
export const LIVE_STATUSES = Object.freeze([
  'live',
  'upcoming',
  'offline',
  'unknown',
]);

const clean = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

/**
 * Validate the hand-checked list. A malformed entry is dropped on its own so
 * one typo never hides the rest.
 * @param {object} document - Parsed live-cams.json.
 * @returns {Array<object>} Valid entries.
 */
export function parseFeaturedCatalog(document) {
  const rows = Array.isArray(document?.cams) ? document.cams : [];
  const seen = new Set();
  const entries = [];
  for (const row of rows) {
    const id = String(row?.id || '');
    if (!ENTRY_ID.test(id) || seen.has(id)) continue;
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    if (!isPlausibleLatLon(lat, lon)) continue;
    const videoId = String(row?.youtube?.videoId || '');
    if (!VIDEO_ID.test(videoId)) continue;
    const channelId = String(row?.youtube?.channelId || '');
    const titleMatch = (
      Array.isArray(row?.youtube?.titleMatch) ? row.youtube.titleMatch : []
    )
      .map((token) => clean(token, 80).toLowerCase())
      .filter(Boolean);
    const coordinatesQuality = COORDINATE_QUALITIES.includes(
      row?.coordinatesQuality,
    )
      ? row.coordinatesQuality
      : 'area';
    const mountHeightM = Number(row?.mountHeightM);
    const headingDeg = Number(row?.headingDeg);
    seen.add(id);
    entries.push({
      id,
      name: clean(row?.name, 120) || id,
      place: clean(row?.place, 120),
      category: clean(row?.category, 40).toLowerCase() || 'nature',
      lat,
      lon,
      coordinatesQuality,
      operator: clean(row?.operator, 120) || 'YouTube',
      operatorUrl: httpsUrl(row?.operatorUrl),
      mountHeightM: Number.isFinite(mountHeightM) ? mountHeightM : NaN,
      headingDeg: Number.isFinite(headingDeg) ? headingDeg : NaN,
      youtube: {
        videoId,
        // A restarted stream can only be found again with both.
        channelId: CHANNEL_ID.test(channelId) ? channelId : '',
        titleMatch: CHANNEL_ID.test(channelId) ? titleMatch : [],
      },
    });
  }
  return entries;
}

/** Read the list from disk; a missing or malformed file means no featured cams. */
export function readFeaturedCatalog(sourceRoot = process.cwd()) {
  const file = process.env.CCTV_FEATURED_FILE || DEFAULT_FEATURED_FILE;
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(sourceRoot, file);
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_CATALOG_BYTES) {
      console.warn('[CCTV] featured cam list is too large:', resolved);
      return [];
    }
    return parseFeaturedCatalog(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT')
      console.warn(
        '[CCTV] featured cam list unreadable:',
        error?.message || error,
      );
    return [];
  }
}

/** What one `videos.list` item says about a stream. */
export function videoStatus(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.status?.privacyStatus && item.status.privacyStatus !== 'public')
    return null;
  if (item.status && item.status.embeddable === false) return null;
  const broadcast = item.snippet?.liveBroadcastContent;
  return {
    videoId: String(item.id || ''),
    title: clean(item.snippet?.title, 200),
    status:
      broadcast === 'live'
        ? 'live'
        : broadcast === 'upcoming'
          ? 'upcoming'
          : 'offline',
  };
}

/** True when every match token appears in the title. */
export function titleMatches(title, tokens) {
  if (!tokens?.length) return false;
  const lower = String(title || '').toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

/**
 * Create a resolver that turns entries into their current stream. It keeps
 * the last id found for each entry and when each channel was last scanned,
 * so a stream that restarted is followed without rescanning every refresh.
 *
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string, now?: () => number}} [options]
 */
export function createLiveResolver({
  fetchImpl = (...args) => fetch(...args),
  apiKey = () => String(process.env.YOUTUBE_API_KEY || '').trim(),
  now = () => Date.now(),
} = {}) {
  /** entry id → the video id that last resolved for it. */
  const currentIds = new Map();
  /** channel id → epoch ms of the last uploads scan. */
  const scannedAt = new Map();
  let quotaWarned = false;

  async function api(resource, params, key) {
    const url = new URL(`${YOUTUBE_API}/${resource}`);
    for (const [name, value] of Object.entries(params))
      url.searchParams.set(name, value);
    url.searchParams.set('key', key);
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    const body = await readResponseJsonCapped(response, MAX_API_BYTES);
    if (!response.ok || body?.error) {
      const reason = body?.error?.errors?.[0]?.reason || response.status;
      throw new Error(`YouTube ${resource} failed: ${reason}`);
    }
    return Array.isArray(body?.items) ? body.items : [];
  }

  async function lookup(videoIds, key) {
    const statuses = new Map();
    const unique = [...new Set(videoIds)];
    for (let i = 0; i < unique.length; i += IDS_PER_CALL) {
      const items = await api(
        'videos',
        {
          part: 'snippet,status',
          id: unique.slice(i, i + IDS_PER_CALL).join(','),
          maxResults: String(IDS_PER_CALL),
        },
        key,
      );
      for (const item of items) {
        const status = videoStatus(item);
        if (status?.videoId) statuses.set(status.videoId, status);
      }
    }
    return statuses;
  }

  /** The live (else upcoming) uploads of one channel, newest first. */
  async function channelStreams(channelId, key) {
    const uploads = await api(
      'playlistItems',
      {
        part: 'contentDetails',
        playlistId: `UU${channelId.slice(2)}`,
        maxResults: String(IDS_PER_CALL),
      },
      key,
    );
    const ids = uploads
      .map((item) => String(item?.contentDetails?.videoId || ''))
      .filter((id) => VIDEO_ID.test(id));
    const statuses = await lookup(ids, key);
    return ids
      .map((id) => statuses.get(id))
      .filter((status) => status && status.status !== 'offline');
  }

  /**
   * @param {Array<object>} entries - From parseFeaturedCatalog.
   * @returns {Promise<Map<string, {videoId: string, status: string, title: string}>>}
   */
  async function resolve(entries) {
    const results = new Map();
    const key = apiKey();
    const fallback = (entry) => ({
      videoId: currentIds.get(entry.id) || entry.youtube.videoId,
      status: 'unknown',
      title: '',
    });
    if (!key) {
      for (const entry of entries) results.set(entry.id, fallback(entry));
      return results;
    }
    try {
      const statuses = await lookup(
        entries.map(
          (entry) => currentIds.get(entry.id) || entry.youtube.videoId,
        ),
        key,
      );
      const needRescue = new Map();
      for (const entry of entries) {
        const videoId = currentIds.get(entry.id) || entry.youtube.videoId;
        const status = statuses.get(videoId) || null;
        if (status) results.set(entry.id, status);
        if (status?.status === 'live') continue;
        const { channelId } = entry.youtube;
        if (!channelId || !entry.youtube.titleMatch.length) continue;
        if (now() - (scannedAt.get(channelId) ?? -Infinity) < CHANNEL_RESCAN_MS)
          continue;
        if (!needRescue.has(channelId)) needRescue.set(channelId, []);
        needRescue.get(channelId).push(entry);
      }
      for (const [channelId, waiting] of needRescue) {
        scannedAt.set(channelId, now());
        let streams = [];
        try {
          streams = await channelStreams(channelId, key);
        } catch (error) {
          console.warn('[CCTV] featured channel scan failed:', error.message);
          continue;
        }
        for (const entry of waiting) {
          const found =
            streams.find(
              (stream) =>
                stream.status === 'live' &&
                titleMatches(stream.title, entry.youtube.titleMatch),
            ) ||
            streams.find((stream) =>
              titleMatches(stream.title, entry.youtube.titleMatch),
            );
          if (!found) continue;
          currentIds.set(entry.id, found.videoId);
          results.set(entry.id, found);
        }
      }
      quotaWarned = false;
    } catch (error) {
      if (!quotaWarned)
        console.warn('[CCTV] featured liveness unavailable:', error.message);
      quotaWarned = true;
      for (const entry of entries)
        if (!results.has(entry.id)) results.set(entry.id, fallback(entry));
    }
    return results;
  }

  return { resolve };
}

/** YouTube's published thumbnail for a stream; the `_live` variant tracks it while live. */
export function youtubeThumbnailUrl(videoId, status) {
  return `https://i.ytimg.com/vi/${videoId}/${status === 'live' ? 'hqdefault_live' : 'hqdefault'}.jpg`;
}

/**
 * One featured entry and its resolved stream as a catalog source. An entry
 * whose video is gone (deleted, private, no longer embeddable) and was not
 * found again on its channel is left out.
 */
export function featuredToSource(entry, resolved) {
  if (!resolved) return null;
  const { videoId, status } = resolved;
  if (!VIDEO_ID.test(videoId)) return null;
  return {
    id: `yt-${entry.id}`,
    name: entry.name,
    city: entry.place || 'Featured live cam',
    cityId: `featured-${entry.category}`,
    provider: entry.operator,
    credit: 'YouTube',
    lat: entry.lat,
    lon: entry.lon,
    headingDeg: entry.headingDeg,
    headingConfidence: Number.isFinite(entry.headingDeg) ? 'high' : 'low',
    mountHeightM: entry.mountHeightM,
    // A nest or reef cam sees metres, not a street block.
    rangeM: 120,
    feedType: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    snapshotUrl: youtubeThumbnailUrl(videoId, status),
    sourceKind: 'youtube-live',
    license: 'Operator stream, shown in the embedded YouTube player',
    code: entry.name,
    embed: { provider: 'youtube', videoId },
    liveStatus: LIVE_STATUSES.includes(status) ? status : 'unknown',
    category: entry.category,
    coordinatesQuality: entry.coordinatesQuality,
    operatorUrl: entry.operatorUrl,
    publishSignal: 'operator-channel',
    licenseClass: 'embed-only',
  };
}

/**
 * Build the featured-cam loader for the catalog. One resolver lives as long
 * as the catalog, so a restarted stream's new id is remembered.
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string, now?: () => number}} [options]
 */
export function createFeaturedLoader(options = {}) {
  const resolver = createLiveResolver(options);
  return async function loadFeaturedLiveCams({ sourceRoot } = {}) {
    const entries = readFeaturedCatalog(sourceRoot);
    if (!entries.length) return [];
    const resolved = await resolver.resolve(entries);
    const sources = entries
      .map((entry) => featuredToSource(entry, resolved.get(entry.id)))
      .filter(Boolean);
    const live = sources.filter((s) => s.liveStatus === 'live').length;
    console.log(
      `[CCTV] featured live cams: ${sources.length} listed, ${live} live now`,
    );
    return sources;
  };
}
