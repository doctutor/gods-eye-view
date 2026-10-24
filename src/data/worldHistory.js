/**
 * Personal fork: the World history layer's model, shared by its build
 * (scripts/worldHistory/), its server routes (server/providers/worldHistory/)
 * and the layer (src/layers/worldHistory/). Pure: years (negative BCE, no
 * year 0), the geometry's compact text form, the colours, the comparison
 * list and its URL form. Nothing here imports Cesium or the i18n catalog.
 *
 * The shapes are Cliopatria's (Seshat Global History Databank, CC BY 4.0);
 * which polities show in which years, and under which names, follow the
 * labels of Cottereau's video "History of the World: Every Year", matched
 * to Cliopatria in data/cottereau/ (names and years as facts; nothing of
 * the video itself).
 */

/** The years the layer covers: the video's span. */
export const WORLD_HISTORY_FIRST_YEAR = -2500;
export const WORLD_HISTORY_LAST_YEAR = 2025;
/** Cliopatria's last year: 2025 shows 2024. */
export const CLIOPATRIA_LAST_YEAR = 2024;
/** The year view's modes: Cottereau's subset, or every polity alive. */
export const WORLD_HISTORY_MODES = Object.freeze(['cottereau', 'all']);
/** A list entry shows its polity at its largest, or as at the year. */
export const WORLD_HISTORY_EXTENTS = Object.freeze(['max', 'year']);
/** The comparison list holds at most this many polities. */
export const MAX_LIST_ENTRIES = 16;
/** The hash parameter (like `cc` and `cs`). */
export const WORLD_HISTORY_PARAM = 'wh';
/** Cottereau's match confidences, best first; `low` is place-only. */
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
/** The list fills' opacity, by default. */
export const DEFAULT_OPACITY = 0.6;

export const CLIOPATRIA_CREDIT_TEXT =
  'Cliopatria (Seshat Global History Databank), CC BY 4.0';
export const CLIOPATRIA_URL =
  'https://github.com/Seshat-Global-History-Databank/cliopatria';

// ── Years ───────────────────────────────────────────────────────────────

/** A year the layer can show: an integer in range, never 0. */
export const isWorldYear = (year) =>
  Number.isInteger(year) &&
  year !== 0 &&
  year >= WORLD_HISTORY_FIRST_YEAR &&
  year <= WORLD_HISTORY_LAST_YEAR;

/** Any number to the nearest year in range (0 becomes 1 AD). */
export function clampYear(year) {
  const n = Math.round(Number(year));
  if (!Number.isFinite(n)) return 1;
  const clamped = Math.min(
    WORLD_HISTORY_LAST_YEAR,
    Math.max(WORLD_HISTORY_FIRST_YEAR, n),
  );
  return clamped === 0 ? 1 : clamped;
}

/** The year `by` years on, counting no year 0 (1 BC + 1 is 1 AD). */
export function stepYear(year, by) {
  return yearFromSlider(sliderFromYear(clampYear(year)) + Math.round(by));
}

/**
 * The slider's position for a year, and back: positions run on without a
 * gap, so 1 BC (−1) sits next to 1 AD (position 0).
 */
export const SLIDER_MIN = WORLD_HISTORY_FIRST_YEAR;
export const SLIDER_MAX = WORLD_HISTORY_LAST_YEAR - 1;
export const sliderFromYear = (year) => (year > 0 ? year - 1 : year);
export function yearFromSlider(position) {
  const p = Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(position)));
  return p >= 0 ? p + 1 : p;
}

/**
 * A typed year: "500 BC", "500 BCE", "-500", "1 AD", "AD 1", "2025",
 * "500 CE", "c. 500 bc". null for anything else, for 0 and for "0 BC".
 * Range is not checked (clampYear does that).
 */
export function parseYear(text) {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^c(?:a|irca)?\.?\s*/, '')
    .replace(/\s+/g, ' ');
  let match =
    /^([-−]?)(\d{1,4})\s*(bce?|b\.c\.(?:e\.)?|ad|a\.d\.|ce|c\.e\.)?$/.exec(raw);
  let sign = 1;
  let era = '';
  let digits = '';
  if (match) {
    sign = match[1] ? -1 : 1;
    digits = match[2];
    era = match[3] || '';
  } else {
    match = /^(ad|a\.d\.)\s*(\d{1,4})$/.exec(raw);
    if (!match) return null;
    digits = match[2];
    era = 'ad';
  }
  const n = Number(digits);
  if (!n) return null;
  const bc = era.startsWith('b');
  if (bc && sign < 0) return null;
  return bc ? -n : sign * n;
}

/** A year as {n, era}: the panel words it ("500 BC", "1 AD"). */
export const yearParts = (year) =>
  year < 0 ? { n: -year, era: 'BC' } : { n: year, era: 'AD' };

/** The Cliopatria year a layer year reads (2025 is 2024). */
export const cliopatriaYear = (year) =>
  Math.min(clampYear(year), CLIOPATRIA_LAST_YEAR);

