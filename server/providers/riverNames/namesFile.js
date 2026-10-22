// Personal fork: the river names sidecar that `npm run rivers:names`
// writes and the rivers routes read: named lines (HydroSHEDS v2 reaches
// named from OpenStreetMap, and OSM's named waterways themselves) for a
// clicked reach's name, and label points for the large named rivers. Not
// part of upstream God's Eye View.
import fs from 'node:fs';

/**
 * names.bin: 'GEVRNM1\n', Uint32 count, Uint32 offsets[count + 1], then
 * UTF-8 "name\0name:en\0wikidata\0waterway" per name group, read one at a
 * time by offset.
 *
 * Lines and labels are bucket files, one per z 8 tile, in the buildings'
 * format (server/providers/overture/buildingsFile.js):
 *
 * - LINE blocks, one per z 12 tile a line's box touches: records of
 *   scripts/rivers/namesSpill.mjs encodeLine (name group, tag, points);
 * - LABEL blocks, one per z 10 tile: one point per name group (its largest
 *   reach's middle), same records.
 *
 * A record's tag is SOURCE × 16 + Strahler order: SOURCE.osm for an OSM
 * waterway (order 0), SOURCE.direct for a v2 reach its OSM line names,
 * SOURCE.inherited for one named down its main stem.
 */

export const NAMES_MAGIC = Buffer.from('GEVRNM1\n', 'latin1');
export const NAMES_KIND = Object.freeze({ LINE: 1, LABEL: 2 });
export const NAMES_BUCKET_ZOOM = 8;
export const LINE_ZOOM = 12;
export const LABEL_ZOOM = 10;
export const SOURCE = Object.freeze({ osm: 1, direct: 2, inherited: 3 });
export const SOURCE_KEYS = Object.freeze({
  1: 'nearest',
  2: 'direct',
  3: 'inherited',
});
export const tagOf = (source, strahler) => source * 16 + (strahler || 0);
export const sourceOfTag = (tag) => Math.floor(tag / 16);
export const strahlerOfTag = (tag) => tag % 16;

/** Write names.bin from [{name, nameEn, wikidata, waterway}] (index = group). */
export function writeNamesFile(file, groups) {
  const bodies = groups.map((g) =>
    Buffer.from(
      [g.name, g.nameEn || '', g.wikidata || '', g.waterway || '']
        .map((v) => String(v).replace(/\0/g, ''))
        .join('\0'),
      'utf8',
    ),
  );
  const head = Buffer.alloc(NAMES_MAGIC.length + 4 + (groups.length + 1) * 4);
  NAMES_MAGIC.copy(head, 0);
  head.writeUInt32LE(groups.length, NAMES_MAGIC.length);
  let offset = 0;
  bodies.forEach((body, i) => {
    head.writeUInt32LE(offset, NAMES_MAGIC.length + 4 + i * 4);
    offset += body.length;
  });
  head.writeUInt32LE(offset, NAMES_MAGIC.length + 4 + groups.length * 4);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, Buffer.concat([head, ...bodies]));
  fs.renameSync(temporary, file);
  return head.length + offset;
}

/** Open names.bin: name(group) → {name, nameEn, wikidata, waterway} | null. */
export function openNamesFile(file) {
  const fd = fs.openSync(file, 'r');
  const lead = Buffer.alloc(NAMES_MAGIC.length + 4);
  fs.readSync(fd, lead, 0, lead.length, 0);
  if (!lead.subarray(0, NAMES_MAGIC.length).equals(NAMES_MAGIC)) {
    fs.closeSync(fd);
    throw new Error(`${file} is not a river names file`);
  }
  const count = lead.readUInt32LE(NAMES_MAGIC.length);
  const offsets = Buffer.alloc((count + 1) * 4);
  fs.readSync(fd, offsets, 0, offsets.length, lead.length);
  const base = lead.length + offsets.length;
  return {
    count,
    name(group) {
      if (!(group >= 0 && group < count)) return null;
      const start = offsets.readUInt32LE(group * 4);
      const end = offsets.readUInt32LE((group + 1) * 4);
      const body = Buffer.alloc(end - start);
      fs.readSync(fd, body, 0, body.length, base + start);
      const [name = '', nameEn = '', wikidata = '', waterway = ''] = body
        .toString('utf8')
        .split('\0');
      return { name, nameEn, wikidata, waterway };
    },
    close: () => fs.closeSync(fd),
  };
}

// ── Line records (also the build's spill records) ─────────────────────

/*
 * A line record: varuint id (a name group, or a reach's index), varuint
 * tag, varuint point count, then zigzag varint deltas of the coordinates
 * in microdegrees (lon, lat), the first from 0.
 */
const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

function pushVarUint(out, value) {
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

/** One line record's bytes. `coords` [lon, lat, …] in degrees. */
export function encodeLine(id, tag, coords) {
  const out = [];
  pushVarUint(out, id);
  pushVarUint(out, tag);
  pushVarUint(out, coords.length / 2);
  let px = 0;
  let py = 0;
  for (let k = 0; k < coords.length; k += 2) {
    const x = Math.round(coords[k] * 1e6);
    const y = Math.round(coords[k + 1] * 1e6);
    pushVarUint(out, zig(x - px));
    pushVarUint(out, zig(y - py));
    px = x;
    py = y;
  }
  return Buffer.from(out);
}

/** Visit a buffer's records: visit(id, tag, coords). */
export function eachLine(buf, visit) {
  let at = 0;
  const varuint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const b = buf[at++];
      value += (b & 0x7f) * scale;
      if (b < 128) return value;
      scale *= 128;
    }
  };
  while (at < buf.length) {
    const id = varuint();
    const tag = varuint();
    const n = varuint();
    const coords = new Array(n * 2);
    let x = 0;
    let y = 0;
    for (let k = 0; k < n; k++) {
      x += unzig(varuint());
      y += unzig(varuint());
      coords[2 * k] = x / 1e6;
      coords[2 * k + 1] = y / 1e6;
    }
    visit(id, tag, coords);
  }
}
