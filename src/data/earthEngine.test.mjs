// Personal fork: the Earth Engine overlay layers' server
// (server/providers/earthEngine.js) with fake Earth Engine answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DAILY_TILES,
  EE_SCOPE,
  MAP_TTL_MS,
  createEarthEngineHandler,
  createEarthEngineService,
  createRestBackend,
  createServiceAccountAuth,
  TRANSPARENT_TILE,
  ZOOM_VARIANT,
  coarseVariant,
  variantForZoom,
  zoomMatched,
  earthEngineSettings,
  featureFilter,
  mapKey,
  mapRequestFor,
  mapRequestHash,
} from '../../server/providers/earthEngine.js';
import {
  AMERICAS_CON_IDS,
  EARTH_ENGINE_LAYERS,
  LAND_COVER_CLASSES,
  LAND_COVER_MAX_HEIGHT_M,
  RIVER_BANDS,
  RIVER_MODES,
  inkColor,
  layerInks,
  layerModes,
  layerVariants,
  modeRecord,
  variantForHeight,
} from './earthEngineLayers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'earth-engine-expressions.json',
);
const byId = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const band = (key) => byId('ee-rivers').variants.find((v) => v.key === key);

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-ee-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('every map request is exactly the committed fixture', async () => {
  const { requests } = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  const built = {};
  for (const layer of EARTH_ENGINE_LAYERS)
    for (const mode of layerModes(layer))
      for (const variant of layerVariants(layer))
        for (const ink of layerInks(layer))
          built[mapKey(layer, variant, ink, mode)] = mapRequestFor(
            layer,
            variant,
            ink,
            mode,
          );
  // A changed layer changes what is sent: regenerate the fixture with it.
  assert.deepEqual(built, requests);
  const slope = requests['ee-terrain-slope/near/default'];
  assert.equal(slope.fileFormat, 'PNG');
  assert.equal(slope.expression.result, '0');
  const root = slope.expression.values['0'].functionInvocationValue;
  assert.equal(root.functionName, 'Terrain.slope');
  assert.deepEqual(slope.visualizationOptions.ranges, [{ min: 0, max: 45 }]);
  assert.match(JSON.stringify(slope), /COPERNICUS\/DEM\/GLO30_2024_1/);
  assert.match(JSON.stringify(slope), /Image\.setDefaultProjection/);
  // Far views: GMTED2010, one pyramided image, its zero sea masked, in its
  // own projection.
  const far = requests['ee-terrain-hillshade/far/default'];
  const farRoot = far.expression.values['0'].functionInvocationValue;
  assert.equal(farRoot.functionName, 'Terrain.hillshade');
  assert.equal(
    farRoot.arguments.input.functionInvocationValue.functionName,
    'Image.selfMask',
  );
  assert.match(JSON.stringify(far), /USGS\/GMTED2010_FULL/);
  assert.doesNotMatch(JSON.stringify(far), /setDefaultProjection/);
  const loss =
    requests['ee-forest-loss/default/default'].expression.values['0'];
  assert.equal(loss.functionInvocationValue.functionName, 'Image.selfMask');
  // Countries: LSIB 2017's outlines, one feature per country, never GAUL
  // 2015's level0, which stores Canada and the United States in chunks
  // whose outlines are straight false borders.
  const level0 = requests['ee-admin-boundaries/level0/light'];
  assert.equal(
    level0.expression.values['0'].functionInvocationValue.functionName,
    'Collection.style',
  );
  assert.match(JSON.stringify(level0), /"USDOS\/LSIB\/2017"/);
  assert.doesNotMatch(JSON.stringify(requests), /GAUL\/2015|LSIB_SIMPLE/);
  assert.doesNotMatch(JSON.stringify(requests), /Image\.paint/);
  // Regions and districts: GAUL 2025, one feature per unit.
  const level2 = requests['ee-admin-boundaries/level2/light'];
  assert.equal(
    level2.expression.values['0'].functionInvocationValue.functionName,
    'Collection.style',
  );
  assert.equal(
    level2.visualizationOptions,
    undefined,
    'styled features are RGB',
  );
  assert.match(JSON.stringify(level2), /FAO\/GAUL\/2025\/level2/);
  // One map per ink: the dark one differs only in its line colour.
  const dark = requests['ee-admin-boundaries/level2/dark'];
  const colorOf = (request) =>
    request.expression.values['0'].functionInvocationValue.arguments.color
      .constantValue;
  assert.equal(colorOf(level2), 'ffffffcc');
  assert.equal(colorOf(dark), '1a1a1acc');
  assert.equal(
    requests['ee-admin-boundaries/level1/light'].expression.values['0']
      .functionInvocationValue.functionName,
    'Collection.style',
  );
  assert.equal(inkColor(byId('ee-admin-boundaries'), 'dark'), '1a1a1acc');
  assert.deepEqual(layerInks(byId('ee-admin-boundaries')), ['light', 'dark']);
  assert.deepEqual(layerInks(byId('ee-forest-loss')), ['default']);
  assert.match(
    byId('ee-admin-boundaries').attribution,
    /FAO GAUL 2025.*LSIB 2017, Office of the Geographer, U\.S\. Department of State/,
  );
});

