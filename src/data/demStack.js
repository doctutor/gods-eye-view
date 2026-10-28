/**
 * Personal fork: the DEM stack, the elevation the terrain layers (slope,
 * aspect, hillshade, elevation; src/data/earthEngineLayers.js) are drawn
 * from: the best free elevation at each place and zoom. Pure data and pure
 * functions, shared by the server (which builds one Earth Engine map per
 * band: server/providers/earthEngine.js) and the client (which names the
 * source drawing under the view, credits it, and sets how deep to ask:
 * src/layers/earthEngine/index.js). docs/PERSONAL-FORK.md, "Elevation: the
 * DEM stack", has the measurements behind every number here.
 *
 * Every asset was read live with the server's service account on
 * 2026-10-19 (id, bands, pixel size, what is stored over the sea):
 * - USGS/GMTED2010_FULL (image, band mea, 7.5″ ≈ 231 m): far views. Its sea
 *   is 0, and so is all of Greenland (no data there); no Antarctica.
 * - projects/sat-io/open-datasets/FABDEM (image collection, 19,011 1° tiles,
 *   band b1, 1″ ≈ 30 m, EPSG:4326; awesome-gee-community-catalog, FABDEM
 *   V1-2): Copernicus GLO-30 with forests and buildings removed. 60° S to
 *   80° N; no Antarctica. The sea inside a land tile is 0, outside none.
 * - USGS/3DEP/10m_collection (image collection, band elevation, 1/3″ ≈
 *   10 m; the successor of the deprecated USGS/3DEP/10m image): the United
 *   States and its territories, with a few km of buffer over the borders.
 *   Water at sea level is 0.
 * - USGS/3DEP/1m (image collection, band elevation, 1 m lidar, NAVD88):
 *   patchy, by lidar project. Water is masked.
 * - UMN/PGC/ArcticDEM/V4/2m_mosaic (image, 2 m, EPSG:3413; bands elevation
 *   and datamask, 0 where the mosaic was filled from GLO-30 or is water):
 *   north of 50° N. Heights above the WGS84 ellipsoid (30 to 50 m above the
 *   others there), and a surface model (trees and buildings included).
 * - UMN/PGC/REMA/V1_1/8m (image, 8 m): Antarctica; ellipsoidal heights, sea
 *   masked.
 *
 * A source:
 *   key        the id used in maps, cache paths and credits
 *   name       what the layer's row calls it (a proper name: not translated)
 *   pixelM     its pixel, metres
 *   asset      {image | collection, band, seaIsZero?, crs?, crsTransform?,
 *              perImage?, maskBand?}; a collection is mosaicked and given
 *              its own grid (`crs`, `crsTransform`) so the terrain
 *              operations have one: another grid resamples it into lines
 *              (FABDEM and 3DEP 10 m at EPSG:4326 and a scale, live
 *              2026-10-19); `perImage`: each image is drawn in its own
 *              projection, then mosaicked (3DEP 1 m, in many UTM zones);
 *              seaIsZero masks the 0 pixels (water at sea level) first
 *   ellipsoidal true when its heights are above the ellipsoid, not the
 *              geoid: the Elevation layer keeps it beneath the others
 *   boxes      [[west, south, east, north]…] it is clipped to (null: global)
 *   covers     [[w, s, e, n]…] where it has data, for naming (default: boxes)
 *   holes      [[w, s, e, n]…] inside `covers` where it has none
 *   maxZoom    the deepest tile worth asking for over it (about 3 to 4 tile
 *              pixels to one of its pixels at its region's middle latitude)
 *   patchy     its coverage is incomplete inside its boxes (lidar)
 *   credit     the notice its terms ask for
 *   url        its page
 *
 * A band (DEM_BANDS) draws the tile zooms `zooms` from `layers`, bottom to
 * top, each {source, mask?}: 'datamask' masks a source by its own data
 * mask band (ArcticDEM: filled or water), 'land' by the base's land (where
 * FABDEM is not 0, else ArcticDEM's data mask). The heights are where the
 * zoom Cesium drapes at the middle of the view steps (the Rivers' rule,
 * riverZoomForHeight in earthEngineLayers.js).
 */

/** Cesium's drape zoom constant for a 1,600 px canvas (RIVER_ZOOM_K_M). */
export const DRAPE_ZOOM_K_M = 5.34e7;

