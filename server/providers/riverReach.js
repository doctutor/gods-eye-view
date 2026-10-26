// Personal fork: click a river reach (src/layers/rivers/reachHighlight.js),
// through Earth Engine's REST API with the Earth Engine layers' service
// account. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
// Personal fork: the river names sidecar names a clicked reach.
import { createRiverNamesIndex, riverNamesDir } from './riverNames/index.js';
import { createLiveRiverNames } from './riverNames/live.js';
import {
  EE_API,
  createServiceAccountAuth,
  earthEngineSettings,
} from './earthEngine.js';
import {
  DOWNSTREAM_HOPS,
  RIVER_REACH_ROUTE,
  RIVER_REACH_SCHEMA,
  UPSTREAM_LEVELS,
  UPSTREAM_ORDER_SPAN,
  UPSTREAM_REACH_CAP,
  maxOrderForHeight,
  parseReachId,
  parseReachQuery,
  toleranceForHeight,
} from '../../src/data/riverReach.js';

/**
 * The reach nearest a click, the path its water takes to the sea or an
 * inland sink, and the network above it, from HydroRIVERS v1 as Earth
 * Engine holds it with the Free-Flowing Rivers attributes (Grill et al.
 * 2019): table WWF/HydroSHEDS/v1/FreeFlowingRivers. The answer's shape is
 * src/data/riverReach.js's, which any other source (a self-hosted
 * HydroSHEDS v2 network) answers too.
 *
 *   GET /api/rivers/reach?lat=&lon=&heightM=[&upstream=1]
 *       the reach nearest the click within a tolerance that grows with the
 *       camera's height, and its downstream path; with upstream=1 also the
 *       upstream network (slower)
 *   GET /api/rivers/reach/<source>/<id>[?upstream=1]
 *       the same for a reach by id
 *   GET /api/rivers/reach/<source>/<id>/upstream
 *       only the upstream network
 *
 * Earth Engine requests (measured in docs/PERSONAL-FORK.md):
 *   1. the nearest reach: a spatially indexed withinDistance filter, sorted
 *      by distance, limit 1 (about 1 s);
 *   2. the downstream path in one request, however long: a backbone (BB_ID)
 *      is a contiguous flow path, so the reaches below the clicked one on
 *      its backbone are `BB_ID = b and UPLAND_SKM >= u`; the backbone's
 *      lowest reach's NDOID names the next backbone's entry, and so on. The
 *      hops are nested in one expression graph, up to DOWNSTREAM_HOPS; past
 *      the terminal reach (NDOID 0) they are empty and cost almost nothing
 *      (about 3.5 s in all);
 *   3. the upstream network in one request: the clicked backbone above the
 *      reach, then the backbones whose lowest reach drains into what is
 *      already found, UPSTREAM_LEVELS deep, within UPSTREAM_ORDER_SPAN
 *      orders of the clicked one, the UPSTREAM_REACH_CAP largest kept
 *      (about 1.1 s a level).
 * Answers are kept on disk by reach id (.gev-cache/rivers/reach/), so a
 * reach seen once costs request 1 only, and a click repeated costs nothing.
 */

export const FFR_TABLE = 'WWF/HydroSHEDS/v1/FreeFlowingRivers';
export const V1_SOURCE = Object.freeze({
  id: 'hydrorivers-v1',
  name: 'HydroRIVERS v1 · Free-Flowing Rivers',
  attribution:
    'HydroSHEDS (Lehner et al. 2008), Free-Flowing Rivers (Grill et al. 2019) via Google Earth Engine',
});
/** The reach properties an answer carries. */
export const REACH_PROPERTIES = Object.freeze([
  'NOID',
  'NDOID',
  'REACH_ID',
  'RIV_ORD',
  'DIS_AV_CMS',
  'LENGTH_KM',
  'UPLAND_SKM',
  'CSI',
  'CSI_FF',
  'CSI_FF2',
  'CSI_D',
  'BB_ID',
  'BB_NAME',
  'BB_OCEAN',
  'BB_LEN_KM',
  'BAS_ID',
  'BAS_NAME',
  'COUNTRY',
  'CONTINENT',
]);
/** What each reach on a path carries: enough to order, join and name it. */
const PATH_PROPERTIES = Object.freeze([
  'NOID',
  'NDOID',
  'BB_ID',
  'BB_NAME',
  'BB_OCEAN',
  'RIV_ORD',
  'LENGTH_KM',
  'UPLAND_SKM',
]);
/** The cached answer's layout; a change here ignores older files. */
export const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join('.gev-cache', 'rivers', 'reach');
/** Earth Engine requests per rolling minute, and at once. */
export const DEFAULT_LIMITS = Object.freeze({ perMinute: 40, concurrent: 3 });
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const NEEDS_KEY =
  'Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to look up rivers';

// --- the expressions ---------------------------------------------------------