test('the boundaries change level with the camera’s height', () => {
  const layer = byId('ee-admin-boundaries');
  assert.equal(variantForHeight(layer, 5_000_000).key, 'level1');
  assert.equal(variantForHeight(layer, 800_000).key, 'level1');
  assert.equal(variantForHeight(layer, 799_999).key, 'level2');
  assert.equal(variantForHeight(layer, 2_000).key, 'level2');
  // Countries are never chosen by height: only the COUNTRIES chip draws them.
  assert.ok(layerVariants(layer).some((v) => v.key === 'level0'));
  for (const height of [0, 800_000, 20_000_000])
    assert.notEqual(variantForHeight(layer, height).key, 'level0');
  assert.equal(variantForHeight(byId('ee-forest-loss'), 10).key, 'default');
});

test('terrain draws from GMTED2010 above 3,000 km and Copernicus below', () => {
  for (const id of [
    'ee-terrain-slope',
    'ee-terrain-aspect',
    'ee-terrain-hillshade',
  ]) {
    const layer = byId(id);
    assert.deepEqual(
      layerVariants(layer).map((v) => v.key),
      ['far', 'near'],
    );
    assert.equal(variantForHeight(layer, 20_000_000).key, 'far', id);
    assert.equal(variantForHeight(layer, 3_000_000).key, 'far', id);
    assert.equal(variantForHeight(layer, 2_999_999).key, 'near', id);
    assert.equal(variantForHeight(layer, 500).key, 'near', id);
    assert.match(layer.attribution, /Copernicus DEM GLO-30.*GMTED2010/);
  }
});

test('configured only with a project and a key file that exists; the key is never read here', async (t) => {
  const root = await tempRoot(t);
  assert.equal(earthEngineSettings({}, root).configured, false);
  assert.equal(
    earthEngineSettings(
      {
        EARTH_ENGINE_KEY_FILE: '.gev-secrets/earth-engine.json',
        EARTH_ENGINE_PROJECT: 'true-energy-511503-v7',
      },
      root,
    ).configured,
    false,
    'no file yet',
  );
  await fs.mkdir(path.join(root, '.gev-secrets'));
  await fs.writeFile(
    path.join(root, '.gev-secrets', 'earth-engine.json'),
    '{}',
  );
  const settings = earthEngineSettings(
    {
      EARTH_ENGINE_KEY_FILE: '.gev-secrets/earth-engine.json',
      EARTH_ENGINE_PROJECT: 'true-energy-511503-v7',
      EARTH_ENGINE_DAILY_TILES: '500',
    },
    root,
  );
  assert.equal(settings.configured, true);
  assert.equal(settings.dailyTiles, 500);
  assert.equal(earthEngineSettings({}, root).dailyTiles, DEFAULT_DAILY_TILES);
  assert.equal(
    earthEngineSettings(
      {
        EARTH_ENGINE_KEY_FILE: '.gev-secrets/earth-engine.json',
        EARTH_ENGINE_PROJECT: 'Not A Project!',
      },
      root,
    ).configured,
    false,
  );
});

test('the service account signs its own token request and keeps the token', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const key = JSON.stringify({
    type: 'service_account',
    client_email: 'gods-eye-view-earth-engine@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  let clock = 1_700_000_000_000;
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, body: new URLSearchParams(init.body) });
    return Response.json({
      access_token: `token-${asked.length}`,
      expires_in: 3600,
    });
  };
  const auth = createServiceAccountAuth({
    keyFile: 'unused',
    readKey: () => key,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([auth.token(), auth.token()]);
  assert.equal(a, 'token-1');
  assert.equal(b, 'token-1', 'one request at a time');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(
    asked[0].body.get('grant_type'),
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  );
  const [header, claims, signature] = asked[0].body.get('assertion').split('.');
  const decode = (part) =>
    JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(claims), {
    iss: 'gods-eye-view-earth-engine@example.iam.gserviceaccount.com',
    scope: EE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: clock / 1000,
    exp: clock / 1000 + 3600,
  });
  assert.equal(
    crypto
      .createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url')),
    true,
  );
  assert.equal(await auth.token(), 'token-1', 'kept');
  clock += 3600 * 1000;
  assert.equal(await auth.token(), 'token-2', 'renewed before it expires');
  // A bad key says what is wrong without its contents.
  const broken = createServiceAccountAuth({
    keyFile: 'unused',
    readKey: () => '{"private_key": "SECRET-MATERIAL"}',
    fetchImpl,
  });
  await assert.rejects(broken.token(), (error) => {
    assert.doesNotMatch(error.message, /SECRET-MATERIAL/);
    return /not a service-account key/.test(error.message);
  });
});

