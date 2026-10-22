/**
 * Personal fork: the Wikipedia coverage layer's catalog and tile bytes, from
 * the local server's /api/wikipedia-coverage (server/providers/
 * wikipediaCoverage.js), which reads a grid built by
 * `npm run wikipedia:build`. The catalog is kept a few minutes.
 */

export const WIKIPEDIA_COVERAGE_ENDPOINT = '/api/wikipedia-coverage';
export { WIKIPEDIA_POINTS_ENDPOINT } from '../../data/wikipediaPoints.js';
import {
  WIKIPEDIA_LANGS_ENDPOINT,
  pointWikiOfKey,
} from '../../data/wikipediaPoints.js';
/** The catalog is asked for again after this long. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;
export const VARIANT_KEYS = Object.freeze([
  'articles',
  'text',
  'count',
  'capita',
  'textcapita',
]);
export const TILE_MAGIC = 'WCT1';

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const finite = (value) => (Number.isFinite(value) ? value : null);

/** One server variant, checked on the way in, or null. */
export function toCatalogVariant(row) {
  const key = String(row?.key || '');
  if (!VARIANT_KEYS.includes(key)) return null;
  const min = finite(row?.domain?.min);
  const max = finite(row?.domain?.max);
  const available =
    row?.available === true &&
    min !== null &&
    max !== null &&
    max > min &&
    min > 0;
  return {
    key,
    available,
    ...(available
      ? { domain: { min, max, median: finite(row.domain.median) ?? min } }
      : {}),
  };
}

/** The server's catalog, checked on the way in. */
export function toCatalog(body) {
  const variants = new Map(
    (Array.isArray(body?.variants) ? body.variants : [])
      .map(toCatalogVariant)
      .filter(Boolean)
      .map((variant) => [variant.key, variant]),
  );
  // Every variant is listed, even when the server left one out.
  for (const key of VARIANT_KEYS)
    if (!variants.has(key)) variants.set(key, { key, available: false });
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message) : '',
    builtAt: body?.builtAt ? text(body.builtAt, 40) : '',
    dumpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body?.dump?.date || ''))
      ? body.dump.date
      : '',
    articles:
      Number.isInteger(body?.rows?.kept) && body.rows.kept >= 0
        ? body.rows.kept
        : 0,
    text: body?.text === true,
    maxZoom: Number.isInteger(body?.maxZoom)
      ? Math.min(14, Math.max(0, body.maxZoom))
      : 9,
    attribution: text(body?.attribution, 200),
    variants,
    // The Articles mode's dots (points/, `--points`).
    points:
      body?.points?.built === true
        ? {
            built: true,
            version: /^[0-9a-f]{12}$/.test(String(body.points.version || ''))
              ? body.points.version
              : '',
            count: Number.isInteger(body.points.points)
              ? body.points.points
              : 0,
            secondary: Number.isInteger(body.points.secondary)
              ? body.points.secondary
              : 0,
            dumpDate: /^\d{4}-\d{2}-\d{2}$/.test(
              String(body.points.dump?.date || ''),
            )
              ? body.points.dump.date
              : '',
          }
        : {
            built: false,
            message: body?.points?.message ? text(body.points.message) : '',
          },
    // The people behind the per-capita variants (population.bin).
    population:
      body?.population?.built === true
        ? {
            built: true,
            source: text(body.population.source, 80),
            total: Number.isFinite(body.population.total)
              ? body.population.total
              : 0,
            floor: Number.isFinite(body.population.floor)
              ? body.population.floor
              : 100,
          }
        : { built: false },
  };
}

/** The tile URL for a variant and tile. */
export function tileUrl(variant, z, x, y) {
  return `${WIKIPEDIA_COVERAGE_ENDPOINT}/tile/${variant}/${z}/${x}/${y}`;
}

/**
 * The Hexes mode's URL: H3 cells of a resolution for a variant in a box
 * (degrees; west > east crosses the antimeridian).
 */
export function hexUrl(res, variant, box) {
  const degrees = (value) => String(Math.round(value * 1e4) / 1e4);
  const query = new URLSearchParams({
    west: degrees(box.west),
    south: degrees(box.south),
    east: degrees(box.east),
    north: degrees(box.north),
  });
  return `${WIKIPEDIA_COVERAGE_ENDPOINT}/h3/${res}/${variant}?${query}`;
}

const POINT_CLASSES = new Set(['place', 'landmark', 'nature', 'other']);

