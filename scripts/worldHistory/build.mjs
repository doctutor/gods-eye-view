import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { listZipEntries, openZipEntry } from '../rivers/zip.mjs';
import { douglasPeucker } from '../../src/sources/featureGeometry.js';
import {
  CLIOPATRIA_LAST_YEAR,
  decodePolygons,
  encodePolygons,
  polygonsContain,
} from '../../src/data/worldHistory.js';
import { cottereauSpans } from './cottereau.mjs';

/**
 * The World history layer's index, from Cliopatria v0.2.1 (Seshat Global
 * History Databank, CC BY 4.0) streamed once a feature a line, and
 * Cottereau's labels matched to it (data/cottereau/):
 *
 * - every record's metadata, its label point, and its polygons simplified
 *   at LODS (served text, encodePolygons) in one file a level, with each
 *   record's byte offset and length;
 * - the records by year (YEAR_BUCKET-year buckets), so a year is a lookup;
 * - each polity (Cliopatria Name): its records, and its largest (by Area);
 * - Cottereau's spans: label, polity, years, confidence.
 *
 * The files carry the build id (from the inputs and FORMAT), and
 * `current.json` moves to the new manifest in one rename, the old files
 * going after; a stopped build leaves the previous one current. The whole
 * build is about a minute, so it keeps no checkpoint and reruns from the
 * start; an unchanged input is skipped unless `force`.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const FORMAT = 1;
/** Douglas–Peucker tolerances (degrees) of the served levels. */
export const LODS = Object.freeze([0.25, 0.08, 0.02]);
/** Year buckets of the index, from YEAR_ORIGIN. */
export const YEAR_BUCKET = 50;
export const YEAR_ORIGIN = -3400;

export const bucketOf = (year) =>
  Math.floor((year - YEAR_ORIGIN) / YEAR_BUCKET);

/** The features of a Cliopatria file: its zip, or GeoJSON a feature a line. */
export async function* cliopatriaFeatures(file) {
  let input;
  if (/\.zip$/i.test(file)) {
    const [entry] = listZipEntries(file).filter((e) =>
      /\.geojson$/i.test(e.name),
    );
    if (!entry) throw new Error(`${file}: no .geojson inside`);
    input = openZipEntry(file, entry);
  } else input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim().replace(/,$/, '');
    if (/^\{\s*"type"\s*:\s*"Feature"/.test(text)) yield JSON.parse(text);
  }
}

const polygonsOf = (geometry) =>
  geometry?.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon'
      ? geometry.coordinates
      : [];

function ringBox(ring) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** A ring's area in square degrees (shoelace), unsigned. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(sum / 2);
}

/**
 * Polygons simplified at a tolerance: each ring by Douglas–Peucker, a ring
 * left with under 3 corners dropped, and a polygon whose outer ring is
 * smaller than the tolerance either way dropped, but never all of them:
 * the largest stays, at a finer tolerance if it must.
 */
export function simplifyPolygons(polygons, tolerance) {
  const out = [];
  for (const polygon of polygons) {
    const box = ringBox(polygon[0]);
    if (box.east - box.west < tolerance && box.north - box.south < tolerance)
      continue;
    const rings = [];
    for (const ring of polygon) {
      const simple = douglasPeucker(ring, tolerance);
      if (simple.length >= 4) rings.push(simple);
      else if (!rings.length) break;
    }
    if (rings.length) out.push(rings);
  }
  if (out.length || !polygons.length) return out;
  const largest = polygons.reduce((best, polygon) =>
    ringArea(polygon[0]) > ringArea(best[0]) ? polygon : best,
  );
  for (const finer of [tolerance / 10, 0]) {
    const ring = finer ? douglasPeucker(largest[0], finer) : largest[0];
    if (ring.length >= 4) return [[ring]];
  }
  return [];
}

/**
 * Where a polity's name goes: the inside point of its largest polygon
 * farthest from that polygon's edges, on a 16 × 16 grid (decoded, served
 * level 1), else its box's centre.
 */
