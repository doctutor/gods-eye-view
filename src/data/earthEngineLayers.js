/**
 * Personal fork: the Earth Engine overlay layers, as data. The server builds
 * each one's Earth Engine expression from its record
 * (server/providers/earthEngine.js) and the client draws it from the tile
 * proxy (src/layers/earthEngine/). Adding a layer is adding a record here.
 *
 * Every asset id is from the public Earth Engine catalog's STAC records
 * (storage.googleapis.com/earthengine-stac), checked 2026-10-17:
 * - the terrain layers' elevation: the DEM stack (src/data/demStack.js,
 *   checked live 2026-10-19): GMTED2010, FABDEM v1-2, USGS 3DEP 10 m and
 *   1 m, ArcticDEM v4.1 and REMA v1.1. Until 2026-10-19 they drew
 *   COPERNICUS/DEM/GLO30_2024_1 below 3,000 km, whose coarse tiles took
 *   10 to 156 s and whose sea inside each land tile is 0 (drawn as flat
 *   squares over the coasts);
 * - UMD/hansen/global_forest_change_2025_v1_13 (image, band lossyear:
 *   0 = no loss, 1–25 = loss in 2001–2025), the latest version;
 * - FAO/GAUL/2025/level1 and level2 (tables, CC-BY-4.0), the successors of
 *   the deprecated, noncommercial-only 2015 tables. GAUL 2025 has no
 *   level0 (checked with the API on 2026-10-18: the folder lists level1
 *   and level2 only); FAO/GAUL_SIMPLIFIED_500m/2025/level1, the same
 *   units simplified to 500 m, draws level1's tiles at z ≤ 8;
 * - USDOS/LSIB/2017 (table, US public domain: "no restrictions on use"),
 *   the countries variant since 2026-10-18; its interior boundaries
 *   reflect US government policy on disputes. LSIB_SIMPLE/2017 stores
 *   Canada and the United States in chunks, like GAUL 2015's level0.
 *   Since 2026-10-22 only while the local Overture country lines are not
 *   built (src/layers/earthEngine/overtureBoundaries.js);
 * - WWF/HydroSHEDS/v1/FreeFlowingRivers (table, 8,477,883 reaches: the
 *   HydroRIVERS v1 network with Grill et al. 2019's connectivity
 *   attributes; HydroSHEDS licence, free with attribution), the Rivers
 *   layer since 2026-10-18;
 * - JRC/GSW1_4/GlobalSurfaceWater (image, 30 m, 1984–2021; bands
 *   occurrence, change_abs, seasonality; never-water pixels are masked;
 *   Copernicus, free, "Source: EC JRC/Google"), checked 2026-10-19;
 * - ESA/WorldCover/v200/2021 and ESA/WorldCover/v100/2020 (the one image
 *   of each collection, 10 m; band Map, 11 classes, pyramided by MODE;
 *   CC-BY-4.0), checked 2026-10-19;
 * - JRC/GFC2020_subtypes/V1 (image, band Map: 1 naturally regenerating,
 *   10 primary, 20 planted forest; 10 m; free to use, citation requested),
 *   the Forest types layer since 2026-10-19;
 * - JRC/GHSL/P2023A/GHS_POP (image collection, one image per epoch 1975 to
 *   2030, band population_count: people per 100 m cell; reuse authorised
 *   with acknowledgement), the Population layer since 2026-10-19;
 * - GOOGLE/Research/open-buildings-temporal/v1 (image collection, one image
 *   per S2 cell and year 2016–2023, 0.5 m grid of 4 m effective resolution;
 *   bands building_presence, building_height, building_fractional_count,
 *   every one pyramided by MEAN; CC BY 4.0 or ODbL 1.0, the user's choice)
 *   and GOOGLE/Research/open-buildings/v3/polygons (table, CC BY 4.0), the
 *   Buildings layer since 2026-10-19;
 * - projects/meta-forest-monitoring-okw37/assets/CanopyHeight (community
 *   catalog, image collection of 170 tiles, band cover_code: canopy height
 *   in m, 0 where none; 1.19 m cells in EPSG:3857, MEAN pyramid; CC BY 4.0)
 *   and users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1 (image, band b1:
 *   canopy height in m, 10 m, MEAN pyramid; CC BY 4.0), the Tree canopy
 *   layer since 2026-10-19 (both readable by the service account, checked
 *   2026-10-19).
 *
 * A record:
 *   id          layer id ('ee-' prefix), also the tile route's name
 *   name        the layer's English name (translated in layerNames.js)
 *   kind        'image' (a band, visualized with vis) or 'features'
 *               (a table, drawn with style)
 *   asset       {collection | image | table, band?, seaIsZero?, year?}; a
 *               collection is mosaicked (only its `year`'s images when
 *               given); seaIsZero masks the zero pixels before use
 *   overlay     a variant's {table, filter?: {property, atLeast}, width}:
 *               the mode's picture with the table's outlines in the ink on
 *               top (Buildings' footprints from z 15)
 *   coverage    {key, boxes}: where the data is; outside every box the row
 *               says there is none here (Buildings)
 *   terrain     'slope' | 'aspect' | 'hillshade' (ee.Terrain), optional
 *   selfMask    true to leave zero pixels transparent
 *   vis         {min, max, palette} (palette colours as RRGGBB)
 *   style       {color, fillColor, width} for features (RRGGBBAA allowed)
 *   inks        for features: {light: RRGGBBAA, dark: RRGGBBAA}, the line
 *               colour per ink; one map per (variant, ink), and the client
 *               picks the ink from the basemap's luminance (src/maps/ink.js)
 *   variants    [{key, asset, auto?, minHeightM?, maxHeightM?, maxOrder?,
 *               minZoom?, zooms?, stack?, heights?}] in place of `asset`,
 *               one map per variant; on AUTO the camera height picks among
 *               the `auto` variants. For features they are administrative
 *               levels, and a chip can force any of them; for terrain the
 *               DEM stack's zoom bands (`stack`: the band, src/data/
 *               demStack.js; `heights`: the Elevation layer's order), no
 *               chips; for rivers the RIV_ORD bands
 *               (`maxOrder`: reaches of that order or larger, all without
 *               it). `minZoom`: the variant's tiles start at that level
 *               (the client asks for nothing coarser, the server answers a
 *               coarser tile with a transparent one)
 *   modes       for an image layer (Surface water, Land cover,
 *               Population): [{key, band?, asset?, maskBand?, mask?,
 *               remap?, scale?, atLeast?, log10?, vis, legend}], one map per
 *               (variant, mode), its fields over the layer's (the steps
 *               below): the mode's `band` of the variant's asset or its own
 *               `asset`, drawn with its own vis; a chip picks the mode,
 *               kept as `modeStorageKey`.
 *               Or [{key, property, numeric?, colors: {ink: {value:
 *               RRGGBBAA}}, fallback: {ink: RRGGBBAA}, legend}] for a
 *               features layer drawn per feature: one map per (variant,
 *               ink, mode), each reach coloured by its `property` through
 *               the ink's table (`numeric`: the property is an integer 1,
 *               2, 3… that every feature has, so it indexes a list;
 *               otherwise text, with `fallback` for values not in the
 *               table) and as wide as riverLineWidth gives its
 *               `widthProperty` in the band; a chip picks the mode, kept as
 *               `modeStorageKey`. A layer marked `lazyMaps` has its maps
 *               made only when a tile asks for one (the Rivers, Population)
 *   An image's steps, on the layer or its mode, in this order
 *   (server/providers/earthEngine.js, imageNode):
 *   maskBand    masked by that band of the variant's asset
 *   remap       {from, to}: class codes to palette indices (anything else
 *               is masked)
 *   mask        'self' (zero transparent, as `selfMask`) or 'nonzero' (zero
 *               transparent where values are signed)
 *   perBand     {band, atLeast}: ÷ another band of the asset, masked where
 *               that band is below atLeast (Buildings' height per built share)
 *   scale       a factor (a count per equal-area cell to one per km²)
 *   atLeast     values below it are masked
 *   log10       true to draw the logarithm (vis min/max in log10)
 *   omitAmericas  rivers: true leaves out the reaches with CON_ID 1 and 2
 *               (AMERICAS_CON_IDS) in every mode, so another source can
 *               draw the Americas; a mode with `omitAmericas` (network-rest)
 *               does so but for AMERICAS_KEEP. A mode can be `inInk` (the
 *               layer's ink, no colour table) and `hidden` (no chip)
 *   americasV2  rivers: NETWORK over the Americas from the self-hosted
 *               HydroSHEDS v2 tiles when built (src/layers/riversV2/source.js)
 *   lineWidth   rivers: {base, step, max}, the widths by order in a band
 *               (riverLineWidth), shared with v2
 *   demStack    true for the terrain layers: the client names the source
 *               under the view, credits the ones in it, and asks as deep
 *               as they go (demStack.js maxZoomInRect)
 *   transform   'sqrt': the image is shown by √max(value, 0) (Elevation)
 *   lazyMaps    the catalog makes no map; the first tile that needs one does
 *   legend      [{label, color}] (labels are English UI text)
 *   attribution the notice the dataset's terms require
 *   maxZoom     the deepest tile level asked for
 *   contour     {indexEvery, minorShare, resample?}: an image layer drawn
 *               as contour lines of its variant's elevation every `step`
 *               metres (the variant's), in the ink (`inks`), every
 *               `indexEvery`-th line (an index contour) at the ink's alpha
 *               and the rest at `minorShare` of it, the elevation read with
 *               `resample` ('bilinear'); a variant with `stack` takes the
 *               DEM stack band's heights, each source resampled on its own
 *               grid (ELEVATION_CONTOURS below)
 *   maxHeightM  no tiles are asked for while the camera is higher than this
 *               (optional; only for a quantity that means nothing once
 *               averaged down, like forest-loss years, or a level that
 *               misleads, like Land cover's z 0 tile. Elevation averages
 *               sensibly and Earth Engine derives slope, aspect and
 *               hillshade at the tile's scale, so the terrain layers draw
 *               from orbit, as do Forest types (a MODE pyramid with an
 *               averaged mask) and Population (a density):
 *               docs/PERSONAL-FORK.md, "Level of detail")
 */

