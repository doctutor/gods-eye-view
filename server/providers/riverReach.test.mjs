// Personal fork: clicking a river reach (server/providers/riverReach.js),
// with Earth Engine faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CACHE_VERSION,
  FFR_TABLE,
  V1_SOURCE,
  clickDistances,
  createLimiter,
  createRiverReachHandler,
  createRiverReachService,
  createRiverRestBackend,
  downstreamExpression,
  joinParts,
  nearestExpression,
  projectOnLine,
  reachByIdExpression,
  shapeDownstream,
  shapeReach,
  shapeUpstream,
  upstreamExpression,
} from './riverReach.js';
import {
  DEFAULT_HEIGHT_M,
  DOWNSTREAM_HOPS,
  MAX_TOLERANCE_M,
  MIN_TOLERANCE_M,
  RIVER_REACH_ROUTE,
  RIVER_REACH_SCHEMA,
  UPSTREAM_LEVELS,
  maxOrderForHeight,
  parseReachId,
  parseReachQuery,
  toleranceForHeight,
} from '../../src/data/riverReach.js';

const q = (query) => parseReachQuery(new URLSearchParams(query));

test('a click needs a place on the globe; height, size limit and upstream are checked', () => {
  assert.deepEqual(q('lat=38.6&lon=-90.2&heightM=5000'), {
    lat: 38.6,
    lon: -90.2,
    heightM: 5000,
    maxOrder: 10,
    upstream: false,
  });
  assert.equal(q('lat=1&lon=2').heightM, DEFAULT_HEIGHT_M);
  assert.equal(q('lat=1&lon=2&upstream=1').upstream, true);
  assert.equal(q('lat=1&lon=2&heightM=1000000').maxOrder, 5);
  assert.equal(q('lat=1&lon=2&heightM=1000000&maxOrder=7').maxOrder, 7);
  for (const bad of [
    '',
    'lat=1',
    'lon=1',
    'lat=91&lon=0',
    'lat=0&lon=-181',
    'lat=abc&lon=0',
    'lat=0&lon=0&heightM=-1',
    'lat=0&lon=0&heightM=1e9',
    'lat=0&lon=0&heightM=x',
    'lat=0&lon=0&maxOrder=0',
    'lat=0&lon=0&maxOrder=11',
    'lat=0&lon=0&maxOrder=2.5',
    'lat=0&lon=0&upstream=yes',
  ])
    assert.ok(q(bad).error, bad);
  assert.equal(parseReachId('7635839'), 7635839);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '0123', '1234567890123'])
    assert.equal(parseReachId(bad), null, bad);
});

test('the tolerance grows with the camera height, within 100 m and 50 km', () => {
  assert.equal(toleranceForHeight(0), MIN_TOLERANCE_M);
  assert.equal(toleranceForHeight(5_000), MIN_TOLERANCE_M);
  assert.equal(toleranceForHeight(10_000), 140);
  assert.equal(toleranceForHeight(100_000), 1400);
  assert.equal(toleranceForHeight(1_000_000), 14_000);
  assert.equal(toleranceForHeight(20_000_000), MAX_TOLERANCE_M);
  assert.equal(toleranceForHeight(NaN), MIN_TOLERANCE_M);
  let last = 0;
  for (let h = 0; h <= 10_000_000; h += 50_000) {
    assert.ok(toleranceForHeight(h) >= last, `${h}`);
    last = toleranceForHeight(h);
  }
  // Further away, only larger rivers (smaller RIV_ORD) are picked.
  assert.equal(maxOrderForHeight(1_000), 10);
  assert.equal(maxOrderForHeight(50_000), 8);
  assert.equal(maxOrderForHeight(200_000), 7);
  assert.equal(maxOrderForHeight(20_000_000), 3);
  let order = 10;
  for (let h = 0; h <= 20_000_000; h += 100_000) {
    assert.ok(maxOrderForHeight(h) <= order);
    order = maxOrderForHeight(h);
  }
});

