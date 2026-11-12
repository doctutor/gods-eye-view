// Personal fork: the treemap navigator's tables (docs/TREEMAP-PLAN.md),
// written by `npm run treemap:build` and read by /api/treemap. Not part of
// upstream God's Eye View.
//
// A table is one variable's facts: rows of keys, one per dimension (a
// grouping id: admin.country, locality.kind, …), with a value and a count.
// A node is the rows under a path of keys, grouped by the next grouping of
// the address; any order of the table's dimensions is a valid address, so
// `/` (nest) and `*` (overlay) are answered the same way, one grouping
// after another.
//
// On disk (JSON): { format, variable, builtAt, signature, exact, note?,
//   attribution, asOf?, dims: [grouping…], keys: [[key…] per dim],
//   labels: [[label…] per dim], geo: [[GeoRef|null…] per dim],
//   rows: [k0, k1, …, value, count, k0, …] } with each k an index into
// its dimension's keys.

export const TABLE_FORMAT = 1;
/** A remainder: the part of a parent its children do not cover. */
export const REST_KEY = '~';
/** The planet's remainder at every level of the area table. */
export const OCEAN_KEY = 'ocean';
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;
/** At depth 2 each child shows at most this many of its own children. */
export const INNER_LIMIT = 50;

export const TABLE_ERRORS = Object.freeze({
  unsupported: '{variable} cannot be cut by {grouping}',
  deep: 'The path has {given} keys; the address has {groupings} groupings, so at most {most}',
  noKey: 'There is no "{key}" in {grouping} here',
});

/**
 * Write a table from rows of key strings.
 * @param {{variable: string, dims: string[], rows: {keys: string[],
 *   value: number, count?: number}[], labels?: Record<string,
 *   Record<string, string>>, geo?: Record<string, Record<string, string>>,
 *   exact?: boolean, note?: string, attribution: string, asOf?: string,
 *   signature?: string, builtAt?: string}} input
 */
export function encodeTable(input) {
  const { dims } = input;
  const keys = dims.map(() => []);
  const indexOf = dims.map(() => new Map());
  const rows = [];
  for (const row of input.rows) {
    if (row.keys.length !== dims.length)
      throw new Error(
        `a row has ${row.keys.length} keys for ${dims.length} dimensions`,
      );
    row.keys.forEach((key, d) => {
      const text = String(key);
      if (text.includes('/')) throw new Error(`a key holds "/": ${text}`);
      let index = indexOf[d].get(text);
      if (index === undefined) {
        index = keys[d].length;
        keys[d].push(text);
        indexOf[d].set(text, index);
      }
      rows.push(index);
    });
    rows.push(Math.round(row.value * 1000) / 1000, row.count ?? 1);
  }
  const perDim = (source) =>
    dims.map((dim, d) => keys[d].map((key) => source?.[dim]?.[key] ?? null));
  return {
    format: TABLE_FORMAT,
    variable: input.variable,
    builtAt: input.builtAt || new Date().toISOString(),
    signature: input.signature || '',
    exact: input.exact !== false,
    ...(input.note ? { note: input.note } : {}),
    attribution: input.attribution,
    ...(input.asOf ? { asOf: input.asOf } : {}),
    dims,
    keys,
    labels: perDim(input.labels).map((labels, d) =>
      labels.map((label, k) => label ?? keys[d][k]),
    ),
    geo: perDim(input.geo),
    rows,
  };
}

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (all, key) =>
    key in values ? String(values[key]) : all,
  );
const failure = (key, values) => ({
  error: fill(TABLE_ERRORS[key], values),
  template: TABLE_ERRORS[key],
  values,
});

/**
 * Open a table as written by encodeTable.
 * @param {ReturnType<typeof encodeTable>} json
 */
