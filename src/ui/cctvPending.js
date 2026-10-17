/**
 * Personal fork: the PENDING CAMS block of the CCTV panel. Streams the
 * featured-cam watcher found (server cctv/featuredChannels.js) wait here
 * until a person accepts a position, adjusts it, or skips the stream; the
 * routes are server cctv/featuredQueue.js. Everything shown comes from the
 * server as data and is written with textContent.
 */

import { msg, t } from '../i18n/index.js';

/** How precise a position is, as the card and the picker say it. */
function precisionLabel(quality) {
  switch (quality) {
    case 'site':
      return t('SITE', { context: 'pin precision' });
    case 'area':
      return t('AREA', { context: 'pin precision' });
    case 'region':
      return t('REGION', { context: 'pin precision' });
    case 'operator-geotag':
      return t('GEOTAG', { context: 'pin precision' });
    default:
      return '?';
  }
}
const SUGGESTION_SOURCE = Object.freeze({
  geotag: msg('operator geotag'),
  text: msg('from the title/description'),
  default: msg('channel default'),
});
/** A stream's YouTube state as the card says it. */
const STREAM_STATUS = Object.freeze({
  live: msg('LIVE'),
  upcoming: msg('UPCOMING'),
});
const ENDPOINT = '/api/cctv/featured';

/** What one queued stream's card says. */
export function pendingCardModel(item) {
  const suggestion = item?.suggestion || { kind: 'none' };
  const placed =
    suggestion.kind !== 'none' &&
    Number.isFinite(Number(suggestion.lat)) &&
    Number.isFinite(Number(suggestion.lon));
  return {
    videoId: String(item?.videoId || ''),
    title: String(item?.title || t('Untitled stream')),
    channel: String(item?.channelTitle || item?.operator || 'YouTube'),
    status: STREAM_STATUS[String(item?.status || '').toLowerCase()]
      ? t(STREAM_STATUS[String(item.status).toLowerCase()])
      : String(item?.status || '').toUpperCase(),
    thumbnailUrl: String(item?.thumbnailUrl || ''),
    watchUrl: String(item?.watchUrl || ''),
    position: placed
      ? {
          lat: Number(suggestion.lat),
          lon: Number(suggestion.lon),
          coordinatesQuality: suggestion.coordinatesQuality,
          label: String(suggestion.label || ''),
        }
      : null,
    placeText: placed
      ? `${suggestion.label || t('Suggested')} · ${precisionLabel(suggestion.coordinatesQuality)}`
      : t('No position suggested — adjust to place it'),
    sourceText:
      placed && SUGGESTION_SOURCE[suggestion.kind]
        ? t(SUGGESTION_SOURCE[suggestion.kind])
        : '',
  };
}

/**
 * What the Adjust box holds: "lat, lon" or a place name.
 * @returns {{kind: 'coords', lat: number, lon: number}|{kind: 'place', query: string}|{error: string}}
 */
export function parseAdjustInput(text) {
  const value = String(text || '').trim();
  if (!value) return { error: t('Type a place or “lat, lon”') };
  const coords = /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(
    value,
  );
  if (coords) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
      return { error: t('Those coordinates are out of range') };
    return { kind: 'coords', lat, lon };
  }
  if (value.length < 2 || value.length > 200)
    return { error: t('Type a place or “lat, lon”') };
  return { kind: 'place', query: value };
}

