// Personal fork: Earth Engine overlay layers (src/layers/earthEngine/),
// through Earth Engine's REST API with a service account. Not part of
// upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { deflateSync } from 'node:zlib';
import {
  AMERICAS_CON_IDS,
  AMERICAS_KEEP,
  riverLineWidth,
  scaleAlpha,
  EARTH_ENGINE_ATTRIBUTION,
  EARTH_ENGINE_LAYERS,
  inkColor,
  layerInks,
  layerModes,
  layerVariants,
  modeRecord,
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
 *   GET /api/earth-engine/tile/<layer>/<mode>/<variant>/<ink>/<z>/<x>/<y>
 *       the same for a layer with modes (the Rivers' network, free-flowing
 *       and pressure colourings; Surface water's bands; Land cover's
 *       years; Population's epochs)
 *
 * A tile coarser than its variant's `minZoom` is a transparent PNG, made
 * here: no Earth Engine request, nothing counted.
 *
 * Each (layer, variant, ink[, mode]) has its own map, made by POST
 * /v1/projects/<project>/maps with the layer's expression (the computation
 * graph Earth Engine's own clients send; a features layer's line colour is
 * the ink's), cached until it nears its expiry, made again on demand, one
 * request at a time per map; when a new one cannot be made the old one
 * keeps serving and the error is reported. A layer marked `lazyMaps` (the
 * Rivers: 5 bands × 2 inks × 3 modes) has its maps made only when a tile
 * asks for one, not for the catalog. The JSON sent for each map is
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

const orOf = (filters) =>
  filters.length === 1
    ? filters[0]
    : invoke('Filter.or', { filters: { arrayValue: { values: filters } } });

/**
 * Not the Americas (CON_ID 1 or 2), or one of the `keep` places. CON_ID is
 * stored as a double: Filter.inList with [1, 2] matched no reach (live,
 * 2026-10-18) where Filter.eq compares numbers and matched 1,270,524 for
 * 1. So: not (CON_ID = 1 or CON_ID = 2), or COUNTRY = …, or inside a box.
 * The CON_ID test comes first, so a reach outside the Americas costs no
 * geometry test.
 */
function americasFilter(keep) {
  const outside = invoke('Filter.not', {
    filter: orOf(
      AMERICAS_CON_IDS.map((id) =>
        invoke('Filter.eq', {
          leftField: constant('CON_ID'),
          rightValue: constant(id),
        }),
      ),
    ),
  });
  const kept = keep.map((place) =>
    place.box
      ? invoke('Filter.intersects', {
          leftField: constant('.geo'),
          rightValue: invoke('GeometryConstructors.BBox', {
            west: constant(place.box[0]),
            south: constant(place.box[1]),
            east: constant(place.box[2]),
            north: constant(place.box[3]),
          }),
        })
      : invoke('Filter.eq', {
          leftField: constant(place.property),
          rightValue: constant(place.equals),
        }),
  );
  return orOf([outside, ...kept]);
}

/**
 * The filter a features variant draws through, or null: its RIV_ORD band
 * (`maxOrder`), and the Americas left out by the layer's `omitAmericas`
 * switch (all of them) or by a mode's (`network-rest`: all but
 * AMERICAS_KEEP, where HydroSHEDS v2 has no data).
 */
export function featureFilter(layer, variant, modeKey) {
  const filters = [];
  if (Number.isFinite(variant?.maxOrder))
    filters.push(
      invoke('Filter.lessThanOrEquals', {
        leftField: constant('RIV_ORD'),
        rightValue: constant(variant.maxOrder),
      }),
    );
  const mode = layer?.modes?.length ? modeRecord(layer, modeKey) : null;
  if (layer?.omitAmericas === true) filters.push(americasFilter([]));
  else if (mode?.omitAmericas === true)
    filters.push(americasFilter(AMERICAS_KEEP));
  if (!filters.length) return null;
  return filters.length === 1
    ? filters[0]
    : invoke('Filter.and', { filters: { arrayValue: { values: filters } } });
}

/** The name the per-feature style function calls its argument. */
const REACH = '_reach';
const reach = { argumentReference: REACH };

/** A numeric property's value less one: an index into a list by 1, 2, 3… */
function indexOf(property) {
  return invoke('Number.subtract', {
    left: invoke('Element.get', {
      object: reach,
      property: constant(property),
    }),
    right: constant(1),
  });
}

/** A table keyed 1, 2, 3… as a list in that order. */
const byNumber = (table) =>
  Object.keys(table)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => table[key]);

/**
 * The styles of one colour by order (RIV_ORD 1 to 10) in a band: the width
 * HydroSHEDS v2's renderer gives that order there (riverLineWidth), and
 * under a pixel a 1 px line with the colour's alpha scaled by the width.
 * A style is a whole {color, width} dictionary.
 */
function stylesByOrder(color, bandMaxOrder) {
  return Array.from({ length: 10 }, (_, i) => {
    const width = riverLineWidth(i + 1, bandMaxOrder);
    return {
      color: width < 1 ? scaleAlpha(color, width) : color,
      width: Math.max(1, Math.round(width * 100) / 100),
    };
  });
}

/**
 * A layer drawn per feature (`modes`): each feature gets a whole style
 * dictionary ({color, width}) looked up from constant tables, and
 * Collection.style draws them through `styleProperty`. The colour is the
 * ink's (`inInk`: NETWORK) or comes from the mode's table for the ink (by
 * the mode's property); the width by RIV_ORD within the band.
 *
 * Built so each reach costs one or two lookups of constants: building a
 * Dictionary per reach (with Number.format keys) made the slowest tiles
 * about twice as slow (o6 pressure at z 5 over the Amazon 18.3 s against
 * 9.7 s, live 2026-10-18). A numeric property (RIV_ORD 1 to 10, CSI_FF2 1
 * to 3: every reach has one, counted live) indexes a list; a text one
 * (CSI_D) keys a dictionary, with the fallback for anything else. The
 * function body is value '1', as Earth Engine's own clients encode a
 * mapped function.
 */
function styledFeatures(layer, variant, collection, ink, modeKey) {
  const mode = modeRecord(layer, modeKey);
  const bandMax = variant?.maxOrder ?? 10;
  const colors = mode.colors?.[ink] || {};
  const fallback = mode.fallback?.[ink] || inkColor(layer, ink);
  const stylesIn = (color) => stylesByOrder(color, bandMax);
  const byOrder = indexOf(layer.widthProperty);
  let style;
  if (mode.inInk)
    // NETWORK: the ink, its width by RIV_ORD: one lookup.
    style = invoke('List.get', {
      list: constant(stylesIn(inkColor(layer, ink))),
      index: byOrder,
    });
  else
    style = invoke('List.get', {
      list: mode.numeric
        ? invoke('List.get', {
            list: constant(byNumber(colors).map(stylesIn)),
            index: indexOf(mode.property),
          })
        : invoke('Dictionary.get', {
            dictionary: constant(
              Object.fromEntries(
                Object.entries(colors).map(([value, color]) => [
                  value,
                  stylesIn(color),
                ]),
              ),
            ),
            key: invoke('Element.get', {
              object: reach,
              property: constant(mode.property),
            }),
            defaultValue: constant(stylesIn(fallback)),
          }),
      index: byOrder,
    });
  return {
    values: {
      0: invoke('Collection.style', {
        collection: invoke('Collection.map', {
          collection,
          baseAlgorithm: {
            functionDefinitionValue: { argumentNames: [REACH], body: '1' },
          },
        }),
        styleProperty: constant('style'),
      }),
      1: invoke('Element.set', {
        object: reach,
        key: constant('style'),
        value: style,
      }),
    },
    result: '0',
  };
}

const imageConstant = (value) =>
  invoke('Image.constant', { value: constant(value) });
const reference = (key) => ({ valueReference: key });

/**
 * The expression of contour lines of an elevation every `step` metres (a
 * `contour` layer): the elevation, its sea (stored as 0) masked, is
 * quantised to the step (floor(dem / step)), and a pixel is on a line where
 * a neighbour's class is lower (the class differs from Image.focalMin over
 * the 3 × 3 pixels about it): lines one pixel wide, on the upper side of
 * each level, in the tile's own pixels. Every `indexEvery`-th level
 * (floor(class / indexEvery) changes too) is an index contour. The result
 * is a constant image whose mask is the line's alpha: `minorShare` for a
 * line, 1 for an index line, 0 elsewhere; the visualization colours it in
 * the ink, and the ink's own alpha (cc) scales both. The class and its
 * focal minimum are each one shared value (valueReference), as Earth
 * Engine's own clients send a value used more than once.
 */
export function contourExpression(
  dem,
  step,
  { indexEvery = 5, minorShare = 0.55, resample = '' },
  { mosaic = false } = {},
) {
  // Bilinear: a tile finer than the DEM's cells reads a smooth surface, not
  // nearest-neighbour steps (staircase lines at z 13 and 14 on 30 m cells).
  // A mosaic's default projection is 1°, so it is given its cells' first,
  // as for terrain: resampled over 1° cells, the lines were straight ramps.
  const surface = resample
    ? invoke('Image.resample', {
        image: mosaic
          ? invoke('Image.setDefaultProjection', {
              image: dem,
              crs: invoke('Projection', { crs: constant('EPSG:3857') }),
              scale: constant(30),
            })
          : dem,
        mode: constant(resample),
      })
    : dem;
  const level = invoke('Image.floor', {
    value: invoke('Image.divide', {
      image1: invoke('Image.selfMask', { image: surface }),
      image2: imageConstant(step),
    }),
  });
  const lowest = invoke('Image.focalMin', {
    image: reference('1'),
    radius: constant(1),
    kernelType: constant('square'),
    units: constant('pixels'),
  });
  const indexOf = (image) =>
    invoke('Image.floor', {
      value: invoke('Image.divide', {
        image1: image,
        image2: imageConstant(indexEvery),
      }),
    });
  const line = invoke('Image.neq', {
    image1: reference('1'),
    image2: reference('2'),
  });
  const index = invoke('Image.neq', {
    image1: indexOf(reference('1')),
    image2: indexOf(reference('2')),
  });
  const alpha = invoke('Image.where', {
    input: invoke('Image.multiply', {
      image1: line,
      image2: imageConstant(minorShare),
    }),
    test: index,
    value: imageConstant(1),
  });
  return {
    values: {
      0: invoke('Image.updateMask', { image: imageConstant(1), mask: alpha }),
      1: level,
      2: lowest,
    },
    result: '0',
  };
}

/**
 * An image layer's picture, from its record and, for a layer with modes,
 * its mode's (whose fields win; one map per mode), step by step:
 * - the asset: the mode's own `asset` (Land cover's years, Population's
 *   epochs), else the variant's with the mode's `band` (Surface water's
 *   bands), else the variant's;
 * - `terrain` (the layer's): slope, aspect or hillshade (ee.Terrain);
 * - `maskBand`: masked by another band of the variant's asset (Surface
 *   water's max_extent, whose coarse pyramid is water only where most of a
 *   pixel is);
 * - `remap` {from, to}: class codes to palette indices, anything else
 *   masked (Land cover, Forest types);
 * - zero masked: `mask` 'self' (or the layer's `selfMask`), or 'nonzero'
 *   for signed values (Surface water's change);
 * - `scale`: × a factor (Population: a count per equal-area cell to one
 *   per km²); `atLeast`: values below it masked; `log10`: the logarithm.
 */
function imageNode(layer, variant, modeKey) {
  const mode = layer.modes?.length ? modeRecord(layer, modeKey) : null;
  const steps = { ...layer, ...mode };
  let node = assetNode(
    mode?.asset ||
      (mode?.band ? { ...variant.asset, band: mode.band } : variant.asset),
  );
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
  if (steps.maskBand)
    node = invoke('Image.updateMask', {
      image: node,
      mask: assetNode({ ...variant.asset, band: steps.maskBand }),
    });
  if (steps.remap)
    node = invoke('Image.remap', {
      image: node,
      from: constant([...steps.remap.from]),
      to: constant([...steps.remap.to]),
    });
  const zero = steps.mask || (steps.selfMask ? 'self' : null);
  if (zero === 'self') node = invoke('Image.selfMask', { image: node });
  else if (zero === 'nonzero')
    node = invoke('Image.updateMask', {
      image: node,
      mask: invoke('Image.neq', { image1: node, image2: imageConstant(0) }),
    });
  if (Number.isFinite(steps.scale))
    node = invoke('Image.multiply', {
      image1: node,
      image2: imageConstant(steps.scale),
    });
  if (Number.isFinite(steps.atLeast))
    node = invoke('Image.updateMask', {
      image: node,
      mask: invoke('Image.gte', {
        image1: node,
        image2: imageConstant(steps.atLeast),
      }),
    });
  if (steps.log10) node = invoke('Image.log10', { value: node });
  return node;
}

/** The colours a map draws with: the mode's for an image layer with modes, else the layer's. */
export function visFor(layer, modeKey) {
  if (layer.kind === 'features') return null;
  const mode = layer.modes?.length ? modeRecord(layer, modeKey) : null;
  return mode?.vis || layer.vis || null;
}

/**
 * A layer variant's expression in an ink (and mode), as the REST API takes
 * it: {values: {0: <value node>, …}, result: '0'}.
 */
export function expressionFor(
  layer,
  variant = layerVariants(layer)[0],
  ink = layerInks(layer)[0],
  mode = layerModes(layer)[0],
) {
  // Contour lines (Elevation contours) have their own expression.
  if (layer.contour)
    return contourExpression(
      assetNode(variant.asset),
      variant.step,
      layer.contour,
      { mosaic: Boolean(variant.asset?.collection) },
    );
  if (layer.kind !== 'features')
    return { values: { 0: imageNode(layer, variant, mode) }, result: '0' };
  let node = assetNode(variant.asset);
  const filter = featureFilter(layer, variant, mode);
  if (filter) node = invoke('Collection.filter', { collection: node, filter });
  if (layer.modes?.length)
    return styledFeatures(layer, variant, node, ink, mode);
  const style = layer.style || {};
  node = invoke('Collection.style', {
    collection: node,
    color: constant(inkColor(layer, ink)),
    fillColor: constant(style.fillColor || '00000000'),
    width: constant(style.width ?? 1),
  });
  return { values: { 0: node }, result: '0' };
}

/**
 * A short hash of what a map is made from (its request body): the disk
 * cache files tiles under it, so a changed expression, ink or
 * visualization never serves the old one's tiles.
 */
export function mapRequestHash(
  layer,
  variant,
  ink = layerInks(layer)[0],
  mode = layerModes(layer)[0],
) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(mapRequestFor(layer, variant, ink, mode)))
    .digest('hex')
    .slice(0, 12);
}

