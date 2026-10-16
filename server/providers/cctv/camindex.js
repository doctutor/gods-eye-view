import fs from 'node:fs';
import path from 'node:path';
import { isPlausibleLatLon } from './normalize.js';

/**
 * Webcams found by camindex (scripts/camindex/), the crawler that reads
 * public camera directories under the rules in scripts/camindex/SOURCES.md
 * and writes .gev-cache/camindex/catalog.json. This pack only reads that
 * file: nothing is fetched here. Like the linked pack it adds nothing to the
 * capped startup catalog and everything to the proximity index.
 *
 * The file is re-read when its modification time or size changes, and each
 * camera is checked again on the way in (coordinates, https feed URLs, the
 * one embed provider the panel allows), since it was assembled from pages
 * the crawler does not control.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export const CAMINDEX_DIR = path.join('.gev-cache', 'camindex');
export const CAMINDEX_CATALOG = 'catalog.json';
const MAX_CATALOG_BYTES = 128 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{1,80}$/;
const WORD = /^[a-z][a-z-]{0,23}$/i;

/** The catalog file: CAMINDEX_DIR (relative to the source root) or the default. */
export function camindexCatalogPath(sourceRoot, env = process.env) {
  const dir = String(env.CAMINDEX_DIR || '').trim();
  return path.join(
    dir ? path.resolve(sourceRoot, dir) : path.join(sourceRoot, CAMINDEX_DIR),
    CAMINDEX_CATALOG,
  );
}

function httpsUrl(value, hostname) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (hostname && url.hostname !== hostname) return '';
    return url.href;
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
 * One catalog camera → a source, or null when it is unusable.
 * @param {object} camera
 * @param {{embeds?: boolean}} [options] - keep directory embeds (off by
 *   default: opencctv.org pages refuse to be framed by another site today).
 */
export function catalogCameraToSource(camera, { embeds = false } = {}) {
  if (!camera || typeof camera !== 'object') return null;
  const id = String(camera.id || '');
  const lat = Number(camera.lat);
  const lon = Number(camera.lon);
  if (!ID.test(id) || !isPlausibleLatLon(lat, lon)) return null;
  if (camera.liveStatus === 'offline') return null;
  const snapshotUrl = httpsUrl(camera.snapshotUrl);
  if (camera.feedType !== 'image' || !snapshotUrl) return null;
  const name = text(camera.name, 120) || id;
  const embedUrl =
    embeds && camera.embed?.provider === 'opencctv'
      ? httpsUrl(camera.embed.url, 'opencctv.org')
      : '';
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
    operatorUrl: httpsUrl(camera.operatorUrl),
    publishSignal: word(camera.publishSignal, 'directory-embed'),
    licenseClass: word(camera.licenseClass, 'embed-only'),
    liveStatus: camera.liveStatus === 'live' ? 'live' : 'unknown',
    feedType: 'image',
    url: snapshotUrl,
    snapshotUrl,
    ...(embedUrl ? { embed: { provider: 'opencctv', url: embedUrl } } : {}),
  };
}

/**
 * The pack loader: everything in the catalog goes to the proximity index.
 * @param {{env?: object}} [options]
 */
export function createCamindexLoader({ env = process.env } = {}) {
  /** The last file read: {file, mtimeMs, size, sources}. */
  let held = null;

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
      const embeds = String(env.CCTV_CAMINDEX_EMBED || '').trim() === '1';
      const sources = (Array.isArray(parsed?.cameras) ? parsed.cameras : [])
        .map((camera) => catalogCameraToSource(camera, { embeds }))
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
    const everything = read(camindexCatalogPath(sourceRoot, env));
    const kept = [];
    Object.defineProperty(kept, 'everything', { value: everything });
    Object.defineProperty(kept, 'available', { value: everything.length });
    Object.defineProperty(kept, 'proximityOnly', { value: true });
    return kept;
  };
}
