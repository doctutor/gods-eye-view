// Personal fork: Earth Engine overlay layers (src/layers/earthEngine/),
// through Earth Engine's REST API with a service account. Not part of
// upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import {
  EARTH_ENGINE_ATTRIBUTION,
  EARTH_ENGINE_LAYERS,
  inkColor,
  layerInks,
  layerVariants,
} from '../../src/data/earthEngineLayers.js';

/**
 * The Cloud project is registered for noncommercial Earth Engine use, and
 * the server holds its service account (EARTH_ENGINE_KEY_FILE, a JSON key
 * kept out of the repository, and EARTH_ENGINE_PROJECT). The browser never
 * sees a token: it asks this server for tiles.
 *
 *   GET /api/earth-engine/layers
 *       the overlay layers (src/data/earthEngineLayers.js) with their tile
 *       URL template, legend, attribution, map expiry and any error
 *   GET /api/earth-engine/tile/<layer>/<variant>/<ink>/<z>/<x>/<y>
 *       one tile, kept on disk, within EARTH_ENGINE_DAILY_TILES a day
 *       (counted per layer for the day; a warning is logged at 50% and
 *       90% of the budget); the ink is 'light' or 'dark' for a features
 *       layer with inks, 'default' otherwise
 *
 * Each (layer, variant, ink) has its own map, made by POST
 * /v1/projects/<project>/maps with the layer's expression (the computation
 * graph Earth Engine's own clients send; a features layer is drawn in the
 * ink's colour, as the edges of its unit code when the variant names one),
 * cached until it nears its expiry, made again on demand, one request at a
 * time per map; when a new one cannot be made the old one
 * keeps serving and the error is reported. The JSON sent for each map is
 * a committed fixture (src/data/fixtures/earth-engine-expressions.json), so
 * an Earth Engine rejection can be read against exactly what was sent.
 *
 * The service account's key is read only to sign the token request; it is
 * never logged or returned.
 */

export const EARTH_ENGINE_ROUTE = '/api/earth-engine';
export const EE_API = 'https://earthengine.googleapis.com/v1';
export const EE_SCOPE = 'https://www.googleapis.com/auth/earthengine';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Map ids last a few hours; a new one is made after this long. */
export const MAP_TTL_MS = 2 * 60 * 60 * 1000;
/** Tiles are kept on disk this long: the datasets are static. */
export const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_TILES = 20_000;
/** A warning is logged once a day as the tiles reach each of these shares. */
export const BUDGET_WARNINGS = Object.freeze([50, 90]);
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const TILE_TIMEOUT_MS = 30_000;
// A coarse tile can take Earth Engine minutes (z 0 to 3 of the countries'
// edges: 15 s to over 200 s, 2026-10-18), but there are only 85 of them per
// map and the disk keeps each 30 days, so they are waited for longer.
const COARSE_TILE_MAX_Z = 3;
const COARSE_TILE_TIMEOUT_MS = 240_000;
const CACHE_DIR = path.join('.gev-cache', 'earth-engine');
const NEEDS_KEY =
  'Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to draw the Earth Engine layers';

// --- the expression a layer's map is made from -------------------------------

const constant = (value) => ({ constantValue: value });
const invoke = (functionName, args) => ({
  functionInvocationValue: { functionName, arguments: args },
});

/** The Earth Engine object an asset record names. */
function assetNode(asset) {
  if (asset?.table)
    return invoke('Collection.loadTable', { tableId: constant(asset.table) });
  const image = asset?.collection
    ? invoke('ImageCollection.mosaic', {
        collection: invoke('ImageCollection.load', {
          id: constant(asset.collection),
        }),
      })
    : invoke('Image.load', { id: constant(asset?.image) });
  const band = asset?.band
    ? invoke('Image.select', {
        input: image,
        bandSelectors: constant([asset.band]),
      })
    : image;
  return asset?.seaIsZero ? invoke('Image.selfMask', { image: band }) : band;
}

/**
 * A layer variant's expression in an ink, as the REST API takes it:
 * {values: {0: <value node>}, result: '0'}.
 */
