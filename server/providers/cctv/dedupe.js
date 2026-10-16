/**
 * One pin per camera. The packs overlap: directories re-host agency and
 * operator feeds (OpenCCTV lists our featured falcon cam and MDOT traffic
 * cams), USGS re-hosts National Park Service views, and OpenStreetMap,
 * Wikidata and Windy point at the same operator pages. This pass keeps the
 * best source of each camera and drops the rest.
 *
 * Cameras are taken best source first (featured, then agency packs, then
 * USGS / NPS, Windy, OpenStreetMap / Wikidata, the directory) and each is
 * compared only with the cameras already kept, so the winner of a
 * duplicate is always the better source and duplicates never chain. A
 * camera is a duplicate of a kept one when:
 *
 *   a. url    - the same feed or snapshot URL (scheme, host case and
 *               cache-busting query ignored) or the same YouTube video, within
 *               25 km;
 *   b. operator - the same operator page within 500 m;
 *   c. name   - within 30 m and the names agree (token Jaccard >= 0.5, or
 *               every word of one is in the other); never between two
 *               agency feeds (two agencies' cameras at one junction);
 *   d. directory - a directory (camindex) camera within 60 m of a camera
 *               from a pack with its own feed: the one whose name agrees,
 *               else the nearest not yet claimed this way. A directory
 *               re-hosts a camera once; several directory cameras around
 *               one of ours are a site with several views, and only one of
 *               them can be ours without a name to say so.
 *
 * Rules b-d compare cameras from different source families only (a pack,
 * and for the linked pack OSM and Wikidata separately): two views on one
 * pole in an agency pack, or two featured cams on one hub page, are two
 * cameras. URLs or operator pages shared by many cameras of one family (a
 * placeholder image, an "all our cams" page) are not evidence of anything.
 *
 * The kept camera records `alsoListedIn` (the other packs that list it) and
 * gains an operator page from a duplicate when it has none; nothing else
 * of the duplicates is merged.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

const URL_RADIUS_M = 25_000;
const OPERATOR_RADIUS_M = 500;
const NAME_RADIUS_M = 30;
const DIRECTORY_RADIUS_M = 60;
/** Grid cell edge, metres; larger than the widest grid rule (60 m). */
const CELL_M = 100;
const M_PER_DEG_LAT = 110_574;
/**
 * A URL or operator page on more cameras than this, within one family, is a
 * placeholder or a hub page (two can be one camera listed twice).
 */
const HUB_LIMIT = 2;

/** Packs of this fork that are not agency feeds; everything else is agency. */
const NON_AGENCY = new Set([
  'featured',
  'usgs-volcano',
  'nps',
  'windy',
  'linked',
  'camindex',
]);
const DIRECTORY_PACKS = new Set(['camindex']);
/** Feed types that are a camera's own picture (not just a page link). */
const OWN_FEED = new Set(['image', 'hls', 'youtube', 'mjpeg', 'video']);

export const DEDUPE_RULES = Object.freeze([
  'url',
  'operator',
  'name',
  'directory',
]);

/**
 * Lower is better: featured 0, agency 1, USGS/NPS 2, Windy 3, linked 4,
 * directory 5.
 */
export function sourceRank(source) {
  const pack = String(source?.pack || '');
  if (pack === 'featured') return 0;
  if (
    (!NON_AGENCY.has(pack) && source?.sourceKind !== 'windy') ||
    source?.feedType === 'hls'
  ) {
    // An HLS stream from a fork pack counts as an agency feed, but never
    // outranks the featured list.
    return 1;
  }
  if (pack === 'usgs-volcano' || pack === 'nps') return 2;
  if (pack === 'windy' || source?.sourceKind === 'windy') return 3;
  if (pack === 'linked') return 4;
  return 5;
}

/** The family rules b-d compare across. */
function familyOf(source) {
  const pack = String(source?.pack || '');
  return pack === 'linked' ? `linked:${source?.sourceKind || ''}` : pack;
}

const CACHE_BUSTERS = new Set([
  '_',
  't',
  'ts',
  'time',
  'timestamp',
  'cb',
  'cache',
  'cachebust',
  'cachebuster',
  'nocache',
  'rand',
  'random',
  'r',
  'rnd',
  'dummy',
  'v',
  'ver',
  'version',
  'uniq',
  'refresh',
]);

