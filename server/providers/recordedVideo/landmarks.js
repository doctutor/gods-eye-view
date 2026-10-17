import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import {
  createYoutubeClient,
  createYoutubeQuota,
  VIDEO_ID,
} from '../cctv/featuredChannels.js';
import {
  FEATURED_CACHE_DIR,
  readJsonFile,
  writeJsonAtomic,
} from '../cctv/featuredStore.js';
import { isPlausibleLatLon } from '../cctv/normalize.js';
import {
  DEFAULT_RECORDED_VIDEO_BUDGET,
  MAX_STORE_MS,
  RECORDED_VIDEO_DIR,
  SEARCH_TTL_MS,
  SHORTS_MAX_S,
  createEntryStore,
  durationSeconds,
} from './videos.js';

/**
 * Recorded video's landmark half: videos *about* a notable place, found on
 * demand per landmark (scripts/landmark-video-trial measured the approach:
 * 53 of 60 top-5 videos were about their place).
 *
 * - Landmarks near the view: notable Wikidata items (attractions, museums,
 *   stadiums, parks, monuments, bridges, stations, markets, aquariums, zoos,
 *   historic sites, or anything with 5+ sitelinks that is not an event, an
 *   organisation or a settlement) with coordinates, per 0.1° cell, the 40
 *   with most sitelinks, kept 30 days (CC0).
 * - A landmark's videos: one search.list for "<label>" <city> (relevance,
 *   any duration, 25), videos.list and channels.list (102 units), Shorts
 *   and live streams dropped, then a hard gate: the title names the
 *   landmark (label or alias, accents and case ignored, possessive and
 *   plural allowed), and a guard against titles about something else (a
 *   hotel named for it, real estate, an incident nearby, rankings).
 *   YouTube's order is kept, with small boosts for a local channel, a geotag
 *   within 1 km and chapters. Kept 7 days; nothing past 30. These videos pin
 *   at the landmark as 'about' this place, never with a filming precision.
 * - "Mentioned at 3:41": one Filmot caption search per landmark, when a
 *   video is opened, kept 30 days.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

export const LANDMARK_CELL_DEG = 0.1;
export const LANDMARKS_PER_CELL = 40;
export const LANDMARK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** search.list (100) + videos.list (1) + channels.list (1). */
export const LANDMARK_QUERY_COST = 102;
/** Uncached cells fetched per request; the next settle asks for the rest. */
const CELLS_PER_REQUEST = 2;
const FILMOT_HOST = 'filmot-tube-metadata-archive.p.rapidapi.com';
export const FILMOT_DAILY_CAP = 30;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 (+https://github.com/doctutor/gods-eye-view)';
const FEATURE = 'recordedVideo';

/** Classes that make an item a landmark (one subclass step allowed). */
export const LANDMARK_CLASSES = Object.freeze({
  Q570116: 'attraction',
  Q2319498: 'landmark',
  Q33506: 'museum',
  Q483110: 'stadium',
  Q1076486: 'venue',
  Q641226: 'arena',
  Q22698: 'park',
  Q4989906: 'monument',
  Q12280: 'bridge',
  Q55488: 'station',
  Q928830: 'station',
  Q330284: 'market',
  Q37654: 'market',
  Q2281788: 'aquarium',
  Q43501: 'zoo',
  Q1081138: 'historic site',
});
/** Never landmarks, even with many sitelinks: people, settlements, areas. */
const NOT_PLACES = [
  'Q5',
  'Q486972',
  'Q56061',
  'Q515',
  'Q1093829',
  'Q123705',
  'Q34442',
  'Q79007',
  'Q3957',
];
/** Excluded (whole subclass tree) unless a landmark class matched: events, organisations, metro areas. */
const NOT_THINGS = ['Q1190554', 'Q43229', 'Q1907114'];
/** P131 classes that are a city or town (for the search's city word). */
const CITY_CLASSES = new Set([
  'Q515',
  'Q1093829',
  'Q1266818',
  'Q3957',
  'Q15127012',
  'Q1549591',
  'Q5119',
  'Q200250',
  'Q1637706',
  'Q62049',
  'Q7930989',
  'Q15221373',
  'Q2264924',
]);

const clean = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const qidOf = (iri) => /\/(Q\d+)$/.exec(String(iri || ''))?.[1] || '';

// --- landmarks near the view --------------------------------------------------

/** The 0.1° cell a point falls in. */
export function landmarkCell(lat, lon) {
  const row = Math.floor(lat / LANDMARK_CELL_DEG);
  const col = Math.floor(lon / LANDMARK_CELL_DEG);
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    key: `${row}_${col}`,
    south: round(row * LANDMARK_CELL_DEG),
    west: round(col * LANDMARK_CELL_DEG),
    north: round((row + 1) * LANDMARK_CELL_DEG),
    east: round((col + 1) * LANDMARK_CELL_DEG),
  };
}

