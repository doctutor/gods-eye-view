import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_CACHE_FILE, AUDIO_VALUES } from './audioProbe.js';
import { camindexCatalogPath } from './camindex.js';
import {
  DEFAULT_DAILY_BUDGET,
  pendingFile,
  quotaDay,
} from './featuredChannels.js';
import { FEATURED_CACHE_DIR } from './featuredStore.js';

/**
 * The camera sources' status for the panel's SOURCES readout
 * (GET /api/cctv/status): what each pack holds and what it costs. Everything
 * is read from what the packs already keep: the catalog's last refresh, the
 * dynamic sources' counters, and the files under .gev-cache (the camindex
 * catalog and its observations, the featured queue and YouTube quota, the
 * audio answers). Large files are parsed once per change. Nothing here
 * fetches, and no key or URL with a key is ever returned.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

const MAX_FILE_BYTES = 128 * 1024 * 1024;
/** The camindex catalog's summary sits before its camera list. */
const CATALOG_HEAD_BYTES = 256 * 1024;

/** A JSON file summarized once per change (mtime and size), else null. */
function createFileSummary(summarize) {
  let held = null;
  return function read(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (
      held?.file === file &&
      held.mtimeMs === stat.mtimeMs &&
      held.size === stat.size
    )
      return held.value;
    let value = null;
    if (stat.size <= MAX_FILE_BYTES)
      try {
        value = summarize(JSON.parse(fs.readFileSync(file, 'utf8')), stat);
      } catch {
        value = null;
      }
    held = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  };
}

/**
 * The camindex catalog (tens of MB) summarized from its first bytes: the
 * crawler writes version, generatedAt and sources before the camera list,
 * so the list is never parsed. Falls back to the whole file if the layout
 * ever changes. Once per change of the file.
 */
function createCatalogHeadSummary() {
  let held = null;
  return function read(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (
      held?.file === file &&
      held.mtimeMs === stat.mtimeMs &&
      held.size === stat.size
    )
      return held.value;
    let value = null;
    try {
      const head = Buffer.alloc(Math.min(stat.size, CATALOG_HEAD_BYTES));
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const text = head.toString('utf8');
      const at = text.indexOf('"cameras":');
      let headDocument = null;
      if (at > 0)
        try {
          headDocument = JSON.parse(
            `${text.slice(0, at).replace(/,\s*$/, '')}}`,
          );
        } catch {
          headDocument = null;
        }
      if (headDocument?.sources && typeof headDocument.sources === 'object')
        value = summarizeCamindexCatalog(headDocument);
      else if (stat.size <= MAX_FILE_BYTES)
        value = summarizeCamindexCatalog(
          JSON.parse(fs.readFileSync(file, 'utf8')),
        );
    } catch {
      value = null;
    }
    held = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  };
}

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** camindex catalog.json → its own per-directory summary. */
export function summarizeCamindexCatalog(document) {
  const sources = {};
  for (const [name, row] of Object.entries(document?.sources || {}))
    if (/^[\w-]{1,40}$/.test(name))
      sources[name] = {
        found: finite(row?.found),
        verified: finite(row?.verified),
        live: finite(row?.live),
        dead: finite(row?.dead),
        served: finite(row?.served),
      };
  return {
    generatedAt:
      typeof document?.generatedAt === 'string' ? document.generatedAt : null,
    cameras: Array.isArray(document?.cameras)
      ? document.cameras.length
      : Object.values(sources).reduce((sum, row) => sum + row.served, 0),
    sources,
  };
}

/** camindex observed.json (id → {status}) → counts by status. */
export function summarizeObservations(document) {
  const counts = { live: 0, dead: 0, unknown: 0 };
  let latest = 0;
  for (const row of Object.values(
    document && typeof document === 'object' ? document : {},
  )) {
    const status =
      row?.status === 'live' || row?.status === 'dead' ? row.status : 'unknown';
    counts[status]++;
    if (Number.isFinite(row?.at) && row.at > latest) latest = row.at;
  }
  return {
    ...counts,
    total: counts.live + counts.dead + counts.unknown,
    lastAt: latest || null,
  };
}

