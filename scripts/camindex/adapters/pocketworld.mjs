import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HostBlockedError, RobotsDisallowedError } from '../fetch.mjs';
import { decodeEntities } from './opencctv.mjs';
import { classifyWebcamUrl } from '../../../server/providers/cctv/linked.js';
import { inBox } from '../verify.mjs';

/**
 * PocketWorld (pocketworld.org), a directory of public webcams with free,
 * keyless JSON APIs. Its webcams endpoint (/api/webcams/<country>, listed in
 * its llms.txt) is asked first; while it does not answer with JSON, the
 * directory's server-rendered listing pages are read instead: the webcam
 * type pages, then city and country pages from its media sitemap. Each card
 * names the camera, its coordinates, its format and the operator's source.
 * One request per 2 s, every page cached for a week. Rules in ../SOURCES.md.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const SOURCE = 'pocketworld';
export const ORIGIN = 'https://pocketworld.org';
/** PocketWorld asks for no more than one request per 2 s from this tool. */
export const MIN_INTERVAL_MS = 2000;
export const API_PROBE_URL = `${ORIGIN}/api/webcams/US`;
export const MEDIA_SITEMAP = `${ORIGIN}/sitemap-media.xml`;
/** First runs stop here, so the yield is seen before scaling up. */
export const FIRST_RUN_LIMIT = 2000;

/** Type pages (directory tag → the app's category word), non-traffic first. */
export const TYPE_PAGES = Object.freeze([
  ['nature', 'nature'],
  ['beach', 'beach'],
  ['urban', 'city'],
  ['airport', 'airport'],
  ['port', 'harbor'],
  ['railway', 'railway'],
  ['religion', 'religious'],
  ['sound', 'sound'],
  ['sports', 'sports'],
  ['business', 'business'],
  ['traffic', 'traffic'],
]);
export const NON_TRAFFIC_TYPES = Object.freeze([
  'nature',
  'beach',
  'urban',
  'airport',
  'port',
  'railway',
  'religion',
  'sound',
]);
export const SCOPES = Object.freeze(['non-traffic', 'maryland', 'all']);
/**
 * City pages read for the maryland scope (sitemap slugs under /city/us/);
 * cards outside camindex's Maryland box are left out.
 */
export const MARYLAND_CITY_SLUGS = Object.freeze([
  'annapolis',
  'baltimore',
  'ocean-city',
  'frederick',
  'hagerstown',
  'columbia',
  'salisbury',
  'cumberland',
  'rockville',
  'silver-spring',
  'bethesda',
  'wash-dc',
]);
export const DEFAULT_SCOPE = 'non-traffic';
export const DEFAULT_LIMIT = FIRST_RUN_LIMIT;

/**
 * A hostname label of a road agency: a DOT (txdot, fdot, dot), a 511 site
 * (fl511, 511pa), anything traffic, or a known agency name.
 */
const TRAFFIC_LABEL =
  /^(?:\w*dot|dot\w*|\w*511\w*|\w*traffic\w*|transport\w*|highways?|roads?|carsprogram|drivebc|motorway|trafikverket|vegvesen|transtar|nzta|mainroads|autobahn)$/i;

const clean = (value, max = 160) =>
  decodeEntities(String(value ?? ''))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A directory webcam id from an app link, else null. */
export function webcamId(href) {
  let url;
  try {
    url = new URL(decodeEntities(String(href || '')), ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN) return null;
  const id = url.searchParams.get('webcam') || '';
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,60}$/.test(id) ? id : null;
}

/** The id as a catalog-safe slug; a changed id gets a short hash. */
export function slugId(id) {
  const raw = String(id || '');
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  if (!slug) return '';
  return slug === raw
    ? slug
    : `${slug}-${createHash('sha1').update(raw).digest('hex').slice(0, 6)}`;
}

/**
 * How a card's feed plays, from its stated format and source URL, as
 * linked.js classifies operator links: YouTube → embed, an https .m3u8 →
 * hls, an image → image, an operator player or anything else → link.
 * @returns {{feedType: string, url: string, snapshotUrl: string,
 *   embed?: object, operatorUrl: string}|null}
 */