/** The cells within `radiusKm` of a point (at most 3×3), nearest first. */
export function cellsAround(lat, lon, radiusKm) {
  const dLat = Math.min(LANDMARK_CELL_DEG, radiusKm / 111);
  const dLon = Math.min(
    LANDMARK_CELL_DEG,
    radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))),
  );
  const cells = new Map();
  for (const a of [-dLat, 0, dLat])
    for (const b of [-dLon, 0, dLon]) {
      const cell = landmarkCell(lat + a, lon + b);
      if (!cells.has(cell.key)) cells.set(cell.key, cell);
    }
  const centre = (c) => [(c.south + c.north) / 2, (c.west + c.east) / 2];
  return [...cells.values()].sort((x, y) => {
    const [ax, bx] = centre(x);
    const [ay, by] = centre(y);
    return Math.hypot(ax - lat, bx - lon) - Math.hypot(ay - lat, by - lon);
  });
}

/** The SPARQL for one cell's landmarks. */
export function landmarksQuery(cell) {
  const values = (ids) => ids.map((q) => `wd:${q}`).join(' ');
  return `SELECT ?item ?itemLabel ?lat ?lon ?sitelinks (SAMPLE(?cls) AS ?class) WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:cornerSouthWest "Point(${cell.west} ${cell.south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${cell.east} ${cell.north})"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?item wdt:P31/wdt:P279? ?cls . VALUES ?cls { ${values(Object.keys(LANDMARK_CLASSES))} } }
  FILTER(BOUND(?cls) || ?sitelinks >= 5)
  FILTER NOT EXISTS { ?item wdt:P31/wdt:P279? ?x . VALUES ?x { ${values(NOT_PLACES)} } }
  FILTER(BOUND(?cls) || NOT EXISTS { ?item wdt:P31/wdt:P279* ?y . VALUES ?y { ${values(NOT_THINGS)} } })
  BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?item ?itemLabel ?lat ?lon ?sitelinks ORDER BY DESC(?sitelinks) LIMIT ${LANDMARKS_PER_CELL * 2}`;
}

/** SPARQL rows → the cell's landmarks: one per item, most sitelinks first, capped. */
export function parseLandmarks(bindings, { cap = LANDMARKS_PER_CELL } = {}) {
  const byQid = new Map();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const qid = qidOf(row?.item?.value);
    const lat = Number(row?.lat?.value);
    const lon = Number(row?.lon?.value);
    const label = clean(row?.itemLabel?.value, 160);
    // An unlabelled item is shown by its Q-id in the label service: skip it.
    if (!qid || !isPlausibleLatLon(lat, lon) || !label || label === qid)
      continue;
    if (byQid.has(qid)) continue;
    const classQid = qidOf(row?.class?.value);
    byQid.set(qid, {
      qid,
      label,
      lat,
      lon,
      sitelinks: Number(row?.sitelinks?.value) || 0,
      kind: LANDMARK_CLASSES[classQid] || 'notable',
    });
  }
  return [...byQid.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks || a.label.localeCompare(b.label))
    .slice(0, cap);
}