/**
 * An Earth Engine expression graph whose every invocation is a value
 * referenced by key, so the nested hops stay linear in size.
 */
function graph() {
  const values = {};
  let next = 0;
  const c = (value) => ({ constantValue: value });
  const f = (functionName, args) => {
    const key = String(next++);
    values[key] = {
      functionInvocationValue: { functionName, arguments: args },
    };
    return { valueReference: key };
  };
  const list = (items) => ({ arrayValue: { values: items } });
  /** A one-argument function for Collection.map: body(argument) → node. */
  const fn = (body) => {
    const name = `_v${next}`;
    const node = body({ argumentReference: name });
    return {
      functionDefinitionValue: {
        argumentNames: [name],
        body: node.valueReference,
      },
    };
  };
  const done = (node) => ({ values, result: node.valueReference });
  return { c, f, list, fn, done };
}

function helpers(g) {
  const { c, f, list, fn } = g;
  const table = f('Collection.loadTable', { tableId: c(FFR_TABLE) });
  const filter = (collection, ...filters) =>
    f('Collection.filter', {
      collection,
      filter:
        filters.length === 1
          ? filters[0]
          : f('Filter.and', { filters: list(filters) }),
    });
  const eq = (field, value) =>
    f('Filter.equals', { leftField: c(field), rightValue: value });
  const gte = (field, value) =>
    f('Filter.greaterThanOrEquals', { leftField: c(field), rightValue: value });
  const lte = (field, value) =>
    f('Filter.lessThanOrEquals', { leftField: c(field), rightValue: value });
  // Filter.inList does not match a numeric field against a list over REST;
  // listContains with the list on the left does (the JS client's own inList).
  const inList = (field, valuesNode) =>
    f('Filter.listContains', { leftValue: valuesNode, rightField: c(field) });
  const not = (inner) => f('Filter.not', { filter: inner });
  /** A property of a collection's first element, or null when it is empty. */
  const firstOf = (collection, property) =>
    f('Dictionary.get', {
      dictionary: f('Collection.reduceColumns', {
        collection,
        reducer: f('Reducer.first', {}),
        selectors: c([property]),
      }),
      key: c('first'),
    });
  const array = (collection, property) =>
    f('AggregateFeatureCollection.array', {
      collection,
      property: c(property),
    });
  const merge = (collections) =>
    collections.reduce((all, one) =>
      f('Collection.merge', { collection1: all, collection2: one }),
    );
  const select = (collection, properties) =>
    f('Collection.map', {
      collection,
      baseAlgorithm: fn((feature) =>
        f('Feature.select', {
          input: feature,
          propertySelectors: c(properties),
        }),
      ),
    });
  return {
    table,
    filter,
    eq,
    gte,
    lte,
    inList,
    not,
    firstOf,
    array,
    merge,
    select,
  };
}

/** The reach nearest a point within a distance, with its distance as gev_distM. */
export function nearestExpression({ lat, lon, toleranceM, maxOrder }) {
  const g = graph();
  const { c, f, fn } = g;
  const { table, filter, lte } = helpers(g);
  const point = f('GeometryConstructors.Point', { coordinates: c([lon, lat]) });
  const near = filter(
    table,
    f('Filter.withinDistance', {
      distance: c(toleranceM),
      leftField: c('.geo'),
      rightValue: point,
      maxError: f('ErrorMargin', { value: c(10) }),
    }),
    lte('RIV_ORD', c(maxOrder)),
  );
  const measured = f('Collection.map', {
    collection: near,
    baseAlgorithm: fn((feature) =>
      f('Element.set', {
        object: feature,
        key: c('gev_distM'),
        value: f('Geometry.distance', {
          left: f('Feature.geometry', { feature }),
          right: point,
          maxError: f('ErrorMargin', { value: c(1) }),
        }),
      }),
    ),
  });
  return g.done(
    f('Collection.limit', {
      collection: measured,
      limit: c(1),
      key: c('gev_distM'),
      ascending: c(true),
    }),
  );
}

/** One reach by id, all its properties. */
export function reachByIdExpression(id) {
  const g = graph();
  const { table, filter, eq } = helpers(g);
  return g.done(filter(table, eq('NOID', g.c(id))));
}

/**
 * The reaches from a reach down to its terminal reach, in one request: per
 * backbone, the reaches at or below the entry (`UPLAND_SKM` only grows
 * downstream), then the next backbone from the lowest reach's NDOID.
 * `entry` gives the first backbone and upland when they are known (a
 * click's nearest reach), else they are looked up from the id.
 */
