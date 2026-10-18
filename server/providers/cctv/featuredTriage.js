import fs from 'node:fs';
import path from 'node:path';
import { haversineKm } from '../common/geo.js';
import { titleMatches } from './featured.js';
import { pendingFile, quotaDay, skippedFile } from './featuredChannels.js';
import { appendCatalogEntry, deriveTitleMatch } from './featuredQueue.js';
import {
  FEATURED_CACHE_DIR,
  readJsonFile,
  updateJsonFile,
  writeJsonAtomic,
} from './featuredStore.js';

/**
 * The owner's placement rule, applied to every stream the channel watcher
 * finds, so most never wait for a person: a live cam joins the Cameras
 * layer only where its pin is accurate.
 *
 * - Accepted on its own: a stream placed by a location rule or by its
 *   channel's default place at site precision (a building, a nest, a dock),
 *   or at area precision when that area is a bounded campus under about a
 *   kilometre (`campus: true`: an aquarium, a zoo, a lodge). Never a town or
 *   a region. At most a channel's `maxPerDay` (6) a day, against a runaway
 *   channel.
 * - Skipped on its own: a channel marked `accept: 'never'` (NASA), an event
 *   title (a press conference, a briefing, a launch, a webinar), a stream
 *   that recurs (the same title match as a listed cam, a queued stream or a
 *   skipped one: WildEarth's daily "SafariLIVE Sunrise - <date>"), and
 *   anything whose place is unknown or only a region.
 * - Held for a person, with the reason on its card: a channel whose place is
 *   only an area, and positions read from an operator geotag or from the
 *   title (automated geotags are what stacks pins at city centres).
 * - The video's own location (the place the channel tagged on that video,
 *   YouTube's recordingDetails, which the scan already reads) decides
 *   when it is precise: given to the fifth decimal (about a metre), not
 *   labelled only with a place the title names (YouTube's place picker
 *   labels its centroid with the place's name: "Charlo"), and no other
 *   channel's cam or stream within 30 m of it (a centroid is shared; a
 *   camera's own spot is not). A precise one is accepted on
 *   its own where the channel has no place or only a coarser one; one that
 *   lies outside the channel's place (by its precision: 1 km for a site,
 *   1.5 km for a campus, 10 km for an area, 150 km for a region) is held.
 *   `autoTriage.videoLocation: false` turns this off for a channel.
 * - A channel's `autoTriage.subjects` (explore.org's) place streams from
 *   their title by what the title names: a nest or an exhibit is a site,
 *   accepted when the title's place geocodes to site precision; a park or a
 *   reserve is an area, accepted only when the geocoder's viewport for it is
 *   under about a kilometre across (CAMPUS_SPAN_M). Otherwise the stream
 *   waits for a person, as before.
 *
 * Every automatic accept and skip, and every new hold, is a line in
 * .gev-cache/cctv-featured/triage.log, so the owner can audit them.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

/** Titles of events at a studio, not a place to watch. */
export const EVENT_TITLE =
  /\b(?:press conference|news conference|press briefing|briefing|launch(?:es)?|webinar)\b/i;
export const DEFAULT_DAILY_CAP = 6;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_SKIPPED = 5000;

/**
 * Why a stream was decided as it was. Accepts and skips are the journal's;
 * holds are shown on the card (src/ui/cctvPending.js).
 */
export const TRIAGE_CODES = Object.freeze({
  accept: [
    'site-default',
    'campus-default',
    'location-rule',
    'video-location',
    'subject-site',
    'subject-campus',
  ],
  skip: [
    'never',
    'event',
    'recurring-entry',
    'recurring-pending',
    'recurring-skipped',
    'no-location',
    'region-only',
  ],
  hold: [
    'video-location-disagrees',
    'area-not-campus',
    'site-only',
    'geotag',
    'text-place',
    'cap',
    'invalid-entry',
  ],
});

export const triageLogFile = (sourceRoot) =>
  path.join(sourceRoot, FEATURED_CACHE_DIR, 'triage.log');
const stateFile = (sourceRoot) =>
  path.join(sourceRoot, FEATURED_CACHE_DIR, 'triage.json');

/** How far a video's location may lie from the channel's place, by its precision. */
export const AGREEMENT_RADIUS_M = Object.freeze({
  site: 1_000,
  campus: 1_500,
  area: 10_000,
  region: 150_000,
});
/** A park or reserve named in a title is a campus when it is no wider than this. */
export const CAMPUS_SPAN_M = 1_000;

