/**
 * Personal fork: the Custom cutouts layer's model (src/layers/customCutouts/).
 * A cutout is a boundary the Google 3D tiles are clipped to: an OpenStreetMap
 * administrative relation (from the local Overpass) or a bundled pack's
 * polygon, simplified to a vertex budget so the clipping stays cheap. This
 * module is pure: the Overpass queries and their parsing, the ring
 * simplification, the list operations and the compact URL form. Nothing here
 * imports Cesium.
 */
import {
  buildRingComponents,
  douglasPeucker,
  ringAreaM2,
} from '../sources/featureGeometry.js';
import { MD_PARCEL_SOURCE_PATTERN } from './mdParcels.js';

/** OSM area ids of relations: the relation id plus this. */
export const OSM_AREA_OFFSET = 3_600_000_000;
/** At most this many vertices a cutout, over all its rings. */
export const CUTOUT_VERTEX_BUDGET = 400;
/** A ring is closed when its ends are this close (metres). */
const CLOSE_TOLERANCE_M = 30;
/** Rings smaller than this (m²) are islets not worth a clipping polygon. */
const MIN_RING_AREA_M2 = 10_000;
/** The most cutouts the list (and the URL) holds. */
export const MAX_CUTOUTS = 12;
/** The plate colours under the cut tiles. */
export const PLATES = Object.freeze(['black', 'white']);

/** The admin areas at a point (is_in), with their names and levels. */
export const isInQuery = (lat, lon) =>
  `[out:json][timeout:25];is_in(${Number(lat).toFixed(6)},${Number(lon).toFixed(6)})->.a;area.a["boundary"="administrative"]["admin_level"];out tags;`;

/**
 * A relation's geometry by its area id: the sanitizer's bounded pivot form
 * (server/providers/overpass/query.js), which is also boundary-class and so
 * kept 30 days on disk.
 */
export const relationGeometryQuery = (relationId) =>
  `[out:json][timeout:30];area(${OSM_AREA_OFFSET + Number(relationId)})->.a;rel(pivot.a);out geom;`;

/**
 * The administrative areas of an is_in answer: {relationId, name, level},
 * the most local (highest admin_level) first. Areas that are not relations
 * (closed ways) have no pivot here and are left out.
 */
export function areasFromIsIn(json) {
  const out = [];
  const seen = new Set();
  for (const element of json?.elements || []) {
    if (element?.type !== 'area') continue;
    const id = Number(element.id);
    if (!Number.isSafeInteger(id) || id <= OSM_AREA_OFFSET) continue;
    const relationId = id - OSM_AREA_OFFSET;
    const tags = element.tags || {};
    const level = Number(tags.admin_level);
    if (!Number.isInteger(level) || seen.has(relationId)) continue;
    seen.add(relationId);
    const name = String(tags['name:en'] || tags.name || '').trim();
    out.push({
      relationId,
      name: name || `relation ${relationId}`,
      level,
    });
  }
  return out.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}

const metresBetween = (a, b) => {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111_320;
};

/**
 * Simplify rings ([lon, lat] each) to at most `budget` vertices together,
 * shared by size: Douglas–Peucker with a tolerance raised until they fit.
 * Rings closed (first point repeated) on the way in come out without the
 * repeat; each keeps at least 4 points.
 */
export function simplifyRings(rings, budget = CUTOUT_VERTEX_BUDGET) {
  const open = rings
    .map((ring) => {
      const points = ring.slice();
      const [fx, fy] = points[0] || [];
      const [lx, ly] = points[points.length - 1] || [];
      if (points.length > 1 && fx === lx && fy === ly) points.pop();
      return points;
    })
    .filter((ring) => ring.length >= 3);
  const count = (list) => list.reduce((sum, ring) => sum + ring.length, 0);
  if (count(open) <= budget) return open;
  // The tolerance (degrees) where everything fits, by bisection.
  const simplified = (tolerance) =>
    open.map((ring) => {
      const closed = douglasPeucker([...ring, ring[0]], tolerance);
      closed.pop();
      return closed.length >= 4 ? closed : ring.slice(0, 4);
    });
  let low = 0;
  let high = 1;
  let best = simplified(high);
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    const attempt = simplified(middle);
    if (count(attempt) <= budget) {
      best = attempt;
      high = middle;
    } else low = middle;
  }
  return best;
}

/**
 * A cutout's outer rings from a relation's `out geom` answer: the outer
 * members' ways stitched into closed rings ([lon, lat] each), islets
 * dropped, simplified to the budget. Inner rings (holes) are ignored in this
 * pass. Returns {relationId, name, level, rings} or null.
 */
