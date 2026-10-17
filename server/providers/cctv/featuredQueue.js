import { readRequestBody } from '../common/request.js';
import { admitSameSite } from '../common/same-site.js';
import {
  COORDINATE_QUALITIES,
  ENTRY_ID,
  parseFeaturedCatalog,
  titleMatches,
} from './featured.js';
import {
  VIDEO_ID,
  createGoogleGeocoder,
  geocodePrecision,
  pendingFile,
  roundForPrecision,
  skippedFile,
} from './featuredChannels.js';
import {
  featuredCatalogPath,
  readJsonFile,
  updateJsonFile,
} from './featuredStore.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * The review queue for streams the channel watcher found: list them, accept
 * one into the hand-checked list at a position a person confirmed, or skip
 * it for good. Routes (same-site only, like the Google proxies):
 *
 *   GET  /api/cctv/featured/pending
 *   POST /api/cctv/featured/accept  {videoId, lat, lon, coordinatesQuality,
 *                                    place, name?, category?}
 *   POST /api/cctv/featured/skip    {videoId}
 *   GET  /api/cctv/featured/locate?q=place  (a typed place for Adjust,
 *                                    geocoded and held to the precision the
 *                                    name supports, as the scan does)
 *
 * An accepted entry is built in the shape parseFeaturedCatalog reads, checked
 * by it, and appended to live-cams.json with an atomic write.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SKIPPED = 5000;
const MAX_SKIPPED_MATCHES = 500;

const clean = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Words that say what a stream is, not which one. */
const GENERIC_WORDS = new Set(
  (
    'live livestream stream streaming streams cam cams camera cameras webcam webcams ' +
    'explore org powered presented partnership with the and for from at in on of by ' +
    'to an a hd 4k uhd view views now new nest nests official channel tv youtube feed ' +
    'highlights replay daily season watch 24 7 247 our your this that is are ' +
    // Dates change from one restart to the next ("… - 17 October 2026").
    'january february march april may june july august september october ' +
    'november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'monday tuesday wednesday thursday friday saturday sunday today tonight'
  ).split(' '),
);

/** A readable cam name from a stream title. */
export function nameFromTitle(title) {
  return (
    clean(
      String(title || '')
        .replace(/[\u{1F000}-\u{1FFFF}☀-➿]/gu, ' ')
        .replace(/\b(?:LIVE|Live)\s*[:!-]?\s*/g, ' ')
        .replace(/\s*[|–—-]\s*(?:powered by\s+)?explore\.org.*$/i, '')
        .replace(/\s*[|]\s*[^|]*$/, (tail) =>
          /explore|channel|official/i.test(tail) ? '' : tail,
        )
        .replace(/^[\s,.:;–—|-]+|[\s,.:;–—|-]+$/g, ''),
      120,
    ) || clean(title, 120)
  );
}

/**
 * Match tokens for a restarted stream: the title's first two distinctive
 * words (not generic stream words, not the operator's own name).
 */
export function deriveTitleMatch(title, operator = '') {
  const operatorWords = new Set(
    String(operator)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const tokens = [];
  for (const word of String(title || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’]+/u)) {
    const token = word.replace(/['’]s$/, '').replace(/['’]/g, '');
    if (token.length < 3 || /^\d+$/.test(token)) continue;
    if (GENERIC_WORDS.has(token) || operatorWords.has(token)) continue;
    if (!tokens.includes(token)) tokens.push(token);
    if (tokens.length === 2) break;
  }
  return tokens;
}

