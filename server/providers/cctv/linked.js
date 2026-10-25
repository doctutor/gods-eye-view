import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { parseOverpassUpstreams } from '../overpass/constants.js';
import { isPlausibleLatLon } from './normalize.js';
import { withObservations } from './observed.js';

/**
 * Linked webcams: places whose public map record names a webcam.
 *
 * - OpenStreetMap: every object tagged `contact:webcam` (about ten thousand
 *   worldwide: harbours, ski areas, squares, viewpoints, observatories), via
 *   the configured Overpass (OVERPASS_UPSTREAMS, as every other Overpass
 *   use in the app; no public mirror of its own), or QLever's OpenStreetMap
 *   index when those fail or none is set. ODbL; the shared OpenStreetMap
 *   credit shows while any is loaded.
 * - Wikidata: every item with a "webcam URL" (P4238) and coordinates (about
 *   six hundred notable landmarks). CC0.
 *
 * Most links are operator pages, so the camera is a pin that opens the
 * operator's site; a direct image, HLS stream or YouTube link plays in the
 * app. The pack contributes nothing to the capped startup catalog and
 * everything to the proximity index, so these appear only near the view.
 *
 * Both lists change slowly: each is fetched at most once a week and kept on
 * disk (.gev-cache/cctv-linked/). The catalog never waits for a fetch
 * (stale-while-revalidate): a stale copy is served at once while one
 * refresh runs in the background, bounded by LINKED_REFRESH_DEADLINE_MS,
 * and after a failure the next waits LINKED_RETRY_MS. With no copy at all
 * the pack is empty until its first fetch lands; the catalog's next
 * rebuild (it retries an empty pack within minutes) picks the new list up.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export const LINKED_CACHE_DIR = path.join('.gev-cache', 'cctv-linked');
/** A cached list is refetched after this long. */
export const LINKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed fetch, the next attempt waits this long. */
export const LINKED_RETRY_MS = 60 * 60 * 1000;
/**
 * A background refresh gives up after this long, whatever it was waiting
 * on (every Overpass endpoint and QLever's attempts could otherwise take
 * half an hour).
 */
export const LINKED_REFRESH_DEADLINE_MS = 5 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_QLEVER_BYTES = 32 * 1024 * 1024;
const OVERPASS_TIMEOUT_MS = 180 * 1000;
const QLEVER_TIMEOUT_MS = 300 * 1000;
const QLEVER_CONNECT_ATTEMPTS = 4;
/** Connection failures worth a fresh attempt; HTTP answers never retry. */
const QLEVER_RETRY_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);
const WIKIDATA_TIMEOUT_MS = 90 * 1000;

export const OVERPASS_WEBCAM_QUERY =
  '[out:json][timeout:240];nwr["contact:webcam"];out tags center;';
/**
 * QLever's SPARQL endpoint over the OpenStreetMap planet (osm2rdf): the
 * fallback when every Overpass mirror fails. Tag keys are predicates named
 * after their wiki page, colons and all (`Key:contact:webcam`); objects are
 * https://www.openstreetmap.org/{node,way,relation}/{id}. The index stores
 * full geometries but no centroid, so the query asks for geof:centroid.
 */
export const QLEVER_OSM_ENDPOINT = 'https://qlever.dev/api/osm-planet';
/** The tags osmToSources() and osmCategory() read; contact:webcam first. */
export const QLEVER_TAG_KEYS = Object.freeze([
  'contact:webcam',
  'name',
  'name:en',
  'official_name',
  'description',
  'addr:city',
  'is_in:city',
  'place',
  'natural',
  'leisure',
  'tourism',
  'landuse',
  'sport',
  'aerialway',
  'piste',
  'piste:type',
  'harbour',
  'seamark',
  'aeroway',
  'man_made',
  'amenity',
  'historic',
  'highway',
  'building',
  'shop',
]);
const OSM_KEY_IRI = 'https://www.openstreetmap.org/wiki/Key:';
/**
 * One row per object and tag. (One OPTIONAL per tag also works but runs
 * slower: each joins against that key's whole planet-wide index.)
 */
