/**
 * Cliopatria (v0.2.1, CC BY 4.0: Seshat's polity borders, 3400 BCE to
 * 2024), streamed from its zipped GeoJSON a feature a line, never loaded
 * whole: each record's properties and its polygons as one Float64Array of
 * lon, lat pairs with ring offsets (3.8 M vertices: about 61 MB, outside
 * the heap). Lookups: the records alive in a span of years, and a point's
 * distance to a record (0 inside it).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import readline from 'node:readline';
import { listZipEntries, openZipEntry } from '../rivers/zip.mjs';

const R_KM = 6371;
const toRad = Math.PI / 180;

/**
 * One record from a GeoJSON feature: {name, from, to, area, type,
 * wikipedia, wikidata, memberOf, components, box, coords, rings, polygons}
 * (`rings` ring start offsets into coords, in pairs; `polygons` the first
 * ring of each polygon, the rest of its rings holes).
 */
export function recordOf(feature, index = 0) {
  const p = feature.properties || {};
  const polys =
    feature.geometry?.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiPolygon'
        ? feature.geometry.coordinates
        : [];
  let n = 0;
  for (const poly of polys) for (const ring of poly) n += ring.length;
  const coords = new Float64Array(n * 2);
  const rings = [];
  const polygons = [];
  const box = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };
  let at = 0;
  for (const poly of polys) {
    polygons.push(rings.length);
    for (const ring of poly) {
      rings.push(at);
      for (const [lon, lat] of ring) {
        coords[at * 2] = lon;
        coords[at * 2 + 1] = lat;
        if (lon < box.west) box.west = lon;
        if (lon > box.east) box.east = lon;
        if (lat < box.south) box.south = lat;
        if (lat > box.north) box.north = lat;
        at += 1;
      }
    }
  }
  rings.push(at);
  return {
    index,
    name: String(p.Name || ''),
    from: Number(p.FromYear),
    to: Number(p.ToYear),
    area: Number(p.Area) || 0,
    type: String(p.Type || 'POLITY'),
    wikipedia: p.Wikipedia || '',
    wikidata: p.Wikidata || '',
    memberOf: p.MemberOf || '',
    components: p.Components || '',
    box,
    coords,
    rings: Int32Array.from(rings),
    polygons: Int32Array.from(polygons),
  };
}

/** Stream Cliopatria's records from its zip (or any GeoJSON a feature a line). */
export async function loadCliopatria(zipFile) {
  const [entry] = listZipEntries(zipFile).filter((e) =>
    /\.geojson$/i.test(e.name),
  );
  if (!entry) throw new Error(`${zipFile}: no .geojson inside`);
  return readFeatureLines(openZipEntry(zipFile, entry));
}

/** Records from a stream of GeoJSON text with a feature a line. */
export async function readFeatureLines(stream) {
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const records = [];
  for await (const line of lines) {
    const text = line.trim().replace(/,$/, '');
    if (!/^\{\s*"type"\s*:\s*"Feature"/.test(text)) continue;
    records.push(recordOf(JSON.parse(text), records.length));
  }
  return records;
}

function inRing(coords, start, end, lon, lat) {
  let inside = false;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = coords[i * 2];
    const yi = coords[i * 2 + 1];
    const xj = coords[j * 2];
    const yj = coords[j * 2 + 1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Whether a record's polygons hold the point (holes excluded). */
export function contains(record, lon, lat) {
  const { box } = record;
  if (lon < box.west || lon > box.east || lat < box.south || lat > box.north)
    return false;
  const { coords, rings, polygons } = record;
  for (let p = 0; p < polygons.length; p++) {
    const first = polygons[p];
    const last = p + 1 < polygons.length ? polygons[p + 1] : rings.length - 1;
    if (!inRing(coords, rings[first], rings[first + 1], lon, lat)) continue;
    let hole = false;
    for (let r = first + 1; r < last; r++)
      if (inRing(coords, rings[r], rings[r + 1], lon, lat)) {
        hole = true;
        break;
      }
    if (!hole) return true;
  }
  return false;
}

/** Great-circle distance, km. */
export function haversineKm(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A point's distance to a record, km: 0 inside, else to its nearest edge
 * (on a local equirectangular plane about the point: within a few hundred
 * km, which is all a match looks at, the error is small).
 */
export function distanceKm(record, lon, lat) {
  if (contains(record, lon, lat)) return 0;
  const { coords, rings } = record;
  const kx = Math.cos(lat * toRad) * R_KM * toRad;
  const ky = R_KM * toRad;
  let best = Infinity;
  for (let r = 0; r + 1 < rings.length; r++) {
    const start = rings[r];
    const end = rings[r + 1];
    for (let i = start, j = end - 1; i < end; j = i++) {
      const ax = (coords[j * 2] - lon) * kx;
      const ay = (coords[j * 2 + 1] - lat) * ky;
      const bx = (coords[i * 2] - lon) * kx;
      const by = (coords[i * 2 + 1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = px * px + py * py;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Whether a record's box lies within `km` of the point (a cheap first cut). */
export function boxNear(record, lon, lat, km) {
  const { box } = record;
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.1, Math.cos(lat * toRad)));
  return (
    lon >= box.west - dLon &&
    lon <= box.east + dLon &&
    lat >= box.south - dLat &&
    lat <= box.north + dLat
  );
}

/** Records alive at any time in [from, to] (inclusive years, negative BCE). */
export function aliveIn(records, from, to) {
  return records.filter((r) => r.from <= to && r.to >= from);
}
