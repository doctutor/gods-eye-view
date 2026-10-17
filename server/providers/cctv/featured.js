import fs from 'node:fs';
import path from 'node:path';
import {
  createChannelWatcher,
  createGoogleGeocoder,
  createYoutubeClient,
  createYoutubeQuota,
  readChannels,
} from './featuredChannels.js';
import {
  DEFAULT_FEATURED_FILE,
  FEATURED_CACHE_DIR,
  featuredCatalogPath,
  persistRestartedStream,
} from './featuredStore.js';
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
 * by title, and the new id is written back to the list. `search.list` is never
 * used: it costs 100 units and, as measured on 2026-10-14, its live filter
 * missed every one of these streams.
 *
 * The same channels, and more (channels.json), are watched for streams the
 * list does not carry yet; those wait in a review queue until a person
 * places them (featuredChannels.js, featuredQueue.js).
 *
 * Without YOUTUBE_API_KEY the cams are still served on their configured video
 * ids, with liveness unknown.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

/** The hand-checked list, relative to the application root. */
export { DEFAULT_FEATURED_FILE };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_CATALOG_BYTES = 512 * 1024;
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
  const resolved = featuredCatalogPath(sourceRoot);
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
 * the last id found for each entry, and finds an ended stream again among
 * its channel's live uploads (through the channel watcher, so a channel is
 * scanned at most once an hour for this). `onFollow` hears of every restart
 * followed, so it can be written back to the list and survive a restart.
 *
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string, now?: () => number,
 *   quota?: object, youtube?: object, watcher?: object,
 *   onFollow?: (entry: object, fromVideoId: string, toVideoId: string) => void}} [options]
 */
export function createLiveResolver({
  fetchImpl = (...args) => fetch(...args),
  apiKey = () => String(process.env.YOUTUBE_API_KEY || '').trim(),
  now = () => Date.now(),
  quota = createYoutubeQuota({ now }),
  youtube = createYoutubeClient({ fetchImpl, apiKey, quota }),
  watcher = createChannelWatcher({ youtube, quota, now }),
  onFollow = () => {},
} = {}) {
  /** entry id → the video id that last resolved for it. */
  const currentIds = new Map();
  let quotaWarned = false;

  async function lookup(videoIds) {
    const statuses = new Map();
    for (const item of await youtube.videos(videoIds)) {
      const status = videoStatus(item);
      if (status?.videoId) statuses.set(status.videoId, status);
    }
    return statuses;
  }

  /**
   * @param {Array<object>} entries - From parseFeaturedCatalog.
   * @returns {Promise<Map<string, {videoId: string, status: string, title: string}>>}
   */
  async function resolve(entries) {
    const results = new Map();
    const fallback = (entry) => ({
      videoId: currentIds.get(entry.id) || entry.youtube.videoId,
      status: 'unknown',
      title: '',
    });
    if (!youtube.hasKey()) {
      for (const entry of entries) results.set(entry.id, fallback(entry));
      return results;
    }
    try {
      const statuses = await lookup(
        entries.map(
          (entry) => currentIds.get(entry.id) || entry.youtube.videoId,
        ),
      );
      const needRescue = new Map();
      for (const entry of entries) {
        const videoId = currentIds.get(entry.id) || entry.youtube.videoId;
        const status = statuses.get(videoId) || null;
        if (status) results.set(entry.id, status);
        if (status?.status === 'live') continue;
        const { channelId } = entry.youtube;
        if (!channelId || !entry.youtube.titleMatch.length) continue;
        if (!needRescue.has(channelId)) needRescue.set(channelId, []);
        needRescue.get(channelId).push(entry);
      }
      for (const [channelId, waiting] of needRescue) {
        const streams = (
          await watcher.streamsFor(channelId, {
            maxAgeMs: CHANNEL_RESCAN_MS,
            // Only a stream that could replace a waiting entry is re-asked.
            recheck: (stream) =>
              waiting.some((entry) =>
                titleMatches(stream.title, entry.youtube.titleMatch),
              ),
          })
        ).filter((stream) => stream.usable);
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
          const resolved = {
            videoId: found.videoId,
            title: found.title,
            status: found.status,
          };
          const previous = currentIds.get(entry.id) || entry.youtube.videoId;
          currentIds.set(entry.id, found.videoId);
          results.set(entry.id, resolved);
          if (found.videoId !== previous)
            onFollow(entry, entry.youtube.videoId, found.videoId);
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
 * Build the featured-cam loader for the catalog. One resolver and one
 * channel watcher live as long as the catalog, so a restarted stream's new
 * id is remembered (and written back to the list) and channels are scanned
 * on their own schedule. The watcher runs in the background after each
 * load; it never delays the catalog. CCTV_FEATURED_WATCH=0 turns it off.
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string, now?: () => number,
 *   geocode?: (address: string) => Promise<object|null>}} [options]
 */
export function createFeaturedLoader(options = {}) {
  const now = options.now || (() => Date.now());
  let parts = null;

  /** Built on first use: the quota file lives under the app root. */
  function partsFor(sourceRoot) {
    if (parts) return parts;
    const quota = createYoutubeQuota({
      now,
      file: path.join(sourceRoot, FEATURED_CACHE_DIR, 'quota.json'),
    });
    const youtube = createYoutubeClient({
      fetchImpl: options.fetchImpl || ((...args) => fetch(...args)),
      apiKey:
        options.apiKey ||
        (() => String(process.env.YOUTUBE_API_KEY || '').trim()),
      quota,
    });
    const watcher = createChannelWatcher({
      youtube,
      quota,
      now,
      geocode: options.geocode || createGoogleGeocoder({ quota }),
      // Personal fork: the placement rule (featuredTriage.js), when given.
      triage: options.triage || null,
    });
    const resolver = createLiveResolver({
      youtube,
      watcher,
      quota,
      now,
      onFollow: (entry, fromVideoId, toVideoId) =>
        persistRestartedStream(sourceRoot, {
          entryId: entry.id,
          fromVideoId,
          toVideoId,
        })
          .then((changed) => {
            if (changed)
              console.log(
                `[CCTV] featured cam ${entry.id} follows its restarted stream ${toVideoId}`,
              );
          })
          .catch((error) =>
            console.warn(
              '[CCTV] featured cam restart not saved:',
              error?.message,
            ),
          ),
    });
    parts = { watcher, resolver };
    return parts;
  }

  return async function loadFeaturedLiveCams({
    sourceRoot = process.cwd(),
  } = {}) {
    const entries = readFeaturedCatalog(sourceRoot);
    const { watcher, resolver } = partsFor(sourceRoot);
    const resolved = entries.length
      ? await resolver.resolve(entries)
      : new Map();
    if (String(process.env.CCTV_FEATURED_WATCH || '1').trim() !== '0')
      void watcher.scanAll({
        sourceRoot,
        entries,
        channels: readChannels(sourceRoot),
      });
    if (!entries.length) return [];
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