export function classifyCard(format, sourceUrl) {
  const classified = classifyWebcamUrl(sourceUrl);
  if (!classified) return null;
  const said = String(format || '').toLowerCase();
  let kind = classified.kind;
  // The directory knows its formats better than a file extension does.
  if (said.startsWith('updating image') && classified.kind === 'link')
    kind = 'image';
  if (said.startsWith('operator player') && classified.kind !== 'youtube')
    kind = 'link';
  if (said.startsWith('motion jpeg')) kind = 'mjpeg';
  const https = classified.url.startsWith('https:');
  if (kind === 'youtube')
    return {
      feedType: 'youtube',
      url: classified.url,
      snapshotUrl: `https://i.ytimg.com/vi/${classified.videoId}/hqdefault.jpg`,
      embed: { provider: 'youtube', videoId: classified.videoId },
      operatorUrl: classified.url,
    };
  if (kind === 'hls' && https)
    return {
      feedType: 'hls',
      url: classified.url,
      snapshotUrl: '',
      operatorUrl: classified.url,
    };
  if (kind === 'image' && https)
    return {
      feedType: 'image',
      url: classified.url,
      snapshotUrl: classified.url,
      // What camindex verify fetches to check the camera.
      stillUrl: classified.url,
      operatorUrl: `${new URL(classified.url).origin}/`,
    };
  if (kind === 'mjpeg' && https)
    return {
      feedType: 'mjpeg',
      url: classified.url,
      snapshotUrl: '',
      operatorUrl: `${new URL(classified.url).origin}/`,
    };
  return {
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    operatorUrl: https ? classified.url : '',
  };
}

/** Whether a card's operator looks like a road agency. */
export function looksLikeTraffic(sourceUrl) {
  try {
    return new URL(String(sourceUrl)).hostname
      .split('.')
      .some((label) => TRAFFIC_LABEL.test(label));
  } catch {
    return false;
  }
}

/**
 * Every webcam card on a listing page.
 * @param {string} html
 * @param {{category?: string}} [context]  The type page's category, if any.
 */
export function parseCards(html, { category = '' } = {}) {
  const cards = [];
  const seen = new Set();
  const pattern = /<article class="webcam-seo-card">([\s\S]*?)<\/article>/g;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const body = match[1];
    const title = /<h3><a href="([^"]+)">([\s\S]*?)<\/a><\/h3>/.exec(body);
    const id = webcamId(title?.[1]);
    if (!id || seen.has(id)) continue;
    const where =
      /Location:\s*([\s\S]*?)\.\s*Coordinates:\s*(-?\d{1,3}(?:\.\d+)?)°,\s*(-?\d{1,3}(?:\.\d+)?)°/.exec(
        body,
      );
    if (!where) continue;
    const lat = Number(where[2]);
    const lon = Number(where[3]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
      continue;
    const format = /Format:\s*([^.<]{1,40})\./.exec(body)?.[1] || '';
    const operator = /Camera operator:\s*<a href="([^"]+)"/.exec(body)?.[1];
    const sourceUrl = operator ? decodeEntities(operator) : '';
    const feed = classifyCard(format, sourceUrl);
    if (!feed) continue;
    seen.add(id);
    cards.push({
      id: slugId(id),
      upstreamId: id,
      name: clean(title[2]) || `PocketWorld webcam ${id}`,
      lat,
      lon,
      place: clean(where[1], 80),
      format: clean(format, 40),
      sourceUrl,
      categories: category
        ? [category]
        : looksLikeTraffic(sourceUrl)
          ? ['traffic']
          : [],
      ...feed,
    });
  }
  return cards;
}

/** City and country listing pages from the media sitemap, English only. */
export function listingPagesFromSitemap(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => decodeEntities(m[1]))
    .filter((loc) =>
      /^https:\/\/pocketworld\.org\/webcams\/(?:country\/[a-z]{2}|city\/[a-z]{2}\/[a-z0-9-]{1,80})$/.test(
        loc,
      ),
    );
}

/** Fold a card seen again (another page) into what is known. */
export function mergeCard(known, next) {
  if (!known) return next;
  return {
    ...known,
    categories: [
      ...new Set([...(known.categories || []), ...(next.categories || [])]),
    ],
  };
}

/** A card's category for summaries and the catalog: typed, else traffic or webcam. */
export function categoryOf(candidate) {
  const typed = (candidate.categories || []).filter((c) => c !== 'traffic');
  if (typed.length) return typed[0];
  return (candidate.categories || []).includes('traffic')
    ? 'traffic'
    : 'webcam';
}

/**
 * Discover webcams.
 * @param {{get: Function}} fetcher
 * @param {{scope?: 'non-traffic'|'all', limit?: number,
 *   known?: Map<string, object>, log?: (line: string) => void}} [options]
 */
