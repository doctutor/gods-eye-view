import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CCTV_SOURCE_FILE, CCTV_SOURCE_CACHE_MS } from './constants.js';
import { allocateSourceCap, resolveCatalogCap } from './cap.js';
import { loadGroundHeights, joinGroundHeights } from './groundHeights.js';
import { cameraRegion, normalizeSourceItem } from './normalize.js';
import {
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadTflSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadTxdotSourcesFromOpenData,
  loadTallinnSourcesFromCatalog,
  loadTarkteeSourcesFromDatex,
  loadWarendorfSourcesFromCatalog,
  loadNswSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadDelDOTSourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
  loadMdotSourcesFromOpenData,
} from './sources.js';
import { createFeaturedLoader } from './featured.js';
import { haversineKm } from '../common/geo.js';
import { createWindySource } from './windy.js';
import { createLinkedLoader } from './linked.js';
import { createCamindexLoader } from './camindex.js';

/** Env kill switch: unset or anything but "0" means enabled. */
const envEnabled = (name) => String(process.env[name] || '1').trim() !== '0';

/**
 * Live open-data packs, in merge order. Adding a region is one entry here
 * plus its loader in sources.js; the catalog cap is shared across entries
 * round-robin (cap.js), so a new pack never silently evicts an older one.
 * Each pack fails independently (allSettled) and is gated by its own env
 * kill switch.
 */
