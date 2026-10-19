/**
 * Personal fork: the Earth Engine overlay layers, as data. The server builds
 * each one's Earth Engine expression from its record
 * (server/providers/earthEngine.js) and the client draws it from the tile
 * proxy (src/layers/earthEngine/). Adding a layer is adding a record here.
 *
 * Every asset id is from the public Earth Engine catalog's STAC records
 * (storage.googleapis.com/earthengine-stac), checked 2026-10-17:
 * - COPERNICUS/DEM/GLO30_2024_1 (image collection, band DEM), the
 *   successor of the deprecated COPERNICUS/DEM/GLO30;
 * - USGS/GMTED2010_FULL (image, band mea: mean elevation at 7.5"), the
 *   terrain layers' far source (used live 2026-10-18; USGS, public domain);
 * - UMD/hansen/global_forest_change_2025_v1_13 (image, band lossyear:
 *   0 = no loss, 1–25 = loss in 2001–2025), the latest version;
 * - FAO/GAUL/2025/level1 and level2 (tables, CC-BY-4.0), the successors of
 *   the deprecated, noncommercial-only 2015 tables. GAUL 2025 has no
 *   level0 (checked with the API on 2026-10-18: the folder lists level1
 *   and level2 only);
 * - USDOS/LSIB/2017 (table, US public domain: "no restrictions on use"),
 *   the countries variant since 2026-10-18; its interior boundaries
 *   reflect US government policy on disputes. LSIB_SIMPLE/2017 stores
 *   Canada and the United States in chunks, like GAUL 2015's level0;
 * - WWF/HydroSHEDS/v1/FreeFlowingRivers (table, 8,477,883 reaches: the
 *   HydroRIVERS v1 network with Grill et al. 2019's connectivity
 *   attributes; HydroSHEDS licence, free with attribution), the Rivers
 *   layer since 2026-10-18.
 *
 * A record:
 *   id          layer id ('ee-' prefix), also the tile route's name
 *   name        the layer's English name (translated in layerNames.js)
 *   kind        'image' (a band, visualized with vis) or 'features'
 *               (a table, drawn with style)
 *   asset       {collection | image | table, band?, seaIsZero?}; a collection
 *               is mosaicked; seaIsZero masks the zero pixels before use
 *   terrain     'slope' | 'aspect' | 'hillshade' (ee.Terrain), optional
 *   selfMask    true to leave zero pixels transparent
 *   vis         {min, max, palette} (palette colours as RRGGBB)
 *   style       {color, fillColor, width} for features (RRGGBBAA allowed)
 *   inks        for features: {light: RRGGBBAA, dark: RRGGBBAA}, the line
 *               colour per ink; one map per (variant, ink), and the client
 *               picks the ink from the basemap's luminance (src/maps/ink.js)
 *   variants    [{key, asset, auto?, minHeightM?, maxHeightM?, maxOrder?,
 *               minZoom?}] in place of `asset`, one map per variant; on
 *               AUTO the camera height picks among the `auto` variants. For
 *               features they are administrative levels, and a chip can
 *               force any of them; for terrain a far and a near source,
 *               chosen by height only; for rivers the RIV_ORD bands
 *               (`maxOrder`: reaches of that order or larger, all without
 *               it). `minZoom`: the variant's tiles start at that level
 *               (the client asks for nothing coarser, the server answers a
 *               coarser tile with a transparent one)
 *   modes       [{key, property, numeric?, colors: {ink: {value: RRGGBBAA}},
 *               fallback: {ink: RRGGBBAA}, legend}] for a features layer
 *               drawn per feature: one map per (variant, ink, mode), each
 *               reach coloured by its `property` through the ink's table
 *               (`numeric`: the property is an integer 1, 2, 3… that every
 *               feature has, so it indexes a list; otherwise text, with
 *               `fallback` for values not in the table) and as wide as
 *               `widths` says for its `widthProperty`; a chip picks the
 *               mode, kept as `modeStorageKey`. The catalog makes these
 *               maps only when a tile asks for one (`lazyMaps`)
 *   omitAmericas  rivers: true leaves out the reaches with CON_ID 1 and 2
 *               (AMERICAS_CON_IDS), so another source can draw the Americas
 *   legend      [{label, color}] (labels are English UI text)
 *   attribution the notice the dataset's terms require
 *   maxZoom     the deepest tile level asked for
 *   maxHeightM  no tiles are asked for while the camera is higher than this
 *               (optional; only for a quantity that means nothing once
 *               averaged down, like forest-loss years. Elevation averages
 *               sensibly and Earth Engine derives slope, aspect and
 *               hillshade at the tile's scale, so the terrain layers draw
 *               from orbit: docs/PERSONAL-FORK.md, "Level of detail")
 */

