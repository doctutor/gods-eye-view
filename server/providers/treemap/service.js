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
import { openStoredLabeller } from './labeller.js';
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
/** Points one /label request may carry. */
export const LABEL_POINTS_LIMIT = 20_000;

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

  /**
   * A variable's tables: its own, then its others ("<variable>+<cut>", a
   * table with other groupings, like land cover's), each opened when asked.
   */
  function tablesOf(variable) {
    const names = Object.keys(manifest()?.tables || {}).filter(
      (name) => name === variable || name.startsWith(`${variable}+`),
    );
    names.sort((a, b) => (a === variable ? -1 : b === variable ? 1 : 0));
    const out = [];
    for (const name of names)
      try {
        out.push(tableOf(name));
      } catch (error) {
        console.warn('[Treemap] table not readable:', error?.message);
      }
    return out;
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
    return {
      schema: TREEMAP_SCHEMA,
      variables: TREEMAP_VARIABLES.map((variable) => {
        if (variable.source === 'live')
          return {
            id: variable.id,
            available: true,
            groupings: [...variable.groupings],
          };
        const found = tablesOf(variable.id);
        const table = found[0] || null;
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
          groupings: variable.groupings.filter((id) =>
            found.some((each) => each.has(id)),
          ),
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
    const found = tablesOf(variable.id);
    if (!found.length)
      return bad(`${variable.id} is not built: ${NEEDS_TREEMAP_BUILD}`);
    // The first of the variable's tables that has every grouping asked for.
    const table =
      found.find((each) => checked.groupings.every((id) => each.has(id))) ||
      found[0];
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

  // The stored labelling the build wrote (manifest files.labels), opened
  // when first asked and again when the build replaces it.
  let labelling = null;
  function labeller() {
    const entry = manifest()?.files?.labels;
    if (!entry?.data) {
      labelling?.value.close();
      labelling = null;
      return null;
    }
    if (labelling?.file === entry.file) return labelling.value;
    labelling?.value.close();
    labelling = {
      file: entry.file,
      value: openStoredLabeller({
        index: JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8')),
        file: path.join(dir, entry.data),
      }),
    };
    return labelling.value;
  }

  /**
   * Live points' units: { points: [[lon, lat]…] } → { units: [{country,
   * region, district} | null…] }, in the points' order; null at sea or for
   * a point that is no point.
   */
  function label(body) {
    const points = body?.points;
    if (!Array.isArray(points))
      return bad('The body is { points: [[lon, lat]…] }');
    if (points.length > LABEL_POINTS_LIMIT)
      return bad(`At most ${LABEL_POINTS_LIMIT} points a request`);
    const labelling = labeller();
    if (!labelling)
      return { status: 503, body: { error: NEEDS_TREEMAP_BUILD } };
    const units = points.map((point) => {
      if (!Array.isArray(point)) return null;
      const [lon, lat] = point.map(Number);
      const found = labelling.label(lon, lat);
      return found
        ? {
            country: found.country,
            region: found.region,
            district: found.district,
          }
        : null;
    });
    return { status: 200, body: { units } };
  }

  return {
    catalog,
    node,
    geo,
    label,
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
