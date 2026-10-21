/**
 * Personal fork: colour scales for every layer that paints a value through
 * a ramp (rasters, hex choropleths, grids). A scale is a palette, a window
 * (floor and ceiling, as in window/level: the ramp stretched between them,
 * values below painted the floor's colour and above the ceiling's, or
 * hidden), a linear or log mapping and an inversion:
 *
 *   { palette, floor, ceiling, scale: 'linear'|'log'|'sqrt', invert,
 *     outside: 'clamp'|'hide' }
 *
 * `floor` and `ceiling` are null for the layer's automatic range (its data
 * domain), else numbers in the layer's units. Each layer declares its
 * defaults (`defineScaleDefaults`): its own ramp as the 'default' palette,
 * its usual mapping, its units. Until a user changes something the scale
 * is the default and the layer paints exactly as before.
 *
 * Kept per layer and mode ("scale key": `wikipedia-coverage:capita`) in
 * localStorage (gev.colourScale.<key>) and in the share hash (`cs`, the
 * layer-options `lo` grammar: `_` between entries, `.` between fields);
 * a hash read at startup wins over storage (the store, in
 * colourScaleStore.js). Pure: no DOM, no Cesium, no browser globals.
 */

import { msg } from '../i18n/marker.js';

/** '#rrggbb' list → [r, g, b] stops. */
const stops = (...hexes) =>
  Object.freeze(
    hexes.map((hex) =>
      Object.freeze([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))),
    ),
  );

const palette = (id, code, label, kind, stopList) =>
  Object.freeze({ id, code, label, kind, stops: stopList });

/**
 * The palette catalog. 'default' is the layer's own ramp (declared by the
 * layer); the rest are fixed: the matplotlib perceptual ramps (viridis,
 * inferno, magma, plasma, cividis), Google's turbo, and the ones a
 * nuclear-medicine reader knows: grey, hot iron (black, red, yellow,
 * white) and the PET "rainbow" (black, purple, blue, green, yellow, red,
 * white); and a blue–white–red diverging ramp.
 */
export const PALETTES = Object.freeze([
  palette('default', 'd', msg('Layer default'), 'default', null),
  palette(
    'viridis',
    'v',
    msg('Viridis'),
    'sequential',
    stops(
      '440154',
      '482878',
      '3e4989',
      '31688e',
      '26828e',
      '1f9e89',
      '35b779',
      '6ece58',
      'b5de2b',
      'fde725',
    ),
  ),
  palette(
    'inferno',
    'i',
    msg('Inferno'),
    'sequential',
    stops(
      '000004',
      '1b0c41',
      '4a0c6b',
      '781c6d',
      'a52c60',
      'cf4446',
      'ed6925',
      'fb9b06',
      'f7d13d',
      'fcffa4',
    ),
  ),
  palette(
    'magma',
    'm',
    msg('Magma'),
    'sequential',
    stops(
      '000004',
      '180f3d',
      '440f76',
      '721f81',
      '9e2f7f',
      'cd4071',
      'f1605d',
      'fd9668',
      'feca8d',
      'fcfdbf',
    ),
  ),
  palette(
    'plasma',
    'p',
    msg('Plasma'),
    'sequential',
    stops(
      '0d0887',
      '46039f',
      '7201a8',
      '9c179e',
      'bd3786',
      'd8576b',
      'ed7953',
      'fb9f3a',
      'fdca26',
      'f0f921',
    ),
  ),
  palette(
    'cividis',
    'c',
    msg('Cividis'),
    'sequential',
    stops(
      '00224e',
      '123570',
      '3b496c',
      '575d6d',
      '707173',
      '8a8779',
      'a69d75',
      'c4b56c',
      'e4cf5b',
      'fee838',
    ),
  ),
  palette(
    'turbo',
    't',
    msg('Turbo'),
    'rainbow',
    stops(
      '30123b',
      '4145ab',
      '4675ed',
      '39a2fc',
      '1bcfd4',
      '24eca6',
      '61fc6c',
      'a4fc3b',
      'd1e834',
      'f3c63a',
      'fe9b2d',
      'f36315',
      'd93806',
      'b11901',
      '7a0403',
    ),
  ),
  palette('grey', 'g', msg('Grey'), 'clinical', stops('000000', 'ffffff')),
  palette(
    'hot-iron',
    'h',
    msg('Hot iron'),
    'clinical',
    stops(
      '000000',
      '550000',
      'aa0000',
      'ff0000',
      'ff5500',
      'ffaa00',
      'ffff00',
      'ffff80',
      'ffffff',
    ),
  ),
  palette(
    'pet',
    'r',
    msg('PET rainbow'),
    'clinical',
    stops(
      '000000',
      '3c0050',
      '5a00a0',
      '0000ff',
      '0080ff',
      '00c0c0',
      '00c000',
      'ffff00',
      'ff8000',
      'ff0000',
      'ffffff',
    ),
  ),
  palette(
    'blue-white-red',
    'b',
    msg('Blue–white–red'),
    'diverging',
    stops('2166ac', '67a9cf', 'd1e5f0', 'f7f7f7', 'fddbc7', 'ef8a62', 'b2182b'),
  ),
]);
export const PALETTE_IDS = Object.freeze(PALETTES.map((entry) => entry.id));
const BY_ID = new Map(PALETTES.map((entry) => [entry.id, entry]));
const BY_CODE = new Map(PALETTES.map((entry) => [entry.code, entry]));
/** A palette by id, or null. */
export const paletteById = (id) => BY_ID.get(id) || null;

