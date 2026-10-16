// Personal fork: the camera panel shows only what applies to the camera's kind.
import { cameraKind, CAMERA_KINDS } from '../layers/cctv/cameraKind.js';
import { apparentSolarTime, daylightPhase } from '../data/solarDaylight.js';
import { embedMetaText } from './cctvEmbed.js';
import { audioMetaLabel } from '../layers/cctv/audio.js';

/**
 * The panel kind of a public camera state: the layer's `panelKind`, else the
 * same derivation (layers/cctv/cameraKind.js) from the state's own fields.
 * @returns {'projected'|'embed'|'still'|'link'}
 */
export function cctvPanelKind(camera) {
  if (CAMERA_KINDS.includes(camera?.panelKind)) return camera.panelKind;
  return cameraKind(camera);
}

/**
 * Which pose-dependent parts of the panel a kind shows. Only 'projected'
 * cameras have a pose to calibrate, project or draw a cone for; every kind
 * keeps CCTV ON, NEAREST, PREV/NEXT and the picker, FOCUS, AUTO HOP and
 * the COVERAGE/VIEWSHED switch.
 */
export function panelSections(kind) {
  const posed = kind === 'projected';
  return Object.freeze({
    calibration: posed,
    poseReadouts: posed,
    calibrationActions: posed,
    calBadge: posed,
    projection: posed,
    cone: posed,
    localTime: !posed,
  });
}

const pad = (n) => String(n).padStart(2, '0');

/** "14:05" in an IANA zone, or null when the zone is missing or unknown. */
function zonedClock(ms, timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    return hour && minute ? `${hour}:${minute}` : null;
  } catch {
    return null;
  }
}

/**
 * Local time and daylight at the camera. With the source's IANA zone the
 * clock is civil time; without one (no source carries a zone yet) it is the
 * apparent solar time at the camera's longitude, labelled "solar".
 * @returns {{clock: string, solar: boolean, phase: 'day'|'dawn'|'dusk'|'night'}|null}
 */
export function cameraLocalTime(camera, now = Date.now()) {
  if (camera?.lat == null || camera?.lon == null) return null;
  const lat = Number(camera.lat);
  const lon = Number(camera.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const phase = daylightPhase(now, lat, lon);
  const zoned = zonedClock(now, camera?.timeZone);
  if (zoned) return { clock: zoned, solar: false, phase };
  const { hours, minutes } = apparentSolarTime(now, lon);
  return { clock: `${pad(hours)}:${pad(minutes)}`, solar: true, phase };
}

/**
 * True for a live embedded stream at night: many "live" webcam streams loop
 * a daytime recording, so the picture is probably a replay.
 */
export function probablyReplay(camera, local) {
  return (
    cctvPanelKind(camera) === 'embed' &&
    String(camera?.liveStatus || '').toLowerCase() === 'live' &&
    local?.phase === 'night'
  );
}

/** "Local 03:12 solar · night · probably a replay", or '' without a position. */
export function localTimeLine(camera, now = Date.now()) {
  const local = cameraLocalTime(camera, now);
  if (!local) return '';
  return [
    `Local ${local.clock}${local.solar ? ' solar' : ''}`,
    local.phase,
    probablyReplay(camera, local) ? 'probably a replay' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Meta line for a camera without a pose: place, category, pin precision,
 * operator, credit and source status; the local-time line under it.
 */
export function poselessMetaText(camera, now = Date.now()) {
  const first = [
    embedMetaText(camera),
    camera?.credit && camera.credit !== camera.provider ? camera.credit : null,
    audioMetaLabel(camera) || null,
    camera?.sourceMessage || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const time = localTimeLine(camera, now);
  return time ? `${first}\n${time}` : first;
}

const KIND_PHRASE = {
  embed: (camera) =>
    String(camera?.liveStatus).toLowerCase() === 'live'
      ? 'Live stream'
      : 'Video stream',
  still: () => 'Still camera',
  link: () => 'Webcam link',
};

const PRECISION_PHRASE = {
  site: 'pinned at the site',
  area: 'pinned to the area',
  region: 'pinned only to the region',
  'operator-geotag': "pinned at the operator's geotag",
};

/**
 * The scene summary for a camera without a pose, in plain words instead of
 * the pose/coverage readout: kind, place, category, precision, operator and
 * local time. Null for projected cameras (their summary is the layer's).
 */
export function plainCameraSummary(camera, now = Date.now()) {
  const kind = cctvPanelKind(camera);
  if (kind === 'projected' || !camera) return null;
  const name = String(camera.name || '').trim();
  const city = String(camera.city || '').trim();
  const place = [name, city && city !== name ? city : null]
    .filter(Boolean)
    .join(', ');
  const category = String(camera.category || '').trim();
  const precision = PRECISION_PHRASE[camera.coordinatesQuality] || null;
  const detail = [
    category ? `${category[0].toUpperCase()}${category.slice(1)} camera` : null,
    precision,
  ]
    .filter(Boolean)
    .join(', ');
  const operator = camera.provider ? `Operator: ${camera.provider}.` : null;
  const local = cameraLocalTime(camera, now);
  const time = local
    ? `Local time ${local.clock}${local.solar ? ' (solar)' : ''}, ${local.phase}${probablyReplay(camera, local) ? ' — probably a replay' : ''}.`
    : null;
  return [
    `${KIND_PHRASE[kind](camera)}${place ? `: ${place}` : ''}.`,
    detail ? `${detail[0].toUpperCase()}${detail.slice(1)}.` : null,
    operator,
    time,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Fit the panel to the active camera's kind: tag the panel for the CSS that
 * hides pose-only controls, and replace the meta line for poseless kinds.
 * Returns the plain summary to show, or null to keep the layer's.
 * @param {object} controls  CctvControls instance (its `_cctvPanel`, `_cctvMeta`).
 */
export function syncCctvPanelKind(
  controls,
  { enabled = false, activeCamera = null, now = Date.now() } = {},
) {
  const kind = enabled && activeCamera ? cctvPanelKind(activeCamera) : null;
  const panel = controls?._cctvPanel;
  if (panel?.dataset) {
    if (kind && kind !== 'projected') panel.dataset.cameraKind = kind;
    else delete panel.dataset.cameraKind;
  }
  if (!kind || kind === 'projected') return null;
  if (controls._cctvMeta)
    controls._cctvMeta.textContent = poselessMetaText(activeCamera, now);
  return plainCameraSummary(activeCamera, now);
}
