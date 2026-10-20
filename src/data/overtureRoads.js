// Personal fork: the Roads layer's classes, levels, modes and colours,
// shared by the build (scripts/overture/roads.mjs), the tile server
// (server/providers/overture/roadsTiles.js) and the layer. Not part of
// upstream God's Eye View.

export const OVERTURE_ROADS_ENDPOINT = '/api/roads';
/** What docs.overturemaps.org/attribution asks of the transportation theme (ODbL). */
export const OVERTURE_ROADS_ATTRIBUTION =
  '© OpenStreetMap contributors. Available under the Open Database License. Data from TomTom. Overture Maps Foundation';
/** The deepest tile the layer asks for (z 17: 1.2 m pixels). */
export const OVERTURE_ROADS_MAX_ZOOM = 17;

/**
 * Road classes (Overture's transportation `class` for subtype road), by
 * code, with the tile zoom each is drawn from (the camera heights the
 * layer's brief names: motorways and trunks from orbit, primary roads from
 * about 1,000 km (z 7), secondary and tertiary from about 300 km (z 9),
 * residential streets from about 50 km (z 12), service roads and paths
 * from about 10 km (z 14)), its width in pixels at the zoom it starts and
 * at z 17, and its NETWORK colour on a dark map (the light ink) and on a
 * light one (the dark ink).
 */
const roadClass = (code, key, minZoom, widths, onDark, onLight, group) =>
  Object.freeze({
    code,
    key,
    minZoom,
    widths: Object.freeze(widths),
    onDark,
    onLight,
    group,
  });
export const ROAD_CLASSES = Object.freeze([
  roadClass(1, 'motorway', 0, [1.2, 9], 'ff7a45', 'd9481c', 'major'),
  roadClass(2, 'trunk', 0, [1, 8], 'ffa64d', 'e07b1a', 'major'),
  roadClass(3, 'primary', 7, [0.9, 7], 'ffd966', 'c99a0a', 'major'),
  roadClass(4, 'secondary', 9, [0.8, 6], 'fff2a8', 'a8892a', 'major'),
  roadClass(5, 'tertiary', 9, [0.7, 5], 'f2f2f2', '6e6e6e', 'minor'),
  roadClass(6, 'residential', 12, [0.6, 4], 'd9d9d9', '7a7a7a', 'minor'),
  roadClass(7, 'living_street', 12, [0.6, 4], 'd9d9d9', '7a7a7a', 'minor'),
  roadClass(8, 'unclassified', 12, [0.6, 4], 'd9d9d9', '7a7a7a', 'minor'),
  roadClass(9, 'unknown', 12, [0.5, 3], 'bfbfbf', '8c8c8c', 'minor'),
  roadClass(10, 'service', 14, [0.5, 2.5], 'b3b3b3', '969696', 'minor'),
  roadClass(11, 'pedestrian', 14, [0.5, 2.5], 'c9b3e6', '8a6bb3', 'path'),
  roadClass(12, 'footway', 14, [0.4, 1.5], 'e6b3b3', 'b36b6b', 'path'),
  roadClass(13, 'steps', 14, [0.4, 1.5], 'e6b3b3', 'b36b6b', 'path'),
  roadClass(14, 'cycleway', 14, [0.5, 2], '66ccff', '1a73b3', 'path'),
  roadClass(15, 'path', 14, [0.4, 1.5], 'd9bf8c', '8c6b33', 'path'),
  roadClass(16, 'track', 14, [0.4, 1.5], 'd9bf8c', '8c6b33', 'path'),
  roadClass(17, 'bridleway', 14, [0.4, 1.5], 'd9bf8c', '8c6b33', 'path'),
]);
const BY_KEY = new Map(ROAD_CLASSES.map((entry) => [entry.key, entry]));
const BY_CODE = new Map(ROAD_CLASSES.map((entry) => [entry.code, entry]));
export const roadClassByKey = (key) => BY_KEY.get(key) || null;
export const roadClassByCode = (code) => BY_CODE.get(code) || null;
/** Links (ramps) are drawn from z 9, with the secondary roads, whatever their class. */
export const LINK_MIN_ZOOM = 9;

/** Flag bits of a segment. */
export const ROAD_FLAGS = Object.freeze({
  bridge: 1,
  tunnel: 2,
  link: 4,
  construction: 8,
  /** Bicycles designated (a cycleway, or a path signed for bikes). */
  bikeDesignated: 16,
  /** Bicycles allowed by a sign or tag (not just by default). */
  bikeAllowed: 32,
  /** The speed limit is in miles an hour. */
  mph: 64,
  /** Bicycles denied. */
  bikeDenied: 128,
});

/** Overture's `subclass`, by code (0 none). */
export const ROAD_SUBCLASSES = Object.freeze([
  '',
  'link',
  'sidewalk',
  'crosswalk',
  'parking_aisle',
  'driveway',
  'alley',
  'cycle_crossing',
]);

/** Overture's `road_surface` values, by code (0 not given). */
export const ROAD_SURFACES = Object.freeze([
  '',
  'paved',
  'paving_stones',
  'metal',
  'unpaved',
  'gravel',
  'dirt',
  'unknown',
]);
/** A surface code's SURFACE mode group: 'paved', 'unpaved' or 'unknown'. */
export const surfaceGroup = (code) =>
  code >= 1 && code <= 3
    ? 'paved'
    : code >= 4 && code <= 6
      ? 'unpaved'
      : 'unknown';

/** Where a segment's data came from, by code. */
export const ROAD_SOURCES = Object.freeze(['OpenStreetMap', 'TomTom', 'other']);

/** km/h in a mile an hour. */
export const KMH_PER_MPH = 1.609344;