/** What a title's place is by the channel's words: 'site', 'area' or null. */
export function subjectOf(title, subjects) {
  const text = String(title || '').toLowerCase();
  const names = (list) =>
    (list || []).some((word) =>
      new RegExp(`\\b${word.replace(/[^a-z -]/g, '')}(?:e?s)?\\b`).test(text),
    );
  if (names(subjects?.site)) return 'site';
  if (names(subjects?.area)) return 'area';
  return null;
}

/** Another channel's pin this close to a video's location means a shared centroid. */
export const STACK_RADIUS_M = 30;

const sameTokens = (a, b) =>
  a.length > 0 && a.length === b.length && a.every((t) => b.includes(t));

/** The place a stream would be pinned at: a location rule first, else the channel default. */
export function placeFor(item, channel) {
  const rule = (channel?.autoTriage?.locations || []).find((location) =>
    titleMatches(item?.title, location.titleMatch),
  );
  if (rule) return { ...rule, source: 'rule' };
  if (channel?.defaultPlace)
    return { ...channel.defaultPlace, source: 'default' };
  return null;
}

/**
 * The location the channel tagged on this video, if any: the scan's own
 * copy (full precision), else the geotag suggestion (rounded to 5 places).
 */
export function videoLocationOf(item) {
  const own = item?.location;
  const lat = Number(own?.latitude);
  const lon = Number(own?.longitude);
  if (own && Number.isFinite(lat) && Number.isFinite(lon))
    return { lat, lon, label: own.description || '' };
  const suggestion = item?.suggestion;
  if (
    suggestion?.kind === 'geotag' &&
    Number.isFinite(Number(suggestion.lat)) &&
    Number.isFinite(Number(suggestion.lon))
  )
    return {
      lat: Number(suggestion.lat),
      lon: Number(suggestion.lon),
      label: suggestion.label || '',
    };
  return null;
}

const metres = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
const toFifthDecimal = (value) =>
  Math.abs(value * 1e4 - Math.round(value * 1e4)) > 1e-6;
const words = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a video's location is a camera's own spot: given to the fifth
 * decimal, not labelled only with a place its title names, and not shared
 * by another channel's listed cam or queued stream.
 */
export function isPreciseVideoLocation(location, item, { entries, earlier }) {
  if (!location) return false;
  if (!toFifthDecimal(location.lat) && !toFifthDecimal(location.lon))
    return false;
  const label = words(location.label);
  const title = new Set(words(item?.title));
  if (label.length && label.every((word) => title.has(word))) return false;
  const channelId = item?.channelId;
  const pins = [
    ...entries
      .filter((entry) => entry?.youtube?.channelId !== channelId)
      .map((entry) => ({ lat: Number(entry.lat), lon: Number(entry.lon) })),
    ...earlier
      .filter((other) => other.channelId !== channelId)
      .map(videoLocationOf)
      .filter(Boolean),
  ].filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lon));
  return !pins.some((pin) => metres(pin, location) <= STACK_RADIUS_M);
}

function agreementRadius(place) {
  if (place.coordinatesQuality === 'area' && place.campus)
    return AGREEMENT_RADIUS_M.campus;
  return (
    AGREEMENT_RADIUS_M[place.coordinatesQuality] ?? AGREEMENT_RADIUS_M.area
  );
}

/**
 * The rule for one stream.
 * @param {object} item - A queue item (featuredChannels.js scanAll).
 * @param {object|undefined} channel - From parseChannels.
 * @param {{entries?: Array<object>, earlier?: Array<object>,
 *   skippedMatches?: Array<{channelId: string, titleMatch: string[]}>,
 *   acceptedToday?: number}} context - Listed cams, the streams queued
 *   before this one, remembered skips, and this channel's accepts today.
 * @returns {{action: 'accept'|'skip'|'hold', code: string,
 *   position?: object}}
 */
