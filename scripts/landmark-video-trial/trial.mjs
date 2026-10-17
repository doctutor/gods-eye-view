#!/usr/bin/env node
/**
 * Personal fork: the "videos about a place" trial for the Recorded Video
 * layer, on 12 Baltimore landmarks. An experiment, not a feature: nothing
 * here is used by the app.
 *
 * For each landmark it gathers candidates from a YouTube search
 * (search.list, 100 units) and a Filmot caption search (via RapidAPI),
 * reads their metadata (videos.list, channels.list: 1 unit per 50), scores
 * each (video, landmark) pair from cheap evidence, and writes
 * .gev-cache/landmark-video-trial/results.json (and report.md beside it,
 * or under --out). Raw answers are kept under raw/ so scoring can be re-run
 * offline (--score-only) without spending anything.
 *
 * Budgets are hard caps checked before every call: YouTube units
 * (--youtube-budget, default 1500) and Filmot caption searches
 * (--filmot-budget, default 25). Keys come from an .env file (--env,
 * default ./.env): YOUTUBE_API_KEY and FILMOT_RAPIDAPI_KEY. Keys are never
 * printed or written.
 *
 * usage: node scripts/landmark-video-trial/trial.mjs [--env FILE] [--out DIR]
 *          [--score-only] [--compare-medium]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join('.gev-cache', 'landmark-video-trial');
const YOUTUBE = 'https://www.googleapis.com/youtube/v3';
const FILMOT_HOST = 'filmot-tube-metadata-archive.p.rapidapi.com';

/** The 12 landmarks: Wikidata item and coordinates, names to look for. */
export const LANDMARKS = Object.freeze([
  {
    key: 'fort-mchenry',
    name: 'Fort McHenry',
    qid: 'Q1438634',
    lat: 39.26333,
    lon: -76.58,
    aliases: ['fort mchenry', 'ft mchenry', 'ft. mchenry'],
    filmot: '"Fort McHenry"',
  },
  {
    key: 'inner-harbor',
    name: 'Inner Harbor',
    qid: 'Q2470296',
    lat: 39.28333,
    lon: -76.61,
    aliases: ['inner harbor', 'inner harbour'],
    filmot: '"Inner Harbor" Baltimore',
  },
  {
    key: 'camden-yards',
    name: 'Camden Yards',
    qid: 'Q1141174',
    lat: 39.28389,
    lon: -76.62167,
    aliases: ['camden yards', 'oriole park'],
    filmot: '"Camden Yards"',
  },
  {
    key: 'mt-bank-stadium',
    name: 'M&T Bank Stadium',
    qid: 'Q1141336',
    lat: 39.27806,
    lon: -76.62278,
    aliases: ['m&t bank stadium', 'm&t stadium', 'm and t bank stadium'],
    filmot: '"M&T Bank Stadium"',
  },
  {
    key: 'lexington-market',
    name: 'Lexington Market',
    qid: 'Q6537838',
    lat: 39.29273,
    lon: -76.62118,
    aliases: ['lexington market'],
    filmot: '"Lexington Market"',
  },
  {
    key: 'national-aquarium',
    name: 'National Aquarium',
    qid: 'Q1000257',
    lat: 39.28509,
    lon: -76.60829,
    aliases: ['national aquarium', 'baltimore aquarium'],
    filmot: '"National Aquarium" Baltimore',
  },
  {
    key: 'johns-hopkins-hospital',
    name: 'Johns Hopkins Hospital',
    qid: 'Q1472068',
    lat: 39.2974,
    lon: -76.5924,
    aliases: ['johns hopkins hospital', 'hopkins hospital'],
    filmot: '"Johns Hopkins Hospital"',
  },
  {
    key: 'penn-station',
    name: 'Penn Station',
    qid: 'Q3374785',
    lat: 39.3074,
    lon: -76.6156,
    aliases: ['penn station'],
    ambiguous: true,
    filmot: '"Penn Station" Baltimore',
  },
  {
    key: 'washington-monument',
    name: 'Washington Monument (Mount Vernon Place)',
    qid: 'Q3683526',
    lat: 39.2975,
    lon: -76.6158,
    aliases: [
      'washington monument',
      'mount vernon place',
      'mt vernon place',
      'mt. vernon place',
    ],
    ambiguous: true,
    filmot: '"Mount Vernon Place"',
    search: 'Washington Monument Mount Vernon Place Baltimore',
  },
  {
    key: 'druid-hill-park',
    name: 'Druid Hill Park / Maryland Zoo',
    qid: 'Q5308980',
    lat: 39.325,
    lon: -76.6433,
    aliases: ['druid hill', 'maryland zoo'],
    filmot: '"Druid Hill Park"',
    search: 'Druid Hill Park Maryland Zoo Baltimore',
  },
  {
    key: 'patterson-park',
    name: 'Patterson Park',
    qid: 'Q3660981',
    lat: 39.28778,
    lon: -76.57861,
    aliases: ['patterson park'],
    filmot: '"Patterson Park" Baltimore',
  },
  {
    key: 'key-bridge',
    name: 'Key Bridge site',
    qid: 'Q5482413',
    lat: 39.21694,
    lon: -76.52833,
    aliases: ['key bridge', 'francis scott key bridge'],
    ambiguous: true,
    filmot: '"Francis Scott Key Bridge"',
    search: 'Francis Scott Key Bridge Baltimore',
  },
]);

