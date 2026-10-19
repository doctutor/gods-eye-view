import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { OSM_MAX_HEIGHT_M } from './places.js';

/**
 * Personal fork: what the Localities layer says in words: a place's kind
 * and population on its card, and the row in the DATA LAYERS panel
 * (REFERENCE): a DOTS chip, the sources drawn at this height and the state
 * of the OpenStreetMap places below OSM_MAX_HEIGHT_M.
 */

const KINDS = Object.freeze({
  city: msg('City'),
  town: msg('Town'),
  village: msg('Village'),
  hamlet: msg('Hamlet'),
  suburb: msg('Suburb'),
  neighbourhood: msg('Neighbourhood'),
});

/** A place's kind in words: OpenStreetMap's place tag, or Natural Earth's capital class. */
export function placeKind(place) {
  if (place?.kind) return KINDS[place.kind] ? t(KINDS[place.kind]) : null;
  if (place?.cap === 'country') return t('National capital');
  if (place?.cap === 'region') return t('Regional capital');
  return t('Populated place');
}

/** The lines of a place's card: kind (and country), population, source. */
export function placeCardDetails(place, countries = []) {
  const lines = [];
  const kind = placeKind(place);
  const country = Number.isInteger(place?.c) ? countries[place.c] : null;
  if (kind && country) lines.push(t('{kind} · {country}', { kind, country }));
  else if (kind) lines.push(kind);
  if (place?.pop)
    lines.push(
      t('Population {count}', { count: formatNumber(Number(place.pop)) }),
    );
  if (place?.local && place.local !== place.name)
    lines.push(t('Local name: {name}', { name: place.local }));
  // i18n-ignore: data source names
  lines.push(place?.kind ? 'OpenStreetMap' : 'Natural Earth');
  return lines;
}

/** What the row says about OpenStreetMap's places. */
export function osmStatusText(osm) {
  switch (osm?.state) {
    case 'above':
      return t('OpenStreetMap places below {height} km', {
        height: Math.round(OSM_MAX_HEIGHT_M / 1000),
      });
    case 'loading':
      return t('Asking OpenStreetMap…');
    case 'unconfigured':
      return t(
        'OpenStreetMap places need OVERPASS_UPSTREAMS in .env (Natural Earth places only)',
      );
    case 'limited':
      return t('OpenStreetMap is busy; trying again shortly');
    case 'failed':
      return t('OpenStreetMap places unavailable');
    case 'ready':
      return osm.saturated
        ? t('{count}+ OpenStreetMap places', { count: osm.count })
        : tn(
            osm.count,
            '{count} OpenStreetMap place',
            '{count} OpenStreetMap places',
          );
    default:
      return '';
  }
}

/**
 * @param {{dots: boolean, onDots: (on: boolean) => void, enabled: boolean,
 *   naturalEarth: number, osm: object|null}} input - `naturalEarth`: the
 *   Natural Earth places named now; `osm`: the OpenStreetMap state.
 */
export function rowControls({ dots, onDots, enabled, naturalEarth, osm }) {
  const parts = [];
  if (enabled) {
    parts.push(
      tn(
        naturalEarth,
        '{count} Natural Earth place',
        '{count} Natural Earth places',
      ),
    );
    const status = osmStatusText(osm);
    if (status) parts.push(status);
  }
  return {
    chips: [
      {
        id: 'dots',
        label: t('DOTS'),
        active: dots,
        title: t('A dot at each named place'),
        onClick: () => onDots(!dots),
      },
    ],
    info: parts.join(' · '),
  };
}
