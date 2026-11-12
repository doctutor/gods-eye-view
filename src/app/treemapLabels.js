/**
 * Personal fork: where the live layers' points are, for the TREEMAP
 * window's admin cuts of live variables ("Countries, then classes"). The
 * service's POST /api/treemap/label answers each point's country, region
 * and district keys (the tables' keys; null at sea); this keeps each
 * aircraft's or vessel's answer for a while, so a refresh posts only the
 * points it has not labelled lately or that have moved far. Names: countries
 * by the browser's own region names (in the page's language), continents
 * from the shared table, regions from the service's area table, asked once
 * per country and only when the window is inside that country.
 */
import { getLocale, msg } from '../i18n/index.js';
import { LABEL_BATCH } from '../data/treemapSources.js';
import { TREEMAP_LABELS } from '../data/treemapCatalog.js';
import {
  continentOfCountry,
  treemapContinent,
} from '../data/treemapContinents.js';

/** A point's label is asked again after this long (ms)… */
export const LABEL_TTL_MS = 3 * 60_000;
/** …or once it has moved this far (degrees, either way). */
export const LABEL_MOVE_DEG = 0.5;
/** At most this many points are remembered. */
const LABEL_CACHE_MAX = 60_000;

/** The tile of points the service could not place (it did not answer). */
export const UNPLACED = Object.freeze({
  key: 'unplaced',
  label: msg('Not placed yet'),
});
/** The service's own sea tile (its key at every admin level). */
export const AT_SEA = Object.freeze({
  key: 'ocean',
  label: TREEMAP_LABELS.ocean,
});
/** A country's part no region covers (the service's `~`). */
export const NO_REGION = Object.freeze({
  key: '~',
  label: TREEMAP_LABELS.noRegion,
});

/**
 * @param {{service: {label: (points: number[][]) => Promise<{units:
 *   object[]}>}, now?: () => number}} options
 */
export function createPointLabeller({ service, now = () => Date.now() }) {
  const cache = new Map(); // id → {unit, at, lon, lat}
  let failed = null;
  return {
    /** Why the last ask failed (null: it did not). */
    failed: () => failed,
    /**
     * The labels of `points` ({id, lon, lat}), asking for those not known
     * lately; resolves when the cache holds what the service answered.
     */
    async label(points) {
      const time = now();
      const ask = points.filter((point) => {
        if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat))
          return false;
        const known = cache.get(point.id);
        return (
          !known ||
          time - known.at > LABEL_TTL_MS ||
          Math.abs(known.lon - point.lon) > LABEL_MOVE_DEG ||
          Math.abs(known.lat - point.lat) > LABEL_MOVE_DEG
        );
      });
      for (let from = 0; from < ask.length; from += LABEL_BATCH) {
        const batch = ask.slice(from, from + LABEL_BATCH);
        try {
          const answer = await service.label(
            batch.map((point) => [point.lon, point.lat]),
          );
          const units = answer?.units || [];
          batch.forEach((point, index) =>
            cache.set(point.id, {
              unit: units[index] ?? null,
              at: time,
              lon: point.lon,
              lat: point.lat,
            }),
          );
          failed = null;
        } catch (error) {
          failed = error;
          break;
        }
      }
      while (cache.size > LABEL_CACHE_MAX)
        cache.delete(cache.keys().next().value);
      return ask.length;
    },
    /** A point's unit: {country, region, district}, null at sea, or
     * undefined while unknown. */
    unitOf(id) {
      const known = cache.get(id);
      return known ? known.unit : undefined;
    },
    size: () => cache.size,
  };
}

/** A country's name in the page's language, else its code. */
export function countryName(code, locale = getLocale()) {
  try {
    const names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    return names.of(String(code).toUpperCase()) || String(code);
  } catch {
    return String(code);
  }
}

/**
 * Region names from the service's area table, a country at a time.
 * @param {{service: {node: Function}}} options
 */
export function createAdminNames({ service }) {
  const regions = new Map(); // region key → name
  const asked = new Map(); // country → Promise
  return {
    /** Fetch the names of `country`'s regions once. */
    loadCountry(country) {
      if (!country || asked.has(country)) return asked.get(country);
      const continent = continentOfCountry(country);
      const done = continent
        ? service
            .node({
              address:
                'm2/surface-area://admin.continent/admin.country/admin.region',
              path: [continent, country],
              depth: 1,
              limit: 1000,
            })
            .then((node) => {
              for (const child of node?.children || [])
                if (child.key && child.label)
                  regions.set(String(child.key), child.label);
            })
            .catch(() => undefined)
        : Promise.resolve();
      asked.set(country, done);
      return done;
    },
    region: (key) => regions.get(String(key)) || null,
  };
}

/**
 * The admin cuts of a live variable, reading the labeller's answers:
 * {'admin.continent', 'admin.country', 'admin.region'} → (record) =>
 * {key, label}|null. `idOf` names a record in the labeller.
 */
export function adminGroupings({ labeller, names, idOf }) {
  const unit = (record) => labeller.unitOf(idOf(record));
  return {
    'admin.continent': (record) => {
      const known = unit(record);
      if (known === undefined) return UNPLACED;
      if (!known?.country) return AT_SEA;
      const id = continentOfCountry(known.country);
      const continent = id ? treemapContinent(id) : null;
      return continent
        ? { key: continent.id, label: continent.label }
        : { key: 'unknown', label: msg('Continent not known') };
    },
    'admin.country': (record) => {
      const known = unit(record);
      if (known === undefined) return UNPLACED;
      if (!known?.country) return AT_SEA;
      return { key: known.country, label: countryName(known.country) };
    },
    'admin.region': (record) => {
      const known = unit(record);
      if (!known?.country) return null;
      if (!known.region) return NO_REGION;
      return {
        key: known.region,
        label: names.region(known.region) || known.region,
      };
    },
  };
}

/**
 * Before a live variable is cut: label its points when the address has an
 * admin cut, and fetch region names for the countries the path is inside.
 */
export function adminPrepare({ labeller, names, idOf, pointOf }) {
  return async ({ records, groupings, path }) => {
    if (!groupings.some((id) => id.startsWith('admin.'))) return;
    await labeller.label(
      records.map((record) => ({ id: idOf(record), ...pointOf(record) })),
    );
    const country = groupings.indexOf('admin.country');
    if (
      groupings.includes('admin.region') &&
      country >= 0 &&
      path.length > country
    )
      await names.loadCountry(path[country]);
  };
}