export function downstreamExpression({
  id,
  entry = null,
  hops = DOWNSTREAM_HOPS,
}) {
  const g = graph();
  const { c, f } = g;
  const { table, filter, eq, gte, firstOf, merge, select } = helpers(g);
  const segments = [];
  let entryId = c(id);
  for (let hop = 0; hop < hops; hop++) {
    let backbone;
    let upland;
    if (hop === 0 && entry) {
      backbone = c(entry.BB_ID);
      upland = c(entry.UPLAND_SKM);
    } else {
      const reach = filter(table, eq('NOID', entryId));
      backbone = firstOf(reach, 'BB_ID');
      upland = firstOf(reach, 'UPLAND_SKM');
    }
    const segment = filter(
      table,
      eq('BB_ID', backbone),
      gte('UPLAND_SKM', upland),
    );
    segments.push(segment);
    const lowest = f('Collection.limit', {
      collection: segment,
      limit: c(1),
      key: c('UPLAND_SKM'),
      ascending: c(false),
    });
    entryId = firstOf(lowest, 'NDOID');
  }
  return g.done(select(merge(segments), [...PATH_PROPERTIES]));
}

/**
 * The network above a reach, in one request: its own backbone above it, then
 * each level of backbones whose lowest reach drains into what is found, all
 * within `maxOrder`, the `cap` largest by upstream area (a kept reach's
 * downstream neighbours are kept too, so the network stays connected).
 *
 * Each level is cut to its own `cap` largest before the next is found: that
 * loses nothing the final cut keeps (a tributary is smaller than the reach
 * it drains into), and it bounds the id lists the filters carry, which Earth
 * Engine refuses as "too complex" when they grow to tens of thousands. A
 * join instead of the lists was tried and took over a minute. Asks for
 * cap + 1 to tell a truncated network.
 */
export function upstreamExpression({
  entry,
  maxOrder,
  levels = UPSTREAM_LEVELS,
  cap = UPSTREAM_REACH_CAP,
}) {
  const g = graph();
  const { c, f } = g;
  const { table, filter, eq, lte, inList, not, array, merge, select } =
    helpers(g);
  const largest = (collection) =>
    f('Collection.limit', {
      collection,
      limit: c(cap + 1),
      key: c('UPLAND_SKM'),
      ascending: c(false),
    });
  let level = largest(
    filter(
      table,
      eq('BB_ID', c(entry.BB_ID)),
      lte('UPLAND_SKM', c(entry.UPLAND_SKM)),
      lte('RIV_ORD', c(maxOrder)),
    ),
  );
  const found = [level];
  for (let depth = 1; depth <= levels; depth++) {
    // The lowest reaches of the backbones that drain into this level: they
    // drain into one of its reaches from another backbone.
    const backbones = f('List.distinct', { list: array(level, 'BB_ID') });
    const mouths = filter(
      table,
      inList('NDOID', array(level, 'NOID')),
      not(inList('BB_ID', backbones)),
      lte('BB_DIS_ORD', c(maxOrder)),
    );
    level = largest(
      filter(
        table,
        inList('BB_ID', f('List.distinct', { list: array(mouths, 'BB_ID') })),
        lte('RIV_ORD', c(maxOrder)),
      ),
    );
    found.push(level);
  }
  return g.done(select(largest(merge(found)), [...PATH_PROPERTIES]));
}

// --- shaping -------------------------------------------------------------------

const round5 = (value) => Math.round(value * 1e5) / 1e5;
const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle metres between two [lon, lat] points. */
export function haversineM(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A GeoJSON line's points as one [lon, lat] list (a MultiLineString's parts joined). */
export function linePoints(geometry) {
  if (!geometry) return [];
  const parts =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const out = [];
  for (const part of parts)
    for (const point of part || [])
      if (Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]))
        out.push([round5(point[0]), round5(point[1])]);
  return out;
}

/** The properties an answer keeps, nulls for the missing. */
export function pickProperties(properties = {}, keys = REACH_PROPERTIES) {
  const out = {};
  for (const key of keys) {
    const value = properties[key];
    out[key] = value === undefined || value === '' ? null : value;
  }
  return out;
}

/**
 * Points joined with the flow: each next part turned to start where the
 * last ended, the shared point once.
 * @param {Array<Array<[number, number]>>} parts in flow order
 */
export function joinParts(parts) {
  const lines = parts.filter((part) => part.length >= 2);
  if (!lines.length) return [];
  let out = [...lines[0]];
  if (lines.length > 1) {
    const second = lines[1];
    const reach = (point) =>
      Math.min(haversineM(point, second[0]), haversineM(point, second.at(-1)));
    if (reach(out[0]) < reach(out.at(-1))) out.reverse();
  }
  for (const part of lines.slice(1)) {
    const end = out.at(-1);
    const next =
      haversineM(end, part.at(-1)) < haversineM(end, part[0])
        ? [...part].reverse()
        : part;
    out = out.concat(haversineM(end, next[0]) < 1 ? next.slice(1) : next);
  }
  return out;
}

/**
 * Where a point falls on a line: metres from the point to the line, and
 * the line's length after that spot (nearest point on each segment, in a
 * local equirectangular frame: a reach is a few kilometres).
 */
