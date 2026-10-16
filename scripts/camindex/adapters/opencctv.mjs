import { gunzipSync } from 'node:zlib';
import { RobotsDisallowedError, HostBlockedError } from '../fetch.mjs';

/**
 * OpenCCTV (opencctv.org), a public directory of live cameras.
 *
 * Read under the rules in ../SOURCES.md: only paths robots.txt allows
 * (/cameras/ listing and camera pages, sitemaps), one request per 1.5 s,
 * every page cached on disk for a week, never /api/. Each camera page and
 * each listing page carries schema.org JSON-LD (an ImageObject per camera
 * with coordinates, and an ItemList on listing pages), which is all this
 * adapter reads; nothing in a page is executed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const ORIGIN = 'https://opencctv.org';
export const SOURCE = 'opencctv';
/** The directory's own categories, in the order a camera's primary one is chosen. */
export const CATEGORIES = Object.freeze([
  'nature',
  'beach',
  'ski',
  'airport',
  'satellite',
  'weather',
  'traffic',
]);
export const NON_TRAFFIC = Object.freeze(
  CATEGORIES.filter((category) => category !== 'traffic'),
);
export const SCOPES = Object.freeze([
  'default',
  'maryland',
  'non-traffic',
  'all',
]);
/** Region listings read for the maryland scope. */
const MARYLAND = {
  path: '/cameras/united-states/maryland',
  region: 'Maryland',
};
/** Listing pages read per root at most (the largest category has ~1,400). */
const MAX_LISTING_PAGES = 2000;
const CAMERA_PATH = /^\/cameras\/[a-z0-9-]+(?:\/[a-z0-9-]+)*-(\d{1,9})\/?$/;
const STILL_PATH = /^\/still\/(\d{1,9})\.jpg$/;

const clean = (value, max = 160) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
};
function decodeEntities(text) {
  return String(text).replace(
    /&(amp|lt|gt|quot|apos|#39|#x27);/g,
    (_, name) => ENTITIES[name],
  );
}

/** A camera page URL on opencctv.org and its numeric id, else null. */
export function cameraPageId(value) {
  let url;
  try {
    url = new URL(String(value || ''), ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'opencctv.org') return null;
  const id = CAMERA_PATH.exec(url.pathname)?.[1];
  return id ? { id, url: `${ORIGIN}${url.pathname.replace(/\/$/, '')}` } : null;
}

/** The directory's published still for a camera id. */
export function stillUrl(id) {
  return `${ORIGIN}/still/${id}.jpg`;
}

/**
 * Every JSON-LD object in a page, flattened (arrays and @graph), skipping
 * blocks that do not parse.
 */
export function extractJsonLd(html) {
  const out = [];
  const pattern =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      out.push(node);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    }
  };
  while ((match = pattern.exec(String(html || '')))) {
    if (match[1].length > 2 * 1024 * 1024) continue;
    try {
      visit(JSON.parse(match[1]));
    } catch {
      /* a malformed block is skipped */
    }
  }
  return out;
}

const typeIs = (node, type) =>
  node?.['@type'] === type ||
  (Array.isArray(node?.['@type']) && node['@type'].includes(type));

function geoOf(node) {
  const geo = node?.contentLocation?.geo || node?.geo;
  const lat = Number(geo?.latitude);
  const lon = Number(geo?.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  )
    return null;
  return { lat, lon };
}

/** The category a camera page's caption states ("Live traffic camera on …"). */
export function categoryFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\btraffic camera\b|\bhighway camera\b|\broad camera\b/.test(t))
    return 'traffic';
  if (/\bbeach\b|\bsurf\b|\bpier\b/.test(t)) return 'beach';
  if (/\bski\b|\bslopes?\b|\bsnow ?cam\b/.test(t)) return 'ski';
  if (/\bairport\b|\brunway\b|\bairfield\b/.test(t)) return 'airport';
  if (/\bsatellite\b/.test(t)) return 'satellite';
  if (/\bweather camera\b|\bweather station\b/.test(t)) return 'weather';
  if (
    /\bnature\b|\bwildlife\b|\bnest\b|\bvolcano\b|\bforest\b|\blake\b/.test(t)
  )
    return 'nature';
  return '';
}