export function labelPoint(served) {
  const polygons = decodePolygons(served);
  if (!polygons.length) return null;
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const points = [];
    for (let i = 0; i < outer.length; i += 2)
      points.push([outer[i], outer[i + 1]]);
    const area = ringArea(points);
    if (area > bestArea) {
      bestArea = area;
      best = rings;
    }
  }
  const outer = best[0];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    west = Math.min(west, outer[i]);
    east = Math.max(east, outer[i]);
    south = Math.min(south, outer[i + 1]);
    north = Math.max(north, outer[i + 1]);
  }
  const edgeDistance = (lon, lat) => {
    let d = Infinity;
    for (const ring of best) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = ring[j * 2];
        const ay = ring[j * 2 + 1];
        const dx = ring[i * 2] - ax;
        const dy = ring[i * 2 + 1] - ay;
        const len = dx * dx + dy * dy;
        const t = len
          ? Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / len))
          : 0;
        d = Math.min(d, Math.hypot(lon - ax - t * dx, lat - ay - t * dy));
      }
    }
    return d;
  };
  let point = null;
  let far = -1;
  const steps = 16;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const lon = west + ((i + 0.5) / steps) * (east - west);
      const lat = south + ((j + 0.5) / steps) * (north - south);
      if (!polygonsContain([best], lon, lat)) continue;
      const d = edgeDistance(lon, lat);
      if (d > far) {
        far = d;
        point = [lon, lat];
      }
    }
  point ||= [(west + east) / 2, (south + north) / 2];
  return point.map((v) => Math.round(v * 1e4) / 1e4);
}

/** A file written whole under a temporary name, then renamed. */
function writeWhole(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The build id: the inputs' sizes and times and the format, hashed. */
export function buildId({ cliopatria, matches, tracks }) {
  const hash = crypto.createHash('sha1');
  hash.update(
    `format ${FORMAT} lods ${LODS.join(',')} bucket ${YEAR_BUCKET}\n`,
  );
  for (const file of [cliopatria, matches, tracks]) {
    const stat = fs.statSync(file);
    hash.update(
      `${path.basename(file)} ${stat.size} ${Math.round(stat.mtimeMs)}\n`,
    );
  }
  return hash.digest('hex').slice(0, 12);
}

/** The manifest current.json points at, or null. */
export function readCurrent(dir) {
  try {
    const { manifest } = JSON.parse(
      fs.readFileSync(path.join(dir, 'current.json'), 'utf8'),
    );
    if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(manifest))) return null;
    return {
      name: manifest,
      ...JSON.parse(fs.readFileSync(path.join(dir, manifest), 'utf8')),
    };
  } catch {
    return null;
  }
}

/**
 * Build the index into `dir` (made if missing).
 * @param {{cliopatria: string, matches: string, tracks: string, dir: string,
 *   force?: boolean, log?: (line: string) => void, now?: () => Date}} options
 * @returns {Promise<object>} the manifest (with `skipped` when unchanged)
 */
