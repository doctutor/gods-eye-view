import { readColumnChunk, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import { unitX, unitY } from '../../server/providers/overture/buildingsFile.js';
import { appendPlace } from './placesParts.mjs';
import { infrastructureCode } from '../../src/data/overtureInfrastructure.js';

/**
 * The first half of the Overture infrastructure step: one fetched row group
 * → one part, in the places' part format (placesParts.mjs appendPlace), so
 * the places' merge and index serve it. A feature is kept when its class is
 * one of INFRASTRUCTURE_CLASSES; its point is the centre of its bounding box
 * (the point itself for a node, the middle of a line or an area), its
 * confidence 1 (the class is OpenStreetMap's tag), and its text the name (if
 * any), the class and the source dataset.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const text = (v) => (v == null ? '' : String(v));

/** A bounding box's centre as [lon, lat], or null. */
export function boxCentre(xmin, xmax, ymin, ymax) {
  // A missing side is null, which Number() would make 0 (null island).
  const values = [xmin, xmax, ymin, ymax].map((v) =>
    v == null ? NaN : Number(v),
  );
  if (!values.every(Number.isFinite)) return null;
  const [x0, x1, y0, y1] = values;
  if (x0 > x1 || y0 > y1 || Math.abs(y0) > 90 || Math.abs(y1) > 90) return null;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Decode a fetched row group (buildingsPlan.mjs readRowGroupFile) into a
 * part's buckets and its stats.
 */
export function decodeInfrastructureRowGroup(group, footer) {
  const meta = footer.rowGroups[group.header.group];
  const column = (p) => {
    const chunk = meta.columns.find((c) => c.path === p);
    const leaf = footer.leaves.find((l) => l.path === p);
    return { raw: readColumnChunk(group.chunk(p), chunk, leaf), leaf };
  };
  const flat = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfFlat(raw, leaf);
  };
  const list = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfRepeated(raw, { ...leaf, elementDef: leaf.maxDef - 1 });
  };
  const classes = flat('class');
  const rows = classes.length;
  const columns = {
    xmin: flat('bbox.xmin'),
    xmax: flat('bbox.xmax'),
    ymin: flat('bbox.ymin'),
    ymax: flat('bbox.ymax'),
    names: flat('names.primary'),
    datasets: list('sources.list.element.dataset'),
  };
  for (const [name, values] of Object.entries(columns))
    if (values.length !== rows)
      throw new Error(
        `${group.header.file} row group ${group.header.group}: ${name} has ${values.length} of ${rows} rows`,
      );
  const { xmin, xmax, ymin, ymax, names, datasets } = columns;
  const buckets = new Map();
  const stats = {
    read: rows,
    kept: 0,
    named: 0,
    unplaced: 0,
    byClass: {},
    byDataset: {},
  };
  for (let i = 0; i < rows; i++) {
    const className = text(classes[i]);
    const code = infrastructureCode(className);
    if (!code) continue;
    const at = boxCentre(xmin[i], xmax[i], ymin[i], ymax[i]);
    if (!at) {
      stats.unplaced += 1;
      continue;
    }
    const name = text(names[i]).trim();
    const source = text(datasets[i]?.[0]) || 'unknown';
    stats.kept += 1;
    if (name) stats.named += 1;
    stats.byClass[className] = (stats.byClass[className] || 0) + 1;
    stats.byDataset[source] = (stats.byDataset[source] || 0) + 1;
    appendPlace(buckets, {
      x: unitX(at[0]),
      y: unitY(at[1]),
      confidence: 1,
      category: code,
      text: {
        name: name.slice(0, 200),
        basic: className,
        source: source.slice(0, 40),
      },
    });
  }
  return { buckets, stats };
}