/** The Web Mercator zoom Cesium drapes at the middle of a view from `heightM`. */
export function drapeZoomForHeight(heightM, k = DRAPE_ZOOM_K_M) {
  const height = Math.max(1, Number(heightM) || 1);
  return Math.max(0, Math.ceil(Math.log2(k / height)) + 1);
}

/** Web Mercator ground metres per tile pixel at a zoom and latitude. */
export function tilePixelM(zoom, latDeg = 0) {
  return (156_543.034 * Math.cos((Number(latDeg) * Math.PI) / 180)) / 2 ** zoom;
}

// Clip boxes stop at 85.1°: a box to the pole cannot be put into Web
// Mercator ("Can't transform (180.0,90.0)", live 2026-10-19).
const NORTH = 85.1;
const SOUTH = -85.1;

/**
 * The United States and its territories, for both 3DEP sources: the
 * conterminous states (with the Canadian shore of the Great Lakes and the
 * border towns of Mexico, where 3DEP has a few km of buffer), Alaska to
 * 141° W, its panhandle, the Aleutians west of 180°, Hawaii, Puerto Rico
 * with the US Virgin Islands, Guam with the Northern Marianas, and American
 * Samoa. Read live on 2026-10-19: 3DEP 10 m has Toronto and Vancouver
 * (buffer), not Montreal, Victoria, Tijuana, Ciudad Juárez, Monterrey,
 * Nassau, Whitehorse or Fredericton, and has Anchorage, Kodiak, Juneau,
 * Prudhoe Bay, Adak, Hawaii, Puerto Rico, the Virgin Islands, Guam and
 * American Samoa.
 */
export const US_BOXES = Object.freeze(
  [
    [-124.85, 24.4, -66.85, 49.0],
    [-180, 51.2, -141.0, 71.6],
    [-141.0, 54.6, -129.95, 60.4],
    [172.4, 51.2, 180, 53.1],
    [-160.6, 18.8, -154.7, 22.4],
    [-67.35, 17.85, -64.5, 18.55],
    [144.55, 13.2, 146.1, 20.6],
    [-171.15, -14.6, -168.1, -14.1],
  ].map((box) => Object.freeze(box)),
);
/**
 * ArcticDEM north of 60° N. Its data reach 50° N, but south of 60° FABDEM's
 * bare earth (forests removed) is the better base, and 2 m adds detail only
 * where the pixels at the zooms it draws are small (cos 60° halves them).
 */
export const ARCTIC_BOXES = Object.freeze([
  Object.freeze([-180, 60, 180, NORTH]),
]);
/** REMA south of 60° S: Antarctica. */
export const ANTARCTIC_BOXES = Object.freeze([
  Object.freeze([-180, SOUTH, 180, -60]),
]);
/** GMTED2010 has no Greenland (its mean is 0 there): ArcticDEM draws it far out. */
const GREENLAND = Object.freeze([-74, 59.5, -10.5, 84]);

const COPERNICUS_NOTICE =
  '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

const source = (record) => Object.freeze(record);