/** A dot from the points endpoint, checked, or null. */
export function toPoint(raw) {
  const [lon, lat] = Array.isArray(raw?.at) ? raw.at.map(Number) : [];
  const id = String(raw?.id || '');
  const page = Number(raw?.page);
  const title = text(raw?.title, 255);
  if (
    !/^wp:\d+:\d+:[ps]:\d+:\d+$/.test(id) ||
    !Number.isInteger(page) ||
    !title ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return {
    id,
    page,
    title,
    ...(/^Q\d+$/.test(String(raw.qid || '')) ? { qid: raw.qid } : {}),
    ...(raw.type ? { type: text(raw.type, 32) } : {}),
    class: POINT_CLASSES.has(raw.class) ? raw.class : 'other',
    dim: Number.isFinite(raw.dim) ? raw.dim : 0,
    bytes: Number.isFinite(raw.bytes) ? raw.bytes : 0,
    secondary: raw.secondary === true,
    // Its own wiki and every wiki with an article on its item (an index of
    // several wikis); an enwiki-only article has neither.
    ...(pointWikiOfKey(raw.wiki)
      ? {
          wiki: raw.wiki,
          wikis: (Array.isArray(raw.wikis) ? raw.wikis : [raw.wiki]).filter(
            (key) => pointWikiOfKey(key),
          ),
        }
      : {}),
    at: [lon, lat],
  };
}

/** The points endpoint's URL for a box at a zoom. */
export function pointsUrl({ box, zoom, secondary = false, version = '' }) {
  const degrees = (value) => String(Math.round(value * 1e4) / 1e4);
  const query = new URLSearchParams({
    west: degrees(box.west),
    south: degrees(box.south),
    east: degrees(box.east),
    north: degrees(box.north),
    zoom: String(zoom),
  });
  if (secondary) query.set('secondary', '1');
  if (version) query.set('v', version);
  return `${WIKIPEDIA_COVERAGE_ENDPOINT}/points?${query}`;
}

/** An error from the hex endpoint, carrying the status. */
export class HexRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HexRequestError';
    this.status = status;
  }
}

/**
 * The hex endpoint's body, checked on the way in: cells as [index, value]
 * pairs with finite values, the domain, the resolution answered.
 */
export function toHexCells(body, { res, variant } = {}) {
  const min = finite(body?.domain?.min);
  const max = finite(body?.domain?.max);
  const cells = (Array.isArray(body?.cells) ? body.cells : [])
    .filter(
      (row) =>
        Array.isArray(row) &&
        /^[0-9a-f]{15}$/i.test(String(row[0] || '')) &&
        Number.isFinite(row[1]),
    )
    .map(([cell, value]) => [String(cell).toLowerCase(), value]);
  return {
    res: Number.isInteger(body?.res) ? body.res : (res ?? 0),
    variant: VARIANT_KEYS.includes(body?.variant) ? body.variant : variant,
    dumpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body?.dump?.date || ''))
      ? body.dump.date
      : '',
    domain:
      min !== null && max !== null && max > min && min > 0
        ? { min, max, median: finite(body.domain.median) ?? min }
        : null,
    cells,
  };
}

/**
 * A tile's bytes as its values: 'WCT1', width, height, dtype (uint32 LE
 * each), then Float32 values, row 0 at the north edge.
 * @param {ArrayBuffer} buffer
 * @returns {{width: number, height: number, values: Float32Array}}
 */
export function decodeTile(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16)
    throw new Error('Not a coverage tile');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== TILE_MAGIC) throw new Error('Not a coverage tile');
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const dtype = view.getUint32(12, true);
  if (dtype !== 1 || width > 4096 || height > 4096)
    throw new Error('Unknown coverage tile format');
  if (buffer.byteLength !== 16 + width * height * 4)
    throw new Error('Coverage tile truncated');
  // A copy: the values must start at a 4-byte boundary, which offset 16 is,
  // but a fresh array also frees the response buffer.
  const values = new Float32Array(width * height);
  values.set(new Float32Array(buffer, 16, width * height));
  return { width, height, values };
}

