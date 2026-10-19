import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { PLACE_CONFIDENCE_CHOICES } from '../../data/overturePlaces.js';
import {
  CATEGORY_COLORS,
  CATEGORY_KEYS,
  PLACE_PINS_BELOW_M,
  basicLabel,
} from './places.js';

/**
 * Personal fork: what the Places layer says in words: its chips (a
 * category at a time, ALL by default; a confidence floor), the legend, the
 * row's status and a place's card.
 */

export const CATEGORY_WORDS = Object.freeze({
  all: Object.freeze({
    chip: msg('ALL'),
    title: msg('Every place, whatever its kind'),
  }),
  food: Object.freeze({
    chip: msg('FOOD & DRINK'),
    title: msg('Restaurants, cafés, bars'),
  }),
  shopping: Object.freeze({
    chip: msg('SHOPPING'),
    title: msg('Shops and markets'),
  }),
  health: Object.freeze({
    chip: msg('HEALTH'),
    title: msg('Hospitals, clinics, pharmacies, doctors'),
  }),
  education: Object.freeze({
    chip: msg('EDUCATION'),
    title: msg('Schools, colleges, universities'),
  }),
  transport: Object.freeze({
    chip: msg('TRANSPORT'),
    title: msg('Stations, airports, fuel, parking, travel'),
  }),
  lodging: Object.freeze({
    chip: msg('ACCOMMODATION'),
    title: msg('Hotels and other lodging'),
  }),
  public: Object.freeze({
    chip: msg('PUBLIC SERVICES'),
    title: msg('Government offices and community services'),
  }),
  religion: Object.freeze({
    chip: msg('RELIGION'),
    title: msg('Places of worship and religious organizations'),
  }),
  recreation: Object.freeze({
    chip: msg('ARTS & RECREATION'),
    title: msg('Arts, entertainment, sport, culture and heritage'),
  }),
  charging: Object.freeze({
    chip: msg('EV CHARGING'),
    title: msg('Electric vehicle charging stations'),
  }),
});
/** The category of a place on its card (OTHER has no chip). */
const CATEGORY_NAMES = Object.freeze({
  food: msg('Food & drink'),
  shopping: msg('Shopping'),
  health: msg('Health'),
  education: msg('Education'),
  transport: msg('Transport'),
  lodging: msg('Accommodation'),
  public: msg('Public services'),
  religion: msg('Religion'),
  recreation: msg('Arts & recreation'),
  charging: msg('EV charging'),
  other: msg('Services and other places'),
});

/** The lines of a place's card. */
export function placeCardDetails(place) {
  const lines = [];
  const kind = basicLabel(place.basic);
  const category = t(CATEGORY_NAMES[place.category] || CATEGORY_NAMES.other);
  // i18n-ignore: Overture's own category name
  lines.push(kind ? `${category} · ${kind}` : category);
  if (place.brand && place.brand !== place.name)
    lines.push(t('Brand: {brand}', { brand: place.brand }));
  if (place.website) lines.push(place.website);
  if (place.phone) lines.push(place.phone);
  lines.push(
    t('Overture Maps · {source} · confidence {percent}%', {
      source: place.source || '?',
      percent: Math.round(place.confidence * 100),
    }),
  );
  return lines;
}

/** The status line. */
export function statusText(status) {
  if (!status) return '';
  switch (status.state) {
    case 'unconfigured':
      return t('Run npm run overture:build -- --places for the Places layer');
    case 'loading':
      return t('Reading the Overture places…');
    case 'failed':
      return t('Places unavailable');
    case 'ready':
      break;
    default:
      return '';
  }
  if (status.mode === 'counts')
    return [
      tn(status.count, '{count} place in view', '{count} places in view', {
        count: formatNumber(status.count),
      }),
      t('Counts per hexagon; pins below {height} km', {
        height: Math.round(PLACE_PINS_BELOW_M / 1000),
      }),
    ].join(' · ');
  const parts = [
    tn(status.count, '{count} place', '{count} places', {
      count: formatNumber(status.count),
    }),
  ];
  if (status.saturated) parts.push(t('the most confident; zoom in for more'));
  return parts.join(' · ');
}

/**
 * @param {{category: string, onCategory: (key: string) => void,
 *   minConfidence: number, onConfidence: (value: number) => void,
 *   status: object|null, enabled: boolean, total?: number}} input
 */
export function rowControls({
  category,
  onCategory,
  minConfidence,
  onConfidence,
  status,
  enabled,
}) {
  return {
    chips: [
      ...CATEGORY_KEYS.map((key) => ({
        id: `category-${key}`,
        label: t(CATEGORY_WORDS[key].chip),
        title: t(CATEGORY_WORDS[key].title),
        active: category === key,
        onClick: () => onCategory(key),
      })),
      ...PLACE_CONFIDENCE_CHOICES.map((value) => ({
        id: `confidence-${Math.round(value * 100)}`,
        label: t('≥{percent}%', { percent: Math.round(value * 100) }),
        title: t('Places Overture is at least {percent}% sure of', {
          percent: Math.round(value * 100),
        }),
        active: minConfidence === value,
        onClick: () => onConfidence(value),
      })),
    ],
    legend: [
      {
        label: t(CATEGORY_WORDS[category]?.chip || CATEGORY_WORDS.all.chip),
        color: CATEGORY_COLORS[category] || CATEGORY_COLORS.all,
      },
    ],
    info: enabled ? statusText(status) : '',
  };
}

/** A count in the page's language (the rollup's labels are its own). */
export const countText = (count) => formatNumber(count);
