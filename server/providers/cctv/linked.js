import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { isPlausibleLatLon } from './normalize.js';

/**
 * Linked webcams: places whose public map record names a webcam.
 *
 * - OpenStreetMap: every object tagged `contact:webcam` (about ten thousand
 *   worldwide: harbours, ski areas, squares, viewpoints, observatories), via
 *   Overpass, or QLever's OpenStreetMap index when every Overpass mirror
 *   fails. ODbL; the shared OpenStreetMap credit shows while any is loaded.
 * - Wikidata: every item with a "webcam URL" (P4238) and coordinates (about
 *   six hundred notable landmarks). CC0.
 *
 * Most links are operator pages, so the camera is a pin that opens the
 * operator's site; a direct image, HLS stream or YouTube link plays in the
 * app. The pack contributes nothing to the capped startup catalog and
 * everything to the proximity index, so these appear only near the view.
 *
 * Both lists change slowly: each is fetched at most once a week and kept on
 * disk (.gev-cache/cctv-linked/); a failed fetch keeps serving the old copy.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export const LINKED_CACHE_DIR = path.join('.gev-cache', 'cctv-linked');
/** A cached list is refetched after this long. */
export const LINKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed fetch, the next attempt waits this long. */
export const LINKED_RETRY_MS = 30 * 60 * 1000;
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

/** Public Overpass mirrors, tried in order when OVERPASS_UPSTREAMS is unset. */
export const DEFAULT_OVERPASS_MIRRORS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  // Worldwide community mirror; answered when the main servers were at
  // capacity for two days (2026-10-16). overpass.osm.ch is not listed: it
  // covers Switzerland only.
  'https://overpass.private.coffee/api/interpreter',
]);
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
 * followed (a 3xx comes back as its status).
 * @returns {Promise<{status: number, text: string}>}
 */
export function postForm(url, body, { headers = {}, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    request.on('error', (error) => finish(reject, error));
    request.end(body);
  });
}

/** Overpass endpoints: the configured chain, else public mirrors. */
export function overpassEndpoints(env = process.env) {
  const configured = String(env.OVERPASS_UPSTREAMS || '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => /^https?:\/\//.test(token));
  return configured.length ? configured : [...DEFAULT_OVERPASS_MIRRORS];
}

/**
 * The pack loader. Returns an empty capped list whose `everything` holds all
 * linked webcams, so the proximity index gets them and the startup catalog
 * stays as it was.
 * @param {{fetchImpl?: typeof fetch, qleverRequest?: typeof postForm,
 *   now?: () => number, cacheDir?: string, env?: object}} [options]
 */
export function createLinkedLoader({
  fetchImpl = (...args) => fetch(...args),
  qleverRequest = postForm,
  now = () => Date.now(),
  cacheDir,
  env = process.env,
} = {}) {
  /** name → {at, sources} in memory; failures → next attempt time. */
  const memory = new Map();
  const retryAt = new Map();

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

  async function fetchOsm() {
    let lastError = null;
    for (const endpoint of overpassEndpoints(env)) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(OVERPASS_WEBCAM_QUERY)}`,
          signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
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
    // Every mirror failed (they refused this query for days in 2026-10):
    // the same objects from QLever's planet index.
    try {
      return await fetchQlever();
    } catch (error) {
      throw new Error(
        `${lastError?.message || 'No Overpass endpoint'}; QLever: ${error?.message}`,
      );
    }
  }

  async function fetchQlever() {
    let answer;
    for (let attempt = 1; !answer; attempt++) {
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

  async function fetchWikidata() {
    const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(WIKIDATA_WEBCAM_QUERY)}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(WIKIDATA_TIMEOUT_MS),
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

  /** One list: memory, else fresh disk, else a fetch, else stale disk. */
  async function list(sourceRoot, name, fetcher) {
    const t = now();
    const held = memory.get(name);
    if (held && t - held.at < LINKED_TTL_MS) return held.sources;
    const file = cacheFile(sourceRoot, name);
    const disk = held || readCache(file);
    if (disk && t - disk.at < LINKED_TTL_MS) {
      memory.set(name, disk);
      return disk.sources;
    }
    if ((retryAt.get(name) ?? -Infinity) > t) return disk?.sources || [];
    try {
      const sources = await fetcher();
      const payload = { at: t, sources };
      memory.set(name, payload);
      writeCache(file, payload);
      console.log(`[CCTV] Loaded ${name} webcam links: ${sources.length}`);
      return sources;
    } catch (error) {
      retryAt.set(name, t + LINKED_RETRY_MS);
      console.warn(
        `[CCTV] ${name} webcam links unavailable (${error?.message}); ` +
          (disk ? `serving ${disk.sources.length} cached` : 'none cached'),
      );
      if (disk) memory.set(name, disk);
      return disk?.sources || [];
    }
  }

  return async function loadLinkedWebcams({ sourceRoot = process.cwd() } = {}) {
    const [osm, wikidata] = await Promise.all([
      list(sourceRoot, 'osm', fetchOsm),
      list(sourceRoot, 'wikidata', fetchWikidata),
    ]);
    const everything = [...osm, ...wikidata];
    const kept = [];
    Object.defineProperty(kept, 'everything', { value: everything });
    Object.defineProperty(kept, 'available', { value: everything.length });
    Object.defineProperty(kept, 'proximityOnly', { value: true });
    return kept;
  };
}