export const EARTH_ENGINE_ATTRIBUTION = 'Google Earth Engine';

const COPERNICUS_DEM_NOTICE =
  'Copernicus DEM GLO-30: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';
const DEM = Object.freeze({
  collection: 'COPERNICUS/DEM/GLO30_2024_1',
  band: 'DEM',
});
// Far views of the terrain layers: GMTED2010's 7.5" mean elevation, one
// pyramided image. The Copernicus mosaic is some 26,000 images, and a z 0
// to 2 tile of it took Earth Engine 10 to 156 s (2026-10-18), past the
// proxy's 30 s; this one answers in under a second. Its sea is 0, masked.
const DEM_FAR = Object.freeze({
  image: 'USGS/GMTED2010_FULL',
  band: 'mea',
  seaIsZero: true,
});
/** Above this camera height the terrain layers draw from DEM_FAR. */
const DEM_FAR_ABOVE_M = 3_000_000;
const DEM_VARIANTS = Object.freeze([
  Object.freeze({
    key: 'far',
    asset: DEM_FAR,
    auto: true,
    minHeightM: DEM_FAR_ABOVE_M,
  }),
  Object.freeze({
    key: 'near',
    asset: DEM,
    auto: true,
    maxHeightM: DEM_FAR_ABOVE_M,
  }),
]);
const DEM_NOTICE = `${COPERNICUS_DEM_NOTICE}. Far views: GMTED2010, USGS and NGA`;

// --- Rivers ------------------------------------------------------------------

const RIVERS_TABLE = Object.freeze({
  table: 'WWF/HydroSHEDS/v1/FreeFlowingRivers',
});

/**
 * The CON_ID values `omitAmericas` leaves out. Counted live on 2026-10-18
 * (every reach has one, 1 to 6, none missing or 0): 1 is North America
 * with Greenland and the Canadian Arctic; 2 is South America with Central
 * America, the Caribbean islands and most of Mexico (northern Baja is 1).
 * Hawaii has no reaches. Alaska's Near Islands west of 180° are 5 (Asia).
 */
export const AMERICAS_CON_IDS = Object.freeze([1, 2]);

/**
 * Line width (px) by RIV_ORD, the order of the reach's long-term average
 * discharge (1: over 100,000 m³/s, the Amazon; each order a tenth of the
 * one before; 10: under 0.001 m³/s): the larger the flow, the wider.
 */
const RIVER_WIDTHS = Object.freeze({
  1: 3,
  2: 2.6,
  3: 2.2,
  4: 1.8,
  5: 1.5,
  6: 1.25,
  7: 1.1,
  8: 1,
  9: 1,
  10: 1,
});

/** NETWORK: the ink, more opaque the larger the flow. */
const NETWORK_ALPHAS = Object.freeze({
  1: 'ff',
  2: 'ff',
  3: 'ff',
  4: 'f2',
  5: 'e0',
  6: 'cc',
  7: 'b3',
  8: '99',
  9: '88',
  10: '77',
});
/**
 * The rivers' inks: a pale blue on imagery and dark maps, a deep blue on
 * the light ones (contrast about 12:1 on #111 and 8:1 on white).
 */
const RIVER_INKS = Object.freeze({ light: '9fd8ffff', dark: '08519cff' });

const networkColors = (ink) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(NETWORK_ALPHAS).map(([order, alpha]) => [
        order,
        `${RIVER_INKS[ink].slice(0, 6)}${alpha}`,
      ]),
    ),
  );

/**
 * Categorical colours: the Okabe–Ito hues (distinct with the common colour
 * vision deficiencies), lightened for the light ink (dark basemaps) and
 * darkened for the dark ink (light basemaps) so each keeps at least 3.9:1
 * against its background.
 */
const OKABE_ITO = Object.freeze({
  light: Object.freeze({
    blue: '56b4e9',
    yellow: 'f0e442',
    vermillion: 'ff7a3d',
    orange: 'e69f00',
    purple: 'e08cc0',
    green: '3fd6a5',
    grey: '9aa4ad',
  }),
  dark: Object.freeze({
    blue: '0072b2',
    yellow: '8c7a00',
    vermillion: 'c24e00',
    orange: '9a6400',
    purple: 'a8458a',
    green: '00795a',
    grey: '6b7480',
  }),
});
const byInk = (make) =>
  Object.freeze({ light: make(OKABE_ITO.light), dark: make(OKABE_ITO.dark) });