/** The SPARQL for one landmark's names and the places around it. */
export function landmarkDetailQuery(qid) {
  return `SELECT ?label ?alias ?lat ?lon ?p1Label ?p1Class ?p2Label ?p2Class ?p3Label WHERE {
  wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { wd:${qid} skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
  OPTIONAL { wd:${qid} p:P625/psv:P625 [ wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon ] }
  OPTIONAL { wd:${qid} wdt:P131 ?p1 . OPTIONAL { ?p1 wdt:P31 ?p1Class }
    OPTIONAL { ?p1 wdt:P131 ?p2 . OPTIONAL { ?p2 wdt:P31 ?p2Class } OPTIONAL { ?p2 wdt:P131 ?p3 } } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 300`;
}

/**
 * Detail rows → {qid, label, aliases, lat, lon, city, terms}: the city is
 * the first enclosing place that is a city or town (else the first
 * enclosing place); terms are the enclosing places' names, for the
 * local-channel boost.
 */
export function parseLandmarkDetail(bindings, qid) {
  const rows = Array.isArray(bindings) ? bindings : [];
  if (!rows.length) return null;
  const label = clean(rows[0]?.label?.value, 160);
  if (!label) return null;
  const aliases = new Set();
  let lat = NaN;
  let lon = NaN;
  let city = '';
  const levels = [];
  for (const row of rows) {
    const alias = clean(row?.alias?.value, 160);
    if (alias) aliases.add(alias);
    if (!Number.isFinite(lat) && row?.lat) {
      lat = Number(row.lat.value);
      lon = Number(row.lon.value);
    }
    for (const [labelKey, classKey] of [
      ['p1Label', 'p1Class'],
      ['p2Label', 'p2Class'],
      ['p3Label', null],
    ]) {
      const name = clean(row?.[labelKey]?.value, 120);
      if (!name || /^Q\d+$/.test(name)) continue;
      if (!levels.includes(name)) levels.push(name);
      if (!city && classKey && CITY_CLASSES.has(qidOf(row?.[classKey]?.value)))
        city = name;
    }
  }
  return {
    qid,
    label,
    aliases: [...aliases].slice(0, 20),
    lat,
    lon,
    city: city || levels[0] || '',
    // The enclosing places (city, county, state…): a channel naming one is local.
    terms: levels.slice(0, 6),
  };
}

// --- which videos are about it ------------------------------------------------

/** Lower case, accents gone, punctuation as spaces ("McHenry's" → "mchenry s"). */
export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The names a title must contain one of: label and aliases, normalised. */
export function landmarkNames(detail) {
  const names = new Set();
  for (const raw of [detail?.label, ...(detail?.aliases || [])]) {
    const base = String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ');
    for (const name of [base, base.replace(/^\s*the\s+/i, '')]) {
      const normal = normalizeText(name);
      if (normal.length >= 4) names.add(normal);
    }
  }
  return [...names];
}

/** True when the title names the landmark (possessive and plural allowed). */
export function titleNamesLandmark(title, names) {
  const text = ` ${normalizeText(title)} `;
  return names.some(
    (name) => text.includes(` ${name} `) || text.includes(` ${name}s `),
  );
}

/** Titles about something else that only carries the place's name. */
export const INCIDENTAL_TITLE =
  /\b(hotel|inn|apartments?|residences|condos?|realty|real estate|homes? for sale|listings?|neighbou?rhood|living in|moving to|relocat\w*|shooting|shot|stabb\w*|killed|murder\w*|police|arrest\w*|voted|ranked|ranking)\b/i;

export function isIncidentalTitle(title) {
  return INCIDENTAL_TITLE.test(String(title || ''));
}

