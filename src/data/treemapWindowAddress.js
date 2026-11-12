/**
 * Personal fork: the treemap navigator's address as the TREEMAP window
 * holds it, read and written by the shared parser (treemapAddress.js, the
 * service's too):
 *
 *   <unit>/<variable>://<grouping>[/<grouping> | *<grouping>]…
 *   m2/surface-area://admin.continent/admin.country/admin.region
 *
 * The window keeps each grouping with the join before it ({id, family,
 * level, join}), which is what its pills are. A path is the keys from the
 * root to a node; in the share link and the service's query it is the keys,
 * each URI-encoded, joined by `/`.
 */
import {
  formatTreemapAddress,
  parseTreemapAddress,
  treemapGroupingParts,
} from './treemapAddress.js';

/**
 * Parse an address; null when it is not one (the shared parser's reason is
 * then `parseAddressError(text)`).
 * @returns {{variable: string, unit: string, name: string,
 *   groupings: {id: string, family: string, level: string,
 *   join: '/'|'*'|null}[]}|null}
 */
export function parseAddress(text) {
  const parsed = parseTreemapAddress(String(text ?? ''));
  if (!parsed.ok) return null;
  return {
    variable: parsed.variable,
    unit: parsed.unit,
    name: parsed.name,
    groupings: parsed.groupings.map((id, index) => ({
      id,
      ...treemapGroupingParts(id),
      join: index === 0 ? null : parsed.joins[index - 1],
    })),
  };
}

/** Why an address does not read: {error, values} for t(), or null. */
export function parseAddressError(text) {
  const parsed = parseTreemapAddress(String(text ?? ''));
  return parsed.ok ? null : { error: parsed.error, values: parsed.values };
}

/**
 * An address from a variable id and its groupings ({id, join}); null when
 * they would not read back (no grouping, one twice).
 */
export function formatAddress(variable, groupings = []) {
  try {
    return formatTreemapAddress({
      variable,
      groupings: groupings.map((grouping) => grouping.id),
      joins: groupings.slice(1).map((grouping) => grouping.join || '/'),
    });
  } catch {
    return null;
  }
}

/** A path's keys as the share link and the service write them. */
export const formatPath = (keys = []) =>
  keys.map((key) => encodeURIComponent(String(key))).join('/');

/** A written path back to its keys ([] for none). */
export function parsePath(text) {
  const value = String(text ?? '');
  if (!value) return [];
  try {
    return value.split('/').map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}
