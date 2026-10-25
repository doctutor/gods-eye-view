/**
 * Personal fork: the SOURCES block of the CCTV panel — what the camera index
 * holds and what it costs. Reads /api/cctv/status (server cctv/status.js) and
 * the Street View indoor status route when that is mounted; fetched when the
 * block opens and every 60 s while it stays open. Everything is written with
 * textContent.
 */

import { t } from '../i18n/index.js';

export const SOURCES_REFRESH_MS = 60_000;
const STATUS_URL = '/api/cctv/status';
const STREETVIEW_STATUS_URL = '/api/streetview/indoor/status';

/** Short labels for pack names. */
const LABELS = Object.freeze({
  featured: 'FEATURED',
  'usgs-volcano': 'USGS VOLCANO',
  nps: 'NPS',
  linked: 'OSM/WIKIDATA',
  camindex: 'OPENCCTV',
  windy: 'WINDY',
  mdot: 'MDOT',
  deldot: 'DELDOT',
  caltrans: 'CALTRANS',
  txdot: 'TXDOT',
  tfl: 'TFL',
  nsw: 'NSW',
  drivebc: 'DRIVEBC',
  fintraffic: 'FINTRAFFIC',
  vegvesen: 'VEGVESEN',
  tarktee: 'TARKTEE',
});

const label = (name) =>
  LABELS[name] ||
  String(name || '?')
    .toUpperCase()
    .slice(0, 16);

/** 1234 → "1.2k", 29980 → "30k". */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Bytes → "12 MB". */
export function formatBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** An ISO time → "4m ago" (or "" when absent). */
export function ageText(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t('{n}s ago', { n: s });
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) });
  if (s < 86_400) return t('{n}h ago', { n: Math.round(s / 3600) });
  return t('{n}d ago', { n: Math.round(s / 86_400) });
}

/** The quota line: YouTube units, Windy requests, Street View probes (exact). */
export function quotaLine(status, streetview) {
  const exact = (value) =>
    Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : '–';
  const parts = [];
  const youtube = status?.featured?.youtube;
  if (youtube)
    parts.push(
      t('YouTube {used} / {budget} units today', {
        used: exact(youtube.units),
        budget: exact(youtube.budget),
      }),
    );
  const windy = (status?.dynamic || []).find((d) => d.name === 'windy');
  if (windy?.enabled && windy.configured !== false)
    parts.push(
      windy.budgetPerMinute
        ? t('Windy {used} / {budget} req/min', {
            used: exact(windy.requestsLastMinute ?? 0),
            budget: exact(windy.budgetPerMinute),
          })
        : t('Windy {used} req/min', {
            used: exact(windy.requestsLastMinute ?? 0),
          }),
    );
  if (streetview && Number.isFinite(Number(streetview.dailyCap)))
    parts.push(
      t('Street View {used} / {budget}', {
        used: exact(streetview.usedToday),
        budget: exact(streetview.dailyCap),
      }),
    );
  return parts.join(' · ');
}

const errorText = (error) =>
  error ? `${String(error.message || 'error').slice(0, 120)}` : null;

const UPSTREAM_LISTS = { osm: 'OpenStreetMap', wikidata: 'Wikidata' };

/**
 * Personal fork: a pack that refreshes its own lists in the background
 * (the linked webcams): its age is its oldest list's, a note while a
 * refresh runs, and the last failure. {age (null when it says nothing),
 * note, error, empty (no list held at all, and one failed)}.
 */
export function upstreamParts(upstream, now = Date.now()) {
  const lists = Array.isArray(upstream?.lists) ? upstream.lists : [];
  if (!lists.length) return { age: null, note: '', error: null, empty: false };
  const held = lists.filter((list) => list.at);
  const oldest = held
    .map((list) => list.at)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const failed = lists.filter((list) => list.lastFailedAt);
  return {
    age: oldest
      ? t('data {age}', { age: ageText(oldest, now) })
      : t('no data yet'),
    note: lists.some((list) => list.refreshing) ? t('refreshing') : '',
    error: failed.length
      ? failed
          .map((list) =>
            t('{list} refresh failed {age}: {error}', {
              list: UPSTREAM_LISTS[list.name] || list.name,
              age: ageText(list.lastFailedAt, now),
              error: String(list.lastError || 'error').slice(0, 80),
            }),
          )
          .join('; ')
      : null,
    empty: !held.length && failed.length > 0,
  };
}

/**
 * One row per source: {key, label, counts, age, error, state}.
 * state: 'ok', 'error' (last attempt failed) or 'off'.
 */