// ── Geometry ────────────────────────────────────────────────────────────

/** Coordinates are kept to 1e-4° (about 11 m) in the served text. */
export const GEOMETRY_SCALE = 1e4;

/**
 * Polygons ([[[lon, lat], …ring], …holes] each) as the served text: JSON of
 * polygons of rings, each ring its first point then the differences, in
 * units of 1e-4°, without the closing point. The server pastes these into
 * its answers as they are.
 */
export function encodePolygons(polygons) {
  const out = [];
  for (const polygon of polygons) {
    const rings = [];
    for (const ring of polygon) {
      const flat = [];
      let px = 0;
      let py = 0;
      const n =
        ring.length > 1 &&
        ring[0][0] === ring.at(-1)[0] &&
        ring[0][1] === ring.at(-1)[1]
          ? ring.length - 1
          : ring.length;
      for (let i = 0; i < n; i++) {
        const x = Math.round(ring[i][0] * GEOMETRY_SCALE);
        const y = Math.round(ring[i][1] * GEOMETRY_SCALE);
        if (i && x === px && y === py) continue;
        flat.push(x - px, y - py);
        px = x;
        py = y;
      }
      if (flat.length >= 6) rings.push(flat);
    }
    if (rings.length) out.push(rings);
  }
  return JSON.stringify(out);
}

/**
 * The served form back (parsed or text): polygons of rings, each ring a
 * Float64Array of lon, lat pairs (not closed).
 */
export function decodePolygons(served) {
  const polygons = typeof served === 'string' ? JSON.parse(served) : served;
  return (polygons || []).map((rings) =>
    rings.map((flat) => {
      const ring = new Float64Array(flat.length);
      let x = 0;
      let y = 0;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        x += flat[i];
        y += flat[i + 1];
        ring[i] = x / GEOMETRY_SCALE;
        ring[i + 1] = y / GEOMETRY_SCALE;
      }
      return ring;
    }),
  );
}

/** [west, south, east, north] of decoded polygons. */
export function polygonsBox(polygons) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const rings of polygons)
    for (let i = 0; rings[0] && i < rings[0].length; i += 2) {
      const lon = rings[0][i];
      const lat = rings[0][i + 1];
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  return [west, south, east, north];
}

function inRing(ring, lon, lat) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Whether decoded polygons hold a point (holes excluded). */
export function polygonsContain(polygons, lon, lat) {
  for (const [outer, ...holes] of polygons)
    if (inRing(outer, lon, lat) && !holes.some((h) => inRing(h, lon, lat)))
      return true;
  return false;
}

// ── Names ───────────────────────────────────────────────────────────────

/** A name folded for matching what is typed: lower case, no accents. */
export const foldName = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/**
 * How a folded name matches a folded query: 0 when it starts so (an
 * opening bracket aside), 1 when one of its words does, 2 when it holds it
 * anywhere, -1 not at all.
 */