export function projectOnLine(points, lon, lat) {
  if (!points.length) return { distanceM: NaN, remainingM: 0, lengthM: 0 };
  const kx = Math.cos(lat * RAD);
  let best = { distanceM: Infinity, index: 0, t: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = (bx - ax) * kx;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2
      ? Math.max(
          0,
          Math.min(1, ((lon - ax) * kx * dx + (lat - ay) * dy) / len2),
        )
      : 0;
    const spot = [ax + (bx - ax) * t, ay + (by - ay) * t];
    const distanceM = haversineM([lon, lat], spot);
    if (distanceM < best.distanceM) best = { distanceM, index: i, t };
  }
  if (points.length === 1) best.distanceM = haversineM([lon, lat], points[0]);
  const segmentM = points.map((point, i) =>
    i ? haversineM(points[i - 1], point) : 0,
  );
  const lengthM = segmentM.reduce((sum, m) => sum + m, 0);
  let remainingM = (segmentM[best.index + 1] || 0) * (1 - best.t);
  for (let i = best.index + 2; i < points.length; i++)
    remainingM += segmentM[i];
  return { distanceM: best.distanceM, remainingM, lengthM };
}

const byNoid = (features) => {
  const map = new Map();
  for (const feature of features) {
    const id = Number(feature?.properties?.NOID);
    if (Number.isFinite(id) && !map.has(id)) map.set(id, feature);
  }
  return map;
};

/**
 * The reach a click found or an id named, shaped. `geometry` keeps the
 * reach's points with the flow (HydroRIVERS lines are drawn source to mouth;
 * turned when the downstream path says otherwise).
 */
export function shapeReach(feature, downstreamStart = null) {
  let points = linePoints(feature?.geometry);
  if (downstreamStart && points.length >= 2) {
    const tail = haversineM(points.at(-1), downstreamStart);
    const head = haversineM(points[0], downstreamStart);
    if (head < tail) points = [...points].reverse();
  }
  return {
    id: Number(feature?.properties?.NOID),
    properties: pickProperties(feature?.properties),
    geometry: { type: 'LineString', coordinates: points },
  };
}

/**
 * The path below a reach from the trace's reaches: walked from the clicked
 * reach along NDOID, cut into backbones. The clicked reach itself is not in
 * the segments (it is drawn as the reach).
 */
export function shapeDownstream(features, clickedId) {
  const reaches = byNoid(features);
  const walked = [];
  const seen = new Set([clickedId]);
  let next = Number(reaches.get(clickedId)?.properties?.NDOID);
  while (
    Number.isFinite(next) &&
    next > 0 &&
    reaches.has(next) &&
    !seen.has(next)
  ) {
    seen.add(next);
    walked.push(reaches.get(next));
    next = Number(reaches.get(next).properties.NDOID);
  }
  const clicked = reaches.get(clickedId);
  const last = walked.at(-1) || clicked;
  const lastNext = Number(last?.properties?.NDOID);
  const complete = Boolean(last) && lastNext === 0;
  const segments = [];
  for (const feature of walked) {
    const props = feature.properties;
    let segment = segments.at(-1);
    if (!segment || segment.backboneId !== props.BB_ID) {
      segment = {
        backboneId: props.BB_ID ?? null,
        name: props.BB_NAME || null,
        order: props.RIV_ORD ?? null,
        lengthKm: 0,
        parts: [],
      };
      segments.push(segment);
    }
    segment.order = Math.min(
      segment.order ?? Infinity,
      props.RIV_ORD ?? Infinity,
    );
    segment.lengthKm += Number(props.LENGTH_KM) || 0;
    segment.parts.push(linePoints(feature.geometry));
  }
  const shaped = segments.map(({ parts, ...segment }) => ({
    ...segment,
    order: Number.isFinite(segment.order) ? segment.order : null,
    lengthKm: Math.round(segment.lengthKm * 10) / 10,
    coordinates: joinParts(parts),
  }));
  // Each segment starts where the one above it ends.
  for (let i = 1; i < shaped.length; i++) {
    const end = shaped[i - 1].coordinates.at(-1);
    const line = shaped[i].coordinates;
    if (
      end &&
      line.length >= 2 &&
      haversineM(end, line.at(-1)) < haversineM(end, line[0])
    )
      line.reverse();
  }
  const lengthKm = shaped.reduce((sum, s) => sum + s.lengthKm, 0);
  const ocean = Number(last?.properties?.BB_OCEAN) === 1;
  return {
    complete,
    terminal: complete ? (ocean ? 'ocean' : 'inland') : 'unknown',
    reaches: walked.length,
    lengthKm: Math.round(lengthKm * 10) / 10,
    mouth: shaped.at(-1)?.coordinates.at(-1) || null,
    segments: shaped,
  };
}