/**
 * Score weights (sum 1.0 before the factors and penalties). Written down so
 * the trial's numbers can be re-read: what each piece of evidence is worth.
 */
export const WEIGHTS = Object.freeze({
  title: 0.3, // the title names the landmark
  chapter: 0.1, // a chapter line (timestamped description line) names it
  description: 0.15, // mentions in the description, 3+ = full
  captions: 0.15, // caption hits (Filmot), 5+ = full
  captionsEarly: 0.05, // share of caption hits in the first minute
  channelLocal: 0.1, // channel title/description mentions Baltimore/Maryland
  geotag: 0.1, // recording location within 1 km of the landmark
  views: 0.05, // log10(views)/6, capped
});
/** Each other landmark the title or chapters also name. */
export const COMPETING_PENALTY = 0.08;
export const COMPETING_PENALTY_MAX = 0.3;
/** An ambiguous name used about another city (NYC's Penn Station, DC's monument). */
export const ELSEWHERE_PENALTY = 0.25;
const ELSEWHERE =
  /\b(new york|nyc|manhattan|newark|washington,? d\.?c\.?|\bd\.?c\.?\b|national mall|arlington|georgetown|philadelphia)\b/i;
const LOCAL = /\b(baltimore|maryland|bmore|charm city)\b/i;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

function readEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no env file */
  }
  return env;
}

// --- evidence --------------------------------------------------------------

/** ISO 8601 duration → seconds (NaN when unreadable). */
export function durationSeconds(value) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(value || ''),
  );
  if (!m || value === 'P' || value === 'PT') return NaN;
  return (
    +(m[1] || 0) * 86400 +
    +(m[2] || 0) * 3600 +
    +(m[3] || 0) * 60 +
    +(m[4] || 0)
  );
}

const lower = (s) => String(s || '').toLowerCase();
const countOf = (text, aliases) => {
  const t = lower(text);
  let n = 0;
  for (const alias of aliases) {
    let at = t.indexOf(alias);
    while (at >= 0) {
      n++;
      at = t.indexOf(alias, at + alias.length);
    }
  }
  return n;
};
const mentions = (text, aliases) => countOf(text, aliases) > 0;

/** Description lines that start with a timestamp ("0:00 Intro", "12:34 - ..."). */
export function chapterLines(description) {
  return String(description || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(line));
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) *
      Math.cos(bLat * r) *
      Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A one-word kind from the title and channel. */