export const QLEVER_WEBCAM_QUERY = [
  'PREFIX geo: <http://www.opengis.net/ont/geosparql#>',
  'PREFIX geof: <http://www.opengis.net/def/function/geosparql/>',
  'SELECT ?osm ?centroid ?key ?value WHERE {',
  `  ?osm <${OSM_KEY_IRI}contact:webcam> ?webcam .`,
  '  OPTIONAL { ?osm geo:hasGeometry/geo:asWKT ?wkt }',
  '  BIND(geof:centroid(?wkt) AS ?centroid)',
  `  VALUES ?key { ${QLEVER_TAG_KEYS.map((key) => `<${OSM_KEY_IRI}${key}>`).join(' ')} }`,
  '  ?osm ?key ?value .',
  '}',
].join('\n');
export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_WEBCAM_QUERY =
  'SELECT ?item ?itemLabel ?url ?coord WHERE { ?item wdt:P4238 ?url; wdt:P625 ?coord . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }';
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 (+https://github.com/doctutor/gods-eye-view)';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * What a webcam link points at, and how the app can show it.
 * @param {string} value
 * @returns {{kind: 'image'|'hls'|'youtube'|'link', url: string, videoId?: string}|null}
 *   Null for anything that is not a usable https/http link, or a Windy page
 *   (windy.js covers those).
 */
export function classifyWebcamUrl(value) {
  const raw = String(value || '')
    .split(';')[0]
    .trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'windy.com' || host.endsWith('.windy.com')) return null;
  if (YOUTUBE_HOSTS.has(host)) {
    const videoId =
      host === 'youtu.be'
        ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
        : url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|live|shorts)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    if (videoId && /^[\w-]{11}$/.test(videoId))
      return { kind: 'youtube', url: url.href, videoId };
    return { kind: 'link', url: url.href };
  }
  const file = url.pathname.toLowerCase();
  if (/\.m3u8$/.test(file) && url.protocol === 'https:')
    return { kind: 'hls', url: url.href };
  if (/\.(?:jpe?g|png|gif|webp)$/.test(file))
    return { kind: 'image', url: url.href };
  return { kind: 'link', url: url.href };
}

const clean = (value, max = 120) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The pose and playback fields for one classified link. */
function feedFields(classified) {
  switch (classified.kind) {
    case 'image':
      return {
        feedType: 'image',
        url: classified.url,
        snapshotUrl: classified.url,
      };
    case 'hls':
      return { feedType: 'hls', url: classified.url, snapshotUrl: '' };
    case 'youtube':
      return {
        feedType: 'youtube',
        url: classified.url,
        snapshotUrl: `https://i.ytimg.com/vi/${classified.videoId}/hqdefault.jpg`,
        embed: { provider: 'youtube', videoId: classified.videoId },
        liveStatus: 'unknown',
      };
    default:
      // A page the operator hosts: a pin that opens it, no frame.
      return { feedType: 'link', url: '', snapshotUrl: '' };
  }
}

/** OSM tags → a category word (what the place is, not what the camera is). */
export function osmCategory(tags = {}) {
  const t = tags;
  if (t.natural === 'beach' || t.leisure === 'beach_resort') return 'beach';
  if (t.natural === 'peak' || t.natural === 'volcano') return 'mountain';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (/^(?:ski|winter_sports)$/.test(String(t.landuse || t.sport || '')))
    return 'ski';
  if (t.aerialway || t.piste || t['piste:type']) return 'ski';
  if (t.harbour || t.leisure === 'marina' || t.seamark) return 'port';
  if (t.aeroway) return 'airport';
  if (t.man_made === 'observatory' || t.man_made === 'telescope')
    return 'observatory';
  if (t.amenity === 'place_of_worship' || t.historic) return 'landmark';
  if (t.tourism) return 'landmark';
  if (t.highway) return 'traffic';
  if (t.place) return 'village';
  if (t.natural) return 'landscape';
  if (t.leisure || t.sport) return 'sportArea';
  if (t.building || t.amenity || t.shop) return 'building';
  return 'webcam';
}

/**
 * Normalize Overpass elements tagged contact:webcam.
 * @param {Array<object>} elements - `out tags center` elements.
 * @returns {Array<object>}
 */
export function osmToSources(elements) {
  const sources = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    const tags = element?.tags || {};
    const classified = classifyWebcamUrl(tags['contact:webcam']);
    if (!classified) continue;
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!isPlausibleLatLon(lat, lon)) continue;
    const type = String(element.type || '');
    const osmId = Number(element.id);
    if (!/^(?:node|way|relation)$/.test(type) || !Number.isInteger(osmId))
      continue;
    const name =
      clean(tags.name || tags['name:en'] || tags.official_name) ||
      clean(tags.description, 80) ||
      `OpenStreetMap ${type} ${osmId}`;
    const place = clean(
      tags['addr:city'] || tags['is_in:city'] || tags.place || '',
      80,
    );
    sources.push({
      id: `osm-webcam-${type[0]}${osmId}`,
      name,
      city: place || 'Linked webcam',
      cityId: 'osm-webcams',
      provider: 'OpenStreetMap',
      credit: '© OpenStreetMap contributors',
      lat,
      lon,
      headingDeg: NaN,
      headingConfidence: 'low',
      rangeM: 150,
      sourceKind: 'osm-webcam',
      license:
        'Webcam link from OpenStreetMap (ODbL); the feed belongs to its operator',
      code: name.toUpperCase(),
      category: osmCategory(tags),
      coordinatesQuality: 'site',
      operatorUrl: classified.url,
      publishSignal: 'operator-page',
      licenseClass:
        classified.kind === 'youtube' ? 'embed-only' : 'display-only',
      ...feedFields(classified),
    });
  }
  return sources;
}