/** FREE-FLOWING: CSI_FF2, 1 free-flowing, 2 good connectivity, 3 impacted. */
const FREE_FLOWING_COLORS = byInk((hue) =>
  Object.freeze({
    1: `${hue.blue}e6`,
    2: `${hue.yellow}e6`,
    3: `${hue.vermillion}e6`,
  }),
);
/**
 * PRESSURE: CSI_D, the pressure that lowers the reach's connectivity
 * most: DOF fragmentation by dams, DOR flow regulation, SED sediment
 * trapping, USE water consumption, RDD road density, URB urban areas. NAN
 * (5.3 of the 8.5 million reaches) has none, and is drawn faint.
 */
const PRESSURE_COLORS = byInk((hue) =>
  Object.freeze({
    DOF: `${hue.vermillion}e6`,
    DOR: `${hue.blue}e6`,
    SED: `${hue.orange}e6`,
    USE: `${hue.purple}e6`,
    RDD: `${hue.green}e6`,
    URB: `${hue.yellow}e6`,
    NAN: `${hue.grey}59`,
  }),
);
const legendOf = (colors, labels) =>
  Object.freeze(
    Object.entries(labels).map(([value, label]) =>
      Object.freeze({
        label,
        color: `#${colors.light[value].slice(0, 6)}`,
        value,
      }),
    ),
  );

/**
 * The Rivers bands: on AUTO the camera height picks how many orders are
 * drawn, the largest rivers from orbit and more orders as the view comes
 * in. Each band's tiles start at its `minZoom`, the coarsest level whose
 * tiles Earth Engine draws in seconds for that band: it reads every reach
 * under a tile, so coarse tiles of the denser bands took 20 to over 60 s
 * (orders 1 to 7 at z 3 over the Amazon: 36.5 s; every order at z 1: 87 s;
 * measured 2026-10-18, docs/PERSONAL-FORK.md, "Rivers"). A band drawn
 * above 1,667 km, where the overlay covers the whole world, starts no
 * deeper than z 3 (64 tiles).
 */
const riverBand = (key, maxOrder, minZoom, heights) =>
  Object.freeze({
    key,
    asset: RIVERS_TABLE,
    ...(maxOrder ? { maxOrder } : {}),
    minZoom,
    auto: true,
    ...heights,
  });
export const RIVER_BANDS = Object.freeze([
  riverBand('o3', 3, 2, { minHeightM: 6_000_000 }),
  riverBand('o4', 4, 3, { minHeightM: 1_600_000, maxHeightM: 6_000_000 }),
  riverBand('o5', 5, 4, { minHeightM: 700_000, maxHeightM: 1_600_000 }),
  riverBand('o6', 6, 5, { minHeightM: 250_000, maxHeightM: 700_000 }),
  riverBand('o7', 7, 6, { minHeightM: 80_000, maxHeightM: 250_000 }),
  riverBand('all', null, 7, { maxHeightM: 80_000 }),
]);

/** The Rivers modes (chips NETWORK / FREE-FLOWING / PRESSURE). */
export const RIVER_MODES = Object.freeze([
  Object.freeze({
    key: 'network',
    property: 'RIV_ORD',
    numeric: true,
    colors: Object.freeze({
      light: networkColors('light'),
      dark: networkColors('dark'),
    }),
    fallback: Object.freeze({
      light: `${RIVER_INKS.light.slice(0, 6)}77`,
      dark: `${RIVER_INKS.dark.slice(0, 6)}77`,
    }),
    legend: legendOf(
      { light: { 1: RIVER_INKS.light, 7: networkColors('light')[7] } },
      { 1: 'Large river', 7: 'Stream' },
    ),
  }),
  Object.freeze({
    key: 'free-flowing',
    property: 'CSI_FF2',
    numeric: true,
    colors: FREE_FLOWING_COLORS,
    fallback: Object.freeze({
      light: `${OKABE_ITO.light.grey}59`,
      dark: `${OKABE_ITO.dark.grey}59`,
    }),
    legend: legendOf(FREE_FLOWING_COLORS, {
      1: 'Free-flowing',
      2: 'Good connectivity',
      3: 'Impacted',
    }),
  }),
  Object.freeze({
    key: 'pressure',
    property: 'CSI_D',
    colors: PRESSURE_COLORS,
    fallback: Object.freeze({
      light: PRESSURE_COLORS.light.NAN,
      dark: PRESSURE_COLORS.dark.NAN,
    }),
    legend: legendOf(PRESSURE_COLORS, {
      DOF: 'Dams (fragmentation)',
      DOR: 'Flow regulation',
      SED: 'Sediment trapping',
      USE: 'Water consumption',
      RDD: 'Road density',
      URB: 'Urban areas',
      NAN: 'No dominant pressure',
    }),
  }),
]);