/** The primary category among several (scenic ahead of traffic). */
export function primaryCategory(categories) {
  for (const category of CATEGORIES)
    if (categories.includes(category)) return category;
  return categories[0] || 'webcam';
}

/**
 * One listing page: its cameras (from the ItemList) and how many pages the
 * listing has ("Page 1 of 357").
 * @returns {{items: Array<object>, pages: number}}
 */
export function parseListingPage(html, { category = '', region = '' } = {}) {
  const items = [];
  const seen = new Set();
  for (const node of extractJsonLd(html)) {
    if (!typeIs(node, 'ItemList')) continue;
    for (const entry of Array.isArray(node.itemListElement)
      ? node.itemListElement
      : []) {
      const item = entry?.item || entry;
      const page = cameraPageId(item?.url);
      if (!page || seen.has(page.id)) continue;
      seen.add(page.id);
      const geo = geoOf(item);
      items.push({
        id: page.id,
        name: clean(item.name) || `OpenCCTV camera ${page.id}`,
        pageUrl: page.url,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        place: clean(item.contentLocation?.name, 80),
        region,
        categories: category ? [category] : [],
        // Every camera page publishes /still/<id>.jpg as its image (its
        // og:image); a listing card does not show it.
        stillUrl: stillUrl(page.id),
      });
    }
  }
  const pages = Number(
    /Page\s+\d+\s+of\s+(\d{1,5})/i.exec(String(html || ''))?.[1],
  );
  return { items, pages: Number.isInteger(pages) && pages > 0 ? pages : 1 };
}

/**
 * One camera page → a candidate, or null when the page has no camera with
 * coordinates.
 */
export function parseCameraPage(html, pageUrl) {
  const page = cameraPageId(pageUrl);
  if (!page) return null;
  const nodes = extractJsonLd(html);
  const image = nodes.find(
    (node) => typeIs(node, 'ImageObject') && geoOf(node),
  );
  if (!image) return null;
  const geo = geoOf(image);
  const address = image.contentLocation?.address || {};
  const crumbs =
    nodes
      .find((node) => typeIs(node, 'BreadcrumbList'))
      ?.itemListElement?.map?.((entry) => clean(entry?.name, 80)) || [];
  // The still the page publishes (its og:image), when it is the usual one.
  let still = '';
  try {
    const content = new URL(String(image.contentUrl || ''));
    if (
      content.protocol === 'https:' &&
      content.hostname === 'opencctv.org' &&
      STILL_PATH.exec(content.pathname)?.[1] === page.id
    )
      still = content.href;
  } catch {
    /* none published */
  }
  const caption = clean(image.caption, 400);
  const category = categoryFromText(caption);
  return {
    id: page.id,
    name: clean(image.name) || `OpenCCTV camera ${page.id}`,
    pageUrl: page.url,
    lat: geo.lat,
    lon: geo.lon,
    place: clean(address.addressLocality || crumbs[crumbs.length - 2], 80),
    region: clean(address.addressRegion, 80),
    country: clean(address.addressCountry, 80),
    caption,
    categories: category ? [category] : [],
    stillUrl: still,
  };
}

/** Sitemap <loc> entries. */
export function parseSitemap(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
    (match) => decodeEntities(match[1]),
  );
}

/** Listing roots a scope reads: {path, category, region}. */
export function listingRoots(scope = 'default') {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
  const roots = [];
  const global = (categories) =>
    categories.map((category) => ({
      path: `/cameras/category/${category}`,
      category,
      region: '',
    }));
  if (scope === 'all') roots.push(...global(CATEGORIES));
  if (scope === 'default' || scope === 'non-traffic')
    roots.push(...global(NON_TRAFFIC));
  if (scope === 'default' || scope === 'maryland') {
    for (const category of CATEGORIES)
      roots.push({
        path: `${MARYLAND.path}/category/${category}`,
        category,
        region: MARYLAND.region,
      });
    // The whole region, for cameras in no category.
    roots.push({ path: MARYLAND.path, category: '', region: MARYLAND.region });
  }
  return roots;
}

