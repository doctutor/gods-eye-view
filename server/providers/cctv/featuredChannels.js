import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import { googleServerApiKey } from '../places/google-key.js';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  FEATURED_CACHE_DIR,
  readJsonFile,
  updateJsonFile,
  writeJsonAtomic,
} from './featuredStore.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * The featured-cam channel watcher: scans a list of operator channels for
 * live and upcoming streams and queues every one the hand-checked list does
 * not already carry, with a suggested position, for a person to accept,
 * adjust or skip (featuredQueue.js). With the owner's placement rule
 * (featuredTriage.js), a stream the rule can decide is accepted or skipped
 * on its own, and only the exceptions wait for a person.
 *
 * A scan reads a channel's uploads playlist (`playlistItems.list`, 1 unit)
 * and asks `videos.list` (1 unit per 50) only about uploads it has not seen
 * before; a finished upload is remembered and never asked about again.
 * `search.list` is never used (100 units, and it missed these streams).
 * Every call counts against a daily budget (YOUTUBE_DAILY_BUDGET, default
 * 1500 units, YouTube's day: midnight Pacific); past it, scanning stops
 * until the next day and the log says so.
 *
 * A suggested position never claims more than its source supports: the
 * operator's own geotag first, else a place named in the title or
 * description, geocoded and held to the precision both the text and the
 * geocoder support, else the channel's default place, else none.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

export const DEFAULT_CHANNELS_FILE =
  'src/data/local_data/cctv_featured/channels.json';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const IDS_PER_CALL = 50;
const MAX_API_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DAILY_BUDGET = 1500;
/** Every channel is scanned at most this often in the background. */
export const DEFAULT_SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** Never more often than this, whatever CCTV_CHANNEL_SCAN_MINUTES says. */
const MIN_SCAN_INTERVAL_MS = 60 * 60 * 1000;
/** Geocoding is a paid call; at most this many new places a day. */
const GEOCODES_PER_DAY = 60;
const DESCRIPTION_CHARS = 600;
const PRECISIONS = ['site', 'area', 'region'];

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

/** YouTube's quota day (it resets at midnight Pacific). */
export function quotaDay(epochMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  }).format(new Date(epochMs));
}

/**
 * Units spent today, kept on disk so a restart does not reset the count.
 * Every user of the shared key (the featured watcher, recorded video) counts
 * through the same file: each change re-reads it first, so two counters in
 * one process never overwrite each other's units. `feature` tallies a
 * user's own share for its own budget.
 * @param {{now?: () => number, budget?: () => number, file?: string}} options
 */
export function createYoutubeQuota({
  now = () => Date.now(),
  budget = () => {
    const value = Number(process.env.YOUTUBE_DAILY_BUDGET);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAILY_BUDGET;
  },
  file = '',
} = {}) {
  let state = { day: quotaDay(now()), units: 0, geocodes: 0, byFeature: {} };
  let stopLogged = false;

  /** The file's count when it is today's (the file wins: others count too). */
  function sync() {
    if (!file) return;
    const stored = readJsonFile(file, null);
    if (typeof stored?.day !== 'string') return;
    if (stored.day !== state.day && stored.day < state.day) return;
    state = {
      day: stored.day,
      units: Number.isFinite(stored.units) ? stored.units : 0,
      geocodes: Number.isFinite(stored.geocodes) ? stored.geocodes : 0,
      byFeature:
        stored.byFeature && typeof stored.byFeature === 'object'
          ? { ...stored.byFeature }
          : {},
    };
  }
  function roll() {
    sync();
    const today = quotaDay(now());
    if (today === state.day) return;
    console.log(`[CCTV] YouTube units used on ${state.day}: ${state.units}`);
    state = { day: today, units: 0, geocodes: 0, byFeature: {} };
    stopLogged = false;
  }
  function save() {
    if (!file) return;
    try {
      const { day, units, geocodes, byFeature } = state;
      writeJsonAtomic(file, {
        day,
        units,
        geocodes,
        ...(Object.keys(byFeature).length ? { byFeature } : {}),
      });
    } catch {
      /* the count is advisory */
    }
  }
  return {
    /** Count units against today (and against `feature`'s share). */
    spend(count = 1, feature = '') {
      roll();
      state.units += count;
      if (feature)
        state.byFeature[feature] = (state.byFeature[feature] || 0) + count;
      save();
    },
    /** Count one geocode; false once today's geocodes are used up. */
    geocode() {
      roll();
      if (state.geocodes >= GEOCODES_PER_DAY) return false;
      state.geocodes++;
      save();
      return true;
    },
    /** True past today's budget; says so once a day. */
    exhausted() {
      roll();
      const limit = budget();
      if (state.units < limit) return false;
      if (!stopLogged) {
        stopLogged = true;
        console.warn(
          `[CCTV] YouTube budget reached (${state.units} of ${limit} units on ${state.day}); channel scans stop until tomorrow`,
        );
      }
      return true;
    },
    used: () => (roll(), state.units),
    /** Today's units spent by one feature. */
    usedBy: (feature) => (roll(), state.byFeature[feature] || 0),
    day: () => (roll(), state.day),
  };
}