export async function discover(fetcher, options = {}) {
  const {
    scope = 'non-traffic',
    limit = FIRST_RUN_LIMIT,
    known = new Map(),
    log = () => {},
  } = options;
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
  const candidates = new Map(known);
  const found = new Set();
  const run = { pagesRead: 0, fromNetwork: 0, stoppedBy: 'complete' };
  const full = () => found.size >= limit;
  /** Maryland keeps every category inside the box; non-traffic drops road cams. */
  const keep = (card) => {
    if (scope === 'maryland') return inBox(card);
    if (scope === 'all') return true;
    const categories = card.categories || [];
    return (
      !categories.includes('traffic') ||
      categories.some((category) => category !== 'traffic')
    );
  };
  const read = async (url) => {
    let answer;
    try {
      answer = await fetcher.get(url);
    } catch (error) {
      if (
        error instanceof HostBlockedError ||
        error instanceof RobotsDisallowedError
      )
        throw error;
      log(`skipped ${url}: ${error?.message || error}`);
      return null;
    }
    run.pagesRead += 1;
    if (!answer.fromCache) run.fromNetwork += 1;
    return answer;
  };
  /** Exact feed URL → id, so two ids for one feed are kept once. */
  const byUrl = new Map(
    [...candidates.values()].filter((c) => c.url).map((c) => [c.url, c.id]),
  );
  const addAll = (cards) => {
    for (const card of cards) {
      if (full()) return;
      if (!keep(card)) continue;
      if (card.url && byUrl.has(card.url) && byUrl.get(card.url) !== card.id)
        continue;
      if (card.url) byUrl.set(card.url, card.id);
      candidates.set(
        card.id,
        mergeCard(candidates.get(card.id), { ...card, source: SOURCE }),
      );
      found.add(card.id);
    }
  };

  try {
    // The webcams API first; it is not parsed until it answers with JSON.
    const api = await read(API_PROBE_URL);
    run.api = api
      ? `${api.status} ${api.contentType || ''}`.trim()
      : 'unreachable';
    if (api?.ok && /json/i.test(api.contentType || ''))
      log(
        `webcams API answered JSON (${api.bytes} bytes); listings still used`,
      );
    else log(`webcams API: ${run.api}; reading listing pages`);

    const types =
      scope === 'all'
        ? TYPE_PAGES.map(([tag]) => tag)
        : scope === 'maryland'
          ? []
          : NON_TRAFFIC_TYPES;
    for (const tag of types) {
      if (full()) break;
      const category = Object.fromEntries(TYPE_PAGES)[tag];
      const page = await read(`${ORIGIN}/webcams/type/${tag}`);
      if (page?.ok && page.body)
        addAll(parseCards(page.body.toString('utf8'), { category }));
    }
    if (!full() && scope !== 'maryland') {
      const video = await read(`${ORIGIN}/webcams/video`);
      if (video?.ok && video.body)
        addAll(parseCards(video.body.toString('utf8')));
    }
    if (!full()) {
      const sitemap = await read(MEDIA_SITEMAP);
      const listed =
        sitemap?.ok && sitemap.body
          ? listingPagesFromSitemap(sitemap.body.toString('utf8'))
          : [];
      const pages =
        scope === 'maryland'
          ? listed.filter((url) =>
              MARYLAND_CITY_SLUGS.some((slug) =>
                url.endsWith(`/webcams/city/us/${slug}`),
              ),
            )
          : listed;
      log(`${pages.length} city and country pages listed`);
      for (const url of pages) {
        if (full()) break;
        const page = await read(url);
        if (page?.ok && page.body)
          addAll(parseCards(page.body.toString('utf8')));
        if (run.pagesRead % 50 === 0)
          log(`${run.pagesRead} pages, ${found.size} webcams`);
      }
    }
  } catch (error) {
    if (
      !(error instanceof HostBlockedError) &&
      !(error instanceof RobotsDisallowedError)
    )
      throw error;
    run.stoppedBy = error.message;
    log(`stopped: ${error.message}`);
  }
  if (run.stoppedBy === 'complete' && full()) run.stoppedBy = 'limit';
  markSharedPoints(candidates);
  return { candidates, found, ...run };
}

/** This many cards on one exact point is a town's pin, not each camera's. */
export const SHARED_POINT_MIN = 3;

/** Count, per candidate, how many candidates sit on its exact point. */
export function markSharedPoints(candidates) {
  const at = (c) => `${c.lat},${c.lon}`;
  const counts = new Map();
  for (const c of candidates.values())
    counts.set(at(c), (counts.get(at(c)) || 0) + 1);
  for (const c of candidates.values()) c.sharedPoint = counts.get(at(c));
  return candidates;
}

/**
 * Hosts whose "image" cards are really web pages. A host whose checked cards
 * (verify.json) answered something other than an image at least this often,
 * over at least this many checks, is a link host: its cards become operator
 * links, except a card verified live on its own.
 */