export function cutoutFromRelationGeometry(
  json,
  budget = CUTOUT_VERTEX_BUDGET,
) {
  const relation = (json?.elements || []).find(
    (element) => element?.type === 'relation',
  );
  if (!relation) return null;
  const ways = (relation.members || [])
    .filter(
      (member) =>
        member?.type === 'way' &&
        member.role !== 'inner' &&
        Array.isArray(member.geometry) &&
        member.geometry.length >= 2,
    )
    .map((member) =>
      member.geometry
        .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map((p) => ({ lat: p.lat, lon: p.lon })),
    )
    .filter((way) => way.length >= 2);
  const rings = buildRingComponents(ways)
    .filter(
      (chain) =>
        chain.length >= 4 &&
        metresBetween(chain[0], chain[chain.length - 1]) <= CLOSE_TOLERANCE_M,
    )
    .map((chain) => chain.map((p) => [p.lon, p.lat]))
    .filter((ring) => ringAreaM2(ring) >= MIN_RING_AREA_M2);
  if (!rings.length) return null;
  const tags = relation.tags || {};
  const level = Number(tags.admin_level);
  return {
    relationId: Number(relation.id),
    name: String(tags['name:en'] || tags.name || `relation ${relation.id}`),
    level: Number.isInteger(level) ? level : null,
    rings: simplifyRings(rings, budget),
  };
}

// ── The list ────────────────────────────────────────────────────────────

/**
 * The source keys a cutout may have, one pattern per kind: `osm:<relation
 * id>`, `pack:<key>`, `mdp:<JURSCODE>-<ACCTID>` (a Maryland parcel,
 * src/data/mdParcels.js). None holds `*`, `!` or `~` (the URL's separators).
 * A new kind is one line here.
 */
export const CUTOUT_SOURCE_PATTERNS = Object.freeze([
  'osm:\\d+',
  'pack:[\\w.-]+',
  MD_PARCEL_SOURCE_PATTERN,
]);
const SOURCE_ALTERNATIVES = CUTOUT_SOURCE_PATTERNS.join('|');
const SOURCE_RE = new RegExp(`^(?:${SOURCE_ALTERNATIVES})$`);
const URL_PART_RE = new RegExp(`^(${SOURCE_ALTERNATIVES})([*!])(.*)$`);
/** Whether a string is a cutout source key of a known kind. */
export const isCutoutSource = (source) => SOURCE_RE.test(String(source ?? ''));

/**
 * A cutout's source key (one of CUTOUT_SOURCE_PATTERNS), the identity the
 * list and the URL keep (the rings are fetched again from it).
 */
export const cutoutKey = (cutout) => String(cutout?.source || '');

const cleanName = (name) =>
  String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/** A list with `cutout` added (or, already there, shown again). */
export function addCutout(list, cutout) {
  const source = cutoutKey(cutout);
  if (!isCutoutSource(source)) return list;
  const existing = list.find((entry) => entry.source === source);
  if (existing)
    return list.map((entry) =>
      entry === existing ? { ...entry, visible: true } : entry,
    );
  if (list.length >= MAX_CUTOUTS) return list;
  return [
    ...list,
    {
      source,
      name: cleanName(cutout.name) || source,
      level: Number.isInteger(cutout.level) ? cutout.level : null,
      rings: Array.isArray(cutout.rings) ? cutout.rings : null,
      visible: cutout.visible !== false,
    },
  ];
}

/** A list with one cutout's fields changed (name, visible, rings, level). */
export function updateCutout(list, source, patch) {
  return list.map((entry) => {
    if (entry.source !== source) return entry;
    const next = { ...entry };
    if ('name' in patch) next.name = cleanName(patch.name) || entry.name;
    if ('visible' in patch) next.visible = patch.visible === true;
    if ('rings' in patch) next.rings = patch.rings;
    if ('level' in patch && Number.isInteger(patch.level))
      next.level = patch.level;
    return next;
  });
}

export const removeCutout = (list, source) =>
  list.filter((entry) => entry.source !== source);

/** The rings every visible cutout clips with ([lon, lat] each). */
export const visibleRings = (list) =>
  list
    .filter((entry) => entry.visible && Array.isArray(entry.rings))
    .flatMap((entry) => entry.rings);

// ── The URL ─────────────────────────────────────────────────────────────

/**
 * The list and the plate as one compact token for the URL: the plate, then
 * each cutout as source, visibility and name, e.g.
 * `black~osm:133345*Baltimore~osm:12345!Cedarcroft` (`*` shown, `!`
 * hidden: neither is a source's character). Names are URI-encoded with
 * `!'()*~` escaped too, so they never hold a separator; rings are never in
 * it.
 */
export function encodeCutouts({ plate = 'black', cutouts = [] } = {}) {
  const parts = [PLATES.includes(plate) ? plate : 'black'];
  const name = (text) =>
    encodeURIComponent(text || '').replace(
      /[!'()*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  for (const entry of cutouts.slice(0, MAX_CUTOUTS))
    parts.push(
      `${entry.source}${entry.visible ? '*' : '!'}${name(entry.name)}`,
    );
  return parts.join('~');
}

/** encodeCutouts' token back: {plate, cutouts} (rings null: to fetch). */
export function decodeCutouts(token) {
  const parts = String(token || '').split('~');
  const plate = PLATES.includes(parts[0]) ? parts[0] : 'black';
  let cutouts = [];
  for (const part of parts.slice(1)) {
    const match = URL_PART_RE.exec(part);
    if (!match) continue;
    let name = match[3];
    try {
      name = decodeURIComponent(name);
    } catch {
      /* kept as it came */
    }
    cutouts = addCutout(cutouts, {
      source: match[1],
      name,
      visible: match[2] === '*',
    });
  }
  return { plate, cutouts };
}
