// Personal fork: the treemap navigator's service (docs/TREEMAP-PLAN.md,
// "The service"): the catalogue with what is built, a node of any address,
// and the outline of a tile, all from the tables `npm run treemap:build`
// writes. Nothing metered is asked while answering. Not part of upstream
// God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { cellToBoundary, isValidCell } from 'h3-js';
import { decodeAreaRecord } from '../overtureAreas/format.js';
import { mercatorLatitude } from './geodesy.js';
import { openTable } from './table.js';
import {
  NEEDS_TREEMAP_BUILD,
  TREEMAP_MANIFEST,
  overtureAreasDir,
} from './sources.js';
import {
  TREEMAP_SCHEMA,
  formatTreemapAddress,
  treemapAddressErrorText,
} from '../../../src/data/treemapAddress.js';
import {
  TREEMAP_GROUPINGS,
  TREEMAP_VARIABLES,
  checkTreemapAddress,
  treemapGrouping,
} from '../../../src/data/treemapCatalog.js';

const STAT_EVERY_MS = 5000;
/** Tables kept open at once (each a few MB of typed arrays). */
const KEPT_TABLES = 12;
const LIVE_WHY = 'Counted in the window from the live layers';

const bad = (error) => ({ status: 400, body: { error } });

/**
 * @param {{dir: string, sourceRoot?: string, env?: object,
 *   now?: () => number}} options dir: the tables' directory
 */