import { INCOME_LEGEND, LST_LEGEND } from './censusTracts.js';
import { BOUNDARY_INKS } from './overtureBoundaries.js';
import { DEM_MAX_ZOOM, demVariants } from './demStack.js';
import { OPEN_BUILDINGS_BOXES } from './openBuildingsCoverage.js';

export const EARTH_ENGINE_ATTRIBUTION = 'Google Earth Engine';

// The terrain layers draw from the DEM stack (src/data/demStack.js): one
// variant per zoom band, each a mosaic of the best sources there, drawn by
// tile zoom through the server's `zoom` variant (as the Rivers are), so a
// 3D tileset's coarse tiles come from GMTED2010, which answers in under a
// second, and close views from FABDEM, USGS 3DEP, ArcticDEM or REMA.
const DEM_VARIANTS = demVariants();
const DEM_HEIGHT_VARIANTS = demVariants({ heights: true });
const DEM_NOTICE =
  'Elevation from the DEM stack: GMTED2010 (USGS, NGA), FABDEM v1-2 (University of Bristol / Fathom, CC BY-NC-SA 4.0; Copernicus DEM GLO-30, © DLR e.V., © Airbus, EU/ESA), USGS 3DEP, ArcticDEM and REMA (PGC, NSF); each source is credited where it draws';
