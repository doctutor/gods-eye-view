import { formatNumber, getLocale, msg, t, tn } from '../../i18n/index.js';
import { OSM_MAX_HEIGHT_M } from './places.js';

/**
 * Personal fork: what the Localities layer says in words: a place's kind
 * and population on its card, and the row in the DATA LAYERS panel
 * (REFERENCE): a DOTS chip, the sources drawn at this height and the state
 * of the close-in places below OSM_MAX_HEIGHT_M (Overture's index, or
 * OpenStreetMap through Overpass without it).
 */

const KINDS = Object.freeze({
  city: msg('City'),
  town: msg('Town'),
  village: msg('Village'),
  hamlet: msg('Hamlet'),
  suburb: msg('Suburb'),
  neighbourhood: msg('Neighbourhood'),
  // Overture's subtypes and locality classes.
  locality: msg('Locality'),
  localadmin: msg('Municipality'),
  county: msg('County'),
  macrohood: msg('District'),
  neighborhood: msg('Neighbourhood'),
  microhood: msg('Small neighbourhood'),
});

/** A country's name from its ISO 3166-1 code, in the page's language. */
export function countryName(code, locale = getLocale()) {
  if (!/^[A-Z]{2}$/.test(String(code || ''))) return null;
  try {
    return (
      new Intl.DisplayNames([String(locale || 'en')], { type: 'region' }).of(
        code,
      ) || code
    );
  } catch {
    return code;
  }
}

/** A place's kind in words: OpenStreetMap's place tag, Overture's kind, or Natural Earth's capital class. */
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
  const country = Number.isInteger(place?.c)
    ? countries[place.c]
    : countryName(place?.country);
  if (kind && country) lines.push(t('{kind} · {country}', { kind, country }));
  else if (kind) lines.push(kind);
  if (place?.pop)
    lines.push(
      t('Population {count}', { count: formatNumber(Number(place.pop)) }),
    );
  if (place?.local && place.local !== place.name)
    lines.push(t('Local name: {name}', { name: place.local }));
  if (place?.source === 'overture') {
    lines.push(
      place.wikidata
        ? t('Overture Maps · Wikidata {id}', { id: place.wikidata })
        : // i18n-ignore: data source name
          'Overture Maps',
    );
    return lines;
  }
  // i18n-ignore: data source names
  lines.push(place?.kind ? 'OpenStreetMap' : 'Natural Earth');
  return lines;
}

/** What the row says about Overture's places. */
export function overtureStatusText(overture) {
  switch (overture?.state) {
    case 'above':
      return t('Overture places below {height} km', {
        height: Math.round(OSM_MAX_HEIGHT_M / 1000),
      });
    case 'loading':
      return t('Reading the Overture index…');
    case 'failed':
      return t('Overture places unavailable');
    case 'ready':
      return overture.saturated
        ? t('{count}+ Overture places', { count: overture.count })
        : tn(
            overture.count,
            '{count} Overture place',
            '{count} Overture places',
          );
    default:
      return '';
  }
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
 *   naturalEarth: number, osm: object|null, overture?: object|null}} input -
 *   `naturalEarth`: the Natural Earth places named now; `osm`: the
 *   OpenStreetMap state; `overture`: the Overture state, when its index is
 *   built (it speaks for the close-in places then).
 */
export function rowControls({
  dots,
  onDots,
  enabled,
  naturalEarth,
  osm,
  overture = null,
}) {
  const parts = [];
  if (enabled) {
    parts.push(
      tn(
        naturalEarth,
        '{count} Natural Earth place',
        '{count} Natural Earth places',
      ),
    );
    const status = overture ? overtureStatusText(overture) : osmStatusText(osm);
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
