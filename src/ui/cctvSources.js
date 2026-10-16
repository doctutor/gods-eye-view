/**
 * Personal fork: the SOURCES block of the CCTV panel — what the camera index
 * holds and what it costs. Reads /api/cctv/status (server cctv/status.js) and
 * the Street View indoor status route when that is mounted; fetched when the
 * block opens and every 60 s while it stays open. Everything is written with
 * textContent.
 */

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
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** The quota line: YouTube units, Windy requests, Street View probes (exact). */
export function quotaLine(status, streetview) {
  const exact = (value) =>
    Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : '–';
  const parts = [];
  const youtube = status?.featured?.youtube;
  if (youtube)
    parts.push(
      `YouTube ${exact(youtube.units)} / ${exact(youtube.budget)} units today`,
    );
  const windy = (status?.dynamic || []).find((d) => d.name === 'windy');
  if (windy?.enabled && windy.configured !== false)
    parts.push(
      `Windy ${exact(windy.requestsLastMinute ?? 0)}${windy.budgetPerMinute ? ` / ${exact(windy.budgetPerMinute)}` : ''} req/min`,
    );
  if (streetview && Number.isFinite(Number(streetview.dailyCap)))
    parts.push(
      `Street View ${exact(streetview.usedToday)} / ${exact(streetview.dailyCap)}`,
    );
  return parts.join(' · ');
}

const errorText = (error) =>
  error ? `${String(error.message || 'error').slice(0, 120)}` : null;

/**
 * One row per source: {key, label, counts, age, error, state}.
 * state: 'ok', 'error' (last attempt failed) or 'off'.
 */
export function sourceRows(status, streetview, now = Date.now()) {
  const rows = [];
  for (const pack of status?.packs || []) {
    const counts = pack.skipped
      ? `off: ${String(pack.skipped).slice(0, 60)}`
      : [
          `${formatCount(pack.inIndex)} indexed`,
          pack.proximityOnly
            ? null
            : `${formatCount(pack.servedCapped)} on map`,
          pack.dedupedAway ? `${formatCount(pack.dedupedAway)} folded` : null,
        ]
          .filter(Boolean)
          .join(' · ');
    rows.push({
      key: `pack:${pack.name}`,
      label: label(pack.name),
      counts,
      age: pack.skipped ? '' : ageText(pack.lastRefreshAt, now),
      error: errorText(pack.lastError),
      state:
        !pack.enabled || pack.skipped ? 'off' : pack.lastError ? 'error' : 'ok',
    });
  }
  for (const source of status?.dynamic || []) {
    rows.push({
      key: `dynamic:${source.name}`,
      label: label(source.name),
      counts:
        source.configured === false
          ? 'no key'
          : `${formatCount(source.cacheEntries)} areas cached · ${formatCount(source.knownCameras)} cams`,
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
      label: 'OPENCCTV FILE',
      counts: [
        camindex.catalog
          ? `${formatCount(camindex.catalog.cameras)} cams`
          : null,
        verified
          ? `checked ${formatCount(verified.live)} live / ${formatCount(verified.dead)} dead${verified.unknown ? ` / ${formatCount(verified.unknown)} ?` : ''}`
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
      label: 'YOUTUBE',
      counts: `${formatCount(featured.listed)} listed · ${formatCount(featured.liveNow)} live · ${formatCount(featured.pending)} pending`,
      age: '',
      error: null,
      state: 'ok',
    });
  const audio = status?.audio;
  if (audio)
    rows.push({
      key: 'audio',
      label: 'AUDIO',
      counts: `${formatCount(audio.audio)} sound · ${formatCount(audio.silent)} silent · ${formatCount(audio.likely)} likely · ${formatCount(audio.unknown)} ?`,
      age: '',
      error: null,
      state: 'ok',
    });
  const frames = status?.frameCache;
  if (frames)
    rows.push({
      key: 'frames',
      label: 'FRAME CACHE',
      counts: `${formatCount(frames.entries)} frames · ${formatBytes(frames.bytes)}${frames.hitRate === null || frames.hitRate === undefined ? '' : ` · ${Math.round(frames.hitRate * 100)}% hits`}`,
      age: '',
      error: null,
      state: 'ok',
    });
  if (streetview?.counts)
    rows.push({
      key: 'streetview',
      label: 'STREET VIEW',
      counts: `${formatCount(streetview.counts.places)} places · ${formatCount(streetview.counts.panos)} panos`,
      age: '',
      error:
        streetview.configured === false
          ? errorText({
              message:
                streetview.message || streetview.reason || 'not configured',
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
      if (quota) quota.textContent = 'Status unavailable';
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