export function openTable(json) {
  if (json?.format !== TABLE_FORMAT) throw new Error('not a treemap table');
  const { dims } = json;
  const width = dims.length + 2;
  const rowCount = json.rows.length / width;
  const keyColumns = dims.map(() => new Int32Array(rowCount));
  const values = new Float64Array(rowCount);
  const counts = new Float64Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const base = r * width;
    for (let d = 0; d < dims.length; d++)
      keyColumns[d][r] = json.rows[base + d];
    values[r] = json.rows[base + dims.length];
    counts[r] = json.rows[base + dims.length + 1];
  }
  const keyIndex = dims.map(
    (dim, d) => new Map(json.keys[d].map((key, k) => [key, k])),
  );
  const dimIndex = new Map(dims.map((dim, d) => [dim, d]));

  /** Group row indices by a dimension: key index → {value, count, rows}. */
  function group(rows, d) {
    const out = new Map();
    const column = keyColumns[d];
    for (const r of rows) {
      const k = column[r];
      let entry = out.get(k);
      if (!entry) out.set(k, (entry = { value: 0, count: 0, rows: [] }));
      entry.value += values[r];
      entry.count += counts[r];
      entry.rows.push(r);
    }
    return out;
  }

  /** Whether a child's rows break down any further by dimension d. */
  function breaksDown(rows, d, ownKey) {
    const column = keyColumns[d];
    for (const r of rows) {
      const key = json.keys[d][column[r]];
      if (key !== REST_KEY && key !== ownKey) return true;
    }
    return false;
  }

  const round = (value) => Math.round(value * 1000) / 1000;

  /** Children of some rows by dims[at], sorted, paged; recursing `depth`. */
  function children(rows, at, dimsOf, depth, limit, offset, total) {
    const d = dimsOf[at];
    const groups = [...group(rows, d)].sort(
      (a, b) => b[1].value - a[1].value || a[0] - b[0],
    );
    const shown = groups.slice(offset, offset + limit);
    const past = groups.slice(offset + limit);
    const next = at + 1 < dimsOf.length ? dimsOf[at + 1] : -1;
    const list = shown.map(([k, entry]) => {
      const key = json.keys[d][k];
      const child = {
        key,
        label: json.labels[d][k],
        value: round(entry.value),
        count: entry.count,
        share: total > 0 ? Math.round((entry.value / total) * 1e6) / 1e6 : 0,
        hasChildren: next >= 0 && breaksDown(entry.rows, next, key),
      };
      const geo = json.geo[d][k];
      if (geo) child.geo = geo;
      if (depth > 1 && child.hasChildren) {
        const inner = children(
          entry.rows,
          at + 1,
          dimsOf,
          depth - 1,
          Math.min(limit, INNER_LIMIT),
          0,
          entry.value,
        );
        child.children = inner.children;
        child.rest = inner.rest;
      }
      return child;
    });
    const rest = past.length
      ? {
          count: past.length,
          value: round(past.reduce((sum, [, entry]) => sum + entry.value, 0)),
        }
      : null;
    return { children: list, rest };
  }

  return {
    variable: json.variable,
    dims,
    rowCount,
    builtAt: json.builtAt,
    signature: json.signature,
    exact: json.exact,
    note: json.note,
    attribution: json.attribution,
    asOf: json.asOf,
    has: (grouping) => dimIndex.has(grouping),
    label(grouping, key) {
      const d = dimIndex.get(grouping);
      const k = d === undefined ? undefined : keyIndex[d].get(key);
      return k === undefined ? null : json.labels[d][k];
    },

    /**
     * The node under `path` (keys of the address's first groupings).
     * @param {{groupings: string[], path?: string[], depth?: number,
     *   limit?: number, offset?: number}} query
     * @returns {{path, total, level, children, rest} | {error, template,
     *   values}}
     */
    node({
      groupings,
      path = [],
      depth = 1,
      limit = DEFAULT_LIMIT,
      offset = 0,
    }) {
      const dimsOf = [];
      for (const grouping of groupings) {
        const d = dimIndex.get(grouping);
        if (d === undefined)
          return failure('unsupported', { variable: json.variable, grouping });
        dimsOf.push(d);
      }
      if (path.length >= groupings.length)
        return failure('deep', {
          given: path.length,
          groupings: groupings.length,
          most: groupings.length - 1,
        });
      const wanted = [];
      for (let i = 0; i < path.length; i++) {
        const k = keyIndex[dimsOf[i]].get(path[i]);
        if (k === undefined)
          return failure('noKey', { key: path[i], grouping: groupings[i] });
        wanted.push(k);
      }
      const rows = [];
      let value = 0;
      let count = 0;
      for (let r = 0; r < rowCount; r++) {
        let keep = true;
        for (let i = 0; i < wanted.length && keep; i++)
          keep = keyColumns[dimsOf[i]][r] === wanted[i];
        if (!keep) continue;
        rows.push(r);
        value += values[r];
        count += counts[r];
      }
      if (path.length && !rows.length)
        return failure('noKey', {
          key: path[path.length - 1],
          grouping: groupings[path.length - 1],
        });
      const at = path.length;
      const { children: list, rest } = children(
        rows,
        at,
        dimsOf,
        Math.max(1, Math.min(2, depth)),
        Math.max(1, Math.min(MAX_LIMIT, limit)),
        Math.max(0, offset),
        value,
      );
      return {
        path: path.map((key, i) => ({
          key,
          label: json.labels[dimsOf[i]][wanted[i]],
          grouping: groupings[i],
        })),
        total: { value: round(value), count },
        level: { grouping: groupings[at] },
        children: list,
        rest,
      };
    },
  };
}