export function createTreemapService({
  dir,
  sourceRoot = process.cwd(),
  env = process.env,
  now = () => Date.now(),
}) {
  const manifestFile = path.join(dir, TREEMAP_MANIFEST);
  let held = null;
  let checkedAt = -Infinity;
  /** file → opened table, least recently used first. */
  const tables = new Map();
  let outlines = null;

  function manifest() {
    if (now() - checkedAt < STAT_EVERY_MS) return held?.manifest || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(manifestFile);
    } catch {
      held = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.manifest;
    try {
      const value = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      held = { manifest: value, mtimeMs: stat.mtimeMs, size: stat.size };
      outlines = null;
    } catch (error) {
      console.warn('[Treemap] manifest not readable:', error?.message);
      held = null;
    }
    return held?.manifest || null;
  }

  function tableOf(variable) {
    const entry = manifest()?.tables?.[variable];
    if (!entry) return null;
    const known = tables.get(entry.file);
    if (known) {
      tables.delete(entry.file);
      tables.set(entry.file, known);
      return known;
    }
    const table = openTable(
      JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8')),
    );
    tables.set(entry.file, table);
    for (const old of tables.keys()) {
      if (tables.size <= KEPT_TABLES) break;
      tables.delete(old);
    }
    return table;
  }

  function outlineIndex() {
    const entry = manifest()?.files?.outlines;
    if (!entry) return null;
    if (outlines?.file === entry.file) return outlines.value;
    const value = JSON.parse(
      fs.readFileSync(path.join(dir, entry.file), 'utf8'),
    );
    outlines = { file: entry.file, value };
    return value;
  }

  function catalog() {
    const built = manifest()?.tables || {};
    return {
      schema: TREEMAP_SCHEMA,
      variables: TREEMAP_VARIABLES.map((variable) => {
        if (variable.source === 'live')
          return {
            id: variable.id,
            available: true,
            groupings: [...variable.groupings],
          };
        const entry = built[variable.id];
        let table = null;
        try {
          table = entry ? tableOf(variable.id) : null;
        } catch (error) {
          console.warn('[Treemap] table not readable:', error?.message);
        }
        if (!table)
          return {
            id: variable.id,
            available: false,
            why: NEEDS_TREEMAP_BUILD,
            groupings: [...variable.groupings],
          };
        return {
          id: variable.id,
          available: true,
          ...(table.asOf ? { asOf: table.asOf } : {}),
          groupings: variable.groupings.filter((id) => table.has(id)),
        };
      }),
      groupings: TREEMAP_GROUPINGS.map((grouping) => ({
        id: grouping.id,
        family: grouping.family,
        level: grouping.level,
        kind: grouping.kind,
        ...(grouping.parent ? { parent: grouping.parent } : {}),
        ...(grouping.cardinality ? { cardinality: grouping.cardinality } : {}),
      })),
    };
  }

  /**
   * @param {{address: string, path?: string[], depth?: number,
   *   limit?: number, offset?: number}} query
   */
  function node({ address, path: keys = [], depth = 1, limit, offset = 0 }) {
    const checked = checkTreemapAddress(address);
    if (!checked.ok) return bad(treemapAddressErrorText(checked));
    const variable = checked.definition;
    if (variable.source === 'live')
      return bad(`${variable.id}: ${LIVE_WHY.toLowerCase()}`);
    const table = tableOf(variable.id);
    if (!table)
      return bad(`${variable.id} is not built: ${NEEDS_TREEMAP_BUILD}`);
    const answer = table.node({
      groupings: checked.groupings,
      path: keys,
      depth,
      limit,
      offset,
    });
    if (answer.error) return bad(answer.error);
    const grouping = treemapGrouping(answer.level.grouping);
    return {
      status: 200,
      etag: table.signature,
      body: {
        schema: TREEMAP_SCHEMA,
        address: formatTreemapAddress(checked),
        mode: variable.mode,
        unit: variable.unit,
        path: answer.path,
        total: answer.total,
        level: { grouping: grouping.id, label: grouping.label },
        children: answer.children,
        rest: answer.rest,
        exact: table.exact,
        ...(table.note ? { note: table.note } : {}),
        attribution: table.attribution,
      },
    };
  }

  /** A GeoRef's GeoJSON Feature. */
  function geo(ref) {
    const text = String(ref || '');
    const colon = text.indexOf(':');
    const kind = colon > 0 ? text.slice(0, colon) : '';
    const rest = text.slice(colon + 1);
    const feature = (geometry) => ({
      status: 200,
      body: { type: 'Feature', properties: { ref: text }, geometry },
    });
    if (kind === 'point') {
      const [lon, lat] = rest.split(',').map(Number);
      if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90))
        return bad('A point is point:lon,lat');
      return feature({ type: 'Point', coordinates: [lon, lat] });
    }
    if (kind === 'box') {
      const [w, s, e, n] = rest.split(',').map(Number);
      if (
        !(Math.abs(w) <= 180 && Math.abs(e) <= 180) ||
        !(Math.abs(s) <= 90 && Math.abs(n) <= 90) ||
        !(s < n)
      )
        return bad('A box is box:w,s,e,n in degrees, south below north');
      const ring = (a, b) => [
        [
          [a, s],
          [b, s],
          [b, n],
          [a, n],
          [a, s],
        ],
      ];
      return feature(
        w < e
          ? { type: 'Polygon', coordinates: ring(w, e) }
          : {
              type: 'MultiPolygon',
              coordinates: [ring(w, 180), ring(-180, e)],
            },
      );
    }
    if (kind === 'h3') {
      if (!isValidCell(rest)) return bad('An H3 cell is h3:<cell index>');
      const boundary = cellToBoundary(rest, true);
      return feature({ type: 'Polygon', coordinates: [boundary] });
    }
    if (kind === 'area') {
      const index = outlineIndex();
      if (!index) return { status: 503, body: { error: NEEDS_TREEMAP_BUILD } };
      const entry = index.units[rest];
      if (!entry) return { status: 404, body: { error: 'No such area' } };
      const [level, offset, length] = entry;
      const scale = 2 ** index.quantBits[level];
      const bytes = Buffer.alloc(length);
      let fd;
      try {
        fd = fs.openSync(
          path.join(overtureAreasDir(env, sourceRoot), index.file),
          'r',
        );
        fs.readSync(fd, bytes, 0, length, offset);
      } catch {
        return {
          status: 503,
          body: {
            error: `The Overture areas build changed: ${NEEDS_TREEMAP_BUILD}`,
          },
        };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      const digits = level === 0 ? 3 : level === 1 ? 4 : 5;
      const round = (value) => Number(value.toFixed(digits));
      const coordinates = decodeAreaRecord(bytes).map((rings) =>
        rings.map((ring) => {
          const out = [];
          for (let i = 0; i < ring.length; i += 2)
            out.push([
              round((ring[i] / scale) * 360 - 180),
              round((mercatorLatitude(ring[i + 1] / scale) * 180) / Math.PI),
            ]);
          const [first, last] = [out[0], out[out.length - 1]];
          if (first && (first[0] !== last[0] || first[1] !== last[1]))
            out.push(first);
          return out;
        }),
      );
      return feature({ type: 'MultiPolygon', coordinates });
    }
    return bad(
      'A GeoRef is area:<id>, h3:<cell>, box:w,s,e,n or point:lon,lat',
    );
  }

  return {
    catalog,
    node,
    geo,
    status() {
      const value = manifest();
      return {
        built: Boolean(value),
        dir,
        tables: value?.tables || {},
      };
    },
  };
}
