/**
 * Personal fork: the HUD's camera readout (src/hud.js): the camera's view
 * state, its height above the surface under it and what one pixel covers,
 * each written to the precision the view supports (src/hud/precision.js),
 * with a tooltip saying what the number is, against what surface, what
 * bounds its precision, and whether it can be edited. A click on an
 * editable number opens it for typing: Enter applies, Escape (or leaving
 * the field) cancels.
 *
 * Bottom left, the position: LAT and LON (decimal degrees, editable), DMS
 * and MGRS at the same precision, ALT above mean sea level and AGL above
 * the rendered surface (both editable). Bottom right, the pose: HEADING,
 * PITCH, ROLL and FOV (editable), PX and SUN.
 */
import { formatNumber, msg, t } from '../i18n/index.js';
import { formatDms } from '../ui/dms.js';
import { MAX_FOV_DEG, MIN_FOV_DEG } from './cameraState.js';
import { DEFAULT_FOV_DEG, formatFootprint, formatLength } from './precision.js';

/** The readout's fields, in order, with their corner and label. */
export const CAMERA_FIELDS = Object.freeze([
  { id: 'lat', corner: 'position', label: msg('LAT'), editable: true },
  { id: 'lon', corner: 'position', label: msg('LON'), editable: true },
  { id: 'dms', corner: 'position', label: msg('DMS'), editable: false },
  { id: 'mgrs', corner: 'position', label: msg('MGRS'), editable: false },
  { id: 'alt', corner: 'position', label: msg('ALT'), editable: true },
  { id: 'agl', corner: 'position', label: msg('AGL'), editable: true },
  { id: 'heading', corner: 'pose', label: msg('HEADING'), editable: true },
  { id: 'pitch', corner: 'pose', label: msg('PITCH'), editable: true },
  { id: 'roll', corner: 'pose', label: msg('ROLL'), editable: true },
  { id: 'fov', corner: 'pose', label: msg('FOV'), editable: true },
  { id: 'px', corner: 'pose', label: msg('PX'), editable: false },
  { id: 'sun', corner: 'pose', label: msg('SUN'), editable: false },
]);
const FIELD_BY_ID = new Map(CAMERA_FIELDS.map((field) => [field.id, field]));
export const isEditableField = (id) => FIELD_BY_ID.get(id)?.editable === true;

/** The id of a field's value element, and of AGL's floor note. */
export const fieldElementId = (id) => `hud-cam-${id}`;
export const FLOOR_NOTE_ID = 'hud-cam-agl-floor';

/** The corner's markup: label, value (focusable when editable), unit. */
export function cameraFieldsHtml(corner) {
  return CAMERA_FIELDS.filter((field) => field.corner === corner)
    .map((field) => {
      const edit = field.editable
        ? ' tabindex="0" role="button" data-cam-editable="true"'
        : '';
      const floor =
        field.id === 'agl'
          ? ` <span class="hud-cam-floor" id="${FLOOR_NOTE_ID}"></span>`
          : '';
      return `<div class="hud-cam-row" data-cam-row="${field.id}"><span class="hud-cam-label">${t(field.label)}</span> <span class="hud-cam-value" id="${fieldElementId(field.id)}" data-cam-field="${field.id}"${edit}>—</span>${floor}</div>`;
    })
    .join('');
}

/** A length step as words: "0.1 m", "10 m", "1 km". */
export function stepText(stepM) {
  if (stepM >= 1000) return `${formatNumber(stepM / 1000)} km`;
  return `${formatNumber(stepM, { maximumFractionDigits: 3 })} m`;
}

/** What bounds a length's precision: the pixel, or the surface's floor. */
function boundText(precision) {
  const floor = precision.floor;
  if (floor?.id === 'flat')
    return t(
      'Shown to {step}: no terrain is loaded under the camera (a flat ellipsoid), so no finer.',
      { step: stepText(precision.stepM) },
    );
  const fromFloor =
    floor?.floorM > 0 &&
    !(precision.footprintM > 0 && precision.footprintM >= floor.floorM);
  if (fromFloor)
    return t(
      'Shown to {step}: the {source} surface is {floor} m resolution, so no finer.',
      {
        step: stepText(precision.stepM),
        source: floor.name,
        floor: formatNumber(floor.floorM),
      },
    );
  return t('Shown to {step}: one pixel covers {px} here.', {
    step: stepText(precision.stepM),
    px: formatFootprint(precision.footprintM),
  });
}