export function kindOf(title, channel) {
  const t = lower(title);
  const c = lower(channel);
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

/**
 * Score one (video, landmark) pair: 0..1, with the evidence lines behind it.
 * @param {object} video - videos.list item (with .channel, .captions).
 */
export function scorePair(video, landmark) {
  const title = video.snippet?.title || '';
  const description = video.snippet?.description || '';
  const chapters = chapterLines(description);
  const captions = Array.isArray(video.captions) ? video.captions : [];
  const channel = video.channel || {};
  const location = video.recordingDetails?.location;
  const seconds = durationSeconds(video.contentDetails?.duration);
  const views = Number(video.statistics?.viewCount) || 0;
  const evidence = [];

  const inTitle = mentions(title, landmark.aliases);
  const inChapters = chapters.filter((line) =>
    mentions(line, landmark.aliases),
  ).length;
  const descriptionCount = countOf(description, landmark.aliases);
  const early = captions.filter((hit) => Number(hit.start) < 60).length;
  const channelText = `${channel.title || video.snippet?.channelTitle || ''} ${channel.description || ''}`;
  const channelLocal = LOCAL.test(channelText);
  const geotagKm =
    location && Number.isFinite(Number(location.latitude))
      ? distanceKm(
          Number(location.latitude),
          Number(location.longitude),
          landmark.lat,
          landmark.lon,
        )
      : null;

  let score =
    WEIGHTS.title * (inTitle ? 1 : 0) +
    WEIGHTS.chapter * (inChapters ? 1 : 0) +
    WEIGHTS.description * Math.min(1, descriptionCount / 3) +
    WEIGHTS.captions * Math.min(1, captions.length / 5) +
    WEIGHTS.captionsEarly * (captions.length ? early / captions.length : 0) +
    WEIGHTS.channelLocal * (channelLocal ? 1 : 0) +
    WEIGHTS.geotag * (geotagKm !== null && geotagKm <= 1 ? 1 : 0) +
    WEIGHTS.views * Math.min(1, Math.log10(views + 1) / 6);
  if (inTitle) evidence.push('title names it');
  if (inChapters) evidence.push(`${inChapters} chapter line(s) name it`);
  if (descriptionCount)
    evidence.push(`description mentions ×${descriptionCount}`);
  if (captions.length)
    evidence.push(
      `${captions.length} caption hit(s), ${early} in the first minute`,
    );
  if (channelLocal) evidence.push('Baltimore/Maryland channel');
  if (geotagKm !== null) evidence.push(`geotag ${geotagKm.toFixed(2)} km away`);
  evidence.push(
    `${views.toLocaleString('en-US')} views, ${Number.isFinite(seconds) ? Math.round(seconds / 60) : '?'} min`,
  );

  // Length: under two minutes or over three hours says less about a place.
  const lengthFactor =
    Number.isFinite(seconds) && (seconds < 120 || seconds > 3 * 3600) ? 0.7 : 1;
  score *= lengthFactor;
  if (lengthFactor < 1) evidence.push('length factor 0.7');

  // Competing landmarks: a video about "Baltimore's top 10 sights" names many.
  const strongText = `${title}\n${chapters.join('\n')}`;
  const others = LANDMARKS.filter(
    (other) =>
      other.key !== landmark.key && mentions(strongText, other.aliases),
  );
  if (others.length) {
    const penalty = Math.min(
      COMPETING_PENALTY_MAX,
      COMPETING_PENALTY * others.length,
    );
    score -= penalty;
    evidence.push(
      `also names ${others.map((o) => o.name).join(', ')} (−${penalty.toFixed(2)})`,
    );
  }
  // An ambiguous name about another city.
  if (
    landmark.ambiguous &&
    ELSEWHERE.test(`${title} ${description.slice(0, 400)}`) &&
    !LOCAL.test(title)
  ) {
    score -= ELSEWHERE_PENALTY;
    evidence.push(`another city named (−${ELSEWHERE_PENALTY})`);
  }
  return {
    score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)),
    evidence,
    kind: kindOf(title, channel.title || video.snippet?.channelTitle),
    signals: {
      inTitle,
      inChapters,
      descriptionCount,
      captionHits: captions.length,
      early,
      channelLocal,
      geotagKm,
      views,
      seconds,
    },
  };
}

