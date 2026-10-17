/**
 * Personal fork: the PENDING CAMS block of the CCTV panel. Streams the
 * featured-cam watcher found (server cctv/featuredChannels.js) wait here
 * until a person accepts a position, adjusts it, or skips the stream; the
 * routes are server cctv/featuredQueue.js. Everything shown comes from the
 * server as data and is written with textContent.
 */

const PRECISION_LABEL = Object.freeze({
  site: 'SITE',
  area: 'AREA',
  region: 'REGION',
  'operator-geotag': 'GEOTAG',
});
const SUGGESTION_SOURCE = Object.freeze({
  geotag: 'operator geotag',
  text: 'from the title/description',
  default: 'channel default',
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
    title: String(item?.title || 'Untitled stream'),
    channel: String(item?.channelTitle || item?.operator || 'YouTube'),
    status: String(item?.status || '').toUpperCase(),
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
      ? `${suggestion.label || 'Suggested'} · ${PRECISION_LABEL[suggestion.coordinatesQuality] || '?'}`
      : 'No position suggested — adjust to place it',
    sourceText: placed ? SUGGESTION_SOURCE[suggestion.kind] || '' : '',
  };
}

/**
 * What the Adjust box holds: "lat, lon" or a place name.
 * @returns {{kind: 'coords', lat: number, lon: number}|{kind: 'place', query: string}|{error: string}}
 */
export function parseAdjustInput(text) {
  const value = String(text || '').trim();
  if (!value) return { error: 'Type a place or “lat, lon”' };
  const coords = /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(
    value,
  );
  if (coords) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
      return { error: 'Those coordinates are out of range' };
    return { kind: 'coords', lat, lon };
  }
  if (value.length < 2 || value.length > 200)
    return { error: 'Type a place or “lat, lon”' };
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
      // i18n-ignore: personal fork, English-only UI
      showToast(`Not saved: ${error.message}`);
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
        ? `${position.label || 'Chosen position'} · ${PRECISION_LABEL[position.coordinatesQuality] || '?'}`
        : model.placeText;
      place.title = position
        ? `${position.lat.toFixed(4)}, ${position.lon.toFixed(4)}${model.sourceText ? ` (${model.sourceText})` : ''}`
        : '';
      accept.disabled = !position;
    };
    const actions = el('div', 'cctv-controls cctv-pending-actions');
    const accept = el('button', 'scene-btn', 'ACCEPT');
    const adjust = el('button', 'scene-btn', 'ADJUST');
    const skip = el('button', 'scene-btn', 'SKIP');
    actions.append(accept, adjust, skip);

    const editor = el('div', 'cctv-pending-editor');
    editor.hidden = true;
    const input = el('input', 'cctv-pending-input');
    input.type = 'text';
    // i18n-ignore: personal fork, English-only UI
    input.placeholder = 'Place, or lat, lon';
    // i18n-ignore: personal fork, English-only UI
    input.setAttribute('aria-label', 'Position for this stream');
    const precision = el('select', 'cctv-pending-precision');
    // i18n-ignore: personal fork, English-only UI
    precision.setAttribute('aria-label', 'How precise the position is');
    for (const quality of qualities) {
      const option = el('option', '', PRECISION_LABEL[quality] || quality);
      option.value = quality;
      precision.append(option);
    }
    const find = el('button', 'scene-btn', 'SET');
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
          // i18n-ignore: personal fork, English-only UI
          return showToast(`Not found: ${error.message}`);
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
            'Accepted — on the map the next time the camera layer loads',
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
      () => act('skip', { videoId: model.videoId }, 'Skipped'),
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
