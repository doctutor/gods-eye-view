/**
 * A small reader for the polygon shapefiles of the Census Bureau's
 * cartographic boundary files: the .shp's polygons (shape type 5, rings in
 * lon/lat) and the .dbf's text fields. Enough for `npm run census:build`;
 * nothing here is a general shapefile library.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const POLYGON = 5;

/**
 * Every record's rings, in file order: [{rings: Float64Array[]}], each ring
 * [lon, lat, lon, lat, …]. A null shape has no rings.
 */
export function readPolygons(shp) {
  if (shp.readInt32BE(0) !== 9994) throw new Error('not a shapefile');
  const fileBytes = shp.readInt32BE(24) * 2;
  const shapes = [];
  let at = 100;
  while (at + 8 <= Math.min(fileBytes, shp.length)) {
    const length = shp.readInt32BE(at + 4) * 2;
    const start = at + 8;
    const type = shp.readInt32LE(start);
    if (type === 0) shapes.push({ rings: [] });
    else if (type === POLYGON) {
      const parts = shp.readInt32LE(start + 36);
      const points = shp.readInt32LE(start + 40);
      const partsAt = start + 44;
      const pointsAt = partsAt + parts * 4;
      const rings = [];
      for (let p = 0; p < parts; p++) {
        const first = shp.readInt32LE(partsAt + p * 4);
        const last =
          p + 1 < parts ? shp.readInt32LE(partsAt + (p + 1) * 4) : points;
        const ring = new Float64Array((last - first) * 2);
        for (let i = first; i < last; i++) {
          ring[(i - first) * 2] = shp.readDoubleLE(pointsAt + i * 16);
          ring[(i - first) * 2 + 1] = shp.readDoubleLE(pointsAt + i * 16 + 8);
        }
        rings.push(ring);
      }
      shapes.push({ rings });
    } else throw new Error(`shape type ${type} is not a polygon`);
    at = start + length;
  }
  return shapes;
}

/** The .dbf's records as {field: text}, for the fields named (all if none). */
export function readDbf(dbf, wanted = null) {
  const count = dbf.readUInt32LE(4);
  const headerBytes = dbf.readUInt16LE(8);
  const recordBytes = dbf.readUInt16LE(10);
  const fields = [];
  let offset = 1; // the deletion flag
  for (let at = 32; at < headerBytes - 1 && dbf[at] !== 0x0d; at += 32) {
    const name = dbf
      .toString('latin1', at, at + 11)
      .replace(/\0.*$/, '')
      .trim();
    const size = dbf[at + 16];
    fields.push({ name, offset, size });
    offset += size;
  }
  const picked = wanted
    ? fields.filter((f) => wanted.includes(f.name))
    : fields;
  const records = [];
  for (let r = 0; r < count; r++) {
    const base = headerBytes + r * recordBytes;
    const record = {};
    for (const field of picked)
      record[field.name] = dbf
        .toString(
          'latin1',
          base + field.offset,
          base + field.offset + field.size,
        )
        .trim();
    records.push(record);
  }
  return records;
}
