/**
 * Personal fork: the treemap navigator's sources (docs/TREEMAP-PLAN.md).
 * One interface, two implementations:
 *
 *   source.catalog()                         → the contract's /catalog
 *   source.node({address, path, depth, limit, offset}) → its /node
 *   source.geo(ref)                          → GeoJSON for the globe, or null
 *
 * - createServiceSource: the server's /api/treemap tables.
 * - createRecordSource: records already in the page (live aircraft and
 *   vessels, or a sample), aggregated here to the same node shape, cut by
 *   the address's groupings in whatever order they are written.
 *
 * Pure but for the injected fetch; no i18n (the window translates).
 */
import { formatTreemapAddress, parseTreemapAddress } from './treemapAddress.js';

export const TREEMAP_SCHEMA = 'treemap/1';
export const TREEMAP_ROUTE = '/api/treemap';
/** The contract's default page of children. */
export const DEFAULT_LIMIT = 200;

/** A source error with the reason the service (or the source) gave. */
export class TreemapError extends Error {
  constructor(message, { status = 0, code = 'failed' } = {}) {
    super(message);
    this.name = 'TreemapError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The server's tables (GET only, same-site).
 * @param {{fetchImpl?: typeof fetch, base?: string}} [options]
 */
export function createServiceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = TREEMAP_ROUTE,
} = {}) {
  async function get(path, params = {}, { signal } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null && value !== '')
        query.set(key, String(value));
    const url = `${base}/${path}${query.size ? `?${query}` : ''}`;
    let response;
    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new TreemapError(error?.message || 'network', { code: 'network' });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new TreemapError(
        body?.error || body?.reason || `treemap ${response.status}`,
        {
          status: response.status,
          code:
            response.status === 404
              ? 'absent'
              : response.status === 400
                ? 'refused'
                : 'failed',
        },
      );
    return body;
  }
  return {
    id: 'service',
    catalog: (options) => get('catalog', {}, options),
    node: ({ address, path = [], depth = 2, limit, offset } = {}, options) =>
      get(
        'node',
        {
          address,
          // Raw keys joined by `/`: the query string encodes them once, and
          // the service splits the decoded value on `/`.
          path: path.map(String).join('/'),
          depth,
          limit,
          offset,
        },
        options,
      ),
    geo: (ref, options) => (ref ? get('geo', { ref }, options) : null),
  };
}

