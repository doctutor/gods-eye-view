// Personal fork: the raster values of the Earth Engine image layers (the
// DEM stack's heights first), from image:computePixels, for
// server/providers/rasterValues.js. Not part of upstream God's Eye View.
import crypto from 'node:crypto';
import {
  layerModes,
  layerVariants,
  modeRecord,
} from '../../../src/data/earthEngineLayers.js';
import {
  VALID_HEIGHT_M,
  DEM_BANDS,
  demBand,
  sourceNamesAt,
  sourcesInRect,
  tilePixelM,
} from '../../../src/data/demStack.js';
import { windowGrid } from '../../../src/data/rasterValues.js';
import {
  WATER_NATIVE_M,
  expressionFor,
  visFor,
  waterImage,
} from '../earthEngine.js';

/**
 * What each layer's numbers are: units, how a coarse cell is made from the
 * fine ones (the asset's pyramid: Earth Engine reads the level nearest the
 * cell, and a categorical image's pyramid is MODE), and the source's name.
 * Units and source may differ by mode. `reduce: 'mean'`: a cell coarser
 * than the source's own (MEAN_ABOVE ×) is the mean over it, reduced in
 * Earth Engine (meanExpression), not a pixel of the nearest pyramid level
 * (the Blocks pyramid's coarse levels: a 30 km block over the Rockies is
 * their mean height). Layers not here have no values (hillshade is
 * shading, not a quantity; the vector layers are lines).
 */
export const EE_VALUE_LAYERS = Object.freeze({
  // Fill values masked in each source before any resampling or mean
  // (VALID_HEIGHT_M), so a cell is the mean of real heights only.
  'ee-elevation': {
    units: 'm',
    aggregation: 'mean',
    reduce: 'mean',
    validRange: VALID_HEIGHT_M,
    // A sampled cell without heights (the sea, masked in every source) is
    // 0 m: water at level 0, as a reduced cell under half land.
    seaIsWater: true,
    // The water plane (?water=1): the share of each cell that is water,
    // from MODIS MOD44W (waterExpression), for the Blocks lakes.
    planes: ['water'],
  },
  'ee-terrain-slope': { units: '°', aggregation: 'mean' },
  // Computed per cell from the heights at the cell's scale: a mean of
  // compass bearings would mean nothing.
  'ee-terrain-aspect': { units: '°', aggregation: 'sample' },
  'ee-population': {
    units: 'people/km²',
    aggregation: 'mean',
    source: (mode) => `GHSL P2023A ${mode.replace(/^density-/, '')}`,
  },
  'ee-surface-water': {
    units: { occurrence: '%', change: '%', seasonality: 'months' },
    aggregation: 'mean',
    source: 'JRC Global Surface Water 1.4',
  },
  'ee-tree-canopy': {
    units: 'm',
    aggregation: 'mean',
    source: (mode) =>
      mode === 'eth'
        ? 'ETH Global Canopy Height 2020 10 m'
        : 'Meta and WRI canopy height 1 m',
  },
  'ee-buildings': {
    units: { count: 'buildings/km²', cover: 'fraction', height: 'm' },
    aggregation: 'mean',
    source: 'Google Open Buildings 2.5D Temporal 2023',
  },
  // Class indices, as the legend lists them (1 natural, 2 primary, 3 planted).
  'ee-forest-types': {
    units: 'class',
    aggregation: 'mode',
    source: 'JRC Global Forest Types 2020',
  },
  // Class indices into LAND_COVER_CLASSES (0 tree cover … 10 moss and lichen).
  'ee-land-cover': {
    units: 'class',
    aggregation: 'mode',
    source: (mode) =>
      mode === 'v100' ? 'ESA WorldCover 2020' : 'ESA WorldCover 2021',
  },
  // 1 to 25: the year of loss, 2001 to 2025.
  'ee-forest-loss': {
    units: 'years since 2000',
    aggregation: 'mode',
    source: 'Hansen Global Forest Change',
  },
  'ee-inundation': {
    units: { count: 'count', duration: 'days' },
    aggregation: 'mean',
    source: 'Global Flood Database v1',
  },
});

