import { youtubeEmbedUrl } from '../../ui/cctvEmbed.js';
import { t } from '../../i18n/index.js';

/**
 * Personal fork: a small floating player for one recorded video — YouTube's
 * own privacy-enhanced embedded player (the CCTV panel's youtubeEmbedUrl),
 * the place and how precise its pin is, and a link out. One at a time;
 * closing it removes the player, so nothing plays unseen.
 */

/** A video's pin precision as the map and the player say it. */
export function precisionLabel(quality) {
  if (quality === 'site') return t('SITE', { context: 'pin precision' });
  if (quality === 'area') return t('AREA', { context: 'pin precision' });
  if (quality === 'region') return t('REGION', { context: 'pin precision' });
  if (quality === 'about') return t('ABOUT', { context: 'pin precision' });
  return '?';
}

/** A landmark video's kind (news, tour, …) as the caption says it. */
export function kindLabel(kind) {
  switch (kind) {
    case 'news':
      return t('NEWS', { context: 'video kind' });
    case 'tour':
      return t('TOUR', { context: 'video kind' });
    case 'event':
      return t('EVENT', { context: 'video kind' });
    case 'vlog':
      return t('VLOG', { context: 'video kind' });
    case 'music':
      return t('MUSIC', { context: 'video kind' });
    case 'other':
      return t('OTHER', { context: 'video kind' });
    default:
      return String(kind || '').toUpperCase();
  }
}

/** What the player's caption says about a record. */
export function captionFor(record) {
  const precision = precisionLabel(record?.coordinatesQuality);
  let where;
  if (record?.source === 'wikidata')
    where = `${record.place || record.title} · Wikidata · ${precision}`;
  else if (record?.source === 'landmark')
    where = `${record.place} · ${precision} · ${kindLabel(String(record.kind || 'other'))}`;
  else {
    const place = record?.place || t('YouTube geotag');
    where = record?.sharedBy
      ? t('{place} · geotag · {precision} (shared by {count})', {
          place,
          precision,
          count: record.sharedBy,
        })
      : t('{place} · geotag · {precision}', { place, precision });
  }
  const when = String(record?.recordedAt || record?.publishedAt || '').slice(
    0,
    10,
  );
  return [where, record?.channelTitle, when].filter(Boolean).join(' · ');
}

/** The embed URL for a record, starting at `start` seconds when given. */
export function embedAt(videoId, start = 0) {
  const src = youtubeEmbedUrl(videoId);
  if (!src || !(start > 0)) return src;
  const url = new URL(src);
  url.searchParams.set('start', String(Math.floor(start)));
  return url.href;
}