export function sourceRows(status, streetview, now = Date.now()) {
  const rows = [];
  for (const pack of status?.packs || []) {
    const counts = pack.skipped
      ? t('off: {reason}', { reason: String(pack.skipped).slice(0, 60) })
      : [
          t('{count} indexed', { count: formatCount(pack.inIndex) }),
          pack.proximityOnly
            ? null
            : t('{count} on map', { count: formatCount(pack.servedCapped) }),
          pack.dedupedAway
            ? t('{count} folded', { count: formatCount(pack.dedupedAway) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ');
    const upstream = upstreamParts(pack.upstream, now);
    rows.push({
      key: `pack:${pack.name}`,
      label: label(pack.name),
      counts: [counts, upstream.note].filter(Boolean).join(' · '),
      age: pack.skipped
        ? ''
        : (upstream.age ?? ageText(pack.lastRefreshAt, now)),
      error: upstream.error || errorText(pack.lastError),
      state:
        !pack.enabled || pack.skipped
          ? 'off'
          : pack.lastError || upstream.empty
            ? 'error'
            : 'ok',
    });
  }
  for (const source of status?.dynamic || []) {
    rows.push({
      key: `dynamic:${source.name}`,
      label: label(source.name),
      counts:
        source.configured === false
          ? t('no key')
          : t('{areas} areas cached · {cams} cams', {
              areas: formatCount(source.cacheEntries),
              cams: formatCount(source.knownCameras),
            }),
      age: '',
      error: errorText(source.lastError),
      state:
        !source.enabled || source.configured === false
          ? 'off'
          : source.lastError
            ? 'error'
            : 'ok',
    });
  }
  const camindex = status?.camindex;
  if (camindex?.catalog || camindex?.verified) {
    const verified = camindex.verified;
    rows.push({
      key: 'camindex:catalog',
      label: t('OPENCCTV FILE'),
      counts: [
        camindex.catalog
          ? t('{count} cams', { count: formatCount(camindex.catalog.cameras) })
          : null,
        verified
          ? verified.unknown
            ? t('checked {live} live / {dead} dead / {unknown} ?', {
                live: formatCount(verified.live),
                dead: formatCount(verified.dead),
                unknown: formatCount(verified.unknown),
              })
            : t('checked {live} live / {dead} dead', {
                live: formatCount(verified.live),
                dead: formatCount(verified.dead),
              })
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      age: ageText(camindex.catalog?.generatedAt, now),
      error: null,
      state: 'ok',
    });
  }
  const featured = status?.featured;
  if (featured)
    rows.push({
      key: 'featured:youtube',
      // i18n-ignore: brand name
      label: 'YOUTUBE',
      counts: t('{listed} listed · {live} live · {pending} pending', {
        listed: formatCount(featured.listed),
        live: formatCount(featured.liveNow),
        pending: formatCount(featured.pending),
      }),
      age: '',
      error: null,
      state: 'ok',
    });
  const audio = status?.audio;
  if (audio)
    rows.push({
      key: 'audio',
      label: t('AUDIO'),
      counts: t(
        '{sound} sound · {silent} silent · {likely} likely · {unknown} ?',
        {
          sound: formatCount(audio.audio),
          silent: formatCount(audio.silent),
          likely: formatCount(audio.likely),
          unknown: formatCount(audio.unknown),
        },
      ),
      age: '',
      error: null,
      state: 'ok',
    });
  const frames = status?.frameCache;
  if (frames)
    rows.push({
      key: 'frames',
      label: t('FRAME CACHE'),
      counts:
        frames.hitRate === null || frames.hitRate === undefined
          ? t('{frames} frames · {size}', {
              frames: formatCount(frames.entries),
              size: formatBytes(frames.bytes),
            })
          : t('{frames} frames · {size} · {rate}% hits', {
              frames: formatCount(frames.entries),
              size: formatBytes(frames.bytes),
              rate: Math.round(frames.hitRate * 100),
            }),
      age: '',
      error: null,
      state: 'ok',
    });
  if (streetview?.counts)
    rows.push({
      key: 'streetview',
      // i18n-ignore: brand name
      label: 'STREET VIEW',
      counts: t('{places} places · {panos} panos', {
        places: formatCount(streetview.counts.places),
        panos: formatCount(streetview.counts.panos),
      }),
      age: '',
      error:
        streetview.configured === false
          ? errorText({
              message:
                streetview.message || streetview.reason || t('not configured'),
            })
          : null,
      state: streetview.configured === false ? 'off' : 'ok',
    });
  return rows;
}

async function readJson(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Wire the block. Returns {refresh}.
 * @param {HTMLElement} root - The [data-cctv-sources] <details> element.
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 */
export function initSourcesBlock(
  root,
  { signal, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {},
) {
  const quota = root.querySelector('[data-cctv-sources-quota]');
  const list = root.querySelector('[data-cctv-sources-list]');
  let timer = null;

  async function refresh() {
    const [status, streetview] = await Promise.all([
      readJson(fetchImpl, STATUS_URL),
      readJson(fetchImpl, STREETVIEW_STATUS_URL),
    ]);
    if (signal?.aborted) return;
    if (!status) {
      if (quota) quota.textContent = t('Status unavailable');
      list?.replaceChildren();
      return;
    }
    if (quota) quota.textContent = quotaLine(status, streetview) || '';
    const rows = sourceRows(status, streetview, now()).map((row) => {
      const line = document.createElement('div');
      line.className = `cctv-sources-row is-${row.state}`;
      const name = document.createElement('span');
      name.className = 'cctv-sources-name';
      name.textContent = row.label;
      const counts = document.createElement('span');
      counts.className = 'cctv-sources-counts';
      counts.textContent = row.counts + (row.age ? ` · ${row.age}` : '');
      line.append(name, counts);
      if (row.error) {
        const error = document.createElement('div');
        error.className = 'cctv-sources-error';
        error.textContent = row.error;
        line.append(error);
      }
      return line;
    });
    list?.replaceChildren(...rows);
  }

  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  root.addEventListener(
    'toggle',
    () => {
      stop();
      if (!root.open) return;
      refresh();
      timer = setInterval(refresh, SOURCES_REFRESH_MS);
    },
    { signal },
  );
  signal?.addEventListener('abort', stop, { once: true });
  return { refresh };
}