/** A cell this many times the source's own or coarser is reduced (`reduce`). */
export const MEAN_ABOVE = 1.5;
/**
 * The most input pixels a reduced cell combines: past it Earth Engine
 * reads a coarser pyramid level (bestEffort), so a 30 km cell is the mean
 * of 16 × 16 pixels of about 1.9 km, each itself a mean.
 */
export const MEAN_MAX_PIXELS = 256;

const constant = (value) => ({ constantValue: value });
const invoke = (functionName, args) => ({
  functionInvocationValue: { functionName, arguments: args },
});
const unmasked = (image, name) =>
  invoke('Image.rename', {
    input: invoke('Image.unmask', {
      input: invoke('Image.toFloat', { value: image }),
      value: invoke('Image.constant', { value: constant(0) }),
      sameFootprint: constant(false),
    }),
    names: constant([name]),
  });

/**
 * A layer's picture as numbers: two float bands, `v` the value (0 where
 * masked) and `m` its mask, so nodata is exact (a sentinel could be a
 * value).
 */
export function valuesExpression(base) {
  const image = { valueReference: base.result };
  return {
    values: {
      ...base.values,
      rv: invoke('Image.addBands', {
        dstImg: unmasked(image, 'v'),
        srcImg: unmasked(invoke('Image.mask', { image }), 'm'),
      }),
    },
    result: 'rv',
  };
}

/**
 * A sampled cell's heights with every masked pixel 0 m (the sea is masked
 * in every source, so it reads as water at level 0, never nodata): the
 * sampled path's rule, as meanExpression's is the reduced path's.
 */
export function seaExpression(base) {
  return {
    values: {
      ...base.values,
      sz: invoke('Image.unmask', {
        input: { valueReference: base.result },
        value: invoke('Image.constant', { value: constant(0) }),
        sameFootprint: constant(false),
      }),
    },
    result: 'sz',
  };
}

/** A reduced cell is water when less than this share of it has heights. */
export const LAND_SHARE = 0.5;

/**
 * The mean over each cell of the request's grid: the image given its
 * source's cell as a default projection (a mosaic's is 1°), then
 * reduceResolution with a mean, in the projection the request asks for
 * (computePixels' grid). The sea is masked in every source, so a cell
 * less than LAND_SHARE of whose pixels have heights, or whose mean is at
 * or below 0 m, is water: 0 m, never nodata (the Blocks style's rule), so
 * the Blocks sea is one water surface at level 0.
 */
export function meanExpression(base, nativeM) {
  const reduced = (image) =>
    invoke('Image.reduceResolution', {
      image: invoke('Image.setDefaultProjection', {
        image,
        crs: invoke('Projection', { crs: constant('EPSG:4326') }),
        scale: constant(nativeM),
      }),
      reducer: invoke('Reducer.mean', {}),
      bestEffort: constant(true),
      maxPixels: constant(MEAN_MAX_PIXELS),
    });
  const zero = invoke('Image.constant', { value: constant(0) });
  const mean = { valueReference: 'mh' };
  // 1 where a cell is water: mostly without heights, or a mean ≤ 0 m.
  const water = invoke('Image.max', {
    image1: invoke('Image.lt', {
      image1: reduced(
        invoke('Image.unmask', {
          input: invoke('Image.mask', {
            image: { valueReference: base.result },
          }),
          value: zero,
          sameFootprint: constant(false),
        }),
      ),
      image2: invoke('Image.constant', { value: constant(LAND_SHARE) }),
    }),
    image2: invoke('Image.unmask', {
      input: invoke('Image.lte', { image1: mean, image2: zero }),
      value: invoke('Image.constant', { value: constant(1) }),
      sameFootprint: constant(false),
    }),
  });
  return {
    values: {
      ...base.values,
      mh: reduced({ valueReference: base.result }),
      mn: invoke('Image.where', {
        input: invoke('Image.unmask', {
          input: mean,
          value: zero,
          sameFootprint: constant(false),
        }),
        test: water,
        value: zero,
      }),
    },
    result: 'mn',
  };
}