/** A one-word kind from the title and channel (the trial's heuristic). */
export function kindOf(title, channel) {
  const t = String(title || '').toLowerCase();
  const c = String(channel || '').toLowerCase();
  if (
    /\b(news|wbal|wjz|wmar|fox ?45|fox baltimore|baltimore sun|banner|cbs|nbc|abc ?2|wusa|wttg|fox 5|nbc4|cnn|associated press|reuters|msnbc|abc news)\b/.test(
      c,
    ) ||
    /\b(breaking|police|shooting|killed|crash|collapse|investigat|officials|mayor|update)\b/.test(
      t,
    )
  )
    return 'news';
  if (
    /\b(official (music )?video|music video|lyrics|ft\.|feat\.|vevo)\b/.test(
      t,
    ) ||
    /vevo|records\b/.test(c)
  )
    return 'music';
  if (
    /\b(tour|walk|walking|walkthrough|guide|things to do|visit(ing)?|explor|drive|driving|4k|sightseeing|history of|exhibit|inside)\b/.test(
      t,
    )
  )
    return 'tour';
  if (
    /\b(game|highlights|vs\.?|festival|parade|fireworks|concert|opening day|marathon|race|celebrat|ceremony|anniversary|show)\b/.test(
      t,
    )
  )
    return 'event';
  if (/\b(vlog|day in the life|my |we |our |trip|weekend|date)\b/.test(t))
    return 'vlog';
  return 'other';
}

const chapterCount = (description) =>
  String(description || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(line)).length;

function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) *
      Math.cos(bLat * r) *
      Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Boosts on YouTube's own order: local channel, close geotag, chapters. */
export const BOOSTS = Object.freeze({
  local: 0.08,
  geotag: 0.08,
  chapters: 0.04,
});

/**
 * A landmark's videos from the search order and their metadata: Shorts,
 * live streams, untitled and incidental videos out; the rest in YouTube's
 * order nudged by the boosts.
 * @param {{ids: string[], items: Array<object>, channels: Map<string, object>,
 *   detail: object}} input
 */
export function rankLandmarkVideos({ ids, items, channels, detail }) {
  const byId = new Map((items || []).map((item) => [item.id, item]));
  const names = landmarkNames(detail);
  const terms = (detail.terms || [])
    .map((term) => normalizeText(term))
    .filter(Boolean);
  const skipped = { short: 0, live: 0, untitled: 0, incidental: 0, missing: 0 };
  const videos = [];
  (ids || []).forEach((videoId, order) => {
    const item = byId.get(videoId);
    if (!item) return void skipped.missing++;
    const title = clean(item.snippet?.title, 200);
    const broadcast = item.snippet?.liveBroadcastContent;
    if (broadcast === 'live' || broadcast === 'upcoming')
      return void skipped.live++;
    const seconds = durationSeconds(item.contentDetails?.duration);
    if (Number.isFinite(seconds) && seconds <= SHORTS_MAX_S)
      return void skipped.short++;
    if (!titleNamesLandmark(title, names)) return void skipped.untitled++;
    if (isIncidentalTitle(title)) return void skipped.incidental++;
    const channel = channels.get(item.snippet?.channelId) || {};
    const channelText = ` ${normalizeText(`${channel.title || item.snippet?.channelTitle || ''} ${channel.description || ''}`)} `;
    const local = terms.some((term) => channelText.includes(` ${term} `));
    const location = item.recordingDetails?.location;
    const geotagKm =
      location && Number.isFinite(Number(location.latitude))
        ? distanceKm(
            Number(location.latitude),
            Number(location.longitude),
            detail.lat,
            detail.lon,
          )
        : null;
    const near = geotagKm !== null && geotagKm <= 1;
    const chapters = chapterCount(item.snippet?.description) >= 2;
    const score =
      1 -
      order / 25 +
      (local ? BOOSTS.local : 0) +
      (near ? BOOSTS.geotag : 0) +
      (chapters ? BOOSTS.chapters : 0);
    const views = Number(item.statistics?.viewCount);
    videos.push({
      id: `lm-${detail.qid}-${videoId}`,
      videoId,
      title,
      channelTitle: clean(item.snippet?.channelTitle, 120),
      publishedAt: clean(item.snippet?.publishedAt, 40),
      durationS: Number.isFinite(seconds) ? seconds : null,
      views: Number.isFinite(views) ? views : null,
      lat: detail.lat,
      lon: detail.lon,
      coordinatesQuality: 'about',
      source: 'landmark',
      kind: kindOf(title, item.snippet?.channelTitle),
      landmarkQid: detail.qid,
      place: detail.label,
      licenseClass: 'embed-only',
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      youtubeRank: order + 1,
      boosts: [
        local && 'local channel',
        near && 'geotag within 1 km',
        chapters && 'chapters',
      ].filter(Boolean),
      score: Math.round(score * 1000) / 1000,
    });
  });
  videos.sort((a, b) => b.score - a.score || a.youtubeRank - b.youtubeRank);
  return { videos, skipped };
}