/** The terrain layers' record fields from the stack. */
const demLayer = (heights = false) => ({
  variants: heights ? DEM_HEIGHT_VARIANTS : DEM_VARIANTS,
  demStack: true,
  // Five bands: their maps are made when a tile asks (`lazyMaps`).
  lazyMaps: true,
  attribution: DEM_NOTICE,
});

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

// --- Surface water and land cover ---------------------------------------------

const SURFACE_WATER = Object.freeze({ image: 'JRC/GSW1_4/GlobalSurfaceWater' });
/** The attribution the dataset's terms ask a published map for, and its paper. */
const SURFACE_WATER_NOTICE =
  'Source: EC JRC/Google. Global Surface Water 1.4, 1984–2021 (Pekel et al. 2016, Nature 540:418)';
const LAND_COVER_NOTICE =
  '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). 2020: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2020) processed by ESA WorldCover consortium';
/**
 * No land cover tiles above this height. WorldCover's Map band is pyramided
 * by MODE (read from the asset, 2026-10-19): a coarse pixel is the class
 * most of it holds, so unlike forest loss (whose lossyear pyramid is MODE
 * too, but its "no loss" 0 outvotes the rare loss pixels from far away)
 * every level shows real classes, and every level drew in under
 * 1 s (z 0 to 10, 2026-10-19; docs/PERSONAL-FORK.md, "Land cover"). The
 * ceiling is for the one level that misleads: the z 0 world tile, which a
 * view of the whole disc drapes on the photoreal tiles, draws the Arctic as
 * blocky stripes and every coast as a thick band of water. From z 1 the map
 * reads as a small-scale land cover map (minority classes such as built-up
 * areas fall out, as on any small-scale map).
 */
export const LAND_COVER_MAX_HEIGHT_M = 10_000_000;

/**
 * The Surface water modes (chips OCCURRENCE / CHANGE / SEASONALITY), three
 * bands of JRC's Global Surface Water 1.4. Pixels where water was never
 * seen are masked in the dataset, so land is transparent; zero (no change,
 * no month) is masked here too.
 *
 * Every mode is also masked by max_extent (1 wherever water was ever seen).
 * Earth Engine's coarse pyramid of a band averages only its unmasked pixels
 * and keeps the pixel wherever any is, so from orbit a country of small
 * ponds drew as one blue sheet (z 3 over Europe, 2026-10-19). max_extent's
 * coarse pixels are water only where most of the pixel is, so from far out
 * the layer shows the large lakes, rivers and coasts, and more as the view
 * comes in; at the data's own 30 m the mask is the water itself.
 */
export const SURFACE_WATER_MODES = Object.freeze([
  Object.freeze({
    key: 'occurrence',
    band: 'occurrence',
    maskBand: 'max_extent',
    mask: 'self',
    // How often water was there, 1984–2021: pale for rarely, deep blue for always.
    vis: Object.freeze({
      min: 1,
      max: 100,
      palette: Object.freeze([
        'd4f0ff',
        '8cc8f0',
        '3d8fd6',
        '0b4fa8',
        '08306b',
      ]),
    }),
    legend: Object.freeze([
      Object.freeze({ label: '1%', color: '#d4f0ff' }),
      Object.freeze({ label: '25%', color: '#8cc8f0' }),
      Object.freeze({ label: '50%', color: '#3d8fd6' }),
      Object.freeze({ label: '75%', color: '#0b4fa8' }),
      Object.freeze({ label: '100%', color: '#08306b' }),
    ]),
  }),
  Object.freeze({
    key: 'change',
    band: 'change_abs',
    maskBand: 'max_extent',
    // Signed: −100 (all water lost) to 100 (all gained); 0 is no change.
    mask: 'nonzero',
    vis: Object.freeze({
      min: -50,
      max: 50,
      palette: Object.freeze([
        'b2182b',
        'ef8a62',
        'fddbc7',
        'd1e5f0',
        '67a9cf',
        '2166ac',
      ]),
    }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Water lost', color: '#b2182b' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Little change', color: '#f3e4e4' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Water gained', color: '#2166ac' }),
    ]),
  }),
  Object.freeze({
    key: 'seasonality',
    band: 'seasonality',
    maskBand: 'max_extent',
    mask: 'self',
    vis: Object.freeze({
      min: 1,
      max: 12,
      palette: Object.freeze(['b9f2e6', '5fc4d8', '1f78b4', '0b2f7a']),
    }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '1 month a year', color: '#b9f2e6' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '6 months a year', color: '#3a9ec6' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'All year', color: '#0b2f7a' }),
    ]),
  }),
]);

/**
 * ESA WorldCover's 11 classes, their codes and the dataset's own colours
 * (the STAC record's gee:classes). Remapped to 0–10 so one palette draws them.
 */
const landClass = (value, color, label) =>
  Object.freeze({ value, color, label });
// The labels are translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js).
export const LAND_COVER_CLASSES = Object.freeze([
  landClass(10, '006400', 'Tree cover'),
  landClass(20, 'ffbb22', 'Shrubland'),
  landClass(30, 'ffff4c', 'Grassland'),
  landClass(40, 'f096ff', 'Cropland'),
  landClass(50, 'fa0000', 'Built-up'),
  landClass(60, 'b4b4b4', 'Bare / sparse vegetation'),
  landClass(70, 'f0f0f0', 'Snow and ice'),
  landClass(80, '0064c8', 'Permanent water bodies'),
  landClass(90, '0096a0', 'Herbaceous wetland'),
  landClass(95, '00cf75', 'Mangroves'),
  landClass(100, 'fae6a0', 'Moss and lichen'),
]);
const LAND_COVER_REMAP = Object.freeze({
  from: Object.freeze(LAND_COVER_CLASSES.map((entry) => entry.value)),
  to: Object.freeze(LAND_COVER_CLASSES.map((_, i) => i)),
});
const LAND_COVER_VIS = Object.freeze({
  min: 0,
  max: LAND_COVER_CLASSES.length - 1,
  palette: Object.freeze(LAND_COVER_CLASSES.map((entry) => entry.color)),
});
const LAND_COVER_LEGEND = Object.freeze(
  LAND_COVER_CLASSES.map((entry) =>
    Object.freeze({ label: entry.label, color: `#${entry.color}` }),
  ),
);
const landCoverMode = (key, image) =>
  Object.freeze({
    key,
    asset: Object.freeze({ image, band: 'Map' }),
    remap: LAND_COVER_REMAP,
    vis: LAND_COVER_VIS,
    legend: LAND_COVER_LEGEND,
  });