/**
 * The network above a reach, one line per backbone (its reaches ordered by
 * upstream area, so with the flow), the clicked reach left out.
 */
export function shapeUpstream(features, clickedId, { maxOrder, levels, cap }) {
  const truncated = features.length > cap;
  const kept = features
    .filter((feature) => Number(feature?.properties?.NOID) !== clickedId)
    .slice(0, cap);
  const backbones = new Map();
  for (const feature of kept) {
    const key = feature.properties.BB_ID ?? `reach:${feature.properties.NOID}`;
    if (!backbones.has(key)) backbones.set(key, []);
    backbones.get(key).push(feature);
  }
  const lines = [];
  let lengthKm = 0;
  for (const [backboneId, group] of backbones) {
    group.sort((a, b) => a.properties.UPLAND_SKM - b.properties.UPLAND_SKM);
    // A backbone is one path; a gap (a reach dropped by the cap or the order
    // limit) starts a new line.
    let run = [];
    const flush = () => {
      if (!run.length) return;
      lines.push({
        backboneId: typeof backboneId === 'number' ? backboneId : null,
        name: run[0].properties.BB_NAME || null,
        order: Math.min(...run.map((f) => f.properties.RIV_ORD ?? 99)),
        coordinates: joinParts(run.map((f) => linePoints(f.geometry))),
      });
      run = [];
    };
    for (const feature of group) {
      const previous = run.at(-1);
      if (
        previous &&
        Number(previous.properties.NDOID) !== feature.properties.NOID
      )
        flush();
      run.push(feature);
      lengthKm += Number(feature.properties.LENGTH_KM) || 0;
    }
    flush();
  }
  lines.sort((a, b) => a.order - b.order);
  return {
    reaches: kept.length,
    lengthKm: Math.round(lengthKm * 10) / 10,
    maxOrder,
    levels,
    truncated,
    lines: lines.filter((line) => line.coordinates.length >= 2),
  };
}

/** The click's distance to the reach and, along the path, to the mouth. */
export function clickDistances(reach, downstream, lat, lon) {
  const points = reach?.geometry?.coordinates || [];
  const lengthKm = Number(reach?.properties?.LENGTH_KM) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || points.length < 2)
    return {
      distanceM: null,
      distanceToMouthKm: Math.round((lengthKm + downstream.lengthKm) * 10) / 10,
    };
  const { distanceM, remainingM, lengthM } = projectOnLine(points, lon, lat);
  // Scale the drawn line's share to the reach's own length.
  const share = lengthM > 0 ? remainingM / lengthM : 1;
  return {
    distanceM: Math.round(distanceM),
    distanceToMouthKm:
      Math.round((share * lengthKm + downstream.lengthKm) * 10) / 10,
  };
}

// --- Earth Engine -----------------------------------------------------------

/** Earth Engine's own error text from a failed answer. */
async function errorText(response) {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message || '';
  return `Earth Engine ${response.status}${message ? `: ${String(message).slice(0, 300)}` : ''}`;
}

/**
 * The REST backend: value:compute, one request per collection whatever its
 * size (table:computeFeatures pages its answer and computes the whole graph
 * again for every page: the Danube above Budapest took 24.7 s paged, 11.1 s
 * in one value:compute, each with the nearest-reach request).
 * @returns {{computeFeatures: (expression: object) => Promise<{features: Array<object>, requests: number}>}}
 */
export function createRiverRestBackend({
  project,
  auth,
  fetchImpl = (...args) => fetch(...args),
}) {
  async function post(body) {
    const send = async () =>
      fetchImpl(
        `${EE_API}/projects/${encodeURIComponent(project)}/value:compute`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await auth.token()}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        },
      );
    let response = await send();
    if (response.status === 401) {
      auth.forget();
      response = await send();
    }
    if (!response.ok) throw new Error(await errorText(response));
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > MAX_ANSWER_BYTES)
      throw new Error('Earth Engine answer too large');
    return response.json();
  }
  return {
    async computeFeatures(expression) {
      const answer = await post({ expression });
      const features = answer?.result?.features;
      return { features: Array.isArray(features) ? features : [], requests: 1 };
    },
  };
}

class RateLimited extends Error {}

/**
 * Earth Engine calls, at most `concurrent` at once (the rest wait) and
 * `perMinute` started in any rolling minute (past that, refused).
 */
export function createLimiter({
  perMinute = DEFAULT_LIMITS.perMinute,
  concurrent = DEFAULT_LIMITS.concurrent,
  now = () => Date.now(),
} = {}) {
  const started = [];
  const waiting = [];
  let running = 0;
  const pump = () => {
    while (running < concurrent && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      running += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  return {
    run(task) {
      const t = now();
      while (started.length && t - started[0] >= 60_000) started.shift();
      if (started.length >= perMinute)
        return Promise.reject(
          new RateLimited(
            'Too many river lookups this minute; try again shortly',
          ),
        );
      started.push(t);
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        pump();
      });
    },
  };
}