/** A box GeoJSON polygon from [w, s, e, n]. */
export function boxGeoJson([w, s, e, n]) {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

/** A `box:` or `point:` GeoRef read back ([w, s, e, n]); null for others. */
export function boxOfRef(ref) {
  const text = String(ref || '');
  const box = /^box:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(text);
  if (box) return box.slice(1).map(Number);
  const point = /^point:(-?[\d.]+),(-?[\d.]+)$/.exec(text);
  if (point) {
    const [lon, lat] = point.slice(1).map(Number);
    return [lon, lat, lon, lat];
  }
  return null;
}

const round = (value) => Math.round(value * 1e4) / 1e4;
/** The GeoRef of a box ([w, s, e, n]); a point when it has no extent. */
export const refOfBox = ([w, s, e, n]) =>
  w === e && s === n
    ? `point:${round(w)},${round(s)}`
    : `box:${round(w)},${round(s)},${round(e)},${round(n)}`;

/**
 * Records in the page aggregated to the contract's nodes.
 *
 * Each variable: {id ('count/aircraft'), mode ('additive' | 'relative'),
 * records: () => object[], value?: (record) => number (1: a count),
 * groupings: {[groupingId]: (record) => {key, label}|null} (null: the
 * record is not cut that way, and goes no deeper), box?: (record) =>
 * [w, s, e, n]|null, attribution?, note?, exact?}. `groupings` lists the
 * cuts each variable takes, in the catalogue's order; `groupingInfo`
 * gives each grouping's {family, level, kind, parent?}.
 * @param {{id?: string, variables: object[], groupingInfo?: object}} spec
 */
export function createRecordSource({
  id = 'records',
  variables,
  groupingInfo = {},
}) {
  const byId = new Map(variables.map((variable) => [variable.id, variable]));
  const groupingMeta = (groupingId) => {
    const [family, level] = groupingId.split('.');
    return {
      id: groupingId,
      family,
      level,
      kind: 'hierarchy',
      ...groupingInfo[groupingId],
    };
  };
  return {
    id,
    async catalog() {
      const used = new Set();
      for (const variable of variables)
        for (const groupingId of Object.keys(variable.groupings))
          used.add(groupingId);
      return {
        schema: TREEMAP_SCHEMA,
        variables: variables.map((variable) => ({
          id: variable.id,
          available: variable.available?.() ?? true,
          ...(variable.why ? { why: variable.why() } : {}),
          groupings: Object.keys(variable.groupings),
        })),
        groupings: [...used].map(groupingMeta),
      };
    },
    async node({
      address,
      path = [],
      depth = 2,
      limit = DEFAULT_LIMIT,
      offset = 0,
    } = {}) {
      const parsed = parseTreemapAddress(String(address ?? ''));
      if (!parsed.ok)
        throw new TreemapError('not an address', {
          code: 'refused',
          status: 400,
        });
      const variable = byId.get(parsed.variable);
      if (!variable)
        throw new TreemapError(`no variable ${parsed.variable}`, {
          code: 'refused',
          status: 400,
        });
      // A cut the records do not have ends the address there (the sample has
      // no districts): the levels above it still draw, and the answer says
      // where it stopped (`stops`, this source's own field). A first cut it
      // does not have is refused.
      const cuts = [];
      let stops = null;
      for (const id of parsed.groupings) {
        const of = variable.groupings[id];
        if (!of) {
          if (!cuts.length)
            throw new TreemapError(`${parsed.variable} is not cut by ${id}`, {
              code: 'refused',
              status: 400,
            });
          stops = id;
          break;
        }
        cuts.push({ id, of });
      }
      if (path.length > cuts.length)
        throw new TreemapError('the path is deeper than the address', {
          code: 'refused',
          status: 400,
        });
      const valueOf = variable.value || (() => 1);
      const relative = variable.mode === 'relative';
      // The records under the path, and the path's labels.
      let records = variable.records() || [];
      const pathOut = [];
      for (let level = 0; level < path.length; level++) {
        const cut = cuts[level];
        let label = null;
        records = records.filter((record) => {
          const member = cut.of(record);
          if (!member || String(member.key) !== String(path[level]))
            return false;
          label ??= member.label;
          return true;
        });
        pathOut.push({
          key: path[level],
          label: label ?? path[level],
          grouping: cut.id,
        });
      }
      const sum = (list) => {
        let value = 0;
        let count = 0;
        for (const record of list) {
          const v = Number(valueOf(record));
          if (!Number.isFinite(v)) continue;
          value += v;
          count += 1;
        }
        return { value: relative && count ? value / count : value, count };
      };
      const boxOfList = (list) => {
        if (!variable.box) return null;
        let w = Infinity;
        let s = Infinity;
        let e = -Infinity;
        let n = -Infinity;
        for (const record of list) {
          const box = variable.box(record);
          if (!box) continue;
          w = Math.min(w, box[0]);
          s = Math.min(s, box[1]);
          e = Math.max(e, box[2]);
          n = Math.max(n, box[3]);
        }
        return Number.isFinite(w) ? [w, s, e, n] : null;
      };
      /** The children of `list` cut by `cut`, sorted, paged. */
      const childrenOf = (list, level, take, skip) => {
        const cut = cuts[level];
        if (!cut) return { children: [], rest: null };
        const groups = new Map();
        for (const record of list) {
          const member = cut.of(record);
          if (!member) continue;
          const key = String(member.key);
          let group = groups.get(key);
          if (!group)
            groups.set(
              key,
              (group = { key, label: member.label ?? key, records: [] }),
            );
          group.records.push(record);
        }
        const all = [...groups.values()].map((group) => {
          const { value, count } = sum(group.records);
          const next = cuts[level + 1];
          return {
            group,
            key: group.key,
            label: group.label,
            value,
            count,
            hasChildren:
              Boolean(next) && group.records.some((record) => next.of(record)),
          };
        });
        all.sort(
          (a, b) =>
            b.value - a.value || String(a.label).localeCompare(String(b.label)),
        );
        const page = all.slice(skip, skip + take);
        const after = all.slice(skip + take);
        const rest = after.length
          ? {
              count: after.length,
              value: relative
                ? null
                : after.reduce((total, child) => total + child.value, 0),
            }
          : null;
        return { page, rest, all };
      };
      const total = sum(records);
      const top = childrenOf(records, path.length, limit, offset);
      const share = (value, of) => (!relative && of > 0 ? value / of : null);
      const children = (top.page || []).map((child) => {
        const out = {
          key: child.key,
          label: child.label,
          value: child.value,
          count: child.count,
          share: share(child.value, total.value),
          hasChildren: child.hasChildren,
        };
        const box = boxOfList(child.group.records);
        if (box) out.geo = refOfBox(box);
        if (depth >= 2 && child.hasChildren) {
          const inner = childrenOf(
            child.group.records,
            path.length + 1,
            limit,
            0,
          );
          out.children = inner.page.map((grand) => {
            const g = {
              key: grand.key,
              label: grand.label,
              value: grand.value,
              count: grand.count,
              share: share(grand.value, child.value),
              hasChildren: grand.hasChildren,
            };
            const gBox = boxOfList(grand.group.records);
            if (gBox) g.geo = refOfBox(gBox);
            return g;
          });
          out.rest = inner.rest;
        }
        return out;
      });
      const levelCut = cuts[path.length];
      return {
        schema: TREEMAP_SCHEMA,
        address: formatTreemapAddress(parsed),
        mode: variable.mode || 'additive',
        unit: parsed.unit,
        path: pathOut,
        total,
        level: levelCut ? { grouping: levelCut.id } : null,
        children,
        rest: top.rest,
        exact: variable.exact ?? true,
        ...(variable.note ? { note: variable.note } : {}),
        ...(stops ? { stops } : {}),
        attribution: variable.attribution || '',
      };
    },
    async geo(ref) {
      const box = boxOfRef(ref);
      return box ? boxGeoJson(box) : null;
    },
  };
}

/**
 * The window's source: the service while it answers its catalogue, else
 * `fallback` (the page-local sample), saying which (`kind()`): 'service',
 * 'fallback' or null before the first catalogue. Variables the fallback
 * (or `local`, the live layers) serves are answered there whatever the
 * service says: a live layer's records are in the page, not the tables.
 */
export function createWindowSource({ service, fallback, local = null }) {
  let using = null;
  // The service's (or the sample's) catalogue, asked once: the window asks
  // for the catalogue every load, and only the live layers' part changes.
  let kept = null;
  const localIds = new Set();
  const pick = (address) => {
    const variable = parseTreemapAddress(String(address ?? '')).variable;
    if (local && localIds.has(variable)) return local;
    return using === 'service' ? service : fallback;
  };
  return {
    id: 'window',
    kind: () => using,
    async catalog(options) {
      let base = kept;
      if (!base) {
        try {
          base = await service.catalog(options);
          using = 'service';
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          base = await fallback.catalog(options);
          using = 'fallback';
        }
        kept = base;
      }
      if (!local) return base;
      const extra = await local.catalog(options);
      localIds.clear();
      for (const variable of extra.variables) localIds.add(variable.id);
      const known = new Set(base.groupings.map((grouping) => grouping.id));
      return {
        ...base,
        variables: [
          ...base.variables.filter((variable) => !localIds.has(variable.id)),
          ...extra.variables,
        ],
        groupings: [
          ...base.groupings,
          ...extra.groupings.filter((grouping) => !known.has(grouping.id)),
        ],
      };
    },
    node: (request, options) => pick(request.address).node(request, options),
    geo: (ref, options) =>
      (using === 'service' && !boxOfRef(ref) ? service : fallback).geo(
        ref,
        options,
      ),
  };
}