/** The Land cover modes: 2021 (v200) and, for comparison, 2020 (v100). */
export const LAND_COVER_MODES = Object.freeze([
  landCoverMode('v200', 'ESA/WorldCover/v200/2021'),
  landCoverMode('v100', 'ESA/WorldCover/v100/2020'),
]);

const RIVERS_NOTICE =
  'HydroSHEDS/WWF: HydroRIVERS v1 (Lehner, Verdin & Jarvis 2008, Eos 89:93) and the Free-Flowing Rivers attributes (Grill et al. 2019, Nature 569:215); names from Natural Earth (public domain) and, close in, OpenStreetMap (© OpenStreetMap contributors, ODbL)';

// --- Elevation contours ----------------------------------------------------------

/**
 * Elevation contours: lines every `step` metres of the DEM, the step
 * following the tile's zoom as the Grid's spacing follows the height
 * (500 m from orbit to 20 m at street scale; Google Earth offers 40 m and
 * 20 m). Each band names the zooms it is drawn at, so the server's `zoom`
 * variant draws every tile with its own zoom's step and source, on the
 * globe and on the photoreal tiles alike (as the Rivers do). Earth Engine
 * computes each tile at its own scale from the elevation already averaged
 * to it (aggregate, then derive): a coarse tile's lines are the coarse
 * shape of the land, not the 30 m lines thinned out. The steps keep lines
 * apart on most slopes at each zoom's pixel size (steep mountains still
 * crowd them, as on any contour map).
 *
 * The heights are the DEM stack's (src/data/demStack.js), as the Elevation
 * layer mosaics them: GMTED2010 to z 5, FABDEM from z 6, USGS 3DEP 10 m
 * from z 13 and 1 m at z 14 over the United States; ArcticDEM and REMA,
 * whose heights are ellipsoidal (30 to 60 m off the others'), only where
 * nothing else has heights (Greenland far out, north of 80° N,
 * Antarctica), so no line jumps at a source's edge. Each band of steps is cut where the stack's band
 * changes, so a tile draws from exactly the sources the terrain layers draw
 * at its zoom, and each source is resampled (bilinear) on its own grid
 * before the mosaic. Timings per band: docs/PERSONAL-FORK.md, "Elevation
 * contours".
 */
export const CONTOUR_INDEX_EVERY = 5;
const CONTOUR_MAX_ZOOM = 14;
const contourBand = (step, stack, zooms) =>
  Object.freeze({
    key: `c${step}-${stack}`,
    // The stack's band, its heights in the Elevation layer's order.
    stack,
    heights: true,
    step,
    zooms: Object.freeze(zooms),
    auto: true,
    // The heights at which the middle of a 1,600 px view drapes these
    // zooms (riverZoomForHeight), for the row's words.
    ...(zooms[0] > 0 ? { maxHeightM: STEP(zooms[0] - 2) } : {}),
    ...(zooms[1] < CONTOUR_MAX_ZOOM ? { minHeightM: STEP(zooms[1] - 1) } : {}),
  });
// The steps (500 m to z 7, 200 m to z 9, 100 m to z 11, 40 m at z 12, 20 m
// from z 13) cut by the stack's bands (far to z 5, base to z 10, polar to
// z 12, fine at z 13, finest from z 14).
export const CONTOUR_BANDS = Object.freeze([
  contourBand(500, 'far', [0, 5]),
  contourBand(500, 'base', [6, 7]),
  contourBand(200, 'base', [8, 9]),
  contourBand(100, 'base', [10, 10]),
  contourBand(100, 'polar', [11, 11]),
  contourBand(40, 'polar', [12, 12]),
  contourBand(20, 'fine', [13, 13]),
  contourBand(20, 'finest', [14, CONTOUR_MAX_ZOOM]),
]);

/** The contour step (m) drawn at a tile zoom. */
export function contourStepForZoom(z) {
  const zoom = Math.max(0, Math.floor(Number(z) || 0));
  return (
    CONTOUR_BANDS.find((band) => zoom >= band.zooms[0] && zoom <= band.zooms[1])
      ?.step ?? CONTOUR_BANDS[CONTOUR_BANDS.length - 1].step
  );
}

const ELEVATION_CONTOURS = Object.freeze({
  id: 'ee-elevation-contours',
  name: 'Elevation contours',
  kind: 'image',
  variants: CONTOUR_BANDS,
  // The terrain layers' credits, source name and depth (demStack.js).
  demStack: true,
  // Maps are made when a tile asks for them (8 bands × 2 inks).
  lazyMaps: true,
  contour: Object.freeze({
    indexEvery: CONTOUR_INDEX_EVERY,
    minorShare: 0.55,
    // A smooth surface between the DEM's cells: nearest-neighbour cells
    // drew staircase lines at z 13 and 14.
    resample: 'bilinear',
  }),
  // The boundaries' and the Rivers' inks.
  inks: RIVER_INKS,
  legend: Object.freeze([
    // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
    Object.freeze({ label: 'Contour', color: '#ffffff' }),
    // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
    Object.freeze({ label: 'Index contour', color: '#ffffff' }),
  ]),
  attribution: DEM_NOTICE,
  maxZoom: CONTOUR_MAX_ZOOM,
});

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

