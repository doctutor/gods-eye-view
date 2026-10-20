import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import {
  ROAD_MODES,
  SURFACE_COLORS,
  UNKNOWN_SPEED_COLOR,
  roadClassByKey,
  speedColor,
} from '../../data/overtureRoads.js';

/**
 * Personal fork: what the Roads layer says in words: its chips (NETWORK,
 * SPEED, SURFACE; AUTO, LIGHT and DARK ink), the legend in the ink drawn,
 * the row's status and a road's card.
 */

export const MODE_WORDS = Object.freeze({
  network: Object.freeze({
    chip: msg('NETWORK'),
    title: msg(
      'Roads by class: motorways from orbit, main roads, streets, then paths close in',
    ),
  }),
  speed: Object.freeze({
    chip: msg('SPEED'),
    title: msg('Speed limits where they are mapped'),
  }),
  surface: Object.freeze({
    chip: msg('SURFACE'),
    title: msg('Paved, unpaved, or not mapped'),
  }),
});

export const INK_WORDS = Object.freeze([
  Object.freeze({
    key: 'auto',
    label: msg('AUTO INK'),
    title: msg(
      'The colours follow the basemap: bright on dark maps, deep on light maps',
    ),
  }),
  Object.freeze({
    key: 'light',
    label: msg('LIGHT INK'),
    title: msg('Bright colours, for dark maps'),
  }),
  Object.freeze({
    key: 'dark',
    label: msg('DARK INK'),
    title: msg('Deep colours, for light maps'),
  }),
]);

/** What a class is called on the legend and the card. */
export const CLASS_WORDS = Object.freeze({
  motorway: msg('Motorway'),
  trunk: msg('Trunk road'),
  primary: msg('Primary road'),
  secondary: msg('Secondary road'),
  tertiary: msg('Tertiary road'),
  residential: msg('Residential street'),
  living_street: msg('Living street'),
  unclassified: msg('Minor road'),
  unknown: msg('Road'),
  service: msg('Service road'),
  pedestrian: msg('Pedestrian street'),
  footway: msg('Footway'),
  steps: msg('Steps'),
  cycleway: msg('Cycleway'),
  path: msg('Path'),
  track: msg('Track'),
  bridleway: msg('Bridleway'),
});
export const SUBCLASS_WORDS = Object.freeze({
  link: msg('Ramp'),
  sidewalk: msg('Sidewalk'),
  crosswalk: msg('Crosswalk'),
  parking_aisle: msg('Parking aisle'),
  driveway: msg('Driveway'),
  alley: msg('Alley'),
  cycle_crossing: msg('Cycle crossing'),
});
export const SURFACE_WORDS = Object.freeze({
  paved: msg('Paved'),
  paving_stones: msg('Paving stones'),
  metal: msg('Metal'),
  unpaved: msg('Unpaved'),
  gravel: msg('Gravel'),
  dirt: msg('Dirt'),
  unknown: msg('Not mapped'),
});

/** The NETWORK legend's classes. */
const NETWORK_LEGEND = Object.freeze([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'service',
  'cycleway',
  'footway',
  'path',
]);
/** The SPEED legend's stops, with their miles an hour (rounded to 5). */
const SPEED_LEGEND = Object.freeze([30, 50, 70, 90, 110, 130]);

const shadeOf = (ink) => (ink === 'dark' ? 'onLight' : 'onDark');