export function expressionFor(
  layer,
  variant = layerVariants(layer)[0],
  ink = layerInks(layer)[0],
) {
  let node = assetNode(variant.asset);
  if (layer.kind === 'features' && variant.code) {
    // Edges where the unit code changes, not feature outlines: the table is
    // painted into an image of its code over a zero (sea) background, and a
    // pixel whose 3 × 3 neighbourhood holds a smaller code is an edge, one
    // pixel wide on the higher-code side. A seam between two chunks of one
    // unit has the same code both sides and vanishes; a shared border is
    // drawn once; the coast counts, since sea is 0. The ink is applied by
    // the map's visualization (mapRequestFor), not baked in here.
    const painted = invoke('Image.paint', {
      image: invoke('Image.constant', { value: constant(0) }),
      featureCollection: node,
      color: constant(variant.code),
    });
    node = invoke('Image.selfMask', {
      image: invoke('Image.neq', {
        image1: painted,
        image2: invoke('Image.focalMin', {
          image: painted,
          radius: constant(1),
          kernelType: constant('square'),
          units: constant('pixels'),
        }),
      }),
    });
  } else if (layer.kind === 'features') {
    // A table without a code property: its feature outlines.
    const style = layer.style || {};
    node = invoke('Collection.style', {
      collection: node,
      color: constant(inkColor(layer, ink)),
      fillColor: constant(style.fillColor || '00000000'),
      width: constant(style.width ?? 1),
    });
  } else {
    if (layer.terrain) {
      // A mosaic has no native projection; terrain needs one in metres.
      if (variant.asset?.collection)
        node = invoke('Image.setDefaultProjection', {
          image: node,
          crs: invoke('Projection', { crs: constant('EPSG:3857') }),
          scale: constant(30),
        });
      node =
        layer.terrain === 'hillshade'
          ? invoke('Terrain.hillshade', {
              input: node,
              azimuth: constant(315),
              elevation: constant(45),
            })
          : invoke(
              layer.terrain === 'aspect' ? 'Terrain.aspect' : 'Terrain.slope',
              { input: node },
            );
    }
    if (layer.selfMask) node = invoke('Image.selfMask', { image: node });
  }
  return { values: { 0: node }, result: '0' };
}

/** The body of the request that makes a layer variant's map in an ink. */
export function mapRequestFor(layer, variant, ink = layerInks(layer)[0]) {
  const body = {
    expression: expressionFor(layer, variant, ink),
    fileFormat: 'PNG',
  };
  if (layer.kind !== 'features' && layer.vis)
    body.visualizationOptions = {
      ranges: [{ min: layer.vis.min, max: layer.vis.max }],
      paletteColors: [...(layer.vis.palette || [])],
    };
  if (layer.kind === 'features' && variant.code) {
    // The edge image is 1 where there is an edge (masked elsewhere): the
    // ink's RRGGBB is the one palette colour, its AA the opacity.
    const color = inkColor(layer, ink);
    body.visualizationOptions = {
      ranges: [{ min: 0, max: 1 }],
      paletteColors: [color.slice(0, 6)],
      ...(color.length === 8
        ? {
            opacity:
              Math.round((parseInt(color.slice(6), 16) / 255) * 100) / 100,
          }
        : {}),
    };
  }
  return body;
}

// --- service-account auth ---------------------------------------------------

const base64url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

/** The settings, and whether the key file is there (never its contents). */
export function earthEngineSettings(
  env = process.env,
  sourceRoot = defaultSourceRoot,
) {
  const keyFile = String(env.EARTH_ENGINE_KEY_FILE || '').trim();
  const project = String(env.EARTH_ENGINE_PROJECT || '').trim();
  const resolved = keyFile ? path.resolve(sourceRoot, keyFile) : '';
  const budget = Number(env.EARTH_ENGINE_DAILY_TILES);
  return {
    keyFile: resolved,
    project,
    configured: Boolean(
      resolved &&
      /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) &&
      fs.existsSync(resolved),
    ),
    dailyTiles:
      Number.isInteger(budget) && budget >= 0 ? budget : DEFAULT_DAILY_TILES,
  };
}

/**
 * An OAuth access token for the service account, from a JWT it signs
 * itself (RS256, node:crypto); kept until a minute before it expires.
 * @param {{keyFile: string, fetchImpl?: typeof fetch, now?: () => number,
 *   scope?: string, readKey?: (file: string) => string}} options
 */