/**
 * The most input pixels a reduced cell's water share combines: 4 × 4, so
 * Earth Engine reads a coarser level of MOD44W's pyramid (its 0/1 mask is
 * valid over land, so a coarse pixel is still the share of water). At
 * MEAN_MAX_PIXELS a fresh 1,920 m lattice tile read about 60 pixels of
 * 250 m a cell, reprojected from MODIS's sinusoidal grid, and took 102 s
 * against 40 s for the heights alone.
 */
export const WATER_MAX_PIXELS = 16;

/**
 * The water plane as band `w`: earthEngine.js waterImage, MODIS MOD44W's
 * land-water mask, 1 water and 0 land;
 * `reduced`, the mean over each cell, as the heights' (meanExpression), so
 * a cell's value is the share of it that is water. Never masked.
 */
export function waterExpression(reduced) {
  const zero = invoke('Image.constant', { value: constant(0) });
  const unmaskZero = (input) =>
    invoke('Image.unmask', {
      input,
      value: zero,
      sameFootprint: constant(false),
    });
  const wet = waterImage();
  const share = reduced
    ? unmaskZero(
        invoke('Image.reduceResolution', {
          image: invoke('Image.setDefaultProjection', {
            image: wet,
            crs: invoke('Projection', { crs: constant('EPSG:4326') }),
            scale: constant(WATER_NATIVE_M),
          }),
          reducer: invoke('Reducer.mean', {}),
          bestEffort: constant(true),
          maxPixels: constant(WATER_MAX_PIXELS),
        }),
      )
    : wet;
  return invoke('Image.rename', { input: share, names: constant(['w']) });
}

/** A values expression (valuesExpression's) with the water plane's band added. */
export function withWater(values, reduced) {
  return {
    values: {
      ...values.values,
      rw: invoke('Image.addBands', {
        dstImg: { valueReference: values.result },
        srcImg: waterExpression(reduced),
      }),
    },
    result: 'rw',
  };
}

/**
 * The layer without what only colours it: Elevation's √, the log10 ramps
 * and the `atLeast` floors below which a map is clear (Population under 1
 * per km² is a number, 0 in a field, not nodata).
 */
export function valuesLayer(layer) {
  const without = (record, keys) => {
    const copy = { ...record };
    for (const key of keys) delete copy[key];
    return copy;
  };
  const plain = without(layer, ['transform', 'log10', 'atLeast']);
  if (layer.modes)
    plain.modes = layer.modes.map((mode) =>
      without(mode, ['log10', 'atLeast']),
    );
  return plain;
}

/** The layer's display range in the values' units: [legendMin, legendMax]. */
export function legendRange(layer, mode) {
  const vis = visFor(layer, mode);
  if (!vis) return [null, null];
  const record = layer.modes?.length ? modeRecord(layer, mode) : null;
  if (record?.log10 ?? layer.log10) return [10 ** vis.min, 10 ** vis.max];
  if (layer.transform === 'sqrt') return [vis.min ** 2, vis.max ** 2];
  return [vis.min, vis.max];
}

/**
 * The band a cell size reads: the one a map tile of that pixel size would
 * draw (the DEM stack's by zoom); never a band drawn over a table's
 * outlines (Buildings' footprints).
 */
export function valuesVariant(layer, z) {
  const variants = layerVariants(layer).filter((entry) => !entry.overlay);
  if (!variants.every((entry) => Array.isArray(entry.zooms)))
    return variants[0];
  return (
    variants.find((entry) => z >= entry.zooms[0] && z <= entry.zooms[1]) ||
    (z < variants[0].zooms[0] ? variants[0] : variants[variants.length - 1])
  );
}

/** The zoom whose tile pixel is a cell's size at a latitude. */
export const zoomForCell = (cellSizeM, lat) =>
  Math.log2(tilePixelM(0, lat) / Math.max(cellSizeM, 1e-3));

const isStack = (layer) =>
  layerVariants(layer).some((entry) => Boolean(entry.stack));

/**
 * The finest cell the DEM stack has in a window (3DEP 1 m in the US, 2 m
 * ArcticDEM, else FABDEM's 30 m): values are never asked finer.
 */