/** Mappings: linear, log, and square root (Elevation's own default). */
export const SCALES = Object.freeze(['linear', 'log', 'sqrt']);
export const OUTSIDE = Object.freeze(['clamp', 'hide']);

/** [r, g, b] stops sampled at t (0 to 1), linear between neighbours. */
export function samplePalette(stopList, t) {
  if (!stopList?.length) return [0, 0, 0];
  if (!Number.isFinite(t)) return [...stopList[0]];
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stopList.length - 1);
  const index = Math.min(stopList.length - 2, Math.floor(scaled));
  if (stopList.length === 1) return [...stopList[0]];
  const frac = scaled - index;
  const a = stopList[index];
  const b = stopList[index + 1];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * frac));
}

/** [r, g, b] from '#rrggbb' or 'rrggbb' (an array passes through). */
const toRgb = (stop) =>
  Array.isArray(stop)
    ? stop.slice(0, 3)
    : [0, 2, 4].map((k) =>
        parseInt(
          String(stop)
            .replace(/^#/, '')
            .slice(k, k + 2),
          16,
        ),
      );

/**
 * A layer's scale defaults: what 'default' means for it.
 * - `colourAt(t)`: its own ramp as [r, g, b, a] (0–255) at 0 to 1, how it
 *   painted before colour scales, alpha included; else made from `stops`
 *   (opaque).
 * - `stops`: its ramp low → high, '#rrggbb' or [r, g, b] (previews, and the
 *   server-drawn layers' palette).
 * - `range` {min, max}: its fixed window in its units, for a layer whose
 *   window does not come from its data (the Earth Engine layers' vis
 *   min/max); a layer with a data domain passes it as `auto` instead.
 * - `units`, `format(value)`: for the legend and the inputs.
 * @param {{scale?: 'linear'|'log'|'sqrt', units?: string,
 *   outside?: 'clamp'|'hide', colourAt?: (t: number) => number[],
 *   stops?: Array<string|number[]>, range?: {min: number, max: number},
 *   format?: (value: number) => string}} input
 */
export function defineScaleDefaults({
  scale = 'linear',
  units = '',
  outside = 'clamp',
  colourAt = null,
  stops: stopList = null,
  range = null,
  format = formatScaleValue,
}) {
  const rgbStops = stopList ? Object.freeze(stopList.map(toRgb)) : null;
  const ownColour =
    typeof colourAt === 'function'
      ? colourAt
      : rgbStops
        ? (t) => [...samplePalette(rgbStops, t), 255]
        : null;
  if (!ownColour)
    throw new TypeError('A layer scale needs its own colourAt(t) or stops');
  return Object.freeze({
    model: Object.freeze({
      palette: 'default',
      floor: null,
      ceiling: null,
      scale: SCALES.includes(scale) ? scale : 'linear',
      invert: false,
      outside: OUTSIDE.includes(outside) ? outside : 'clamp',
    }),
    units,
    colourAt: ownColour,
    stops:
      rgbStops ||
      Object.freeze(
        Array.from({ length: 9 }, (_, i) => ownColour(i / 8).slice(0, 3)),
      ),
    range:
      range && Number.isFinite(range.min) && Number.isFinite(range.max)
        ? Object.freeze({ min: range.min, max: range.max })
        : null,
    format,
  });
}

/**
 * A scale's palette as '#rrggbb' stops, low → high (not inverted): the
 * layer's own for 'default'. What a server-drawn layer sends its renderer.
 */
export function paletteStopsHex(model, defaults) {
  const list =
    model.palette === 'default'
      ? defaults.stops
      : paletteById(model.palette)?.stops || defaults.stops;
  return list.map(rgbHex);
}

const finiteOrNull = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;

/**
 * A scale checked against a layer's defaults: unknown or invalid fields
 * take the default's; a floor at or above the ceiling, or a log window
 * reaching zero, drops both ends back to automatic.
 */
export function normalizeScale(input, defaults) {
  const base = defaults.model;
  const out = {
    palette: PALETTE_IDS.includes(input?.palette)
      ? input.palette
      : base.palette,
    floor: finiteOrNull(input?.floor),
    ceiling: finiteOrNull(input?.ceiling),
    scale: SCALES.includes(input?.scale) ? input.scale : base.scale,
    invert: typeof input?.invert === 'boolean' ? input.invert : base.invert,
    outside: OUTSIDE.includes(input?.outside) ? input.outside : base.outside,
  };
  if (out.scale === 'log') {
    if (out.floor !== null && !(out.floor > 0)) out.floor = null;
    if (out.ceiling !== null && !(out.ceiling > 0)) out.ceiling = null;
  }
  if (out.scale === 'sqrt') {
    if (out.floor !== null && !(out.floor >= 0)) out.floor = null;
    if (out.ceiling !== null && !(out.ceiling > 0)) out.ceiling = null;
  }
  if (
    out.floor !== null &&
    out.ceiling !== null &&
    !(out.floor < out.ceiling)
  ) {
    out.floor = null;
    out.ceiling = null;
  }
  return Object.freeze(out);
}

/** Whether a scale is its layer's default (paints as the layer always did). */
export function isDefaultScale(model, defaults) {
  const base = defaults.model;
  return (
    model.palette === base.palette &&
    model.floor === null &&
    model.ceiling === null &&
    model.scale === base.scale &&
    model.invert === base.invert &&
    model.outside === base.outside
  );
}

/**
 * The window in force: the scale's floor and ceiling, each else the
 * automatic range's (`auto` {min, max}); null when there is none.
 */
export function resolveWindow(model, auto) {
  let floor = model.floor ?? auto?.min;
  let ceiling = model.ceiling ?? auto?.max;
  if (model.scale === 'sqrt' && Number.isFinite(floor))
    floor = Math.max(0, floor);
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) return null;
  // A floor set above the automatic ceiling (or the reverse): the set end wins.
  if (!(floor < ceiling)) {
    if (model.floor !== null && model.ceiling === null)
      ceiling =
        floor * (model.scale === 'log' ? 10 : 1) +
        (model.scale === 'log' ? 0 : 1);
    else if (model.ceiling !== null && model.floor === null)
      floor = model.scale === 'log' ? ceiling / 10 : ceiling - 1;
    else return null;
  }
  if (model.scale === 'log' && !(floor > 0)) return null;
  return { floor, ceiling };
}

