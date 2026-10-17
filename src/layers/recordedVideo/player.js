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
  // i18n-ignore: personal fork, English-only UI (not yet translated)
  if (quality === 'about') return 'ABOUT';
  return '?';
}

/** What the player's caption says about a record. */
export function captionFor(record) {
  const precision = precisionLabel(record?.coordinatesQuality);
  let where;
  if (record?.source === 'wikidata')
    where = `${record.place || record.title} · Wikidata · ${precision}`;
  else if (record?.source === 'landmark')
    // i18n-ignore: personal fork, English-only UI
    where = `${record.place} · ${precision} · ${String(record.kind || 'other').toUpperCase()}`;
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

/**
 * @param {{document?: Document}} [options]
 * @returns {{open: (record: object) => void, close: () => void,
 *   isOpen: () => boolean,
 *   showMentions: (record: object, mentions: Array<{start: number, at: string, text: string}>) => void}}
 */
export function createVideoPlayer({
  document: doc = globalThis.document,
} = {}) {
  let panel = null;
  let current = null;

  function close() {
    panel?.remove();
    panel = null;
    current = null;
  }

  /** "Mentioned at 3:41" links under the player; each restarts it there. */
  function showMentions(record, mentions) {
    if (!panel || current?.id !== record?.id || !mentions?.length) return;
    panel.querySelector('.recorded-video-player-mentions')?.remove();
    const list = doc.createElement('div');
    list.className = 'recorded-video-player-mentions';
    const head = doc.createElement('span');
    head.className = 'recorded-video-player-mentions-head';
    // i18n-ignore: personal fork, English-only UI
    head.textContent = 'MENTIONED AT';
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

  function open(record) {
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
    doc.body.appendChild(panel);
    current = record;
  }

  return { open, close, showMentions, isOpen: () => Boolean(panel) };
}