/** Every node of an expression graph by function name. */
function invocations(expression) {
  const names = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.functionInvocationValue)
      names.push(node.functionInvocationValue.functionName);
    for (const value of Object.values(node)) visit(value);
  };
  visit(expression.values);
  return names;
}

/** True when every valueReference names a value of the graph. */
function referencesResolve(expression) {
  const keys = new Set(Object.keys(expression.values));
  let ok = keys.has(expression.result);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.valueReference === 'string')
      ok &&= keys.has(node.valueReference);
    if (node.functionDefinitionValue)
      ok &&= keys.has(node.functionDefinitionValue.body);
    for (const value of Object.values(node)) visit(value);
  };
  visit(expression.values);
  return ok;
}

test('the expressions: a spatial nearest, nested downstream hops, bounded upstream levels', () => {
  const near = nearestExpression({
    lat: 38.55,
    lon: -90.49,
    toleranceM: 1400,
    maxOrder: 8,
  });
  assert.ok(referencesResolve(near));
  const nearNames = invocations(near);
  for (const name of [
    'Collection.loadTable',
    'Filter.withinDistance',
    'Filter.lessThanOrEquals',
    'Geometry.distance',
    'Collection.limit',
  ])
    assert.ok(nearNames.includes(name), name);
  assert.ok(JSON.stringify(near).includes(FFR_TABLE));
  assert.ok(JSON.stringify(near).includes('[-90.49,38.55]'));

  const down = downstreamExpression({
    id: 7,
    entry: { BB_ID: 3, UPLAND_SKM: 9.5 },
  });
  assert.ok(referencesResolve(down));
  const downNames = invocations(down);
  assert.equal(
    downNames.filter((n) => n === 'Collection.merge').length,
    DOWNSTREAM_HOPS - 1,
  );
  // The table is loaded once and shared: the graph is linear in the hops.
  assert.equal(downNames.filter((n) => n === 'Collection.loadTable').length, 1);
  assert.ok(Object.keys(down.values).length < DOWNSTREAM_HOPS * 20);
  // A known entry skips the first lookup; an id alone looks it up.
  const byId = downstreamExpression({ id: 7 });
  assert.ok(
    invocations(byId).filter((n) => n === 'Reducer.first').length >
      downNames.filter((n) => n === 'Reducer.first').length,
  );

  const up = upstreamExpression({
    entry: { BB_ID: 3, UPLAND_SKM: 9.5 },
    maxOrder: 7,
  });
  assert.ok(referencesResolve(up));
  const upNames = invocations(up);
  // listContains, not inList (which does not match numbers over REST).
  assert.ok(upNames.includes('Filter.listContains'));
  assert.ok(!upNames.includes('Filter.inList'));
  assert.equal(
    upNames.filter((n) => n === 'Collection.merge').length,
    UPSTREAM_LEVELS,
  );
  assert.ok(referencesResolve(reachByIdExpression(5)));
});