/** A unique entry id from a name. */
export function entryIdFor(name, existing) {
  const base =
    String(name || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'featured-cam';
  let id = base;
  for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Validate an accept request against its queued stream and build the
 * catalog entry.
 * @returns {{entry: object}|{error: string}}
 */
export function entryFromPending(item, body, { existingIds = new Set() } = {}) {
  if (!item) return { error: 'That stream is not in the review queue' };
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  if (!isPlausibleLatLon(lat, lon))
    return { error: 'A plausible latitude and longitude are required' };
  const coordinatesQuality = String(body?.coordinatesQuality || '');
  if (!COORDINATE_QUALITIES.includes(coordinatesQuality))
    return {
      error: `coordinatesQuality must be one of ${COORDINATE_QUALITIES.join(', ')}`,
    };
  if (coordinatesQuality === 'operator-geotag') {
    const geotag = item.location;
    if (
      !geotag ||
      Math.abs(geotag.latitude - lat) > 1e-4 ||
      Math.abs(geotag.longitude - lon) > 1e-4
    )
      return {
        error: 'operator-geotag is only for the operator’s own geotag position',
      };
  }
  const place = clean(body?.place, 120);
  if (!place) return { error: 'A place label is required' };
  const name = clean(body?.name, 120) || nameFromTitle(item.title);
  const category =
    body?.category === undefined || body?.category === ''
      ? item.defaultCategory || 'nature'
      : String(body.category);
  if (!/^[a-z][a-z-]{0,39}$/.test(category))
    return { error: 'category must be a lowercase word' };
  const titleMatch = deriveTitleMatch(item.title, item.operator);
  if (!titleMatch.length || !titleMatches(item.title, titleMatch))
    return { error: 'The stream title has no distinctive words to follow' };
  const entry = {
    id: entryIdFor(name, existingIds),
    name,
    place,
    category,
    lat: roundForPrecision(lat, coordinatesQuality),
    lon: roundForPrecision(lon, coordinatesQuality),
    coordinatesQuality,
    operator: clean(item.operator, 120) || 'YouTube',
    ...(item.operatorUrl ? { operatorUrl: item.operatorUrl } : {}),
    youtube: {
      videoId: item.videoId,
      channelId: item.channelId,
      titleMatch,
    },
  };
  const [parsed] = parseFeaturedCatalog({ cams: [entry] });
  if (!parsed || !ENTRY_ID.test(entry.id) || !parsed.youtube.channelId)
    return { error: 'The entry would not be a valid featured cam' };
  return { entry };
}

const readPending = (sourceRoot) =>
  readJsonFile(pendingFile(sourceRoot), { items: [] }).items?.filter((item) =>
    VIDEO_ID.test(String(item?.videoId || '')),
  ) || [];

/** The queue as the panel shows it. */
export function listPending(sourceRoot) {
  return readPending(sourceRoot).map((item) => ({
    ...item,
    thumbnailUrl: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
    watchUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
  }));
}

function removeFromPending(sourceRoot, videoId) {
  return updateJsonFile(
    pendingFile(sourceRoot),
    { version: 1, items: [] },
    (document) => {
      const items = Array.isArray(document.items) ? document.items : [];
      const kept = items.filter((item) => item?.videoId !== videoId);
      document.items = kept;
      return { result: kept.length, write: kept.length !== items.length };
    },
  );
}

/**
 * Add a stream to the hand-checked list at the position in `body` (a person's
 * accept, or the triage rule's: featuredTriage.js).
 * @returns {Promise<{status: number, body: object}>}
 */
export function appendCatalogEntry(sourceRoot, item, body) {
  const videoId = item.videoId;
  return updateJsonFile(
    featuredCatalogPath(sourceRoot),
    { version: 1, cams: [] },
    (document) => {
      if (!Array.isArray(document.cams)) document.cams = [];
      if (document.cams.some((row) => row?.youtube?.videoId === videoId))
        return {
          result: { status: 409, body: { error: 'Already in the list' } },
          write: false,
        };
      const built = entryFromPending(item, body, {
        existingIds: new Set(document.cams.map((row) => row?.id)),
      });
      if (built.error)
        return { result: { status: 400, body: built }, write: false };
      document.cams.push(built.entry);
      return {
        result: { status: 200, body: { entry: built.entry } },
        write: true,
      };
    },
  );
}

/**
 * Accept a queued stream at the position in `body`.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function acceptPending(sourceRoot, body) {
  const videoId = String(body?.videoId || '');
  if (!VIDEO_ID.test(videoId))
    return { status: 400, body: { error: 'A videoId is required' } };
  const item = readPending(sourceRoot).find((row) => row.videoId === videoId);
  if (!item)
    return {
      status: 404,
      body: { error: 'That stream is not in the review queue' },
    };
  const outcome = await appendCatalogEntry(sourceRoot, item, body);
  if (outcome.status === 200 || outcome.status === 409)
    await removeFromPending(sourceRoot, videoId);
  return outcome;
}

/**
 * Skip a queued stream for good. Its title match is remembered too, so the
 * same recurring stream (a new id every day) is skipped on its own after
 * (featuredTriage.js).
 * @returns {Promise<{status: number, body: object}>}
 */
export async function skipPending(sourceRoot, body) {
  const videoId = String(body?.videoId || '');
  if (!VIDEO_ID.test(videoId))
    return { status: 400, body: { error: 'A videoId is required' } };
  const item = readPending(sourceRoot).find((row) => row.videoId === videoId);
  const titleMatch = item ? deriveTitleMatch(item.title, item.operator) : [];
  await updateJsonFile(
    skippedFile(sourceRoot),
    { version: 1, videoIds: [] },
    (document) => {
      const ids = Array.isArray(document.videoIds) ? document.videoIds : [];
      const matches = Array.isArray(document.matches) ? document.matches : [];
      const newMatch =
        item?.channelId &&
        titleMatch.length &&
        !matches.some(
          (match) =>
            match?.channelId === item.channelId &&
            match.titleMatch?.join(' ') === titleMatch.join(' '),
        );
      if (ids.includes(videoId) && !newMatch)
        return { result: false, write: false };
      document.version = 1;
      document.videoIds = ids.includes(videoId)
        ? ids
        : [...ids, videoId].slice(-MAX_SKIPPED);
      if (newMatch)
        document.matches = [
          ...matches,
          { channelId: item.channelId, titleMatch },
        ].slice(-MAX_SKIPPED_MATCHES);
      return { result: true, write: true };
    },
  );
  const remaining = await removeFromPending(sourceRoot, videoId);
  return { status: 200, body: { skipped: videoId, remaining } };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Middleware for /api/cctv/featured/*.
 * @param {{sourceRoot?: string, onAccepted?: (entry: object) => void,
 *   geocode?: (address: string) => Promise<object|null>}} [options]
 */
export function createFeaturedQueueRoutes({
  sourceRoot = process.cwd(),
  onAccepted = () => {},
  geocode = createGoogleGeocoder(),
} = {}) {
  return async function featuredQueueRoutes(req, res, next) {
    if (admitSameSite(req, res)) return;
    const route = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (route === '/pending') {
        if (req.method !== 'GET')
          return send(res, 405, { error: 'Method not allowed' });
        return send(res, 200, {
          items: listPending(sourceRoot),
          coordinateQualities: COORDINATE_QUALITIES,
        });
      }
      if (route === '/locate') {
        if (req.method !== 'GET')
          return send(res, 405, { error: 'Method not allowed' });
        const query = clean(
          new URL(req.url || '/', 'http://localhost').searchParams.get('q'),
          200,
        );
        if (query.length < 2)
          return send(res, 400, { error: 'A place name is required' });
        const result = await geocode(query);
        if (!result) return send(res, 404, { error: 'No such place found' });
        const coordinatesQuality = geocodePrecision(result, query);
        return send(res, 200, {
          lat: roundForPrecision(result.lat, coordinatesQuality),
          lon: roundForPrecision(result.lon, coordinatesQuality),
          coordinatesQuality,
          label: query,
          geocoded: result.formatted,
        });
      }
      if (route !== '/accept' && route !== '/skip') {
        if (typeof next === 'function') return next();
        return send(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'POST')
        return send(res, 405, { error: 'Method not allowed' });
      if (!/^application\/json\b/i.test(String(req.headers?.['content-type'])))
        return send(res, 415, { error: 'Send JSON' });
      let body;
      try {
        body = JSON.parse(await readRequestBody(req, MAX_BODY_BYTES));
      } catch (error) {
        return send(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
          error: 'A small JSON object is required',
        });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return send(res, 400, { error: 'A JSON object is required' });
      const outcome =
        route === '/accept'
          ? await acceptPending(sourceRoot, body)
          : await skipPending(sourceRoot, body);
      if (route === '/accept' && outcome.status === 200)
        onAccepted(outcome.body.entry);
      return send(res, outcome.status, outcome.body);
    } catch (error) {
      console.warn('[CCTV] featured review queue failed:', error?.message);
      return send(res, 500, { error: 'The review queue could not be updated' });
    }
  };
}