/** The legend for a mode in the ink drawn ('light' or 'dark'). */
export function legendFor(mode, ink) {
  const shade = shadeOf(ink);
  if (mode === 'speed')
    return [
      ...SPEED_LEGEND.map((kmh, i) => ({
        label:
          (i === SPEED_LEGEND.length - 1 ? '≥ ' : '') +
          t('{kmh} km/h ({mph} mph)', {
            kmh,
            mph: Math.round(kmh / 1.609344 / 5) * 5,
          }),
        color: `#${speedColor(kmh)}`,
      })),
      {
        label: t('No limit mapped'),
        color: `#${UNKNOWN_SPEED_COLOR[shade]}`,
      },
    ];
  if (mode === 'surface')
    return ['paved', 'unpaved', 'unknown'].map((group) => ({
      label: t(SURFACE_WORDS[group]),
      color: `#${SURFACE_COLORS[group][shade]}`,
    }));
  return NETWORK_LEGEND.map((key) => ({
    label: t(CLASS_WORDS[key]),
    color: `#${roadClassByKey(key)[shade]}`,
  }));
}

/** A road's kind in words: its class, or its subclass (a sidewalk, a ramp). */
export function roadKind(segment) {
  const sub = SUBCLASS_WORDS[segment.subclass];
  const kind = t(CLASS_WORDS[segment.class] || CLASS_WORDS.unknown);
  return sub ? `${kind} · ${t(sub)}` : kind;
}

/** The lines of a road's card. */
export function roadCardDetails(segment) {
  const lines = [];
  const kind = [roadKind(segment)];
  if (segment.bridge) kind.push(t('bridge'));
  if (segment.tunnel) kind.push(t('tunnel'));
  if (segment.construction) kind.push(t('under construction'));
  // i18n-ignore: joined words
  lines.push(kind.join(' · '));
  if (segment.speed)
    lines.push(
      t('Speed limit {speed} {unit}', {
        speed: segment.speed,
        unit: segment.speedUnit,
      }),
    );
  if (segment.surface)
    lines.push(
      t('Surface: {surface}', {
        surface: t(SURFACE_WORDS[segment.surface] || SURFACE_WORDS.unknown),
      }),
    );
  if (segment.bicycle === 'designated') lines.push(t('Bicycles: designated'));
  else if (segment.bicycle === 'allowed') lines.push(t('Bicycles: allowed'));
  else if (segment.bicycle === 'denied') lines.push(t('Bicycles: not allowed'));
  lines.push(
    t('Source: Overture Maps · {source}', {
      source: segment.source || 'OpenStreetMap',
    }),
  );
  return lines;
}

/** The card's title: the road's name, else its kind. */
export const roadCardTitle = (segment) => segment.name || roadKind(segment);

/** The status line. */
export function statusText({ status, inRegions = true, enabled = true }) {
  if (!enabled) return '';
  if (!status) return t('Asking the roads server…');
  if (!status.configured)
    return status.failed
      ? t('Roads unavailable')
      : t('Run npm run overture:build -- --roads for the Roads layer');
  const parts = [
    tn(status.segments, '{count} road segment', '{count} road segments', {
      count: formatNumber(status.segments),
    }),
  ];
  if (!inRegions)
    parts.push(t('built for the United States and Europe; none here'));
  else parts.push(t('click a road for its card'));
  return parts.join(' · ');
}

/**
 * @param {{mode: string, onMode: (key: string) => void, ink: string,
 *   onInk: (key: string) => void, inkDrawn: string, status: object|null,
 *   inRegions: boolean, enabled: boolean}} input `ink` the setting
 *   ('auto', 'light', 'dark'); `inkDrawn` the ink in use.
 */
export function rowControls({
  mode,
  onMode,
  ink,
  onInk,
  inkDrawn,
  status,
  inRegions,
  enabled,
}) {
  return {
    chips: [
      ...ROAD_MODES.map((key) => ({
        id: `mode-${key}`,
        label: t(MODE_WORDS[key].chip),
        title: t(MODE_WORDS[key].title),
        active: mode === key,
        onClick: () => onMode(key),
      })),
      ...INK_WORDS.map((chip) => ({
        id: `ink-${chip.key}`,
        label: t(chip.label),
        title: t(chip.title),
        active: ink === chip.key,
        onClick: () => onInk(chip.key),
      })),
    ],
    legend: legendFor(mode, inkDrawn),
    info: statusText({ status, inRegions, enabled }),
  };
}