export function createServiceAccountAuth({
  keyFile,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  scope = EE_SCOPE,
  readKey = (file) => fs.readFileSync(file, 'utf8'),
}) {
  let held = null;
  let inflight = null;

  async function fresh() {
    let key;
    try {
      key = JSON.parse(readKey(keyFile));
    } catch {
      throw new Error('The Earth Engine key file is not readable JSON');
    }
    if (!key?.client_email || !key?.private_key)
      throw new Error('The Earth Engine key file is not a service-account key');
    const issued = Math.floor(now() / 1000);
    const audience = key.token_uri || TOKEN_URL;
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
      JSON.stringify({
        iss: key.client_email,
        scope,
        aud: audience,
        iat: issued,
        exp: issued + 3600,
      }),
    )}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(unsigned)
      .sign(key.private_key);
    const response = await fetchImpl(audience, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64url(signature)}`,
      }).toString(),
      signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.access_token)
      throw new Error(
        `Earth Engine sign-in failed (${response.status}${body?.error ? `: ${String(body.error_description || body.error).slice(0, 160)}` : ''})`,
      );
    held = {
      token: body.access_token,
      expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000,
    };
    return held.token;
  }

  return {
    async token() {
      if (held && now() < held.expiresAt) return held.token;
      inflight ||= fresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    forget() {
      held = null;
    },
  };
}

/** Earth Engine's own error text from a failed answer. */
async function errorText(response) {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message || body?.error_description || '';
  return `Earth Engine ${response.status}${message ? `: ${String(message).slice(0, 300)}` : ''}`;
}

/**
 * The REST backend: makes maps and fetches their tiles with the account's
 * token. Any other backend (Earth Engine's npm client) can take its place.
 * @param {{project: string, auth: {token: Function, forget: Function},
 *   fetchImpl?: typeof fetch}} options
 */
export function createRestBackend({
  project,
  auth,
  fetchImpl = (...args) => fetch(...args),
}) {
  async function authorized(url, init = {}, timeoutMs = TILE_TIMEOUT_MS) {
    const send = async () =>
      fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${await auth.token()}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    let response = await send();
    if (response.status === 401) {
      auth.forget();
      response = await send();
    }
    return response;
  }
  return {
    /** @returns {Promise<{name: string}>} */
    async createMap(layer, variant, ink = layerInks(layer)[0]) {
      const response = await authorized(
        `${EE_API}/projects/${encodeURIComponent(project)}/maps?fields=name`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mapRequestFor(layer, variant, ink)),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      const body = await response.json();
      if (!/^projects\/[^/]+\/maps\/[\w-]+$/.test(String(body?.name || '')))
        throw new Error('Earth Engine answered without a map name');
      return { name: body.name };
    },
    /** @returns {Promise<{status: number, contentType: string, body: Buffer|null, error?: string}>} */
    async fetchTile(name, z, x, y) {
      const response = await authorized(
        `${EE_API}/${name}/tiles/${z}/${x}/${y}`,
        {},
        z <= COARSE_TILE_MAX_Z ? COARSE_TILE_TIMEOUT_MS : TILE_TIMEOUT_MS,
      );
      if (!response.ok)
        return {
          status: response.status,
          contentType: '',
          body: null,
          error: await errorText(response),
        };
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_TILE_BYTES)
        return {
          status: 502,
          contentType: '',
          body: null,
          error: 'Tile too large',
        };
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_TILE_BYTES)
        return {
          status: 502,
          contentType: '',
          body: null,
          error: 'Tile too large',
        };
      return {
        status: 200,
        contentType: response.headers.get('content-type') || 'image/png',
        body,
      };
    },
  };
}

// --- the service ---------------------------------------------------------------

const TILE_PATH =
  /^\/tile\/(ee-[a-z0-9-]{1,40})\/([a-z0-9-]{1,20})\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/;

/**
 * @param {{sourceRoot?: string, env?: object, layers?: Array<object>,
 *   backend?: object|null, fetchImpl?: typeof fetch, now?: () => number}} [options]
 *   `backend` replaces the REST one (tests; another client).
 */
export function createEarthEngineService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  layers = EARTH_ENGINE_LAYERS,
  backend = null,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const dir = path.join(sourceRoot, CACHE_DIR);
  const usageFile = path.join(dir, 'usage.json');
  /** "<layer>/<variant>/<ink>" → {name, madeAt, expiresAt, error, inflight}. */
  const maps = new Map();
  let made = null;

  function settings() {
    return earthEngineSettings(env, sourceRoot);
  }
  function backendNow() {
    if (backend) return backend;
    const current = settings();
    if (!current.configured) return null;
    const key = `${current.keyFile}\n${current.project}`;
    if (made?.key !== key)
      made = {
        key,
        backend: createRestBackend({
          project: current.project,
          fetchImpl,
          auth: createServiceAccountAuth({
            keyFile: current.keyFile,
            fetchImpl,
            now,
          }),
        }),
      };
    return made.backend;
  }

  /** A (variant, ink)'s map, made again once old; the old one serves if that fails. */
  async function mapFor(layer, variant, ink, { force = false } = {}) {
    const key = `${layer.id}/${variant.key}/${ink}`;
    const held = maps.get(key) || {};
    maps.set(key, held);
    if (!force && held.name && now() < held.expiresAt) return held;
    held.inflight ||= (async () => {
      try {
        const engine = backendNow();
        if (!engine) throw new Error(NEEDS_KEY);
        const { name } = await engine.createMap(layer, variant, ink);
        Object.assign(held, {
          name,
          madeAt: now(),
          expiresAt: now() + MAP_TTL_MS,
          error: null,
        });
      } catch (error) {
        held.error = String(error?.message || error).slice(0, 400);
        console.warn(`[EarthEngine] ${key} map not made:`, held.error);
      } finally {
        held.inflight = null;
      }
      return held;
    })();
    return held.inflight;
  }

  /** Today's Earth Engine tiles: in all, per layer, and the warnings given. */
  function usage() {
    const day = new Date(now()).toISOString().slice(0, 10);
    try {
      const stored = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
      if (stored?.day === day)
        return {
          day,
          tiles: Number(stored.tiles) || 0,
          byLayer:
            stored.byLayer && typeof stored.byLayer === 'object'
              ? { ...stored.byLayer }
              : {},
          warned: Array.isArray(stored.warned) ? stored.warned : [],
        };
    } catch {
      /* none yet today */
    }
    return { day, tiles: 0, byLayer: {}, warned: [] };
  }
  /** Count one tile fetched from Earth Engine; say so once at 50% and 90%. */
  function countTile(layerId) {
    const current = usage();
    current.tiles += 1;
    current.byLayer[layerId] = (Number(current.byLayer[layerId]) || 0) + 1;
    const budget = settings().dailyTiles;
    for (const share of BUDGET_WARNINGS) {
      if (current.warned.includes(share) || !budget) continue;
      if (current.tiles < (budget * share) / 100) continue;
      current.warned.push(share);
      const top = Object.entries(current.byLayer)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, count]) => `${id} ${count}`)
        .join(', ');
      console.warn(
        `[EarthEngine] ${share}% of today's tile budget used (${current.tiles} of ${budget}; ${top})`,
      );
    }
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${usageFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(current));
    fs.renameSync(temporary, usageFile);
  }

  const tileFile = (layerId, variantKey, ink, z, x, y) =>
    path.join(
      dir,
      'tiles',
      layerId,
      variantKey,
      ink,
      String(z),
      String(x),
      `${y}.png`,
    );

  return {
    /** The layer catalog, every map made or refreshed as needed. */
    async layers() {
      const current = settings();
      const today = usage();
      const tiles = { used: today.tiles, budget: current.dailyTiles };
      const out = [];
      for (const layer of layers) {
        const variants = [];
        const inks = layerInks(layer);
        let error = current.configured || backend ? null : NEEDS_KEY;
        for (const variant of layerVariants(layer)) {
          // One map per ink; the variant is ready when every ink's map is.
          const held = [];
          for (const ink of inks)
            held.push(
              current.configured || backend
                ? await mapFor(layer, variant, ink)
                : {},
            );
          const failed = held.find((map) => map.error);
          if (failed && !error) error = failed.error;
          const expiries = held
            .map((map) => map.expiresAt)
            .filter(Number.isFinite);
          variants.push({
            key: variant.key,
            ...(variant.auto ? { auto: true } : {}),
            ...(variant.minHeightM !== undefined
              ? { minHeightM: variant.minHeightM }
              : {}),
            ...(variant.maxHeightM !== undefined
              ? { maxHeightM: variant.maxHeightM }
              : {}),
            ready: held.every((map) => Boolean(map.name)),
            ...(expiries.length
              ? { expiresAt: new Date(Math.min(...expiries)).toISOString() }
              : {}),
          });
        }
        out.push({
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          tileUrl: `${EARTH_ENGINE_ROUTE}/tile/${layer.id}/{variant}/{ink}/{z}/{x}/{y}`,
          maxZoom: layer.maxZoom ?? 12,
          variants,
          inks,
          legend: layer.legend || [],
          attribution:
            `${EARTH_ENGINE_ATTRIBUTION} · ${layer.attribution || ''}`.trim(),
          // Tiles this layer took from Earth Engine today (disk hits are free).
          tilesToday: Number(today.byLayer[layer.id]) || 0,
          error,
        });
      }
      return {
        configured: current.configured || Boolean(backend),
        ...(current.configured || backend ? {} : { message: NEEDS_KEY }),
        tiles,
        layers: out,
      };
    },

    /**
     * One tile: from disk, else from Earth Engine within the day's budget.
     * @returns {Promise<{status: number, contentType?: string, body?: Buffer, error?: string, cached?: boolean}>}
     */
    async tile(layerId, variantKey, ink, z, x, y) {
      const layer = byId.get(layerId);
      const variant = layer
        ? layerVariants(layer).find((entry) => entry.key === variantKey)
        : null;
      if (!variant) return { status: 404, error: 'No such layer' };
      if (!layerInks(layer).includes(ink))
        return { status: 404, error: 'No such ink' };
      const limit = 2 ** z;
      if (z > (layer.maxZoom ?? 12) || x >= limit || y >= limit)
        return { status: 400, error: 'Tile out of range' };
      const file = tileFile(layerId, variantKey, ink, z, x, y);
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs < TILE_TTL_MS)
          return {
            status: 200,
            contentType: 'image/png',
            body: fs.readFileSync(file),
            cached: true,
          };
      } catch {
        /* not on disk */
      }
      const current = settings();
      if (!current.configured && !backend)
        return { status: 503, error: NEEDS_KEY };
      if (usage().tiles >= current.dailyTiles)
        return {
          status: 429,
          error: `The day's ${current.dailyTiles} Earth Engine tiles are used`,
        };
      let held = await mapFor(layer, variant, ink);
      if (!held.name) return { status: 502, error: held.error || 'No map' };
      const engine = backendNow();
      countTile(layerId);
      let answer = await engine.fetchTile(held.name, z, x, y);
      // An expired map is made again, once.
      if ([400, 404].includes(answer.status)) {
        held = await mapFor(layer, variant, ink, { force: true });
        if (held.name) {
          countTile(layerId);
          answer = await engine.fetchTile(held.name, z, x, y);
        }
      }
      if (answer.status !== 200 || !answer.body)
        return {
          status: answer.status === 200 ? 502 : answer.status,
          error: answer.error,
        };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, answer.body);
      } catch {
        /* serving matters more than keeping */
      }
      return {
        status: 200,
        contentType: answer.contentType,
        body: answer.body,
      };
    },
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** The routes under /api/earth-engine (same-site only, GET only). */
export function createEarthEngineHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const route =
      new URL(req.url || '/', 'http://localhost').pathname.replace(
        /\/+$/,
        '',
      ) || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const match = TILE_PATH.exec(route);
      if (match) {
        const [, layer, variant, ink, z, x, y] = match;
        const answer = await service.tile(
          layer,
          variant,
          ink,
          Number(z),
          Number(x),
          Number(y),
        );
        if (answer.status !== 200)
          return sendJson(res, answer.status, {
            error: answer.error || 'No tile',
          });
        res.statusCode = 200;
        res.setHeader('Content-Type', answer.contentType || 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.end(answer.body);
        return;
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[EarthEngine] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Earth Engine unavailable' });
    }
  };
}

let shared = null;

/** Vite plugin: /api/earth-engine for the Earth Engine overlay layers. */
export function earthEngineProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createEarthEngineService({ sourceRoot });
    middlewares.use(
      EARTH_ENGINE_ROUTE,
      createEarthEngineHandler({ service: service || shared }),
    );
  }
  return {
    name: 'earth-engine',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
