/**
 * Personal fork: an operator's YouTube stream plays in YouTube's own embedded
 * player inside the camera panel, the way the operator's site shows it. The
 * player is created only while the panel is open, and removed when the camera
 * changes, the panel collapses or the layer turns off, so nothing plays
 * unseen.
 *
 * A camera from the OpenCCTV directory (server/providers/cctv/camindex.js)
 * may instead carry that directory's own player page, which is framed only
 * when it is an https://opencctv.org/cameras/… page; no other host is ever
 * framed from a camera record.
 */

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Directory player hosts the panel may frame, by provider. */
const DIRECTORY_EMBED_HOSTS = Object.freeze({ opencctv: 'opencctv.org' });
const PROVIDER_NAMES = Object.freeze({
  youtube: 'YouTube',
  opencctv: 'OpenCCTV',
});

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

/** An OpenCCTV camera page to frame, or '' for anything else. */
export function opencctvEmbedUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return '';
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== DIRECTORY_EMBED_HOSTS.opencctv ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/cameras/')
  )
    return '';
  return url.href;
}

/** The frame URL for a camera's embed, or '' when it may not be framed. */
export function embedSrcFor(embed) {
  if (embed?.provider === 'youtube') return youtubeEmbedUrl(embed.videoId);
  if (embed?.provider === 'opencctv') return opencctvEmbedUrl(embed.url);
  return '';
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
  const embed = enabled ? activeCamera?.embed : null;
  const src = embedSrcFor(embed);
  const wrap = controls._cctvFrameWrap;
  if (!src || !wrap) {
    removeEmbed(controls);
    return false;
  }
  if (controls._cctvPanel?.classList.contains('collapsed')) {
    removeEmbed(controls);
    return true;
  }
  if (controls._cctvEmbedFrame?.dataset.embedSrc === src) return true;
  removeEmbed(controls);
  const frame = document.createElement('iframe');
  frame.className = 'cctv-embed';
  frame.src = src;
  frame.title = `${activeCamera.name || 'Live stream'} on ${PROVIDER_NAMES[embed.provider]}`;
  if (embed.provider === 'youtube') {
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  } else {
    // A directory page: its own scripts run, but it may not navigate the
    // app, open windows or submit forms.
    frame.allow = 'fullscreen';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  }
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.dataset.embedSrc = src;
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
  const verb = activeCamera?.feedType === 'link' ? 'WATCH ON' : 'OPEN ON';
  return { href: url.href, text: `${verb} ${host.toUpperCase()} ↗` };
}

/** Badge text for an embedded stream, e.g. "YOUTUBE · LIVE". */
export function embedBadgeText(activeCamera) {
  const status = String(activeCamera?.liveStatus || 'unknown').toUpperCase();
  const provider = (
    PROVIDER_NAMES[activeCamera?.embed?.provider] || 'YouTube'
  ).toUpperCase();
  return `${provider} · ${status === 'UNKNOWN' ? 'STATUS UNKNOWN' : status}`;
}

/** Meta line for an embedded stream: place, how precise the pin is, operator. */
export function embedMetaText(activeCamera) {
  const quality = {
    site: 'PIN AT SITE',
    area: 'PIN AT AREA',
    region: 'PIN AT REGION',
    'operator-geotag': 'OPERATOR GEOTAG',
  }[activeCamera?.coordinatesQuality];
  return [
    activeCamera?.city,
    String(activeCamera?.category || '').toUpperCase(),
    quality,
    activeCamera?.provider,
  ]
    .filter(Boolean)
    .join(' · ');
}