/** What each Data API call costs, in quota units (search.list is 100). */
export const YOUTUBE_UNIT_COST = Object.freeze({ search: 100 });

/**
 * A YouTube Data API client that counts every call at its cost.
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string,
 *   quota: ReturnType<typeof createYoutubeQuota>, feature?: string}} options
 */
export function createYoutubeClient({
  fetchImpl = (...args) => fetch(...args),
  apiKey = () => String(process.env.YOUTUBE_API_KEY || '').trim(),
  quota,
  feature = '',
}) {
  async function call(resource, params) {
    const key = apiKey();
    if (!key) throw new Error('YOUTUBE_API_KEY is not set');
    const url = new URL(`${YOUTUBE_API}/${resource}`);
    for (const [name, value] of Object.entries(params))
      url.searchParams.set(name, value);
    url.searchParams.set('key', key);
    quota?.spend(YOUTUBE_UNIT_COST[resource] ?? 1, feature);
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
  return {
    call,
    hasKey: () => Boolean(apiKey()),
    /** videos.list for any number of ids, 50 per call. */
    async videos(ids, part = 'snippet,status') {
      const items = [];
      const unique = [...new Set(ids)].filter((id) => VIDEO_ID.test(id));
      for (let i = 0; i < unique.length; i += IDS_PER_CALL)
        items.push(
          ...(await call('videos', {
            part,
            id: unique.slice(i, i + IDS_PER_CALL).join(','),
            maxResults: String(IDS_PER_CALL),
          })),
        );
      return items;
    },
    /** The newest uploads of a channel (its uploads playlist), ids only. */
    async uploads(channelId) {
      const items = await call('playlistItems', {
        part: 'contentDetails',
        playlistId: `UU${channelId.slice(2)}`,
        maxResults: String(IDS_PER_CALL),
      });
      return items
        .map((item) => String(item?.contentDetails?.videoId || ''))
        .filter((id) => VIDEO_ID.test(id));
    },
  };
}

/** A place a channel vouches for: a default, or a location rule's. */
function parsePlace(place) {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  if (
    !place ||
    !isPlausibleLatLon(lat, lon) ||
    !PRECISIONS.includes(place.coordinatesQuality)
  )
    return null;
  return {
    lat,
    lon,
    coordinatesQuality: place.coordinatesQuality,
    label: clean(place.label, 120),
    // A bounded campus under about a kilometre (an aquarium, a zoo, a lodge).
    ...(place.campus === true ? { campus: true } : {}),
  };
}

/**
 * A channel's automatic-triage settings (featuredTriage.js): `accept` says
 * how precise a place must be to be accepted without a person ('site';
 * 'area', which takes a campus area too; or 'never'), `maxPerDay` caps the
 * accepts a day, and `locations` place streams by title on a channel whose
 * streams are at several places.
 */
function parseAutoTriage(value) {
  if (!value || typeof value !== 'object') return null;
  const accept = ['site', 'area', 'never'].includes(value.accept)
    ? value.accept
    : undefined;
  // Personal fork: false ignores the location tagged on each video.
  const videoLocation = value.videoLocation === false ? false : undefined;
  const maxPerDay = Number(value.maxPerDay);
  const locations = (Array.isArray(value.locations) ? value.locations : [])
    .map((row) => {
      const place = parsePlace(row);
      const titleMatch = (Array.isArray(row?.titleMatch) ? row.titleMatch : [])
        .map((token) => clean(token, 80).toLowerCase())
        .filter(Boolean);
      return place && titleMatch.length ? { ...place, titleMatch } : null;
    })
    .filter(Boolean);
  return {
    ...(accept ? { accept } : {}),
    ...(Number.isInteger(maxPerDay) && maxPerDay >= 0 && maxPerDay <= 50
      ? { maxPerDay }
      : {}),
    ...(locations.length ? { locations } : {}),
    ...(videoLocation === false ? { videoLocation } : {}),
  };
}

/**
 * Validate the watched-channel list; a malformed entry is dropped alone.
 * @param {object} document - Parsed channels.json.
 */
export function parseChannels(document) {
  const rows = Array.isArray(document?.channels) ? document.channels : [];
  const seen = new Set();
  const channels = [];
  for (const row of rows) {
    const channelId = String(row?.channelId || '');
    if (!CHANNEL_ID.test(channelId) || seen.has(channelId)) continue;
    seen.add(channelId);
    const defaultPlace = parsePlace(row?.defaultPlace);
    const autoTriage = parseAutoTriage(row?.autoTriage);
    channels.push({
      channelId,
      operator: clean(row?.operator, 120) || 'YouTube',
      operatorUrl: httpsUrl(row?.operatorUrl),
      defaultCategory:
        clean(row?.defaultCategory, 40)
          .toLowerCase()
          .replace(/[^a-z-]/g, '') || 'nature',
      defaultPlace,
      ...(autoTriage ? { autoTriage } : {}),
    });
  }
  return channels;
}

/** Read the watched-channel list from disk; missing means none. */
export function readChannels(sourceRoot = process.cwd()) {
  const file = process.env.CCTV_FEATURED_CHANNELS_FILE || DEFAULT_CHANNELS_FILE;
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(sourceRoot, file);
  return parseChannels(readJsonFile(resolved, null, 256 * 1024));
}

/** What one videos.list item says about a stream, for the queue. */
export function streamFromItem(item, channelId) {
  if (!item || typeof item !== 'object') return null;
  const videoId = String(item.id || '');
  if (!VIDEO_ID.test(videoId)) return null;
  const broadcast = item.snippet?.liveBroadcastContent;
  const status =
    broadcast === 'live'
      ? 'live'
      : broadcast === 'upcoming'
        ? 'upcoming'
        : 'offline';
  const publicEmbeddable =
    item.status?.privacyStatus === 'public' && item.status?.embeddable === true;
  const location = item.recordingDetails?.location;
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  return {
    videoId,
    channelId: String(item.snippet?.channelId || channelId || ''),
    channelTitle: clean(item.snippet?.channelTitle, 120),
    title: clean(item.snippet?.title, 200),
    description: String(item.snippet?.description || '').slice(
      0,
      DESCRIPTION_CHARS,
    ),
    publishedAt: clean(item.snippet?.publishedAt, 40),
    status,
    usable: publicEmbeddable && status !== 'offline',
    location:
      location && isPlausibleLatLon(lat, lon)
        ? {
            latitude: lat,
            longitude: lon,
            ...(item.recordingDetails?.locationDescription
              ? {
                  description: clean(
                    item.recordingDetails.locationDescription,
                    120,
                  ),
                }
              : {}),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Place names in titles and descriptions.

const US_STATES =
  'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
const REGIONS =
  'Alberta|British Columbia|Manitoba|Ontario|Quebec|Nova Scotia|New Brunswick|Newfoundland|Saskatchewan|Yukon|Canada|Mexico|Belize|Costa Rica|Panama|Brazil|Peru|Chile|Argentina|Iceland|Norway|Sweden|Finland|Denmark|Germany|Netherlands|Belgium|France|Spain|Portugal|Italy|Switzerland|Austria|Poland|Ireland|Scotland|England|Wales|United Kingdom|UK|Kenya|Tanzania|South Africa|Botswana|Namibia|Zambia|Zimbabwe|Uganda|Rwanda|Madagascar|India|Nepal|Japan|Taiwan|Philippines|Indonesia|Australia|New Zealand|USA|U\\.S\\.A?';
const PLACE_WORDS =
  'National Park|National Wildlife Refuge|National Monument|Wildlife Refuge|State Park|Provincial Park|Nature Reserve|Game Reserve|Reserve|Sanctuary|Preserve|Refuge|Island|Islands|Bay|Lake|River|Falls|Beach|Harbor|Harbour|Mountain|Mountains|Valley|County|Canyon|Glacier|Reef|Sound|Strait|Peninsula|Zoo|Aquarium|Hatchery|Lighthouse|Observatory';
const STATE_OR_REGION = new RegExp(`\\b(?:${US_STATES}|${REGIONS})\\b`);
const PLACE_WORD = new RegExp(`\\b(?:${PLACE_WORDS})\\b`);
/** Facilities an operator names as the spot itself. */
const FACILITY = new RegExp(
  '\\b(?:Falls|Zoo|Aquarium|Hatchery|Lighthouse|Observatory|Bridge|Dam|Pier|Dock|Marina|Museum|Center|Centre|Tower|Building|Hall|Campus|Station)\\b',
);
/** Words around a place name that are not part of it. */
const NOISE =
  /\b(?:live|livestream|live stream|cam|cams|camera|webcam|stream|streaming|hd|4k|24\/7|powered by|explore\.org|explore|presented by|in partnership with|view|views|now)\b/gi;
/** One word of a place name. */
const NAME_WORD = "(?:(?:St|Mt|Ft|Pt|Ste)\\.|[A-Z][\\w'’-]*)";
/**
 * A run of capitalized words with the small connectors place names use; a
 * period ends it unless it abbreviates (St., Mt.).
 */
const NAME_RUN = new RegExp(
  `(${NAME_WORD}(?:(?:,\\s*|\\s+(?:of|de|la|du|del|and|in|on|the|des)\\s+|\\s+)${NAME_WORD}){0,7})`,
  'g',
);

function placeish(text) {
  return (
    /,\s*[A-Z]/.test(text) ||
    STATE_OR_REGION.test(text) ||
    PLACE_WORD.test(text)
  );
}

function tidy(text) {
  return clean(
    String(text || '')
      .replace(/[\u{1F000}-\u{1FFFF}☀-➿]/gu, ' ')
      .replace(NOISE, ' ')
      .replace(/^[\s,.:;–—|-]+|[\s,.:;–—|-]+$/g, '')
      .replace(/^(?:the|in|at|near|from)\s+/i, '')
      .replace(/\s{2,}/g, ' '),
    120,
  );
}

/**
 * Place names a stream's title and description give, most specific source
 * first (title segments, then "in/at/near/from …" phrases in the
 * description). Only phrases that look like places are kept.
 * @returns {string[]}
 */
export function extractPlaceCandidates(title, description) {
  const found = [];
  const add = (text) => {
    const candidate = tidy(text);
    if (candidate.length < 3 || !placeish(candidate)) return;
    if (!found.some((seen) => seen.toLowerCase() === candidate.toLowerCase()))
      found.push(candidate);
  };
  const segments = String(title || '')
    .split(/\s+[–—|-]\s+|\s*\|\s*|\s*[(){}[\]]\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  // Later title segments name the place ("Osprey Nest – Charlo, Montana").
  for (const segment of segments.slice(1)) add(segment);
  for (const segment of segments) {
    const at = /\b(?:in|at|near|from|on)\s+(.+)$/.exec(segment);
    if (at) add(at[1]);
  }
  const text = String(description || '').slice(0, DESCRIPTION_CHARS);
  const phrase =
    /\b(?:located (?:in|at|on|near)|live from|streaming from|based in|situated (?:in|on)|nestled in|in|at|near|from|on)\s+(?:the\s+)?/g;
  let match;
  while ((match = phrase.exec(text))) {
    const rest = text.slice(match.index + match[0].length);
    NAME_RUN.lastIndex = 0;
    const run = NAME_RUN.exec(rest);
    if (run && run.index === 0) add(run[1]);
    if (found.length >= 6) break;
  }
  return found.slice(0, 6);
}

/** The most precise a phrase itself supports, before any geocoder. */
export function textPrecision(phrase) {
  const text = String(phrase || '');
  if (/^\d+\s+\S/.test(text)) return 'site';
  if (FACILITY.test(text)) return 'site';
  if (/,\s*[A-Z]/.test(text) || PLACE_WORD.test(text)) return 'area';
  // A state or country on its own, or "… in <state>".
  return 'region';
}

const REGION_TYPES = new Set([
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'natural_feature',
  'colloquial_area',
  'continent',
]);
const SITE_TYPES = new Set([
  'street_address',
  'premise',
  'subpremise',
  'establishment',
  'point_of_interest',
  'tourist_attraction',
  'zoo',
  'aquarium',
  'museum',
  'airport',
]);

const coarser = (a, b) =>
  PRECISIONS[Math.max(PRECISIONS.indexOf(a), PRECISIONS.indexOf(b))];

/**
 * The precision a geocoder result supports: Google's location_type
 * (ROOFTOP → site, GEOMETRIC_CENTER / RANGE_INTERPOLATED → area,
 * APPROXIMATE → region), no finer than what the result is (a state or a bay
 * is a region, a town or park an area), one step coarser on a partial
 * match, and never finer than the phrase it came from.
 */
export function geocodePrecision(result, phrase) {
  const byType =
    {
      ROOFTOP: 'site',
      RANGE_INTERPOLATED: 'area',
      GEOMETRIC_CENTER: 'area',
      APPROXIMATE: 'region',
    }[result?.locationType] || 'region';
  const types = Array.isArray(result?.types) ? result.types : [];
  const byKind = types.some((type) => REGION_TYPES.has(type))
    ? 'region'
    : types.some((type) => SITE_TYPES.has(type))
      ? 'site'
      : 'area';
  let precision = coarser(coarser(byType, byKind), textPrecision(phrase));
  if (result?.partialMatch)
    precision =
      PRECISIONS[
        Math.min(PRECISIONS.length - 1, PRECISIONS.indexOf(precision) + 1)
      ];
  return precision;
}

/** Coordinates no finer than their precision claims. */
export function roundForPrecision(value, precision) {
  const places = { site: 5, 'operator-geotag': 5, area: 3, region: 2 }[
    precision
  ];
  const factor = 10 ** (places ?? 2);
  return Math.round(Number(value) * factor) / factor;
}

/**
 * Google geocoding with the server key (the same key and endpoint the
 * /api/google/geocode proxy uses), remembered per phrase.
 * @returns {(address: string) => Promise<object|null>}
 */
export function createGoogleGeocoder({
  fetchImpl = (...args) => fetch(...args),
  apiKey = googleServerApiKey,
  quota,
} = {}) {
  const remembered = new Map();
  return async function geocode(address) {
    const phrase = clean(address, 200);
    if (!phrase) return null;
    if (remembered.has(phrase)) return remembered.get(phrase);
    const key = String(apiKey() || '').trim();
    if (!key || (quota && !quota.geocode())) return null;
    const url = new URL(GEOCODE_API);
    url.searchParams.set('address', phrase);
    url.searchParams.set('key', key);
    let result = null;
    try {
      const response = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      const body = await readResponseJsonCapped(response, MAX_API_BYTES);
      const first = body?.status === 'OK' ? body.results?.[0] : null;
      const lat = Number(first?.geometry?.location?.lat);
      const lon = Number(first?.geometry?.location?.lng);
      if (first && isPlausibleLatLon(lat, lon))
        result = {
          lat,
          lon,
          locationType: String(first.geometry.location_type || ''),
          types: Array.isArray(first.types) ? first.types.map(String) : [],
          partialMatch: first.partial_match === true,
          formatted: clean(first.formatted_address, 160),
        };
    } catch {
      return null; // not remembered: a network failure may pass
    }
    remembered.set(phrase, result);
    return result;
  };
}

/**
 * A suggested position for a queued stream, or kind 'none'.
 * @param {object} stream - From streamFromItem.
 * @param {object|null} channel - From parseChannels.
 * @param {{geocode?: (address: string) => Promise<object|null>}} options
 */
export async function suggestPosition(stream, channel, { geocode } = {}) {
  const location = stream?.location;
  if (location && isPlausibleLatLon(location.latitude, location.longitude))
    return {
      kind: 'geotag',
      lat: roundForPrecision(location.latitude, 'operator-geotag'),
      lon: roundForPrecision(location.longitude, 'operator-geotag'),
      coordinatesQuality: 'operator-geotag',
      label: location.description || 'Operator geotag',
    };
  if (geocode) {
    for (const phrase of extractPlaceCandidates(
      stream?.title,
      stream?.description,
    ).slice(0, 2)) {
      const result = await geocode(phrase);
      if (!result) continue;
      const precision = geocodePrecision(result, phrase);
      return {
        kind: 'text',
        lat: roundForPrecision(result.lat, precision),
        lon: roundForPrecision(result.lon, precision),
        coordinatesQuality: precision,
        label: phrase,
        geocoded: result.formatted,
      };
    }
  }
  const place = channel?.defaultPlace;
  if (place)
    return {
      kind: 'default',
      lat: place.lat,
      lon: place.lon,
      coordinatesQuality: place.coordinatesQuality,
      label: place.label || channel.operator,
    };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The watcher.

export function pendingFile(sourceRoot) {
  return path.join(sourceRoot, FEATURED_CACHE_DIR, 'pending.json');
}
export function skippedFile(sourceRoot) {
  return path.join(sourceRoot, FEATURED_CACHE_DIR, 'skipped.json');
}

/** True when every match token appears in the title (as featured.js). */
function titleMatches(title, tokens) {
  if (!tokens?.length) return false;
  const lower = String(title || '').toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

/**
 * @param {{youtube: ReturnType<typeof createYoutubeClient>,
 *   quota: ReturnType<typeof createYoutubeQuota>,
 *   geocode?: (address: string) => Promise<object|null>,
 *   triage?: {review: Function},
 *   now?: () => number, intervalMs?: () => number}} options - Personal
 *   fork: with `triage` (featuredTriage.js), the queued and the new streams
 *   are decided by the owner's placement rule, and only its exceptions wait
 *   for a person.
 */
export function createChannelWatcher({
  youtube,
  quota,
  geocode,
  triage = null,
  now = () => Date.now(),
  intervalMs = () => {
    const minutes = Number(process.env.CCTV_CHANNEL_SCAN_MINUTES);
    return Number.isFinite(minutes) && minutes > 0
      ? Math.max(MIN_SCAN_INTERVAL_MS, minutes * 60 * 1000)
      : DEFAULT_SCAN_INTERVAL_MS;
  },
} = {}) {
  /** channel id → {at, streams} from its last scan. */
  const scans = new Map();
  /** video id → finished (never asked about again). */
  const finished = new Set();
  /** video id → its last stream record (live or upcoming). */
  const known = new Map();
  let running = null;

  /**
   * One channel's live and upcoming streams. Uploads never seen are asked
   * about; a stream already seen live is asked about again only when
   * `recheck` wants it (the resolver, about a stream that could replace an
   * ended one), so a routine rescan costs one unit.
   */
  async function scanChannel(channelId, { recheck = () => false } = {}) {
    if (quota.exhausted()) throw new Error('YouTube daily budget reached');
    const ids = await youtube.uploads(channelId);
    const ask = ids.filter(
      (id) => !finished.has(id) && (!known.has(id) || recheck(known.get(id))),
    );
    const items = ask.length
      ? await youtube.videos(ask, 'snippet,status,recordingDetails')
      : [];
    const answered = new Set();
    for (const item of items) {
      const stream = streamFromItem(item, channelId);
      if (!stream) continue;
      answered.add(stream.videoId);
      if (stream.status === 'offline') {
        finished.add(stream.videoId);
        known.delete(stream.videoId);
      } else known.set(stream.videoId, stream);
    }
    // Asked about but not answered: deleted or private.
    for (const id of ask) if (!answered.has(id)) finished.add(id);
    const streams = ids.map((id) => known.get(id)).filter(Boolean);
    scans.set(channelId, { at: now(), streams });
    return streams;
  }

  /**
   * A channel's streams, rescanned when its last scan is older than maxAgeMs.
   * Never throws: a failed or over-budget scan answers what is known.
   */
  async function streamsFor(channelId, { maxAgeMs, recheck } = {}) {
    const last = scans.get(channelId);
    if (last && now() - last.at < maxAgeMs) return last.streams;
    try {
      return await scanChannel(channelId, { recheck });
    } catch (error) {
      if (!/budget/.test(error.message))
        console.warn('[CCTV] featured channel scan failed:', error.message);
      scans.set(channelId, { at: now(), streams: last?.streams || [] });
      return last?.streams || [];
    }
  }

  /**
   * Scan every watched channel that is due and queue new streams.
   * @param {{sourceRoot: string, entries: Array<object>,
   *   channels: Array<object>}} context
   * @returns {Promise<{scanned: number, queued: number}>}
   */
  async function scanAll({ sourceRoot, entries, channels }) {
    if (!youtube.hasKey() || !channels.length) return { scanned: 0, queued: 0 };
    const knownIds = new Set(entries.map((entry) => entry.youtube.videoId));
    const skipped = new Set(
      readJsonFile(skippedFile(sourceRoot), { videoIds: [] }).videoIds || [],
    );
    let scanned = 0;
    const fresh = [];
    for (const channel of channels) {
      // A channel scanned recently (here or by a restart lookup) is judged
      // on what that scan found.
      const last = scans.get(channel.channelId);
      const due = !last || now() - last.at >= intervalMs();
      if (due && quota.exhausted()) break;
      const streams = due
        ? await streamsFor(channel.channelId, { maxAgeMs: 0 })
        : last.streams;
      if (due) scanned++;
      const sameChannel = entries.filter(
        (entry) => entry.youtube.channelId === channel.channelId,
      );
      for (const stream of streams) {
        if (!stream.usable) continue;
        if (knownIds.has(stream.videoId) || skipped.has(stream.videoId))
          continue;
        // A restart of a listed cam: featured.js follows it.
        if (
          sameChannel.some((entry) =>
            titleMatches(stream.title, entry.youtube.titleMatch),
          )
        )
          continue;
        fresh.push({ stream, channel });
      }
    }
    let queued = 0;
    let decided = '';
    const rule = triage && triage.enabled?.() !== false ? triage : null;
    if (fresh.length || rule) {
      const pending = readJsonFile(pendingFile(sourceRoot), { items: [] });
      const already = new Set(
        (pending.items || []).map((item) => item?.videoId),
      );
      const additions = [];
      for (const { stream, channel } of fresh) {
        if (already.has(stream.videoId)) continue;
        already.add(stream.videoId);
        additions.push({
          videoId: stream.videoId,
          channelId: channel.channelId,
          channelTitle: stream.channelTitle,
          operator: channel.operator,
          operatorUrl: channel.operatorUrl,
          defaultCategory: channel.defaultCategory,
          title: stream.title,
          description: stream.description,
          publishedAt: stream.publishedAt,
          status: stream.status,
          location: stream.location,
          suggestion: await suggestPosition(stream, channel, { geocode }),
          queuedAt: new Date(now()).toISOString(),
        });
      }
      if (rule) {
        // The queue as it stands and the new streams, through the rule.
        const outcome = await rule.review({
          sourceRoot,
          channels,
          entries,
          additions,
        });
        queued = outcome.queued;
        if (outcome.accepted.length || outcome.skipped)
          decided = `, accepted ${outcome.accepted.length} and skipped ${outcome.skipped} by the placement rule`;
      } else if (additions.length)
        queued = await updateJsonFile(
          pendingFile(sourceRoot),
          { version: 1, items: [] },
          (document) => {
            const items = Array.isArray(document.items) ? document.items : [];
            const present = new Set(items.map((item) => item?.videoId));
            const added = additions.filter(
              (item) => !present.has(item.videoId),
            );
            document.version = 1;
            document.items = [...items, ...added];
            return { result: added.length, write: added.length > 0 };
          },
        );
    }
    if (scanned || decided)
      console.log(
        `[CCTV] featured channels: scanned ${scanned}, queued ${queued} new stream(s) for review${decided}; YouTube units today ${quota.used()}`,
      );
    return { scanned, queued };
  }

  return {
    streamsFor,
    /** Background scan; at most one at a time, never rejects. */
    scanAll(context) {
      if (!running)
        running = scanAll(context)
          .catch((error) => {
            console.warn(
              '[CCTV] featured channel watch failed:',
              error.message,
            );
            return { scanned: 0, queued: 0 };
          })
          .finally(() => {
            running = null;
          });
      return running;
    },
  };
}