/**
 * The stored levels. Tiles from `from` to `to` read the level; it holds
 * the classes drawn by `to`, its coordinates on a grid of 2^bits a world
 * side (a quarter pixel at `to`; the last level Overture's own 0.15 m),
 * simplified to half a pixel at `to`, in blocks of z `block` tiles (a
 * tile at `from` is a block or half of one), the blocks kept in files of
 * z `container` tiles. A line is cut into pieces no longer than a quarter
 * of a block, each kept in the block holding its ends' middle, so every
 * point of it is within an eighth of a block of that block
 * (ROAD_BLOCK_MARGIN): a tile reads the blocks it meets, widened by that.
 */
export const ROAD_LEVELS = Object.freeze(
  [
    { from: 0, to: 4, bits: 14, block: 2, container: 0 },
    { from: 5, to: 6, bits: 16, block: 4, container: 0 },
    { from: 7, to: 8, bits: 18, block: 6, container: 6 },
    { from: 9, to: 11, bits: 21, block: 8, container: 6 },
    { from: 12, to: 13, bits: 23, block: 11, container: 6 },
    {
      from: 14,
      to: OVERTURE_ROADS_MAX_ZOOM,
      bits: 28,
      block: 13,
      container: 6,
    },
  ].map((level, index) => Object.freeze({ index, ...level })),
);
/** A piece's longest, as a share of its block's side. */
export const ROAD_PIECE_SHARE = 1 / 4;
/** How far past its block a piece may reach, as a share of the block's side. */
export const ROAD_BLOCK_MARGIN = ROAD_PIECE_SHARE / 2;
/** The level a tile zoom reads. */
export const roadLevelForZoom = (z) =>
  ROAD_LEVELS.find((level) => z >= level.from && z <= level.to) ||
  ROAD_LEVELS[ROAD_LEVELS.length - 1];

/** The zoom a segment is drawn from: its class's, links from LINK_MIN_ZOOM. */
export function segmentMinZoom(code, flags) {
  const entry = roadClassByCode(code);
  if (!entry) return 99;
  return flags & ROAD_FLAGS.link
    ? Math.max(entry.minZoom, LINK_MIN_ZOOM)
    : entry.minZoom;
}

/** A class's width in pixels at a tile zoom: from its first width where it starts to its last at z 17. */
export function roadWidth(code, z) {
  const entry = roadClassByCode(code);
  if (!entry) return 0;
  const [first, last] = entry.widths;
  const span = Math.max(1, OVERTURE_ROADS_MAX_ZOOM - entry.minZoom);
  const t = Math.max(0, Math.min(1, (z - entry.minZoom) / span));
  // Grows by a factor per zoom (as a road's real width does on the map).
  return first * (last / first) ** t;
}

/** The SPEED mode's ramp: km/h stops and colours (unknown is drawn thin and grey). */
export const SPEED_STOPS = Object.freeze([
  Object.freeze({ kmh: 0, color: '2c7bb6' }),
  Object.freeze({ kmh: 30, color: '2c7bb6' }),
  Object.freeze({ kmh: 50, color: '00a6ca' }),
  Object.freeze({ kmh: 70, color: '90eb9d' }),
  Object.freeze({ kmh: 90, color: 'f9d057' }),
  Object.freeze({ kmh: 110, color: 'f29e2e' }),
  Object.freeze({ kmh: 130, color: 'd7191c' }),
]);
export const UNKNOWN_SPEED_COLOR = Object.freeze({
  onDark: '8c8c8c',
  onLight: 'a6a6a6',
});
/** A speed's colour (km/h) on the ramp. */
export function speedColor(kmh) {
  const stops = SPEED_STOPS;
  if (kmh <= stops[0].kmh) return stops[0].color;
  for (let i = 1; i < stops.length; i++)
    if (kmh <= stops[i].kmh) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (kmh - a.kmh) / (b.kmh - a.kmh || 1);
      return [0, 2, 4]
        .map((k) => {
          const va = parseInt(a.color.slice(k, k + 2), 16);
          const vb = parseInt(b.color.slice(k, k + 2), 16);
          return Math.round(va + (vb - va) * t)
            .toString(16)
            .padStart(2, '0');
        })
        .join('');
    }
  return stops[stops.length - 1].color;
}

/** The SURFACE mode's colours by group and ink. */
export const SURFACE_COLORS = Object.freeze({
  paved: Object.freeze({ onDark: 'e6e6e6', onLight: '4d4d4d' }),
  unpaved: Object.freeze({ onDark: 'e69a4d', onLight: 'a0521a' }),
  unknown: Object.freeze({ onDark: '7f7f7f', onLight: 'b3b3b3' }),
});

/** The layer's modes: NETWORK (classes), SPEED (the limit), SURFACE. */
export const ROAD_MODES = Object.freeze(['network', 'speed', 'surface']);
export const ROAD_INKS = Object.freeze(['light', 'dark']);

/** A segment's colour (RRGGBB) in a mode and ink ('light' draws on a dark map). */
export function segmentColor(mode, ink, { code, flags, surface, speed }) {
  // The light ink draws on a dark map.
  const shade = ink === 'dark' ? 'onLight' : 'onDark';
  if (mode === 'speed') {
    if (!speed) return UNKNOWN_SPEED_COLOR[shade];
    const kmh = flags & ROAD_FLAGS.mph ? speed * KMH_PER_MPH : speed;
    return speedColor(kmh);
  }
  if (mode === 'surface') return SURFACE_COLORS[surfaceGroup(surface)][shade];
  const entry = roadClassByCode(code);
  return entry ? entry[shade] : 'ffffff';
}

/** A speed limit for people: "55 mph" or "50 km/h", '' when none. */
export function speedLabel(speed, flags) {
  if (!speed) return '';
  return flags & ROAD_FLAGS.mph ? `${speed} mph` : `${speed} km/h`;
}
