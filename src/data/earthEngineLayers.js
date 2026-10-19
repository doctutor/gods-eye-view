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
 *   layer since 2026-10-18;
 * - JRC/GFC2020_subtypes/V1 (image, band Map: 1 naturally regenerating,
 *   10 primary, 20 planted forest; 10 m; free to use, citation requested),
 *   the Forest types layer since 2026-10-19;
 * - JRC/GHSL/P2023A/GHS_POP (image collection, one image per epoch 1975 to
 *   2030, band population_count: people per 100 m cell; reuse authorised
 *   with acknowledgement), the Population layer since 2026-10-19.
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
 *               riverLineWidth gives its `widthProperty` in the band; a chip picks the
 *               mode, kept as `modeStorageKey`. The catalog makes these
 *               maps only when a tile asks for one (`lazyMaps`)
 *               An image layer's modes each name their own `asset`, `vis`,
 *               `legend` and steps (below): Population's epochs
 *   remap       image: {from, to}, class codes to palette indices (anything
 *               else is masked)
 *   scale       image: a factor (a count per equal-area cell to one per km²)
 *   atLeast     image: values below it are masked
 *   log10       image: true to draw the logarithm (vis min/max in log10)
 *   omitAmericas  rivers: true leaves out the reaches with CON_ID 1 and 2
 *               (AMERICAS_CON_IDS) in every mode, so another source can
 *               draw the Americas; a mode with `omitAmericas` (network-rest)
 *               does so but for AMERICAS_KEEP. A mode can be `inInk` (the
 *               layer's ink, no colour table) and `hidden` (no chip)
 *   americasV2  rivers: NETWORK over the Americas from the self-hosted
 *               HydroSHEDS v2 tiles when built (src/layers/riversV2/source.js)
 *   lineWidth   rivers: {base, step, max}, the widths by order in a band
 *               (riverLineWidth), shared with v2
 *   legend      [{label, color}] (labels are English UI text)
 *   attribution the notice the dataset's terms require
 *   maxZoom     the deepest tile level asked for
 *   maxHeightM  no tiles are asked for while the camera is higher than this
 *               (optional; only for a quantity that means nothing once
 *               averaged down, like forest-loss years. Elevation averages
 *               sensibly and Earth Engine derives slope, aspect and
 *               hillshade at the tile's scale, so the terrain layers draw
 *               from orbit, as do Forest types (a MODE pyramid with an
 *               averaged mask) and Population (a density):
 *               docs/PERSONAL-FORK.md, "Level of detail")
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
 * Hawaii and Easter Island have no reaches. Alaska's Near Islands west of
 * 180° are 5 (Asia).
 */
export const AMERICAS_CON_IDS = Object.freeze([1, 2]);

/**
 * The Americas reaches v1 keeps drawing while HydroSHEDS v2 draws the rest
 * of the Americas (the `omitAmericas` NETWORK maps): where v2 has no data.
 * v2's extent is 169.72° W to 32.41° W, 55.96° S to 83.13° N, without
 * Greenland (server/providers/riversV2.js; docs/PERSONAL-FORK.md). Counted
 * live on 2026-10-18:
 * - COUNTRY = 'Greenland': 137,088 reaches, all CON_ID 1, none outside
 *   Greenland (the Canadian Arctic islands next to it are 'Canada');
 * - west of 169.72° W: 734 CON_ID 1 reaches (United States: the Aleutians
 *   past Umnak, the Pribilofs, St. Lawrence Island);
 * - north of 83.13° N: 28 Canadian reaches at Ellesmere's north tip.
 * Nothing else of CON_ID 1 or 2 lies outside v2's extent (none south of
 * 55.96° S, none east of 32.41° W but Greenland's), and Easter Island has
 * no v1 reach.
 */
export const AMERICAS_KEEP = Object.freeze([
  Object.freeze({ property: 'COUNTRY', equals: 'Greenland' }),
  Object.freeze({ box: Object.freeze([-180, -90, -169.72, 90]) }),
  Object.freeze({ box: Object.freeze([-180, 83.13, 180, 90]) }),
]);

/**
 * Line widths, shared with HydroSHEDS v2's renderer
 * (server/providers/riversV2/bands.js) so the two match at the Americas'
 * edge: the smallest order a band draws is 0.75 px, each order larger adds
 * 0.55 px, up to 4 px. Under a pixel a line is drawn a pixel wide and that
 * much fainter (0.75 px: a 1 px line at 75% of the ink's alpha), as v2's
 * coverage raster does.
 */
export const RIVER_LINE = Object.freeze({ base: 0.75, step: 0.55, max: 4 });
/** The smallest order v2 holds (a 1 km² basin); v1's 8 to 10 draw as it. */
export const RIVER_SMALLEST_ORDER = 8;

/** A reach's line width (px) in a band drawing orders up to `bandMaxOrder`. */
export function riverLineWidth(order, bandMaxOrder = RIVER_SMALLEST_ORDER) {
  const top = Math.min(RIVER_SMALLEST_ORDER, bandMaxOrder);
  const steps = Math.max(0, top - Math.min(Number(order) || top, top));
  const width = RIVER_LINE.base + RIVER_LINE.step * steps;
  return Math.round(Math.min(RIVER_LINE.max, width) * 100) / 100;
}

/**
 * The rivers' inks, v2's too: white on imagery and dark maps, near-black on
 * the light ones (the boundaries' and the Grid's choice), both at 80%.
 */
export const RIVER_INKS = Object.freeze({
  light: 'ffffffcc',
  dark: '1a1a1acc',
});

/** 'rrggbbaa' with its alpha scaled (a sub-pixel line's coverage). */
export function scaleAlpha(color, factor) {
  const alpha = parseInt(String(color).slice(6, 8) || 'ff', 16);
  const scaled = Math.round(alpha * Math.min(1, Math.max(0, factor)));
  return `${String(color).slice(0, 6)}${scaled.toString(16).padStart(2, '0')}`;
}

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
 *
 * The heights are where the imagery level Cesium picks at the middle of
 * the view steps (riverZoomForHeight), so each band is the one HydroSHEDS
 * v2's zoom bands (server/providers/riversV2/bands.js) draw at that
 * height: `zooms` names them.
 */
const riverBand = (key, maxOrder, minZoom, zooms, heights) =>
  Object.freeze({
    key,
    asset: RIVERS_TABLE,
    ...(maxOrder ? { maxOrder } : {}),
    minZoom,
    zooms: Object.freeze(zooms),
    auto: true,
    ...heights,
  });

/**
 * The imagery level (Web Mercator zoom) Cesium 1.138's globe drapes at the
 * middle of a view looking down from `heightM`. A terrain tile of level L
 * (geometric error e0 / 2^L, e0 = 77,067 m for a 65-sample heightmap over
 * two level-0 tiles) is refined until e·drawingBufferHeight /
 * (distance · sseDenominator) ≤ 2 px, and sseDenominator is 2·tan(30°) /
 * aspect for the 60° frustum, so e ≤ 2.309 · distance / canvas width; the
 * tile then takes the imagery level round(L + log2(2.03 · cos latitude)),
 * L + 1 between the equator and about 50°. With a 1,600 px wide canvas
 * that is z = ceil(log2(5.34e7 / height)) + 1. A wider canvas shifts every
 * step to a greater height (2,560 px: by 1.6×).
 */
export const RIVER_ZOOM_K_M = 5.34e7;
export function riverZoomForHeight(heightM, k = RIVER_ZOOM_K_M) {
  const height = Math.max(1, Number(heightM) || 1);
  return Math.max(0, Math.ceil(Math.log2(k / height)) + 1);
}
/** The canvas width (CSS px) RIVER_ZOOM_K_M is for. */
export const RIVER_REFERENCE_WIDTH_PX = 1600;

/**
 * The camera height a 1,600 px canvas would need to drape the zoom this
 * canvas drapes at `heightM`: Cesium's level steps with distance / the
 * canvas's larger side (the 60° field of view spans it), so a 720 px pane
 * at 4,500 km drapes what a 1,600 px one does at 10,000 km. The Rivers
 * pick their band from it, so v1 follows the zoom v2 is drawn at whatever
 * the pane's size.
 */
export function riverHeightForCanvas(heightM, widthPx, heightPx) {
  const side = Math.max(Number(widthPx) || 0, Number(heightPx) || 0);
  return side > 0 ? (heightM * RIVER_REFERENCE_WIDTH_PX) / side : heightM;
}

/** The height below which the middle of the view is at zoom n + 2: K / 2^n. */
const STEP = (n) => RIVER_ZOOM_K_M / 2 ** n;

export const RIVER_BANDS = Object.freeze([
  riverBand('o3', 3, 2, [0, 4], { minHeightM: STEP(3) }),
  // Up to 1,666 km, not K / 32 = 1,669 km (z 6/7): o5's square must not be the world.
  riverBand('o4', 4, 3, [5, 6], {
    minHeightM: 1_666_000,
    maxHeightM: STEP(3),
  }),
  riverBand('o5', 5, 4, [7, 7], { minHeightM: STEP(6), maxHeightM: 1_666_000 }),
  riverBand('o6', 6, 5, [8, 8], { minHeightM: STEP(7), maxHeightM: STEP(6) }),
  riverBand('o7', 7, 6, [9, 10], { minHeightM: STEP(9), maxHeightM: STEP(7) }),
  riverBand('all', null, 7, [11, 14], { maxHeightM: STEP(9) }),
]);

/** The largest order the Rivers draw at a camera height (10: every order). */
export function riverOrdersAt(heightM) {
  const band = RIVER_BANDS.find(
    (variant) =>
      !(Number(heightM) < (variant.minHeightM ?? -Infinity)) &&
      !(Number(heightM) >= (variant.maxHeightM ?? Infinity)),
  );
  return (band || RIVER_BANDS[RIVER_BANDS.length - 1]).maxOrder ?? 10;
}

const NETWORK_LEGEND = Object.freeze([
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  Object.freeze({ label: 'Large river', color: '#ffffff', ink: true }),
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  Object.freeze({ label: 'Stream', color: '#ffffff', ink: true }),
]);

/**
 * The Rivers modes (chips NETWORK / FREE-FLOWING / PRESSURE). NETWORK is
 * in the ink; `network-rest` is NETWORK without the Americas (but
 * AMERICAS_KEEP), drawn while HydroSHEDS v2 draws them, and has no chip.
 */
export const RIVER_MODES = Object.freeze([
  Object.freeze({
    key: 'network',
    property: 'RIV_ORD',
    inInk: true,
    legend: NETWORK_LEGEND,
  }),
  Object.freeze({
    key: 'network-rest',
    property: 'RIV_ORD',
    inInk: true,
    omitAmericas: true,
    hidden: true,
    legend: NETWORK_LEGEND,
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

// --- Forest types ------------------------------------------------------------

/**
 * JRC's global forest types 2020 v1 (10 m): 1 naturally regenerating, 10
 * primary, 20 planted; anything else is masked. One image whose pyramid is
 * MODE for the classes, while the mask is averaged: a coarser pixel is the
 * commonest type beneath it, as opaque as the share of forest (checked
 * live 2026-10-19).
 */
const FOREST_TYPES_IMAGE = Object.freeze({
  image: 'JRC/GFC2020_subtypes/V1',
  band: 'Map',
});
/**
 * Brewer's Dark2 hues (the dataset's own dark green for primary forest
 * vanished on forest imagery and black): a light yellow-green, a teal and
 * an orange, apart in lightness too.
 */
export const FOREST_TYPE_COLORS = Object.freeze({
  natural: 'b8e186',
  primary: '1b9e77',
  planted: 'd95f02',
});

// --- Population --------------------------------------------------------------

/** GHSL's population epochs (P2023A): 1975 to 2020 estimated, 2025 and 2030 projected. */
export const POPULATION_COLLECTION = 'JRC/GHSL/P2023A/GHS_POP';
export const POPULATION_BAND = 'population_count';
/** The latest epoch that is an estimate, not a projection. */
export const POPULATION_EPOCH = 2020;
/** The epochs a chip draws. */
export const POPULATION_EPOCHS = Object.freeze([2020, 2000, 1990, 1975]);
/**
 * People per km² from a cell's count: GHS_POP's cells are 100 m squares of
 * the equal-area World Mollweide grid, 0.01 km² each, and Earth Engine's
 * pyramid for the band is MEAN (checked 2026-10-19), so a coarser level's
 * pixel is the mean count of the 100 m cells beneath it and × 100 is their
 * density at every level: scale-invariant, unlike a count.
 */
export const POPULATION_PER_KM2 = 100;

/**
 * The GHSL population image of an epoch, for a layer or a join (a later
 * "Wikipedia articles per capita"): its Earth Engine id, band, the factor
 * from a cell's count to people per km², and the cell size.
 */
export function populationDataset(epoch = POPULATION_EPOCH) {
  const year = Number(epoch);
  if (!Number.isInteger(year) || year < 1975 || year > 2030 || year % 5)
    throw new RangeError(`No GHSL population epoch ${epoch}`);
  return Object.freeze({
    collection: POPULATION_COLLECTION,
    image: `${POPULATION_COLLECTION}/${year}`,
    band: POPULATION_BAND,
    epoch: year,
    projected: year > POPULATION_EPOCH,
    cellM: 100,
    perKm2: POPULATION_PER_KM2,
  });
}

/** The density ramp: log10 of people per km², 1 to 10,000+. */
const POPULATION_PALETTE = Object.freeze([
  'fed976',
  'fecc5c',
  'fd8d3c',
  'f03b20',
  'bd0026',
]);
const POPULATION_LEGEND = Object.freeze([
  Object.freeze({ label: '1', color: `#${POPULATION_PALETTE[0]}` }),
  Object.freeze({ label: '10', color: `#${POPULATION_PALETTE[1]}` }),
  Object.freeze({ label: '100', color: `#${POPULATION_PALETTE[2]}` }),
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  Object.freeze({ label: '1,000', color: `#${POPULATION_PALETTE[3]}` }),
  Object.freeze({
    // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
    label: '10,000+ per km²',
    color: `#${POPULATION_PALETTE[4]}`,
  }),
]);

/** The Population modes: people per km² in one epoch each (chips by year). */
export const POPULATION_MODES = Object.freeze(
  POPULATION_EPOCHS.map((epoch) => {
    const dataset = populationDataset(epoch);
    return Object.freeze({
      key: `density-${epoch}`,
      epoch,
      asset: Object.freeze({ image: dataset.image, band: dataset.band }),
      scale: dataset.perKm2,
      // Under one person per km² is left clear.
      atLeast: 1,
      log10: true,
      vis: Object.freeze({ min: 0, max: 4, palette: POPULATION_PALETTE }),
      legend: POPULATION_LEGEND,
    });
  }),
);

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
  // Forest types: a categorical 10 m image whose MODE pyramid keeps its
  // meaning from orbit (FOREST_TYPES_IMAGE), so it has no ceiling.
  Object.freeze({
    id: 'ee-forest-types',
    name: 'Forest types',
    kind: 'image',
    asset: FOREST_TYPES_IMAGE,
    // The class codes as palette indices.
    remap: Object.freeze({
      from: Object.freeze([1, 10, 20]),
      to: Object.freeze([1, 2, 3]),
    }),
    vis: Object.freeze({
      min: 1,
      max: 3,
      palette: Object.freeze([
        FOREST_TYPE_COLORS.natural,
        FOREST_TYPE_COLORS.primary,
        FOREST_TYPE_COLORS.planted,
      ]),
    }),
    legend: Object.freeze([
      Object.freeze({
        // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
        label: 'Naturally regenerating forest',
        color: `#${FOREST_TYPE_COLORS.natural}`,
      }),
      Object.freeze({
        // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
        label: 'Primary forest',
        color: `#${FOREST_TYPE_COLORS.primary}`,
      }),
      Object.freeze({
        // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
        label: 'Planted forest',
        color: `#${FOREST_TYPE_COLORS.planted}`,
      }),
    ]),
    attribution:
      'EC JRC, Global map of forest types 2020 v1 (Bourgoin et al. 2026)',
    maxZoom: 14,
  }),
  // Population: people per km², a density, so it averages sensibly and draws
  // from orbit (POPULATION_PER_KM2).
  Object.freeze({
    id: 'ee-population',
    name: 'Population',
    kind: 'image',
    asset: POPULATION_MODES[0].asset,
    modes: POPULATION_MODES,
    modeStorageKey: 'gev.population.mode',
    // One epoch is drawn at a time: its map is made when a tile asks.
    lazyMaps: true,
    legend: POPULATION_LEGEND,
    attribution:
      'GHSL: Global population surfaces P2023A, European Commission, Joint Research Centre',
    maxZoom: 12,
  }),
  // Rivers: a vector network drawn by Earth Engine per reach, its detail by
  // RIV_ORD band with the camera height (level switching), each band's
  // tiles starting at a level Earth Engine answers in seconds; the names
  // are Natural Earth's, drawn by the client (src/layers/earthEngine/
  // riverNames.js). Lines are 0.75 to 4 px at every zoom, as HydroSHEDS v2 draws them.
  Object.freeze({
    id: 'ee-rivers',
    name: 'Rivers',
    kind: 'features',
    variants: RIVER_BANDS,
    modes: RIVER_MODES,
    modeStorageKey: 'gev.rivers.mode',
    lazyMaps: true,
    widthProperty: 'RIV_ORD',
    // Widths by order within the band (riverLineWidth), as v2 draws them.
    lineWidth: RIVER_LINE,
    // NETWORK over the Americas from the self-hosted HydroSHEDS v2 tiles
    // when they are built (src/layers/riversV2/source.js), v1 elsewhere.
    americasV2: true,
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
