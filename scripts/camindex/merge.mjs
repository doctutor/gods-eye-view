/**
 * Collapse cameras that several sources list: first by feed URL, then by
 * place (under 50 m apart with a similar name, from different sources). The
 * operator's own feed is
 * kept over a directory's copy of it; the others are remembered in
 * `alsoListedBy`.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const SAME_PLACE_M = 50;
export const SAME_NAME_SIMILARITY = 0.5;

/** A feed URL reduced to what identifies it (scheme, case and fragment dropped). */
export function feedKey(source) {
  const raw = source?.snapshotUrl || source?.url || '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const STOP_WORDS = new Set([
  'the',
  'cam',
  'camera',
  'webcam',
  'live',
  'view',
  'at',
  'of',
  'and',
  'on',
]);
const tokens = (name) =>
  new Set(
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((word) => word && !STOP_WORDS.has(word)),
  );

/** Token overlap of two names, 0–1 (1 when one name's words contain the other's). */
export function nameSimilarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** Lower is preferred: operator feeds, then verified live, then the rest. */
function preference(source) {
  const directory = String(source.publishSignal || '').startsWith('directory');
  const live = source.liveStatus === 'live';
  return (directory ? 2 : 0) + (live ? 0 : 1);
}

/**
 * @param {Array<object>} sources - catalog-shaped cameras from every source.
 * @returns {Array<object>} One camera per real camera, input order kept.
 */
export function mergeCameras(sources) {
  const kept = [];
  /** Per kept camera, the sources already folded into it. */
  const kinds = [];
  const byFeed = new Map();
  /** Grid of ~110 m cells → indexes into `kept`. */
  const grid = new Map();
  const cell = (lat, lon) =>
    `${Math.floor(lat * 1000)}:${Math.floor(lon * 1000)}`;

  const absorb = (index, other) => {
    kinds[index].add(other.sourceKind);
    const current = kept[index];
    const [winner, loser] =
      preference(other) < preference(current)
        ? [other, current]
        : [current, other];
    kept[index] = {
      ...winner,
      alsoListedBy: [
        ...new Set([
          ...(winner.alsoListedBy || []),
          ...(loser.alsoListedBy || []),
          loser.id,
        ]),
      ].filter((id) => id !== winner.id),
    };
  };

  for (const source of sources) {
    const key = feedKey(source);
    if (key && byFeed.has(key)) {
      absorb(byFeed.get(key), source);
      continue;
    }
    let near = -1;
    const baseLat = Math.floor(source.lat * 1000);
    const baseLon = Math.floor(source.lon * 1000);
    search: for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const index of grid.get(`${baseLat + dy}:${baseLon + dx}`) || []) {
          const other = kept[index];
          // One source's distinct ids are distinct cameras (a nest's fixed
          // and PTZ views); only listings from different sources collapse.
          if (
            !kinds[index].has(source.sourceKind) &&
            distanceM(source, other) < SAME_PLACE_M &&
            nameSimilarity(source.name, other.name) >= SAME_NAME_SIMILARITY
          ) {
            near = index;
            break search;
          }
        }
      }
    if (near >= 0) {
      absorb(near, source);
      if (key) byFeed.set(key, near);
      continue;
    }
    const index = kept.push({ ...source }) - 1;
    kinds.push(new Set([source.sourceKind]));
    if (key) byFeed.set(key, index);
    const at = cell(source.lat, source.lon);
    if (!grid.has(at)) grid.set(at, []);
    grid.get(at).push(index);
  }
  return kept;
}