// --- a small synthetic network ------------------------------------------------
//
//   10 → 11 ─┐                (backbone 100, "Creek", into the river)
//            ▼
//   20 → 21 → 22 → 23 → 0     (backbone 200, "River", to the ocean)
//   30 ──────┘                (backbone 300, unnamed, into 21)
//
// Reach 22 is drawn against the flow, as data sometimes is.
const line = (...points) => ({ type: 'LineString', coordinates: points });
const reach = (NOID, NDOID, BB_ID, props, geometry) => ({
  type: 'Feature',
  geometry,
  properties: {
    NOID,
    NDOID,
    BB_ID,
    BB_NAME: '',
    BB_OCEAN: 1,
    RIV_ORD: 6,
    LENGTH_KM: 1,
    UPLAND_SKM: 10,
    ...props,
  },
});
const NETWORK = [
  reach(
    10,
    11,
    100,
    { BB_NAME: 'Creek', UPLAND_SKM: 5, RIV_ORD: 7, BB_OCEAN: 0 },
    line([0, 1], [0, 0.5]),
  ),
  reach(
    11,
    21,
    100,
    {
      BB_NAME: 'Creek',
      UPLAND_SKM: 8,
      RIV_ORD: 7,
      BB_OCEAN: 0,
      LENGTH_KM: 2,
      DIS_AV_CMS: 0.5,
      CSI: 97,
      CSI_FF2: 1,
      CSI_D: 'URB',
      BAS_NAME: 'Test',
      COUNTRY: 'Nowhere',
      BAS_ID: 9,
    },
    line([0, 0.5], [0, 0.25], [0, 0]),
  ),
  reach(
    20,
    21,
    200,
    { BB_NAME: 'River', UPLAND_SKM: 50 },
    line([-1, 0], [-0.5, 0]),
  ),
  reach(
    21,
    22,
    200,
    { BB_NAME: 'River', UPLAND_SKM: 70 },
    line([-0.5, 0], [0, 0]),
  ),
  reach(
    22,
    23,
    200,
    { BB_NAME: 'River', UPLAND_SKM: 80, LENGTH_KM: 3 },
    line([0.5, 0], [0, 0]),
  ),
  reach(
    23,
    0,
    200,
    { BB_NAME: 'River', UPLAND_SKM: 90 },
    line([0.5, 0], [1, 0]),
  ),
  reach(
    30,
    21,
    300,
    { UPLAND_SKM: 4, RIV_ORD: 8 },
    line([-0.5, -1], [-0.5, 0]),
  ),
];
const byIds = (...ids) =>
  ids.map((id) => NETWORK.find((f) => f.properties.NOID === id));

test('parts join with the flow, and a click is placed along its reach', () => {
  assert.deepEqual(
    joinParts([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [3, 0],
      ],
    ]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ],
  );
  const points = [
    [0, 0],
    [0, 0.01],
    [0, 0.02],
  ];
  const middle = projectOnLine(points, 0.001, 0.01);
  assert.ok(Math.abs(middle.distanceM - 111) < 2, `${middle.distanceM}`);
  assert.ok(Math.abs(middle.remainingM / middle.lengthM - 0.5) < 1e-6);
});

test('the downstream path is walked from the clicked reach and cut into named backbones', () => {
  const down = shapeDownstream(byIds(23, 11, 21, 22, 10), 11);
  assert.equal(down.complete, true);
  assert.equal(down.terminal, 'ocean');
  assert.equal(down.reaches, 3, '21, 22, 23: not the clicked reach or 10');
  assert.equal(down.lengthKm, 5);
  assert.equal(down.segments.length, 1);
  assert.equal(down.segments[0].name, 'River');
  assert.equal(down.segments[0].backboneId, 200);
  assert.deepEqual(down.segments[0].coordinates, [
    [-0.5, 0],
    [0, 0],
    [0.5, 0],
    [1, 0],
  ]);
  assert.deepEqual(down.mouth, [1, 0]);
  // A chain cut short is not complete.
  const cut = shapeDownstream(byIds(11, 21), 11);
  assert.equal(cut.complete, false);
  assert.equal(cut.terminal, 'unknown');
  // An inland end: the last backbone does not reach the ocean.
  const sink = shapeDownstream(
    [
      reach(1, 2, 5, { BB_OCEAN: 0 }, line([0, 0], [1, 0])),
      reach(2, 0, 5, { BB_OCEAN: 0 }, line([1, 0], [2, 0])),
    ],
    1,
  );
  assert.equal(sink.terminal, 'inland');

  const clicked = shapeReach(byIds(11)[0], down.segments[0].coordinates[0]);
  assert.equal(clicked.id, 11);
  assert.equal(clicked.properties.CSI_D, 'URB');
  assert.equal(clicked.properties.BB_NAME, 'Creek');
  assert.equal(clicked.properties.HYFALL, undefined, 'only the listed ones');
  assert.deepEqual(clicked.geometry.coordinates.at(-1), [0, 0]);
  // Halfway down the 2 km reach: 1 km of it, then 5 km to the mouth.
  const at = clickDistances(clicked, down, 0.25, 0.0001);
  assert.ok(
    Math.abs(at.distanceToMouthKm - 6) < 0.05,
    `${at.distanceToMouthKm}`,
  );
  assert.ok(at.distanceM < 20);
  assert.equal(clickDistances(clicked, down).distanceToMouthKm, 7);
});