export function stackNativeM(box, heights) {
  const finest = DEM_BANDS[DEM_BANDS.length - 1];
  const sizes = sourcesInRect(box, finest, { heights })
    .map((entry) => entry.pixelM)
    .filter((size) => size > 0);
  return sizes.length ? Math.min(...sizes) : 0;
}

/** One cell's centre-to-edge grid for computePixels: EPSG:4326, north row first. */
export function pixelGrid({ west, south, east, north }, cols, rows) {
  return {
    dimensions: { width: cols, height: rows },
    affineTransform: {
      scaleX: (east - west) / cols,
      shearX: 0,
      translateX: west,
      shearY: 0,
      scaleY: -(north - south) / rows,
      translateY: north,
    },
    crsCode: 'EPSG:4326',
  };
}

const NPY_TYPES = {
  f4: (view, at, little) => view.getFloat32(at, little),
  f8: (view, at, little) => view.getFloat64(at, little),
  i1: (view, at) => view.getInt8(at),
  u1: (view, at) => view.getUint8(at),
  i2: (view, at, little) => view.getInt16(at, little),
  u2: (view, at, little) => view.getUint16(at, little),
  i4: (view, at, little) => view.getInt32(at, little),
  u4: (view, at, little) => view.getUint32(at, little),
};

/**
 * Read computePixels' NPY (a structured array, one field per band) into
 * Float32Arrays by band name.
 * @returns {{rows: number, cols: number, bands: Record<string, Float32Array>}}
 */
export function readNpy(buf) {
  const bytes =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, buf.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(1, 6));
  if (bytes[0] !== 0x93 || magic !== 'NUMPY') throw new Error('Not NPY');
  const major = bytes[6];
  const headerAt = major >= 2 ? 12 : 10;
  const headerLength =
    major >= 2 ? view.getUint32(8, true) : view.getUint16(8, true);
  const header = new TextDecoder('latin1').decode(
    bytes.subarray(headerAt, headerAt + headerLength),
  );
  if (/'fortran_order':\s*True/.test(header))
    throw new Error('NPY in Fortran order');
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!shape) throw new Error('NPY shape is not 2-D');
  const rows = Number(shape[1]);
  const cols = Number(shape[2]);
  const fields = [];
  let stride = 0;
  for (const [, name, order, kind, size] of header.matchAll(
    /\('([^']+)',\s*'([<>|=]?)([fiu])(\d)'\)/g,
  )) {
    const read = NPY_TYPES[`${kind}${size}`];
    if (!read) throw new Error(`NPY type ${kind}${size}`);
    fields.push({ name, read, little: order !== '>', offset: stride });
    stride += Number(size);
  }
  if (!fields.length) throw new Error('NPY without fields');
  const start = headerAt + headerLength;
  if (start + stride * rows * cols > bytes.byteLength)
    throw new Error('NPY shorter than its shape');
  const bands = {};
  for (const field of fields) {
    const out = new Float32Array(rows * cols);
    for (
      let i = 0, at = start + field.offset;
      i < out.length;
      i++, at += stride
    )
      out[i] = field.read(view, at, field.little);
    bands[field.name] = out;
  }
  return { rows, cols, bands };
}

/** The source's cell when the stack says none, metres (FABDEM's). */
const DEFAULT_NATIVE_M = 30;
/** Answers that sampling would meet too: the day's budget, the setup. */
const NOT_RETRIED = new Set([429, 503]);

const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);

/**
 * An Earth Engine layer's adapter: plan(mode, box, cells) says what the
 * answer will be (grid, version, units…) and how to compute it.
 * @param {object} layer the record (src/data/earthEngineLayers.js)
 * @param {{computePixels: Function}} earthEngine the Earth Engine service
 */