test('the REST backend makes maps with the token, retries a 401 once, and returns Earth Engine’s words', async () => {
  const calls = [];
  let tokens = 0;
  const auth = {
    token: async () => `t${++tokens}`,
    forget: () => calls.push('forget'),
  };
  let mapAnswers = [
    new Response('{}', { status: 401 }),
    Response.json({ name: 'projects/true-energy-511503-v7/maps/abc123-def' }),
  ];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      auth: init.headers.Authorization,
      method: init.method || 'GET',
    });
    if (url.includes('/tiles/'))
      return url.endsWith('/9/9/9')
        ? Response.json(
            { error: { message: 'Map not found' } },
            { status: 404 },
          )
        : new Response(Buffer.from('png-bytes'), {
            headers: { 'content-type': 'image/png' },
          });
    return mapAnswers.shift();
  };
  const backend = createRestBackend({
    project: 'true-energy-511503-v7',
    auth,
    fetchImpl,
  });
  const layer = byId('ee-terrain-slope');
  const map = await backend.createMap(layer, layerVariants(layer)[0]);
  assert.equal(map.name, 'projects/true-energy-511503-v7/maps/abc123-def');
  assert.equal(
    calls[0].url,
    'https://earthengine.googleapis.com/v1/projects/true-energy-511503-v7/maps?fields=name',
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Bearer t1');
  assert.equal(calls[1], 'forget');
  assert.equal(calls[2].auth, 'Bearer t2');
  const tile = await backend.fetchTile(map.name, 3, 2, 1);
  assert.equal(tile.status, 200);
  assert.equal(tile.body.toString(), 'png-bytes');
  assert.equal(
    calls.at(-1).url,
    'https://earthengine.googleapis.com/v1/projects/true-energy-511503-v7/maps/abc123-def/tiles/3/2/1',
  );
  const missing = await backend.fetchTile(map.name, 9, 9, 9);
  assert.equal(missing.status, 404);
  assert.equal(missing.error, 'Earth Engine 404: Map not found');
  mapAnswers = [
    Response.json(
      { error: { message: 'Image.setDefaultProjection: Unknown argument' } },
      { status: 400 },
    ),
  ];
  await assert.rejects(
    backend.createMap(layer, layerVariants(layer)[0]),
    /Earth Engine 400: Image\.setDefaultProjection: Unknown argument/,
  );
});