export function nameMatchRank(folded, query) {
  const at = folded.indexOf(query);
  if (at < 0) return -1;
  if (at === 0 || (at === 1 && folded[0] === '(')) return 0;
  return /[\s(-]/.test(folded[at - 1]) ? 1 : 2;
}

/**
 * Polities matching a query, the best match first and then the largest;
 * all of them, largest first, for an empty query. `area(entry)` and
 * `folded(entry, k)` say how to read an entry.
 */
export function rankNames(
  entries,
  query,
  {
    limit = Infinity,
    area = (entry) => entry.area,
    folded = (entry) => foldName(entry.name),
  } = {},
) {
  const q = foldName(query).trim();
  const byArea = (a, b) => area(b.entry) - area(a.entry);
  const scored = [];
  entries.forEach((entry, k) => {
    const rank = q ? nameMatchRank(folded(entry, k), q) : 0;
    if (rank >= 0) scored.push({ entry, rank });
  });
  scored.sort((a, b) => a.rank - b.rank || byArea(a, b));
  return scored.slice(0, limit).map((s) => s.entry);
}

// ── Colours ─────────────────────────────────────────────────────────────

/**
 * The year view's palette: twelve mid-tone categorical colours that read on
 * a black and on a white plate alike (none near either), as [r, g, b].
 */
export const YEAR_PALETTE = Object.freeze([
  [230, 159, 0],
  [86, 180, 233],
  [0, 158, 115],
  [213, 94, 0],
  [204, 121, 167],
  [0, 114, 178],
  [181, 160, 52],
  [148, 103, 189],
  [102, 166, 30],
  [217, 95, 2],
  [27, 158, 119],
  [231, 41, 138],
]);

/** The comparison list's colours, strong and far apart, given in order. */
export const LIST_PALETTE = Object.freeze([
  [255, 59, 48],
  [0, 122, 255],
  [255, 204, 0],
  [52, 199, 89],
  [175, 82, 222],
  [255, 149, 0],
  [0, 199, 190],
  [255, 45, 146],
]);

/** FNV-1a of a string: the same polity, the same colour, every year. */
export function nameHash(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A polity's year-view colour: by its name, stable. */
export const polityColor = (name) =>
  YEAR_PALETTE[nameHash(name) % YEAR_PALETTE.length];

/** `rgba()` text of a colour and an alpha. */
export const rgba = ([r, g, b], alpha = 1) =>
  `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;

// ── The comparison list ─────────────────────────────────────────────────

const cleanName = (name) =>
  String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

/** The colour index the next entry gets: the first no entry has. */
export function nextColorIndex(list) {
  const used = new Set(list.map((entry) => entry.color));
  for (let i = 0; i < LIST_PALETTE.length; i++) if (!used.has(i)) return i;
  return list.length % LIST_PALETTE.length;
}

/**
 * A list with a polity added (by its Cliopatria name), shown, at its
 * largest unless said; unchanged when it is there already or full.
 */
export function addListEntry(
  list,
  name,
  { extent = 'max', visible = true } = {},
) {
  const key = cleanName(name);
  if (!key || list.some((entry) => entry.name === key)) return list;
  if (list.length >= MAX_LIST_ENTRIES) return list;
  return [
    ...list,
    {
      name: key,
      extent: WORLD_HISTORY_EXTENTS.includes(extent) ? extent : 'max',
      visible: visible !== false,
      color: nextColorIndex(list),
    },
  ];
}

/** A list with one entry changed: `visible` or `extent`. */
export function updateListEntry(list, name, patch) {
  return list.map((entry) => {
    if (entry.name !== name) return entry;
    const next = { ...entry };
    if ('visible' in patch) next.visible = patch.visible === true;
    if ('extent' in patch && WORLD_HISTORY_EXTENTS.includes(patch.extent))
      next.extent = patch.extent;
    return next;
  });
}

export const removeListEntry = (list, name) =>
  list.filter((entry) => entry.name !== name);

// ── The URL ─────────────────────────────────────────────────────────────

/** The state the layer keeps, with every field at its default. */
export const defaultWorldHistoryState = () => ({
  enabled: false,
  year: 1,
  mode: 'cottereau',
  places: false,
  opacity: DEFAULT_OPACITY,
  list: [],
});

const escapeName = (text) =>
  encodeURIComponent(text || '').replace(
    /[!'()*~.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The state as one token for the hash: toggle, year, mode, opacity, then
 * each list entry as `*` (shown) or `!` (hidden), `m` (max extent) or `y`
 * (at the year), and its name, e.g.
 * `1.-500.c.60~*mRoman%20Empire~!yHan%20Dynasty`. The mode is `c`
 * (Cottereau), `cp` (with place-only matches) or `a` (all). Names are
 * URI-encoded with `!'()*~.` escaped too, so they never hold a separator.
 * '' when off with nothing set.
 */
export function encodeWorldHistoryParam(state) {
  const s = { ...defaultWorldHistoryState(), ...state };
  const list = (s.list || []).slice(0, MAX_LIST_ENTRIES);
  const year = clampYear(s.year);
  const opacity = Math.round(Math.min(1, Math.max(0, s.opacity)) * 100);
  const mode = s.mode === 'all' ? 'a' : s.places ? 'cp' : 'c';
  if (
    !s.enabled &&
    !list.length &&
    year === 1 &&
    mode === 'c' &&
    opacity === Math.round(DEFAULT_OPACITY * 100)
  )
    return '';
  const parts = [`${s.enabled ? 1 : 0}.${year}.${mode}.${opacity}`];
  for (const entry of list)
    parts.push(
      `${entry.visible ? '*' : '!'}${entry.extent === 'year' ? 'y' : 'm'}${escapeName(entry.name)}`,
    );
  return parts.join('~');
}

/** encodeWorldHistoryParam's token back; defaults for what is missing. */
export function decodeWorldHistoryParam(token) {
  const state = defaultWorldHistoryState();
  const [head = '', ...entries] = String(token || '').split('~');
  const match = /^([01])\.(-?\d{1,4})\.(c|cp|a)\.(\d{1,3})$/.exec(head);
  if (match) {
    state.enabled = match[1] === '1';
    state.year = clampYear(Number(match[2]));
    state.mode = match[3] === 'a' ? 'all' : 'cottereau';
    state.places = match[3] === 'cp';
    state.opacity = Math.min(100, Number(match[4])) / 100;
  }
  for (const part of entries) {
    const entry = /^([*!])([my])(.+)$/.exec(part);
    if (!entry) continue;
    let name = entry[3];
    try {
      name = decodeURIComponent(name);
    } catch {
      continue;
    }
    state.list = addListEntry(state.list, name, {
      visible: entry[1] === '*',
      extent: entry[2] === 'y' ? 'year' : 'max',
    });
  }
  return state;
}
