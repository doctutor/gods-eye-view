import fs from 'node:fs';
import path from 'node:path';
import { isPlausibleLatLon } from './normalize.js';
import {
  CAMINDEX_DIR,
  OBSERVED_FILE,
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
 * Cameras are still images; no directory player is framed.
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

/**
 * The catalog's sources with observations applied: dead and placeholder
 * cameras out, live ones marked live with `observedAt`.
 * @param {Array<object>} sources
 * @param {Record<string, {status: string, at: number}>} observed
 */
export function applyObserved(sources, observed) {
  const out = [];
  for (const source of sources) {
    const seen = observed[source.id];
    if (seen?.status === 'dead' || seen?.status === 'placeholder') continue;
    out.push(
      seen?.status === 'live'
        ? {
            ...source,
            liveStatus: 'live',
            observedAt: new Date(seen.at).toISOString(),
          }
        : source,
    );
  }
  return out;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
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
 */
export function catalogCameraToSource(camera) {
  if (!camera || typeof camera !== 'object') return null;
  const id = String(camera.id || '');
  const lat = Number(camera.lat);
  const lon = Number(camera.lon);
  if (!ID.test(id) || !isPlausibleLatLon(lat, lon)) return null;
  if (camera.liveStatus === 'offline') return null;
  const snapshotUrl = httpsUrl(camera.snapshotUrl);
  if (camera.feedType !== 'image' || !snapshotUrl) return null;
  const name = text(camera.name, 120) || id;
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
    const result = applyObserved(sources, readObserved(file));
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