// --- the service ---------------------------------------------------------------

const answer = (status, body) => ({ status, body });
const failure = (status, error) => ({ status, body: { error } });

/**
 * HydroRIVERS v1 reaches through Earth Engine.
 * @param {{sourceRoot?: string, env?: object, backend?: object|null,
 *   fetchImpl?: typeof fetch, now?: () => number, limits?: object}} [options]
 *   `backend` ({computeFeatures}) replaces the REST one (tests).
 */
export function createRiverReachService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  backend = null,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  limits = DEFAULT_LIMITS,
  // Personal fork: the river names sidecar (riverNames/index.js), whose
  // nearest named line names a clicked reach.
  names = null,
  // Personal fork: the live name from the local Overpass when the sidecar
  // has none (riverNames/live.js).
  liveNames = null,
} = {}) {
  const dir = path.join(sourceRoot, CACHE_DIR);
  const limiter = createLimiter({ ...limits, now });
  /** A click's rounded place and rule → the reach id it found (or 0). */
  const clicks = new Map();
  /** A click's rounded place → its live name at the point (or null). */
  const pointNames = new Map();
  const inflight = new Map();
  let made = null;

  function engine() {
    if (backend) return backend;
    const settings = earthEngineSettings(env, sourceRoot);
    if (!settings.configured) return null;
    const key = `${settings.keyFile}\n${settings.project}`;
    if (made?.key !== key)
      made = {
        key,
        backend: createRiverRestBackend({
          project: settings.project,
          fetchImpl,
          auth: createServiceAccountAuth({
            keyFile: settings.keyFile,
            fetchImpl,
            now,
          }),
        }),
      };
    return made.backend;
  }

  /** One Earth Engine computation, counted. */
  async function compute(expression, tally) {
    const ee = engine();
    if (!ee) throw Object.assign(new Error(NEEDS_KEY), { status: 503 });
    const result = await limiter.run(() => ee.computeFeatures(expression));
    tally.requests += result.requests ?? 1;
    return result.features || [];
  }

  /** The same work asked twice at once is done once. */
  function once(key, work) {
    if (!inflight.has(key))
      inflight.set(
        key,
        Promise.resolve()
          .then(work)
          .finally(() => inflight.delete(key)),
      );
    return inflight.get(key);
  }

  const file = (id, part) =>
    path.join(dir, `${id}${part ? `.${part}` : ''}.json`);
  function readCache(id, part) {
    try {
      const target = file(id, part);
      if (now() - fs.statSync(target).mtimeMs > CACHE_TTL_MS) return null;
      const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
      return stored?.version === CACHE_VERSION ? stored : null;
    } catch {
      return null;
    }
  }
  function writeCache(id, part, payload) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = file(id, part);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: CACHE_VERSION, ...payload }),
      );
      fs.renameSync(temporary, target);
    } catch {
      /* answering matters more than keeping */
    }
  }

  /** The reach and its downstream path, from disk or Earth Engine. */
  async function trace(id, feature, tally) {
    const stored = readCache(id);
    if (stored?.reach && stored?.downstream) return { ...stored, cached: true };
    return once(`trace:${id}`, async () => {
      const entry = feature?.properties
        ? {
            BB_ID: feature.properties.BB_ID,
            UPLAND_SKM: feature.properties.UPLAND_SKM,
          }
        : null;
      const [chain, found] = await Promise.all([
        compute(downstreamExpression({ id, entry }), tally),
        feature ? [feature] : compute(reachByIdExpression(id), tally),
      ]);
      const reachFeature = found[0];
      if (!reachFeature) return null;
      const downstream = shapeDownstream(chain, id);
      const reach = shapeReach(
        reachFeature,
        downstream.segments[0]?.coordinates[0],
      );
      writeCache(id, '', { reach, downstream });
      return { reach, downstream, cached: false };
    });
  }

  /** The network above a reach, from disk or Earth Engine. */
  async function upstreamOf(reach, tally) {
    const id = reach.id;
    const stored = readCache(id, 'upstream');
    if (stored?.upstream) return { upstream: stored.upstream, cached: true };
    return once(`upstream:${id}`, async () => {
      const order = Number(reach.properties.RIV_ORD) || 10;
      const maxOrder = Math.min(12, order + UPSTREAM_ORDER_SPAN);
      const features = await compute(
        upstreamExpression({ entry: reach.properties, maxOrder }),
        tally,
      );
      const upstream = shapeUpstream(features, id, {
        maxOrder,
        levels: UPSTREAM_LEVELS,
        cap: UPSTREAM_REACH_CAP,
      });
      writeCache(id, 'upstream', { upstream });
      return { upstream, cached: false };
    });
  }

  /**
   * The reach's live OpenStreetMap name (riverNames/live.js), asked once
   * and kept with the reach (<id>.osmname.json, CACHE_TTL_MS), a "none" too;
   * a failed lookup is not kept and names nothing.
   */
  async function liveNameOf(reach) {
    const stored = readCache(reach.id, 'osmname');
    if (stored && 'osmName' in stored) return stored.osmName;
    return once(`osmname:${reach.id}`, async () => {
      const found = await liveNames.name(reach);
      if (found.status === 'failed') return null;
      const osmName = found.status === 'named' ? found.osmName : null;
      writeCache(reach.id, 'osmname', { osmName });
      return osmName;
    });
  }

  /**
   * The name of a waterway at a click no reach is near: the sidecar's
   * (its own radius by the river's size), else a live one from the local
   * Overpass (liveNames.nameAt), kept by the rounded click; null when none.
   */
  async function nameAt({ lat, lon }) {
    let osmName = null;
    if (names)
      try {
        osmName = names.nearest({ lat, lon });
      } catch (error) {
        console.warn('[Rivers] name lookup failed:', error?.message);
      }
    if (osmName || !liveNames?.nameAt) return osmName;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (pointNames.has(key)) return pointNames.get(key);
    return once(`osmnameat:${key}`, async () => {
      const found = await liveNames.nameAt({ lat, lon });
      if (found.status === 'failed') return null;
      const named = found.status === 'named' ? found.osmName : null;
      pointNames.set(key, named);
      if (pointNames.size > 1000)
        pointNames.delete(pointNames.keys().next().value);
      return named;
    });
  }

  const links = (id) => ({
    self: `${RIVER_REACH_ROUTE}/${V1_SOURCE.id}/${id}`,
    upstream: `${RIVER_REACH_ROUTE}/${V1_SOURCE.id}/${id}/upstream`,
  });

  async function guarded(work) {
    if (!engine()) return failure(503, NEEDS_KEY);
    try {
      return await work();
    } catch (error) {
      if (error instanceof RateLimited) return failure(429, error.message);
      if (error?.status === 503) return failure(503, error.message);
      console.warn(
        '[Rivers] reach lookup failed:',
        String(error?.message || error).slice(0, 300),
      );
      return failure(502, 'Earth Engine could not trace this river');
    }
  }

  async function full(id, feature, { upstream, click, query, started, tally }) {
    const traced = await trace(id, feature, tally);
    if (!traced) return failure(404, 'No such reach');
    const up = upstream ? await upstreamOf(traced.reach, tally) : null;
    const distances = clickDistances(
      traced.reach,
      traced.downstream,
      click?.lat,
      click?.lon,
    );
    const reach = { ...traced.reach };
    if (click) reach.distanceM = distances.distanceM;
    // The name OpenStreetMap gives the river at the click, if any.
    let osmName = null;
    if (click && names)
      try {
        osmName = names.nearest({ lat: click.lat, lon: click.lon });
      } catch (error) {
        console.warn('[Rivers] name lookup failed:', error?.message);
      }
    // None from the sidecar: the named waterway that follows the reach, live
    // from the local Overpass. Not for a reach BB_NAME names: that name is
    // authoritative for the big rivers, and a live one would not be shown.
    if (!osmName && liveNames && !traced.reach.properties?.BB_NAME)
      try {
        osmName = await liveNameOf(traced.reach);
      } catch (error) {
        console.warn('[Rivers] live name lookup failed:', error?.message);
      }
    return answer(200, {
      schema: RIVER_REACH_SCHEMA,
      source: V1_SOURCE,
      ...(query ? { query } : {}),
      reach,
      ...(osmName ? { osmName } : {}),
      downstream: {
        ...traced.downstream,
        distanceToMouthKm: distances.distanceToMouthKm,
      },
      upstream: up ? up.upstream : null,
      links: links(id),
      cached: traced.cached && (!up || up.cached),
      timing: { ms: now() - started, requests: tally.requests },
    });
  }

  return {
    source: V1_SOURCE,
    /** HydroRIVERS v1 covers the world's land below 60°N and much above it. */
    covers: () => true,

    /** The reach nearest a click, its downstream path, and maybe its network. */
    async atPoint({ lat, lon, heightM, maxOrder: order, upstream = false }) {
      const started = now();
      const tally = { requests: 0 };
      const toleranceM = toleranceForHeight(heightM);
      const maxOrder = order ?? maxOrderForHeight(heightM);
      const query = { lat, lon, heightM, toleranceM, maxOrder };
      return guarded(async () => {
        const key = `${lat.toFixed(4)},${lon.toFixed(4)},${toleranceM},${maxOrder}`;
        let id = clicks.get(key);
        let feature = null;
        if (id === undefined) {
          const found = await once(`near:${key}`, () =>
            compute(
              nearestExpression({ lat, lon, toleranceM, maxOrder }),
              tally,
            ),
          );
          feature = found[0] || null;
          id = feature ? Number(feature.properties?.NOID) : 0;
          clicks.set(key, id);
          if (clicks.size > 1000) clicks.delete(clicks.keys().next().value);
        }
        if (!id) {
          // No HydroRIVERS reach near enough: the waterway's name alone,
          // when OpenStreetMap has one here (nothing to highlight).
          let osmName = null;
          try {
            osmName = await nameAt({ lat, lon });
          } catch (error) {
            console.warn('[Rivers] name lookup failed:', error?.message);
          }
          if (osmName)
            return answer(200, {
              schema: RIVER_REACH_SCHEMA,
              source: V1_SOURCE,
              query,
              nameOnly: true,
              reach: null,
              osmName,
              downstream: null,
              upstream: null,
              links: null,
              cached: false,
              timing: { ms: now() - started, requests: tally.requests },
            });
          return failure(404, `No river within ${toleranceM} m of this point`);
        }
        return full(id, feature, {
          upstream,
          click: { lat, lon },
          query,
          started,
          tally,
        });
      });
    },

    /** A reach by id, its downstream path, and maybe its network. */
    async byId(id, { upstream = false } = {}) {
      const started = now();
      const tally = { requests: 0 };
      return guarded(() => full(id, null, { upstream, started, tally }));
    },

    /** Only the network above a reach. */
    async upstream(id) {
      const started = now();
      const tally = { requests: 0 };
      return guarded(async () => {
        const traced = await trace(id, null, tally);
        if (!traced) return failure(404, 'No such reach');
        const up = await upstreamOf(traced.reach, tally);
        return answer(200, {
          schema: RIVER_REACH_SCHEMA,
          source: V1_SOURCE,
          reachId: id,
          upstream: up.upstream,
          links: links(id),
          cached: up.cached,
          timing: { ms: now() - started, requests: tally.requests },
        });
      });
    },
  };
}

