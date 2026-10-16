import { createHash } from 'node:crypto';
import { HostBlockedError, RobotsDisallowedError } from '../fetch.mjs';

/**
 * Open-Eagle-Eye (github.com/stuchapin909/Open-Eagle-Eye, MIT): a registry of
 * about 31,500 public still cameras in one JSON file. It is read once a week
 * through the shared fetcher (robots.txt, pacing, disk cache); nothing from
 * the project is run. Rules in ../SOURCES.md.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const SOURCE = 'openeagleeye';
export const REGISTRY_URL =
  'https://raw.githubusercontent.com/stuchapin909/Open-Eagle-Eye/master/cameras.json';
/** The registry is ~14 MB; one file, so it gets its own size allowance. */
export const REGISTRY_MAX_BYTES = 32 * 1024 * 1024;
export const REGISTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The registry's categories in the app's words; any other is kept as given. */
export const CATEGORY_WORDS = Object.freeze({
  highway: 'traffic',
  traffic: 'traffic',
  city: 'city',
  beach: 'beach',
  airport: 'airport',
  volcano: 'volcano',
  wildlife: 'nature',
  nature: 'nature',
});

const clean = (value, max = 160) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A category word the app accepts (letters and hyphens), from theirs. */
export function categoryWord(category) {
  const raw = String(category || '')
    .toLowerCase()
    .trim();
  const word = CATEGORY_WORDS[raw] || raw;
  return /^[a-z][a-z-]{0,23}$/.test(word) ? word : 'webcam';
}

/**
 * Whether a row needs credentials: `auth: true`, or an object naming any
 * requirement (`{required: …}`). `false`, `null` and `{}` need none.
 */
export function needsAuth(auth) {
  if (auth === true) return true;
  if (auth && typeof auth === 'object') return Object.keys(auth).length > 0;
  return false;
}

/** An IANA zone Intl knows, else ''. */
export function validTimeZone(zone) {
  const value = String(zone || '').trim();
  if (!value || value.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return '';
  }
}

/** Their id as a catalog-safe slug; a changed id gets a short hash so two never collide. */
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
 * The registry → candidates, plus what was dropped and why. Rows need https
 * image URLs, real coordinates and no credentials; an exact URL seen twice
 * is kept once.
 * @param {string} text
 */
export function parseRegistry(text) {
  let rows;
  try {
    rows = JSON.parse(String(text || ''));
  } catch {
    rows = null;
  }
  const dropped = { auth: 0, coordinates: 0, url: 0, duplicate: 0, id: 0 };
  const candidates = [];
  if (!Array.isArray(rows)) return { candidates, dropped, rows: 0 };
  const seenUrls = new Set();
  const seenIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (needsAuth(row.auth)) {
      dropped.auth++;
      continue;
    }
    const lat = Number(row.coordinates?.lat);
    const lon = Number(row.coordinates?.lng ?? row.coordinates?.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    ) {
      dropped.coordinates++;
      continue;
    }
    let url;
    try {
      url = new URL(String(row.url || ''));
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
      dropped.url++;
      continue;
    }
    if (seenUrls.has(url.href)) {
      dropped.duplicate++;
      continue;
    }
    const id = slugId(row.id);
    if (!id || seenIds.has(id)) {
      dropped.id++;
      continue;
    }
    seenUrls.add(url.href);
    seenIds.add(id);
    const category = categoryWord(row.category);
    candidates.push({
      id,
      upstreamId: clean(row.id, 80),
      name: clean(row.name) || `Open-Eagle-Eye camera ${id}`,
      lat,
      lon,
      place: clean(row.city, 80),
      region: clean(row.location, 120),
      country: clean(row.country, 8),
      categories: [category],
      stillUrl: url.href,
      provider: url.hostname.replace(/^www\./, ''),
      operatorUrl: `${url.origin}/`,
      timeZone: validTimeZone(row.timezone),
      upstreamVerified: row.verified === true,
    });
  }
  return { candidates, dropped, rows: rows.length };
}

/** The candidate's category, for run summaries. */
export function categoryOf(candidate) {
  return candidate.categories?.[0] || 'webcam';
}

/**
 * Read the registry (once a week; a rerun replays it from disk).
 * @param {{get: Function}} fetcher
 * @param {{limit?: number, log?: (line: string) => void}} [options]
 */
export async function discover(fetcher, options = {}) {
  const { limit = Infinity, log = () => {} } = options;
  const candidates = new Map();
  const found = new Set();
  const run = { pagesRead: 0, fromNetwork: 0, stoppedBy: 'complete' };
  let answer;
  try {
    answer = await fetcher.get(REGISTRY_URL, {
      maxBytes: REGISTRY_MAX_BYTES,
      maxAgeMs: REGISTRY_MAX_AGE_MS,
    });
  } catch (error) {
    if (
      !(error instanceof HostBlockedError) &&
      !(error instanceof RobotsDisallowedError) &&
      !error?.oversize
    )
      throw error;
    run.stoppedBy = error.message;
    log(`stopped: ${error.message}`);
    return { candidates, found, ...run };
  }
  run.pagesRead = 1;
  if (!answer.fromCache) run.fromNetwork = 1;
  if (!answer.ok || !answer.body) {
    run.stoppedBy = `registry answered ${answer.status}`;
    return { candidates, found, ...run };
  }
  const parsed = parseRegistry(answer.body.toString('utf8'));
  log(
    `registry: ${parsed.rows} rows, ${parsed.candidates.length} usable; dropped ${JSON.stringify(parsed.dropped)}`,
  );
  for (const candidate of parsed.candidates) {
    if (found.size >= limit) {
      run.stoppedBy = 'limit';
      break;
    }
    candidates.set(candidate.id, { ...candidate, source: SOURCE });
    found.add(candidate.id);
  }
  run.dropped = parsed.dropped;
  return { candidates, found, ...run };
}

/**
 * One candidate → a catalog camera: the operator's own still, linked to the
 * operator's site, with the registry's IANA zone for the panel's local time.
 */
export function toSource(candidate, record) {
  const name = clean(candidate.name) || `Open-Eagle-Eye camera ${candidate.id}`;
  return {
    id: `openeagleeye-${candidate.id}`,
    name,
    city: clean(candidate.place || candidate.region, 80) || 'Open-Eagle-Eye',
    cityId: 'openeagleeye',
    provider: candidate.provider,
    credit: 'via Open-Eagle-Eye (MIT)',
    lat: candidate.lat,
    lon: candidate.lon,
    headingConfidence: 'low',
    rangeM: 150,
    sourceKind: 'openeagleeye',
    license:
      'Listed in the Open-Eagle-Eye registry (MIT); the image belongs to its operator',
    code: name.toUpperCase(),
    category: categoryOf(candidate),
    coordinatesQuality: 'site',
    operatorUrl: candidate.operatorUrl,
    publishSignal: 'operator-page',
    licenseClass: 'display-only',
    feedType: 'image',
    url: candidate.stillUrl,
    snapshotUrl: candidate.stillUrl,
    ...(candidate.timeZone ? { timeZone: candidate.timeZone } : {}),
    liveStatus: record?.status === 'live' ? 'live' : 'unknown',
    ...(record?.verifiedAt
      ? { verifiedAt: new Date(record.verifiedAt).toISOString() }
      : {}),
  };
}
