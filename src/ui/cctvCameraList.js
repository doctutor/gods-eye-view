/**
 * Personal fork: the camera picker. A search box over a list of cameras
 * ordered by distance from the centre of the view, with the matched letters
 * marked and a tag saying what kind of feed each one is. The hidden native
 * select stays the compatibility seam (QA scripts, the change handler).
 */

/** Cameras listed when nothing is typed, nearest first. */
export const CAMERA_LIST_DEFAULT_LIMIT = 150;
/** Matches listed for a query. */
export const CAMERA_LIST_QUERY_LIMIT = 150;

const toRad = Math.PI / 180;

export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A short word for the kind of feed, from the public camera state. */
export function cameraTag(camera) {
  if (camera?.embed?.provider === 'youtube') return 'YOUTUBE';
  if (camera?.feedType === 'link') return 'LINK';
  if (camera?.sourceKind === 'windy') return 'WINDY';
  if (camera?.feedType === 'hls' || camera?.isVideo) return 'VIDEO';
  return 'CCTV';
}

/** "2.3 km", "850 m", or "" without a centre. */
export function formatDistance(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** The text a camera is searched by: place, name, tag and category. */
export function cameraSearchText(camera) {
  return [camera?.city, camera?.name, cameraTag(camera), camera?.category]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Where each query token occurs in the text, or null when a token is absent.
 * Every token must appear somewhere; tokens are matched case-insensitively.
 * @param {string} text
 * @param {string[]} tokens - Lower-cased.
 * @returns {Array<[number, number]>|null} [start, end) ranges, merged.
 */
export function matchRanges(text, tokens) {
  const lower = String(text).toLowerCase();
  const ranges = [];
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at < 0) return null;
    ranges.push([at, at + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** Query tokens: whitespace-separated, lower-cased, empty when blank. */
export function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The cameras to list for a query, nearest the centre first.
 * @param {Array<object>} cameras - Public camera states (uiState().cameras).
 * @param {{lat:number, lon:number}|null} center - View centre, or null.
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<{camera: object, distanceKm: number, text: string,
 *   ranges: Array<[number, number]>}>}
 */
export function rankCameras(cameras, center, query, options = {}) {
  const tokens = queryTokens(query);
  const limit =
    options.limit ??
    (tokens.length ? CAMERA_LIST_QUERY_LIMIT : CAMERA_LIST_DEFAULT_LIMIT);
  const entries = [];
  for (const camera of Array.isArray(cameras) ? cameras : []) {
    if (!camera?.id) continue;
    const text = cameraSearchText(camera);
    const ranges = tokens.length ? matchRanges(text, tokens) : [];
    if (!ranges) continue;
    const km =
      center && Number.isFinite(camera.lat) && Number.isFinite(camera.lon)
        ? distanceKm(center.lat, center.lon, camera.lat, camera.lon)
        : Number.POSITIVE_INFINITY;
    entries.push({ camera, distanceKm: km, text, ranges });
  }
  entries.sort(
    (a, b) => a.distanceKm - b.distanceKm || a.text.localeCompare(b.text),
  );
  return entries.slice(0, Math.max(1, limit));
}

/**
 * The camera ids in nearest-first order, for PREV/NEXT. A camera without a
 * position, or with no centre to measure from, keeps catalog order after
 * the measured ones.
 * @param {Array<{lat:number, lon:number, id:string}>} cameras
 * @param {{lat:number, lon:number}|null} center
 * @returns {string[]}
 */
export function nearestFirstIds(cameras, center) {
  const list = Array.isArray(cameras) ? cameras : [];
  if (!center) return list.map((camera) => camera.id);
  return list
    .map((camera, index) => ({
      id: camera.id,
      index,
      km:
        Number.isFinite(camera.lat) && Number.isFinite(camera.lon)
          ? distanceKm(center.lat, center.lon, camera.lat, camera.lon)
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.km - b.km || a.index - b.index)
    .map((entry) => entry.id);
}

/** Text with the matched ranges wrapped in <mark>, everything else escaped. */
export function markedHtml(text, ranges) {
  const escape = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  let out = '';
  let at = 0;
  for (const [start, end] of ranges || []) {
    out += escape(text.slice(at, start));
    out += `<mark>${escape(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escape(text.slice(at));
}

/**
 * Render the list into its element. Rows carry data-camera-id; the active
 * camera and the keyboard-highlighted row get classes.
 * @param {HTMLElement} host
 * @param {Array} entries - From rankCameras.
 * @param {{activeId?: string|null, highlightId?: string|null, total?: number,
 *   query?: string}} state
 */
export function renderCameraList(host, entries, state = {}) {
  if (!host) return;
  const doc = host.ownerDocument;
  host.replaceChildren();
  for (const entry of entries) {
    const row = doc.createElement('div');
    row.className = 'cctv-camera-row';
    row.setAttribute('role', 'option');
    row.dataset.cameraId = entry.camera.id;
    row.setAttribute(
      'aria-selected',
      entry.camera.id === state.activeId ? 'true' : 'false',
    );
    if (entry.camera.id === state.activeId) row.classList.add('active');
    if (entry.camera.id === state.highlightId) row.classList.add('highlight');
    const text = doc.createElement('span');
    text.className = 'cctv-camera-row-text';
    text.innerHTML = markedHtml(entry.text, entry.ranges);
    const meta = doc.createElement('span');
    meta.className = 'cctv-camera-row-meta';
    meta.textContent = formatDistance(entry.distanceKm);
    row.append(text, meta);
    host.appendChild(row);
  }
  if (!entries.length) {
    const empty = doc.createElement('div');
    empty.className = 'cctv-camera-row empty';
    empty.textContent = state.query ? 'No camera matches' : 'No cameras loaded';
    host.appendChild(empty);
  }
  const shown = entries.length;
  const total = Number(state.total) || 0;
  host.dataset.summary =
    total > shown ? `${shown} of ${total} · nearest first` : `${shown}`;
}

/**
 * The row to highlight after an arrow key, wrapping at the ends.
 * @param {string[]} ids - Listed camera ids, in order.
 * @param {string|null} currentId
 * @param {number} step - +1 or -1.
 */
export function stepHighlight(ids, currentId, step) {
  if (!ids.length) return null;
  const at = ids.indexOf(currentId);
  if (at < 0) return step < 0 ? ids[ids.length - 1] : ids[0];
  return ids[(at + step + ids.length) % ids.length];
}