// --- Inundation history --------------------------------------------------------

/**
 * The Global Flood Database v1 (GLOBAL_FLOOD_DB/MODIS_EVENTS/V1): 913 flood
 * events, 2000–2018, mapped from MODIS at 250 m, one image per event with
 * the event's maximum extent (`flooded`, 1 or 0), its days under water
 * (`duration`) and the JRC permanent water inside it (`jrc_perm_water`).
 * A mode sums one band over every event, less the share of each pixel that
 * is permanent water (summedNode, server/providers/earthEngine.js). Every
 * band is pyramided by MEAN (read from the asset, 2026-10-19), so a coarse
 * pixel is each event's flooded fraction summed: a count averaged over the
 * pixel, which reads sensibly from orbit, and the tiles drew in under 7 s
 * at z 0 to 3 (docs/PERSONAL-FORK.md, "Inundation history").
 */
const FLOOD_EVENTS = 'GLOBAL_FLOOD_DB/MODIS_EVENTS/V1';
const floodAsset = (sum) =>
  Object.freeze({
    collection: FLOOD_EVENTS,
    sum,
    lessShareOf: 'jrc_perm_water',
  });
export const FLOOD_MODES = Object.freeze([
  Object.freeze({
    key: 'count',
    asset: floodAsset('flooded'),
    // Under a tenth of a flood (a sliver of a far pixel, once) is not drawn.
    atLeast: 0.1,
    vis: Object.freeze({
      min: 0.1,
      max: 10,
      palette: Object.freeze([
        'c6e6f5',
        '74b9e3',
        '2b7bc4',
        '0b3d91',
        '2a0b5e',
      ]),
    }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Once', color: '#c6e6f5' }),
      Object.freeze({ label: '3', color: '#2b7bc4' }),
      Object.freeze({ label: '10+', color: '#2a0b5e' }),
    ]),
  }),
  Object.freeze({
    key: 'duration',
    asset: floodAsset('duration'),
    // Days under water over all events, drawn on a log scale: 1 to 300+.
    atLeast: 1,
    log10: true,
    vis: Object.freeze({
      min: 0,
      max: 2.5,
      palette: Object.freeze([
        'fee8c8',
        'fdbb84',
        'e34a33',
        'b30000',
        '4d0000',
      ]),
    }),
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '1 day', color: '#fee8c8' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '10 days', color: '#fdbb84' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '100 days', color: '#b30000' }),
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: '300+ days', color: '#4d0000' }),
    ]),
  }),
]);
// --- Census tracts ---------------------------------------------------------------

/**
 * Census tracts: TRACTS draws TIGER/Line 2020's 85,528 tract outlines in
 * the boundaries' inks (Earth Engine); HOUSEHOLD INCOME and SURFACE
 * TEMPERATURE fill the 2024 cartographic boundary tracts by their ACS
 * median household income or their summer land surface temperature,
 * drawn by the local server (`local: 'census'`, server/providers/census.js,
 * built by `npm run census:build`; the income needs CENSUS_API_KEY, the
 * temperature Earth Engine, once). Tracts hold
 * about 4,000 people, a kilometre or two across in a city: they are drawn
 * below TRACT_MAX_HEIGHT_M, where the middle of the view is z 9 (300 m
 * pixels), and Earth Engine's outline tiles start at z 7, the first level
 * that answers in about a second (z 3 to 5 took 4 to 21 s, live
 * 2026-10-19; docs/PERSONAL-FORK.md, "Census tracts").
 */
export const TRACT_MAX_HEIGHT_M = Math.round(STEP(7));
const TRACT_INKS = Object.freeze({ light: 'ffffffaa', dark: '1a1a1aaa' });
export const CENSUS_TRACT_MODES = Object.freeze([
  Object.freeze({
    key: 'tracts',
    legend: Object.freeze([
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      Object.freeze({ label: 'Tract', color: '#ffffff', ink: true }),
    ]),
  }),
  Object.freeze({ key: 'income', local: 'census', legend: INCOME_LEGEND }),
  // The June–August 2018–2023 Landsat surface temperature per tract,
  // computed once by `npm run census:build` (scripts/census/lst.mjs).
  Object.freeze({ key: 'lst', local: 'census', legend: LST_LEGEND }),
]);

const FLOOD_NOTICE =
  'Global Flood Database v1 (Tellman et al. 2021, Nature 596:80, doi:10.1038/s41586-021-03695-w), Cloud to Street and the Dartmouth Flood Observatory, CC BY-NC 4.0';

// --- Buildings ----------------------------------------------------------------

/** Google Open Buildings 2.5D Temporal: the latest year it has. */
export const OPEN_BUILDINGS_YEAR = 2023;
const OPEN_BUILDINGS_RASTER = Object.freeze({
  collection: 'GOOGLE/Research/open-buildings-temporal/v1',
  year: OPEN_BUILDINGS_YEAR,
});
/**
 * Buildings per km² from a pixel's fractional count: the bands are on a
 * 0.5 m grid (0.25 m² a pixel) and MEAN-pyramided, so at every level a
 * pixel's mean count × 4,000,000 is the buildings per km² beneath it
 * (Lagos 2023, a 1 km box: about 2,400).
 */
export const BUILDINGS_PER_KM2 = 4_000_000;
/**
 * Footprints: Open Buildings v3's polygons with a confidence of at least
 * 0.7 (the dataset suggests 0.65 to 0.75 for its precision), drawn over
 * the mode from z 15: their tiles took 3.0 to 7.6 s at z 14 to 17 and 5 to
 * 11 s at z 13, where z 11 timed out past 30 s (Jakarta), measured
 * 2026-10-19. At z 15 a 4.8 m pixel shows a house's shape.
 */
