/**
 * Personal fork: the RECORDED VIDEO block of the CCTV panel — the Recorded
 * Video layer's videos near the view, nearest first, with a search box over
 * title, channel and place, a precision tag and a source tag per row, the
 * counts and the day's remaining search budget, and SEARCH AGAIN for the
 * current view. A row plays its video and flies to its pin, like a pin
 * click. Shown only while the layer is on. Ranking and marking reuse the
 * camera picker's helpers (cctvCameraList.js).
 */
import {
  distanceKm,
  formatDistance,
  markedHtml,
  matchRanges,
  queryTokens,
} from './cctvCameraList.js';
import { t, tn } from '../i18n/index.js';

/** Videos listed with nothing typed: those this close to the view centre. */
export const NEARBY_KM = 100;
export const LIST_LIMIT = 120;
/** A video's pin precision as its row tag says it. */
function precisionTag(quality) {
  if (quality === 'site') return t('SITE', { context: 'pin precision' });
  if (quality === 'area') return t('AREA', { context: 'pin precision' });
  return t('REGION', { context: 'pin precision' });
}
/** Where a video's position came from, as its row tag says it. */
function sourceTag(source) {
  // i18n-ignore: brand name
  if (source === 'wikidata') return 'WIKIDATA';
  return t('GEOTAG', { context: 'pin precision' });
}

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
    precision: precisionTag(record.coordinatesQuality),
    source: sourceTag(record.source),
  };
}

/** "25 videos · 9 site · 16 region" for the listed videos. */
export function countsLine(records) {
  const list = Array.isArray(records) ? records : [];
  const counts = { site: 0, area: 0, region: 0 };
  for (const record of list)
    if (record?.coordinatesQuality in counts)
      counts[record.coordinatesQuality]++;
  const parts = [tn(list.length, '{count} video', '{count} videos')];
  if (counts.site) parts.push(t('{count} site', { count: counts.site }));
  if (counts.area) parts.push(t('{count} area', { count: counts.area }));
  if (counts.region) parts.push(t('{count} region', { count: counts.region }));
  return parts.join(' · ');
}

/** "Search budget 798 / 1000 units left today", or '' before any search. */
export function budgetLine(quota) {
  if (!quota || !Number.isFinite(Number(quota.budget))) return '';
  const remaining = Number.isFinite(Number(quota.remaining))
    ? Number(quota.remaining)
    : Math.max(0, Number(quota.budget) - (Number(quota.used) || 0));
  return t('Search budget {remaining} / {budget} units left today', {
    remaining,
    budget: Number(quota.budget),
  });
}

/** What the status line says after the last search, if anything. */
export function searchStatus(lastSearch) {
  if (!lastSearch) return '';
  if (lastSearch.configured === false)
    return t('No YouTube key: Wikidata only');
  if (lastSearch.refused) return t('Search budget used up for today');
  return lastSearch.cached
    ? t('This view: stored answer')
    : t('This view: just asked');
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
  let shown = new Map();

  function render() {
    const enabled = layer.isEnabled?.() === true;
    root.hidden = !enabled;
    if (!enabled) return;
    const entries = rankVideos(
      layer.records(),
      layer.viewCentre(),
      search?.value || '',
    );
    const listed = entries.map((entry) => entry.record);
    if (counts) counts.textContent = countsLine(listed);
    if (total) total.textContent = String(listed.length);
    if (budget) budget.textContent = budgetLine(layer.quota?.());
    if (status) status.textContent = searchStatus(layer.lastSearch?.());
    if (!list) return;
    const doc = root.ownerDocument;
    shown = new Map();
    list.replaceChildren(
      ...entries.map((entry) => {
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
        ]) {
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
      }),
    );
  }

  const open = (event) => {
    const row = event.target?.closest?.('.rv-row');
    const record = row ? shown.get(row.dataset.videoId) : null;
    if (record) layer.focus(record);
  };
  list?.addEventListener('click', open, { signal });
  list?.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') open(event);
    },
    { signal },
  );
  search?.addEventListener('input', render, { signal });
  again?.addEventListener(
    'click',
    () => {
      if (!layer.searchAgain() && status)
        status.textContent = t('Zoom in below 50 km to search this view');
    },
    { signal },
  );
  const unsubscribe = layer.subscribe(render);
  signal?.addEventListener('abort', unsubscribe, { once: true });
  render();
  return { render };
}
