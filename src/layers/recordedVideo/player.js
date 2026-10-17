import { youtubeEmbedUrl } from '../../ui/cctvEmbed.js';
import { PRECISION_STYLE } from './source.js';

/**
 * Personal fork: a small floating player for one recorded video — YouTube's
 * own privacy-enhanced embedded player (the CCTV panel's youtubeEmbedUrl),
 * the place and how precise its pin is, and a link out. One at a time;
 * closing it removes the player, so nothing plays unseen.
 */

/** What the player's caption says about a record. */
export function captionFor(record) {
  const precision = PRECISION_STYLE[record?.coordinatesQuality]?.label || '?';
  const where =
    record?.source === 'wikidata'
      ? `${record.place || record.title} · Wikidata · ${precision}`
      : `${record?.place || 'YouTube geotag'} · geotag · ${precision}${record?.sharedBy ? ` (shared by ${record.sharedBy})` : ''}`;
  const when = String(record?.recordedAt || record?.publishedAt || '').slice(
    0,
    10,
  );
  return [where, record?.channelTitle, when].filter(Boolean).join(' · ');
}

/**
 * @param {{document?: Document}} [options]
 * @returns {{open: (record: object) => void, close: () => void,
 *   isOpen: () => boolean}}
 */
export function createVideoPlayer({
  document: doc = globalThis.document,
} = {}) {
  let panel = null;

  function close() {
    panel?.remove();
    panel = null;
  }

  function open(record) {
    const src = youtubeEmbedUrl(record?.videoId);
    if (!src || !doc) return;
    close();
    panel = doc.createElement('div');
    panel.className = 'recorded-video-player';
    panel.setAttribute('role', 'dialog');
    // i18n-ignore: personal fork, English-only UI
    panel.setAttribute('aria-label', `Recorded video: ${record.title}`);
    const header = doc.createElement('div');
    header.className = 'recorded-video-player-header';
    const title = doc.createElement('span');
    title.className = 'recorded-video-player-title';
    title.textContent = record.title;
    const shut = doc.createElement('button');
    shut.type = 'button';
    shut.className = 'recorded-video-player-close';
    shut.textContent = '×';
    // i18n-ignore: personal fork, English-only UI
    shut.setAttribute('aria-label', 'Close the video');
    shut.addEventListener('click', close);
    header.append(title, shut);
    const frame = doc.createElement('iframe');
    frame.className = 'recorded-video-player-frame';
    frame.src = src;
    // i18n-ignore: personal fork, English-only UI
    frame.title = `${record.title} on YouTube`;
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
    // i18n-ignore: personal fork, English-only UI
    link.textContent = 'WATCH ON YOUTUBE ↗';
    panel.append(header, frame, caption, link);
    doc.body.appendChild(panel);
  }

  return { open, close, isOpen: () => Boolean(panel) };
}