export const BUILDINGS_FOOTPRINT_ZOOM = 15;
const BUILDINGS_MAX_ZOOM = 17;
const BUILDINGS_FOOTPRINTS = Object.freeze({
  table: 'GOOGLE/Research/open-buildings/v3/polygons',
  filter: Object.freeze({ property: 'confidence', atLeast: 0.7 }),
  width: 1,
});
/**
 * The Buildings bands, by tile zoom (the server's `zoom` variant): the
 * raster alone to z 14, the raster with footprints from z 15.
 */
export const BUILDINGS_BANDS = Object.freeze([
  Object.freeze({
    key: 'raster',
    asset: OPEN_BUILDINGS_RASTER,
    zooms: Object.freeze([0, BUILDINGS_FOOTPRINT_ZOOM - 1]),
    auto: true,
    minHeightM: STEP(BUILDINGS_FOOTPRINT_ZOOM - 2),
  }),
  Object.freeze({
    key: 'footprints',
    asset: OPEN_BUILDINGS_RASTER,
    overlay: BUILDINGS_FOOTPRINTS,
    zooms: Object.freeze([BUILDINGS_FOOTPRINT_ZOOM, BUILDINGS_MAX_ZOOM]),
    auto: true,
    maxHeightM: STEP(BUILDINGS_FOOTPRINT_ZOOM - 2),
  }),
]);
/** RdPu: a ramp apart from Population's YlOrRd and Land cover's built-up red. */
const BUILDINGS_PALETTE = Object.freeze([
  'fcc5c0',
  'fa9fb5',
  'f768a1',
  'c51b8a',
  '7a0177',
]);
/** Viridis for height, read as a quantity rather than a density. */
const BUILDING_HEIGHT_PALETTE = Object.freeze([
  '440154',
  '3b528b',
  '21918c',
  '5ec962',
  'fde725',
]);
const swatches = (palette, labels) =>
  Object.freeze(
    labels.map((label, i) => Object.freeze({ label, color: `#${palette[i]}` })),
  );
/**
 * The Buildings modes (chips COUNT / COVER / HEIGHT), every band
 * MEAN-pyramided, so each mode is the same quantity at every zoom:
 * - COUNT (the default): buildings per km² (BUILDINGS_PER_KM2), log scale,
 *   1 to 10,000+; it reads at every zoom, from orbit too;
 * - COVER: building_presence, the share of the ground built on (a 1 km box
 *   in Lagos 2023: 35%), 2% to 50%+. From orbit only cities show: a z 3
 *   pixel (20 km) is under 2% built almost everywhere else;
 * - HEIGHT: building_height ÷ building_presence, Σ height / Σ presence over
 *   the pixel at every zoom, so roughly the mean height of what is built
 *   there. Height is predicted off buildings too (11 to 22% of the pixels
 *   with presence under 0.1 had some, in 1 km boxes over Lagos, Jakarta and
 *   São Paulo), so this reads 28 to 50% above the mean height of pixels
 *   with presence over 0.5 there (10.1 against 7.9 m, 24.9 against 16.6 m,
 *   31.8 against 23.7 m); the plain mean over the ground (3.5, 5.8, 10.5 m)
 *   would be half the buildings' height. Masked where under 5% is built.
 */
export const BUILDINGS_MODES = Object.freeze([
  Object.freeze({
    key: 'count',
    band: 'building_fractional_count',
    scale: BUILDINGS_PER_KM2,
    atLeast: 1,
    log10: true,
    vis: Object.freeze({ min: 0, max: 4, palette: BUILDINGS_PALETTE }),
    legend: swatches(BUILDINGS_PALETTE, [
      '1',
      '10',
      '100',
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      '1,000',
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      '10,000+ per km²',
    ]),
  }),
  Object.freeze({
    key: 'cover',
    band: 'building_presence',
    atLeast: 0.02,
    vis: Object.freeze({ min: 0, max: 0.5, palette: BUILDINGS_PALETTE }),
    legend: swatches(BUILDINGS_PALETTE, ['2%', '10%', '20%', '35%', '50%+']),
  }),
  Object.freeze({
    key: 'height',
    band: 'building_height',
    perBand: Object.freeze({ band: 'building_presence', atLeast: 0.05 }),
    vis: Object.freeze({ min: 0, max: 30, palette: BUILDING_HEIGHT_PALETTE }),
    legend: swatches(BUILDING_HEIGHT_PALETTE, [
      '3',
      '8',
      '15',
      '22',
      // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
      '30+ m',
    ]),
  }),
]);
const BUILDINGS_NOTICE = `Google Open Buildings 2.5D Temporal v1, ${OPEN_BUILDINGS_YEAR} (CC BY 4.0; Sirko et al. 2023; contains modified Copernicus Sentinel-2 data) and Open Buildings v3 polygons (CC BY 4.0; Sirko et al. 2021)`;

const BUILDINGS = Object.freeze({
  id: 'ee-buildings',
  name: 'Buildings',
  kind: 'image',
  variants: BUILDINGS_BANDS,
  modes: BUILDINGS_MODES,
  modeStorageKey: 'gev.buildings.mode',
  // 2 bands × 3 modes × 2 inks: made when a tile asks.
  lazyMaps: true,
  // The footprints' ink; the raster is the same in both.
  inks: RIVER_INKS,
  coverage: Object.freeze({
    key: 'open-buildings',
    boxes: OPEN_BUILDINGS_BOXES,
  }),
  // Outside the boxes: Overture's buildings, when the local build has them
  // (src/layers/earthEngine/overtureBuildings.js).
  overture: true,
  legend: BUILDINGS_MODES[0].legend,
  attribution: BUILDINGS_NOTICE,
  maxZoom: BUILDINGS_MAX_ZOOM,
});

// --- Tree canopy --------------------------------------------------------------