/** A playlist row's second line: kind and channel. */
export function playlistDetails(record) {
  return [
    record?.source === 'landmark'
      ? kindLabel(String(record.kind || 'other'))
      : '',
    record?.channelTitle,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How long a notice stays in the player's place (ms). */
export const NOTICE_MS = 5000;

/**
 * @param {{document?: Document, setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout}} [options]
 * @returns {{open: (record: object, options?: {playlist?: object[],
 *   onSelect?: (record: object) => void}) => void, close: () => void,
 *   isOpen: () => boolean, notice: (text: string) => void,
 *   showMentions: (record: object, mentions: Array<{start: number, at: string, text: string}>) => void}}
 */
export function createVideoPlayer({
  document: doc = globalThis.document,
  setTimeoutImpl = (...a) => setTimeout(...a),
  clearTimeoutImpl = (...a) => clearTimeout(...a),
} = {}) {
  let panel = null;
  let current = null;
  let noticeBox = null;
  let noticeTimer = null;

  function clearNotice() {
    if (noticeTimer) clearTimeoutImpl(noticeTimer);
    noticeTimer = null;
    noticeBox?.remove();
    noticeBox = null;
  }

  function close() {
    clearNotice();
    panel?.remove();
    panel = null;
    current = null;
  }

  /**
   * A short message where the player shows (a landmark with no usable
   * videos, a refused search): inside an open player, else a small box in
   * its place; gone after NOTICE_MS.
   */
  function notice(text) {
    if (!doc || !text) return;
    clearNotice();
    noticeBox = doc.createElement('div');
    noticeBox.className = 'recorded-video-player-notice';
    noticeBox.setAttribute('role', 'status');
    noticeBox.textContent = text;
    if (panel)
      panel.querySelector('.recorded-video-player-header')?.after(noticeBox);
    else {
      noticeBox.classList.add('is-alone');
      doc.body.appendChild(noticeBox);
    }
    noticeTimer = setTimeoutImpl(clearNotice, NOTICE_MS);
  }

  /** The other videos of a landmark, to switch between (and ‹ ›). */
  function playlistOf(record, playlist, onSelect) {
    const index = playlist.findIndex((item) => item.id === record.id);
    const nav = doc.createElement('div');
    nav.className = 'recorded-video-player-nav';
    const step = (delta, label, glyph) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'recorded-video-player-step';
      button.textContent = glyph;
      button.setAttribute('aria-label', label);
      button.title = label;
      const target = playlist[index + delta];
      button.disabled = !target;
      button.addEventListener('click', () => target && onSelect(target));
      return button;
    };
    const position = doc.createElement('span');
    position.className = 'recorded-video-player-position';
    position.textContent = t('{n} of {count}', {
      n: index + 1,
      count: playlist.length,
    });
    nav.append(
      step(-1, t('Previous video'), '‹'),
      position,
      step(1, t('Next video'), '›'),
    );
    const list = doc.createElement('div');
    list.className = 'recorded-video-player-list';
    list.setAttribute('role', 'list');
    for (const item of playlist) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'recorded-video-player-item';
      row.setAttribute('role', 'listitem');
      if (item.id === record.id) row.setAttribute('aria-current', 'true');
      const name = doc.createElement('span');
      name.className = 'recorded-video-player-item-title';
      name.textContent = item.title;
      const details = doc.createElement('span');
      details.className = 'recorded-video-player-item-details';
      details.textContent = playlistDetails(item);
      row.append(name, details);
      row.addEventListener('click', () => {
        if (item.id !== current?.id) onSelect(item);
      });
      list.append(row);
    }
    return [nav, list];
  }

  /** "Mentioned at 3:41" links under the player; each restarts it there. */
  function showMentions(record, mentions) {
    if (!panel || current?.id !== record?.id || !mentions?.length) return;
    panel.querySelector('.recorded-video-player-mentions')?.remove();
    const list = doc.createElement('div');
    list.className = 'recorded-video-player-mentions';
    const head = doc.createElement('span');
    head.className = 'recorded-video-player-mentions-head';
    head.textContent = t('MENTIONED AT');
    list.append(head);
    for (const mention of mentions) {
      const jump = doc.createElement('button');
      jump.type = 'button';
      jump.className = 'recorded-video-player-mention';
      jump.textContent = mention.at;
      jump.title = mention.text;
      jump.addEventListener('click', () => {
        const frame = panel?.querySelector('.recorded-video-player-frame');
        if (frame) frame.src = embedAt(record.videoId, mention.start);
      });
      list.append(jump);
    }
    panel.querySelector('.recorded-video-player-caption')?.after(list);
  }

  function open(record, { playlist = null, onSelect = null } = {}) {
    const src = youtubeEmbedUrl(record?.videoId);
    if (!src || !doc) return;
    close();
    panel = doc.createElement('div');
    panel.className = 'recorded-video-player';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute(
      'aria-label',
      t('Recorded video: {title}', { title: record.title }),
    );
    const header = doc.createElement('div');
    header.className = 'recorded-video-player-header';
    const title = doc.createElement('span');
    title.className = 'recorded-video-player-title';
    title.textContent = record.title;
    const shut = doc.createElement('button');
    shut.type = 'button';
    shut.className = 'recorded-video-player-close';
    shut.textContent = '×';
    shut.setAttribute('aria-label', t('Close the video'));
    shut.addEventListener('click', close);
    header.append(title, shut);
    const frame = doc.createElement('iframe');
    frame.className = 'recorded-video-player-frame';
    frame.src = src;
    frame.title = t('{name} on YouTube', { name: record.title });
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    const caption = doc.createElement('div');
    caption.className = 'recorded-video-player-caption';
    caption.textContent = captionFor(record);
    const link = doc.createElement('a');
    link.className = 'recorded-video-player-link';
    link.href = `https://www.youtube.com/watch?v=${record.videoId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('WATCH ON {site} ↗', { site: 'YOUTUBE' });
    panel.append(header, frame, caption, link);
    if (playlist?.length > 1 && onSelect)
      panel.append(...playlistOf(record, playlist, onSelect));
    doc.body.appendChild(panel);
    current = record;
  }

  return {
    open,
    close,
    notice,
    showMentions,
    isOpen: () => Boolean(panel),
    current: () => current,
  };
}