export async function buildWorldHistory({
  cliopatria,
  matches,
  tracks,
  dir,
  force = false,
  log = () => {},
  now = () => new Date(),
}) {
  const started = Date.now();
  const id = buildId({ cliopatria, matches, tracks });
  fs.mkdirSync(dir, { recursive: true });
  const current = readCurrent(dir);
  if (current?.id === id && !force) {
    log(`World history ${id} is current: nothing to do (--force rebuilds)`);
    return { ...current, skipped: true };
  }

  const geomFiles = LODS.map((_, lod) => `geom-${id}-${lod}.json`);
  const outs = geomFiles.map((file) => {
    const tmp = path.join(dir, `${file}.${process.pid}.tmp`);
    return { tmp, file, fd: fs.openSync(tmp, 'w'), at: 0 };
  });
  const records = [];
  const vertices = LODS.map(() => 0);
  let sourceVertices = 0;
  try {
    for await (const feature of cliopatriaFeatures(cliopatria)) {
      const p = feature.properties || {};
      const polygons = polygonsOf(feature.geometry);
      for (const polygon of polygons)
        for (const ring of polygon) sourceVertices += ring.length;
      const geom = [];
      let label = null;
      let box = null;
      LODS.forEach((tolerance, lod) => {
        const simple = simplifyPolygons(polygons, tolerance);
        for (const rings of simple)
          for (const ring of rings) vertices[lod] += ring.length;
        const text = encodePolygons(simple);
        const bytes = Buffer.from(text, 'utf8');
        const out = outs[lod];
        fs.writeSync(out.fd, bytes);
        geom.push([out.at, bytes.length]);
        out.at += bytes.length;
        if (lod === 1) label = labelPoint(text);
        if (lod === 0) {
          const all = simple.length ? simple : polygons;
          const b = {
            west: Infinity,
            south: Infinity,
            east: -Infinity,
            north: -Infinity,
          };
          for (const rings of all) {
            const r = ringBox(rings[0]);
            b.west = Math.min(b.west, r.west);
            b.south = Math.min(b.south, r.south);
            b.east = Math.max(b.east, r.east);
            b.north = Math.max(b.north, r.north);
          }
          box = Number.isFinite(b.west)
            ? [b.west, b.south, b.east, b.north].map(
                (v) => Math.round(v * 1e3) / 1e3,
              )
            : null;
        }
      });
      records.push({
        name: String(p.Name || ''),
        from: Number(p.FromYear),
        to: Number(p.ToYear),
        area: Math.round(Number(p.Area) || 0),
        type: p.Type === 'RELATION' ? 'relation' : 'polity',
        wikipedia: p.Wikipedia || '',
        wikidata: p.Wikidata || '',
        memberOf: p.MemberOf || '',
        label,
        box,
        geom,
      });
      if (records.length % 2000 === 0) log(`  ${records.length} records`);
    }
  } finally {
    for (const out of outs) fs.closeSync(out.fd);
  }

  // Polities by name, and each one's largest record.
  const byName = new Map();
  records.forEach((record, index) => {
    const polity = byName.get(record.name) || {
      name: record.name,
      records: [],
      max: index,
      from: record.from,
      to: record.to,
    };
    polity.records.push(index);
    if (record.area > records[polity.max].area) polity.max = index;
    polity.from = Math.min(polity.from, record.from);
    polity.to = Math.max(polity.to, record.to);
    byName.set(record.name, polity);
  });
  const polities = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );

  // Records by year bucket.
  const buckets = [];
  records.forEach((record, index) => {
    for (let b = bucketOf(record.from); b <= bucketOf(record.to); b++)
      (buckets[b] ||= []).push(index);
  });
  for (let b = 0; b < buckets.length; b++) buckets[b] ||= [];

  // Cottereau's spans, only those naming a polity Cliopatria has.
  const spans = cottereauSpans(
    JSON.parse(fs.readFileSync(matches, 'utf8')),
    JSON.parse(fs.readFileSync(tracks, 'utf8')),
  ).filter((span) => byName.has(span.name));

  const indexFile = `index-${id}.json`;
  const index = {
    format: FORMAT,
    id,
    lods: LODS,
    yearBucket: YEAR_BUCKET,
    yearOrigin: YEAR_ORIGIN,
    lastYear: CLIOPATRIA_LAST_YEAR,
    records,
    polities,
    buckets,
    spans,
  };
  writeWhole(path.join(dir, indexFile), JSON.stringify(index));
  for (const out of outs) fs.renameSync(out.tmp, path.join(dir, out.file));

  const sizes = Object.fromEntries(
    [indexFile, ...geomFiles].map((file) => [
      file,
      fs.statSync(path.join(dir, file)).size,
    ]),
  );
  const sourceStat = fs.statSync(cliopatria);
  const manifest = {
    format: FORMAT,
    id,
    builtAt: now().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    source: {
      cliopatria: path.basename(cliopatria),
      size: sourceStat.size,
      vertices: sourceVertices,
    },
    records: records.length,
    polities: polities.length,
    spans: spans.length,
    lods: LODS.map((tolerance, lod) => ({
      tolerance,
      vertices: vertices[lod],
      file: geomFiles[lod],
    })),
    index: indexFile,
    sizes,
    bytes: Object.values(sizes).reduce((a, b) => a + b, 0),
  };
  const manifestFile = `manifest-${id}.json`;
  writeWhole(path.join(dir, manifestFile), JSON.stringify(manifest, null, 2));
  writeWhole(
    path.join(dir, 'current.json'),
    JSON.stringify({ manifest: manifestFile }),
  );
  // The previous build's files go once the new one is current.
  for (const file of fs.readdirSync(dir)) {
    const stamp = /^(?:manifest|index|geom)-([0-9a-f]{12})/.exec(file)?.[1];
    if (stamp && stamp !== id) fs.rmSync(path.join(dir, file), { force: true });
    else if (file.endsWith('.tmp') && !file.includes(`.${process.pid}.`))
      fs.rmSync(path.join(dir, file), { force: true });
  }
  log(
    `World history ${id}: ${records.length} records, ${polities.length} polities, ${spans.length} Cottereau spans, ${(manifest.bytes / 1e6).toFixed(1)} MB in ${manifest.seconds} s`,
  );
  return manifest;
}

/** What `status` says: the current build, or that there is none. */
export function worldHistoryStatus(dir) {
  const current = readCurrent(dir);
  if (!current) return { dir, built: false };
  const missing = Object.keys(current.sizes || {}).filter(
    (file) => !fs.existsSync(path.join(dir, file)),
  );
  return {
    dir,
    built: missing.length === 0,
    id: current.id,
    builtAt: current.builtAt,
    seconds: current.seconds,
    records: current.records,
    polities: current.polities,
    spans: current.spans,
    lods: current.lods,
    bytes: current.bytes,
    missing,
  };
}
