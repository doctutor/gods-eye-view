/**
 * Personal fork: the RECORDED VIDEO block of the CCTV panel — the Recorded
 * Video layer's videos near the view, nearest first, with a search box over
 * title, channel and place, a precision tag and a source tag per row, the
 * counts and the day's remaining search budget, and SEARCH AGAIN for the
 * current view. A row plays its video and flies to its pin, like a pin
 * click. LANDMARKS NEARBY lists the layer's landmarks by distance; a row
 * asks for videos about the place and shows its top LANDMARK_TOP (the rest
 * behind MORE). Shown only while the layer is on. Ranking and marking reuse the
 * camera picker's helpers (cctvCameraList.js).
 */
import {
  distanceKm,
  formatDistance,
  markedHtml,
  matchRanges,
  queryTokens,
} from './cctvCameraList.js';

/** Videos listed with nothing typed: those this close to the view centre. */
export const NEARBY_KM = 100;
export const LIST_LIMIT = 120;
/** Landmarks listed: the nearest this many, within LANDMARK_NEARBY_KM. */
export const LANDMARK_LIMIT = 20;
export const LANDMARK_NEARBY_KM = 25;
/** A landmark's videos shown before MORE. */
export const LANDMARK_TOP = 5;
const PRECISION_TAG = Object.freeze({
  site: 'SITE',
  area: 'AREA',
  region: 'REGION',
  about: 'ABOUT',
});
const SOURCE_TAG = Object.freeze({
  wikidata: 'WIKIDATA',
  'youtube-geotag': 'GEOTAG',
  landmark: 'LANDMARK',
});

/** What a video is searched by: title, channel and place. */
export function videoSearchText(record) {
  return [record?.title, record?.channelTitle, record?.place]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The videos to list, nearest the centre first. With nothing typed, only
 * those within NEARBY_KM; with a query, every match (a Wikidata place far
 * away can be found by name).
 * @returns {Array<{record: object, distanceKm: number, text: string,
 *   ranges: Array<[number, number]>}>}
 */
export function rankVideos(
  records,
  centre,
  query,
  { limit = LIST_LIMIT } = {},
) {
  const tokens = queryTokens(query);
  const entries = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id) continue;
    const text = videoSearchText(record);
    const ranges = tokens.length ? matchRanges(text, tokens) : [];
    if (!ranges) continue;
    const km = centre
      ? distanceKm(centre.lat, centre.lon, record.lat, record.lon)
      : Number.POSITIVE_INFINITY;
    if (!tokens.length && centre && !(km <= NEARBY_KM)) continue;
    entries.push({ record, distanceKm: km, text, ranges });
  }
  entries.sort(
    (a, b) => a.distanceKm - b.distanceKm || a.text.localeCompare(b.text),
  );
  return entries.slice(0, Math.max(1, limit));
}

/** One row: marked title, the details line and the two tags. */
export function videoRowModel(entry) {
  const { record } = entry;
  const titleEnd = String(record.title || '').length;
  // Only the title part of the search text is shown marked.
  const ranges = entry.ranges
    .filter(([start]) => start < titleEnd)
    .map(([start, end]) => [start, Math.min(end, titleEnd)]);
  const day = String(record.recordedAt || record.publishedAt || '').slice(
    0,
    10,
  );
  return {
    id: record.id,
    titleHtml: markedHtml(String(record.title || ''), ranges),
    details: [
      record.channelTitle,
      day,
      record.place,
      formatDistance(entry.distanceKm),
    ]
      .filter(Boolean)
      .join(' · '),
    precision: PRECISION_TAG[record.coordinatesQuality] || 'REGION',
    source: SOURCE_TAG[record.source] || 'GEOTAG',
    // A landmark's video also says what kind it is (news, tour, …).
    kind: record.source === 'landmark' ? String(record.kind || 'other') : '',
  };
}

/**
 * The landmarks to list, nearest the centre first: within LANDMARK_NEARBY_KM
 * with nothing typed, else those whose name matches.
 * @returns {Array<{landmark: object, distanceKm: number,
 *   ranges: Array<[number, number]>}>}
 */
export function rankLandmarks(
  landmarks,
  centre,
  query,
  { limit = LANDMARK_LIMIT } = {},
) {
  const tokens = queryTokens(query);
  const entries = [];
  for (const landmark of Array.isArray(landmarks) ? landmarks : []) {
    if (!landmark?.qid) continue;
    const ranges = tokens.length
      ? matchRanges(String(landmark.label || ''), tokens)
      : [];
    if (!ranges) continue;
    const km = centre
      ? distanceKm(centre.lat, centre.lon, landmark.lat, landmark.lon)
      : Number.POSITIVE_INFINITY;
    if (!tokens.length && centre && !(km <= LANDMARK_NEARBY_KM)) continue;
    entries.push({ landmark, distanceKm: km, ranges });
  }
  entries.sort(
    (a, b) =>
      a.distanceKm - b.distanceKm ||
      String(a.landmark.label).localeCompare(String(b.landmark.label)),
  );
  return entries.slice(0, Math.max(1, limit));
}

