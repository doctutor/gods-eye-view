import { formatNumber, msg, t } from '../../i18n/index.js';

/**
 * Personal fork: what the card beside a clicked river reach says, in plain
 * words, from a 'river-reach/1' answer (src/data/riverReach.js): the river
 * and its basin, its size and flow, whether it flows freely and what most
 * presses on it, and how far its water has to go.
 */

/** RIV_ORD (HydroRIVERS' discharge order) as a size anyone can read. */
const SIZE_CLASSES = Object.freeze({
  1: msg('Great river'),
  2: msg('Very large river'),
  3: msg('Large river'),
  4: msg('Medium river'),
  5: msg('Small river'),
  6: msg('Stream'),
  7: msg('Small stream'),
  8: msg('Brook'),
  9: msg('Brook'),
  10: msg('Brook'),
});

/** CSI_FF2: the Free-Flowing Rivers status of the reach. */
const STATUSES = Object.freeze({
  1: msg('Free-flowing'),
  2: msg('Good connectivity'),
  3: msg('Impacted'),
});

/** CSI_D: the pressure that lowers the connectivity index most. */
const PRESSURES = Object.freeze({
  DOF: msg('fragmentation by dams'),
  DOR: msg('flow regulated by reservoirs'),
  SED: msg('sediment trapped by dams'),
  USE: msg('water withdrawals'),
  RDD: msg('roads along the river'),
  URB: msg('urban areas'),
});

export function sizeClass(order) {
  const label = SIZE_CLASSES[Number(order)];
  return label ? t(label) : t('River');
}

export function statusText(code) {
  const label = STATUSES[Number(code)];
  return label ? t(label) : null;
}

export function pressureText(code) {
  const label = PRESSURES[String(code || '').toUpperCase()];
  return label ? t(label) : null;
}

/** Average flow, rounded to what reads well: 0.13, 75, 2,311. */
export function flowText(cms) {
  const value = Number(cms);
  if (!Number.isFinite(value) || value < 0) return null;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : 3;
  return t('{flow} m³/s average flow', {
    flow: formatNumber(value, { maximumFractionDigits: digits }),
  });
}

/**
 * A river's name from OpenStreetMap (the river names sidecar), in its own
 * language with the English one beside it when they differ.
 */
export function osmNameTitle(osmName) {
  const name = String(osmName?.name || '').trim();
  if (!name) return '';
  const english = String(osmName.nameEn || '').trim();
  return english && english !== name ? `${name} (${english})` : name;
}

/** Whether an OpenStreetMap name and BB_NAME name the same river. */
const sameRiver = (osmName, bbName) => {
  const fold = (text) =>
    String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(river|rio|fleuve|riviere|fluss)\b/g, '')
      .replace(/[^a-z0-9\u0400-\u04ff]+/g, '');
  const bb = fold(bbName);
  return Boolean(
    bb && [osmName?.name, osmName?.nameEn].some((n) => fold(n) === bb),
  );
};

/**
 * The river's name: the sidecar's OpenStreetMap name (direct, then carried
 * down the main stem), then a live one from a nearby waterway unless
 * BB_NAME names the river otherwise, then BB_NAME; an unnamed one is named
 * after the first named river below it.
 */
export function reachTitle(answer) {
  // Personal fork: OpenStreetMap's name, when there is one.
  const name = answer?.reach?.properties?.BB_NAME;
  const osmName = answer?.osmName;
  const live = osmName?.confidence === 'live';
  const osm = osmNameTitle(osmName);
  if (osm && (!live || !name || sameRiver(osmName, name))) return osm;
  if (name) return name;
  const below = (answer?.downstream?.segments || []).find((s) => s.name);
  if (below) return t('Tributary of {river}', { river: below.name });
  // Some great rivers are unnamed in the data (the Volga's lower course).
  const basin = answer?.reach?.properties?.BAS_NAME;
  return basin
    ? t('A river of the {basin} basin', { basin })
    : t('Unnamed river');
}