export const LINK_HOST_SHARE = 0.9;
export const LINK_HOST_MIN_CHECKED = 3;
export const LINK_HOSTS_FILE = 'link-hosts.json';
const NOT_AN_IMAGE = 'not an image';

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Link hosts from verify records: {host: {checked, nonImage}}. */
export function learnLinkHosts(candidates, records) {
  const byHost = new Map();
  for (const candidate of candidates) {
    const record = records[candidate.id];
    if (candidate.feedType !== 'image' || !record) continue;
    const host = hostOf(candidate.stillUrl || candidate.url);
    if (!host) continue;
    const seen = byHost.get(host) || { checked: 0, nonImage: 0 };
    seen.checked += 1;
    if (record.reason === NOT_AN_IMAGE) seen.nonImage += 1;
    byHost.set(host, seen);
  }
  const hosts = {};
  for (const [host, seen] of byHost)
    if (
      seen.checked >= LINK_HOST_MIN_CHECKED &&
      seen.nonImage / seen.checked >= LINK_HOST_SHARE
    )
      hosts[host] = seen;
  return hosts;
}

/** An image card that is really a page, as a link to that page. */
export function asLinkCard(candidate) {
  const page = String(candidate.url || '');
  const { stillUrl: _still, ...rest } = candidate;
  return {
    ...rest,
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    operatorUrl: page.startsWith('https:') ? page : candidate.operatorUrl,
    linkedFrom: 'image',
  };
}

/**
 * Turn page-not-image cards into links: every image card on a link host
 * (unless verified live itself) and any card whose own check answered
 * something other than an image. Their image verdicts no longer apply, so
 * those records are left out.
 * @returns {{candidates: Array<object>, records: Record<string, object>,
 *   converted: number}}
 */
export function applyLinkHosts(candidates, records, hosts) {
  const kept = { ...records };
  let converted = 0;
  const out = candidates.map((candidate) => {
    if (candidate.feedType !== 'image') return candidate;
    const record = records[candidate.id];
    const onLinkHost =
      Boolean(hosts[hostOf(candidate.stillUrl || candidate.url)]) &&
      record?.status !== 'live';
    if (!onLinkHost && record?.reason !== NOT_AN_IMAGE) return candidate;
    converted += 1;
    delete kept[candidate.id];
    return asLinkCard(candidate);
  });
  return { candidates: out, records: kept, converted };
}

/**
 * Learn link hosts from this source's verify records, record them in
 * <dir>/pocketworld/link-hosts.json and apply them; build and verify both
 * call this, so a new verdict applies on the next build with no recrawl.
 */
export function adjustCandidates(dir, candidates, records, now = Date.now()) {
  const hosts = learnLinkHosts(candidates, records);
  const file = path.join(dir, SOURCE, LINK_HOSTS_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify(
        {
          updatedAt: new Date(now).toISOString(),
          share: LINK_HOST_SHARE,
          minChecked: LINK_HOST_MIN_CHECKED,
          hosts,
        },
        null,
        1,
      ),
    );
    fs.renameSync(temporary, file);
  } catch {
    /* the rule still applies to this run */
  }
  const applied = applyLinkHosts(candidates, records, hosts);
  return { ...applied, linkHosts: Object.keys(hosts) };
}

/** One candidate → a catalog camera. */
export function toSource(candidate, record) {
  const name = clean(candidate.name) || `PocketWorld webcam ${candidate.id}`;
  const embed = candidate.feedType === 'youtube';
  return {
    id: `pocketworld-${candidate.id}`,
    name,
    city: clean(candidate.place, 80) || 'PocketWorld',
    cityId: 'pocketworld',
    provider: (() => {
      try {
        return new URL(candidate.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        return 'PocketWorld';
      }
    })(),
    credit: 'via PocketWorld (pocketworld.org)',
    lat: candidate.lat,
    lon: candidate.lon,
    headingConfidence: 'low',
    rangeM: 150,
    sourceKind: 'pocketworld',
    license:
      'Listed by PocketWorld (pocketworld.org); the feed belongs to its operator',
    code: name.toUpperCase(),
    category: categoryOf(candidate),
    coordinatesQuality:
      candidate.sharedPoint >= SHARED_POINT_MIN ? 'area' : 'site',
    operatorUrl: candidate.operatorUrl,
    publishSignal: 'directory-link',
    licenseClass: embed ? 'embed-only' : 'display-only',
    feedType: candidate.feedType,
    url: candidate.url,
    snapshotUrl: candidate.snapshotUrl,
    ...(candidate.embed ? { embed: { ...candidate.embed } } : {}),
    liveStatus: record?.status === 'live' ? 'live' : 'unknown',
  };
}