/** What a landmark row says about its videos: asked or not, and how many. */
export function landmarkVideoState(landmark) {
  if (landmark?.loading) return 'ASKING…';
  if (landmark?.refused) return 'BUDGET USED';
  if (landmark?.configured === false) return 'NO KEY';
  if (landmark?.error) return 'FAILED';
  const count = landmark?.videoCount;
  if (!Number.isFinite(count)) return 'FIND VIDEOS';
  return `${count} VIDEO${count === 1 ? '' : 'S'}`;
}

/** One landmark row: marked name, kind and distance, and its video state. */
export function landmarkRowModel(entry) {
  const { landmark } = entry;
  return {
    qid: landmark.qid,
    labelHtml: markedHtml(String(landmark.label || ''), entry.ranges),
    details: [
      String(landmark.kind || '').replace(/-/g, ' '),
      formatDistance(entry.distanceKm),
    ]
      .filter(Boolean)
      .join(' · '),
    state: landmarkVideoState(landmark),
    asked: Number.isFinite(landmark.videoCount),
  };
}

/** A landmark's videos split at LANDMARK_TOP, unless MORE was asked for. */
export function landmarkVideoSplit(records, { expanded = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  const shown = expanded ? list : list.slice(0, LANDMARK_TOP);
  return { shown, more: list.length - shown.length };
}

/** "25 videos · 9 site · 16 region" for the listed videos. */
export function countsLine(records) {
  const list = Array.isArray(records) ? records : [];
  const counts = { site: 0, area: 0, region: 0, about: 0 };
  for (const record of list)
    if (record?.coordinatesQuality in counts)
      counts[record.coordinatesQuality]++;
  return [
    `${list.length} video${list.length === 1 ? '' : 's'}`,
    ...['site', 'area', 'region', 'about']
      .filter((key) => counts[key])
      .map((key) => `${counts[key]} ${key}`),
  ].join(' · ');
}

/** "Search budget 798 / 1000 units left today", or '' before any search. */
export function budgetLine(quota) {
  if (!quota || !Number.isFinite(Number(quota.budget))) return '';
  const remaining = Number.isFinite(Number(quota.remaining))
    ? Number(quota.remaining)
    : Math.max(0, Number(quota.budget) - (Number(quota.used) || 0));
  return `Search budget ${remaining} / ${Number(quota.budget)} units left today`;
}

/** What the status line says after the last search, if anything. */
export function searchStatus(lastSearch) {
  if (!lastSearch) return '';
  if (lastSearch.configured === false) return 'No YouTube key: Wikidata only';
  if (lastSearch.refused) return 'Search budget used up for today';
  return lastSearch.cached
    ? 'This view: stored answer'
    : 'This view: just asked';
}

/**
 * Wire the block to the layer. Returns {render}.
 * @param {HTMLElement} root - The [data-recorded-video-panel] element.
 * @param {{layer: object, signal?: AbortSignal}} options
 */
export function initRecordedVideoPanel(root, { layer, signal }) {
  const $ = (name) => root.querySelector(`[data-rv-${name}]`);
  const counts = $('counts');
  const total = $('total');
  const budget = $('budget');
  const status = $('status');
  const search = $('search');
  const again = $('again');
  const list = $('list');
  const landmarkSection = $('landmarks-section');
  const landmarkTotal = $('landmarks-total');
  const landmarkList = $('landmarks');
  let shown = new Map();
  /** Landmarks whose MORE was pressed. */
  const expanded = new Set();

  function videoRow(doc, entry) {
    const row = videoRowModel(entry);
    shown.set(row.id, entry.record);
    const line = doc.createElement('div');
    line.className = 'rv-row';
    line.setAttribute('role', 'listitem');
    line.dataset.videoId = row.id;
    line.tabIndex = 0;
    const title = doc.createElement('span');
    title.className = 'rv-row-title';
    title.innerHTML = row.titleHtml; // escaped by markedHtml
    const tags = doc.createElement('span');
    tags.className = 'rv-row-tags';
    for (const [name, value] of [
      ['precision', row.precision],
      ['source', row.source],
      ['kind', row.kind.toUpperCase()],
    ]) {
      if (!value) continue;
      const tag = doc.createElement('span');
      tag.className = `rv-tag rv-tag-${name} is-${value.toLowerCase()}`;
      tag.textContent = value;
      tags.append(tag);
    }
    const details = doc.createElement('span');
    details.className = 'rv-row-details';
    details.textContent = row.details;
    line.append(title, tags, details);
    return line;
  }

  function renderLandmarks(doc, centre) {
    if (!landmarkList || typeof layer.landmarks !== 'function') {
      if (landmarkSection) landmarkSection.hidden = true;
      return;
    }
    const entries = rankLandmarks(
      layer.landmarks(),
      centre,
      search?.value || '',
    );
    if (landmarkSection) landmarkSection.hidden = entries.length === 0;
    if (landmarkTotal) landmarkTotal.textContent = String(entries.length);
    const selected = layer.selectedLandmark?.();
    const rows = [];
    for (const entry of entries) {
      const row = landmarkRowModel(entry);
      const line = doc.createElement('div');
      line.className = 'rv-landmark';
      line.setAttribute('role', 'listitem');
      line.dataset.qid = row.qid;
      line.tabIndex = 0;
      line.classList.toggle('is-selected', row.qid === selected);
      line.classList.toggle('is-asked', row.asked);
      const name = doc.createElement('span');
      name.className = 'rv-landmark-name';
      name.innerHTML = row.labelHtml; // escaped by markedHtml
      const state = doc.createElement('span');
      state.className = 'rv-landmark-state';
      state.textContent = row.state;
      const details = doc.createElement('span');
      details.className = 'rv-row-details';
      details.textContent = row.details;
      line.append(name, state, details);
      rows.push(line);
      if (row.qid !== selected || !row.asked) continue;
      const split = landmarkVideoSplit(layer.landmarkVideos(row.qid), {
        expanded: expanded.has(row.qid),
      });
      const videos = doc.createElement('div');
      videos.className = 'rv-landmark-videos';
      videos.setAttribute('role', 'list');
      videos.append(
        ...split.shown.map((record) =>
          videoRow(doc, { record, distanceKm: Number.NaN, ranges: [] }),
        ),
      );
      if (split.more) {
        const more = doc.createElement('button');
        more.type = 'button';
        more.className = 'rv-landmark-more';
        more.dataset.moreQid = row.qid;
        // i18n-ignore: personal fork, English-only UI
        more.textContent = `MORE (${split.more})`;
        videos.append(more);
      }
      if (!split.shown.length) {
        const none = doc.createElement('div');
        none.className = 'rv-landmark-none';
        // i18n-ignore: personal fork, English-only UI
        none.textContent = 'No videos found about this place';
        videos.append(none);
      }
      rows.push(videos);
    }
    landmarkList.replaceChildren(...rows);
  }

  function render() {
    const enabled = layer.isEnabled?.() === true;
    root.hidden = !enabled;
    if (!enabled) return;
    const centre = layer.viewCentre();
    const entries = rankVideos(layer.records(), centre, search?.value || '');
    const listed = entries.map((entry) => entry.record);
    if (counts) counts.textContent = countsLine(listed);
    if (total) total.textContent = String(listed.length);
    if (budget) budget.textContent = budgetLine(layer.quota?.());
    if (status) status.textContent = searchStatus(layer.lastSearch?.());
    const doc = root.ownerDocument;
    shown = new Map();
    renderLandmarks(doc, centre);
    if (!list) return;
    list.replaceChildren(...entries.map((entry) => videoRow(doc, entry)));
  }

  const open = (event) => {
    const row = event.target?.closest?.('.rv-row');
    const record = row ? shown.get(row.dataset.videoId) : null;
    if (record) layer.focus(record);
  };
  const openLandmark = (event) => {
    const more = event.target?.closest?.('.rv-landmark-more');
    if (more) {
      expanded.add(more.dataset.moreQid);
      render();
      return;
    }
    if (event.target?.closest?.('.rv-row')) return open(event);
    const row = event.target?.closest?.('.rv-landmark');
    if (row) layer.openLandmark?.(row.dataset.qid);
  };
  for (const [target, handler] of [
    [list, open],
    [landmarkList, openLandmark],
  ]) {
    target?.addEventListener('click', handler, { signal });
    target?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') handler(event);
      },
      { signal },
    );
  }
  search?.addEventListener('input', render, { signal });
  again?.addEventListener(
    'click',
    () => {
      if (!layer.searchAgain() && status)
        // i18n-ignore: personal fork, English-only UI
        status.textContent = 'Zoom in below 50 km to search this view';
    },
    { signal },
  );
  const unsubscribe = layer.subscribe(render);
  signal?.addEventListener('abort', unsubscribe, { once: true });
  render();
  return { render };
}