/**
 * Where a value sits on the scale, 0 to 1 (inverted when asked), or NaN
 * when it paints nothing: no value, zero or less on a log scale, or
 * outside the window when `outside` is 'hide'.
 */
export function scalePosition(model, value, auto) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return NaN;
  const window = resolveWindow(model, auto);
  if (!window) return NaN;
  const { floor, ceiling } = window;
  let t;
  if (model.scale === 'log') {
    if (!(value > 0)) return NaN;
    t =
      (Math.log(value) - Math.log(floor)) /
      (Math.log(ceiling) - Math.log(floor));
  } else if (model.scale === 'sqrt') {
    const root = Math.sqrt(Math.max(0, value));
    t = (root - Math.sqrt(floor)) / (Math.sqrt(ceiling) - Math.sqrt(floor));
  } else t = (value - floor) / (ceiling - floor);
  if (t < 0 || t > 1) {
    if (model.outside === 'hide') return NaN;
    t = t < 0 ? 0 : 1;
  }
  return model.invert ? 1 - t : t;
}

/** The colour at a position: [r, g, b, a] (0–255); transparent for NaN. */
export function colourAtPosition(model, defaults, t) {
  if (!Number.isFinite(t)) return [0, 0, 0, 0];
  if (model.palette === 'default') return defaults.colourAt(t);
  return [...samplePalette(paletteById(model.palette).stops, t), 255];
}

/** A value's colour on a scale: [r, g, b, a] (0–255), transparent for none. */
export function scaleColour(model, defaults, value, auto) {
  return colourAtPosition(model, defaults, scalePosition(model, value, auto));
}

/**
 * A painter for many values at once: positions quantised to `steps`
 * colours looked up in a table (fast enough for a 256 × 256 tile).
 * Returns {colourOf(value) → [r, g, b, a], paint(values, out) → painted}.
 */
