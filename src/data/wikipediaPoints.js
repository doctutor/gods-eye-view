// Personal fork: what the Wikipedia points build (`npm run wikipedia:build`,
// its points step), its server (/api/wikipedia-coverage/points) and the
// Wikipedia layer's Articles mode share: the type classes that rank and
// colour the dots, the zooms the index thins at, and the answers' limits.
// Not part of upstream God's Eye View.

/**
 * GeoData's `gt_type` values in four classes, the first ranked highest
 * (a world view keeps cities before landmarks before natural features
 * before the untyped): each with its code in the index and its colour.
 */
export const WIKIPEDIA_POINT_CLASSES = Object.freeze([
  Object.freeze({
    code: 1,
    key: 'place',
    types: Object.freeze([
      'city',
      'adm1st',
      'adm2nd',
      'adm3rd',
      'country',
      'state',
    ]),
    color: '#ffd166',
  }),
  Object.freeze({
    code: 2,
    key: 'landmark',
    types: Object.freeze([
      'landmark',
      'edu',
      'railwaystation',
      'airport',
      'event',
    ]),
    color: '#ef476f',
  }),
  Object.freeze({
    code: 3,
    key: 'nature',
    types: Object.freeze([
      'mountain',
      'river',
      'waterbody',
      'isle',
      'glacier',
      'forest',
    ]),
    color: '#06d6a0',
  }),
  Object.freeze({
    code: 4,
    key: 'other',
    types: Object.freeze([]),
    color: '#8ecae6',
  }),
]);
const CLASS_BY_TYPE = new Map(
  WIKIPEDIA_POINT_CLASSES.flatMap((c) => c.types.map((type) => [type, c])),
);
export const pointClassOfType = (type) =>
  CLASS_BY_TYPE.get(String(type || '').toLowerCase()) ||
  WIKIPEDIA_POINT_CLASSES[3];
/**
 * Articles about a period, a list, an event or a polity rather than a
 * place: GeoData often types them country, state or adm with a country's
 * dim, which would rank them with the places. They count as "other". A
 * republic only when numbered (the French Third Republic), so the Czech
 * and Dominican Republics stay places.
 */
export const NOT_A_PLACE_TITLE =
  /^(?:Lists? of|History of|Timeline of|Outline of|Index of|Geography of|Battle of|Siege of|Treaty of) |\s(?:period|era|dynasty|empire|campaign|offensive|rebellion|uprising|revolution)$|\b(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh)\b.*\sRepublic$/i;

/** An article's class from its GeoData type and its title. */
export function pointClassOf(type, title = '') {
  if (NOT_A_PLACE_TITLE.test(String(title || '').trim()))
    return WIKIPEDIA_POINT_CLASSES[3];
  return pointClassOfType(type);
}

export const pointClassOfCode = (code) =>
  WIKIPEDIA_POINT_CLASSES.find((c) => c.code === code) ||
  WIKIPEDIA_POINT_CLASSES[3];

export const WIKIPEDIA_POINTS_ENDPOINT = '/api/wikipedia-coverage/points';
/** The wikis a points build can union by Wikidata item (enwiki for now). */
export const WIKIPEDIA_POINT_WIKIS = Object.freeze([
  Object.freeze({ code: 1, key: 'enwiki', host: 'en.wikipedia.org' }),
]);
export const pointWikiOfCode = (code) =>
  WIKIPEDIA_POINT_WIKIS.find((wiki) => wiki.code === code) ||
  WIKIPEDIA_POINT_WIKIS[0];

/**
 * The index keeps, per tile of each zoom below WIKIPEDIA_POINTS_FULL_ZOOM,
 * its best-ranked POINTS_PER_TILE articles, so a world view is a sparse
 * splatter; from the full zoom on, every article.
 */
export const WIKIPEDIA_POINTS_FULL_ZOOM = 12;
export const WIKIPEDIA_POINTS_PER_TILE = 24;
/** The most articles one answer holds. */
export const WIKIPEDIA_POINT_LIMIT = 4_000;
/** A points box is at most this many degrees a side (a view window). */
export const WIKIPEDIA_POINTS_MAX_SPAN_DEGREES = 360;

/**
 * The tile zoom a camera height reads (z 12 at about 10 km: every article),
 * the way Cesium's imagery picks its level.
 */
export function pointZoomForHeight(heightM) {
  const height = Number.isFinite(heightM) && heightM > 0 ? heightM : 2e7;
  return Math.max(0, Math.min(16, Math.round(Math.log2(4e7 / height))));
}
