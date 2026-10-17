import fs from 'node:fs';
import path from 'node:path';
import { isPlausibleLatLon } from './normalize.js';
import {
  CAMINDEX_DIR,
  OBSERVED_FILE,
  applyObservations,
  camindexDir,
  readObserved,
} from './observed.js';

/**
 * Webcams found by camindex (scripts/camindex/), the crawler that reads
 * public camera directories under the rules in scripts/camindex/SOURCES.md
 * and writes .gev-cache/camindex/catalog.json. This pack only reads that
 * file: nothing is fetched here. Like the linked pack it adds nothing to the
 * capped startup catalog and everything to the proximity index.
 *
 * The file is re-read when its modification time or size changes, and each
 * camera is checked again on the way in (coordinates, https URLs, plain
 * words), since it was assembled from pages the crawler does not control.
 * Cameras are still images, or the operator's own feed the directory's
 * camera page names (a YouTube stream, an HLS playlist, an MJPEG stream, an
 * image); no directory player is framed.
 *
 * What viewers' frame fetches observed (observed.json, observed.js) applies
 * on top: a camera seen dead or showing a placeholder leaves the index (the
 * observation stays on file, so `camindex verify --rolling` re-checks it),
 * and one seen live is marked live with the time it was seen.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export { CAMINDEX_DIR };
export const CAMINDEX_CATALOG = 'catalog.json';
const MAX_CATALOG_BYTES = 128 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{1,80}$/;
const WORD = /^[a-z][a-z-]{0,23}$/i;

/** The catalog file: CAMINDEX_DIR (relative to the source root) or the default. */
export function camindexCatalogPath(sourceRoot, env = process.env) {
  return path.join(camindexDir(sourceRoot, env), CAMINDEX_CATALOG);
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Hosts the server must never be pointed at: local names and private IPs. */
export function isPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost'))
    return false;
  if (/\.(?:local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  if (host.startsWith('[')) return false; // IPv6 literals: none needed.
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip) return host.includes('.');
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  if (ip.slice(1).some((part) => Number(part) > 255)) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** An https URL on a public host, without credentials; else ''. */
function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (!isPublicHost(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** An IANA zone the runtime knows ("Europe/Oslo"), else ''. */
export function validTimeZone(value) {
  const zone = String(value || '');
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(zone)) return '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

const text = (value, max = 160) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const word = (value, fallback = '') =>
  WORD.test(String(value || '')) ? String(value) : fallback;

/**
 * Playback fields for one camera, in the shapes linked.js's feedFields()
 * produces, or null when its feed is not usable:
 * - image   url and snapshotUrl, the still (https), and a fallbackSnapshotUrl
 *           when one is given (a directory's still behind an operator image);
 * - mjpeg   url (https), snapshotUrl only if one is given;
 * - hls     url, an https .m3u8; no snapshot;
 * - youtube embed {provider: 'youtube', videoId}, the watch URL and its
 *           thumbnail, rebuilt from the id; liveStatus 'unknown';
 * - link    no picture (url and snapshotUrl ''); needs an https operatorUrl.
 */
export function feedFieldsFor(camera, operatorUrl) {
  switch (String(camera.feedType || '')) {
    case 'image': {
      const snapshotUrl = httpsUrl(camera.snapshotUrl || camera.url);
      const fallbackSnapshotUrl = httpsUrl(camera.fallbackSnapshotUrl);
      return snapshotUrl
        ? {
            feedType: 'image',
            url: snapshotUrl,
            snapshotUrl,
            ...(fallbackSnapshotUrl && fallbackSnapshotUrl !== snapshotUrl
              ? { fallbackSnapshotUrl }
              : {}),
          }
        : null;
    }
    case 'mjpeg': {
      const url = httpsUrl(camera.url);
      return url
        ? { feedType: 'mjpeg', url, snapshotUrl: httpsUrl(camera.snapshotUrl) }
        : null;
    }
    case 'hls': {
      const url = httpsUrl(camera.url);
      return url && /\.m3u8$/i.test(new URL(url).pathname)
        ? { feedType: 'hls', url, snapshotUrl: '' }
        : null;
    }
    case 'youtube': {
      const videoId = String(camera.embed?.videoId || '');
      if (camera.embed?.provider !== 'youtube' || !VIDEO_ID.test(videoId))
        return null;
      const given = httpsUrl(camera.url);
      const url =
        given && YOUTUBE_HOSTS.has(new URL(given).hostname)
          ? given
          : `https://www.youtube.com/watch?v=${videoId}`;
      return {
        feedType: 'youtube',
        url,
        snapshotUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        embed: { provider: 'youtube', videoId },
        liveStatus: 'unknown',
      };
    }
    case 'link':
      return operatorUrl
        ? { feedType: 'link', url: '', snapshotUrl: '' }
        : null;
    default:
      return null;
  }
}

/**
 * One catalog camera → a source, or null when it is unusable.
 * @param {object} camera
 */
export function catalogCameraToSource(camera) {
  if (!camera || typeof camera !== 'object') return null;
  const id = String(camera.id || '');
  const lat = Number(camera.lat);
  const lon = Number(camera.lon);
  if (!ID.test(id) || !isPlausibleLatLon(lat, lon)) return null;
  if (camera.liveStatus === 'offline') return null;
  const operatorUrl = httpsUrl(camera.operatorUrl);
  const feed = feedFieldsFor(camera, operatorUrl);
  if (!feed) return null;
  const name = text(camera.name, 120) || id;
  const timeZone = validTimeZone(camera.timeZone);
  return {
    id,
    name,
    city: text(camera.city, 80) || 'Webcam directory',
    cityId: word(camera.cityId, 'camindex'),
    provider: text(camera.provider, 60) || 'Webcam directory',
    credit: text(camera.credit, 80),
    lat,
    lon,
    headingDeg: NaN,
    headingConfidence: 'low',
    rangeM: 150,
    sourceKind: word(camera.sourceKind, 'camindex'),
    license: text(camera.license, 200),
    code: name.toUpperCase(),
    category: word(camera.category, 'webcam'),
    coordinatesQuality: word(camera.coordinatesQuality, 'site'),
    operatorUrl,
    // As the catalog says; a directory still is the default.
    publishSignal: word(camera.publishSignal, 'directory-still'),
    licenseClass: word(
      camera.licenseClass,
      feed.feedType === 'youtube' ? 'embed-only' : 'display-only',
    ),
    liveStatus: camera.liveStatus === 'live' ? 'live' : 'unknown',
    ...(timeZone ? { timeZone } : {}),
    // Personal fork: a directory camera resolved to its operator's own feed
    // (scripts/camindex/resolve.mjs) says where the feed was found.
    ...(camera.primaryVia ? { primaryVia: word(camera.primaryVia) } : {}),
    ...(Number.isFinite(Date.parse(camera.resolvedAt))
      ? { resolvedAt: new Date(Date.parse(camera.resolvedAt)).toISOString() }
      : {}),
    ...feed,
  };
}

/**
 * The pack loader: everything in the catalog goes to the proximity index.
 * @param {{env?: object}} [options]
 */
export function createCamindexLoader({ env = process.env } = {}) {
  /** The last file read: {file, mtimeMs, size, sources}. */
  let held = null;
  /** The last observations applied: {key, sources}. */
  let applied = null;

  /** The catalog with observed.json on top, recomputed when either changes. */
  function withObservations(sources, file) {
    let key = '';
    try {
      const stat = fs.statSync(file);
      key = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return sources;
    }
    if (applied?.sources === sources && applied.key === key)
      return applied.result;
    const result = applyObservations(sources, readObserved(file));
    applied = { sources, key, result };
    return result;
  }

  function read(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    if (
      held?.file === file &&
      held.mtimeMs === stat.mtimeMs &&
      held.size === stat.size
    )
      return held.sources;
    if (stat.size > MAX_CATALOG_BYTES) {
      console.warn(`[CCTV] camindex catalog too large (${stat.size} bytes)`);
      return held?.sources || [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const sources = (Array.isArray(parsed?.cameras) ? parsed.cameras : [])
        .map((camera) => catalogCameraToSource(camera))
        .filter(Boolean);
      held = { file, mtimeMs: stat.mtimeMs, size: stat.size, sources };
      console.log(`[CCTV] Loaded camindex catalog: ${sources.length} cameras`);
      return sources;
    } catch (error) {
      console.warn('[CCTV] camindex catalog unreadable:', error?.message);
      return held?.sources || [];
    }
  }

  return async function loadCamindexWebcams({
    sourceRoot = process.cwd(),
  } = {}) {
    const everything = withObservations(
      read(camindexCatalogPath(sourceRoot, env)),
      path.join(camindexDir(sourceRoot, env), OBSERVED_FILE),
    );
    const kept = [];
    Object.defineProperty(kept, 'everything', { value: everything });
    Object.defineProperty(kept, 'available', { value: everything.length });
    Object.defineProperty(kept, 'proximityOnly', { value: true });
    return kept;
  };
}