export function createScalePainter(model, defaults, auto, steps = 256) {
  const lut = new Array(steps);
  for (let i = 0; i < steps; i++)
    lut[i] = colourAtPosition(model, defaults, i / (steps - 1));
  const colourOf = (value) => {
    const t = scalePosition(model, value, auto);
    return Number.isFinite(t) ? lut[Math.round(t * (steps - 1))] : null;
  };
  return {
    colourOf: (value) => colourOf(value) || [0, 0, 0, 0],
    /** Paint values into RGBA bytes; returns how many pixels were painted. */
    paint(values, out) {
      if (out.length < values.length * 4)
        throw new RangeError('out is too small');
      let painted = 0;
      for (let i = 0; i < values.length; i++) {
        const c = colourOf(values[i]);
        const at = i * 4;
        if (!c) {
          out[at] = out[at + 1] = out[at + 2] = out[at + 3] = 0;
          continue;
        }
        out[at] = c[0];
        out[at + 1] = c[1];
        out[at + 2] = c[2];
        out[at + 3] = c[3];
        painted += 1;
      }
      return painted;
    },
  };
}

/** `#rrggbb` of [r, g, b]. */
export const rgbHex = ([r, g, b]) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** A number for a legend or an input: 2 significant figures, whole above 100. */
export function formatScaleValue(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return String(Math.round(value));
  return String(Number(value.toPrecision(2)));
}

/**
 * Legend stops across the window: `count` swatches at equal steps on the
 * scale, labelled in the layer's units (the last "+" when values above the
 * ceiling are painted its colour, the first "≤" likewise below the floor).
 * @returns {Array<{value: number, label: string, color: string}>}
 */
export function scaleLegend(model, defaults, auto, { count = 5 } = {}) {
  const window = resolveWindow(model, auto);
  if (!window) return [];
  const { floor, ceiling } = window;
  const out = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const value =
      model.scale === 'log'
        ? Math.exp(Math.log(floor) + u * (Math.log(ceiling) - Math.log(floor)))
        : model.scale === 'sqrt'
          ? (Math.sqrt(floor) + u * (Math.sqrt(ceiling) - Math.sqrt(floor))) **
            2
          : floor + u * (ceiling - floor);
    const t = model.invert ? 1 - u : u;
    let label = defaults.format(value);
    if (model.outside === 'clamp' && i === count - 1) label += '+';
    if (model.outside === 'clamp' && i === 0 && model.floor !== null)
      label = `≤${label}`;
    if (i === count - 1 && defaults.units) label += ` ${defaults.units}`;
    out.push({
      value,
      label,
      color: rgbHex(colourAtPosition(model, defaults, t)),
    });
  }
  return out;
}

/** CSS `linear-gradient` of a palette (the layer's own stops for 'default'). */
export function paletteGradient(paletteId, defaults, { invert = false } = {}) {
  const list =
    paletteId === 'default'
      ? defaults.stops
      : paletteById(paletteId)?.stops || [];
  const ordered = invert ? [...list].reverse() : list;
  return `linear-gradient(to right, ${ordered.map(rgbHex).join(', ')})`;
}

/**
 * The slider's position (0 to 1) of a value over the data range, on the
 * scale's own mapping, and back; for the two-handle window slider.
 */
export function rangeFraction(value, range, scale) {
  if (!range || !(range.max > range.min)) return 0;
  const t =
    scale === 'log' && range.min > 0
      ? (Math.log(value) - Math.log(range.min)) /
        (Math.log(range.max) - Math.log(range.min))
      : scale === 'sqrt' && range.min >= 0
        ? (Math.sqrt(Math.max(0, value)) - Math.sqrt(range.min)) /
          (Math.sqrt(range.max) - Math.sqrt(range.min))
        : (value - range.min) / (range.max - range.min);
  return Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
}
export function rangeValue(fraction, range, scale) {
  const t = Math.min(1, Math.max(0, fraction));
  if (scale === 'log' && range.min > 0)
    return Math.exp(
      Math.log(range.min) + t * (Math.log(range.max) - Math.log(range.min)),
    );
  if (scale === 'sqrt' && range.min >= 0)
    return (
      (Math.sqrt(range.min) +
        t * (Math.sqrt(range.max) - Math.sqrt(range.min))) **
      2
    );
  return range.min + t * (range.max - range.min);
}

// --- serialisation ---------------------------------------------------------------

/** The share hash's parameter. */
export const COLOUR_SCALE_PARAM = 'cs';
/** The storage prefix: gev.colourScale.<key>. */
export const COLOUR_SCALE_STORAGE_PREFIX = 'gev.colourScale.';
const MAX_PARAM_CHARS = 1024;