// --- "mentioned at 3:41" ------------------------------------------------------

/** 221 → "3:41", 3725 → "1:02:05". */
export function clockText(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** A Filmot getsearchsubtitles answer → video id → its hits (start, text). */
export function parseFilmotHits(body) {
  const byVideo = {};
  for (const video of Array.isArray(body?.result) ? body.result : []) {
    const id = String(video?.id || '');
    if (!VIDEO_ID.test(id)) continue;
    const hits = (Array.isArray(video.hits) ? video.hits : [])
      .map((hit) => ({
        start: Number(hit?.start),
        text: clean(
          Array.isArray(hit?.lines) && hit.lines.length
            ? hit.lines.map((line) => line?.text || '').join(' ')
            : `${hit?.ctx_before || ''}${hit?.token || ''}${hit?.ctx_after || ''}`,
          160,
        ),
      }))
      .filter((hit) => Number.isFinite(hit.start) && hit.start >= 0)
      .sort((a, b) => a.start - b.start);
    if (hits.length) byVideo[id] = { title: clean(video.title, 200), hits };
  }
  return byVideo;
}

// --- the service ----------------------------------------------------------------

/**
 * @param {{sourceRoot?: string, fetchImpl?: typeof fetch,
 *   apiKey?: () => string, filmotKey?: () => string, now?: () => number,
 *   env?: object}} [options]
 */
export function createLandmarkService({
  sourceRoot = process.cwd(),
  fetchImpl = (...args) => fetch(...args),
  apiKey = () => String(process.env.YOUTUBE_API_KEY || '').trim(),
  filmotKey = () => String(process.env.FILMOT_RAPIDAPI_KEY || '').trim(),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const dir = path.join(sourceRoot, RECORDED_VIDEO_DIR);
  const quota = createYoutubeQuota({
    now,
    file: path.join(sourceRoot, FEATURED_CACHE_DIR, 'quota.json'),
  });
  const youtube = createYoutubeClient({
    fetchImpl,
    apiKey,
    quota,
    feature: FEATURE,
  });
  const cells = createEntryStore(path.join(dir, 'landmarks', 'cells.json'), {
    maxAgeMs: LANDMARK_TTL_MS,
    now,
  });
  const details = createEntryStore(
    path.join(dir, 'landmarks', 'details.json'),
    {
      maxAgeMs: LANDMARK_TTL_MS,
      now,
    },
  );
  const answers = createEntryStore(path.join(dir, 'landmark-videos.json'), {
    maxAgeMs: SEARCH_TTL_MS,
    now,
  });
  const captions = createEntryStore(path.join(dir, 'landmark-captions.json'), {
    maxAgeMs: MAX_STORE_MS,
    now,
  });
  const filmotUsageFile = path.join(dir, 'filmot-usage.json');
  const inflight = new Map();
  const budget = () => {
    const value = Number(env.RECORDED_VIDEO_DAILY_BUDGET);
    return Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_RECORDED_VIDEO_BUDGET;
  };
  const quotaNow = () => {
    const used = quota.usedBy(FEATURE);
    return { used, budget: budget(), remaining: Math.max(0, budget() - used) };
  };
  const once = (key, work) => {
    if (!inflight.has(key))
      inflight.set(
        key,
        Promise.resolve()
          .then(work)
          .finally(() => inflight.delete(key)),
      );
    return inflight.get(key);
  };

  async function sparql(query) {
    const response = await fetchImpl(
      `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      },
    );
    const body = await readResponseJsonCapped(response, 8 * 1024 * 1024);
    if (!response.ok || !Array.isArray(body?.results?.bindings))
      throw new Error(`Wikidata ${response.status}`);
    return body.results.bindings;
  }

  async function detailFor(qid) {
    const held = details.get(qid);
    if (held) return held.detail;
    return once(`detail:${qid}`, async () => {
      const detail = parseLandmarkDetail(
        await sparql(landmarkDetailQuery(qid)),
        qid,
      );
      if (!detail || !isPlausibleLatLon(detail.lat, detail.lon)) return null;
      details.set(qid, { detail });
      return detail;
    });
  }

  function filmotDay() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const usage = readJsonFile(filmotUsageFile, null);
    return { day, count: usage?.day === day ? Number(usage.count) || 0 : 0 };
  }

  return {
    /** Landmarks in the cells around a point (uncached cells fetched two at a time). */
    async near(lat, lon, radiusKm) {
      if (!isPlausibleLatLon(lat, lon))
        return { status: 400, body: { error: 'near=lat,lon is required' } };
      const around = cellsAround(
        lat,
        lon,
        Math.min(15, Math.max(1, Number(radiusKm) || 8)),
      );
      const landmarks = [];
      let fetched = 0;
      let pending = 0;
      for (const cell of around) {
        const held = cells.get(cell.key);
        if (held) {
          landmarks.push(...held.landmarks);
          continue;
        }
        if (fetched >= CELLS_PER_REQUEST) {
          pending++;
          continue;
        }
        fetched++;
        try {
          const found = await once(`cell:${cell.key}`, async () => {
            const parsed = parseLandmarks(await sparql(landmarksQuery(cell)));
            cells.set(cell.key, { landmarks: parsed });
            return parsed;
          });
          landmarks.push(...found);
        } catch (error) {
          pending++;
          console.warn('[Video] landmarks unavailable:', error?.message);
        }
      }
      const seen = new Set();
      return {
        status: 200,
        body: {
          landmarks: landmarks.filter(
            (l) => !seen.has(l.qid) && seen.add(l.qid),
          ),
          cells: around.length,
          pending,
          quota: quotaNow(),
        },
      };
    },

    /** One landmark's videos (cached a week; budget-checked). */
    async videos(qid, { refresh = false } = {}) {
      if (!/^Q\d{1,12}$/.test(String(qid || '')))
        return { status: 400, body: { error: 'qid is required', videos: [] } };
      const held = refresh ? null : answers.get(qid);
      if (held)
        return {
          status: 200,
          body: { ...held.result, cached: true, quota: quotaNow() },
        };
      if (!youtube.hasKey())
        return {
          status: 200,
          body: { videos: [], configured: false, quota: quotaNow() },
        };
      if (quota.usedBy(FEATURE) + LANDMARK_QUERY_COST > budget())
        return {
          status: 429,
          body: {
            error: 'Recorded video search budget reached for today',
            videos: [],
            quota: quotaNow(),
          },
        };
      try {
        const result = await once(`videos:${qid}`, async () => {
          const detail = await detailFor(qid);
          if (!detail)
            throw Object.assign(new Error('No such landmark'), { status: 404 });
          const q = `"${detail.label.replace(/\s*\([^)]*\)\s*/g, ' ').trim()}"${detail.city ? ` ${detail.city}` : ''}`;
          const ids = (
            await youtube.call('search', {
              part: 'id',
              type: 'video',
              q,
              order: 'relevance',
              videoDuration: 'any',
              maxResults: '25',
              relevanceLanguage: 'en',
            })
          )
            .map((item) => String(item?.id?.videoId || ''))
            .filter((id) => VIDEO_ID.test(id));
          const items = ids.length
            ? await youtube.videos(
                ids,
                'snippet,contentDetails,recordingDetails,statistics',
              )
            : [];
          const channelIds = [
            ...new Set(items.map((i) => i.snippet?.channelId).filter(Boolean)),
          ];
          const channelItems = channelIds.length
            ? await youtube.call('channels', {
                part: 'snippet',
                id: channelIds.slice(0, 50).join(','),
                maxResults: '50',
              })
            : [];
          const channels = new Map(
            channelItems.map((c) => [
              c.id,
              {
                title: clean(c.snippet?.title, 120),
                description: clean(c.snippet?.description, 600),
              },
            ]),
          );
          const ranked = rankLandmarkVideos({ ids, items, channels, detail });
          const answer = {
            landmark: {
              qid,
              label: detail.label,
              lat: detail.lat,
              lon: detail.lon,
              city: detail.city,
            },
            query: q,
            returned: ids.length,
            skipped: ranked.skipped,
            videos: ranked.videos,
          };
          answers.set(qid, { result: answer });
          return answer;
        });
        return {
          status: 200,
          body: { ...result, cached: false, quota: quotaNow() },
        };
      } catch (error) {
        return {
          status: error?.status || 502,
          body: {
            error: String(error?.message || 'YouTube search failed').slice(
              0,
              200,
            ),
            videos: [],
            quota: quotaNow(),
          },
        };
      }
    },

    /** "Mentioned at" moments for one video of a landmark (one Filmot search per landmark). */
    async mentions(qid, videoId) {
      if (
        !/^Q\d{1,12}$/.test(String(qid || '')) ||
        !VIDEO_ID.test(String(videoId || ''))
      )
        return {
          status: 400,
          body: { error: 'qid and videoId are required', mentions: [] },
        };
      let held = captions.get(qid);
      if (!held) {
        const key = filmotKey();
        if (!key)
          return { status: 200, body: { mentions: [], configured: false } };
        const usage = filmotDay();
        if (usage.count >= FILMOT_DAILY_CAP)
          return { status: 200, body: { mentions: [], refused: true } };
        try {
          held = await once(`captions:${qid}`, async () => {
            const detail = await detailFor(qid);
            if (!detail) throw new Error('No such landmark');
            const name = detail.label.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
            const url = new URL(`https://${FILMOT_HOST}/getsearchsubtitles`);
            url.searchParams.set('query', `"${name}"`);
            // Asks for videos titled with the place too (honoured or ignored).
            url.searchParams.set('title', name);
            url.searchParams.set('lang', 'en');
            url.searchParams.set('hitFormat', '1');
            url.searchParams.set('page', '1');
            const current = filmotDay();
            writeJsonAtomic(filmotUsageFile, {
              day: current.day,
              count: current.count + 1,
            });
            const response = await fetchImpl(url.toString(), {
              headers: {
                'x-rapidapi-host': FILMOT_HOST,
                'x-rapidapi-key': key,
                accept: 'application/json',
              },
              signal: AbortSignal.timeout(30_000),
            });
            const body = await readResponseJsonCapped(
              response,
              8 * 1024 * 1024,
            );
            if (!response.ok || body?.error)
              throw new Error(
                `Filmot ${response.status}${body?.error ? `: ${String(body.error).slice(0, 80)}` : ''}`,
              );
            const videos = parseFilmotHits(body);
            const entry = {
              videos,
              total: Number(body?.totalresultcount) || null,
            };
            captions.set(qid, entry);
            return entry;
          });
        } catch (error) {
          return {
            status: 502,
            body: {
              mentions: [],
              error: String(error?.message || 'Filmot failed').slice(0, 200),
            },
          };
        }
      }
      const hits = held?.videos?.[videoId]?.hits || [];
      return {
        status: 200,
        body: {
          mentions: hits.slice(0, 6).map((hit) => ({
            start: hit.start,
            at: clockText(hit.start),
            text: hit.text,
          })),
        },
      };
    },

    /** Drop stored answers past their age. */
    sweep: () =>
      cells.sweep() + details.sweep() + answers.sweep() + captions.sweep(),
    quota: quotaNow,
  };
}
