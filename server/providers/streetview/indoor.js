// Personal fork: finds Google Street View indoor imagery and user photospheres.
import {
  PANO_RECHECK_DAYS,
  cellKey,
  cellsInCircle,
  metresBetween,
} from './db.js';

/**
 * Street View Static API metadata. Metadata requests are free (only images are
 * billed, and this module never asks for one) but share a per-minute quota.
 */
export const METADATA_ENDPOINT =
  'https://maps.googleapis.com/maps/api/streetview/metadata';
/** Search radius for each metadata request, metres. */
export const METADATA_RADIUS_M = 25;
/** A panorama further than this from its target belongs to something else. */
export const MAX_TARGET_DISTANCE_M = 40;
/** At most this many metadata requests per second, across every caller. */
export const METADATA_PER_SECOND = 5;
export const DEFAULT_DAILY_CAP = 3000;
/** Places nearby searches are billed: their own, smaller daily budget. */
export const DEFAULT_PLACES_DAILY_CAP = 200;
export const MAX_POI_TARGETS = 40;
export const GRID_SPACING_M = 40;
export const MAX_GRID_TARGETS = 400;
export const MIN_PROBE_RADIUS_M = 50;
export const MAX_PROBE_RADIUS_M = 2000;
/** After a failed Places search (e.g. its daily quota), skip Places this long. */
export const PLACES_RETRY_MS = 10 * 60_000;
/** After REQUEST_DENIED (API not enabled yet), wait this long before asking again. */
export const DENIED_RETRY_MS = 5 * 60_000;
/** First sweep after startup, then every interval. */
export const SWEEP_DELAY_MS = 30_000;
export const SWEEP_INTERVAL_MS = 12 * 3_600_000;
const METADATA_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

/**
 * Places (New) types worth probing, in two searches of up to 20 results each:
 * where Business View photographers and visitors shoot interiors.
 */
export const POI_TYPE_GROUPS = Object.freeze([
  Object.freeze([
    'restaurant',
    'cafe',
    'bar',
    'lodging',
    'museum',
    'art_gallery',
    'tourist_attraction',
  ]),
  Object.freeze([
    'store',
    'shopping_mall',
    'train_station',
    'subway_station',
    'transit_station',
    'church',
    'place_of_worship',
  ]),
]);

/**
 * Whether a metadata copyright line names a contributor rather than Google
 * ("© Google", "© 2024 Google"); a missing line is not evidence.
 */
export function isContributed(copyright) {
  const text = String(copyright || '').trim();
  if (!text) return false;
  return !/^(©|\(c\))?\s*(\d{4}\s*)?Google\b/i.test(text);
}

/** Probe stopped early: the API is not configured, a cap was reached, or Google throttled. */
export class IndoorStop extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IndoorStop';
    this.code = code;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** Settings from the environment, read on every use so a .env edit applies. */
export function indoorConfig(env = process.env) {
  const flag = String(env.STREETVIEW_INDOOR_ENABLED ?? '')
    .trim()
    .toLowerCase();
  return {
    enabled: !['0', 'false', 'off', 'no'].includes(flag),
    grid: String(env.STREETVIEW_INDOOR_GRID ?? '').trim() === '1',
    dailyCap: positiveInt(env.STREETVIEW_INDOOR_DAILY_CAP, DEFAULT_DAILY_CAP),
    placesDailyCap: positiveInt(
      env.STREETVIEW_INDOOR_PLACES_DAILY_CAP,
      DEFAULT_PLACES_DAILY_CAP,
    ),
  };
}

