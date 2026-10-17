/**
 * Personal fork: an operator's YouTube stream plays in YouTube's own embedded
 * player inside the camera panel, the way the operator's site shows it. The
 * player is created only while the panel is open, and removed when the camera
 * changes, the panel collapses or the layer turns off, so nothing plays
 * unseen.
 */

import { msg, t } from '../i18n/index.js';

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** A YouTube stream's live state as the badge says it. */
const LIVE_STATUS_LABELS = Object.freeze({
  live: msg('LIVE'),
  upcoming: msg('UPCOMING'),
  offline: msg('OFFLINE'),
  unknown: msg('STATUS UNKNOWN'),
});
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Player URL for one stream: muted autoplay, inline, no unrelated suggestions. */
export function youtubeEmbedUrl(videoId) {
  if (!VIDEO_ID.test(String(videoId))) return '';
  const url = new URL(`${EMBED_ORIGIN}/embed/${videoId}`);
  url.searchParams.set('autoplay', '1');
  url.searchParams.set('mute', '1');
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('rel', '0');
  return url.href;
}

function removeEmbed(controls) {
  controls._cctvEmbedFrame?.remove();
  controls._cctvEmbedFrame = null;
  controls._cctvFrameWrap?.classList.remove('has-embed');
}

/**
 * Show, keep or remove the panel player for the active camera.
 * @param {object} controls - CctvControls instance.
 * @param {{enabled?: boolean, activeCamera?: object|null}} state
 * @returns {boolean} True while the active camera is an embedded stream, so
 *   the caller leaves the frame preview alone.
 */
export function syncCctvEmbed(
  controls,
  { enabled = false, activeCamera } = {},
) {
  const embed =
    enabled && activeCamera?.embed?.provider === 'youtube'
      ? activeCamera.embed
      : null;
  const src = embed ? youtubeEmbedUrl(embed.videoId) : '';
  const wrap = controls._cctvFrameWrap;
  if (!src || !wrap) {
    removeEmbed(controls);
    return false;
  }
  if (controls._cctvPanel?.classList.contains('collapsed')) {
    removeEmbed(controls);
    return true;
  }
  if (controls._cctvEmbedFrame?.dataset.videoId === embed.videoId) return true;
  removeEmbed(controls);
  const frame = document.createElement('iframe');
  frame.className = 'cctv-embed';
  frame.src = src;
  frame.title = t('{name} on YouTube', {
    name: activeCamera.name || t('Live stream'),
  });
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.dataset.videoId = embed.videoId;
  wrap.appendChild(frame);
  wrap.classList.add('has-embed');
  controls._cctvEmbedFrame = frame;
  return true;
}

/**
 * The operator-page link for the active camera, or null. Only https links
 * from the server-side provenance are offered.
 * @param {object|null} activeCamera
 * @returns {{href: string, text: string}|null}
 */
export function operatorLinkFor(activeCamera) {
  let url;
  try {
    url = new URL(String(activeCamera?.operatorUrl || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const site = host.toUpperCase();
  const text =
    activeCamera?.feedType === 'link'
      ? t('WATCH ON {site} ↗', { site })
      : t('OPEN ON {site} ↗', { site });
  return { href: url.href, text };
}

/** Badge text for an embedded stream, e.g. "YOUTUBE · LIVE". */
export function embedBadgeText(activeCamera) {
  const code = String(activeCamera?.liveStatus || 'unknown').toLowerCase();
  const label = LIVE_STATUS_LABELS[code];
  return t('YOUTUBE · {status}', {
    status: label ? t(label) : code.toUpperCase(),
  });
}

/** Meta line for an embedded stream: place, how precise the pin is, operator. */
export function embedMetaText(activeCamera) {
  const quality = {
    site: msg('PIN AT SITE'),
    area: msg('PIN AT AREA'),
    region: msg('PIN AT REGION'),
    'operator-geotag': msg('OPERATOR GEOTAG'),
  }[activeCamera?.coordinatesQuality];
  return [
    activeCamera?.city,
    String(activeCamera?.category || '').toUpperCase(),
    quality ? t(quality) : null,
    activeCamera?.provider,
  ]
    .filter(Boolean)
    .join(' · ');
}