test('the upstream network is one line per backbone, the clicked reach left out, capped', () => {
  const features = byIds(21, 20, 11, 30, 10);
  const up = shapeUpstream(features, 21, { maxOrder: 8, levels: 4, cap: 10 });
  assert.equal(up.reaches, 4);
  assert.equal(up.truncated, false);
  assert.equal(up.lines.length, 3);
  const creek = up.lines.find((l) => l.backboneId === 100);
  assert.equal(creek.name, 'Creek');
  assert.deepEqual(creek.coordinates, [
    [0, 1],
    [0, 0.5],
    [0, 0.25],
    [0, 0],
  ]);
  assert.equal(up.lines[0].order, 6, 'largest first');
  const capped = shapeUpstream(features, 21, {
    maxOrder: 8,
    levels: 4,
    cap: 2,
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.reaches, 2);
});

// --- the service ---------------------------------------------------------------

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-rivers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** Earth Engine faked on the network: answers each expression by what it asks. */
function fakeEngine({ nearest = 11 } = {}) {
  const calls = [];
  return {
    calls,
    async computeFeatures(expression) {
      const names = invocations(expression);
      const text = JSON.stringify(expression);
      let kind;
      let features;
      if (names.includes('Filter.withinDistance')) {
        kind = 'nearest';
        features = nearest ? byIds(nearest) : [];
      } else if (names.includes('Filter.listContains')) {
        kind = 'upstream';
        features = byIds(10, 11);
      } else if (names.includes('Collection.merge')) {
        kind = 'downstream';
        features = byIds(11, 21, 22, 23);
      } else {
        kind = 'byId';
        const id = Number(/"constantValue":(\d+)/.exec(text)?.[1]);
        features = NETWORK.filter((f) => f.properties.NOID === id);
      }
      calls.push(kind);
      return { features, requests: 1 };
    },
  };
}

test('a click finds the reach, traces it once, and keeps it on disk by reach id', async (t) => {
  const root = await tempRoot(t);
  const engine = fakeEngine();
  const service = createRiverReachService({
    sourceRoot: root,
    backend: engine,
  });
  const first = await service.atPoint({
    lat: 0.25,
    lon: 0.0001,
    heightM: 100_000,
  });
  assert.equal(first.status, 200);
  const body = first.body;
  assert.equal(body.schema, RIVER_REACH_SCHEMA);
  assert.equal(body.source.id, V1_SOURCE.id);
  assert.deepEqual(body.query, {
    lat: 0.25,
    lon: 0.0001,
    heightM: 100_000,
    toleranceM: 1400,
    maxOrder: 7,
  });
  assert.equal(body.reach.id, 11);
  assert.equal(body.reach.properties.BB_NAME, 'Creek');
  assert.ok(Number.isFinite(body.reach.distanceM));
  assert.equal(body.downstream.terminal, 'ocean');
  assert.ok(Math.abs(body.downstream.distanceToMouthKm - 6) < 0.05);
  assert.equal(body.upstream, null, 'upstream only when asked');
  assert.equal(
    body.links.upstream,
    `${RIVER_REACH_ROUTE}/${V1_SOURCE.id}/11/upstream`,
  );
  assert.equal(body.cached, false);
  assert.equal(body.timing.requests, 2);
  assert.deepEqual(engine.calls, ['nearest', 'downstream']);
  const stored = JSON.parse(
    await fs.readFile(
      path.join(root, '.gev-cache', 'rivers', 'reach', '11.json'),
      'utf8',
    ),
  );
  assert.equal(stored.version, CACHE_VERSION);
  assert.equal(stored.reach.id, 11);

  // The same click again: nothing asked of Earth Engine.
  const again = await service.atPoint({
    lat: 0.25,
    lon: 0.0001,
    heightM: 100_000,
  });
  assert.equal(again.body.cached, true);
  assert.equal(again.body.timing.requests, 0);
  assert.equal(engine.calls.length, 2);

  // Another process (a fresh service) finds the reach, then the disk.
  const engine2 = fakeEngine();
  const fresh = createRiverReachService({ sourceRoot: root, backend: engine2 });
  const third = await fresh.atPoint({
    lat: 0.25,
    lon: 0.0002,
    heightM: 100_000,
  });
  assert.equal(third.body.cached, true);
  assert.deepEqual(engine2.calls, ['nearest']);

  // The upstream network, then kept too.
  const up = await fresh.upstream(11);
  assert.equal(up.status, 200);
  assert.equal(up.body.reachId, 11);
  assert.equal(up.body.upstream.reaches, 1, 'reach 10 above 11');
  assert.equal(up.body.upstream.maxOrder, 9);
  assert.deepEqual(engine2.calls, ['nearest', 'upstream']);
  const upAgain = await fresh.byId(11, { upstream: true });
  assert.equal(upAgain.body.cached, true);
  assert.equal(upAgain.body.upstream.reaches, 1);
  assert.deepEqual(engine2.calls, ['nearest', 'upstream']);
});

test('by id: the reach and its path in parallel; a missing reach is a 404', async (t) => {
  const root = await tempRoot(t);
  const engine = fakeEngine();
  const service = createRiverReachService({
    sourceRoot: root,
    backend: engine,
  });
  const found = await service.byId(11);
  assert.equal(found.status, 200);
  assert.equal(found.body.reach.distanceM, undefined, 'no click');
  assert.equal(found.body.downstream.distanceToMouthKm, 7);
  assert.deepEqual([...engine.calls].sort(), ['byId', 'downstream']);
  assert.equal((await service.byId(999)).status, 404);
});

test('no river near the click is a 404; no Earth Engine is a 503; failures are a 502', async (t) => {
  const root = await tempRoot(t);
  const none = createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine({ nearest: 0 }),
  });
  const miss = await none.atPoint({ lat: 5, lon: 5, heightM: 1000 });
  assert.equal(miss.status, 404);
  assert.match(miss.body.error, /100 m/);

  const unconfigured = createRiverReachService({ sourceRoot: root, env: {} });
  assert.equal(
    (await unconfigured.atPoint({ lat: 5, lon: 5, heightM: 1000 })).status,
    503,
  );
  assert.equal((await unconfigured.byId(5)).status, 503);

  const warn = t.mock.method(console, 'warn', () => {});
  const broken = createRiverReachService({
    sourceRoot: root,
    backend: {
      computeFeatures: async () => {
        throw new Error('Earth Engine 400: nope');
      },
    },
  });
  const failed = await broken.atPoint({ lat: 5, lon: 5, heightM: 1000 });
  assert.equal(failed.status, 502);
  assert.equal(warn.mock.callCount(), 1);
});