/**
 * An http(s) URL split into host (lower case, no "www.", default port
 * dropped), path (no trailing slash) and query, or null. Plain string work
 * rather than the URL parser: the pass meets 80,000+ URLs per refresh, and
 * the values are normalized sources (already checked URLs).
 */
const HTTP_URL =
  /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)(?::(\d+))?([^?#]*)(?:\?([^#]*))?/i;
function splitHttpUrl(value) {
  if (typeof value !== 'string' || value.length < 8) return null;
  const match = HTTP_URL.exec(value.trim());
  if (!match) return null;
  let host = match[1].toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const port =
    match[2] && match[2] !== '80' && match[2] !== '443' ? `:${match[2]}` : '';
  let path = match[3] || '/';
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { host: host + port, path, query: match[4] || '' };
}

/** A feed URL as a comparison key, or ''. */
export function normalizeFeedUrl(value) {
  const url = splitHttpUrl(value);
  if (!url) return '';
  if (!url.query) return url.host + url.path;
  const params = [];
  for (const pair of url.query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const val = eq < 0 ? '' : pair.slice(eq + 1);
    if (CACHE_BUSTERS.has(name.toLowerCase()) || /^\d{9,}$/.test(val)) continue;
    params.push(pair);
  }
  params.sort();
  return params.length
    ? `${url.host}${url.path}?${params.join('&')}`
    : url.host + url.path;
}

/** An operator page as a comparison key (fragment and query dropped), or ''. */
export function normalizeOperatorUrl(value) {
  const url = splitHttpUrl(value);
  // A site's front page names no camera.
  if (!url || url.path === '/') return '';
  return url.host + url.path.toLowerCase();
}

const YOUTUBE_ID =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

/** Every key rule a matches on: feed URLs and the YouTube video. */
export function feedKeys(source) {
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  const url = source?.url;
  const snapshot = source?.snapshotUrl;
  for (const value of snapshot === url ? [url] : [url, snapshot]) {
    const text = typeof value === 'string' ? value : '';
    if (!text) continue;
    if (text.includes('youtu')) {
      const youtube = YOUTUBE_ID.exec(text);
      if (youtube) {
        add(`yt:${youtube[1]}`);
        continue;
      }
    }
    // YouTube's thumbnail of a video is that video.
    if (text.includes('ytimg.com')) {
      const thumb = /i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//.exec(text);
      if (thumb) {
        add(`yt:${thumb[1]}`);
        continue;
      }
    }
    add(normalizeFeedUrl(text));
  }
  const videoId = source?.embed?.videoId;
  if (typeof videoId === 'string' && /^[\w-]{11}$/.test(videoId))
    add(`yt:${videoId}`);
  return keys;
}

/** Words that say what a camera is rather than which camera. */
const GENERIC = new Set(
  (
    'webcam webcams cam cams camera cameras live stream view views hd 4k the ' +
    'of at in on and a an de la le el du des der die das von zu am im ' +
    'traffic cctv'
  ).split(' '),
);

/**
 * A name as comparison tokens: lowercase, no accents or punctuation, no
 * generic words, plurals folded ("falcons" is "falcon").
 */
export function nameTokens(name) {
  const tokens = String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !GENERIC.has(token))
    .map((token) =>
      token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
        ? token.slice(0, -1)
        : token,
    );
  return [...new Set(tokens)];
}

/**
 * Rule c's name test on two token lists: token Jaccard >= 0.5, or every
 * word of one name is in the other (and says something: 4+ letters).
 */
export function namesAgree(a, b) {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const longSet = new Set(long);
  let shared = 0;
  for (const token of short) if (longSet.has(token)) shared++;
  if (shared === short.length && short.join('').length >= 4) return true;
  return shared / (a.length + b.length - shared) >= 0.5;
}

/** Ground distance in metres (equirectangular; exact enough below 25 km). */
export function distanceM(a, b) {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * Math.cos(meanLat) * 111_320;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Metres per degree of longitude along each grid row (memoised). */
const rowScale = new Map();
function lonScale(row) {
  let scale = rowScale.get(row);
  if (scale === undefined) {
    const rowLat = ((row + 0.5) * CELL_M) / M_PER_DEG_LAT;
    scale = Math.max(1, 111_320 * Math.cos((rowLat * Math.PI) / 180)) / CELL_M;
    if (rowScale.size > 50_000) rowScale.clear();
    rowScale.set(row, scale);
  }
  return scale;
}

/**
 * A spatial hash of kept cameras, for the 30 m and 60 m rules: rows of
 * CELL_M, columns of CELL_M along each row (row → column → cameras; both
 * small integers, which Maps hash fastest).
 */
export function createGrid() {
  const rows = new Map();
  const found = [];
  return {
    add(entry) {
      const row = Math.floor((entry.lat * M_PER_DEG_LAT) / CELL_M);
      const col = Math.floor(entry.lon * lonScale(row));
      let cols = rows.get(row);
      if (!cols) rows.set(row, (cols = new Map()));
      const bucket = cols.get(col);
      if (bucket) bucket.push(entry);
      else cols.set(col, [entry]);
    },
    /**
     * Kept cameras in the cells around a point (always covers 100 m). The
     * array is reused by the next call.
     */
    around(lat, lon) {
      found.length = 0;
      const row = Math.floor((lat * M_PER_DEG_LAT) / CELL_M);
      for (let r = row - 1; r <= row + 1; r++) {
        const cols = rows.get(r);
        if (!cols) continue;
        const col = Math.floor(lon * lonScale(r));
        for (let c = col - 1; c <= col + 1; c++) {
          const bucket = cols.get(c);
          if (bucket)
            for (let i = 0; i < bucket.length; i++) found.push(bucket[i]);
        }
      }
      return found;
    },
  };
}

/** Counts keys per family; a key past HUB_LIMIT in one family is a hub. */
function createHubCounter() {
  const byFamily = new Map();
  const hubs = new Set();
  return {
    hubs,
    count(family, key) {
      let counts = byFamily.get(family);
      if (!counts) byFamily.set(family, (counts = new Map()));
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > HUB_LIMIT) hubs.add(key);
    },
  };
}

/**
 * De-duplicate cameras.
 * @param {Array<object>} sources - Normalized sources, each with `pack`.
 * @param {{record?: boolean}} [options] - record: also return every merge.
 * @returns {{sources: Array<object>, removed: number,
 *   byRule: Record<string, number>, winnerOf: Map<string, string>,
 *   merges?: Array<{winner: object, loser: object, rule: string, distanceM: number}>}}
 */
export function dedupeSources(sources, { record = false } = {}) {
  const prepared = [];
  // Placeholder images and hub pages shared within a family prove nothing.
  // (The same video on two featured entries is still one stream.)
  const feedHubs = createHubCounter();
  const operatorHubs = createHubCounter();
  const list = Array.isArray(sources) ? sources : [];
  for (let order = 0; order < list.length; order++) {
    const source = list[order];
    if (!source || !Number.isFinite(source.lat) || !Number.isFinite(source.lon))
      continue;
    const rank = sourceRank(source);
    const ownFeed = OWN_FEED.has(source.feedType);
    const family = familyOf(source);
    const feeds = feedKeys(source);
    const operator = normalizeOperatorUrl(source.operatorUrl);
    for (const key of feeds)
      if (!key.startsWith('yt:')) feedHubs.count(family, key);
    if (operator) operatorHubs.count(family, operator);
    prepared.push({
      source,
      order,
      // Copied off the source: entries share one shape, sources do not.
      lat: source.lat,
      lon: source.lon,
      pack: String(source.pack || ''),
      directory: DIRECTORY_PACKS.has(source.pack),
      // Best first; a camera with its own picture before a page link; then
      // the order the packs came in.
      sortKey: rank * 2 + (ownFeed ? 0 : 1),
      family,
      ownFeed,
      feeds,
      operator,
      tokens: null,
      also: null,
      operatorFill: '',
      claimed: false,
      kept: false,
      nearbyUnnamed: false,
    });
  }
  // A stable bucket sort on the dozen sort keys (input order within each).
  const buckets = [];
  for (const entry of prepared) (buckets[entry.sortKey] ??= []).push(entry);
  const ordered = buckets.flat();

  let kept = 0;
  const byFeed = new Map();
  const byOperator = new Map();
  const grid = createGrid();
  const byRule = Object.fromEntries(DEDUPE_RULES.map((rule) => [rule, 0]));
  const merges = record ? [] : null;
  /** id of every dropped camera → id of the camera it duplicates. */
  const winnerOf = new Map();

  const tokensOf = (entry) => (entry.tokens ??= nameTokens(entry.source.name));

  function match(entry, nameless) {
    for (const key of entry.feeds) {
      if (feedHubs.hubs.has(key)) continue;
      const winners = byFeed.get(key);
      if (!winners) continue;
      for (const winner of winners) {
        const d = distanceM(winner, entry);
        if (d <= URL_RADIUS_M) return { winner, rule: 'url', d };
      }
    }
    const sharing =
      entry.operator && !operatorHubs.hubs.has(entry.operator)
        ? byOperator.get(entry.operator)
        : undefined;
    if (sharing)
      for (const winner of sharing) {
        if (winner.family === entry.family) continue;
        const d = distanceM(winner, entry);
        if (d <= OPERATOR_RADIUS_M) return { winner, rule: 'operator', d };
      }
    const { directory } = entry;
    const agency = entry.sortKey < 4; // featured or agency, see sourceRank
    let named = null;
    let listedNamed = null;
    let listedNearest = null;
    for (const winner of grid.around(entry.lat, entry.lon)) {
      if (winner.family === entry.family) continue;
      const d = distanceM(winner, entry);
      if (
        directory &&
        d <= DIRECTORY_RADIUS_M &&
        winner.ownFeed &&
        !winner.directory
      ) {
        // A directory re-hosts one camera once; several directory cameras
        // around one of ours are a site with several views, so past the
        // first, a directory camera needs a name that agrees.
        if (namesAgree(tokensOf(winner), tokensOf(entry))) {
          if (!listedNamed || d < listedNamed.d)
            listedNamed = { winner, rule: 'directory', d };
        } else if (!winner.claimed) {
          entry.nearbyUnnamed = true;
          if (nameless && (!listedNearest || d < listedNearest.d))
            listedNearest = { winner, rule: 'directory', d };
        }
        continue;
      }
      // Two agency feeds at one junction are two cameras.
      if (agency && winner.sortKey < 4) continue;
      if (
        d <= NAME_RADIUS_M &&
        (!named || d < named.d) &&
        namesAgree(tokensOf(winner), tokensOf(entry))
      )
        named = { winner, rule: 'name', d };
    }
    if (listedNamed) {
      listedNamed.winner.claimed = true;
      return listedNamed;
    }
    if (listedNearest) {
      listedNearest.winner.claimed = true;
      return listedNearest;
    }
    return named;
  }

  function settle(entry, found) {
    if (found) {
      const { winner } = found;
      byRule[found.rule]++;
      if (entry.pack !== winner.pack)
        (winner.also ??= new Set()).add(entry.pack);
      if (
        !winner.source.operatorUrl &&
        !winner.operatorFill &&
        entry.source.operatorUrl
      )
        winner.operatorFill = entry.source.operatorUrl;
      winnerOf.set(entry.source.id, winner.source.id);
      merges?.push({
        winner: winner.source,
        loser: entry.source,
        rule: found.rule,
        distanceM: Math.round(found.d),
      });
      return;
    }
    entry.kept = true;
    kept++;
    for (const key of entry.feeds) {
      const list = byFeed.get(key);
      if (list) list.push(entry);
      else byFeed.set(key, [entry]);
    }
    if (entry.operator) {
      const list = byOperator.get(entry.operator);
      if (list) list.push(entry);
      else byOperator.set(entry.operator, [entry]);
    }
    // Directory cameras come last and the grid rules compare families, so
    // no later camera could match one there.
    if (!entry.directory) grid.add(entry);
  }

  // Directory cameras are placed in two passes: every one whose name says
  // which camera it re-hosts first, then the nameless ones, so a site's
  // named view is never beaten to its camera by a neighbouring view.
  const deferred = [];
  for (const entry of ordered) {
    const found = match(entry, !entry.directory);
    if (!found && entry.directory && entry.nearbyUnnamed) deferred.push(entry);
    else settle(entry, found);
  }
  for (const entry of deferred) settle(entry, match(entry, true));

  // Back in the order the cameras came in (prepared still is).
  const out = [];
  for (const entry of prepared) {
    if (!entry.kept) continue;
    out.push(mergedSource(entry));
  }
  function mergedSource(entry) {
    if (!entry.also && !entry.operatorFill) return entry.source;
    const merged = { ...entry.source };
    if (entry.also) {
      const before = Array.isArray(entry.source.alsoListedIn)
        ? entry.source.alsoListedIn
        : [];
      merged.alsoListedIn = [...new Set([...before, ...entry.also])].sort();
    }
    if (entry.operatorFill) merged.operatorUrl = entry.operatorFill;
    return merged;
  }
  return {
    sources: out,
    removed: prepared.length - kept,
    byRule,
    winnerOf,
    ...(merges ? { merges } : {}),
  };
}