const degrees = (value, decimals) => `${value.toFixed(decimals)}°`;
/** Heading in 0 … 360, roll in −180 … 180. */
export const normalizeHeading = (deg) => ((deg % 360) + 360) % 360;
/** Heading as written: 359.999° shows 0.00°, not 360.00°. */
const headingText = (deg, decimals) => {
  const shown = Number(normalizeHeading(deg).toFixed(decimals));
  return `${(shown >= 360 ? 0 : shown).toFixed(decimals)}°`;
};
export const normalizeRoll = (deg) => {
  const wrapped = normalizeHeading(deg + 180) - 180;
  return wrapped === -180 ? 180 : wrapped;
};

/**
 * Every field's text and tooltip.
 * @param {{view: object, altMslM: number, geoidApplied: boolean,
 *   aglM: number, aglStepM?: number|null, footprintM: number,
 *   distanceM: number, sunElDeg: number, pixelDeg: number}} reading the
 *   camera now (src/hud.js); `aglStepM` rounds the AGL instead of the
 *   view's step (Walk and Fly: the model's exact ground)
 * @param {ReturnType<import('./precision.js').viewPrecision>} precision
 * @param {{mgrs?: (lon: number, lat: number, digits: number) => string}} [options]
 * @returns {Record<string, {text: string, title: string}>}
 */
export function formatCameraReadout(reading, precision, { mgrs = null } = {}) {
  const { view } = reading;
  const bound = boundText(precision);
  const edit = t('Click to edit.');
  const angle = t('One pixel is about {pixel}°, so 2 decimals.', {
    pixel: formatNumber(reading.pixelDeg, { maximumFractionDigits: 3 }),
  });
  const d = precision.degreeDecimals;
  let mgrsText = '—';
  try {
    if (mgrs) mgrsText = mgrs(view.lon, view.lat, precision.mgrsDigits) || '—';
  } catch {
    mgrsText = '—';
  }
  const source = precision.floor?.name || '';
  const out = {
    lat: {
      text: degrees(view.lat, d),
      title: `${t('Camera latitude, degrees on the WGS84 ellipsoid.')} ${bound} ${edit}`,
    },
    lon: {
      text: degrees(view.lon, d),
      title: `${t('Camera longitude, degrees on the WGS84 ellipsoid.')} ${bound} ${edit}`,
    },
    dms: {
      text: `${formatDms(view.lat, 'lat', { secondDecimals: precision.secondDecimals })} ${formatDms(view.lon, 'lon', { secondDecimals: precision.secondDecimals })}`,
      title: `${t('The camera position in degrees, minutes and seconds, at the same precision.')} ${bound}`,
    },
    mgrs: {
      text: mgrsText,
      title: `${t('The camera position as an MGRS grid reference, to {step}.', {
        step: stepText(10 ** (5 - precision.mgrsDigits)),
      })} ${bound}`,
    },
    alt: {
      text: `${formatLength(reading.altMslM, precision.stepM)} m`,
      title: `${
        reading.geoidApplied
          ? t('Camera height above mean sea level (the EGM96 geoid).')
          : t('Camera height above the WGS84 ellipsoid, until the geoid loads.')
      } ${bound} ${edit}`,
    },
    agl: {
      text: Number.isFinite(reading.aglM)
        ? `${formatLength(reading.aglM, reading.aglStepM > 0 ? reading.aglStepM : precision.stepM)} m`
        : '—',
      title: Number.isFinite(reading.aglM)
        ? `${t('Camera height above the rendered surface directly under it ({source}).', { source })} ${bound} ${t('Click to edit: ALT becomes the surface’s height plus the number typed.')}`
        : t(
            'Camera height above the rendered surface under it: waiting for that surface to load.',
          ),
    },
    heading: {
      text: headingText(view.headingDeg, precision.angleDecimals),
      title: `${t('Camera heading, degrees clockwise from true north.')} ${angle} ${edit}`,
    },
    pitch: {
      text: degrees(view.pitchDeg, precision.angleDecimals),
      title: `${t('Camera pitch, degrees from the horizontal; −90° looks straight down.')} ${angle} ${edit}`,
    },
    roll: {
      text: degrees(normalizeRoll(view.rollDeg), precision.angleDecimals),
      title: `${t('Camera roll, degrees about the direction of view.')} ${angle} ${edit}`,
    },
    fov: {
      text: degrees(view.fovDeg, precision.angleDecimals),
      title: `${t('Field of view across the wider side of the screen, degrees ({fov}° by default).', { fov: formatNumber(DEFAULT_FOV_DEG) })} ${angle} ${edit}`,
    },
    px: {
      text: formatFootprint(reading.footprintM),
      title: t(
        'What one screen pixel covers at the centre of the view: 2·d·tan(FOV/2) ÷ width, d the distance to the surface there ({distance}).',
        { distance: stepText(Math.max(0.001, Math.round(reading.distanceM))) },
      ),
    },
    sun: {
      text: Number.isFinite(reading.sunElDeg)
        ? `${reading.sunElDeg.toFixed(1)}° EL`
        : '—',
      title: t(
        'Estimated sun elevation above the horizon at the camera, degrees.',
      ),
    },
  };
  return out;
}