const RIVERS_NOTICE =
  'HydroSHEDS/WWF: HydroRIVERS v1 (Lehner, Verdin & Jarvis 2008, Eos 89:93) and the Free-Flowing Rivers attributes (Grill et al. 2019, Nature 569:215); names from Natural Earth (public domain)';

export const EARTH_ENGINE_LAYERS = Object.freeze([
  Object.freeze({
    id: 'ee-terrain-slope',
    name: 'Terrain slope',
    kind: 'image',
    variants: DEM_VARIANTS,
    terrain: 'slope',
    vis: Object.freeze({
      min: 0,
      max: 45,
      palette: Object.freeze([
        '1a9850',
        '91cf60',
        'fee08b',
        'fc8d59',
        'd73027',
      ]),
    }),
    legend: Object.freeze([
      Object.freeze({ label: '0°', color: '#1a9850' }),
      Object.freeze({ label: '11°', color: '#91cf60' }),
      Object.freeze({ label: '22°', color: '#fee08b' }),
      Object.freeze({ label: '34°', color: '#fc8d59' }),
      Object.freeze({ label: '45°+', color: '#d73027' }),
    ]),
    attribution: DEM_NOTICE,
    maxZoom: 14,
  }),
  Object.freeze({
    id: 'ee-terrain-aspect',
    name: 'Terrain aspect',
    kind: 'image',
    variants: DEM_VARIANTS,
    terrain: 'aspect',
    vis: Object.freeze({
      min: 0,
      max: 360,
      // North, east, south, west, north again: a circular palette.
      palette: Object.freeze([
        '3288bd',
        '99d594',
        'fee08b',
        'fc8d59',
        '3288bd',
      ]),
    }),
    legend: Object.freeze([
      Object.freeze({ label: 'N', color: '#3288bd' }),
      Object.freeze({ label: 'E', color: '#99d594' }),
      Object.freeze({ label: 'S', color: '#fee08b' }),
      Object.freeze({ label: 'W', color: '#fc8d59' }),
    ]),
    attribution: DEM_NOTICE,
    maxZoom: 14,
  }),
  Object.freeze({
    id: 'ee-terrain-hillshade',
    name: 'Hillshade',
    kind: 'image',
    variants: DEM_VARIANTS,
    terrain: 'hillshade',
    vis: Object.freeze({
      min: 0,
      max: 255,
      palette: Object.freeze(['000000', 'ffffff']),
    }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Shade', color: '#000000' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Light', color: '#ffffff' }),
    ]),
    attribution: DEM_NOTICE,
    maxZoom: 14,
  }),
  Object.freeze({
    id: 'ee-forest-loss',
    name: 'Forest loss',
    kind: 'image',
    asset: Object.freeze({
      image: 'UMD/hansen/global_forest_change_2025_v1_13',
      band: 'lossyear',
    }),
    selfMask: true,
    vis: Object.freeze({
      min: 1,
      max: 25,
      palette: Object.freeze(['ffff00', 'ff9900', 'ff0000', '990000']),
    }),
    legend: Object.freeze([
      Object.freeze({ label: '2001', color: '#ffff00' }),
      Object.freeze({ label: '2009', color: '#ff9900' }),
      Object.freeze({ label: '2017', color: '#ff0000' }),
      Object.freeze({ label: '2025', color: '#990000' }),
    ]),
    attribution:
      'Hansen/UMD/Google/USGS/NASA, Global Forest Change 2000–2025 v1.13 (CC BY 4.0)',
    maxZoom: 12,
    maxHeightM: 3_000_000,
  }),
  Object.freeze({
    id: 'ee-admin-boundaries',
    name: 'Administrative boundaries',
    kind: 'features',
    variants: Object.freeze([
      // Countries only when asked for (the COUNTRIES chip). GAUL 2025 has
      // no level0, and GAUL 2015's stores Canada, the United States and
      // others in chunks (292 features, 276 codes) whose outlines are
      // straight false borders. LSIB 2017 has one feature per country (279
      // and 279), and its outlines took Earth Engine 0.4 to 3.6 s a z 1 to 3
      // tile (2026-10-18). Edges of GAUL 2015's code (Image.paint, focalMin)
      // hid the seams but took 15 s to over 240 s a z 1 to 3 tile.
      Object.freeze({
        key: 'level0',
        asset: Object.freeze({ table: 'USDOS/LSIB/2017' }),
      }),
      // On AUTO: states and provinces from far out; districts closer in.
      Object.freeze({
        key: 'level1',
        asset: Object.freeze({ table: 'FAO/GAUL/2025/level1' }),
        auto: true,
        minHeightM: 800_000,
      }),
      Object.freeze({
        key: 'level2',
        asset: Object.freeze({ table: 'FAO/GAUL/2025/level2' }),
        auto: true,
        maxHeightM: 800_000,
      }),
    ]),
    style: Object.freeze({
      color: 'ffffffcc',
      fillColor: '00000000',
      width: 1,
    }),
    // White on imagery and dark styles; near-black on the white globe,
    // Positron, the light Stamen styles and the light Countries maps.
    inks: Object.freeze({ light: 'ffffffcc', dark: '1a1a1acc' }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Boundary', color: '#ffffff' }),
    ]),
    attribution:
      'FAO GAUL 2025, Global Administrative Unit Layers (CC BY 4.0); boundaries do not imply any opinion of FAO. Countries: LSIB 2017, Office of the Geographer, U.S. Department of State',
    maxZoom: 12,
  }),
  // Rivers: a vector network drawn by Earth Engine per reach, its detail by
  // RIV_ORD band with the camera height (level switching), each band's
  // tiles starting at a level Earth Engine answers in seconds; the names
  // are Natural Earth's, drawn by the client (src/layers/earthEngine/
  // riverNames.js). Lines stay one to three pixels at every zoom.
  Object.freeze({
    id: 'ee-rivers',
    name: 'Rivers',
    kind: 'features',
    variants: RIVER_BANDS,
    modes: RIVER_MODES,
    modeStorageKey: 'gev.rivers.mode',
    lazyMaps: true,
    widthProperty: 'RIV_ORD',
    widths: RIVER_WIDTHS,
    // Off: every continent. On: the Americas (CON_ID 1 and 2) left out, for
    // another source to draw there.
    omitAmericas: false,
    inks: RIVER_INKS,
    names: 'natural-earth-rivers',
    legend: RIVER_MODES[0].legend,
    attribution: RIVERS_NOTICE,
    maxZoom: 11,
  }),
]);