export const DEM_SOURCES = Object.freeze([
  source({
    key: 'gmted',
    name: 'GMTED2010 230 m',
    pixelM: 231,
    asset: Object.freeze({
      image: 'USGS/GMTED2010_FULL',
      band: 'mea',
      seaIsZero: true,
    }),
    boxes: null,
    covers: Object.freeze([Object.freeze([-180, -56, 180, 84])]),
    holes: Object.freeze([GREENLAND]),
    maxZoom: 10,
    credit: 'GMTED2010: USGS and NGA (public domain)',
    url: 'https://www.usgs.gov/coastal-changes-and-impacts/gmted2010',
  }),
  source({
    key: 'fabdem',
    name: 'FABDEM 30 m',
    pixelM: 30,
    asset: Object.freeze({
      collection: 'projects/sat-io/open-datasets/FABDEM',
      band: 'b1',
      seaIsZero: true,
      // Its own 1″ grid (pixel centres on whole arc-seconds): a mosaic given
      // any other grid is resampled to it and draws lines.
      crs: 'EPSG:4326',
      crsTransform: Object.freeze([
        1 / 3600,
        0,
        -180 - 1 / 7200,
        0,
        -1 / 3600,
        90 + 1 / 7200,
      ]),
    }),
    boxes: null,
    covers: Object.freeze([Object.freeze([-180, -60, 180, 80])]),
    maxZoom: 14,
    credit: `FABDEM v1-2 © University of Bristol / Fathom, CC BY-NC-SA 4.0 (Hawker et al. 2022, doi:10.1088/1748-9326/ac4d4f), built on Copernicus DEM GLO-30 (${COPERNICUS_NOTICE})`,
    url: 'https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn',
  }),
  source({
    key: 'rema',
    name: 'REMA 8 m',
    pixelM: 8,
    asset: Object.freeze({ image: 'UMN/PGC/REMA/V1_1/8m', band: 'elevation' }),
    ellipsoidal: true,
    boxes: ANTARCTIC_BOXES,
    maxZoom: 14,
    credit:
      'REMA v1.1 (Howat et al. 2019, The Cryosphere 13:665): DEMs provided by the Byrd Polar and Climate Research Center and the Polar Geospatial Center under NSF-OPP awards 1043681, 1542736, 1543501, 1559691, 1810976, and 2129685',
    url: 'https://www.pgc.umn.edu/data/rema/',
  }),
  source({
    key: 'arcticdem',
    name: 'ArcticDEM 2 m',
    pixelM: 2,
    asset: Object.freeze({
      image: 'UMN/PGC/ArcticDEM/V4/2m_mosaic',
      band: 'elevation',
      maskBand: 'datamask',
    }),
    ellipsoidal: true,
    boxes: ARCTIC_BOXES,
    maxZoom: 16,
    credit:
      'ArcticDEM v4.1 (Porter et al. 2023, doi:10.7910/DVN/3VDC4W): DEMs provided by the Polar Geospatial Center under NSF-OPP awards 1043681, 1559691, 1542736, 1810976, and 2129685',
    url: 'https://www.pgc.umn.edu/data/arcticdem/',
  }),
  source({
    key: '3dep10',
    name: 'USGS 3DEP 10 m',
    pixelM: 10,
    asset: Object.freeze({
      collection: 'USGS/3DEP/10m_collection',
      band: 'elevation',
      seaIsZero: true,
      // Its own 1/3″ grid in NAD83 (each 1° tile starts 6 pixels before
      // its degree, so they overlap by 6).
      crs: 'EPSG:4269',
      crsTransform: Object.freeze([
        1 / 10800,
        0,
        -180 - 6 / 10800,
        0,
        -1 / 10800,
        90 + 6 / 10800,
      ]),
    }),
    boxes: US_BOXES,
    maxZoom: 15,
    credit:
      'USGS 3D Elevation Program (3DEP) 1/3″ (10 m): U.S. Geological Survey (public domain)',
    url: 'https://www.usgs.gov/3d-elevation-program',
  }),
  source({
    key: '3dep1',
    name: 'USGS 3DEP 1 m',
    pixelM: 1,
    asset: Object.freeze({
      collection: 'USGS/3DEP/1m',
      band: 'elevation',
      seaIsZero: true,
      // 10 km tiles in their own UTM zones (overlapping by 6 m): no one grid
      // fits them, so each tile is drawn in its own and then mosaicked.
      perImage: true,
    }),
    boxes: US_BOXES,
    maxZoom: 17,
    patchy: true,
    credit:
      'USGS 3D Elevation Program (3DEP) 1 m lidar: U.S. Geological Survey (public domain)',
    url: 'https://www.usgs.gov/3d-elevation-program',
  }),
]);

const BY_KEY = new Map(DEM_SOURCES.map((entry) => [entry.key, entry]));
/** A source by key, or null. */
export const demSource = (key) => BY_KEY.get(key) || null;

/** The deepest zoom any source is asked for. */
export const DEM_MAX_ZOOM = Math.max(...DEM_SOURCES.map((s) => s.maxZoom));

const layer = (key, mask) =>
  Object.freeze(mask ? { source: key, mask } : { source: key });