/** The accept request for a stream at a position. */
export function acceptPayload(videoId, position) {
  return {
    videoId,
    lat: position.lat,
    lon: position.lon,
    coordinatesQuality: position.coordinatesQuality,
    place: position.label,
  };
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, {
    credentials: 'same-origin',
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Wire the block. Returns {refresh}.
 * @param {HTMLElement} root - The [data-cctv-pending] element.
 * @param {{signal?: AbortSignal, showToast?: (message: string) => void,
 *   fetchImpl?: typeof fetch}} [options]
 */
export function initPendingCams(
  root,
  { signal, showToast = () => {}, fetchImpl = (...a) => fetch(...a) } = {},
) {
  const count = root.querySelector('[data-cctv-pending-count]');
  const list = root.querySelector('[data-cctv-pending-list]');
  /** videoId → the position the card will accept (suggested or adjusted). */
  const chosen = new Map();
  let qualities = ['site', 'area', 'region', 'operator-geotag'];

  async function act(route, payload, done) {
    try {
      await requestJson(fetchImpl, `${ENDPOINT}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast(done);
      chosen.delete(payload.videoId);
      await refresh();
    } catch (error) {
      showToast(t('Not saved: {reason}', { reason: error.message }));
    }
  }

  function card(item) {
    const model = pendingCardModel(item);
    if (!chosen.has(model.videoId) && model.position)
      chosen.set(model.videoId, model.position);
    const row = el('div', 'cctv-pending-card');
    const thumb = el('img', 'cctv-pending-thumb');
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    if (model.thumbnailUrl) thumb.src = model.thumbnailUrl;
    const body = el('div', 'cctv-pending-body');
    const title = el('a', 'cctv-pending-title', model.title);
    if (model.watchUrl) {
      title.href = model.watchUrl;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    const meta = el(
      'div',
      'cctv-pending-meta',
      [model.channel, model.status].filter(Boolean).join(' · '),
    );
    const place = el('div', 'cctv-pending-place');
    const showPlace = () => {
      const position = chosen.get(model.videoId);
      place.textContent = position
        ? `${position.label || t('Chosen position')} · ${precisionLabel(position.coordinatesQuality)}`
        : model.placeText;
      place.title = position
        ? `${position.lat.toFixed(4)}, ${position.lon.toFixed(4)}${model.sourceText ? ` (${model.sourceText})` : ''}`
        : '';
      accept.disabled = !position;
    };
    const actions = el('div', 'cctv-controls cctv-pending-actions');
    const accept = el('button', 'scene-btn', t('ACCEPT'));
    const adjust = el('button', 'scene-btn', t('ADJUST'));
    const skip = el('button', 'scene-btn', t('SKIP'));
    actions.append(accept, adjust, skip);

    const editor = el('div', 'cctv-pending-editor');
    editor.hidden = true;
    const input = el('input', 'cctv-pending-input');
    input.type = 'text';
    input.placeholder = t('Place, or lat, lon');
    input.setAttribute('aria-label', t('Position for this stream'));
    const precision = el('select', 'cctv-pending-precision');
    precision.setAttribute('aria-label', t('How precise the position is'));
    for (const quality of qualities) {
      const option = el('option', '', precisionLabel(quality));
      option.value = quality;
      precision.append(option);
    }
    const find = el('button', 'scene-btn', t('SET'));
    editor.append(input, precision, find);

    const setFromEditor = async () => {
      const parsed = parseAdjustInput(input.value);
      if (parsed.error) return showToast(parsed.error);
      if (parsed.kind === 'coords') {
        const quality =
          precision.value === 'operator-geotag' ? 'site' : precision.value;
        chosen.set(model.videoId, {
          lat: parsed.lat,
          lon: parsed.lon,
          coordinatesQuality: quality,
          label:
            chosen.get(model.videoId)?.label ||
            `${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)}`,
        });
      } else {
        try {
          const found = await requestJson(
            fetchImpl,
            `${ENDPOINT}/locate?q=${encodeURIComponent(parsed.query)}`,
          );
          chosen.set(model.videoId, {
            lat: found.lat,
            lon: found.lon,
            coordinatesQuality: found.coordinatesQuality,
            label: found.label,
          });
          precision.value = found.coordinatesQuality;
        } catch (error) {
          return showToast(t('Not found: {reason}', { reason: error.message }));
        }
      }
      showPlace();
    };

    accept.addEventListener(
      'click',
      () => {
        const position = chosen.get(model.videoId);
        if (position)
          act(
            'accept',
            acceptPayload(model.videoId, position),
            t('Accepted — on the map the next time the camera layer loads'),
          );
      },
      { signal },
    );
    adjust.addEventListener(
      'click',
      () => {
        editor.hidden = !editor.hidden;
        const position = chosen.get(model.videoId);
        if (position) precision.value = position.coordinatesQuality;
        if (!editor.hidden) input.focus();
      },
      { signal },
    );
    skip.addEventListener(
      'click',
      () => act('skip', { videoId: model.videoId }, t('Skipped')),
      { signal },
    );
    find.addEventListener('click', setFromEditor, { signal });
    input.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') setFromEditor();
      },
      { signal },
    );
    precision.addEventListener(
      'change',
      () => {
        const position = chosen.get(model.videoId);
        if (position && precision.value !== 'operator-geotag') {
          position.coordinatesQuality = precision.value;
          showPlace();
        }
      },
      { signal },
    );

    body.append(title, meta, place, actions, editor);
    row.append(thumb, body);
    showPlace();
    return row;
  }

  async function refresh() {
    let items = [];
    try {
      const body = await requestJson(fetchImpl, `${ENDPOINT}/pending`);
      items = Array.isArray(body.items) ? body.items : [];
      if (Array.isArray(body.coordinateQualities))
        qualities = body.coordinateQualities;
    } catch {
      items = [];
    }
    if (count) count.textContent = String(items.length);
    root.hidden = items.length === 0;
    if (list) list.replaceChildren(...items.map(card));
  }

  root.addEventListener(
    'toggle',
    () => {
      if (root.open) refresh();
    },
    { signal },
  );
  refresh();
  return { refresh };
}