/**
 * Normalize Wikidata SPARQL rows (item, itemLabel, url, coord).
 * @param {Array<object>} bindings - `results.bindings`.
 * @returns {Array<object>}
 */
export function wikidataToSources(bindings) {
  const sources = [];
  const seen = new Set();
  /** Links per item, so each item's ids stay stable as the list changes. */
  const perItem = new Map();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const qid = /\/(Q\d+)$/.exec(String(row?.item?.value || ''))?.[1];
    if (!qid) continue;
    const classified = classifyWebcamUrl(row?.url?.value);
    if (!classified) continue;
    const point = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(
      String(row?.coord?.value || ''),
    );
    if (!point) continue;
    const lon = Number(point[1]);
    const lat = Number(point[2]);
    if (!isPlausibleLatLon(lat, lon)) continue;
    // One item can list several webcams; keep each distinct link.
    const key = `${qid}|${classified.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nth = perItem.get(qid) ?? 0;
    perItem.set(qid, nth + 1);
    const id = `wd-webcam-${qid}-${nth}`;
    const name = clean(row?.itemLabel?.value) || qid;
    sources.push({
      id,
      name,
      city: 'Linked webcam',
      cityId: 'wikidata-webcams',
      provider: 'Wikidata',
      credit: 'Wikidata (CC0)',
      lat,
      lon,
      headingDeg: NaN,
      headingConfidence: 'low',
      rangeM: 150,
      sourceKind: 'wikidata-webcam',
      license:
        'Webcam link from Wikidata (CC0); the feed belongs to its operator',
      code: name.toUpperCase(),
      category: 'landmark',
      coordinatesQuality: 'site',
      operatorUrl: classified.url,
      publishSignal: 'operator-page',
      licenseClass:
        classified.kind === 'youtube' ? 'embed-only' : 'display-only',
      ...feedFields(classified),
    });
  }
  return sources;
}

/**
 * QLever SPARQL rows (see QLEVER_WEBCAM_QUERY; one per object and tag) →
 * Overpass-shaped elements for osmToSources(): type, id, tags and the
 * centroid as lat/lon (absent when the object has none, so osmToSources()
 * drops it).
 * @param {Array<object>} bindings - `results.bindings`.
 * @returns {Array<object>}
 */
export function qleverToElements(bindings) {
  const wanted = new Set(QLEVER_TAG_KEYS);
  const elements = new Map();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const match =
      /^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/(\d{1,15})$/.exec(
        String(row?.osm?.value || ''),
      );
    if (!match) continue;
    const ref = `${match[1]}/${match[2]}`;
    let element = elements.get(ref);
    if (!element) {
      element = { type: match[1], id: Number(match[2]), tags: {} };
      elements.set(ref, element);
    }
    const point = /^POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(
      String(row?.centroid?.value || ''),
    );
    if (point && !('lat' in element)) {
      element.lon = Number(point[1]);
      element.lat = Number(point[2]);
    }
    const iri = String(row?.key?.value || '');
    const key = iri.startsWith(OSM_KEY_IRI)
      ? iri.slice(OSM_KEY_IRI.length)
      : '';
    const value = row?.value?.value;
    if (wanted.has(key) && typeof value === 'string' && !(key in element.tags))
      element.tags[key] = value;
  }
  return [...elements.values()];
}

/**
 * POST a form over node:https and read at most maxBytes of the answer.
 * QLever can take 20–30 s to accept a connection, past fetch()'s fixed 10 s
 * connect timeout, so this path does not use fetch(). Redirects are not
 * followed (a 3xx comes back as its status). `signal` aborts it.
 * @returns {Promise<{status: number, text: string}>}
 */
export function postForm(
  url,
  body,
  { headers = {}, timeoutMs, maxBytes, signal },
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    let settled = false;
    const onAbort = () =>
      request.destroy(signal.reason || new Error('aborted'));
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        if (Number(response.headers['content-length']) > maxBytes) {
          request.destroy(new Error('response too large'));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) request.destroy(new Error('response too large'));
          else chunks.push(chunk);
        });
        response.on('error', (error) => finish(reject, error));
        response.on('aborted', () =>
          finish(reject, new Error('response aborted')),
        );
        response.on('end', () =>
          finish(resolve, {
            status: response.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error('timed out')),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (error) => finish(reject, error));
    request.end(body);
  });
}

/**
 * Overpass endpoints: the configured chain (OVERPASS_UPSTREAMS, read as the
 * Overpass proxy reads it), else none: then QLever alone.
 */
export function overpassEndpoints(env = process.env) {
  return parseOverpassUpstreams(env.OVERPASS_UPSTREAMS);
}

/** A per-call timeout that the refresh's own deadline can cut short. */
const within = (ms, signal) =>
  signal
    ? AbortSignal.any([AbortSignal.timeout(ms), signal])
    : AbortSignal.timeout(ms);

/**
 * The pack loader. Returns an empty capped list whose `everything` holds all
 * linked webcams, so the proximity index gets them and the startup catalog
 * stays as it was; it never waits for a fetch. `loader.settled()` resolves
 * once no refresh is running (tests, and a caller that wants to wait), and
 * `loader.status()` says each list's age and refresh.
 * @param {{fetchImpl?: typeof fetch, qleverRequest?: typeof postForm,
 *   now?: () => number, cacheDir?: string, env?: object,
 *   deadlineMs?: number}} [options]
 */
export function createLinkedLoader({
  fetchImpl = (...args) => fetch(...args),
  qleverRequest = postForm,
  now = () => Date.now(),
  cacheDir,
  env = process.env,
  deadlineMs = LINKED_REFRESH_DEADLINE_MS,
} = {}) {
  /**
   * name → {data: {at, sources} | null, read (disk read once), refreshing
   * (the running refresh's promise), failedAt, error, retryAt}.
   */
  const lists = new Map();
  const listState = (name) => {
    if (!lists.has(name))
      lists.set(name, {
        data: null,
        read: false,
        refreshing: null,
        failedAt: null,
        error: null,
        retryAt: -Infinity,
      });
    return lists.get(name);
  };

  function cacheFile(sourceRoot, name) {
    return path.join(
      cacheDir || path.join(sourceRoot, LINKED_CACHE_DIR),
      `${name}.json`,
    );
  }

  function readCache(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isFinite(parsed?.at) || !Array.isArray(parsed?.sources))
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeCache(file, payload) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(payload));
    } catch (error) {
      console.warn('[CCTV] linked webcam cache not written:', error?.message);
    }
  }

  async function fetchOsm(signal) {
    let lastError = null;
    for (const endpoint of overpassEndpoints(env)) {
      if (signal?.aborted) throw signal.reason;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(OVERPASS_WEBCAM_QUERY)}`,
          signal: within(OVERPASS_TIMEOUT_MS, signal),
          redirect: 'error',
        });
        const text = await readText(response);
        if (!response.ok) throw new Error(`Overpass ${response.status}`);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed?.elements) || parsed.remark)
          throw new Error('Overpass returned no element list');
        return osmToSources(parsed.elements);
      } catch (error) {
        lastError = error;
      }
    }
    // Every endpoint failed, or none is configured: the same objects from
    // QLever's planet index.
    if (signal?.aborted) throw signal.reason;
    try {
      return await fetchQlever(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `${lastError?.message || 'No Overpass endpoint'}; QLever: ${error?.message}`,
      );
    }
  }

  async function fetchQlever(signal) {
    let answer;
    for (let attempt = 1; !answer; attempt++) {
      if (signal?.aborted) throw signal.reason;
      try {
        answer = await qleverRequest(
          QLEVER_OSM_ENDPOINT,
          `query=${encodeURIComponent(QLEVER_WEBCAM_QUERY)}`,
          {
            headers: {
              Accept: 'application/sparql-results+json',
              'User-Agent': USER_AGENT,
            },
            timeoutMs: QLEVER_TIMEOUT_MS,
            maxBytes: MAX_QLEVER_BYTES,
            signal,
          },
        );
      } catch (error) {
        // The handshake can outlast the OS's own connect timeout (about
        // 21 s on Windows); a fresh connection usually gets through.
        if (attempt >= QLEVER_CONNECT_ATTEMPTS) throw error;
        if (!QLEVER_RETRY_CODES.has(error?.code)) throw error;
      }
    }
    const { status, text } = answer;
    if (!(status >= 200 && status < 300)) throw new Error(`QLever ${status}`);
    if (typeof text !== 'string' || text.length > MAX_QLEVER_BYTES)
      throw new Error('response too large');
    let bindings;
    try {
      bindings = JSON.parse(text)?.results?.bindings;
    } catch {
      throw new Error('QLever returned malformed JSON');
    }
    if (!Array.isArray(bindings) || !bindings.length)
      throw new Error('QLever returned no rows');
    return osmToSources(qleverToElements(bindings));
  }

  async function fetchWikidata(signal) {
    const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(WIKIDATA_WEBCAM_QUERY)}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': USER_AGENT,
      },
      signal: within(WIKIDATA_TIMEOUT_MS, signal),
      redirect: 'error',
    });
    const text = await readText(response);
    if (!response.ok) throw new Error(`Wikidata ${response.status}`);
    return wikidataToSources(JSON.parse(text)?.results?.bindings);
  }

  async function readText(response) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BYTES) throw new Error('response too large');
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('response too large');
    return text;
  }

  /**
   * One refresh of a list in the background: one at a time, given up at
   * the deadline (every request it made is aborted, so nothing outlives
   * it), a failure waiting LINKED_RETRY_MS before the next.
   */
  function refresh(state, file, name, fetcher) {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`no answer within ${Math.round(deadlineMs / 1000)} s`),
        ),
      deadlineMs,
    );
    timer.unref?.();
    state.refreshing = (async () => {
      try {
        const sources = await fetcher(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        const payload = { at: now(), sources };
        state.data = payload;
        state.failedAt = null;
        state.error = null;
        state.retryAt = -Infinity;
        writeCache(file, payload);
        console.log(`[CCTV] Loaded ${name} webcam links: ${sources.length}`);
      } catch (error) {
        const reason = controller.signal.aborted
          ? controller.signal.reason
          : error;
        state.failedAt = now();
        state.error = String(reason?.message || reason).slice(0, 200);
        state.retryAt = state.failedAt + LINKED_RETRY_MS;
        console.warn(
          `[CCTV] ${name} webcam links unavailable (${state.error}); ` +
            (state.data
              ? `serving ${state.data.sources.length} cached`
              : 'none cached'),
        );
      } finally {
        clearTimeout(timer);
        controller.abort(new Error('refresh over'));
        state.refreshing = null;
      }
    })();
  }

  /** One list, at once: what is held (fresh or stale, or nothing); a refresh started when it is due. */
  function list(sourceRoot, name, fetcher) {
    const state = listState(name);
    const file = cacheFile(sourceRoot, name);
    if (!state.read) {
      state.data = readCache(file);
      state.read = true;
    }
    const t = now();
    const fresh = state.data && t - state.data.at < LINKED_TTL_MS;
    if (!fresh && !state.refreshing && t >= state.retryAt)
      refresh(state, file, name, fetcher);
    return state.data?.sources || [];
  }

  /** Each list's age and refresh, for the status readout. */
  function status() {
    const iso = (ms) =>
      Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    return {
      lists: ['osm', 'wikidata'].map((name) => {
        const state = listState(name);
        return {
          name,
          at: iso(state.data?.at),
          count: state.data?.sources.length ?? 0,
          refreshing: Boolean(state.refreshing),
          lastFailedAt: iso(state.failedAt),
          lastError: state.error,
          nextAttemptAt: state.failedAt ? iso(state.retryAt) : null,
        };
      }),
    };
  }

  async function loadLinkedWebcams({ sourceRoot = process.cwd() } = {}) {
    const osm = list(sourceRoot, 'osm', fetchOsm);
    const wikidata = list(sourceRoot, 'wikidata', fetchWikidata);
    const everything = [...osm, ...wikidata];
    const kept = [];
    Object.defineProperty(kept, 'everything', { value: everything });
    Object.defineProperty(kept, 'available', { value: everything.length });
    Object.defineProperty(kept, 'proximityOnly', { value: true });
    // The lists' age and refresh, read when the status is asked for.
    Object.defineProperty(kept, 'upstream', { value: status });
    // Personal fork: what viewers' frame fetches saw (observed.js).
    return withObservations(kept, sourceRoot);
  }
  loadLinkedWebcams.status = status;
  /** Resolves once no refresh is running. */
  loadLinkedWebcams.settled = async () => {
    for (;;) {
      const running = [...lists.values()]
        .map((state) => state.refreshing)
        .filter(Boolean);
      if (!running.length) return;
      await Promise.all(running);
    }
  };
  return loadLinkedWebcams;
}