const LIVE_PACKS = [
  { name: 'austin', enabled: () => true, load: loadAustinSourcesFromOpenData },
  {
    name: 'caltrans',
    enabled: () => true,
    load: loadCaltransSourcesFromOpenData,
  },
  {
    name: 'tfl',
    enabled: () => envEnabled('CCTV_TFL_ENABLED'),
    load: loadTflSourcesFromOpenData,
  },
  {
    name: 'ontario',
    enabled: () => envEnabled('CCTV_ONTARIO_ENABLED'),
    load: loadOntarioSourcesFromOpenData,
  },
  {
    name: 'fintraffic',
    enabled: () => envEnabled('CCTV_FINTRAFFIC_ENABLED'),
    load: loadFintrafficSourcesFromOpenData,
  },
  {
    name: 'drivebc',
    enabled: () => envEnabled('CCTV_DRIVEBC_ENABLED'),
    load: loadDriveBcSourcesFromOpenData,
  },
  {
    name: 'txdot',
    enabled: () => envEnabled('CCTV_TXDOT_ENABLED'),
    load: loadTxdotSourcesFromOpenData,
  },
  {
    name: 'tallinn',
    enabled: () => envEnabled('CCTV_TALLINN_ENABLED'),
    load: loadTallinnSourcesFromCatalog,
  },
  {
    name: 'tarktee',
    enabled: () => envEnabled('CCTV_TARKTEE_ENABLED'),
    load: loadTarkteeSourcesFromDatex,
  },
  {
    name: 'warendorf',
    enabled: () => envEnabled('CCTV_WARENDORF_ENABLED'),
    load: loadWarendorfSourcesFromCatalog,
  },
  {
    name: 'nsw',
    enabled: () => envEnabled('CCTV_NSW_ENABLED'),
    load: loadNswSourcesFromOpenData,
  },
  {
    name: 'calgary',
    enabled: () => envEnabled('CCTV_CALGARY_ENABLED'),
    load: loadCalgarySourcesFromOpenData,
  },
  {
    name: 'deldot',
    enabled: () => envEnabled('CCTV_DELDOT_ENABLED'),
    load: loadDelDOTSourcesFromOpenData,
  },
  {
    name: 'vegvesen',
    enabled: () => envEnabled('CCTV_VEGVESEN_ENABLED'),
    load: loadVegvesenSourcesFromOpenData,
  },
  {
    name: 'mdot',
    enabled: () => envEnabled('CCTV_MDOT_ENABLED'),
    load: loadMdotSourcesFromOpenData,
  },
  // Personal fork: hand-checked public-interest streams on YouTube.
  {
    name: 'featured',
    enabled: () => envEnabled('CCTV_FEATURED_ENABLED'),
    load: createFeaturedLoader(),
  },
  // Personal fork: webcams linked from OpenStreetMap and Wikidata places;
  // proximity index only (linked.js).
  {
    name: 'linked',
    enabled: () => envEnabled('CCTV_LINKED_ENABLED'),
    load: createLinkedLoader(),
  },
  // Personal fork: webcams found by scripts/camindex in public directories;
  // reads its catalog file only, proximity index only (camindex.js).
  {
    name: 'camindex',
    enabled: () => envEnabled('CCTV_CAMINDEX_ENABLED'),
    load: createCamindexLoader(),
  },
];
/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
function loadSourcesFromFile(sourceRoot) {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] failed to read source file:',
      resolved,
      error?.message || error,
    );
    return [];
  }
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Create an independent catalog rooted in the consuming application. */
export function createCctvCatalog({ sourceRoot = process.cwd() } = {}) {
  /** @type {Array<object>} Cached merged + normalized CCTV source list. */
  let _cctvSourceCache = [];
  /** @type {number} Epoch-ms when the source cache was last refreshed. */
  let _cctvSourceCacheAt = 0;
  /** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
   * callers so a post-TTL burst launches ONE refetch, not one per request. */
  let _cctvSourceInflight = null;
  /** @type {Array<{pack: string, available: number, served: number}>} Packs
   * that serve fewer cameras than they offer. */
  let _cctvTrimmedPacks = [];
  /** @type {Array<object>} Personal fork: every camera the packs offered,
   * uncapped, for proximity queries (`near`). */
  let _cctvIndex = [];
  // Personal fork: sources too large to index, asked per proximity query.
  const dynamicSources = [
    {
      source: createWindySource(),
      enabled: () => envEnabled('CCTV_WINDY_ENABLED'),
    },
  ];

  /**
   * Assemble and cache the merged CCTV source list.
   *
   * Merges every source pack (live open-data packs, local file, env
   * variable), deduplicates by ID, shares the catalog cap fairly across
   * packs, and caches for CCTV_SOURCE_CACHE_MS.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function getCctvSources() {
    const now = Date.now();
    if (
      _cctvSourceCache.length &&
      now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS
    ) {
      return _cctvSourceCache;
    }
    // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
    // instead of each launching the full multi-provider refetch. The `.finally`
    // clears the ref so the next post-TTL cycle starts fresh.
    if (_cctvSourceInflight) return _cctvSourceInflight;
    _cctvSourceInflight = refreshCctvSources().finally(() => {
      _cctvSourceInflight = null;
    });
    return _cctvSourceInflight;
  }

  /**
   * Assemble and cache the merged CCTV source list from file/env + live packs.
   * Always resolves (loaders self-catch to []); on a fully-empty refresh with a
   * good prior catalog it serves stale rather than blanking the CCTV layer.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function refreshCctvSources() {
    const fromFile = loadSourcesFromFile(sourceRoot);
    const fromEnv = loadSourcesFromEnv();

    const forceAustin =
      String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
    const preferAustin =
      String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
    // Live open-data packs load unless a file/env pack is configured and live
    // packs aren't forced — the same gate that governed the Austin-only fetch
    // now governs every entry in LIVE_PACKS.
    const needsLiveSources =
      forceAustin || (fromFile.length + fromEnv.length === 0 && preferAustin);
    const liveResults = needsLiveSources
      ? await Promise.allSettled(
          // Invoked inside the promise so a loader that throws synchronously
          // (a file-based pack on a malformed row) is isolated like any other
          // failed pack instead of rejecting the whole refresh.
          LIVE_PACKS.map((pack) =>
            Promise.resolve().then(() =>
              pack.enabled() ? pack.load({ sourceRoot }) : [],
            ),
          ),
        )
      : [];
    // Live packs first so file/env overrides win on duplicate IDs; each pack
    // keeps its own priority order and the catalog cap is shared fairly.
    const normalizePack = (name, items) => ({
      name,
      sources: items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({ ...normalizeSourceItem(item), pack: name }))
        .filter((item) => item.id),
      available: Number.isFinite(items.available)
        ? items.available
        : items.length,
      region: items.region ?? null,
      // Personal fork: a pack that serves only through proximity queries.
      proximityOnly: items.proximityOnly === true,
      // Personal fork: the pack's full offer, for the proximity index.
      everything: (Array.isArray(items.everything) ? items.everything : items)
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({ ...normalizeSourceItem(item), pack: name }))
        .filter((item) => item.id),
    });
    const packs = [
      ...LIVE_PACKS.map((pack, index) =>
        normalizePack(
          pack.name,
          liveResults[index]?.status === 'fulfilled'
            ? liveResults[index].value
            : [],
        ),
      ),
      normalizePack('file', fromFile),
      normalizePack('env', fromEnv),
    ];
    const maxCount = resolveCatalogCap(process.env.CCTV_MAX_SOURCES);
    const allocation = allocateSourceCap(packs, maxCount);
    // Shipped ground heights (src/data/local_data/cctv_ground_heights/, produced by
    // scripts/precompute-cctv-heights.mjs) ride along on the served source so
    // the client can place a camera and its monitor plane with zero sampling.
    const groundHeights = loadGroundHeights(sourceRoot);
    const capped = joinGroundHeights(allocation.sources, groundHeights);
    // Personal fork: the uncapped index behind proximity queries. Later packs
    // win duplicate ids, as in the capped catalog.
    const indexById = new Map();
    for (const pack of packs)
      for (const source of pack.everything) indexById.set(source.id, source);
    const index = joinGroundHeights([...indexById.values()], groundHeights);
    const trimmed = allocation.packs.filter((pack) => pack.kept < pack.offered);
    // Each pack's own nearest-first cap and the shared catalog cap both trim.
    const trimmedPacks = packs
      .map((pack, index) => ({
        pack: pack.name,
        available: Math.max(pack.available, allocation.packs[index].offered),
        served: allocation.packs[index].kept,
        // Where the pack's cameras are, including those not served.
        region: pack.region ?? cameraRegion(pack.sources),
      }))
      .filter(
        (pack, index) =>
          !packs[index].proximityOnly && pack.served < pack.available,
      );
    if (trimmed.length) {
      const detail = trimmed
        .map((pack) => `${pack.name} ${pack.kept}/${pack.offered}`)
        .join(', ');
      console.warn(
        `[CCTV] source catalog exceeds cap ${maxCount}; shared round-robin across packs (${detail}). Raise CCTV_MAX_SOURCES or lower a per-pack cap to change the mix.`,
      );
    }
    if (capped.length > 0 || _cctvSourceCache.length === 0) {
      _cctvSourceCache = capped;
      _cctvTrimmedPacks = trimmedPacks;
      _cctvIndex = index;
    } else {
      // Every source came back empty (all live packs timed out / upstream outage)
      // but a good catalog is already cached — serve it stale rather than blanking
      // every CCTV route. Advancing the timestamp waits one TTL before retrying,
      // which (with single-flight) bounds load on a persistently-down upstream.
      console.warn(
        `[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`,
      );
    }
    _cctvSourceCacheAt = Date.now();
    return _cctvSourceCache;
  }

  /** Packs serving fewer cameras than they offer, as of the last refresh. */
  getCctvSources.trimmedPacks = () => _cctvTrimmedPacks;
  /** Personal fork: every known camera, including those the cap leaves out. */
  getCctvSources.index = () => _cctvIndex;
  /** Personal fork: a camera a dynamic source has returned before. */
  getCctvSources.dynamic = (id) => {
    for (const entry of dynamicSources) {
      const found = entry.source.lookup(id);
      if (found) return found;
    }
    return null;
  };
  /**
   * Personal fork: the cameras nearest a point (see nearSources), from the
   * index and from every enabled dynamic source. A dynamic source that fails
   * contributes nothing; the indexed answer still comes back.
   */
  getCctvSources.near = async (lat, lon, options = {}) => {
    const radiusKm = Math.min(
      NEAR_MAX_RADIUS_KM,
      Math.max(0.1, Number(options.radiusKm) || 25),
    );
    const extra = await Promise.all(
      dynamicSources.map((entry) =>
        entry.enabled() ? entry.source.near(lat, lon, radiusKm) : [],
      ),
    );
    const byId = new Map(_cctvIndex.map((source) => [source.id, source]));
    for (const list of extra)
      for (const source of list)
        if (!byId.has(source.id)) byId.set(source.id, source);
    return nearSources([...byId.values()], lat, lon, options);
  };
  return getCctvSources;
}