/** Where the card's name came from, when OpenStreetMap gave it. */
export function osmNameSource(osmName, bbName = '') {
  if (!osmName?.name) return '';
  if (osmName.confidence === 'live')
    return bbName && !sameRiver(osmName, bbName)
      ? ''
      : t(
          'Name from OpenStreetMap (nearby waterway), © OpenStreetMap contributors, ODbL',
        );
  if (osmName.confidence === 'direct')
    return t('Name from OpenStreetMap (© OpenStreetMap contributors, ODbL)');
  if (osmName.confidence === 'inherited')
    return t(
      'Name from OpenStreetMap, carried down the main stem (© OpenStreetMap contributors, ODbL)',
    );
  return t(
    'Name of the nearest OpenStreetMap waterway (© OpenStreetMap contributors, ODbL)',
  );
}

/** How far the water goes from the click, and where it ends. */
export function distanceText(downstream) {
  const km = Number(downstream?.distanceToMouthKm);
  if (!Number.isFinite(km)) return null;
  const distance = formatNumber(Math.round(km), { maximumFractionDigits: 0 });
  if (downstream.terminal === 'ocean')
    return t('{km} km to the sea', { km: distance });
  if (downstream.terminal === 'inland')
    return t('{km} km to an inland sink', { km: distance });
  return t('{km} km traced downstream, not yet to the end', { km: distance });
}

/**
 * The card's lines under the title.
 * @param {object} answer a 'river-reach/1' answer
 * @param {{upstream?: 'loading'|'failed'|null}} [state]
 */
export function reachCardDetails(answer, { upstream = null } = {}) {
  const props = answer?.reach?.properties || {};
  const lines = [];
  const place = [
    props.BAS_NAME ? t('{basin} basin', { basin: props.BAS_NAME }) : null,
    props.COUNTRY || null,
  ].filter(Boolean);
  if (place.length) lines.push(place.join(' · '));
  lines.push(
    [sizeClass(props.RIV_ORD), flowText(props.DIS_AV_CMS)]
      .filter(Boolean)
      .join(' · '),
  );
  const status = statusText(props.CSI_FF2);
  const csi = Number(props.CSI);
  if (status)
    lines.push(
      Number.isFinite(csi)
        ? t('{status} (connectivity {csi}%)', {
            status,
            csi: formatNumber(csi, { maximumFractionDigits: 0 }),
          })
        : status,
    );
  const pressure = pressureText(props.CSI_D);
  if (pressure && Number.isFinite(csi) && csi < 100)
    lines.push(
      Number(props.CSI_FF2) === 1
        ? t('Slight pressure: {pressure}', { pressure })
        : t('Main pressure: {pressure}', { pressure }),
    );
  const distance = distanceText(answer?.downstream);
  if (distance) lines.push(distance);
  const naming = osmNameSource(answer?.osmName, props.BB_NAME);
  if (naming) lines.push(naming);
  if (upstream === 'loading') lines.push(t('Tracing the rivers upstream…'));
  else if (upstream === 'failed')
    lines.push(t('The rivers upstream could not be traced'));
  else if (answer?.upstream?.truncated)
    lines.push(
      t('Upstream: the {count} largest reaches', {
        count: formatNumber(answer.upstream.reaches),
      }),
    );
  return lines;
}

/** The short label at the path's end. */
export function mouthLabel(downstream) {
  if (downstream?.terminal === 'ocean') return t('Mouth');
  if (downstream?.terminal === 'inland') return t('Inland sink');
  return t('Trace ends');
}

/** The card while a click is looked up, or when it found nothing. */
export function pendingTitle() {
  return t('Looking for a river…');
}
export function missTitle() {
  return t('No river here');
}
/** A failed lookup, by status: 503 is a server without Earth Engine. */
export function failureTitle(status) {
  if (status === 503) return t('River lookups need Earth Engine on the server');
  if (status === 429) return t('Too many river lookups; try again shortly');
  return t('The river could not be traced');
}