/**
 * Layers' short tokens in the hash (a key's mode follows a '-'). Add a
 * layer here when it gets a scale; a token is never reused.
 */
export const COLOUR_SCALE_LAYER_TOKENS = Object.freeze({
  'wikipedia-coverage': 'w',
  property: 'p',
  // Earth Engine image layers (worker3's), Lego mode's window, and later ones:
  'ee-elevation': 'el',
  'ee-terrain-slope': 'sl',
  'ee-terrain-aspect': 'as',
  'ee-population': 'po',
  'ee-surface-water': 'sw',
  'ee-tree-canopy': 'tc',
  'ee-buildings': 'bu',
  'ee-inundation': 'in',
  'ee-forest-loss': 'fl',
  'ee-census-tracts': 'ct',
});
const LAYER_BY_TOKEN = new Map(
  Object.entries(COLOUR_SCALE_LAYER_TOKENS).map(([id, token]) => [token, id]),
);

/** A scale key for a layer and its mode ('' for none). */
export const scaleKey = (layerId, mode = '') =>
  mode ? `${layerId}:${mode}` : layerId;
const splitKey = (key) => {
  const at = key.indexOf(':');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
};

// Numbers in the hash: '.' is the field separator, so the decimal point is 'p'.
const encodeNumber = (value) =>
  value === null ? '' : String(Number(value.toPrecision(6))).replace('.', 'p');
const decodeNumber = (text) => {
  if (text === '') return null;
  if (!/^-?[0-9]+(p[0-9]+)?(e[-+]?[0-9]+)?$/.test(text)) return undefined;
  const value = Number(text.replace('p', '.'));
  return Number.isFinite(value) ? value : undefined;
};

/** One scale as its hash fields: palette.floor.ceiling.flags. */
export function encodeScaleFields(model) {
  const flags =
    (model.scale === 'log' ? 'l' : model.scale === 'sqrt' ? 's' : 'n') +
    (model.invert ? 'i' : '') +
    (model.outside === 'hide' ? 'h' : '');
  return [
    paletteById(model.palette).code,
    encodeNumber(model.floor),
    encodeNumber(model.ceiling),
    flags,
  ].join('.');
}

/** Hash fields back to a raw scale (normalised later against the layer's defaults), or null. */
export function decodeScaleFields(fields) {
  if (fields.length !== 4) return null;
  const [code, floorText, ceilingText, flags] = fields;
  const entry = BY_CODE.get(code);
  const floor = decodeNumber(floorText);
  const ceiling = decodeNumber(ceilingText);
  if (!entry || floor === undefined || ceiling === undefined) return null;
  if (!/^[lns]i?h?$/.test(flags)) return null;
  return {
    palette: entry.id,
    floor,
    ceiling,
    scale: flags[0] === 'l' ? 'log' : flags[0] === 's' ? 'sqrt' : 'linear',
    invert: flags.includes('i'),
    outside: flags.includes('h') ? 'hide' : 'clamp',
  };
}

/**
 * The hash parameter for a set of scales {key: model}: entries of
 * `<layer token>[-<mode>].<palette>.<floor>.<ceiling>.<flags>` joined by
 * '_', sorted, unknown layers left out. '' when there is none.
 */
export function encodeColourScaleParam(scales) {
  const entries = [];
  for (const [key, model] of Object.entries(scales || {})) {
    const [layerId, mode] = splitKey(key);
    const token = COLOUR_SCALE_LAYER_TOKENS[layerId];
    if (!token || !/^[a-z0-9-]{0,24}$/.test(mode)) continue;
    entries.push(
      `${token}${mode ? `-${mode}` : ''}.${encodeScaleFields(model)}`,
    );
  }
  return entries.sort().join('_');
}

/** The hash parameter back to {key: raw scale}; malformed entries are skipped. */
export function decodeColourScaleParam(text) {
  const out = {};
  const raw = String(text || '');
  if (!raw || raw.length > MAX_PARAM_CHARS) return out;
  for (const entry of raw.split('_')) {
    const [head, ...fields] = entry.split('.');
    const dash = head.indexOf('-');
    const token = dash < 0 ? head : head.slice(0, dash);
    const mode = dash < 0 ? '' : head.slice(dash + 1);
    const layerId = LAYER_BY_TOKEN.get(token);
    if (!layerId || !/^[a-z0-9-]{0,24}$/.test(mode)) continue;
    const scale = decodeScaleFields(fields);
    if (scale) out[scaleKey(layerId, mode)] = scale;
  }
  return out;
}

// The store (storage, the share hash, listeners): colourScaleStore.js.
