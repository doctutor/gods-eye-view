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

// ── Source keys ─────────────────────────────────────────────────────────

/**
 * The source keys a cutout may have, one pattern each (anchored when used).
 * A key is the cutout's identity in the list and the URL, so none of them
 * may hold the `cc` separators `~ * !`. Add a source with one line here.
 * - `osm:` an OpenStreetMap relation (rings fetched from Overpass);
 * - `pack:` a bundled boundary pack's area, by its folded name;
 * - `draw:` a hand-drawn ring, carried in the key itself (encodeDrawnRing).
 */
export const CUTOUT_SOURCE_PATTERNS = Object.freeze([
  'osm:\\d+',
  'pack:[\\w.-]+',
  'draw:[A-Za-z0-9_-]+',
]);
const SOURCE = `(?:${CUTOUT_SOURCE_PATTERNS.join('|')})`;
const SOURCE_RE = new RegExp(`^${SOURCE}$`);
const TOKEN_RE = new RegExp(`^(${SOURCE})([*!])(.*)$`);

/** Whether a source key is one the list accepts. */
export const isCutoutSource = (source) => SOURCE_RE.test(String(source || ''));

// ── Drawn rings ─────────────────────────────────────────────────────────

/** A drawn cutout holds at most this many vertices (its ring is in the URL). */
export const DRAW_MAX_VERTICES = 200;
/** Drawn coordinates are kept to a millionth of a degree (about 11 cm). */
const DRAW_SCALE = 1e6;
const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) out += BASE64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

function fromBase64Url(text) {
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) return null;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * A drawn ring ([lon, lat] each, at least 3, at most DRAW_MAX_VERTICES) as
 * its source key: `draw:` and the base64url (no padding) of the latitudes
 * and longitudes at 1e-6°, each the zigzag varint of its difference from
 * the point before. null for a ring out of bounds.
 */
export function encodeDrawnRing(ring) {
  if (
    !Array.isArray(ring) ||
    ring.length < 3 ||
    ring.length > DRAW_MAX_VERTICES
  )
    return null;
  const bytes = [];
  const varint = (value) => {
    let rest = value >= 0 ? value * 2 : -value * 2 - 1;
    while (rest >= 128) {
      bytes.push((rest % 128) | 128);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  };
  let lastLat = 0;
  let lastLon = 0;
  for (const [lon, lat] of ring) {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    const y = Math.round(lat * DRAW_SCALE);
    const x = Math.round(lon * DRAW_SCALE);
    varint(y - lastLat);
    varint(x - lastLon);
    lastLat = y;
    lastLon = x;
  }
  return `draw:${toBase64Url(bytes)}`;
}

/** encodeDrawnRing's key back to its ring ([lon, lat] each), or null. */
export function decodeDrawnRing(source) {
  const match = /^draw:([A-Za-z0-9_-]+)$/.exec(String(source || ''));
  if (!match) return null;
  const bytes = fromBase64Url(match[1]);
  if (!bytes) return null;
  const values = [];
  let value = 0;
  let scale = 1;
  for (const byte of bytes) {
    value += (byte & 127) * scale;
    if (byte < 128) {
      values.push(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
      value = 0;
      scale = 1;
    } else scale *= 128;
  }
  if (values.length % 2 || values.length < 6) return null;
  const ring = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < values.length; i += 2) {
    lat += values[i];
    lon += values[i + 1];
    ring.push([lon / DRAW_SCALE, lat / DRAW_SCALE]);
  }
  if (ring.length > DRAW_MAX_VERTICES) return null;
  if (!ring.every(([x, y]) => Math.abs(y) <= 90 && Math.abs(x) <= 180))
    return null;
  return ring;
}

const cross = (o, a, b) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const within = (p, q, r) =>
  Math.min(p[0], r[0]) <= q[0] &&
  q[0] <= Math.max(p[0], r[0]) &&
  Math.min(p[1], r[1]) <= q[1] &&
  q[1] <= Math.max(p[1], r[1]);

/** Whether segments p1p2 and p3p4 meet (crossing, or touching). */
function segmentsMeet(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  )
    return true;
  return (
    (d1 === 0 && within(p3, p1, p4)) ||
    (d2 === 0 && within(p3, p2, p4)) ||
    (d3 === 0 && within(p1, p3, p2)) ||
    (d4 === 0 && within(p1, p4, p2))
  );
}

