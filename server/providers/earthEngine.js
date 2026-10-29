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
// Personal fork: a user's colour scale for a raster layer (window, palette).
import {
  decodeScaleToken,
  drawnScaleKey,
  drawnWindow,
  takesScale,
} from '../../src/data/earthEngineScale.js';
import {
  DEM_RESAMPLE,
  VALID_HEIGHT_M,
  bandLayers,
  demBand,
  demSource,
} from '../../src/data/demStack.js';
import {
  BLOCKS_STYLE_EDGE_TONE,
  BLOCKS_STYLE_LAYER,
  BLOCKS_STYLE_TERRAIN_RGB,
  BLOCKS_STYLE_WATER_RGB,
  blocksLevelM,
  blocksStyleLit,
  blocksStyleCell,
  blocksStyleZoomBand,
} from '../../src/data/blocksStyle.js';

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
 *       years; Population's epochs), and for Elevation's Blocks style,
 *       mode 'blocks-<cellM>' at each coarse pyramid level
 *       (src/data/blocksStyle.js; not in the catalog, its maps made when
 *       a tile asks)
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
/** computePixels: 512² cells of two float bands is 2 MB. */
const MAX_PIXELS_BYTES = 4 * 1024 * 1024;
const TILE_TIMEOUT_MS = 30_000;
/**
 * A values request (image:computePixels) waits this long: a 512-cell
 * tile reduced to a mean at a coarse level often takes longer than a map
 * tile's 30 s.
 */
export const VALUES_TIMEOUT_MS = 120_000;
/** One more try after a values request gets no answer, this long after. */
export const VALUES_RETRY_MS = 2_000;
/** What a client is told to wait before asking again after no answer, s. */
export const VALUES_RETRY_AFTER_S = 30;
/** A token exchange is tried this many times while it may pass (no answer, 429, 5xx, a 200 without a token)… */
export const SIGN_IN_ATTEMPTS = 4;
/** …waiting this long before the second, doubling after. */
export const SIGN_IN_BACKOFF_MS = 500;
/** A token this close to its end is renewed in the background while it still serves. */
export const SIGN_IN_EARLY_MS = 5 * 60 * 1000;
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
  if (asset?.sum) return summedNode(asset);
  const loaded = asset?.collection
    ? invoke('ImageCollection.load', { id: constant(asset.collection) })
    : null;
  // A collection with one image per year (Open Buildings): that year's.
  const collection =
    loaded && Number.isInteger(asset.year)
      ? invoke('Collection.filter', {
          collection: loaded,
          filter: invoke('Filter.calendarRange', {
            start: constant(asset.year),
            end: constant(asset.year),
            field: constant('year'),
          }),
        })
      : loaded;
  const image = collection
    ? invoke('ImageCollection.mosaic', { collection })
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
 * A collection's band summed over its images (`sum`: Inundation history's
 * flood count, or days, over 913 events), less the share of each pixel
 * that is `lessShareOf` (permanent water, the same JRC map in every event):
 * sum × (1 − share). Both are pyramided by MEAN, so a coarse pixel is the
 * flooded fraction summed over the events, times its land share: a count
 * averaged over the pixel's area. A mask would drop every coarse pixel that
 * touches a lake or a coast.
 */