/** A layer's modes: the keys of its `modes`, else one ('default'). */
export function layerModes(layer) {
  return layer?.modes?.length
    ? layer.modes.map((mode) => mode.key)
    : ['default'];
}

/** A layer's mode record by key, else its first (or null without modes). */
export function modeRecord(layer, key) {
  const modes = layer?.modes || [];
  return modes.find((mode) => mode.key === key) || modes[0] || null;
}

/** A layer's variants: features layers name theirs; an image layer has one. */
export function layerVariants(layer) {
  return layer?.variants?.length
    ? layer.variants
    : [{ key: 'default', asset: layer?.asset }];
}

/**
 * The variant a camera height wants on AUTO: the first `auto` variant
 * that fits, else the last of them. A layer without `auto` variants
 * chooses among all of its variants.
 */
export function variantForHeight(layer, heightM) {
  const all = layerVariants(layer);
  const eligible = all.filter((variant) => variant.auto);
  const variants = eligible.length ? eligible : all;
  return (
    variants.find(
      (variant) =>
        !(Number(heightM) < (variant.minHeightM ?? -Infinity)) &&
        !(Number(heightM) >= (variant.maxHeightM ?? Infinity)),
    ) || variants[variants.length - 1]
  );
}

/** A layer's inks: features layers with `inks` name theirs; anything else has one. */
export function layerInks(layer) {
  return layer?.inks && Object.keys(layer.inks).length
    ? Object.keys(layer.inks)
    : ['default'];
}

/** The line colour (RRGGBB[AA]) a features layer draws in an ink. */
export function inkColor(layer, ink) {
  return layer?.inks?.[ink] || layer?.style?.color || 'ffffff';
}