// --- fetching ----------------------------------------------------------------

function createBudget(limit, label) {
  let used = 0;
  return {
    spend(n) {
      if (used + n > limit)
        throw new Error(
          `${label} budget would be passed (${used} + ${n} > ${limit})`,
        );
      used += n;
    },
    used: () => used,
    limit,
  };
}

async function main() {
  const out = option('--out', OUT_DIR);
  const rawDir = path.join(OUT_DIR, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const env = readEnv(option('--env', '.env'));
  const youtubeKey = env.YOUTUBE_API_KEY || '';
  const filmotKey = env.FILMOT_RAPIDAPI_KEY || '';
  const units = createBudget(
    Number(option('--youtube-budget', 1500)),
    'YouTube',
  );
  const filmotSearches = createBudget(
    Number(option('--filmot-budget', 25)),
    'Filmot',
  );
  const scoreOnly = flag('--score-only');
  const ledgerFile = path.join(rawDir, 'ledger.json');
  const ledger = fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    : { youtubeUnits: 0, filmotSearches: 0, filmotQuota: null };
  units.spend(ledger.youtubeUnits);
  filmotSearches.spend(ledger.filmotSearches);
  const saveLedger = () =>
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify(
        {
          ...ledger,
          youtubeUnits: units.used(),
          filmotSearches: filmotSearches.used(),
        },
        null,
        2,
      ),
    );

  /** A raw answer from disk, or fetched (and kept) when allowed. */
  async function cached(name, fetcher) {
    const file = path.join(rawDir, `${name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (scoreOnly) return null;
    const value = await fetcher();
    fs.writeFileSync(file, JSON.stringify(value));
    saveLedger();
    return value;
  }
  async function youtube(resource, params, cost) {
    if (!youtubeKey) throw new Error('YOUTUBE_API_KEY is not set');
    units.spend(cost);
    const url = new URL(`${YOUTUBE}/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', youtubeKey);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();
    if (!response.ok || body.error)
      throw new Error(
        `YouTube ${resource}: ${body.error?.errors?.[0]?.reason || response.status}`,
      );
    return body;
  }
  async function filmot(query) {
    if (!filmotKey) throw new Error('FILMOT_RAPIDAPI_KEY is not set');
    filmotSearches.spend(1);
    const url = new URL(`https://${FILMOT_HOST}/getsearchsubtitles`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', '1');
    url.searchParams.set('lang', 'en');
    url.searchParams.set('hitFormat', '1');
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-host': FILMOT_HOST,
        'x-rapidapi-key': filmotKey,
        accept: 'application/json',
      },
    });
    const header = (n) => response.headers.get(n);
    ledger.filmotQuota = {
      requestsRemaining: header('x-ratelimit-requests-remaining'),
      subtitleSearchesRemaining: header(
        'x-ratelimit-subtitle-searches-remaining',
      ),
      rowsRemainingHundreds: header(
        'x-ratelimit-exported_row_hundreds-remaining',
      ),
    };
    const text = await response.text();
    if (!response.ok)
      throw new Error(`Filmot ${response.status}: ${text.slice(0, 160)}`);
    const body = JSON.parse(text);
    if (body?.error)
      throw new Error(`Filmot: ${String(body.error).slice(0, 160)}`);
    return body;
  }

  const perLandmark = {};
  const videoIds = new Set();
  for (const landmark of LANDMARKS) {
    const q = landmark.search || `${landmark.name} Baltimore`;
    const search = await cached(`search-${landmark.key}-any`, () =>
      youtube(
        'search',
        {
          part: 'id',
          type: 'video',
          q,
          order: 'relevance',
          maxResults: '25',
          videoDuration: 'any',
          regionCode: 'US',
          relevanceLanguage: 'en',
        },
        100,
      ),
    );
    const medium =
      flag('--compare-medium') &&
      ['fort-mchenry', 'inner-harbor'].includes(landmark.key)
        ? await cached(`search-${landmark.key}-medium`, () =>
            youtube(
              'search',
              {
                part: 'id',
                type: 'video',
                q,
                order: 'relevance',
                maxResults: '25',
                videoDuration: 'medium',
                regionCode: 'US',
                relevanceLanguage: 'en',
              },
              100,
            ),
          )
        : null;
    let captions = null;
    try {
      captions = await cached(`filmot-${landmark.key}`, () =>
        filmot(landmark.filmot),
      );
    } catch (error) {
      console.warn(`[trial] Filmot ${landmark.key}: ${error.message}`);
    }
    const searchIds = (search?.items || [])
      .map((i) => i?.id?.videoId)
      .filter(Boolean);
    const mediumIds = (medium?.items || [])
      .map((i) => i?.id?.videoId)
      .filter(Boolean);
    const filmotVideos = (
      Array.isArray(captions?.result) ? captions.result : []
    ).slice(0, 25);
    const captionHits = new Map(
      filmotVideos.map((v) => [
        v.id,
        (Array.isArray(v.hits) ? v.hits : []).map((h) => ({
          start: h.start,
          text: (h.lines || [])
            .map((l) => l.text)
            .join(' ')
            .slice(0, 200),
        })),
      ]),
    );
    perLandmark[landmark.key] = {
      q,
      searchIds,
      mediumIds,
      filmotIds: [...captionHits.keys()],
      captionHits,
      filmotTotal: captions?.totalresultcount ?? null,
    };
    for (const id of [...searchIds, ...mediumIds, ...captionHits.keys()])
      videoIds.add(id);
  }

  /**
   * Metadata from every stored answer of a resource (whatever ids it was
   * asked for), fetching, 50 a call, only ids no stored answer covers. A
   * stored answer records the ids it asked for, so a deleted video is not
   * asked about again; --score-only never fetches.
   */
  async function metadata(prefix, resource, ids, params) {
    const items = new Map();
    const asked = new Set();
    for (const file of fs
      .readdirSync(rawDir)
      .filter((f) => f.startsWith(`${prefix}-`))) {
      const body = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
      for (const id of body?.askedIds || []) asked.add(id);
      for (const item of body?.items || []) {
        items.set(item.id, item);
        asked.add(item.id);
      }
    }
    const missing = ids.filter((id) => !asked.has(id));
    for (let i = 0; i < missing.length && !scoreOnly; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const body = await cached(
        `${prefix}-${Date.now()}-${chunk[0]}`,
        async () => ({
          ...(await youtube(
            resource,
            { ...params, id: chunk.join(','), maxResults: '50' },
            1,
          )),
          askedIds: chunk,
        }),
      );
      for (const item of body?.items || []) items.set(item.id, item);
    }
    return items;
  }

  // Metadata for every candidate, and for their channels.
  const videos = await metadata('videos', 'videos', [...videoIds].sort(), {
    part: 'snippet,contentDetails,recordingDetails,statistics',
  });
  const channelIds = [
    ...new Set(
      [...videos.values()].map((v) => v.snippet?.channelId).filter(Boolean),
    ),
  ].sort();
  const channels = new Map(
    [
      ...(
        await metadata('channels', 'channels', channelIds, { part: 'snippet' })
      ).values(),
    ].map((item) => [
      item.id,
      {
        title: item.snippet?.title,
        description: String(item.snippet?.description || '').slice(0, 600),
      },
    ]),
  );

  // Score.
  const results = [];
  const totals = {
    youtubeCandidates: 0,
    filmotCandidates: 0,
    overlap: 0,
    unique: 0,
    shortsDropped: 0,
    withGeotag: 0,
    geotagWithin1km: 0,
    missingMetadata: 0,
  };
  const seenGeotag = new Set();
  for (const landmark of LANDMARKS) {
    const entry = perLandmark[landmark.key];
    const fromSearch = new Set(entry.searchIds);
    const fromFilmot = new Set(entry.filmotIds);
    totals.youtubeCandidates += fromSearch.size;
    totals.filmotCandidates += fromFilmot.size;
    const overlap = [...fromSearch].filter((id) => fromFilmot.has(id));
    totals.overlap += overlap.length;
    const scored = [];
    for (const id of new Set([...fromSearch, ...fromFilmot])) {
      totals.unique++;
      const video = videos.get(id);
      if (!video) {
        totals.missingMetadata++;
        continue;
      }
      if (video.recordingDetails?.location && !seenGeotag.has(id)) {
        seenGeotag.add(id);
        totals.withGeotag++;
      }
      const seconds = durationSeconds(video.contentDetails?.duration);
      if (Number.isFinite(seconds) && seconds <= 60) {
        totals.shortsDropped++;
        continue;
      }
      const pair = scorePair(
        {
          ...video,
          channel: channels.get(video.snippet?.channelId),
          captions: entry.captionHits.get(id) || [],
        },
        landmark,
      );
      if (pair.signals.geotagKm !== null && pair.signals.geotagKm <= 1)
        totals.geotagWithin1km++;
      scored.push({
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: video.snippet?.title,
        channel: video.snippet?.channelTitle,
        publishedAt: video.snippet?.publishedAt,
        sources: [
          fromSearch.has(id) && 'youtube-search',
          fromFilmot.has(id) && 'filmot',
        ].filter(Boolean),
        ...pair,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const mediumSeconds = entry.mediumIds
      .map((id) => durationSeconds(videos.get(id)?.contentDetails?.duration))
      .filter(Number.isFinite);
    const anySeconds = entry.searchIds
      .map((id) => durationSeconds(videos.get(id)?.contentDetails?.duration))
      .filter(Number.isFinite);
    results.push({
      landmark: {
        key: landmark.key,
        name: landmark.name,
        qid: landmark.qid,
        lat: landmark.lat,
        lon: landmark.lon,
      },
      query: entry.q,
      filmotQuery: landmark.filmot,
      filmotTotal: entry.filmotTotal,
      counts: {
        youtubeSearch: fromSearch.size,
        filmot: fromFilmot.size,
        overlap: overlap.length,
        scored: scored.length,
      },
      ...(entry.mediumIds.length
        ? {
            durationComparison: {
              any: {
                results: anySeconds.length,
                shorts: anySeconds.filter((s) => s <= 60).length,
                over20min: anySeconds.filter((s) => s > 1200).length,
              },
              medium: {
                results: mediumSeconds.length,
                shorts: mediumSeconds.filter((s) => s <= 60).length,
                overlapWithAny: entry.mediumIds.filter((id) =>
                  fromSearch.has(id),
                ).length,
              },
            },
          }
        : {}),
      top: scored.slice(0, 10),
    });
  }
  saveLedger();
  const summary = {
    generatedAt: new Date().toISOString(),
    weights: WEIGHTS,
    penalties: {
      competing: COMPETING_PENALTY,
      competingMax: COMPETING_PENALTY_MAX,
      elsewhere: ELSEWHERE_PENALTY,
      lengthFactor: 0.7,
    },
    budget: {
      youtubeUnits: units.used(),
      youtubeLimit: units.limit,
      filmotSearches: filmotSearches.used(),
      filmotLimit: filmotSearches.limit,
      filmotQuota: ledger.filmotQuota,
    },
    totals,
    results,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'results.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify({ budget: summary.budget, totals }, null, 1));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`[trial] ${error.message}`);
    process.exitCode = 1;
  });