test('the same lookup asked twice at once is done once; the minute budget refuses more', async (t) => {
  const root = await tempRoot(t);
  const engine = fakeEngine();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = {
    async computeFeatures(expression) {
      await gate;
      return engine.computeFeatures(expression);
    },
  };
  const service = createRiverReachService({ sourceRoot: root, backend: slow });
  const a = service.atPoint({ lat: 0.25, lon: 0.0001, heightM: 100_000 });
  const b = service.atPoint({ lat: 0.25, lon: 0.0001, heightM: 100_000 });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.deepEqual(engine.calls, ['nearest', 'downstream']);

  let clock = 0;
  const limiter = createLimiter({
    perMinute: 2,
    concurrent: 1,
    now: () => clock,
  });
  let running = 0;
  let most = 0;
  const task = async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    return 'done';
  };
  assert.deepEqual(await Promise.all([limiter.run(task), limiter.run(task)]), [
    'done',
    'done',
  ]);
  assert.equal(most, 1, 'one at a time');
  await assert.rejects(limiter.run(task), /Too many river lookups/);
  clock = 60_000;
  assert.equal(await limiter.run(task), 'done', 'a minute later');

  const limited = createRiverReachService({
    sourceRoot: await tempRoot(t),
    backend: fakeEngine(),
    limits: { perMinute: 1, concurrent: 1 },
  });
  const refused = await limited.atPoint({ lat: 3, lon: 3, heightM: 100_000 });
  assert.equal(refused.status, 429);
});

