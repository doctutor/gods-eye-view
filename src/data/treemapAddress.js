// Personal fork: the treemap navigator's address (docs/TREEMAP-PLAN.md),
// shared by its service (/api/treemap) and its window. Not part of
// upstream God's Eye View.
//
//   <unit>/<variable>://<grouping>[/<grouping> | *<grouping>]…
//   m2/surface-area://admin.continent/admin.country/admin.region
//
// Left of `://` the variable: a unit and a name, together the variable's
// id (`m2/surface-area`). Right of it the groupings, each `family.level`,
// joined by `/` (descend a stored hierarchy) or `*` (overlay an independent
// partition; `×` is read as `*`, and the window shows `*` as `×`). This
// module reads and writes the syntax only; whether the variable and its
// groupings exist is the catalogue's (treemapCatalog.js checkTreemapAddress).
import { msg } from '../i18n/index.js';

export const TREEMAP_SCHEMA = 'treemap/1';
/** Between the variable and the groupings. */
export const TREEMAP_SCHEME_SEPARATOR = '://';
/** A grouping's joins: descend a hierarchy, overlay a partition. */
export const TREEMAP_JOINS = Object.freeze(['/', '*']);

const UNIT = /^[a-z0-9]+$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GROUPING = /^[a-z][a-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The address's errors: English templates for t(), with their values. */
export const TREEMAP_ADDRESS_ERRORS = Object.freeze({
  empty: msg('An address is text like m2/surface-area://admin.country'),
  scheme: msg('The address needs "://" between the variable and the groupings'),
  schemeTwice: msg('The address has "://" more than once'),
  variable: msg(
    'The part before "://" needs a unit and a variable, like m2/surface-area',
  ),
  unit: msg(
    'The unit "{unit}" can hold only lower-case letters and digits, like m2',
  ),
  name: msg(
    'The variable "{name}" can hold only lower-case letters, digits and hyphens',
  ),
  noGrouping: msg('The address names no grouping after "://"'),
  emptyGrouping: msg(
    'Grouping {index} is empty: two joins in a row, or one at an end',
  ),
  grouping: msg(
    'The grouping "{grouping}" is not family.level, like admin.country',
  ),
  repeated: msg('The grouping "{grouping}" appears twice'),
});

const failure = (key, values = {}) => ({
  ok: false,
  error: TREEMAP_ADDRESS_ERRORS[key],
  values,
});

/** An error's English text with its values filled in (for logs and 400s). */
export function treemapAddressErrorText({ error, values = {} }) {
  return String(error).replace(/\{(\w+)\}/g, (all, key) =>
    key in values ? String(values[key]) : all,
  );
}

/**
 * Read an address.
 * @param {string} text
 * @returns {{ok: true, variable: string, unit: string, name: string,
 *   groupings: string[], joins: ('/'|'*')[]} | {ok: false, error: string,
 *   values: object}} `joins[i]` joins `groupings[i]` to `groupings[i + 1]`;
 *   `error` is an English template for t(error, values).
 */
export function parseTreemapAddress(text) {
  if (typeof text !== 'string' || !text.trim()) return failure('empty');
  const address = text.trim();
  const at = address.indexOf(TREEMAP_SCHEME_SEPARATOR);
  if (at < 0) return failure('scheme');
  if (address.indexOf(TREEMAP_SCHEME_SEPARATOR, at + 1) >= 0)
    return failure('schemeTwice');
  const left = address.slice(0, at);
  const right = address.slice(at + TREEMAP_SCHEME_SEPARATOR.length);
  const slash = left.indexOf('/');
  if (
    slash <= 0 ||
    slash === left.length - 1 ||
    left.indexOf('/', slash + 1) >= 0
  )
    return failure('variable');
  const unit = left.slice(0, slash);
  const name = left.slice(slash + 1);
  if (!UNIT.test(unit)) return failure('unit', { unit });
  if (!NAME.test(name)) return failure('name', { name });
  if (!right.trim()) return failure('noGrouping');
  const groupings = [];
  const joins = [];
  let current = '';
  const close = () => {
    if (!current)
      return failure('emptyGrouping', { index: groupings.length + 1 });
    if (!GROUPING.test(current))
      return failure('grouping', { grouping: current });
    if (groupings.includes(current))
      return failure('repeated', { grouping: current });
    groupings.push(current);
    current = '';
    return null;
  };
  for (const char of right.replace(/×/g, '*')) {
    if (char === '/' || char === '*') {
      const problem = close();
      if (problem) return problem;
      joins.push(char);
    } else if (!/\s/.test(char)) current += char;
  }
  const problem = close();
  if (problem) return problem;
  return {
    ok: true,
    variable: `${unit}/${name}`,
    unit,
    name,
    groupings,
    joins,
  };
}

/**
 * Write an address. `joins` defaults to `/` throughout.
 * @param {{variable: string, groupings: string[], joins?: string[]}} parts
 * @returns {string}
 * @throws {TypeError} when the parts would not read back
 */
export function formatTreemapAddress({ variable, groupings, joins = [] }) {
  const pieces = (groupings || []).map((grouping, index) =>
    index === 0
      ? grouping
      : `${joins[index - 1] === '*' ? '*' : '/'}${grouping}`,
  );
  const text = `${variable}${TREEMAP_SCHEME_SEPARATOR}${pieces.join('')}`;
  const parsed = parseTreemapAddress(text);
  if (!parsed.ok) throw new TypeError(treemapAddressErrorText(parsed));
  return text;
}

/** A grouping id's family and level: `admin.country` → admin, country. */
export function treemapGroupingParts(id) {
  const dot = String(id).indexOf('.');
  return dot < 0
    ? { family: String(id), level: '' }
    : { family: id.slice(0, dot), level: id.slice(dot + 1) };
}