/**
 * The bands, by tile zoom. Why these zooms (tile pixels at 40° N; 70° N for
 * the Arctic): GMTED2010 up to z 5, where FABDEM's coarse tiles take Earth
 * Engine 2 to 15 s (z 3 to 5; z 6 and finer under 1 s); FABDEM from z 6;
 * ArcticDEM on top from z 11, where a tile pixel at 70° N (26 m) is smaller
 * than FABDEM's; 3DEP 10 m from z 13 (15 m pixels at 40° N; 31 m at 37° N
 * at z 12, no finer than FABDEM); 3DEP 1 m from z 14 (7.3 m, finer than 10
 * m). Below their own bands ArcticDEM and REMA fill what the base lacks
 * (Greenland and Antarctica far out, north of 80° N and Antarctica on
 * FABDEM).
 */
export const DEM_BANDS = Object.freeze([
  Object.freeze({
    key: 'far',
    zooms: Object.freeze([0, 5]),
    layers: Object.freeze([
      layer('arcticdem', 'datamask'),
      layer('rema'),
      layer('gmted'),
    ]),
  }),
  Object.freeze({
    key: 'base',
    zooms: Object.freeze([6, 10]),
    layers: Object.freeze([
      layer('arcticdem', 'datamask'),
      layer('rema'),
      layer('fabdem'),
    ]),
  }),
  Object.freeze({
    key: 'polar',
    zooms: Object.freeze([11, 12]),
    layers: Object.freeze([
      layer('fabdem'),
      layer('rema'),
      layer('arcticdem', 'land'),
    ]),
  }),
  Object.freeze({
    key: 'fine',
    zooms: Object.freeze([13, 13]),
    layers: Object.freeze([
      layer('fabdem'),
      layer('rema'),
      layer('3dep10'),
      layer('arcticdem', 'land'),
    ]),
  }),
  Object.freeze({
    key: 'finest',
    zooms: Object.freeze([14, DEM_MAX_ZOOM]),
    layers: Object.freeze([
      layer('fabdem'),
      layer('rema'),
      layer('3dep10'),
      layer('arcticdem', 'land'),
      layer('3dep1'),
    ]),
  }),
]);

/**
 * A band's layers for a layer that draws heights (Elevation): the
 * ellipsoidal sources (ArcticDEM, REMA, 30 to 60 m off the geoid) go
 * beneath the others, masked by their own data, so they only fill where
 * nothing else has heights (Greenland far out, north of 80° N, Antarctica).
 * The terrain layers (slope, aspect, hillshade) mosaic what each source
 * gives, so a datum's offset makes no step in them.
 */
export function bandLayers(band, { heights = false } = {}) {
  const layers = band?.layers || [];
  if (!heights) return layers;
  const ellipsoidal = (entry) => demSource(entry.source)?.ellipsoidal;
  return Object.freeze([
    ...layers
      .filter(ellipsoidal)
      .map((entry) =>
        entry.source === 'arcticdem' ? layer('arcticdem', 'datamask') : entry,
      ),
    ...layers.filter((entry) => !ellipsoidal(entry)),
  ]);
}

/** A band's camera heights (1,600 px canvas): {minHeightM?, maxHeightM?}. */
export function bandHeights(band) {
  const [first, last] = band.zooms;
  const out = {};
  // z ≤ last ⇔ h ≥ K / 2^(last − 1); z ≥ first ⇔ h < K / 2^(first − 2).
  if (last < DEM_MAX_ZOOM) out.minHeightM = DRAPE_ZOOM_K_M / 2 ** (last - 1);
  if (first > 0) out.maxHeightM = DRAPE_ZOOM_K_M / 2 ** (first - 2);
  return out;
}

/** The band that draws a tile zoom (the first below the bands, the last above). */
export function bandForZoom(z) {
  return (
    DEM_BANDS.find((band) => z >= band.zooms[0] && z <= band.zooms[1]) ||
    (z < 0 ? DEM_BANDS[0] : DEM_BANDS[DEM_BANDS.length - 1])
  );
}

/** The band Cesium drapes at the middle of a view from `heightM` (1,600 px canvas). */
export const bandForHeight = (heightM) =>
  bandForZoom(drapeZoomForHeight(heightM));

/** A band by key, or null. */
export const demBand = (key) =>
  DEM_BANDS.find((band) => band.key === key) || null;

const inBox = (lat, lon, [west, south, east, north]) =>
  lat >= south && lat <= north && lon >= west && lon <= east;