/** The floor note beside AGL: "· Google". */
export const floorNoteText = (precision) =>
  precision.floor?.name ? `· ${precision.floor.name}` : '';

/**
 * A typed number: decimal point or comma, a leading minus or −, a trailing
 * ° or m tolerated. NaN when it is not a number.
 */
export function parseEditValue(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/−/g, '-')
    .replace(',', '.')
    .replace(/\s*(°|m)$/i, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

/**
 * The view after editing one field to `value`, the other numbers held;
 * null when the value is not one the field takes. ALT is above sea level
 * (`geoidN` turns it back into the ellipsoidal height the camera keeps);
 * AGL above `surfaceM`, the surface's ellipsoidal height under the camera.
 */
export function editedView(
  view,
  field,
  value,
  { surfaceM = NaN, geoidN = null } = {},
) {
  if (!view || !Number.isFinite(value)) return null;
  const next = { ...view };
  switch (field) {
    case 'lat':
      if (value < -90 || value > 90) return null;
      next.lat = value;
      break;
    case 'lon':
      if (value < -180 || value > 180) return null;
      next.lon = value;
      break;
    case 'alt':
      next.heightM = value + (Number.isFinite(geoidN) ? geoidN : 0);
      break;
    case 'agl':
      if (!Number.isFinite(surfaceM) || value < 0) return null;
      next.heightM = surfaceM + value;
      break;
    case 'heading':
      next.headingDeg = normalizeHeading(value);
      break;
    case 'pitch':
      if (value < -90 || value > 90) return null;
      next.pitchDeg = value;
      break;
    case 'roll':
      next.rollDeg = normalizeRoll(value);
      break;
    case 'fov':
      if (value < MIN_FOV_DEG || value > MAX_FOV_DEG) return null;
      next.fovDeg = value;
      break;
    default:
      return null;
  }
  return next;
}

/**
 * Click-to-edit on the readout's corners. `value(field)` is the number to
 * put in the box (as shown), `apply(field, number)` applies it and says
 * whether it took; `onChange()` is told when editing starts or ends.
 * @returns {{editing: () => string|null, cancel: () => void, detach: () => void}}
 */
export function attachCameraEditing({
  roots,
  documentRef = globalThis.document,
  value,
  apply,
  onChange = () => {},
}) {
  let editing = null;

  function finish() {
    if (!editing) return;
    const { element, input } = editing;
    editing = null;
    input.remove?.();
    element.classList?.remove?.('editing');
    onChange();
  }

  function start(element) {
    const field = element?.dataset?.camField;
    if (!isEditableField(field) || editing?.element === element) return;
    finish();
    const input = documentRef.createElement('input');
    input.type = 'text';
    input.className = 'hud-cam-input';
    input.value = value(field);
    input.setAttribute('aria-label', t(FIELD_BY_ID.get(field).label));
    input.setAttribute('inputmode', 'decimal');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault?.();
        const number = parseEditValue(input.value);
        if (apply(field, number)) finish();
        else input.classList?.add?.('invalid');
      } else if (event.key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        finish();
      }
    });
    input.addEventListener('blur', () => {
      if (editing?.input === input) finish();
    });
    editing = { field, element, input };
    element.textContent = '';
    element.classList?.add?.('editing');
    element.appendChild(input);
    onChange();
    input.focus?.();
    input.select?.();
  }

  const fieldOf = (target) => target?.closest?.('[data-cam-editable]') || null;
  const onClick = (event) => {
    const element = fieldOf(event.target);
    if (element) start(element);
  };
  const onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const element = fieldOf(event.target);
    if (!element || event.target !== element) return;
    event.preventDefault?.();
    start(element);
  };
  for (const root of roots) {
    root?.addEventListener?.('click', onClick);
    root?.addEventListener?.('keydown', onKey);
  }
  return {
    editing: () => editing?.field ?? null,
    cancel: finish,
    detach() {
      finish();
      for (const root of roots) {
        root?.removeEventListener?.('click', onClick);
        root?.removeEventListener?.('keydown', onKey);
      }
    },
  };
}
