/**
 * Personal fork: the treemap navigator's address (docs/TREEMAP-PLAN.md),
 * as the window reads and writes it:
 *
 *   <unit>/<variable>://<grouping>[/<grouping> | *<grouping>]…
 *   m2/surface-area://admin.continent/admin.country/admin.region
 *
 * `/` descends a hierarchy stored in the data, `*` overlays a partition
 * (shown as ×). A grouping is `family.level`. The window's own parser,
 * written to the plan's contract until the shared one (worker2's, with
 * src/data/treemapCatalog.js) lands; it then takes this one's place.
 *
 * A path is the keys from the root to a node; in the share link and the
 * service's query it is the keys, each URI-encoded, joined by `/`.
 */

const VARIABLE_PATTERN = /^([a-z0-9]+)\/([a-z0-9][a-z0-9-]*)$/;
const GROUPING_PATTERN = /^([a-z][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)$/;

/**
 * Parse an address; null when it is not one.
 * @returns {{variable: string, unit: string, name: string,
 *   groupings: {id: string, family: string, level: string,
 *   join: '/'|'*'|null}[]}|null}
 */
export function parseAddress(text) {
  const value = String(text ?? '').trim();
  const at = value.indexOf('://');
  if (at <= 0) return null;
  const variable = value.slice(0, at);
  const head = VARIABLE_PATTERN.exec(variable);
  if (!head) return null;
  const tail = value.slice(at + 3);
  const groupings = [];
  if (tail) {
    let join = null;
    let current = '';
    const push = () => {
      const match = GROUPING_PATTERN.exec(current);
      if (!match) return false;
      groupings.push({
        id: current,
        family: match[1],
        level: match[2],
        join,
      });
      current = '';
      return true;
    };
    for (const char of tail) {
      if (char === '/' || char === '*') {
        if (!push()) return null;
        join = char;
      } else current += char;
    }
    if (!push()) return null;
    if (new Set(groupings.map((g) => g.id)).size !== groupings.length)
      return null;
  }
  return { variable, unit: head[1], name: head[2], groupings };
}

/** An address from a variable id and its groupings ({id, join}). */
export function formatAddress(variable, groupings = []) {
  return (
    `${variable}://` +
    groupings
      .map((grouping, index) =>
        index === 0
          ? grouping.id
          : `${grouping.join === '*' ? '*' : '/'}${grouping.id}`,
      )
      .join('')
  );
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