/** Whether a source has data at a point (its covers, less its holes). */
export function sourceCovers(entry, lat, lon) {
  const covers = entry?.covers || entry?.boxes;
  if (covers && !covers.some((box) => inBox(lat, lon, box))) return false;
  return !(entry?.holes || []).some((box) => inBox(lat, lon, box));
}

/**
 * The sources drawing at a point in a band, top first: the ones whose
 * region holds it. `heights`: the Elevation layer's order.
 */
export function sourcesAt(lat, lon, band, { heights = false } = {}) {
  return bandLayers(band, { heights })
    .map((entry) => demSource(entry.source))
    .filter((entry) => entry && sourceCovers(entry, lat, lon))
    .reverse();
}

/**
 * What the row calls the elevation at a point: the top source there, and
 * for a patchy one (3DEP 1 m lidar, which a box cannot say is there) the
 * one beneath it as its fallback, without the words they share ("USGS 3DEP
 * 1 m" and "10 m": the row says "USGS 3DEP 1 m where lidar exists, else
 * 10 m").
 * @returns {{name: string, fallback: string|null}}
 */
export function sourceNamesAt(lat, lon, band, options) {
  const [top, next] = sourcesAt(lat, lon, band, options);
  if (!top) return { name: '', fallback: null };
  if (!top.patchy || !next) return { name: top.name, fallback: null };
  const own = top.name.split(' ');
  const words = next.name.split(' ');
  let shared = 0;
  while (shared < words.length - 1 && words[shared] === own[shared]) shared++;
  return { name: top.name, fallback: words.slice(shared).join(' ') };
}

/**
 * How every source is read where a tile's pixels are finer than its cells:
 * bilinearly, so terrain and heights magnified past a source's resolution
 * (10 m 3DEP at z 16 and 17 where there is no 1 m lidar) shade and tint
 * smoothly instead of in blocks of one cell each.
 */
export const DEM_RESAMPLE = 'bilinear';

/**
 * The heights a source may hold, metres: lower than the Dead Sea's shore
 * (−430 m) and the ellipsoidal sources' sea (about −60 m), higher than
 * Everest. Anything outside is a fill value (REMA's and others' −9999, a
 * 16-bit −32768 or 32767), masked where heights are averaged (the Blocks
 * values and style) before a source is resampled, so no fill reaches a
 * neighbour or a mean.
 */
export const VALID_HEIGHT_M = Object.freeze([-500, 9000]);

const boxesMeet = (a, b) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * The sources a band draws inside a rectangle {west, south, east, north}
 * (null: the world), bottom first: the ones to credit.
 */
export function sourcesInRect(rect, band, options) {
  const area = rect ? [rect.west, rect.south, rect.east, rect.north] : null;
  return bandLayers(band, options)
    .map((entry) => demSource(entry.source))
    .filter((entry) => {
      if (!entry) return false;
      const covers = entry.covers || entry.boxes;
      if (!area || !covers) return true;
      return covers.some((box) => boxesMeet(box, area));
    })
    .filter((entry, i, all) => all.indexOf(entry) === i);
}

/**
 * How deep to ask for tiles over a rectangle (null: the world): the
 * deepest `maxZoom` of the finest band's sources there, at most `cap`.
 */
export function maxZoomInRect(rect, cap = DEM_MAX_ZOOM) {
  const finest = DEM_BANDS[DEM_BANDS.length - 1];
  const zoom = Math.max(
    ...sourcesInRect(rect, finest).map((entry) => entry.maxZoom),
  );
  return Math.min(cap, Number.isFinite(zoom) ? zoom : cap);
}

/** The terrain layers' variants: one per band, chosen by height, drawn by zoom. */
export function demVariants({ heights = false } = {}) {
  return Object.freeze(
    DEM_BANDS.map((band) =>
      Object.freeze({
        key: band.key,
        stack: band.key,
        ...(heights ? { heights: true } : {}),
        zooms: band.zooms,
        auto: true,
        ...bandHeights(band),
      }),
    ),
  );
}

/** Every source's credit, for the layers' tooltip and the server's catalog. */
export const DEM_STACK_NOTICE = DEM_SOURCES.map(
  (entry) => `${entry.name}: ${entry.credit}`,
).join('. ');