// --- the routes ------------------------------------------------------------------

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    status === 200 ? 'private, max-age=3600' : 'no-store',
  );
  res.end(JSON.stringify(payload));
}

const ID_PATH = /^\/([a-z0-9-]{1,40})\/(\d{1,12})(\/upstream)?$/;

/**
 * The routes under /api/rivers/reach (same-site only, GET only).
 * `sources` are tried in order for a click (the first whose covers(lat, lon)
 * says yes answers), and named by their source.id in the id routes: a
 * self-hosted HydroSHEDS v2 network for the Americas goes before the v1
 * service and answers the same shape.
 * @param {{sources: Array<{source: {id: string}, covers: Function,
 *   atPoint: Function, byId: Function, upstream: Function}>}} options
 */
export function createRiverReachHandler({ sources }) {
  const byId = new Map(sources.map((service) => [service.source.id, service]));
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/') {
        const query = parseReachQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        const service =
          sources.find((candidate) => {
            try {
              return candidate.covers(query.lat, query.lon);
            } catch {
              return false;
            }
          }) || null;
        if (!service)
          return sendJson(res, 404, {
            error: 'No river source covers this point',
          });
        const { status, body } = await service.atPoint(query);
        return sendJson(res, status, body);
      }
      const match = ID_PATH.exec(route);
      if (match) {
        const service = byId.get(match[1]);
        const id = parseReachId(match[2]);
        if (!service)
          return sendJson(res, 404, { error: 'No such river source' });
        if (!id) return sendJson(res, 400, { error: 'Bad reach id' });
        const upstream = url.searchParams.get('upstream');
        if (upstream !== null && !['0', '1'].includes(upstream))
          return sendJson(res, 400, { error: 'upstream must be 0 or 1' });
        const { status, body } = match[3]
          ? await service.upstream(id)
          : await service.byId(id, { upstream: upstream === '1' });
        return sendJson(res, status, body);
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Rivers] route failed:', error?.message);
      return sendJson(res, 500, { error: 'River lookup unavailable' });
    }
  };
}

let shared = null;
let sharedNames = null;

/** The river names sidecar the dev server reads (one, shared). */
export function sharedRiverNames(sourceRoot = defaultSourceRoot) {
  sharedNames ||= createRiverNamesIndex({
    dir: riverNamesDir(process.env, sourceRoot),
  });
  return sharedNames;
}

/** Vite plugin: /api/rivers/reach for clicking a river (the Rivers layer). */
export function riverReachProxy({
  sourceRoot = defaultSourceRoot,
  sources,
} = {}) {
  function install(middlewares) {
    shared ||= createRiverReachService({
      sourceRoot,
      names: sharedRiverNames(sourceRoot),
      liveNames: createLiveRiverNames(),
    });
    middlewares.use(
      RIVER_REACH_ROUTE,
      createRiverReachHandler({ sources: sources || [shared] }),
    );
  }
  return {
    name: 'river-reach',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