test('the REST backend asks value:compute once with the service account', async () => {
  const sent = [];
  const backend = createRiverRestBackend({
    project: 'my-project-1',
    auth: { token: async () => 'tok', forget: () => {} },
    fetchImpl: async (url, init) => {
      sent.push({ url, init });
      return new Response(
        JSON.stringify({
          result: { type: 'FeatureCollection', features: byIds(11) },
        }),
        { status: 200 },
      );
    },
  });
  const expression = reachByIdExpression(11);
  const answer = await backend.computeFeatures(expression);
  assert.equal(answer.requests, 1);
  assert.equal(answer.features[0].properties.NOID, 11);
  assert.equal(
    sent[0].url,
    'https://earthengine.googleapis.com/v1/projects/my-project-1/value:compute',
  );
  assert.equal(sent[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(sent[0].init.body), { expression });

  const failing = createRiverRestBackend({
    project: 'my-project-1',
    auth: { token: async () => 'tok', forget: () => {} },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { message: 'Filter is too complex' } }),
        {
          status: 400,
        },
      ),
  });
  await assert.rejects(
    failing.computeFeatures(expression),
    /400: Filter is too complex/,
  );
});

function call(handle, url, headers = { host: 'localhost:5173' }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      end(body) {
        resolve({
          status: this.statusCode,
          body: JSON.parse(body),
          headers: this.headers,
        });
      },
    };
    handle({ method: 'GET', url, headers, socket: {} }, res, () =>
      resolve({ status: 'next' }),
    );
  });
}

test('the routes: 400 for bad parameters, the regional source first, ids by source', async (t) => {
  const root = await tempRoot(t);
  const v1 = createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine(),
  });
  const asked = [];
  const v2 = {
    source: { id: 'hydrosheds-v2' },
    covers: (lat, lon) => lon < -30,
    atPoint: async (query) => (
      asked.push(query),
      { status: 200, body: { v2: true } }
    ),
    byId: async (id) => ({ status: 200, body: { v2: id } }),
    upstream: async (id) => ({ status: 200, body: { v2up: id } }),
  };
  const handle = createRiverReachHandler({ sources: [v2, v1] });
  assert.equal((await call(handle, '/?lat=91&lon=0')).status, 400);
  assert.equal((await call(handle, '/?lon=0')).status, 400);
  assert.equal((await call(handle, `/${V1_SOURCE.id}/abc`)).status, 'next');
  assert.equal((await call(handle, `/${V1_SOURCE.id}/0`)).status, 400);
  assert.equal((await call(handle, '/nope/12')).status, 404);
  assert.equal(
    (await call(handle, `/${V1_SOURCE.id}/11?upstream=2`)).status,
    400,
  );

  const americas = await call(handle, '/?lat=-3&lon=-60&heightM=50000');
  assert.deepEqual(americas.body, { v2: true });
  assert.equal(asked[0].maxOrder, 8);
  const danube = await call(handle, '/?lat=0.25&lon=0.0001&heightM=100000');
  assert.equal(danube.status, 200);
  assert.equal(danube.body.reach.id, 11);
  assert.match(danube.headers['cache-control'], /max-age/);
  assert.deepEqual((await call(handle, '/hydrosheds-v2/5/upstream')).body, {
    v2up: 5,
  });
  const byId = await call(handle, `/${V1_SOURCE.id}/11?upstream=1`);
  assert.equal(byId.body.upstream.reaches, 1);

  const crossSite = await call(handle, '/?lat=0&lon=0', {
    host: 'localhost:5173',
    origin: 'https://evil.example',
  });
  assert.equal(crossSite.status, 403);
});

