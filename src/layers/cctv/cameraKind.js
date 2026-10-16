// Personal fork: what kind of camera a record is, for the panel and the cone.

/** Camera kinds, from the most to the least the app can model. */
export const CAMERA_KINDS = Object.freeze([
  'projected',
  'embed',
  'still',
  'link',
]);

/**
 * The camera's kind, from its catalog record or public state:
 * - 'embed'     a stream only its own player may show (YouTube);
 * - 'link'      only an operator page, no picture here;
 * - 'still'     a display-only picture with no surveyed pose (Windy, USGS,
 *               NPS, OpenCCTV, OpenStreetMap/Wikidata-linked feeds: every
 *               provenance-carrying source, which sets `licenseClass`);
 * - 'projected' a traffic/agency camera with a real or estimated pose, the
 *               default the calibration and projection tools are built for.
 * @param {object|null} camera
 * @returns {'projected'|'embed'|'still'|'link'}
 */
export function cameraKind(camera) {
  if (!camera) return 'projected';
  if (camera.embed?.provider === 'youtube' || camera.feedType === 'youtube')
    return 'embed';
  if (camera.feedType === 'link') return 'link';
  if (camera.licenseClass) return 'still';
  return 'projected';
}

/** True when the camera has no pose worth drawing as a cone or a monitor plane. */
export function isPoselessKind(kind) {
  return kind === 'embed' || kind === 'still' || kind === 'link';
}