/** Proximity query bounds. */
export const NEAR_MAX_RADIUS_KM = 500;
export const NEAR_MAX_LIMIT = 1000;
/** Embedded public-interest streams rank as if this much closer. */
const FEATURED_DISTANCE_FACTOR = 0.25;
/** Scenic and nature webcams (any category but traffic) rank this much closer. */
const SCENIC_DISTANCE_FACTOR = 0.5;

/** How much nearer a camera counts than it is, by what it shows. */
export function interestFactor(source) {
  // Personal fork: a directory's embed (camindex.js) ranks as scenic, not
  // as a featured stream.
  if (source?.embed && source.publishSignal !== 'directory-embed')
    return FEATURED_DISTANCE_FACTOR;
  if (source?.category && source.category !== 'traffic')
    return SCENIC_DISTANCE_FACTOR;
  return 1;
}

/**
 * Personal fork: the cameras within `radiusKm` of a point, nearest first,
 * with embedded public-interest streams (featured.js) ranked ahead of traffic
 * cameras at the same distance, so a tight limit keeps them.
 *
 * @param {Array<object>} sources - Normalized catalog sources.
 * @param {number} lat
 * @param {number} lon
 * @param {{radiusKm?: number, limit?: number}} [options]
 * @returns {Array<object>}
 */
export function nearSources(sources, lat, lon, options = {}) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return [];
  const radiusKm = Math.min(
    NEAR_MAX_RADIUS_KM,
    Math.max(0.1, Number(options.radiusKm) || 25),
  );
  const limit = Math.min(
    NEAR_MAX_LIMIT,
    Math.max(1, Math.floor(Number(options.limit) || 300)),
  );
  const scored = [];
  for (const source of sources || []) {
    const distanceKm = haversineKm(lat, lon, source.lat, source.lon);
    if (!(distanceKm <= radiusKm)) continue;
    const rank = distanceKm * interestFactor(source);
    scored.push({ source, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((entry) => entry.source);
}