test('a clicked reach carries the name the river names sidecar gives the click', async (t) => {
  const root = await tempRoot(t);
  const asked = [];
  const named = createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine(),
    names: {
      nearest: (point) => {
        asked.push(point);
        return {
          name: 'Río Grande',
          nameEn: 'Rio Grande',
          wikidata: 'Q2',
          confidence: 'direct',
          distanceM: 12,
        };
      },
    },
  });
  const answer = await named.atPoint({
    lat: 0.25,
    lon: 0.0001,
    heightM: 100_000,
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.osmName, {
    name: 'Río Grande',
    nameEn: 'Rio Grande',
    wikidata: 'Q2',
    confidence: 'direct',
    distanceM: 12,
  });
  assert.deepEqual(asked, [{ lat: 0.25, lon: 0.0001 }]);
  // No sidecar, or no name there: the answer is as before.
  const unnamed = createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine(),
    names: { nearest: () => null },
  });
  const plain = await unnamed.atPoint({
    lat: 0.25,
    lon: 0.0001,
    heightM: 100_000,
  });
  assert.equal('osmName' in plain.body, false);
});

test('no sidecar name: the live OpenStreetMap name, asked once and kept with the reach; never for a BB_NAME reach', async (t) => {
  const root = await tempRoot(t);
  const asked = [];
  let answer = { status: 'failed' };
  const liveNames = {
    async name(reach) {
      asked.push(reach.id);
      return answer;
    },
  };
  const make = (names = null) =>
    createRiverReachService({
      sourceRoot: root,
      backend: fakeEngine({ nearest: 30 }),
      names,
      liveNames,
    });
  const click = { lat: -0.5, lon: -0.5, heightM: 100_000 };
  // Overpass down: no name, nothing kept, the card as today.
  const failed = await make().atPoint(click);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.reach.id, 30);
  assert.equal(failed.body.osmName, undefined);
  assert.deepEqual(asked, [30]);
  // Up again: the name, kept.
  answer = {
    status: 'named',
    osmName: {
      name: 'Gwynns Falls',
      coverage: 0.83,
      distanceM: 103,
      confidence: 'live',
    },
  };
  const named = await make().atPoint(click);
  assert.equal(named.body.osmName.name, 'Gwynns Falls');
  assert.equal(named.body.osmName.confidence, 'live');
  assert.deepEqual(asked, [30, 30]);
  const kept = JSON.parse(
    await fs.readFile(
      path.join(root, '.gev-cache', 'rivers', 'reach', '30.osmname.json'),
      'utf8',
    ),
  );
  assert.equal(kept.version, CACHE_VERSION);
  assert.equal(kept.osmName.name, 'Gwynns Falls');
  // A second click (a fresh process too) asks nothing.
  const again = await make().atPoint(click);
  assert.equal(again.body.osmName.name, 'Gwynns Falls');
  assert.deepEqual(asked, [30, 30]);
  // The sidecar's name comes first: no live lookup.
  const sidecar = await make({
    nearest: () => ({ name: 'Dead Run', confidence: 'direct', distanceM: 12 }),
  }).atPoint(click);
  assert.equal(sidecar.body.osmName.name, 'Dead Run');
  assert.deepEqual(asked, [30, 30]);
  // A reach BB_NAME names (the Susquehanna's case) keeps that name.
  const creek = await createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine({ nearest: 11 }),
    liveNames,
  }).atPoint({ lat: 0.25, lon: 0.0001, heightM: 100_000 });
  assert.equal(creek.body.reach.properties.BB_NAME, 'Creek');
  assert.equal(creek.body.osmName, undefined);
  assert.deepEqual(asked, [30, 30]);
});

test('a live lookup that finds no waterway is kept as none: the next click asks nothing either', async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const service = createRiverReachService({
    sourceRoot: root,
    backend: fakeEngine({ nearest: 30 }),
    liveNames: {
      async name() {
        calls += 1;
        return { status: 'none' };
      },
    },
  });
  const click = { lat: -0.5, lon: -0.5, heightM: 100_000 };
  assert.equal((await service.atPoint(click)).body.osmName, undefined);
  assert.equal((await service.byId(30)).body.osmName, undefined);
  assert.equal(calls, 1);
});
