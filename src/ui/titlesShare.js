// Personal fork: the Titles toggle in the share link: an assignment in the
// `ui` param (src/sharelink.js), `tl.v.0` when titles are off. Pure: no
// DOM, no overlay host. Not part of upstream.

/** The share link's `ui` param, and the Titles assignment's token and field. */
export const SHARE_UI_PARAM = 'ui';
export const TITLES_SHARE_PREFIX = 'tl.v.';

/** The Titles setting a link carries: true, false, or null (none). */
export function decodeTitlesParam(params) {
  if (params?.get?.('v') !== '2') return null;
  const raw = String(params.get(SHARE_UI_PARAM) || '');
  for (const assignment of raw.split('_')) {
    if (assignment === `${TITLES_SHARE_PREFIX}0`) return false;
    if (assignment === `${TITLES_SHARE_PREFIX}1`) return true;
  }
  return null;
}

/**
 * Put the Titles setting in a link's `ui` param, beside the panels'
 * assignments: written only when off (on is the default), so a link
 * without it reads as on.
 */
export function encodeTitlesParam(params, visible) {
  const kept = String(params.get(SHARE_UI_PARAM) || '')
    .split('_')
    .filter(
      (assignment) => assignment && !assignment.startsWith(TITLES_SHARE_PREFIX),
    );
  if (visible === false) kept.push(`${TITLES_SHARE_PREFIX}0`);
  if (kept.length) params.set(SHARE_UI_PARAM, kept.join('_'));
  else params.delete(SHARE_UI_PARAM);
}