function fakeBackend({ fail = () => false } = {}) {
  const made = [];
  const tiles = [];
  let gone = new Set();
  return {
    made,
    tiles,
    expire: (name) => gone.add(name),
    async createMap(layer, variant, ink) {
      made.push(`${layer.id}/${variant.key}/${ink}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (fail(layer, variant))
        throw new Error('Earth Engine 400: bad expression');
      return {
        name: `projects/p/maps/${layer.id}-${variant.key}-${ink}-${made.length}`,
      };
    },
    async fetchTile(name, z, x, y) {
      tiles.push(`${name}/${z}/${x}/${y}`);
      if (gone.has(name))
        return { status: 404, error: 'Earth Engine 404: gone' };
      return {
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(`${z}/${x}/${y}`),
      };
    },
  };
}

test('maps are made once, kept until they near expiry, and an old one serves when a new one fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const root = await tempRoot(t);
  let clock = 1_000_000;
  let failing = false;
  const backend = fakeBackend({ fail: () => failing });
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    backend,
    now: () => clock,
  });
  const [first] = await Promise.all([service.layers(), service.layers()]);
  assert.equal(
    backend.made.length,
    19,
    'one map per variant and ink (and mode), one request each; Population makes its maps lazily',
  );
  assert.ok(backend.made.includes('ee-admin-boundaries/level0/dark'));
  assert.ok(backend.made.includes('ee-terrain-slope/near/default'));
  assert.ok(backend.made.includes('ee-terrain-slope/far/default'));
  assert.equal(first.configured, true);
  const slope = first.layers.find((layer) => layer.id === 'ee-terrain-slope');
  assert.equal(
    slope.tileUrl,
    '/api/earth-engine/tile/ee-terrain-slope/{variant}/{ink}/{z}/{x}/{y}',
  );
  assert.equal(slope.variants[0].ready, true);
  assert.deepEqual(slope.inks, ['default']);
  assert.match(slope.attribution, /^Google Earth Engine · Copernicus DEM/);
  assert.equal(slope.error, null);
  assert.deepEqual(
    first.layers
      .find((layer) => layer.id === 'ee-admin-boundaries')
      .variants.map((v) => [
        v.key,
        v.auto ?? false,
        v.minHeightM ?? null,
        v.maxHeightM ?? null,
      ]),
    [
      ['level0', false, null, null],
      ['level1', true, 800_000, null],
      ['level2', true, null, 800_000],
    ],
  );
  assert.deepEqual(
    first.layers.find((layer) => layer.id === 'ee-admin-boundaries').inks,
    ['light', 'dark'],
  );
  await service.layers();
  assert.equal(backend.made.length, 19, 'kept');
  clock += MAP_TTL_MS + 1;
  failing = true;
  const stale = await service.layers();
  assert.equal(backend.made.length, 38, 'asked again');
  const staleSlope = stale.layers.find(
    (layer) => layer.id === 'ee-terrain-slope',
  );
  assert.equal(staleSlope.variants[0].ready, true, 'the old map still serves');
  assert.equal(
    staleSlope.error,
    'Earth Engine 400: bad expression',
    'and the error is said',
  );
});

test('the disk cache is keyed by a hash of the map request, so a changed expression never serves old tiles', async (t) => {
  const root = await tempRoot(t);
  const layer = byId('ee-forest-loss');
  const variant = layerVariants(layer)[0];
  const hash = mapRequestHash(layer, variant, 'default');
  assert.match(hash, /^[0-9a-f]{12}$/);
  const changed = { ...layer, vis: { ...layer.vis, max: 26 } };
  assert.notEqual(mapRequestHash(changed, variant, 'default'), hash);
  const boundaries = byId('ee-admin-boundaries');
  const level0 = layerVariants(boundaries)[0];
  assert.notEqual(
    mapRequestHash(boundaries, level0, 'light'),
    mapRequestHash(boundaries, level0, 'dark'),
    'each ink its own',
  );
  // A tile left under the old layout, or under another hash, is not served.
  const tiles = path.join(root, '.gev-cache', 'earth-engine', 'tiles');
  for (const stale of [
    path.join(tiles, 'ee-forest-loss', 'default', 'default', '3', '2'),
    path.join(
      tiles,
      'ee-forest-loss',
      'default',
      'default',
      'f'.repeat(12),
      '3',
      '2',
    ),
  ]) {
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, '1.png'), 'stale');
  }
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    backend,
  });
  const tile = await service.tile(
    'ee-forest-loss',
    'default',
    'default',
    3,
    2,
    1,
  );
  assert.equal(tile.body.toString(), '3/2/1', 'made by Earth Engine');
  assert.equal(backend.tiles.length, 1);
  assert.equal(
    await fs.readFile(
      path.join(
        tiles,
        'ee-forest-loss',
        'default',
        'default',
        hash,
        '3',
        '2',
        '1.png',
      ),
      'utf8',
    ),
    '3/2/1',
    'kept under its hash',
  );
  // The catalog gives the client each ink's hash for the tile URL.
  const catalog = await service.layers();
  const loss = catalog.layers.find((entry) => entry.id === 'ee-forest-loss');
  assert.deepEqual(loss.variants[0].versions, { default: hash });
  const level0Row = catalog.layers
    .find((entry) => entry.id === 'ee-admin-boundaries')
    .variants.find((entry) => entry.key === 'level0');
  assert.deepEqual(Object.keys(level0Row.versions), ['light', 'dark']);
});

test('tiles come from disk first, within the day’s budget, and an expired map is made again once', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const root = await tempRoot(t);
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: { EARTH_ENGINE_DAILY_TILES: '3' },
    backend,
    now: () => clock,
  });
  const one = await service.tile(
    'ee-forest-loss',
    'default',
    'default',
    3,
    2,
    1,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.toString(), '3/2/1');
  const again = await service.tile(
    'ee-forest-loss',
    'default',
    'default',
    3,
    2,
    1,
  );
  assert.equal(again.cached, true);
  assert.equal(backend.tiles.length, 1, 'the disk answered');
  assert.equal(
    (await service.tile('ee-nothing', 'default', 'default', 1, 0, 0)).status,
    404,
  );
  assert.equal(
    (await service.tile('ee-forest-loss', 'level9', 'default', 1, 0, 0)).status,
    404,
  );
  assert.equal(
    (await service.tile('ee-forest-loss', 'default', 'default', 2, 4, 0))
      .status,
    400,
  );
  assert.equal(
    (await service.tile('ee-forest-loss', 'default', 'default', 13, 0, 0))
      .status,
    400,
    'past its max zoom',
  );
  // An expired map: a 404, a new map, the tile again.
  backend.expire(backend.tiles[0].split('/3/')[0]);
  const renewed = await service.tile(
    'ee-forest-loss',
    'default',
    'default',
    4,
    1,
    1,
  );
  assert.equal(renewed.status, 200);
  assert.equal(
    backend.made.filter((m) => m === 'ee-forest-loss/default/default').length,
    2,
  );
  // Three upstream tiles today (one, and the retried one twice): the budget is spent.
  const over = await service.tile(
    'ee-forest-loss',
    'default',
    'default',
    5,
    1,
    1,
  );
  assert.equal(over.status, 429);
  assert.match(over.error, /3 Earth Engine tiles/);
  assert.equal(
    (await service.tile('ee-forest-loss', 'default', 'default', 3, 2, 1))
      .status,
    200,
    'the disk still serves',
  );
  clock += 24 * 60 * 60 * 1000;
  assert.equal(
    (await service.tile('ee-forest-loss', 'default', 'default', 5, 1, 1))
      .status,
    200,
    'a new day',
  );
});

test('without a key the catalog says what to set, and no tile is asked for', async (t) => {
  const root = await tempRoot(t);
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    fetchImpl: () => assert.fail('nothing is fetched'),
  });
  const catalog = await service.layers();
  assert.equal(catalog.configured, false);
  assert.match(
    catalog.message,
    /^Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT/,
  );
  assert.ok(
    catalog.layers.every((layer) => /EARTH_ENGINE_KEY_FILE/.test(layer.error)),
  );
  assert.equal(
    (await service.tile('ee-forest-loss', 'default', 'default', 1, 0, 0))
      .status,
    503,
  );
});

test('the routes are same-site only and GET only', async (t) => {
  const service = {
    layers: async () => ({ configured: false, layers: [] }),
    tile: async (layer, variant, ink, z, x, y) =>
      layer === 'ee-forest-loss'
        ? {
            status: 200,
            contentType: 'image/png',
            body: Buffer.from(`${variant}/${ink}:${z}/${x}/${y}`),
          }
        : { status: 404, error: 'No such layer' },
  };
  const handler = createEarthEngineHandler({ service });
  const call = async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = Buffer.isBuffer(body) ? body.toString() : JSON.parse(body);
      },
    };
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
      },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  assert.equal(
    (await call('/layers', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  assert.equal((await call('/layers', { method: 'POST' })).statusCode, 405);
  assert.deepEqual((await call('/layers')).body, {
    configured: false,
    layers: [],
  });
  const tile = await call('/tile/ee-forest-loss/default/default/3/2/1');
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['content-type'], 'image/png');
  assert.equal(tile.body, 'default/default:3/2/1');
  assert.equal(
    (await call('/tile/ee-forest-loss/level2/dark/3/2/1')).body,
    'level2/dark:3/2/1',
    'the ink is a path segment',
  );
  assert.equal(
    (await call('/tile/ee-other/default/default/3/2/1')).statusCode,
    404,
  );
  assert.equal(
    (await call('/tile/ee-forest-loss/default/3/2/1')).nexted,
    true,
    'the old shape without an ink is not a tile route',
  );
  assert.equal((await call('/tile/../../etc/3/2/1')).nexted, true);
  assert.equal(
    (await call('/tile/ee-forest-loss/default/default/x/2/1')).nexted,
    true,
  );
});

test('tiles are counted per layer for the day, and the budget warns once at 50% and 90%', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const root = await tempRoot(t);
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: { EARTH_ENGINE_DAILY_TILES: '10' },
    backend,
    now: () => clock,
  });
  for (let x = 0; x < 4; x++)
    await service.tile('ee-terrain-slope', 'near', 'default', 4, x, 1);
  // A disk hit is not counted.
  await service.tile('ee-terrain-slope', 'near', 'default', 4, 0, 1);
  await service.tile('ee-forest-loss', 'default', 'default', 4, 0, 1);
  const budgetWarnings = () => warnings.filter((w) => /tile budget/.test(w));
  assert.deepEqual(budgetWarnings(), [
    "[EarthEngine] 50% of today's tile budget used (5 of 10; ee-terrain-slope 4, ee-forest-loss 1)",
  ]);
  for (let x = 1; x < 5; x++)
    await service.tile('ee-forest-loss', 'default', 'default', 4, x, 1);
  assert.equal(budgetWarnings().length, 2);
  assert.match(
    budgetWarnings()[1],
    /^\[EarthEngine\] 90% of today's tile budget used \(9 of 10; ee-forest-loss 5, ee-terrain-slope 4\)$/,
  );
  await service.tile('ee-forest-loss', 'default', 'default', 4, 5, 1);
  assert.equal(budgetWarnings().length, 2, 'once each a day');
  const catalog = await service.layers();
  const today = Object.fromEntries(
    catalog.layers.map((layer) => [layer.id, layer.tilesToday]),
  );
  assert.deepEqual(today, {
    'ee-terrain-slope': 4,
    'ee-terrain-aspect': 0,
    'ee-terrain-hillshade': 0,
    'ee-forest-loss': 6,
    'ee-admin-boundaries': 0,
    'ee-forest-types': 0,
    'ee-population': 0,
    'ee-rivers': 0,
    'ee-surface-water': 0,
    'ee-land-cover': 0,
  });
  assert.deepEqual(catalog.tiles, { used: 10, budget: 10 });
  // A new day starts from nothing, with its own warnings.
  clock += 24 * 60 * 60 * 1000;
  assert.equal(
    (await service.layers()).layers.find((l) => l.id === 'ee-forest-loss')
      .tilesToday,
    0,
  );
});

test('Rivers: one map per (band, ink, mode), made when a tile asks, cached per mode; nothing below a band’s first level', async (t) => {
  const root = await tempRoot(t);
  const rivers = byId('ee-rivers');
  const made = [];
  const fetched = [];
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: [rivers],
    backend: {
      async createMap(layer, variant, ink, mode) {
        made.push(mapKey(layer, variant, ink, mode));
        return { name: `projects/p/maps/m${made.length}` };
      },
      async fetchTile(name, z, x, y) {
        fetched.push(`${name}/${z}/${x}/${y}`);
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(`${z}/${x}/${y}`),
        };
      },
    },
  });
  // The catalog makes no map for a lazy layer, and gives every hash.
  const catalog = await service.layers();
  assert.deepEqual(made, []);
  const row = catalog.layers[0];
  assert.deepEqual(row.modes, layerModes(rivers));
  // The bands, then the zoom variant, which draws each tile with the band
  // of its zoom; its version hashes every band's.
  assert.equal(row.variants.length, RIVER_BANDS.length + 1);
  const zoom = row.variants.at(-1);
  assert.equal(zoom.key, ZOOM_VARIANT);
  assert.equal(zoom.minZoom, 0);
  assert.match(zoom.modeVersions['network-rest'].dark, /^[0-9a-f]{12}$/);
  assert.notEqual(
    zoom.modeVersions.network.dark,
    row.variants[0].modeVersions.network.dark,
  );
  for (const variant of row.variants.slice(0, -1)) {
    assert.equal(variant.ready, false);
    assert.equal(variant.versions, undefined);
    for (const mode of layerModes(rivers))
      for (const ink of layerInks(rivers))
        assert.equal(
          variant.modeVersions[mode][ink],
          mapRequestHash(
            rivers,
            rivers.variants.find((v) => v.key === variant.key),
            ink,
            mode,
          ),
        );
  }
  // Below a band's first level, bands without zooms: a transparent tile,
  // no Earth Engine, not counted.
  const plain = {
    ...rivers,
    variants: rivers.variants.map(({ zooms, ...variant }) => variant),
  };
  const plainService = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: [plain],
    backend: {
      async createMap() {
        throw new Error('no map wanted');
      },
    },
  });
  const blank = await plainService.tile(
    'ee-rivers',
    'o4',
    'light',
    2,
    1,
    1,
    'pressure',
  );
  assert.equal(blank.status, 200);
  assert.equal(blank.blank, true);
  assert.equal(blank.body, TRANSPARENT_TILE);
  assert.equal(
    (await plainService.layers()).layers[0].variants.some(
      (variant) => variant.key === ZOOM_VARIANT,
    ),
    false,
  );
  assert.deepEqual(made, []);
  assert.deepEqual(fetched, []);
  assert.equal((await service.layers()).layers[0].tilesToday, 0);
  // From it: the mode's map, made once, its tiles kept under the mode.
  const tile = await service.tile(
    'ee-rivers',
    'o4',
    'light',
    3,
    4,
    2,
    'pressure',
  );
  assert.equal(tile.status, 200);
  assert.deepEqual(made, ['ee-rivers/pressure/o4/light']);
  const hash = mapRequestHash(rivers, RIVER_BANDS[1], 'light', 'pressure');
  const kept = await fs.stat(
    path.join(
      root,
      '.gev-cache',
      'earth-engine',
      'tiles',
      'ee-rivers',
      'pressure',
      'o4',
      'light',
      hash,
      '3',
      '4',
      '2.png',
    ),
  );
  assert.ok(kept.isFile());
  assert.equal(
    (await service.tile('ee-rivers', 'o4', 'light', 3, 4, 2, 'pressure'))
      .cached,
    true,
  );
  await service.tile('ee-rivers', 'o4', 'light', 3, 4, 2, 'network');
  assert.deepEqual(made, [
    'ee-rivers/pressure/o4/light',
    'ee-rivers/network/o4/light',
  ]);
  const after = (await service.layers()).layers[0];
  assert.equal(after.tilesToday, 2);
  assert.equal(after.variants[0].ready, false, 'not every mode and ink yet');
  // A mode the layer does not have, or none: no tile.
  assert.equal(
    (await service.tile('ee-rivers', 'o4', 'light', 3, 4, 2, 'bogus')).status,
    404,
  );
  assert.equal(
    (await service.tile('ee-rivers', 'o4', 'light', 3, 4, 2)).status,
    404,
  );
  assert.equal(
    (await service.tile('ee-rivers', 'o4', 'light', 12, 0, 0, 'network'))
      .status,
    400,
    'past maxZoom 11',
  );
});

test('Rivers: the zoom variant draws each tile with the band of its zoom, and a band’s coarser tiles are the coarser band’s (what a 3D tileset asks for)', async (t) => {
  const root = await tempRoot(t);
  const rivers = byId('ee-rivers');
  const made = [];
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: [rivers],
    backend: {
      async createMap(layer, variant, ink, mode) {
        made.push(mapKey(layer, variant, ink, mode));
        return { name: `projects/p/maps/${variant.key}` };
      },
      async fetchTile(name, z, x, y) {
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(`${name}/${z}/${x}/${y}`),
        };
      },
    },
  });
  assert.equal(zoomMatched(rivers), true);
  assert.equal(zoomMatched(byId('ee-admin-boundaries')), false);
  // z → band: the bands' zooms, the first below them, the last above.
  const bandAt = (z) => variantForZoom(rivers, z).key;
  assert.deepEqual([0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 14].map(bandAt), [
    'o3',
    'o3',
    'o3',
    'o4',
    'o4',
    'o5',
    'o6',
    'o7',
    'o7',
    'all',
    'all',
  ]);
  for (const [z, band] of [
    [1, 'o3'],
    [5, 'o4'],
    [8, 'o6'],
    [11, 'all'],
  ]) {
    const tile = await service.tile(
      'ee-rivers',
      ZOOM_VARIANT,
      'dark',
      z,
      0,
      0,
      'network',
    );
    assert.equal(tile.status, 200);
    assert.equal(String(tile.body), `projects/p/maps/${band}/${z}/0/0`);
  }
  assert.deepEqual(made, [
    'ee-rivers/network/o3/dark',
    'ee-rivers/network/o4/dark',
    'ee-rivers/network/o6/dark',
    'ee-rivers/network/all/dark',
  ]);
  // A band's tile below its first level: the band of that zoom draws it,
  // under its own cache path.
  const coarse = await service.tile(
    'ee-rivers',
    'o6',
    'dark',
    2,
    1,
    1,
    'network',
  );
  assert.equal(String(coarse.body), 'projects/p/maps/o3/2/1/1');
  assert.equal(coarseVariant(rivers, band('o6'), 2).key, 'o3');
  assert.equal(coarseVariant(rivers, band('o3'), 0).key, 'o3', 'the floor');
  assert.equal(
    coarseVariant(
      byId('ee-admin-boundaries'),
      byId('ee-admin-boundaries').variants[1],
      0,
    ),
    null,
  );
  // At or past a band's first level a band draws itself.
  assert.equal(
    String(
      (await service.tile('ee-rivers', 'o6', 'dark', 5, 1, 1, 'network')).body,
    ),
    'projects/p/maps/o6/5/1/1',
  );
});

test('the transparent tile is a 256 × 256 RGBA PNG of zeros', async () => {
  const { inflateSync } = await import('node:zlib');
  assert.deepEqual(
    [...TRANSPARENT_TILE.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(TRANSPARENT_TILE.toString('latin1', 12, 16), 'IHDR');
  assert.equal(TRANSPARENT_TILE.readUInt32BE(16), 256);
  assert.equal(TRANSPARENT_TILE.readUInt32BE(20), 256);
  assert.equal(TRANSPARENT_TILE[25], 6, 'RGBA');
  const idatLength = TRANSPARENT_TILE.readUInt32BE(33);
  assert.equal(TRANSPARENT_TILE.toString('latin1', 37, 41), 'IDAT');
  const rows = inflateSync(TRANSPARENT_TILE.subarray(41, 41 + idatLength));
  assert.equal(rows.length, 256 * (1 + 256 * 4));
  assert.ok(rows.every((byte) => byte === 0));
  assert.ok(TRANSPARENT_TILE.length < 2_000);
});

test('the mode is a path segment after the layer; the plain route stays as it was', async () => {
  const seen = [];
  const handler = createEarthEngineHandler({
    service: {
      layers: async () => ({}),
      tile: async (...args) => {
        seen.push(args);
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from('x'),
        };
      },
    },
  });
  const call = async (url) => {
    const res = { statusCode: 200, setHeader() {}, end() {} };
    await handler(
      { url, method: 'GET', headers: { host: 'localhost' }, socket: {} },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  await call('/tile/ee-rivers/free-flowing/o5/dark/4/8/5?v=0123456789ab');
  assert.deepEqual(seen.at(-1), [
    'ee-rivers',
    'o5',
    'dark',
    4,
    8,
    5,
    'free-flowing',
  ]);
  await call('/tile/ee-forest-loss/default/default/3/2/1');
  assert.deepEqual(seen.at(-1), [
    'ee-forest-loss',
    'default',
    'default',
    3,
    2,
    1,
  ]);
  assert.equal(
    (await call('/tile/ee-rivers/Bad_Mode/o5/dark/4/8/5')).nexted,
    true,
  );
});

test('the Rivers record: AUTO by height, the Americas switch off, both citations', () => {
  const rivers = byId('ee-rivers');
  assert.equal(variantForHeight(rivers, 20_000_000).key, 'o3');
  assert.equal(variantForHeight(rivers, 50_000).key, 'all');
  assert.equal(rivers.omitAmericas, false);
  assert.deepEqual([...AMERICAS_CON_IDS], [1, 2]);
  assert.equal(featureFilter(rivers, rivers.variants.at(-1)), null);
  assert.equal(modeRecord(rivers, 'nope').key, 'network');
  assert.deepEqual(
    RIVER_MODES.map((mode) => mode.key),
    ['network', 'network-rest', 'free-flowing', 'pressure'],
  );
  assert.match(rivers.attribution, /HydroSHEDS\/WWF/);
  assert.match(rivers.attribution, /Lehner.*2008/);
  assert.match(rivers.attribution, /Grill et al\. 2019, Nature 569:215/);
  assert.match(rivers.attribution, /Natural Earth/);
});

// Personal fork: Surface water and Land cover, image layers with modes.
const fnOf = (node) => node.functionInvocationValue;

test('Surface water: each mode is its JRC band, masked by max_extent, zero transparent, in its own colours', () => {
  const water = byId('ee-surface-water');
  assert.deepEqual(layerModes(water), ['occurrence', 'change', 'seasonality']);
  assert.equal(water.modeStorageKey, 'gev.surfaceWater.mode');
  assert.equal(water.maxHeightM, undefined, 'it draws from orbit');
  assert.match(water.attribution, /^Source: EC JRC\/Google/);
  const bandOf = (node) => fnOf(node).arguments.bandSelectors.constantValue[0];
  const expect = {
    occurrence: { band: 'occurrence', top: 'Image.selfMask', min: 1, max: 100 },
    change: { band: 'change_abs', top: 'Image.updateMask', min: -50, max: 50 },
    seasonality: {
      band: 'seasonality',
      top: 'Image.selfMask',
      min: 1,
      max: 12,
    },
  };
  for (const [mode, want] of Object.entries(expect)) {
    const request = mapRequestFor(
      water,
      layerVariants(water)[0],
      'default',
      mode,
    );
    const top = fnOf(request.expression.values['0']);
    assert.equal(top.functionName, want.top, mode);
    // Under the zero mask: the band, masked by max_extent of the same image.
    const masked = fnOf(top.arguments.image);
    assert.equal(masked.functionName, 'Image.updateMask', mode);
    assert.equal(bandOf(masked.arguments.image), want.band, mode);
    assert.equal(bandOf(masked.arguments.mask), 'max_extent', mode);
    assert.match(JSON.stringify(request), /JRC\/GSW1_4\/GlobalSurfaceWater/);
    assert.deepEqual(request.visualizationOptions.ranges, [
      { min: want.min, max: want.max },
    ]);
    assert.deepEqual(request.visualizationOptions.paletteColors, [
      ...modeRecord(water, mode).vis.palette,
    ]);
  }
  // CHANGE is signed: zero (no change) is masked by comparing with 0.
  const change = fnOf(
    mapRequestFor(water, layerVariants(water)[0], 'default', 'change')
      .expression.values['0'],
  );
  assert.equal(fnOf(change.arguments.mask).functionName, 'Image.neq');
  // One map per mode, each its own key and hash.
  const keys = layerModes(water).map((mode) =>
    mapKey(water, layerVariants(water)[0], 'default', mode),
  );
  assert.deepEqual(keys, [
    'ee-surface-water/occurrence/default/default',
    'ee-surface-water/change/default/default',
    'ee-surface-water/seasonality/default/default',
  ]);
  assert.equal(
    new Set(
      layerModes(water).map((mode) =>
        mapRequestHash(water, layerVariants(water)[0], 'default', mode),
      ),
    ).size,
    3,
  );
  // A single variant: the height never changes what is drawn.
  for (const height of [1_000, 3_000_000, 20_000_000])
    assert.equal(variantForHeight(water, height).key, 'default');
});

test('Land cover: WorldCover classes remapped to the dataset palette, two years, and a ceiling', () => {
  const cover = byId('ee-land-cover');
  assert.deepEqual(layerModes(cover), ['v200', 'v100']);
  assert.equal(cover.modeStorageKey, 'gev.landCover.mode');
  assert.equal(cover.maxHeightM, LAND_COVER_MAX_HEIGHT_M);
  assert.equal(LAND_COVER_MAX_HEIGHT_M, 10_000_000);
  assert.match(
    cover.attribution,
    /^© ESA WorldCover project 2021 \/ Contains modified Copernicus Sentinel data \(2021\) processed by ESA WorldCover consortium/,
  );
  assert.match(cover.attribution, /CC BY 4\.0/);
  // The STAC record's gee:classes, in order.
  assert.deepEqual(
    LAND_COVER_CLASSES.map((entry) => [entry.value, entry.color]),
    [
      [10, '006400'],
      [20, 'ffbb22'],
      [30, 'ffff4c'],
      [40, 'f096ff'],
      [50, 'fa0000'],
      [60, 'b4b4b4'],
      [70, 'f0f0f0'],
      [80, '0064c8'],
      [90, '0096a0'],
      [95, '00cf75'],
      [100, 'fae6a0'],
    ],
  );
  for (const [mode, image] of [
    ['v200', 'ESA/WorldCover/v200/2021'],
    ['v100', 'ESA/WorldCover/v100/2020'],
  ]) {
    const request = mapRequestFor(
      cover,
      layerVariants(cover)[0],
      'default',
      mode,
    );
    const remap = fnOf(request.expression.values['0']);
    assert.equal(remap.functionName, 'Image.remap');
    assert.deepEqual(
      remap.arguments.from.constantValue,
      LAND_COVER_CLASSES.map((entry) => entry.value),
    );
    assert.deepEqual(
      remap.arguments.to.constantValue,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    const select = fnOf(remap.arguments.image);
    assert.deepEqual(select.arguments.bandSelectors.constantValue, ['Map']);
    assert.equal(
      fnOf(select.arguments.input).arguments.id.constantValue,
      image,
    );
    assert.deepEqual(request.visualizationOptions, {
      ranges: [{ min: 0, max: 10 }],
      paletteColors: LAND_COVER_CLASSES.map((entry) => entry.color),
    });
  }
  assert.equal(cover.legend.length, 11);
  assert.equal(cover.legend[4].label, 'Built-up');
  assert.equal(cover.legend[4].color, '#fa0000');
});

test('the tile route takes a mode with digits (Land cover’s v200, Population’s density-1990)', async () => {
  const asked = [];
  const handle = createEarthEngineHandler({
    service: {
      async layers() {
        return { configured: true, layers: [] };
      },
      async tile(...args) {
        asked.push(args);
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from('t'),
        };
      },
    },
  });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headers: {},
        statusCode: 0,
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(body) {
          resolve({ status: this.statusCode, body: String(body) });
        },
      };
      handle(
        { method: 'GET', url, headers: { host: 'localhost:4176' }, socket: {} },
        res,
        () => resolve({ nexted: true }),
      );
    });
  assert.equal(
    (await call('/tile/ee-land-cover/v200/default/default/3/4/2')).status,
    200,
  );
  assert.equal(
    (await call('/tile/ee-surface-water/change/default/default/9/291/144'))
      .status,
    200,
  );
  assert.equal(
    (await call('/tile/ee-population/density-1990/default/default/3/2/1'))
      .status,
    200,
  );
  assert.deepEqual(asked, [
    ['ee-land-cover', 'default', 'default', 3, 4, 2, 'v200'],
    ['ee-surface-water', 'default', 'default', 9, 291, 144, 'change'],
    ['ee-population', 'default', 'default', 3, 2, 1, 'density-1990'],
  ]);
  assert.equal(
    (await call('/tile/ee-land-cover/2021/default/default/3/4/2')).nexted,
    true,
    'a mode starts with a letter',
  );
});