/** cctv-audio.json → cached answers by state. */
export function summarizeAudio(document) {
  const byState = Object.fromEntries(AUDIO_VALUES.map((value) => [value, 0]));
  for (const row of Array.isArray(document?.cameras) ? document.cameras : [])
    if (AUDIO_VALUES.includes(row?.audio)) byState[row.audio]++;
  return byState;
}

/**
 * The featured quota file → today's units (0 when the file is from another
 * YouTube day) against the budget.
 */
export function youtubeQuota(
  document,
  { now = Date.now(), env = process.env } = {},
) {
  const budget = Number(env.YOUTUBE_DAILY_BUDGET);
  const today = quotaDay(now);
  const current = document?.day === today;
  return {
    day: today,
    units: current ? finite(document?.units) : 0,
    budget:
      Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_DAILY_BUDGET,
    geocodes: current ? finite(document?.geocodes) : 0,
  };
}

/**
 * @param {{sourceRoot?: string, getCctvSources: Function,
 *   frameCache?: {stats: () => object}, audioCachePath?: string,
 *   now?: () => number, env?: object}} options
 */
export function createCctvStatus({
  sourceRoot = process.cwd(),
  getCctvSources,
  frameCache,
  // Where the audio probe keeps its answers (its own default).
  audioCachePath = path.join(process.cwd(), AUDIO_CACHE_FILE),
  now = () => Date.now(),
  env = process.env,
}) {
  const camindexCatalog = createCatalogHeadSummary();
  const observations = createFileSummary(summarizeObservations);
  const audio = createFileSummary(summarizeAudio);
  const pending = createFileSummary((document) =>
    Array.isArray(document?.items) ? document.items.length : 0,
  );
  const quota = createFileSummary((document) => document);

  return function status() {
    const catalog = getCctvSources.status?.() || {
      refreshedAt: null,
      packs: [],
      dynamic: [],
    };
    const index = getCctvSources.index?.() || [];
    let listed = 0;
    let liveNow = 0;
    for (const source of index)
      if (source.pack === 'featured') {
        listed++;
        if (source.liveStatus === 'live') liveNow++;
      }
    const camindexFile = camindexCatalogPath(sourceRoot, env);
    const frames = frameCache?.stats?.() || null;
    const lookups = frames ? finite(frames.hits) + finite(frames.misses) : 0;
    return {
      generatedAt: new Date(now()).toISOString(),
      refreshedAt: catalog.refreshedAt
        ? new Date(catalog.refreshedAt).toISOString()
        : null,
      packs: catalog.packs.map((pack) => ({
        ...pack,
        lastRefreshAt: pack.lastRefreshAt
          ? new Date(pack.lastRefreshAt).toISOString()
          : null,
        lastError: pack.lastError
          ? {
              at: new Date(pack.lastError.at).toISOString(),
              message: pack.lastError.message,
            }
          : null,
      })),
      dynamic: catalog.dynamic.map((source) => ({
        ...source,
        lastError: source.lastError
          ? {
              at: new Date(source.lastError.at).toISOString(),
              message: String(source.lastError.message).slice(0, 200),
            }
          : null,
      })),
      camindex: {
        catalog: camindexCatalog(camindexFile),
        verified: observations(
          path.join(path.dirname(camindexFile), 'observed.json'),
        ),
      },
      featured: {
        listed,
        liveNow,
        pending: pending(pendingFile(sourceRoot)) ?? 0,
        youtube: youtubeQuota(
          quota(path.join(sourceRoot, FEATURED_CACHE_DIR, 'quota.json')),
          {
            now: now(),
            env,
          },
        ),
      },
      audio: audio(audioCachePath),
      frameCache: frames
        ? {
            entries: finite(frames.entries),
            bytes: finite(frames.bytes),
            hits: finite(frames.hits),
            misses: finite(frames.misses),
            hitRate: lookups
              ? Math.round((finite(frames.hits) / lookups) * 1000) / 1000
              : null,
          }
        : null,
    };
  };
}