export function triageDecision(
  item,
  channel,
  { entries = [], earlier = [], skippedMatches = [], acceptedToday = 0 } = {},
) {
  const title = String(item?.title || '');
  const channelId = item?.channelId;
  const auto = channel?.autoTriage || {};
  if (auto.accept === 'never') return { action: 'skip', code: 'never' };
  if (EVENT_TITLE.test(title)) return { action: 'skip', code: 'event' };
  // A stream that recurs is decided once.
  if (
    entries.some(
      (entry) =>
        entry?.youtube?.channelId === channelId &&
        titleMatches(title, entry.youtube.titleMatch),
    )
  )
    return { action: 'skip', code: 'recurring-entry' };
  if (
    skippedMatches.some(
      (match) =>
        match.channelId === channelId && titleMatches(title, match.titleMatch),
    )
  )
    return { action: 'skip', code: 'recurring-skipped' };
  const tokens = deriveTitleMatch(title, item?.operator);
  if (
    earlier.some(
      (other) =>
        other.channelId === channelId &&
        other.videoId !== item?.videoId &&
        sameTokens(deriveTitleMatch(other.title, other.operator), tokens),
    )
  )
    return { action: 'skip', code: 'recurring-pending' };

  const place = placeFor(item, channel);
  const video = auto.videoLocation === false ? null : videoLocationOf(item);
  if (place && video && metres(place, video) > agreementRadius(place))
    return { action: 'hold', code: 'video-location-disagrees' };
  const capped = acceptedToday >= (auto.maxPerDay ?? DEFAULT_DAILY_CAP);
  // The video's own precise spot, where the channel's place says less.
  const byVideo = () => {
    if (capped) return { action: 'hold', code: 'cap' };
    return {
      action: 'accept',
      code: 'video-location',
      position: {
        lat: video.lat,
        lon: video.lon,
        coordinatesQuality: 'operator-geotag',
        label: video.label || place?.label || channel?.operator || '',
      },
    };
  };
  const precise =
    video && isPreciseVideoLocation(video, item, { entries, earlier });
  if (place) {
    const coarse =
      place.coordinatesQuality === 'region' ||
      (place.coordinatesQuality === 'area' &&
        (!place.campus || auto.accept === 'site'));
    if (coarse && precise) return byVideo();
    if (place.coordinatesQuality === 'region')
      return { action: 'skip', code: 'region-only' };
    if (place.coordinatesQuality === 'area' && !place.campus)
      return { action: 'hold', code: 'area-not-campus' };
    if (place.coordinatesQuality === 'area' && auto.accept === 'site')
      return { action: 'hold', code: 'site-only' };
    if (capped) return { action: 'hold', code: 'cap' };
    const position = {
      lat: place.lat,
      lon: place.lon,
      coordinatesQuality: place.coordinatesQuality,
      label: place.label || channel?.operator || '',
    };
    return {
      action: 'accept',
      code:
        place.source === 'rule'
          ? 'location-rule'
          : place.coordinatesQuality === 'site'
            ? 'site-default'
            : 'campus-default',
      position,
    };
  }
  if (precise) return byVideo();
  // No place the channel vouches for: what the scan suggested.
  const suggestion = item?.suggestion || { kind: 'none' };
  if (suggestion.kind === 'none' || !Number.isFinite(Number(suggestion.lat)))
    return { action: 'skip', code: 'no-location' };
  if (suggestion.coordinatesQuality === 'region')
    return { action: 'skip', code: 'region-only' };
  // The channel's words for what its titles name (explore.org's rules).
  const subject =
    suggestion.kind === 'text' ? subjectOf(title, auto.subjects) : null;
  const bySubject = (code, coordinatesQuality) =>
    capped
      ? { action: 'hold', code: 'cap' }
      : {
          action: 'accept',
          code,
          position: {
            lat: Number(suggestion.lat),
            lon: Number(suggestion.lon),
            coordinatesQuality,
            label: suggestion.label || channel?.operator || '',
          },
        };
  if (subject === 'site' && suggestion.coordinatesQuality === 'site')
    return bySubject('subject-site', 'site');
  if (
    subject === 'area' &&
    ['site', 'area'].includes(suggestion.coordinatesQuality) &&
    Number(suggestion.spanM) <= CAMPUS_SPAN_M
  )
    return bySubject('subject-campus', 'area');
  return {
    action: 'hold',
    code: suggestion.kind === 'geotag' ? 'geotag' : 'text-place',
  };
}

function appendLog(sourceRoot, lines) {
  if (!lines.length) return;
  const file = triageLogFile(sourceRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Kept small: past the limit, the older half goes.
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(
        file,
        text.slice(text.indexOf('\n', text.length / 2) + 1),
      );
    }
    fs.appendFileSync(
      file,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
  } catch (error) {
    console.warn('[CCTV] featured triage log not written:', error?.message);
  }
}

/**
 * @param {{now?: () => number, enabled?: () => boolean}} [options] -
 *   `enabled` is asked on every scan (CCTV_FEATURED_TRIAGE=0 turns the rule
 *   off, and every found stream waits for a person again).
 */