export function createEarthEngineAdapter(layer, earthEngine) {
  const spec = EE_VALUE_LAYERS[layer.id];
  const modes = layerModes(layer);
  const plain = spec.validRange
    ? { ...valuesLayer(layer), validRange: spec.validRange }
    : valuesLayer(layer);
  const stack = isStack(layer);
  const pick = (value, mode) =>
    typeof value === 'function'
      ? value(mode)
      : value && typeof value === 'object'
        ? value[mode]
        : value;
  return {
    id: layer.id,
    modes: modes[0] === 'default' ? [''] : modes,
    planes: spec.planes || [],
    /** `water`: the water plane too, in the same request (withWater). */
    plan(mode, box, cells, { water = false } = {}) {
      const modeKey = mode || modes[0];
      const lat = (box.south + box.north) / 2;
      const lon = (box.west + box.east) / 2;
      const heights = layerVariants(layer).some((entry) => entry.heights);
      const nativeM = stack ? stackNativeM(box, heights) : 0;
      const { cols, rows, cellSizeM } = windowGrid(box, cells, nativeM);
      const z = Math.max(
        0,
        Math.min(layer.maxZoom ?? 14, Math.round(zoomForCell(cellSizeM, lat))),
      );
      const variant = valuesVariant(plain, z);
      const picture = expressionFor(plain, variant, undefined, modeKey);
      const ownM = nativeM || DEFAULT_NATIVE_M;
      const reduced = spec.reduce === 'mean' && cellSizeM >= MEAN_ABOVE * ownM;
      const plane = (values, isReduced) =>
        water ? withWater(values, isReduced) : values;
      // The heights alone (no water plane): a refused plane's stand-in.
      const drySampled = valuesExpression(
        spec.seaIsWater ? seaExpression(picture) : picture,
      );
      const dry = reduced
        ? valuesExpression(meanExpression(picture, ownM))
        : drySampled;
      const sampled = plane(drySampled, false);
      const expression = plane(dry, reduced);
      const units = pick(spec.units, modeKey);
      let source = pick(spec.source, modeKey);
      if (variant.stack) {
        const names = sourceNamesAt(lat, lon, demBand(variant.stack), {
          heights,
        });
        source = names.fallback
          ? `${names.name} (else ${names.fallback})`
          : names.name || 'DEM stack';
      }
      const [legendMin, legendMax] = legendRange(layer, modeKey);
      const grid = pixelGrid(box, cols, rows);
      return {
        mode: modes[0] === 'default' ? '' : modeKey,
        version: hash({ expression, units, schema: 1 }),
        cols,
        rows,
        cellSizeM,
        units,
        aggregation: reduced ? 'mean' : spec.aggregation,
        source,
        legendMin,
        legendMax,
        ...(variant.stack ? { band: variant.stack } : {}),
        async run() {
          const pixels = async (request, wet = water) => {
            const answer = await earthEngine.computePixels(
              layer.id,
              request,
              grid,
            );
            if (answer.status !== 200) return answer;
            const { rows: r, cols: c, bands } = readNpy(answer.body);
            if (
              r !== rows ||
              c !== cols ||
              !bands.v ||
              !bands.m ||
              (wet && !bands.w)
            )
              return {
                status: 502,
                error: 'Earth Engine answered another grid',
              };
            const values = bands.v;
            for (let i = 0; i < values.length; i++)
              if (!(bands.m[i] > 0)) values[i] = NaN;
            return {
              status: 200,
              values,
              ...(wet ? { water: bands.w } : {}),
            };
          };
          const answer = await pixels(expression);
          if (answer.status === 200 || NOT_RETRIED.has(answer.status))
            return answer;
          // The water plane's source refused (an asset gone, a band
          // renamed): the heights alone this once, said so and not kept,
          // so Blocks still draws (without lakes).
          if (water) {
            console.warn(
              `[RasterValues] ${layer.id}: the water plane failed (${answer.status}: ${answer.error}); heights alone instead`,
            );
            const bare = await pixels(dry, false);
            if (bare.status === 200) return { ...bare, keep: false };
            if (!reduced || NOT_RETRIED.has(bare.status)) return bare;
          }
          // A reduction Earth Engine refused (not the budget, not the
          // setup): the sampled cells this once, said so and not kept.
          if (!reduced) return answer;
          console.warn(
            `[RasterValues] ${layer.id}: the mean failed (${answer.status}: ${answer.error}); sampled instead`,
          );
          const fallback = water
            ? await pixels(drySampled, false)
            : await pixels(sampled);
          return fallback.status === 200
            ? { ...fallback, aggregation: 'sample', keep: false }
            : fallback;
        },
      };
    },
  };
}