/** Space calls at least `intervalMs` apart, in the order they ask. */
export function createPacer({
  intervalMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let next = 0;
  return async function wait() {
    const t = now();
    const slot = Math.max(t, next);
    next = slot + intervalMs;
    if (slot > t) await sleep(slot - t);
  };
}

/** Grid points every `spacing` metres inside a circle, widened to fit `max`. */
export function gridTargets({ lat, lon }, radiusM, { spacing, max }) {
  const area = Math.PI * radiusM * radiusM;
  const step = Math.max(spacing, Math.sqrt(area / max));
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const points = [];
  for (let dy = -radiusM; dy <= radiusM; dy += step)
    for (let dx = -radiusM; dx <= radiusM; dx += step) {
      if (Math.hypot(dx, dy) > radiusM) continue;
      points.push({
        lat: lat + dy / 110_540,
        lon: lon + dx / (111_320 * cosLat),
      });
    }
  return points.slice(0, max);
}

/**
 * The probe service over a database (db.js). `fetchImpl` reaches Google;
 * `searchNearby` is the Places nearby helper from places/google.js.
 */
export function createIndoorService({
  db,
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  searchNearby,
  env = process.env,
  now = Date.now,
  sleep,
  logger = console,
  metadataEndpoint = METADATA_ENDPOINT,
  pacer = createPacer({
    intervalMs: Math.ceil(1000 / METADATA_PER_SECOND),
    now,
    ...(sleep ? { sleep } : {}),
  }),
}) {
  let loaded = null;
  let busy = false;
  /** {message, at} after Google answered REQUEST_DENIED. */
  let denied = null;
  let warnedNoKey = false;
  /** No Places searches before this time (ms), after one failed. */
  let placesHoldUntil = 0;
  let sweepTimer = null;
  let sweeping = null;

  const ensureLoaded = () => (loaded ||= db.load().catch(() => {}));
  const apiKey = () => String(resolveApiKey?.() ?? '').trim();

  function noKey() {
    if (!warnedNoKey) {
      warnedNoKey = true;
      logger.warn?.(
        '[StreetView:indoor] GOOGLE_MAPS_SERVER_API_KEY is not set; indoor probes are off',
      );
    }
  }

  /** Why probing cannot run right now, or null when it can. */
  function blocker() {
    const config = indoorConfig(env);
    if (!config.enabled)
      return { reason: 'disabled', message: 'STREETVIEW_INDOOR_ENABLED=0' };
    if (!apiKey()) {
      noKey();
      return {
        reason: 'no_key',
        message: 'Set GOOGLE_MAPS_SERVER_API_KEY to find indoor views',
      };
    }
    if (denied && now() - denied.at < DENIED_RETRY_MS)
      return {
        reason: 'not_enabled',
        message:
          'Google refused the Street View metadata request — enable "Street View Static API" for the server key',
        detail: denied.message || null,
      };
    return null;
  }

  async function status() {
    await ensureLoaded();
    const config = indoorConfig(env);
    const usage = db.usage();
    const block = blocker();
    return {
      configured: block === null,
      enabled: config.enabled,
      reason: block?.reason ?? null,
      message: block?.message ?? null,
      grid: config.grid,
      dailyCap: config.dailyCap,
      usedToday: usage.metadata,
      remainingToday: Math.max(0, config.dailyCap - usage.metadata),
      placesUsedToday: usage.places,
      placesDailyCap: config.placesDailyCap,
      busy,
      counts: db.counts(),
    };
  }

  /** One metadata request, paced and counted against the daily cap. */
  async function metadata(query, signal) {
    const config = indoorConfig(env);
    if (db.usage().metadata >= config.dailyCap)
      throw new IndoorStop(
        'cap',
        `Daily Street View metadata cap (${config.dailyCap}) reached`,
      );
    await pacer();
    if (signal?.aborted) throw new IndoorStop('aborted', 'Probe cancelled');
    const url = new URL(metadataEndpoint);
    if (query.pano) url.searchParams.set('pano', query.pano);
    else {
      url.searchParams.set(
        'location',
        `${query.lat.toFixed(7)},${query.lon.toFixed(7)}`,
      );
      url.searchParams.set('radius', String(METADATA_RADIUS_M));
      url.searchParams.set('source', query.source || 'default');
    }
    url.searchParams.set('key', apiKey());
    db.countRequest('metadata');
    const timeout = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    let data;
    try {
      const response = await fetchImpl(url.toString(), {
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      data = await response.json().catch(() => ({}));
      if (!data?.status && !response.ok) data = { status: 'UNKNOWN_ERROR' };
    } catch (error) {
      if (signal?.aborted) throw new IndoorStop('aborted', 'Probe cancelled');
      // The URL carries the key: report the failure without it.
      return {
        status: 'UNKNOWN_ERROR',
        error: error?.name || 'fetch failed',
      };
    }
    const status = String(data.status || 'UNKNOWN_ERROR');
    if (status === 'REQUEST_DENIED') {
      denied = { message: String(data.error_message || ''), at: now() };
      throw new IndoorStop('not_configured', blocker()?.message || status);
    }
    if (status === 'OVER_QUERY_LIMIT')
      throw new IndoorStop(
        'quota',
        'Google is throttling Street View metadata — try again later',
      );
    if (status !== 'OK') return { status };
    denied = null;
    const lat = Number(data.location?.lat);
    const lon = Number(data.location?.lng);
    const panoId = String(data.pano_id || '');
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(panoId) || !Number.isFinite(lat))
      return { status: 'INVALID_RESPONSE' };
    return {
      status,
      panoId,
      lat,
      lon,
      date: typeof data.date === 'string' ? data.date.slice(0, 16) : null,
      copyright:
        typeof data.copyright === 'string'
          ? data.copyright.slice(0, 200)
          : null,
    };
  }

  /**
   * Classify the panorama nearest one target. A hit is either contributed (its
   * copyright names someone other than Google: Business View interiors and
   * user photospheres, which Google also returns for source=outdoor) or
   * Google's own imagery that Google returns for any source but not outdoor.
   */
  async function checkTarget(target, run) {
    const any = await metadata({ ...target, source: 'default' }, run.signal);
    if (any.status !== 'OK') return null;
    if (metresBetween(target, any) > MAX_TARGET_DISTANCE_M) return null;
    if (run.outdoor.has(any.panoId)) return null;
    const known = db.getPano(any.panoId);
    const contributed = isContributed(any.copyright);
    if (!known && !contributed) {
      const outdoor = await metadata(
        { ...target, source: 'outdoor' },
        run.signal,
      );
      if (outdoor.status === 'OK' && outdoor.panoId === any.panoId) {
        run.outdoor.add(any.panoId);
        return null;
      }
      // Anything but a clear answer is no evidence either way.
      if (outdoor.status !== 'OK' && outdoor.status !== 'ZERO_RESULTS')
        return null;
    }
    const t = now();
    const placeId = target.placeId || known?.placeId || null;
    if (target.placeId)
      db.putPlace({
        placeId: target.placeId,
        name: target.name,
        lat: target.lat,
        lon: target.lon,
      });
    const isNew = db.putPano({
      panoId: any.panoId,
      placeId,
      name: target.name || known?.name || null,
      lat: any.lat,
      lon: any.lon,
      date: any.date,
      copyright: any.copyright,
      checkedAt: t,
      foundAt: known?.foundAt ?? t,
      method: known?.method || target.method,
      kind: contributed ? 'contributed' : 'indoor',
    });
    return isNew ? any.panoId : null;
  }

  /** Points of interest from the Places nearby search, in unprobed cells. */
  async function poiTargets(centre, radiusM, unprobed, run) {
    const config = indoorConfig(env);
    const withPanos = new Set(
      db
        .allPanos()
        .map((pano) => pano.placeId)
        .filter(Boolean),
    );
    const seen = new Set();
    const targets = [];
    for (const includedTypes of POI_TYPE_GROUPS) {
      if (targets.length >= MAX_POI_TARGETS) break;
      if (db.usage().places >= config.placesDailyCap) {
        run.notes.push(
          `Places daily cap (${config.placesDailyCap}) reached; POIs skipped`,
        );
        run.poiIncomplete = true;
        break;
      }
      if (run.allowPlaces && !run.allowPlaces()) {
        run.notes.push('Places rate limit reached; POIs skipped');
        run.poiIncomplete = true;
        break;
      }
      if (now() < placesHoldUntil) {
        run.notes.push('Places searches paused after a failure; POIs skipped');
        run.poiIncomplete = true;
        break;
      }
      db.countRequest('places');
      run.requests.places++;
      let result;
      try {
        result = await searchNearby({
          apiKey: apiKey(),
          latitude: centre.lat,
          longitude: centre.lon,
          radiusM: Math.min(radiusM, 5000),
          includedTypes: [...includedTypes],
          rankPreference: 'POPULARITY',
          fetchImpl,
          signal: run.signal,
        });
      } catch (error) {
        if (run.signal?.aborted)
          throw new IndoorStop('aborted', 'Probe cancelled');
        run.notes.push(`Places search failed: ${error?.message || error}`);
        run.poiIncomplete = true;
        placesHoldUntil = now() + PLACES_RETRY_MS;
        break;
      }
      if (!result?.ok) {
        run.notes.push(`Places search failed: ${result?.error || 'error'}`);
        run.poiIncomplete = true;
        placesHoldUntil = now() + PLACES_RETRY_MS;
        break;
      }
      for (const place of result.places || []) {
        const lat = Number(place.latitude);
        const lon = Number(place.longitude);
        if (!place.id || !Number.isFinite(lat) || !Number.isFinite(lon))
          continue;
        if (seen.has(place.id) || withPanos.has(place.id)) continue;
        if (metresBetween(centre, { lat, lon }) > radiusM) continue;
        if (!unprobed.has(cellKey(lat, lon))) continue;
        seen.add(place.id);
        targets.push({
          lat,
          lon,
          placeId: place.id,
          name: place.name || null,
          method: 'poi',
        });
        if (targets.length >= MAX_POI_TARGETS) break;
      }
    }
    return targets;
  }

  /**
   * Probe an area: POIs first, then (STREETVIEW_INDOOR_GRID=1) a coarse grid.
   * Cells are marked probed only when every target was listed and checked.
   */
  async function probe({ lat, lon, radiusKm }, { signal, allowPlaces } = {}) {
    await ensureLoaded();
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -85 ||
      lat > 85 ||
      lon < -180 ||
      lon > 180
    )
      return {
        ok: false,
        status: 400,
        error: 'Valid lat and lon are required',
      };
    const radiusM = Math.min(
      MAX_PROBE_RADIUS_M,
      Math.max(MIN_PROBE_RADIUS_M, (Number(radiusKm) || 0.5) * 1000),
    );
    const centre = { lat, lon };
    const block = blocker();
    if (block)
      return {
        ok: false,
        configured: false,
        reason: block.reason,
        error: block.message,
        hits: db.hitsNear(centre, radiusM),
      };
    if (busy) return { ok: false, status: 409, busy: true, error: 'busy' };
    busy = true;
    const run = {
      signal,
      allowPlaces,
      outdoor: new Set(),
      requests: { metadata: 0, places: 0 },
      notes: [],
      /** POIs could not be listed: the area stays unprobed for a later try. */
      poiIncomplete: false,
    };
    const before = db.usage().metadata;
    const newHits = [];
    let stopped = null;
    let targets = { poi: 0, grid: 0 };
    try {
      const allCells = cellsInCircle(lat, lon, radiusM);
      const unprobed = new Set(db.unprobedCells(allCells));
      if (unprobed.size === 0)
        return {
          ok: true,
          skipped: true,
          newHits: [],
          hits: db.hitsNear(centre, radiusM),
          requests: run.requests,
          usage: await usageSummary(),
        };
      const list = await poiTargets(centre, radiusM, unprobed, run);
      targets.poi = list.length;
      if (indoorConfig(env).grid) {
        const grid = gridTargets(centre, radiusM, {
          spacing: GRID_SPACING_M,
          max: MAX_GRID_TARGETS,
        }).filter((point) => unprobed.has(cellKey(point.lat, point.lon)));
        targets.grid = grid.length;
        for (const point of grid) list.push({ ...point, method: 'grid' });
      }
      for (const target of list) {
        if (signal?.aborted) {
          stopped = { code: 'aborted', message: 'Probe cancelled' };
          break;
        }
        const panoId = await checkTarget(target, run);
        if (panoId) newHits.push(panoId);
      }
      if (!stopped && !run.poiIncomplete) db.markCells([...unprobed]);
    } catch (error) {
      if (!(error instanceof IndoorStop)) throw error;
      stopped = { code: error.code, message: error.message };
    } finally {
      run.requests.metadata = db.usage().metadata - before;
      busy = false;
      await db.save().catch((error) => {
        logger.warn?.(
          '[StreetView:indoor] could not save the database:',
          error?.message || error,
        );
      });
    }
    const hits = db.hitsNear(centre, radiusM);
    const fresh = new Set(newHits);
    return {
      ok: !stopped || stopped.code === 'cap' || stopped.code === 'aborted',
      ...(stopped?.code === 'not_configured'
        ? { configured: false, reason: 'not_enabled' }
        : {}),
      stopped: stopped?.code ?? null,
      error: stopped?.message ?? null,
      capReached: stopped?.code === 'cap',
      incomplete: Boolean(stopped) || run.poiIncomplete,
      newHits: hits.filter((hit) => fresh.has(hit.panoId)),
      hits,
      targets,
      requests: run.requests,
      notes: run.notes,
      usage: await usageSummary(),
    };
  }

  async function usageSummary() {
    const config = indoorConfig(env);
    const usage = db.usage();
    return {
      usedToday: usage.metadata,
      dailyCap: config.dailyCap,
      remainingToday: Math.max(0, config.dailyCap - usage.metadata),
      placesUsedToday: usage.places,
    };
  }

  async function hitsNear({ lat, lon, radiusKm }) {
    await ensureLoaded();
    const radiusM = Math.min(
      20_000,
      Math.max(MIN_PROBE_RADIUS_M, (Number(radiusKm) || 1) * 1000),
    );
    const centre = { lat, lon };
    const probeRadius = Math.min(radiusM, MAX_PROBE_RADIUS_M);
    return {
      hits: db.hitsNear(centre, radiusM),
      unprobedCells: db.unprobedCells(cellsInCircle(lat, lon, probeRadius))
        .length,
    };
  }

  /**
   * Re-check panoramas nearing the 30-day limit by id (one request each), and
   * drop what Google no longer serves or the cap left unchecked past 30 days.
   */
  async function sweep({ signal } = {}) {
    await ensureLoaded();
    const result = { checked: 0, refreshed: 0, dropped: 0, stopped: null };
    if (blocker()) {
      db.expire();
      await db.save().catch(() => {});
      result.stopped = 'not_configured';
      return result;
    }
    const cutoff = now() - PANO_RECHECK_DAYS * DAY_MS;
    const due = db
      .allPanos()
      .filter((pano) => pano.checkedAt < cutoff)
      .sort((a, b) => a.checkedAt - b.checkedAt);
    try {
      for (const pano of due) {
        if (signal?.aborted || busy) break;
        const answer = await metadata({ pano: pano.panoId }, signal);
        result.checked++;
        if (answer.status === 'OK' && answer.panoId === pano.panoId) {
          db.putPano({
            ...pano,
            lat: answer.lat,
            lon: answer.lon,
            date: answer.date,
            copyright: answer.copyright,
            checkedAt: now(),
          });
          result.refreshed++;
        } else if (
          answer.status === 'ZERO_RESULTS' ||
          answer.status === 'NOT_FOUND'
        ) {
          db.dropPano(pano.panoId);
          result.dropped++;
        }
      }
    } catch (error) {
      if (!(error instanceof IndoorStop)) throw error;
      result.stopped = error.code;
    }
    db.expire();
    await db.save().catch(() => {});
    return result;
  }

  function runSweep() {
    if (sweeping || !indoorConfig(env).enabled || !apiKey()) return sweeping;
    sweeping = sweep()
      .then((result) => {
        if (result.checked)
          logger.log?.(
            `[StreetView:indoor] sweep re-checked ${result.checked}, dropped ${result.dropped}`,
          );
        return result;
      })
      .catch((error) => {
        logger.warn?.(
          '[StreetView:indoor] sweep failed:',
          error?.message || error,
        );
      })
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  }

  /** Start the paced background sweep: shortly after startup, then twice a day. */
  function start() {
    if (sweepTimer) return;
    const first = setTimeout(runSweep, SWEEP_DELAY_MS);
    first.unref?.();
    sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    sweepTimer.first = first;
  }

  function stop() {
    if (!sweepTimer) return;
    clearTimeout(sweepTimer.first);
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return { status, probe, hitsNear, sweep, start, stop, checkTarget };
}
