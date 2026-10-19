// Personal fork: the census tract boundaries `npm run census:build` writes
// and the census tile server reads. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Four files in the build directory:
 *   tracts.json   {version, count, geoids: [GEOID, …]} in file order
 *   index.bin     per tract, Int32: bbox west, south, east, north (degrees
 *                 × 1e6), first ring, ring count
 *   rings.bin     per ring, Int32: first point, point count
 *   coords.bin    per point, Int32: lon, lat (degrees × 1e6)
 * Degrees × 1e6 is 0.11 m at the equator, far finer than the 1:500,000
 * cartographic boundaries.
 */
export const TRACTS_FORMAT = 1;
const SCALE = 1e6;
const INDEX_INTS = 6;

/** Write tracts [{geoid, rings: Float64Array[]}] to `dir`. */
export function writeTracts(dir, tracts) {
  let ringTotal = 0;
  let pointTotal = 0;
  for (const tract of tracts) {
    ringTotal += tract.rings.length;
    for (const ring of tract.rings) pointTotal += ring.length / 2;
  }
  const index = new Int32Array(tracts.length * INDEX_INTS);
  const rings = new Int32Array(ringTotal * 2);
  const coords = new Int32Array(pointTotal * 2);
  let ring = 0;
  let point = 0;
  tracts.forEach((tract, t) => {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    index[t * INDEX_INTS + 4] = ring;
    index[t * INDEX_INTS + 5] = tract.rings.length;
    for (const points of tract.rings) {
      rings[ring * 2] = point;
      rings[ring * 2 + 1] = points.length / 2;
      ring += 1;
      for (let i = 0; i < points.length; i += 2) {
        const lon = Math.round(points[i] * SCALE);
        const lat = Math.round(points[i + 1] * SCALE);
        coords[point * 2] = lon;
        coords[point * 2 + 1] = lat;
        point += 1;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    index.set(
      Number.isFinite(west) ? [west, south, east, north] : [0, 0, 0, 0],
      t * INDEX_INTS,
    );
  });
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, data) => {
    const file = path.join(dir, name);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  };
  write('index.bin', Buffer.from(index.buffer));
  write('rings.bin', Buffer.from(rings.buffer));
  write('coords.bin', Buffer.from(coords.buffer));
  write(
    'tracts.json',
    JSON.stringify({
      version: TRACTS_FORMAT,
      count: tracts.length,
      rings: ringTotal,
      points: pointTotal,
      geoids: tracts.map((tract) => tract.geoid),
    }),
  );
  return { count: tracts.length, rings: ringTotal, points: pointTotal };
}

const int32s = (file) => {
  const buffer = fs.readFileSync(file);
  return new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
};

/** Grid cells of this many degrees index the tracts by bbox. */
const CELL_DEG = 0.5;
const cellOf = (micro) => Math.floor(micro / SCALE / CELL_DEG);

/**
 * Open a build: the tracts and a grid index of their bboxes.
 * @returns {{count: number, geoids: string[], tractsIn: (box: {west, south,
 *   east, north}) => number[], ringsOf: (t: number) => Int32Array[]}}
 */
export function openTracts(dir) {
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, 'tracts.json'), 'utf8'),
  );
  if (meta.version !== TRACTS_FORMAT)
    throw new Error(`tract format ${meta.version}, not ${TRACTS_FORMAT}`);
  const index = int32s(path.join(dir, 'index.bin'));
  const rings = int32s(path.join(dir, 'rings.bin'));
  const coords = int32s(path.join(dir, 'coords.bin'));
  if (index.length !== meta.count * INDEX_INTS)
    throw new Error('index.bin does not match tracts.json');
  const grid = new Map();
  for (let t = 0; t < meta.count; t++) {
    const at = t * INDEX_INTS;
    if (index[at + 5] === 0) continue;
    for (let cx = cellOf(index[at]); cx <= cellOf(index[at + 2]); cx++)
      for (let cy = cellOf(index[at + 1]); cy <= cellOf(index[at + 3]); cy++) {
        const key = `${cx},${cy}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(t);
      }
  }
  return {
    count: meta.count,
    geoids: meta.geoids,
    /** Tracts whose bbox meets a box in degrees. */
    tractsIn({ west, south, east, north }) {
      const seen = new Set();
      const w = west * SCALE;
      const s = south * SCALE;
      const e = east * SCALE;
      const n = north * SCALE;
      for (
        let cx = Math.floor(west / CELL_DEG);
        cx <= Math.floor(east / CELL_DEG);
        cx++
      )
        for (
          let cy = Math.floor(south / CELL_DEG);
          cy <= Math.floor(north / CELL_DEG);
          cy++
        )
          for (const t of grid.get(`${cx},${cy}`) || []) {
            if (seen.has(t)) continue;
            const at = t * INDEX_INTS;
            if (
              index[at] <= e &&
              index[at + 2] >= w &&
              index[at + 1] <= n &&
              index[at + 3] >= s
            )
              seen.add(t);
          }
      return [...seen];
    },
    /** A tract's rings, each [lon, lat, …] in degrees × 1e6. */
    ringsOf(t) {
      const at = t * INDEX_INTS;
      const out = [];
      for (let r = index[at + 4]; r < index[at + 4] + index[at + 5]; r++) {
        const first = rings[r * 2];
        out.push(coords.subarray(first * 2, (first + rings[r * 2 + 1]) * 2));
      }
      return out;
    },
  };
}

export const COORD_SCALE = SCALE;