/** Fold a newly seen candidate into what is known about the same camera. */
export function mergeCandidate(known, next) {
  if (!known) return { ...next, categories: [...new Set(next.categories)] };
  const merged = { ...known };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'categories') continue;
    if (value !== '' && value !== null && value !== undefined)
      merged[key] =
        merged[key] === '' || merged[key] == null ? value : merged[key];
  }
  // A camera page is more authoritative than a listing card.
  if (next.caption) {
    for (const key of ['name', 'lat', 'lon', 'place', 'stillUrl'])
      if (next[key] !== '' && next[key] != null) merged[key] = next[key];
  }
  merged.categories = [
    ...new Set([...(known.categories || []), ...(next.categories || [])]),
  ];
  return merged;
}

/**
 * Discover cameras.
 * @param {{get: Function}} fetcher - fetch.mjs fetcher.
 * @param {{scope?: string, limit?: number, via?: 'listings'|'sitemap'|'commoncrawl',
 *   known?: Map<string, object>, log?: (line: string) => void,
 *   pageDetails?: boolean, commonCrawlIndex?: string}} [options]
 * @returns {Promise<{candidates: Map<string, object>, pagesRead: number,
 *   fromNetwork: number, stoppedBy: string}>}
 */
export async function discover(fetcher, options = {}) {
  const {
    scope = 'default',
    limit = Infinity,
    via = 'listings',
    known = new Map(),
    log = () => {},
  } = options;
  const candidates = new Map(known);
  const found = new Set();
  const run = { pagesRead: 0, fromNetwork: 0, stoppedBy: 'complete' };
  const full = () => found.size >= limit;

  run.skipped = [];
  const read = async (url, extra = {}) => {
    let answer;
    try {
      answer = await fetcher.get(url, extra);
    } catch (error) {
      if (
        error instanceof HostBlockedError ||
        error instanceof RobotsDisallowedError
      )
        throw error;
      // One page that keeps failing is skipped; a host that keeps failing
      // stops the run (HostBlockedError).
      run.skipped.push(url);
      log(`skipped ${url}: ${error?.message || error}`);
      return SKIPPED;
    }
    run.pagesRead += 1;
    if (!answer.fromCache) run.fromNetwork += 1;
    if (!answer.ok || !answer.body) return null;
    return answer.body.toString('utf8');
  };
  const add = (candidate) => {
    candidates.set(
      candidate.id,
      mergeCandidate(candidates.get(candidate.id), {
        ...candidate,
        source: SOURCE,
      }),
    );
    found.add(candidate.id);
  };

  try {
    if (via === 'listings') {
      for (const root of listingRoots(scope)) {
        if (full()) break;
        let pages = 1;
        for (let page = 1; page <= Math.min(pages, MAX_LISTING_PAGES); page++) {
          if (full()) break;
          const url = `${ORIGIN}${root.path}${page > 1 ? `?page=${page}` : ''}`;
          const html = await read(url);
          if (html === SKIPPED) continue;
          if (!html) break;
          const listing = parseListingPage(html, root);
          if (page === 1) pages = listing.pages;
          if (!listing.items.length) break;
          for (const item of listing.items) {
            if (full()) break;
            add(item);
          }
          if (page === 1 || page % 25 === 0)
            log(
              `${root.path} page ${page}/${pages}: ${found.size} cameras so far`,
            );
        }
      }
      // A card without coordinates needs its camera page.
      const missing = [...found]
        .map((id) => candidates.get(id))
        .filter(
          (candidate) =>
            options.pageDetails ||
            !Number.isFinite(candidate.lat) ||
            !Number.isFinite(candidate.lon),
        );
      if (missing.length) log(`${missing.length} camera pages to read`);
      for (const candidate of missing) {
        const html = await read(candidate.pageUrl);
        const parsed =
          typeof html === 'string' && parseCameraPage(html, candidate.pageUrl);
        if (parsed) add(parsed);
      }
    } else if (via === 'sitemap') {
      const index = await read(`${ORIGIN}/sitemap.xml`);
      const maps = parseSitemap(index === SKIPPED ? '' : index).filter((loc) =>
        /\/sitemap-cameras-\d+\.xml$/.test(loc),
      );
      for (const map of maps) {
        if (full()) break;
        const xml = await read(map);
        const pages = parseSitemap(xml === SKIPPED ? '' : xml).filter(
          cameraPageId,
        );
        for (const pageUrl of pages) {
          if (full()) break;
          const html = await read(pageUrl);
          const parsed =
            typeof html === 'string' && parseCameraPage(html, pageUrl);
          if (parsed) add(parsed);
          if (run.pagesRead % 100 === 0)
            log(`sitemap: ${run.pagesRead} pages, ${found.size} cameras`);
        }
      }
    } else if (via === 'commoncrawl') {
      await discoverFromCommonCrawl(fetcher, {
        index: options.commonCrawlIndex,
        add,
        full,
        run,
        log,
      });
    } else {
      throw new Error(`unknown --via ${via}`);
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
  return { candidates, found, ...run };
}

/** A page that failed after retries (not an HTTP answer). */
const SKIPPED = Symbol('skipped');

export const COMMON_CRAWL_INDEX = 'CC-MAIN-2026-39';

/**
 * Split one WARC response record (already gunzipped) into its HTTP body.
 * @returns {string|null}
 */
export function warcHtmlBody(record) {
  const text = Buffer.isBuffer(record)
    ? record.toString('utf8')
    : String(record);
  const httpStart = text.indexOf('\r\n\r\nHTTP/');
  if (httpStart < 0) return null;
  const http = text.slice(httpStart + 4);
  const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(http)?.[1]);
  if (status !== 200) return null;
  const bodyStart = http.indexOf('\r\n\r\n');
  return bodyStart < 0 ? null : http.slice(bodyStart + 4);
}

/**
 * Camera pages from a Common Crawl capture, instead of opencctv.org. The CDX
 * index is read page by page and every answer is cached, so an interrupted
 * run resumes where it stopped.
 */
async function discoverFromCommonCrawl(
  fetcher,
  { index, add, full, run, log },
) {
  const name = index || COMMON_CRAWL_INDEX;
  const api = `https://index.commoncrawl.org/${name}-index`;
  const query = `url=${encodeURIComponent('opencctv.org/cameras/*')}&output=json&filter=status:200&filter=mime:text/html`;
  const head = await fetcher.get(`${api}?${query}&showNumPages=true`, {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  });
  run.pagesRead += 1;
  if (!head.ok) throw new Error(`Common Crawl index answered ${head.status}`);
  const pages = Number(JSON.parse(head.body.toString('utf8'))?.pages) || 0;
  log(`Common Crawl ${name}: ${pages} index pages`);
  for (let page = 0; page < pages && !full(); page++) {
    const listing = await fetcher.get(`${api}?${query}&page=${page}`, {
      maxAgeMs: 365 * 24 * 60 * 60 * 1000,
    });
    run.pagesRead += 1;
    if (!listing.ok)
      throw new Error(`Common Crawl index answered ${listing.status}`);
    for (const line of listing.body.toString('utf8').split('\n')) {
      if (full()) break;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const pageUrl = cameraPageId(row?.url)?.url;
      const offset = Number(row?.offset);
      const length = Number(row?.length);
      if (
        !pageUrl ||
        !/^crawl-data\/[\w./-]+\.warc\.gz$/.test(String(row?.filename)) ||
        !Number.isInteger(offset) ||
        !Number.isInteger(length) ||
        length <= 0 ||
        length > 2 * 1024 * 1024
      )
        continue;
      const range = `bytes=${offset}-${offset + length - 1}`;
      const record = await fetcher.get(
        `https://data.commoncrawl.org/${row.filename}`,
        {
          headers: { Range: range },
          variant: range,
          maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        },
      );
      run.pagesRead += 1;
      if (!record.ok || !record.body) continue;
      let html;
      try {
        html = warcHtmlBody(gunzipSync(record.body));
      } catch {
        continue;
      }
      const parsed = html && parseCameraPage(html, pageUrl);
      if (parsed) add(parsed);
    }
    log(`Common Crawl page ${page + 1}/${pages}`);
  }
}