/**
 * Canopy height in metres, 0 where there is none (masked). Both sources are
 * MEAN-pyramided, zero included, so a coarse pixel is the mean height over
 * the ground beneath it, gaps and all (a forest's stand height reads lower
 * than its trees from far out). The share of ground above a height (canopy
 * cover) is not on offer: a mean pyramid of heights cannot give it, and
 * deriving it from the 1 m pixels is a precomputed pyramid's job. Meta's
 * band is an integer, so a coarse pixel whose mean is under 1 m (dry
 * savanna, East Africa at z 2) is 0 and clear. Every
 * tile of both took under 0.7 s, z 0 to 14 (Congo basin and the Pacific
 * Northwest, 2026-10-19), so Meta's 1 m map draws from orbit with no far
 * fallback.
 */
const CANOPY_PALETTE = Object.freeze([
  'f7fcb9',
  'addd8e',
  '41ab5d',
  '006837',
  '00321a',
]);
const CANOPY_VIS = Object.freeze({ min: 0, max: 40, palette: CANOPY_PALETTE });
const CANOPY_LEGEND = swatches(CANOPY_PALETTE, [
  '2',
  '10',
  '20',
  '30',
  // i18n-ignore: translated through LEGEND_WORDS (src/layers/earthEngine/presentation.js)
  '40+ m',
]);
/**
 * The Tree canopy modes (chips META 1 m / ETH 10 m). Meta's reads lower in
 * tall tropical forest (a 1 km box in the Congo basin: 22.6 m mean against
 * ETH's 32.7 m; the Pacific Northwest: 10.3 against 20.0), so the second is
 * there to compare, not to blend.
 */
export const CANOPY_MODES = Object.freeze([
  Object.freeze({
    key: 'meta',
    asset: Object.freeze({
      collection: 'projects/meta-forest-monitoring-okw37/assets/CanopyHeight',
      band: 'cover_code',
    }),
    mask: 'self',
    vis: CANOPY_VIS,
    legend: CANOPY_LEGEND,
  }),
  Object.freeze({
    key: 'eth',
    asset: Object.freeze({
      image: 'users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1',
      band: 'b1',
    }),
    mask: 'self',
    vis: CANOPY_VIS,
    legend: CANOPY_LEGEND,
  }),
]);
const CANOPY_NOTICE =
  'Meta and World Resources Institute, High Resolution Canopy Height Maps 1 m (CC BY 4.0; Tolan et al. 2024, Remote Sensing of Environment 300). ETH: Global Canopy Height 2020, 10 m (CC BY 4.0; Lang et al. 2023, Nature Ecology & Evolution 7)';

const TREE_CANOPY = Object.freeze({
  id: 'ee-tree-canopy',
  name: 'Tree canopy',
  kind: 'image',
  asset: CANOPY_MODES[0].asset,
  modes: CANOPY_MODES,
  modeStorageKey: 'gev.treeCanopy.mode',
  lazyMaps: true,
  legend: CANOPY_LEGEND,
  attribution: CANOPY_NOTICE,
  maxZoom: 16,
});

/**
 * Below these camera heights REGIONS and DISTRICTS draw Overture's region
 * and county lines (where built and where the view has them) in place of
 * FAO GAUL 2025.
 * - GAUL's coasts and shore-following lines are generalised: hundreds of
 *   metres to about a kilometre off the imagery (Baltimore's harbour). On
 *   a 1,600 px canvas a pixel is about the camera height / 1,400, so that
 *   error starts to show below about 1,400 km.
 * - Overture's county lines are built from z 7, which a 1,000 px canvas
 *   drapes from about 1,050 km down: DISTRICTS switches at 1,000 km, and
 *   so does AUTO's district level (below 800 km).
 * - Region lines are built from z 4 (about 8,500 km on that canvas):
 *   REGIONS switches at 5,000 km, where AUTO hands the countries over.
 */
export const OVERTURE_REGIONS_BELOW_M = 5_000_000;
export const OVERTURE_DISTRICTS_BELOW_M = 1_000_000;