export function createFeaturedTriage({
  now = () => Date.now(),
  enabled = () => true,
} = {}) {
  /**
   * Decide the queued streams and the new ones: accept and skip what the
   * rule decides, and keep the rest queued with their reason.
   * @param {{sourceRoot: string, channels: Array<object>,
   *   entries: Array<object>, additions?: Array<object>}} context
   * @returns {Promise<{accepted: Array<object>, skipped: number,
   *   queued: number}>} The entries accepted, the streams skipped, and the
   *   new streams queued for a person.
   */
  async function review({ sourceRoot, channels, entries, additions = [] }) {
    const byChannel = new Map(channels.map((c) => [c.channelId, c]));
    const skippedDoc = readJsonFile(skippedFile(sourceRoot), {});
    const skippedMatches = Array.isArray(skippedDoc.matches)
      ? skippedDoc.matches
      : [];
    const queuedItems = (
      readJsonFile(pendingFile(sourceRoot), { items: [] }).items || []
    ).filter((item) => item?.videoId);
    const day = quotaDay(now());
    const stored = readJsonFile(stateFile(sourceRoot), null);
    const state =
      stored?.day === day &&
      stored.accepts &&
      typeof stored.accepts === 'object'
        ? stored
        : { day, accepts: {} };
    const listed = [...entries];
    const at = new Date(now()).toISOString();
    const kept = [];
    const decided = new Set();
    const holds = new Map();
    const skips = [];
    const accepted = [];
    const log = [];
    let changedState = false;
    const rows = [
      ...queuedItems.map((item) => ({ item, queued: true })),
      ...additions.map((item) => ({ item, queued: false })),
    ];
    for (const { item, queued } of rows) {
      const channel = byChannel.get(item.channelId);
      let decision = triageDecision(item, channel, {
        entries: listed,
        earlier: kept,
        skippedMatches,
        acceptedToday: state.accepts[item.channelId] || 0,
      });
      if (decision.action === 'accept') {
        // operator-geotag is checked against the item's own location: for a
        // video-located stream, the location that placed it.
        const source =
          decision.code === 'video-location' && !item.location
            ? {
                ...item,
                location: {
                  latitude: decision.position.lat,
                  longitude: decision.position.lon,
                },
              }
            : item;
        const outcome = await appendCatalogEntry(sourceRoot, source, {
          lat: decision.position.lat,
          lon: decision.position.lon,
          coordinatesQuality: decision.position.coordinatesQuality,
          place: decision.position.label,
        });
        if (outcome.status === 200) {
          const entry = outcome.body.entry;
          accepted.push(entry);
          listed.push(entry);
          state.accepts[item.channelId] =
            (state.accepts[item.channelId] || 0) + 1;
          changedState = true;
          decided.add(item.videoId);
          log.push({
            at,
            action: 'accept',
            code: decision.code,
            videoId: item.videoId,
            channelId: item.channelId,
            title: item.title,
            entryId: entry.id,
            lat: entry.lat,
            lon: entry.lon,
            coordinatesQuality: entry.coordinatesQuality,
          });
          continue;
        }
        if (outcome.status === 409) {
          decided.add(item.videoId);
          continue;
        }
        decision = { action: 'hold', code: 'invalid-entry' };
      }
      if (decision.action === 'skip') {
        decided.add(item.videoId);
        skips.push(item.videoId);
        log.push({
          at,
          action: 'skip',
          code: decision.code,
          videoId: item.videoId,
          channelId: item.channelId,
          title: item.title,
        });
        continue;
      }
      const triage = { code: decision.code, at };
      if (item.triage?.code !== decision.code) {
        holds.set(item.videoId, triage);
        log.push({
          at,
          action: 'hold',
          code: decision.code,
          videoId: item.videoId,
          channelId: item.channelId,
          title: item.title,
        });
      }
      kept.push(queued ? item : { ...item, triage });
    }
    const fresh = kept.filter(
      (item) => !queuedItems.some((q) => q.videoId === item.videoId),
    );
    const queued = await updateJsonFile(
      pendingFile(sourceRoot),
      { version: 1, items: [] },
      (document) => {
        const items = Array.isArray(document.items) ? document.items : [];
        let write = false;
        const next = [];
        for (const item of items) {
          if (decided.has(item?.videoId)) {
            write = true;
            continue;
          }
          const triage = holds.get(item?.videoId);
          if (triage) {
            next.push({ ...item, triage });
            write = true;
          } else next.push(item);
        }
        const present = new Set(next.map((item) => item?.videoId));
        const added = fresh.filter((item) => !present.has(item.videoId));
        if (added.length) write = true;
        document.version = 1;
        document.items = [...next, ...added];
        return { result: added.length, write };
      },
    );
    if (skips.length)
      await updateJsonFile(
        skippedFile(sourceRoot),
        { version: 1, videoIds: [] },
        (document) => {
          const ids = Array.isArray(document.videoIds) ? document.videoIds : [];
          const add = skips.filter((id) => !ids.includes(id));
          document.version = 1;
          document.videoIds = [...ids, ...add].slice(-MAX_SKIPPED);
          return { result: add.length, write: add.length > 0 };
        },
      );
    if (changedState) writeJsonAtomic(stateFile(sourceRoot), state);
    appendLog(sourceRoot, log);
    return { accepted, skipped: skips.length, queued };
  }

  return { review, enabled };
}