/** The body of the request that makes a layer variant's map in an ink (and mode). */
export function mapRequestFor(
  layer,
  variant,
  ink = layerInks(layer)[0],
  mode = layerModes(layer)[0],
) {
  const body = {
    expression: expressionFor(layer, variant, ink, mode),
    fileFormat: 'PNG',
  };
  const vis = visFor(layer, mode);
  if (layer.contour) {
    // The lines in the ink; the ink's alpha (RRGGBBAA) is the map's opacity.
    const color = inkColor(layer, ink);
    const alpha = parseInt(String(color).slice(6, 8) || 'ff', 16) / 255;
    body.visualizationOptions = {
      ranges: [{ min: 0, max: 1 }],
      paletteColors: [color.slice(0, 6), color.slice(0, 6)],
      opacity: Math.round(alpha * 1000) / 1000,
    };
  } else if (vis)
    body.visualizationOptions = {
      ranges: [{ min: vis.min, max: vis.max }],
      paletteColors: [...(vis.palette || [])],
    };
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
  async function authorized(url, init = {}) {
    const send = async () =>
      fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${await auth.token()}`,
        },
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
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
    async createMap(
      layer,
      variant,
      ink = layerInks(layer)[0],
      mode = layerModes(layer)[0],
    ) {
      const response = await authorized(
        `${EE_API}/projects/${encodeURIComponent(project)}/maps?fields=name`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mapRequestFor(layer, variant, ink, mode)),
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
/** The same with a mode after the layer (a layer with `modes`). */
const MODE_TILE_PATH =
  /^\/tile\/(ee-[a-z0-9-]{1,40})\/([a-z][a-z0-9-]{0,19})\/([a-z0-9-]{1,20})\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/;

/**
 * The variant that draws a tile coarser than `variant`'s minZoom, or null
 * (then the tile is transparent). For variants that name the `zooms` they
 * are drawn at (the Rivers bands, matched to the zooms Cesium drapes at
 * their heights): the variant whose zooms hold z, else the first (the
 * fewest orders), so a z 0 to 4 tile of any band is the orbit band's,
 * which Earth Engine draws in seconds. Only a 3D-tiles host asks for these:
 * it drapes about one imagery tile on each loaded primitive, at the level
 * that spans it, so a continent-sized primitive at orbit asks for z 0 to 2
 * (docs/PERSONAL-FORK.md, "Rivers on the photoreal tiles").
 */
export function coarseVariant(layer, variant, z) {
  if (!variant?.zooms || !zoomMatched(layer)) return null;
  return variantForZoom(layer, z);
}

/** The pseudo-variant a layer with zoom-matched bands is drawn through. */
export const ZOOM_VARIANT = 'zoom';

/** Whether every variant of a layer names the zooms it is drawn at. */
export const zoomMatched = (layer) =>
  layerVariants(layer).every((variant) => Array.isArray(variant.zooms));

/**
 * The band a zoom draws: the variant whose `zooms` hold z, else the first
 * below the bands' zooms (the fewest orders) or the last above them.
 */
export function variantForZoom(layer, z) {
  const variants = layerVariants(layer);
  return (
    variants.find((entry) => z >= entry.zooms[0] && z <= entry.zooms[1]) ||
    (z < variants[0].zooms[0] ? variants[0] : variants[variants.length - 1])
  );
}

/** "<layer>/<variant>/<ink>", or "<layer>/<mode>/<variant>/<ink>" for a layer with modes. */
export function mapKey(layer, variant, ink, mode = 'default') {
  return mode === 'default'
    ? `${layer.id}/${variant.key}/${ink}`
    : `${layer.id}/${mode}/${variant.key}/${ink}`;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/**
 * A transparent 256 × 256 PNG (RGBA, every pixel 0): the answer for a tile
 * coarser than its variant's `minZoom`.
 */
export const TRANSPARENT_TILE = (() => {
  const size = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (1 + size * 4)); // filter 0, zero pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
})();

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

  /** A (variant, ink[, mode])'s map, made again once old; the old one serves if that fails. */
  async function mapFor(
    layer,
    variant,
    ink,
    { force = false, mode = 'default' } = {},
  ) {
    const key = mapKey(layer, variant, ink, mode);
    const held = maps.get(key) || {};
    maps.set(key, held);
    if (!force && held.name && now() < held.expiresAt) return held;
    held.inflight ||= (async () => {
      try {
        const engine = backendNow();
        if (!engine) throw new Error(NEEDS_KEY);
        const { name } =
          mode === 'default'
            ? await engine.createMap(layer, variant, ink)
            : await engine.createMap(layer, variant, ink, mode);
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

  /** mapKey → the hash of its map request (fixed per process). */
  const hashes = new Map();
  const tileFile = (layer, variant, ink, z, x, y, mode = 'default') => {
    const key = mapKey(layer, variant, ink, mode);
    if (!hashes.has(key))
      hashes.set(key, mapRequestHash(layer, variant, ink, mode));
    return path.join(
      dir,
      'tiles',
      layer.id,
      ...(mode === 'default' ? [] : [mode]),
      variant.key,
      ink,
      hashes.get(key),
      String(z),
      String(x),
      `${y}.png`,
    );
  };

  return {
    /**
     * The layer catalog, every map made or refreshed as needed (a
     * `lazyMaps` layer's only when its tiles ask: the catalog reports the
     * maps it has).
     */
    async layers() {
      const current = settings();
      const today = usage();
      const tiles = { used: today.tiles, budget: current.dailyTiles };
      const out = [];
      for (const layer of layers) {
        const variants = [];
        const inks = layerInks(layer);
        const modes = layerModes(layer);
        const moded = modes[0] !== 'default';
        let error = current.configured || backend ? null : NEEDS_KEY;
        for (const variant of layerVariants(layer)) {
          // One map per ink (and mode); the variant is ready when every one is.
          const held = [];
          for (const mode of modes)
            for (const ink of inks)
              held.push(
                !(current.configured || backend)
                  ? {}
                  : layer.lazyMaps
                    ? maps.get(mapKey(layer, variant, ink, mode)) || {}
                    : await mapFor(layer, variant, ink, { mode }),
              );
          const failed = held.find((map) => map.error);
          if (failed && !error) error = failed.error;
          const expiries = held
            .map((map) => map.expiresAt)
            .filter(Number.isFinite);
          // Per ink, the hash its tiles are kept under: the client puts it
          // in the tile URL, so the browser's day-long cache cannot serve a
          // changed expression's old tiles either.
          const versionsFor = (mode) =>
            Object.fromEntries(
              inks.map((ink) => [
                ink,
                mapRequestHash(layer, variant, ink, mode),
              ]),
            );
          variants.push({
            key: variant.key,
            ...(variant.auto ? { auto: true } : {}),
            ...(variant.minHeightM !== undefined
              ? { minHeightM: variant.minHeightM }
              : {}),
            ...(variant.maxHeightM !== undefined
              ? { maxHeightM: variant.maxHeightM }
              : {}),
            ...(Number.isInteger(variant.minZoom)
              ? { minZoom: variant.minZoom }
              : {}),
            ready: held.every((map) => Boolean(map.name)),
            ...(moded
              ? {
                  modeVersions: Object.fromEntries(
                    modes.map((mode) => [mode, versionsFor(mode)]),
                  ),
                }
              : { versions: versionsFor('default') }),
            ...(expiries.length
              ? { expiresAt: new Date(Math.min(...expiries)).toISOString() }
              : {}),
          });
        }
        // Bands matched to zooms (the Rivers) are also served as one
        // `zoom` variant: each tile drawn by the band of its own zoom, as
        // HydroSHEDS v2's tiles are; its version hashes every band's.
        if (zoomMatched(layer)) {
          const versionsAt = (mode) =>
            Object.fromEntries(
              inks.map((ink) => [
                ink,
                crypto
                  .createHash('sha256')
                  .update(
                    layerVariants(layer)
                      .map((variant) =>
                        mapRequestHash(layer, variant, ink, mode),
                      )
                      .join(','),
                  )
                  .digest('hex')
                  .slice(0, 12),
              ]),
            );
          variants.push({
            key: ZOOM_VARIANT,
            minZoom: 0,
            ready: variants.every((variant) => variant.ready),
            ...(moded
              ? {
                  modeVersions: Object.fromEntries(
                    modes.map((mode) => [mode, versionsAt(mode)]),
                  ),
                }
              : { versions: versionsAt('default') }),
          });
        }
        out.push({
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          tileUrl: moded
            ? `${EARTH_ENGINE_ROUTE}/tile/${layer.id}/{mode}/{variant}/{ink}/{z}/{x}/{y}`
            : `${EARTH_ENGINE_ROUTE}/tile/${layer.id}/{variant}/{ink}/{z}/{x}/{y}`,
          maxZoom: layer.maxZoom ?? 12,
          variants,
          inks,
          ...(moded ? { modes } : {}),
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
     * One tile: from disk, else from Earth Engine within the day's budget;
     * a transparent one below the variant's `minZoom`. `mode` is 'default'
     * for a layer without modes.
     * @returns {Promise<{status: number, contentType?: string, body?: Buffer, error?: string, cached?: boolean, blank?: boolean}>}
     */
    async tile(layerId, variantKey, ink, z, x, y, mode = 'default') {
      const layer = byId.get(layerId);
      let variant = layer
        ? variantKey === ZOOM_VARIANT && zoomMatched(layer)
          ? variantForZoom(layer, z)
          : layerVariants(layer).find((entry) => entry.key === variantKey)
        : null;
      if (!variant) return { status: 404, error: 'No such layer' };
      if (!layerInks(layer).includes(ink))
        return { status: 404, error: 'No such ink' };
      if (!layerModes(layer).includes(mode))
        return { status: 404, error: 'No such mode' };
      const limit = 2 ** z;
      if (z > (layer.maxZoom ?? 12) || x >= limit || y >= limit)
        return { status: 400, error: 'Tile out of range' };
      if (z < (variant.minZoom ?? 0)) {
        // A band with zooms (the Rivers) answers a coarser tile with the
        // band drawn at that zoom: a 3D tileset drapes one tile per loaded
        // primitive whatever the level, so it asks for coarse tiles the
        // globe never does (see coarseVariant). Otherwise: transparent.
        const coarse = coarseVariant(layer, variant, z);
        if (!coarse)
          return {
            status: 200,
            contentType: 'image/png',
            body: TRANSPARENT_TILE,
            blank: true,
          };
        variant = coarse;
      }
      const file = tileFile(layer, variant, ink, z, x, y, mode);
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
      let held = await mapFor(layer, variant, ink, { mode });
      if (!held.name) return { status: 502, error: held.error || 'No map' };
      const engine = backendNow();
      countTile(layerId);
      let answer = await engine.fetchTile(held.name, z, x, y);
      // An expired map is made again, once.
      if ([400, 404].includes(answer.status)) {
        held = await mapFor(layer, variant, ink, { force: true, mode });
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
      const plain = TILE_PATH.exec(route);
      const moded = plain ? null : MODE_TILE_PATH.exec(route);
      if (plain || moded) {
        const [layer, mode, variant, ink, z, x, y] = plain
          ? [plain[1], 'default', ...plain.slice(2)]
          : moded.slice(1);
        const answer = await service.tile(
          layer,
          variant,
          ink,
          Number(z),
          Number(x),
          Number(y),
          ...(mode === 'default' ? [] : [mode]),
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
