// Personal fork: a clicked river reach named live from the local Overpass
// when the names sidecar (./index.js) has no name for it. Not part of
// upstream God's Eye View.
import { fetchOverpassPayload } from '../overpass/transport.js';
import {
  createWayIndex,
  localProjector,
  matchReach,
} from '../../../scripts/rivers/namesMatch.mjs';

/**
 * HydroRIVERS v1's reaches are drawn on its 15″ grid (about 450 m), in
 * steps of 45°, so their lines sit off OpenStreetMap's channels further
 * than the sidecar's 1″ v2 reaches do. Around Baltimore (2026-10-23) the
 * named waterway that follows a reach lay 63 to 114 m from it on average:
 * 150 m covered 21 to 87 % of each reach, 250 m 83 to 97 % for the streams
 * (49 % for the Susquehanna), 400 m all of them. Hence 250 m, and 400 m for
 * the big rivers (RIV_ORD 4 or less: 100 m³/s and more).
 */
export function liveToleranceM(rivOrd) {
  const order = Number(rivOrd);
  return Number.isFinite(order) && order <= 4 ? 400 : 250;
}
/** A waterway names the reach when it follows at least this share of it. */
export const LIVE_MIN_COVERAGE = 0.4;
/** A segment counts within this angle of the reach (v1 turns in 45° steps). */
export const LIVE_MAX_ANGLE_DEGREES = 60;
/** The one Overpass request a click may cost waits this long at most. */
export const LIVE_TIMEOUT_MS = 10_000;
/** Points of the reach the query follows (its line, thinned). */
const QUERY_POINTS = 40;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/**
 * The named waterways along a reach: Overpass's `around` over the reach's
 * own line (a polyline, not only the click), rivers, streams and canals
 * with a name, their tags and geometry.
 * @param {number[][]} coordinates the reach's [lon, lat] points
 */
export function liveNameQuery(coordinates, radiusM) {
  const points = coordinates.filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  const step = Math.max(1, Math.ceil(points.length / QUERY_POINTS));
  const kept = points.filter(
    (_, i) => i % step === 0 || i === points.length - 1,
  );
  const line = kept
    .map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
    .join(',');
  return `[out:json][timeout:${Math.ceil(LIVE_TIMEOUT_MS / 1000)}];way(around:${Math.round(radiusM)},${line})["waterway"~"^(river|stream|canal)$"]["name"];out tags geom;`;
}

const nameGroup = (name) =>
  String(name || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The waterway that follows a reach, from Overpass's ways: grouped by name
 * (a river's ways do not all carry its Wikidata item), each sample of the
 * reach counting for the names whose nearest segment lies within the
 * tolerance and runs within LIVE_MAX_ANGLE_DEGREES of the reach; the name
 * covering the most of it wins, at LIVE_MIN_COVERAGE or more. A crossing
 * stream counts at one sample at most, and at a confluence the tributary
 * follows only the reach's end. Returns {name, nameEn?, wikidata?,
 * coverage, distanceM} or null.
 * @param {number[][]} coordinates the reach's [lon, lat] points
 * @param {object[]} elements Overpass ways with `tags` and `geometry`
 */
export function chooseWaterway(coordinates, elements, { toleranceM }) {
  const groups = [];
  const byKey = new Map();
  const ways = [];
  for (const element of elements || []) {
    const name = String(element?.tags?.name || '').trim();
    const key = nameGroup(name);
    const geometry = (element?.geometry || []).filter(
      (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
    );
    if (!key || geometry.length < 2) continue;
    if (!byKey.has(key)) {
      byKey.set(key, groups.length);
      groups.push({ name, nameEn: '', wikidata: '' });
    }
    const group = groups[byKey.get(key)];
    group.nameEn ||= String(element.tags['name:en'] || '').trim();
    group.wikidata ||= /^Q\d+$/.test(element.tags.wikidata || '')
      ? element.tags.wikidata
      : '';
    ways.push({
      group: byKey.get(key),
      coords: geometry.flatMap((p) => [p.lon, p.lat]),
    });
  }
  const points = (coordinates || []).filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (!ways.length || points.length < 2) return null;
  const project = localProjector(points[0][1]);
  const match = matchReach(
    points.flatMap(([lon, lat]) => [lon, lat]),
    createWayIndex(ways, { project }),
    {
      tolerance: toleranceM,
      minCoverage: LIVE_MIN_COVERAGE,
      maxAngle: LIVE_MAX_ANGLE_DEGREES,
    },
  );
  if (!match) return null;
  const group = groups[match.group];
  return {
    name: group.name,
    ...(group.nameEn && group.nameEn !== group.name
      ? { nameEn: group.nameEn }
      : {}),
    ...(group.wikidata ? { wikidata: group.wikidata } : {}),
    coverage: Math.round(match.coverage * 100) / 100,
    distanceM: Math.round(match.distance),
  };
}

/**
 * The live lookup: one request to the configured Overpass (OVERPASS_UPSTREAMS,
 * the local instance; never a public one), LIVE_TIMEOUT_MS at most.
 * `name(reach)` answers {status: 'named', osmName} (osmName as the
 * sidecar's, confidence 'live'), {status: 'none'} (an answer, no waterway
 * follows the reach: kept like a name), or {status: 'failed'} (no answer:
 * not kept, the card shows what it has).
 * @param {{fetchPayload?: typeof fetchOverpassPayload, timeoutMs?: number,
 *   fetchImpl?: typeof fetch}} [options]
 */
export function createLiveRiverNames({
  fetchPayload = fetchOverpassPayload,
  timeoutMs = LIVE_TIMEOUT_MS,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  // The transport waits OVERPASS_TIMEOUT_MS (22 s); a click waits less.
  const timedFetch = (url, init = {}) =>
    fetchImpl(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  return {
    async name(reach) {
      const coordinates = reach?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2)
        return { status: 'none' };
      const toleranceM = liveToleranceM(reach.properties?.RIV_ORD);
      let timer = null;
      try {
        const payload = await Promise.race([
          fetchPayload(
            `data=${encodeURIComponent(liveNameQuery(coordinates, toleranceM))}`,
            MAX_ANSWER_BYTES,
            { fetchImpl: timedFetch, simplify: (body) => body },
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Overpass took too long')),
              timeoutMs + 500,
            );
          }),
        ]);
        if (
          payload?.status !== 200 ||
          payload.rateLimited ||
          payload.runtimeError
        )
          return { status: 'failed' };
        const elements = JSON.parse(payload.body)?.elements;
        if (!Array.isArray(elements)) return { status: 'failed' };
        const chosen = chooseWaterway(coordinates, elements, { toleranceM });
        if (!chosen) return { status: 'none' };
        return {
          status: 'named',
          osmName: { ...chosen, confidence: 'live' },
        };
      } catch {
        return { status: 'failed' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