/** Whether edges a→b and b→c fold back over each other at b. */
const foldsBack = (a, b, c) =>
  cross(a, b, c) === 0 &&
  (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0;

/**
 * Whether a path of points ([lon, lat] each) crosses itself: two edges that
 * are not neighbours meet, or two neighbours fold back over each other.
 * `closed` adds the edge from the last point back to the first.
 */
export function pathSelfIntersects(points, { closed = false } = {}) {
  const n = points.length;
  const edges = closed ? n : n - 1;
  if (edges < 2) return false;
  const at = (i) => points[i % n];
  for (let i = 0; i < edges; i++) {
    if (i + 1 < edges || closed)
      if (foldsBack(at(i), at(i + 1), at(i + 2))) return true;
    for (let j = i + 2; j < edges; j++) {
      // The first and the last edge of a ring share its first point.
      if (closed && i === 0 && j === n - 1) continue;
      if (segmentsMeet(at(i), at(i + 1), at(j), at(j + 1))) return true;
    }
  }
  return false;
}

/**
 * Whether a closed ring ([lon, lat] each, the last joining the first)
 * crosses itself. A drawn ring that does is refused (the panel says why),
 * never repaired: a guess at what was meant could cut the wrong lot.
 */
export const ringSelfIntersects = (ring) =>
  pathSelfIntersects(ring, { closed: true });

/** A ring's signed area (shoelace, degrees²): positive counter-clockwise. */
export function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return sum / 2;
}

/**
 * A ring turned counter-clockwise if it was not, so a drawn ring's winding
 * (or a relation's) never changes what the clipping keeps.
 */
export const counterClockwise = (ring) =>
  ringSignedArea(ring) < 0 ? [...ring].reverse() : ring;

/** "Drawn N": one more than the highest drawn number already listed. */
export function nextDrawnName(list) {
  let highest = 0;
  for (const entry of list) {
    const match = /^Drawn (\d+)$/.exec(entry?.name || '');
    if (match && entry.source?.startsWith('draw:'))
      highest = Math.max(highest, Number(match[1]));
  }
  return `Drawn ${highest + 1}`;
}

// ── The list ────────────────────────────────────────────────────────────

/**
 * A cutout's source key (one of CUTOUT_SOURCE_PATTERNS), the identity the
 * list and the URL keep: the rings are fetched again from it, or, for a
 * drawn one, decoded from it.
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
  const drawn = source.startsWith('draw:') ? decodeDrawnRing(source) : null;
  if (source.startsWith('draw:') && !drawn) return list;
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
      rings: drawn
        ? [drawn]
        : Array.isArray(cutout.rings)
          ? cutout.rings
          : null,
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

/**
 * The rings every visible cutout clips with ([lon, lat] each), all turned
 * counter-clockwise, so how a ring was drawn never matters to the clipping.
 */
export const visibleRings = (list) =>
  list
    .filter((entry) => entry.visible && Array.isArray(entry.rings))
    .flatMap((entry) => entry.rings.map(counterClockwise));

// ── The URL ─────────────────────────────────────────────────────────────

/**
 * The list and the plate as one compact token for the URL: the plate, then
 * each cutout as source, visibility and name, e.g.
 * `black~osm:133345*Baltimore~osm:12345!Cedarcroft` (`*` shown, `!`
 * hidden: neither is a source's character). Names are URI-encoded with
 * `!'()*~` escaped too, so they never hold a separator. Fetched rings are
 * never in it; a drawn ring is its source key (encodeDrawnRing).
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

/**
 * encodeCutouts' token back: {plate, cutouts} (rings null: to fetch, but a
 * drawn cutout's decoded from its key).
 */
export function decodeCutouts(token) {
  const parts = String(token || '').split('~');
  const plate = PLATES.includes(parts[0]) ? parts[0] : 'black';
  let cutouts = [];
  for (const part of parts.slice(1)) {
    const match = TOKEN_RE.exec(part);
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