function summedNode(asset) {
  const collection = invoke('ImageCollection.load', {
    id: constant(asset.collection),
  });
  const summed = invoke('Image.select', {
    input: invoke('ImageCollection.reduce', {
      collection,
      reducer: invoke('Reducer.sum', {}),
    }),
    bandSelectors: constant([`${asset.sum}_sum`]),
  });
  if (!asset.lessShareOf) return summed;
  return invoke('Image.multiply', {
    image1: summed,
    image2: invoke('Image.subtract', {
      image1: invoke('Image.constant', { value: constant(1) }),
      image2: invoke('Image.select', {
        input: invoke('ImageCollection.mosaic', { collection }),
        bandSelectors: constant([asset.lessShareOf]),
      }),
    }),
  });
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
  { mosaic = false, values: shared = {} } = {},
) {
  // The class and its focal minimum come after any values `dem` refers to
  // (the DEM stack's shared sources).
  const levelRef = String(Object.keys(shared).length + 1);
  const lowestRef = String(Object.keys(shared).length + 2);
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
    image: reference(levelRef),
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
    image1: reference(levelRef),
    image2: reference(lowestRef),
  });
  const index = invoke('Image.neq', {
    image1: indexOf(reference(levelRef)),
    image2: indexOf(reference(lowestRef)),
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
      ...shared,
      [levelRef]: level,
      [lowestRef]: lowest,
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
 * - `perBand` {band, atLeast}: ÷ another band of the same asset, masked
 *   where that band is below `atLeast` (Buildings' height per built share:
 *   both bands MEAN-pyramided, so a coarse pixel is Σ height / Σ presence);
 * - `scale`: × a factor (Population: a count per equal-area cell to one
 *   per km²); `atLeast`: values below it masked; `log10`: the logarithm.
 */
function imageNode(layer, variant, modeKey, window = null) {
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
    node = terrainNode(layer.terrain, node);
  }
  if (steps.perBand) {
    const asset =
      mode?.asset ||
      (mode?.band ? { ...variant.asset, band: mode.band } : variant.asset);
    const divisor = assetNode({ ...asset, band: steps.perBand.band });
    node = invoke('Image.updateMask', {
      image: invoke('Image.divide', { image1: node, image2: divisor }),
      mask: invoke('Image.gte', {
        image1: divisor,
        image2: imageConstant(steps.perBand.atLeast ?? 0),
      }),
    });
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
  // A chosen colour scale draws in its own transform (and may hide what
  // lies outside its window); otherwise the layer's native log10, if any.
  if (window) node = drawnNode(node, window);
  else if (steps.log10) node = invoke('Image.log10', { value: node });
  return node;
}

/**
 * An image in the transform a chosen scale asks for, in place of the
 * layer's native one: log → log10 (zero and below masked first), sqrt →
 * the root of the non-negative part, linear → as it is.
 */
function transformNode(node, transform) {
  if (transform === 'log')
    return invoke('Image.log10', {
      value: invoke('Image.updateMask', {
        image: node,
        mask: invoke('Image.gt', { image1: node, image2: imageConstant(0) }),
      }),
    });
  if (transform === 'sqrt')
    return invoke('Image.sqrt', {
      value: invoke('Image.max', { image1: node, image2: imageConstant(0) }),
    });
  return node;
}

/**
 * The image a chosen scale draws: in its transform, masked outside its
 * window when it hides; a diverging or circular scale as its ramp
 * position t, 0 to 1 (src/data/earthEngineScale.js, drawnWindow).
 */
function drawnNode(node, window) {
  if (window.remap?.kind === 'diverging') return divergingNode(node, window);
  if (window.remap?.kind === 'circular') return circularNode(node, window);
  return hideOutside(transformNode(node, window.transform), window);
}

const imageSubtract = (image, value) =>
  invoke('Image.subtract', { image1: image, image2: imageConstant(value) });
const imageScaled = (image, factor, offset = 0) => {
  const scaled = invoke('Image.multiply', {
    image1: image,
    image2: imageConstant(factor),
  });
  return offset
    ? invoke('Image.add', { image1: scaled, image2: imageConstant(offset) })
    : scaled;
};

/**
 * A locked diverging scale: each side of the centre stretched to its own
 * end, below it t = 0.5 · (v − floor) / (centre − floor), above it
 * t = 0.5 + 0.5 · (v − centre) / (ceiling − centre).
 */
function divergingNode(node, window) {
  const { floor, centre, ceiling } = window.remap;
  const values = hideOutside(node, {
    hide: window.hide,
    min: floor,
    max: ceiling,
  });
  return invoke('Image.where', {
    input: imageScaled(
      imageSubtract(values, centre),
      0.5 / (ceiling - centre),
      0.5,
    ),
    test: invoke('Image.lt', { image1: values, image2: imageConstant(centre) }),
    value: imageScaled(imageSubtract(values, floor), 0.5 / (centre - floor)),
  });
}

/**
 * A circular scale: along = (v − floor) mod period (values within a
 * period of the start, as an aspect's are), t = along / span; past the
 * arc hidden, or the nearer end (1 when along − span ≤ period − along).
 */
function circularNode(node, window) {
  const { floor, span, period } = window.remap;
  const offset = imageSubtract(node, floor);
  const along = invoke('Image.where', {
    input: offset,
    test: invoke('Image.lt', { image1: offset, image2: imageConstant(0) }),
    value: invoke('Image.add', {
      image1: offset,
      image2: imageConstant(period),
    }),
  });
  const t = imageScaled(along, 1 / span);
  if (window.hide)
    return invoke('Image.updateMask', {
      image: t,
      mask: invoke('Image.lte', { image1: along, image2: imageConstant(span) }),
    });
  return invoke('Image.where', {
    input: t,
    test: invoke('Image.gt', { image1: along, image2: imageConstant(span) }),
    value: invoke('Image.lte', {
      image1: imageScaled(along, 2),
      image2: imageConstant(span + period),
    }),
  });
}

/** With "outside: hide", the image masked below the window's floor and above its ceiling. */
function hideOutside(node, window) {
  if (!window?.hide) return node;
  const above = invoke('Image.updateMask', {
    image: node,
    mask: invoke('Image.gte', {
      image1: node,
      image2: imageConstant(window.min),
    }),
  });
  return invoke('Image.updateMask', {
    image: above,
    mask: invoke('Image.lte', {
      image1: node,
      image2: imageConstant(window.max),
    }),
  });
}

/** The window a chosen scale draws (drawn space), or null for the layer's own visualization. */
function windowFor(layer, scale) {
  if (!scale || layer?.kind === 'features' || layer?.contour) return null;
  return drawnWindow(scale);
}

/** The colours a map draws with: the mode's for an image layer with modes, else the layer's. */
export function visFor(layer, modeKey) {
  if (layer.kind === 'features') return null;
  const mode = layer.modes?.length ? modeRecord(layer, modeKey) : null;
  return mode?.vis || layer.vis || null;
}

// --- the DEM stack (src/data/demStack.js) ---------------------------------------

/** A terrain operation on an elevation image ('slope', 'aspect', 'hillshade'). */
function terrainNode(kind, input) {
  return kind === 'hillshade'
    ? invoke('Terrain.hillshade', {
        input,
        azimuth: constant(315),
        elevation: constant(45),
      })
    : invoke(kind === 'aspect' ? 'Terrain.aspect' : 'Terrain.slope', {
        input,
      });
}

/**
 * The geometry a source is clipped to: one box is a BBox; several are a
 * planar MultiPolygon (edges along parallels and meridians, as the client's
 * box tests take them).
 */
export function boxesGeometry(boxes) {
  if (boxes.length === 1) {
    const [west, south, east, north] = boxes[0];
    return invoke('GeometryConstructors.BBox', {
      west: constant(west),
      south: constant(south),
      east: constant(east),
      north: constant(north),
    });
  }
  return invoke('GeometryConstructors.MultiPolygon', {
    coordinates: constant(
      boxes.map(([west, south, east, north]) => [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ]),
    ),
    geodesic: constant(false),
  });
}

/** An image's `band`, from an image node. */
const bandNode = (image, band) =>
  invoke('Image.select', { input: image, bandSelectors: constant([band]) });

/**
 * A source's elevation band, before any mask: an image, or a collection
 * mosaicked and given its own grid (`crs`, `crsTransform`) so the terrain
 * operations have a projection that does not resample it.
 */
function demRawNode(asset) {
  const image = asset.collection
    ? invoke('ImageCollection.mosaic', {
        collection: invoke('ImageCollection.load', {
          id: constant(asset.collection),
        }),
      })
    : invoke('Image.load', { id: constant(asset.image) });
  const band = bandNode(image, asset.band);
  return asset.crs
    ? invoke('Image.setDefaultProjection', {
        image: band,
        crs: invoke('Projection', { crs: constant(asset.crs) }),
        crsTransform: constant([...asset.crsTransform]),
      })
    : band;
}

/** An image's own band `name` (ArcticDEM's datamask). */
const bandOf = (asset, name) =>
  bandNode(invoke('Image.load', { id: constant(asset.image) }), name);

/** The name a `perImage` source's mapped function calls its image. */
const DEM_IMAGE = '_dem';

/**
 * A band of the DEM stack as an expression: each source's elevation (its
 * water at 0 masked where `seaIsZero`, ArcticDEM masked by its own data or
 * by the base's land), the terrain operation on each (so the sources'
 * datums, which differ by up to 60 m, make no step), each clipped to its
 * boxes, mosaicked bottom to top: the finer source on top inside its box,
 * the base beneath it with no gap. Each source's elevation is a shared value
 * ('1', '2', …), so FABDEM read for the base and for the land mask is one
 * node; a `perImage` source (3DEP 1 m) is a function over its images (its
 * body a value too), each drawn in its own projection, then mosaicked. The
 * Elevation layer (`heights`) mosaics the heights themselves.
 */
function demStackExpression(
  layer,
  variant,
  { resample = DEM_RESAMPLE, window = null } = {},
) {
  const band = demBand(variant.stack);
  const values = {};
  const refs = new Map();
  const share = (name, node) => {
    if (!refs.has(name)) {
      const ref = String(refs.size + 1);
      refs.set(name, ref);
      values[ref] = node();
    }
    return refs.get(name);
  };
  const raw = (key) => ({
    valueReference: share(key, () => demRawNode(demSource(key).asset)),
  });
  // Land, for ArcticDEM on top: FABDEM not 0; where FABDEM has nothing
  // (north of 80° N, open sea), ArcticDEM's own data mask.
  const land = (entry) =>
    invoke('Image.unmask', {
      input: invoke('Image.neq', {
        image1: raw('fabdem'),
        image2: invoke('Image.constant', { value: constant(0) }),
      }),
      value: bandOf(entry.asset, entry.asset.maskBand),
      sameFootprint: constant(false),
    });
  /**
   * A layer with `validRange` [low, high] (the Blocks values and style):
   * a source's raw pixels outside it masked, before anything reads them.
   */
  const valid = (input) => {
    if (!layer.validRange) return input;
    const [low, high] = layer.validRange;
    const above = invoke('Image.updateMask', {
      image: input,
      mask: invoke('Image.gte', {
        image1: input,
        image2: invoke('Image.constant', { value: constant(low) }),
      }),
    });
    return invoke('Image.updateMask', {
      image: above,
      mask: invoke('Image.lte', {
        image1: input,
        image2: invoke('Image.constant', { value: constant(high) }),
      }),
    });
  };
  /** What every source goes through: its masks, then terrain or a rename. */
  const pipeline = (entry, mask, pixels) => {
    // A fill value masked first, so the resampling never blends it in.
    const input = valid(pixels);
    // Each source read as a smooth surface on its own grid (DEM_RESAMPLE;
    // the contours' own `resample`), before the mosaic, whose default
    // projection (1°) would resample it to ramps.
    let node = resample
      ? invoke('Image.resample', { image: input, mode: constant(resample) })
      : input;
    if (entry.asset.seaIsZero) node = invoke('Image.selfMask', { image: node });
    if (mask)
      node = invoke('Image.updateMask', {
        image: node,
        mask:
          mask === 'land'
            ? land(entry)
            : bandOf(entry.asset, entry.asset.maskBand),
      });
    // A mosaic wants one band name and type: the terrain operations name
    // theirs; heights are renamed (FABDEM's is b1, GMTED2010's an integer).
    // Earth Engine computes a terrain operation on the source's own grid,
    // so its result is resampled too: magnified, it shades smoothly.
    return layer.terrain
      ? resample
        ? invoke('Image.resample', {
            image: terrainNode(layer.terrain, node),
            mode: constant(resample),
          })
        : terrainNode(layer.terrain, node)
      : invoke('Image.rename', {
          input: invoke('Image.toFloat', { value: node }),
          names: constant(['elevation']),
        });
  };
  const images = bandLayers(band, { heights: variant.heights }).map(
    ({ source: key, mask }) => {
      const entry = demSource(key);
      const node = entry.asset.perImage
        ? invoke('ImageCollection.mosaic', {
            collection: invoke('Collection.map', {
              collection: invoke('ImageCollection.load', {
                id: constant(entry.asset.collection),
              }),
              baseAlgorithm: {
                functionDefinitionValue: {
                  argumentNames: [DEM_IMAGE],
                  body: share(`${key}/each`, () =>
                    pipeline(
                      entry,
                      mask,
                      bandNode(
                        { argumentReference: DEM_IMAGE },
                        entry.asset.band,
                      ),
                    ),
                  ),
                },
              },
            }),
          })
        : pipeline(entry, mask, raw(key));
      return entry.boxes
        ? invoke('Image.clip', {
            input: node,
            geometry: boxesGeometry(entry.boxes),
          })
        : node;
    },
  );
  let node = invoke('ImageCollection.mosaic', {
    collection: invoke('ImageCollection.fromImages', {
      images: { arrayValue: { values: images } },
    }),
  });
  if (window) node = drawnNode(node, window);
  else if (layer.transform === 'sqrt')
    node = invoke('Image.sqrt', {
      value: invoke('Image.max', {
        image1: node,
        image2: invoke('Image.constant', { value: constant(0) }),
      }),
    });
  return { values: { 0: node, ...values }, result: '0' };
}

/**
 * Contour lines of the DEM stack's heights in a band (Elevation contours):
 * each source resampled on its own grid as the record asks (bilinear), the
 * heights mosaicked as the Elevation layer's are (the ellipsoidal polar
 * sources only beneath the others), then the contour expression of that.
 */
function stackContourExpression(layer, variant) {
  const stack = demStackExpression(layer, variant, {
    resample: layer.contour.resample || '',
  });
  const { 0: heights, ...shared } = stack.values;
  return contourExpression(
    heights,
    variant.step,
    { ...layer.contour, resample: '' },
    { values: shared },
  );
}

/**
 * An image layer's picture with a table drawn over it (a variant's
 * `overlay`: Buildings' footprints from z 15). The picture is visualized
 * with the mode's vis (Image.visualize), then the features whose
 * `overlay.filter.property` is at least `atLeast` are drawn by
 * Collection.style in the ink, `overlay.width` px, unfilled, and blended on
 * top. The map has no visualization of its own (the result is RGB).
 */
export function overlayExpression(layer, variant, ink, modeKey, window = null) {
  const vis = window || visFor(layer, modeKey);
  const picture = invoke('Image.visualize', {
    image: imageNode(layer, variant, modeKey, window),
    min: constant(vis.min),
    max: constant(vis.max),
    palette: constant([...vis.palette]),
  });
  const { table, filter, width = 1 } = variant.overlay;
  let features = assetNode({ table });
  if (filter)
    features = invoke('Collection.filter', {
      collection: features,
      filter: invoke('Filter.gte', {
        leftField: constant(filter.property),
        rightValue: constant(filter.atLeast),
      }),
    });
  return {
    values: {
      0: invoke('Image.blend', {
        bottom: picture,
        top: invoke('Collection.style', {
          collection: features,
          color: constant(inkColor(layer, ink)),
          fillColor: constant('00000000'),
          width: constant(width),
        }),
      }),
    },
    result: '0',
  };
}

/** The Blocks style's flat cells: the hillshade of a flat cell (255 · cos 45°). */
const FLAT_HILLSHADE = 180;
/**
 * The Blocks style's cell edges: the westmost and southmost of
 * BLOCKS_EDGE_PARTS sub-cells a side (one output pixel at the level the
 * client picks, 8 px a cell) …
 */
export const BLOCKS_EDGE_PARTS = 8;
/** … darkened to this share of the cell's tone. */
export const BLOCKS_EDGE_TONE = BLOCKS_STYLE_EDGE_TONE;
/**
 * A cell is the mean of SUB × SUB samples of its source, read at a quarter
 * of the cell (from the source's pyramid, itself means): 16 a cell, so a
 * z 4 tile at 1,920 m reads about 25 M pixels, not 400 M.
 */
export const BLOCKS_MEAN_SUB = 4;
/** A cell is water (level 0) when less than this share of it has heights. */
export const BLOCKS_LAND_SHARE = 0.5;
/** The water's colour: the Blocks water's (mesh.js), flat. */
export const BLOCKS_WATER_RGB = Object.freeze(
  blocksStyleLit(BLOCKS_STYLE_WATER_RGB),
);
/** The land's colour: the Blocks terrain's sand, lit as a top face. */
export const BLOCKS_TERRAIN_RGB = Object.freeze(
  blocksStyleLit(BLOCKS_STYLE_TERRAIN_RGB),
);
/** The finest level read from the far band (GMTED 230 m); finer ones read FABDEM 30 m. */
export const BLOCKS_FAR_FROM_M = 1920;
const M_PER_DEG_EQUATOR = 111_319.49;

/**
 * The Blocks style's grids: equal-angle cells of `cellM` (blockM of
 * latitude, as the Blocks lattice) from 180° W and, in whole cells, from
 * 90° S, so a style cell is a lattice cell; `part` divides the cell.
 */
export function blocksStyleGrid(cellM, part = 1) {
  const cellDeg = cellM / M_PER_DEG_EQUATOR;
  const top = -90 + Math.ceil(180 / cellDeg) * cellDeg;
  const deg = cellDeg / part;
  return { cellDeg, top, deg, transform: [deg, 0, -180, 0, -deg, top] };
}

/**
 * Elevation's Blocks style at a cell (src/data/blocksStyle.js), every
 * property the cell's own:
 * - the heights: the DEM stack's band for the level (the far band, GMTED
 *   230 m, from BLOCKS_FAR_FROM_M; FABDEM 30 m under it), fill masked
 *   (VALID_HEIGHT_M), averaged over each cell of blocksStyleGrid (from
 *   BLOCKS_MEAN_SUB² samples) and over valid pixels only;
 * - water: a cell less than half of whose samples have heights (the sea,
 *   masked in every source), or whose mean is at or below 0 m: level 0,
 *   one flat colour, as the Blocks geometry draws water;
 * - the level: the mean quantised down to blocksLevelM; its colour the
 *   Blocks terrain's sand as a top face shows it (blocksStyle.js, the
 *   geometry's), shaded flat by the hillshade of the quantised cells
 *   (÷ 180, a flat cell's); water the Blocks water's blue, lit alike;
 * - the edges: the westmost and southmost eighth of each cell, on a grid
 *   of eighths, BLOCKS_EDGE_TONE as dark (the geometry's 12 %).
 * Each is reprojected to its grid, so a cell is one colour at any zoom. An
 * RGB image, drawn 0 to 255.
 */
export function blocksStyleExpression(layer, variant, cellM) {
  const band = cellM >= BLOCKS_FAR_FROM_M ? 'far' : 'base';
  const source =
    layerVariants(layer).find((entry) => entry.stack === band) || variant;
  const heights = demStackExpression(
    { ...layer, transform: null, validRange: VALID_HEIGHT_M },
    source,
  );
  const levelM = blocksLevelM(cellM);
  const wgs84 = invoke('Projection', { crs: constant('EPSG:4326') });
  const onGrid = (image, part) =>
    invoke('Image.reproject', {
      image,
      crs: wgs84,
      crsTransform: constant(blocksStyleGrid(cellM, part).transform),
    });
  // The mean over each cell of samples at 1 / BLOCKS_MEAN_SUB of it.
  const cellMean = (image) =>
    onGrid(
      invoke('Image.reduceResolution', {
        image: invoke('Image.setDefaultProjection', {
          image,
          crs: wgs84,
          crsTransform: constant(
            blocksStyleGrid(cellM, BLOCKS_MEAN_SUB).transform,
          ),
        }),
        reducer: invoke('Reducer.mean', {}),
        bestEffort: constant(true),
        maxPixels: constant(BLOCKS_MEAN_SUB * BLOCKS_MEAN_SUB),
      }),
      1,
    );
  // The stack's own values ('1', '2', …) kept; its result moved off '0'.
  const { [heights.result]: heightsNode, ...stackValues } = heights.values;
  const count = Object.keys(heights.values).length;
  const refs = {
    heights: String(count + 1),
    water: String(count + 2),
    level: String(count + 3),
    mean: String(count + 4),
  };
  // Shared, so Earth Engine reduces it once for the water and the level.
  const meanHeight = reference(refs.mean);
  const landShare = cellMean(
    invoke('Image.unmask', {
      input: invoke('Image.mask', { image: reference(refs.heights) }),
      value: imageConstant(0),
      sameFootprint: constant(false),
    }),
  );
  // 1 where the cell is water: mostly no heights, or a mean at or below 0 m.
  const water = invoke('Image.max', {
    image1: invoke('Image.lt', {
      image1: landShare,
      image2: imageConstant(BLOCKS_LAND_SHARE),
    }),
    image2: invoke('Image.unmask', {
      input: invoke('Image.lte', {
        image1: meanHeight,
        image2: imageConstant(0),
      }),
      value: imageConstant(1),
      sameFootprint: constant(false),
    }),
  });
  // The cell's level in metres: the mean quantised down; water 0.
  const level = invoke('Image.where', {
    input: invoke('Image.unmask', {
      input: invoke('Image.multiply', {
        image1: invoke('Image.floor', {
          value: invoke('Image.divide', {
            image1: meanHeight,
            image2: imageConstant(levelM),
          }),
        }),
        image2: imageConstant(levelM),
      }),
      value: imageConstant(0),
      sameFootprint: constant(false),
    }),
    test: reference(refs.water),
    value: imageConstant(0),
  });
  // The Blocks terrain's sand as a flat top shows it; the relief is the
  // shade's (the geometry has one terrain colour, light carries shape).
  const land = imageConstant([...BLOCKS_TERRAIN_RGB]);
  // The hillshade of the quantised cells, on the cells' grid.
  const shade = invoke('Image.divide', {
    image1: onGrid(
      invoke('Terrain.hillshade', {
        input: reference(refs.level),
        azimuth: constant(315),
        elevation: constant(45),
      }),
      1,
    ),
    image2: imageConstant(FLAT_HILLSHADE),
  });
  const landTone = invoke('Image.min', {
    image1: invoke('Image.multiply', { image1: land, image2: shade }),
    image2: imageConstant(255),
  });
  const picture = invoke('Image.add', {
    image1: invoke('Image.multiply', {
      image1: landTone,
      image2: invoke('Image.subtract', {
        image1: imageConstant(1),
        image2: reference(refs.water),
      }),
    }),
    image2: invoke('Image.multiply', {
      image1: imageConstant([...BLOCKS_WATER_RGB]),
      image2: reference(refs.water),
    }),
  });
  // The edges: the westmost and southmost eighth of each cell, on the grid
  // of eighths (whole sub-cells, so a line is a whole output pixel there).
  const { deg: partDeg, top } = blocksStyleGrid(cellM, BLOCKS_EDGE_PARTS);
  const coordinates = invoke('Image.pixelCoordinates', { projection: wgs84 });
  const degrees = (axis) =>
    invoke('Image.select', {
      input: coordinates,
      bandSelectors: constant([axis]),
    });
  const partOf = (image) =>
    invoke('Image.mod', {
      image1: invoke('Image.floor', {
        value: invoke('Image.divide', {
          image1: image,
          image2: imageConstant(partDeg),
        }),
      }),
      image2: imageConstant(BLOCKS_EDGE_PARTS),
    });
  const west = invoke('Image.eq', {
    image1: partOf(
      invoke('Image.add', {
        image1: degrees('x'),
        image2: imageConstant(180),
      }),
    ),
    image2: imageConstant(0),
  });
  const south = invoke('Image.eq', {
    image1: partOf(
      invoke('Image.subtract', {
        image1: imageConstant(top),
        image2: degrees('y'),
      }),
    ),
    image2: imageConstant(BLOCKS_EDGE_PARTS - 1),
  });
  const edge = onGrid(
    invoke('Image.max', { image1: west, image2: south }),
    BLOCKS_EDGE_PARTS,
  );
  const tone = invoke('Image.subtract', {
    image1: imageConstant(1),
    image2: invoke('Image.multiply', {
      image1: edge,
      image2: imageConstant(1 - BLOCKS_EDGE_TONE),
    }),
  });
  return {
    values: {
      0: invoke('Image.multiply', { image1: picture, image2: tone }),
      ...stackValues,
      [refs.heights]: heightsNode,
      [refs.water]: water,
      [refs.level]: level,
      [refs.mean]: cellMean(reference(refs.heights)),
    },
    result: '0',
  };
}

/** Elevation's Blocks style cell for a mode, or null for any other layer or mode. */
export const blocksStyleOf = (layer, mode) =>
  layer?.id === BLOCKS_STYLE_LAYER ? blocksStyleCell(mode) : null;

/**
 * A layer variant's expression in an ink (and mode), as the REST API takes
 * it: {values: {0: <value node>, …}, result: '0'}.
 */
export function expressionFor(
  layer,
  variant = layerVariants(layer)[0],
  ink = layerInks(layer)[0],
  mode = layerModes(layer)[0],
  scale = null,
) {
  // Personal fork: a chosen colour scale (src/data/earthEngineScale.js).
  const window = windowFor(layer, scale);
  // Contour lines (Elevation contours) have their own expression: of the
  // DEM stack's heights for a `stack` variant, else of the variant's asset.
  if (layer.contour) {
    if (variant?.stack) return stackContourExpression(layer, variant);
    return contourExpression(
      assetNode(variant.asset),
      variant.step,
      layer.contour,
      { mosaic: Boolean(variant.asset?.collection) },
    );
  }
  // Elevation's Blocks style (a 'blocks-<cellM>' mode).
  const blocksCell = blocksStyleOf(layer, mode);
  if (blocksCell && variant?.stack)
    return blocksStyleExpression(layer, variant, blocksCell);
  // The terrain layers and Elevation: the DEM stack's band.
  if (variant?.stack) return demStackExpression(layer, variant, { window });
  // A band with an `overlay` (Buildings' footprints up close): the mode's
  // picture with a table's outlines in the ink on top.
  if (layer.kind !== 'features' && variant?.overlay)
    return overlayExpression(layer, variant, ink, mode, window);
  if (layer.kind !== 'features')
    return {
      values: { 0: imageNode(layer, variant, mode, window) },
      result: '0',
    };
  let node = assetNode(variant.asset);
  const filter = featureFilter(layer, variant, mode);
  if (filter) node = invoke('Collection.filter', { collection: node, filter });
  // Modes coloured per feature by a property (the Rivers'); a mode without
  // one (the Census tracts' outlines) is drawn in the ink.
  if (layer.modes?.length && modeRecord(layer, mode)?.property)
    return styledFeatures(layer, variant, node, ink, mode);
  const style = layer.style || {};
  node = invoke('Collection.style', {
    collection: node,
    color: constant(inkColor(layer, ink)),
    fillColor: constant(style.fillColor || '00000000'),
    width: constant(style.width ?? 1),
    // A simplified table's islands collapsed to points: drawn as nothing,
    // not as circles (Collection.style's default point).
    ...(Number.isFinite(variant?.pointSize)
      ? { pointSize: constant(variant.pointSize) }
      : {}),
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
  scale = null,
) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(mapRequestFor(layer, variant, ink, mode, scale)))
    .digest('hex')
    .slice(0, 12);
}

/**
 * The body of the request that makes a layer variant's map in an ink (and
 * mode, and a chosen colour scale: its window and stops become the
 * visualization, in the layer's drawn space).
 */
export function mapRequestFor(
  layer,
  variant,
  ink = layerInks(layer)[0],
  mode = layerModes(layer)[0],
  scale = null,
) {
  const body = {
    expression: expressionFor(layer, variant, ink, mode, scale),
    fileFormat: 'PNG',
  };
  const window = windowFor(layer, scale);
  const vis = variant?.overlay ? null : window || visFor(layer, mode);
  if (blocksStyleOf(layer, mode))
    // Already RGB: each band drawn as it is.
    body.visualizationOptions = { ranges: [{ min: 0, max: 255 }] };
  else if (layer.contour) {
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
 * itself (RS256, node:crypto); kept until a minute before it expires, and
 * renewed in the background in its last SIGN_IN_EARLY_MS. An exchange
 * that gets no answer, a 429 or 5xx, or a 200 whose body cannot be read
 * (a loaded machine times the read out) is tried again, SIGN_IN_ATTEMPTS
 * times with a doubling wait; a refused key (400, 401, 403) fails at once.
 * Every request waiting meanwhile shares the one exchange.
 * @param {{keyFile: string, fetchImpl?: typeof fetch, now?: () => number,
 *   scope?: string, readKey?: (file: string) => string, attempts?: number,
 *   backoffMs?: number, timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>}} options
 */
export function createServiceAccountAuth({
  keyFile,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  scope = EE_SCOPE,
  readKey = (file) => fs.readFileSync(file, 'utf8'),
  attempts = SIGN_IN_ATTEMPTS,
  backoffMs = SIGN_IN_BACKOFF_MS,
  timeoutMs = TILE_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let held = null;
  let inflight = null;

  /** One token exchange: the token, or an Error whose `retry` says whether to try again. */
  async function exchange() {
    let key;
    try {
      key = JSON.parse(readKey(keyFile));
    } catch {
      throw Object.assign(
        new Error('The Earth Engine key file is not readable JSON'),
        { retry: false },
      );
    }
    if (!key?.client_email || !key?.private_key)
      throw Object.assign(
        new Error('The Earth Engine key file is not a service-account key'),
        { retry: false },
      );
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
    let response;
    try {
      response = await fetchImpl(audience, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${base64url(signature)}`,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No answer (a timeout, a dropped connection): try again.
      throw Object.assign(
        new Error(
          `Earth Engine sign-in got no answer (${String(error?.message || error).slice(0, 120)})`,
        ),
        { retry: true },
      );
    }
    // The body is read on its own: a 200 whose body times out or arrives
    // broken is not a refusal, and is tried again.
    let body = null;
    let unreadable = '';
    try {
      body = await response.json();
    } catch (error) {
      unreadable = String(error?.message || error).slice(0, 120);
    }
    if (response.ok && body?.access_token) {
      held = {
        token: body.access_token,
        expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000,
      };
      return held.token;
    }
    if (response.ok)
      throw Object.assign(
        new Error(
          `Earth Engine sign-in answered ${response.status} without a token (${unreadable || 'no access_token'})`,
        ),
        { retry: true },
      );
    throw Object.assign(
      new Error(
        `Earth Engine sign-in failed (${response.status}${body?.error ? `: ${String(body.error_description || body.error).slice(0, 160)}` : ''})`,
      ),
      // A refused key (400, 401, 403) stays refused; the rest may pass.
      { retry: response.status === 429 || response.status >= 500 },
    );
  }

  /** The exchange, tried again after SIGN_IN_BACKOFF_MS (doubling) while it may pass. */
  async function fresh() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await exchange();
      } catch (error) {
        if (!error.retry || attempt >= attempts) throw error;
        console.warn(
          `[EarthEngine] sign-in attempt ${attempt} of ${attempts} failed, trying again: ${error.message}`,
        );
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  const refresh = () =>
    (inflight ||= fresh().finally(() => {
      inflight = null;
    }));

  return {
    async token() {
      if (held && now() < held.expiresAt) {
        // Close to its end, a new one is asked for while this one serves.
        if (now() > held.expiresAt - SIGN_IN_EARLY_MS)
          refresh().catch((error) =>
            console.warn('[EarthEngine] early sign-in failed:', error.message),
          );
        return held.token;
      }
      return refresh();
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
  valuesTimeoutMs = VALUES_TIMEOUT_MS,
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
    async createMap(
      layer,
      variant,
      ink = layerInks(layer)[0],
      mode = layerModes(layer)[0],
      scale = null,
    ) {
      const response = await authorized(
        `${EE_API}/projects/${encodeURIComponent(project)}/maps?fields=name`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mapRequestFor(layer, variant, ink, mode, scale)),
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
    /**
     * An expression's pixels over a grid, as NPY (image:computePixels): the
     * raster values service's numbers (server/providers/rasterValues/).
     * @returns {Promise<{status: number, body: Buffer|null, error?: string}>}
     */
    async computePixels(expression, grid) {
      let response;
      try {
        response = await authorized(
          `${EE_API}/projects/${encodeURIComponent(project)}/image:computePixels`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expression, fileFormat: 'NPY', grid }),
          },
          valuesTimeoutMs,
        );
      } catch (error) {
        // No answer in time (or a dropped connection): a 504, which the
        // service tries once more, not a thrown error (a route's 500).
        return {
          status: 504,
          body: null,
          error: `Earth Engine gave no answer (${String(error?.message || error).slice(0, 120)})`,
        };
      }
      if (!response.ok)
        return {
          status: response.status,
          body: null,
          error: await errorText(response),
        };
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_PIXELS_BYTES)
        return { status: 502, body: null, error: 'Pixels too large' };
      return { status: 200, body };
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

/**
 * The variant a tile at zoom z is drawn from: a variant's `coarse` table
 * (GAUL's 500 m simplified level1) for tiles at or below its `maxZoom`,
 * where 500 m is under a pixel, as a variant of its own (its own map, hash
 * and tile directory: "<key>-coarse"); else null.
 */
export function simplifiedVariant(variant, z) {
  const coarse = variant?.coarse;
  if (!coarse || !(z <= coarse.maxZoom)) return null;
  return Object.freeze({
    key: `${variant.key}-coarse`,
    asset: Object.freeze({ table: coarse.table }),
    ...(Number.isFinite(coarse.pointSize)
      ? { pointSize: coarse.pointSize }
      : {}),
  });
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
export function mapKey(layer, variant, ink, mode = 'default', scaleToken = '') {
  const base =
    mode === 'default'
      ? `${layer.id}/${variant.key}/${ink}`
      : `${layer.id}/${mode}/${variant.key}/${ink}`;
  // Personal fork: a chosen colour scale is its own map.
  return scaleToken ? `${base}|s=${scaleToken}` : base;
}

/** Maps made for chosen colour scales kept per session (the oldest go first). */
export const SCALED_MAPS_KEPT = 48;

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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

  /** Keys of maps made for chosen scales, oldest first (SCALED_MAPS_KEPT). */
  const scaled = [];
  function keepScaled(key) {
    const at = scaled.indexOf(key);
    if (at >= 0) scaled.splice(at, 1);
    scaled.push(key);
    while (scaled.length > SCALED_MAPS_KEPT) {
      const old = scaled.shift();
      maps.delete(old);
      hashes.delete(old);
    }
  }

  /** A (variant, ink[, mode][, scale])'s map, made again once old; the old one serves if that fails. */
  async function mapFor(
    layer,
    variant,
    ink,
    { force = false, mode = 'default', scale = null } = {},
  ) {
    const token = scale ? drawnScaleKey(scale) : '';
    const key = mapKey(layer, variant, ink, mode, token);
    if (token) keepScaled(key);
    const held = maps.get(key) || {};
    maps.set(key, held);
    if (!force && held.name && now() < held.expiresAt) return held;
    held.inflight ||= (async () => {
      try {
        const engine = backendNow();
        if (!engine) throw new Error(NEEDS_KEY);
        const { name } = scale
          ? await engine.createMap(layer, variant, ink, mode, scale)
          : mode === 'default'
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
  const tileFile = (
    layer,
    variant,
    ink,
    z,
    x,
    y,
    mode = 'default',
    scale = null,
  ) => {
    const key = mapKey(
      layer,
      variant,
      ink,
      mode,
      scale ? drawnScaleKey(scale) : '',
    );
    // A chosen scale's request hashes differently, so its tiles have a
    // directory of their own under the same layer, mode, variant and ink.
    if (!hashes.has(key))
      hashes.set(key, mapRequestHash(layer, variant, ink, mode, scale));
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
     * Personal fork: today's Earth Engine spend, read-only (GET /budget):
     * the day (UTC), the daily budget, the tiles fetched per layer and in
     * all, as countTile keeps them (disk hits are not counted). Nothing is
     * signed in or fetched to answer.
     */
    budget() {
      const today = usage();
      return {
        date: today.day,
        dailyTiles: settings().dailyTiles,
        used: today.byLayer,
        total: today.tiles,
        warnAt: [...BUDGET_WARNINGS],
      };
    },
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
    async tile(
      layerId,
      variantKey,
      ink,
      z,
      x,
      y,
      mode = 'default',
      scaleToken = '',
    ) {
      const layer = byId.get(layerId);
      let variant = layer
        ? variantKey === ZOOM_VARIANT && zoomMatched(layer)
          ? variantForZoom(layer, z)
          : layerVariants(layer).find((entry) => entry.key === variantKey)
        : null;
      if (!variant) return { status: 404, error: 'No such layer' };
      if (!layerInks(layer).includes(ink))
        return { status: 404, error: 'No such ink' };
      const blocksStyle = blocksStyleOf(layer, mode);
      if (!layerModes(layer).includes(mode) && !blocksStyle)
        return { status: 404, error: 'No such mode' };
      if (blocksStyle && scaleToken)
        return { status: 400, error: 'The Blocks style takes no colour scale' };
      // Personal fork: a chosen colour scale (the route's `s`, the shared
      // model's fields), resolved against this layer (mode)'s defaults.
      const modeKey = mode === 'default' ? '' : mode;
      if (scaleToken && !takesScale(layerId, modeKey))
        return { status: 400, error: 'This layer takes no colour scale' };
      const scale = scaleToken
        ? decodeScaleToken(layerId, modeKey, scaleToken)
        : null;
      if (scaleToken && !scale) return { status: 400, error: 'Bad scale' };
      const limit = 2 ** z;
      if (z > (layer.maxZoom ?? 12) || x >= limit || y >= limit)
        return { status: 400, error: 'Tile out of range' };
      // The Blocks style under its level's zoom band: blank, made here, no
      // Earth Engine request, nothing counted (src/data/blocksStyle.js).
      if (blocksStyle && z < blocksStyleZoomBand(blocksStyle).min)
        return {
          status: 200,
          contentType: 'image/png',
          body: TRANSPARENT_TILE,
          blank: true,
        };
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
      // Far out (GAUL's level1): the simplified table, faster and the same
      // to the pixel.
      variant = simplifiedVariant(variant, z) || variant;
      const file = tileFile(layer, variant, ink, z, x, y, mode, scale);
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
      let held = await mapFor(layer, variant, ink, { mode, scale });
      if (!held.name) return { status: 502, error: held.error || 'No map' };
      const engine = backendNow();
      countTile(layerId);
      let answer = await engine.fetchTile(held.name, z, x, y);
      // An expired map is made again, once.
      if ([400, 404].includes(answer.status)) {
        held = await mapFor(layer, variant, ink, { force: true, mode, scale });
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

    /**
     * An expression's pixels over a grid (NPY), counted against the day's
     * budget as one tile of the layer: the raster values service's.
     * @returns {Promise<{status: number, body?: Buffer, error?: string}>}
     */
    async computePixels(layerId, expression, grid) {
      const current = settings();
      if (!current.configured && !backend)
        return { status: 503, error: NEEDS_KEY };
      if (usage().tiles >= current.dailyTiles)
        return {
          status: 429,
          error: `The day's ${current.dailyTiles} Earth Engine tiles are used`,
        };
      const engine = backendNow();
      if (typeof engine?.computePixels !== 'function')
        return {
          status: 503,
          error: 'This Earth Engine backend has no computePixels',
        };
      // No answer (504, or a backend that throws): once more after
      // VALUES_RETRY_MS, each try counted; still none, a 503 to ask again
      // later (VALUES_RETRY_AFTER_S), never kept.
      let answer;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
          if (usage().tiles >= current.dailyTiles)
            return {
              status: 429,
              error: `The day's ${current.dailyTiles} Earth Engine tiles are used`,
            };
          await sleep(VALUES_RETRY_MS);
        }
        countTile(layerId);
        try {
          answer = await engine.computePixels(expression, grid);
        } catch (error) {
          answer = {
            status: 504,
            error: `Earth Engine gave no answer (${String(error?.message || error).slice(0, 120)})`,
          };
        }
        if (answer.status !== 504) break;
      }
      if (answer.status === 504)
        return {
          status: 503,
          error: `${answer.error}; ask again later`,
          retryAfterS: VALUES_RETRY_AFTER_S,
        };
      if (answer.status !== 200 || !answer.body)
        return {
          status: answer.status === 200 ? 502 : answer.status,
          error: answer.error,
        };
      return { status: 200, body: answer.body };
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
      // Personal fork: today's tiles against the budget (read-only).
      if (route === '/budget' && typeof service.budget === 'function')
        return sendJson(res, 200, await service.budget());
      const plain = TILE_PATH.exec(route);
      const moded = plain ? null : MODE_TILE_PATH.exec(route);
      if (plain || moded) {
        const [layer, mode, variant, ink, z, x, y] = plain
          ? [plain[1], 'default', ...plain.slice(2)]
          : moded.slice(1);
        // Personal fork: `s`, a chosen colour scale's token.
        const scaleToken =
          new URL(req.url || '/', 'http://localhost').searchParams.get('s') ||
          '';
        const answer = await service.tile(
          layer,
          variant,
          ink,
          Number(z),
          Number(x),
          Number(y),
          ...(scaleToken
            ? [mode, scaleToken]
            : mode === 'default'
              ? []
              : [mode]),
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

/** The route's service, made when first asked for: raster values count against its budget too. */
export function sharedEarthEngineService(sourceRoot = defaultSourceRoot) {
  shared ||= createEarthEngineService({ sourceRoot });
  return shared;
}

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