/**
 * The catalog, shared and kept CATALOG_TTL_MS.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createWikipediaCoverageSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;
  let pointsRequest = null;
  /** Summaries this session has asked for, by title (asked only on click). */
  const summaries = new Map();
  const langs = new Map();

  async function load() {
    const response = await fetchImpl(`${WIKIPEDIA_COVERAGE_ENDPOINT}/layers`, {
      credentials: 'same-origin',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return { ...toCatalog(body), at: now() };
  }

  return {
    /** @returns {Promise<object>} the catalog (a failed request throws). */
    async catalog({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < CATALOG_TTL_MS) return held;
      inflight ||= load()
        .then((catalog) => (held = catalog))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    /** The last catalog seen, if any. */
    last: () => held,
    /**
     * The Articles mode's dots for a box at a zoom; a newer question aborts
     * the one in flight. Throws a HexRequestError with the server's status.
     */
    async points({ box, zoom, secondary = false, version = '' }) {
      pointsRequest?.abort();
      const controller = new AbortController();
      pointsRequest = controller;
      try {
        const response = await fetchImpl(
          pointsUrl({ box, zoom, secondary, version }),
          { credentials: 'same-origin', signal: controller.signal },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new HexRequestError(
            response.status,
            text(body?.error || body?.message || `HTTP ${response.status}`),
          );
        return {
          zoom: Number.isInteger(body.zoom) ? body.zoom : zoom,
          saturated: body.saturated === true,
          points: (Array.isArray(body.points) ? body.points : [])
            .map(toPoint)
            .filter(Boolean),
        };
      } finally {
        if (pointsRequest === controller) pointsRequest = null;
      }
    },
    abortPoints() {
      pointsRequest?.abort();
    },
    /**
     * An article's summary (extract, thumbnail) for its card from its own
     * wiki (enwiki unless named), asked once a session per article; null
     * when Wikipedia has none.
     */
    summary(title, wiki = 'enwiki') {
      const key = `${wiki} ${title}`;
      if (!summaries.has(key))
        summaries.set(
          key,
          fetchImpl(
            `${WIKIPEDIA_COVERAGE_ENDPOINT}/summary?${new URLSearchParams(wiki === 'enwiki' ? { title } : { title, wiki })}`,
            { credentials: 'same-origin' },
          )
            .then(async (response) => {
              if (!response.ok) return null;
              const body = await response.json().catch(() => null);
              const thumb = String(body?.thumbnail?.source || '');
              return {
                description: text(body?.description, 200),
                extract: text(body?.extract, 600),
                thumbnail: /^https:\/\/upload\.wikimedia\.org\//.test(thumb)
                  ? { source: thumb }
                  : null,
              };
            })
            .catch(() => {
              summaries.delete(key);
              return null;
            }),
        );
      return summaries.get(key);
    },
    /**
     * Every wiki's article on a Wikidata item, for the card's languages:
     * [{wiki, lang, page, url}], asked once a session per item; [] when
     * the server has none.
     */
    langs(qid) {
      if (!/^Q\d+$/.test(String(qid || ''))) return Promise.resolve([]);
      if (!langs.has(qid))
        langs.set(
          qid,
          fetchImpl(
            `${WIKIPEDIA_LANGS_ENDPOINT}?${new URLSearchParams({ qid })}`,
            { credentials: 'same-origin' },
          )
            .then(async (response) => {
              if (!response.ok) return [];
              const body = await response.json().catch(() => null);
              return (Array.isArray(body?.langs) ? body.langs : [])
                .filter((entry) => pointWikiOfKey(entry?.wiki))
                .map((entry) => ({
                  wiki: entry.wiki,
                  lang: pointWikiOfKey(entry.wiki).lang,
                  page: Number(entry.page) || 0,
                  url: `https://${pointWikiOfKey(entry.wiki).host}/?curid=${encodeURIComponent(Number(entry.page) || 0)}`,
                }))
                .filter((entry) => entry.page > 0);
            })
            .catch(() => {
              langs.delete(qid);
              return [];
            }),
        );
      return langs.get(qid);
    },
    /**
     * The Hexes mode's cells for a window. Throws a HexRequestError with
     * the server's status: 413 when the window holds too many cells at
     * the resolution, 503 when the H3 grid is not built.
     * @param {{res: number, variant: string, box: object, signal?: AbortSignal}} request
     */
    async hexCells({ res, variant, box, signal }) {
      const response = await fetchImpl(hexUrl(res, variant, box), {
        credentials: 'same-origin',
        signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new HexRequestError(
          response.status,
          text(body?.message || body?.error || `HTTP ${response.status}`),
        );
      return toHexCells(body, { res, variant });
    },
  };
}