export const EARTH_ENGINE_LAYERS = Object.freeze([
  Object.freeze({
    id: 'ee-terrain-slope',
    name: 'Terrain slope',
    kind: 'image',
    ...demLayer(),
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
    maxZoom: DEM_MAX_ZOOM,
  }),
  Object.freeze({
    id: 'ee-terrain-aspect',
    name: 'Terrain aspect',
    kind: 'image',
    ...demLayer(),
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
    maxZoom: DEM_MAX_ZOOM,
  }),
  Object.freeze({
    id: 'ee-terrain-hillshade',
    name: 'Hillshade',
    kind: 'image',
    ...demLayer(),
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
    maxZoom: DEM_MAX_ZOOM,
  }),
  // Elevation: a hypsometric tint of the same stack, its ellipsoidal polar
  // sources only beneath the others (heights). Shown by the square root of
  // the height above sea level, so the lowlands, where most land is, get as
  // many colours as the mountains: the stops are at 0, 100, 400, 900, 1,600,
  // 2,500, 3,600, 4,900 and 6,400 m. A tint shows no more at 1 m than at
  // 7 m, so it stops at z 14.
  Object.freeze({
    id: 'ee-elevation',
    name: 'Elevation',
    kind: 'image',
    ...demLayer(true),
    transform: 'sqrt',
    vis: Object.freeze({
      min: 0,
      max: 80,
      palette: Object.freeze([
        '2b6a2e',
        '5f9a3c',
        'a9c15f',
        'e8dc8a',
        'd2a564',
        'a66a3e',
        '8a5a44',
        'c9c3bd',
        'ffffff',
      ]),
    }),
    legend: Object.freeze([
      Object.freeze({ label: '0 m', color: '#2b6a2e' }),
      Object.freeze({ label: '400 m', color: '#a9c15f' }),
      Object.freeze({ label: '1,600 m', color: '#d2a564' }),
      Object.freeze({ label: '3,600 m', color: '#8a5a44' }),
      Object.freeze({ label: '6,400 m+', color: '#ffffff' }),
    ]),
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
      // While Overture's country lines are built
      // (`npm run overture:boundaries`), the local server draws them in
      // place of LSIB, and AUTO draws them too from `localAutoAboveM` up.
      Object.freeze({
        key: 'level0',
        asset: Object.freeze({ table: 'USDOS/LSIB/2017' }),
        local: 'overture-boundaries',
        localAutoAboveM: 5_000_000,
      }),
      // On AUTO: states and provinces from far out; districts closer in.
      // Tiles at z 8 and coarser (AUTO above 800 km, and REGIONS from far
      // out) draw GAUL's 500 m simplified table instead: one feature per
      // unit like the full one, its lines within a pixel of the full
      // table's, and a cold z 3 tile in a median 1.2 s against 2.5 s (worst
      // 2.0 s against 9.7 s; 2026-10-22). Its smallest islands collapse to
      // points, which `pointSize: 0` leaves undrawn.
      // While Overture's region and county lines are built, REGIONS draws
      // them below `localBelowM`, and DISTRICTS below its own, wherever the
      // view's cell has lines of that level (Brazil has no county lines);
      // GAUL above and elsewhere (OVERTURE_REGIONS_BELOW_M).
      Object.freeze({
        key: 'level1',
        asset: Object.freeze({ table: 'FAO/GAUL/2025/level1' }),
        coarse: Object.freeze({
          table: 'FAO/GAUL_SIMPLIFIED_500m/2025/level1',
          maxZoom: 8,
          pointSize: 0,
        }),
        auto: true,
        minHeightM: 800_000,
        local: 'overture-boundaries',
        localSet: 'regions',
        localBelowM: OVERTURE_REGIONS_BELOW_M,
      }),
      Object.freeze({
        key: 'level2',
        asset: Object.freeze({ table: 'FAO/GAUL/2025/level2' }),
        auto: true,
        maxHeightM: 800_000,
        local: 'overture-boundaries',
        localSet: 'districts',
        localBelowM: OVERTURE_DISTRICTS_BELOW_M,
      }),
    ]),
    style: Object.freeze({
      color: 'ffffffcc',
      fillColor: '00000000',
      width: 1,
    }),
    // White on imagery and dark styles; near-black on the white globe,
    // Positron, the light Stamen styles and the light Countries maps.
    inks: BOUNDARY_INKS,
    // Personal fork: Overture's division areas (`npm run overture:areas`):
    // a click's card, FILLS and COASTS.
    areas: true,
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
  // Surface water: JRC's 38-year record of where water was, one image band
  // per mode; occurrence averages sensibly, so it draws from orbit.
  Object.freeze({
    id: 'ee-surface-water',
    name: 'Surface water',
    kind: 'image',
    asset: SURFACE_WATER,
    modes: SURFACE_WATER_MODES,
    modeStorageKey: 'gev.surfaceWater.mode',
    legend: SURFACE_WATER_MODES[0].legend,
    attribution: SURFACE_WATER_NOTICE,
    maxZoom: 13,
  }),
  // Land cover: ESA WorldCover's classes; categorical, so it keeps a ceiling.
  Object.freeze({
    id: 'ee-land-cover',
    name: 'Land cover',
    kind: 'image',
    asset: LAND_COVER_MODES[0].asset,
    modes: LAND_COVER_MODES,
    modeStorageKey: 'gev.landCover.mode',
    legend: LAND_COVER_LEGEND,
    attribution: LAND_COVER_NOTICE,
    maxZoom: 14,
    maxHeightM: LAND_COVER_MAX_HEIGHT_M,
  }),
  ELEVATION_CONTOURS,
  BUILDINGS,
  TREE_CANOPY,
  Object.freeze({
    id: 'ee-census-tracts',
    name: 'Census tracts',
    kind: 'features',
    variants: Object.freeze([
      Object.freeze({
        key: 'tracts',
        asset: Object.freeze({ table: 'TIGER/2020/TRACT' }),
        minZoom: 7,
      }),
    ]),
    modes: CENSUS_TRACT_MODES,
    modeStorageKey: 'gev.censusTracts.mode',
    style: Object.freeze({
      color: TRACT_INKS.light,
      fillColor: '00000000',
      width: 1,
    }),
    inks: TRACT_INKS,
    legend: CENSUS_TRACT_MODES[0].legend,
    attribution:
      'U.S. Census Bureau: TIGER/Line 2020 census tracts; income from the ACS 5-year 2020–2024 estimates and the 2024 cartographic boundaries (public domain); summer surface temperature from Landsat 8 and 9 Collection 2 (USGS), on land by JRC Global Surface Water 1.4 (Source: EC JRC/Google). This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau',
    maxZoom: 14,
    maxHeightM: TRACT_MAX_HEIGHT_M,
  }),
  // Inundation history: how often, and how long, floods covered the ground.
  Object.freeze({
    id: 'ee-inundation',
    name: 'Inundation history',
    kind: 'image',
    asset: FLOOD_MODES[0].asset,
    modes: FLOOD_MODES,
    modeStorageKey: 'gev.inundation.mode',
    legend: FLOOD_MODES[0].legend,
    attribution: FLOOD_NOTICE,
    // 250 m pixels: z 10 is about 150 m.
    maxZoom: 10,
  }),
]);

/** A layer's modes: the keys of its `modes`, else one ('default'). */
export function layerModes(layer) {
  // A mode drawn by a local server (`local`: the Census tracts' income) has
  // no Earth Engine map.
  const modes = (layer?.modes || []).filter((mode) => !mode.local);
  return modes.length ? modes.map((mode) => mode.key) : ['default'];
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
