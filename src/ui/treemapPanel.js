/**
 * Personal fork: the TREEMAP window (docs/TREEMAP-PLAN.md, "The window").
 * A squarified treemap of a variable cut by its address's groupings,
 * drawn on a canvas two levels at once (src/data/treemapLayout.js): click
 * a tile to go in, the breadcrumb to go out, the "…" tile to page in what
 * was too small to read. Hover shows the value with its unit scaled, its
 * share of the parent and of the whole, and its count. Colour follows the
 * first grouping's member, so a country keeps its colour as the cut
 * changes. The state (address, path) is the share link's `tm`
 * (src/data/treemapStore.js); the data comes from one source interface
 * (src/data/treemapSources.js).
 */
import { t, msg, tn, formatNumber, translateKnown } from '../i18n/index.js';
import { layoutNode, hitTest } from '../data/treemapLayout.js';
import { parseTreemapAddress } from '../data/treemapAddress.js';
import { treemapVariable } from '../data/treemapCatalog.js';
import {
  createAddressBar,
  groupingName,
  variableName,
} from './treemapAddressBar.js';

/** The address read ({variable, unit, groupings, joins}), or null. */
const parseAddress = (address) => {
  const parsed = parseTreemapAddress(String(address ?? ''));
  return parsed.ok ? parsed : null;
};

/** The canvas's height in the rail, CSS px (a floating window fills). */
export const RAIL_STAGE_PX = 240;
/** A single click waits this long for a second one (a double-click flies
 * and does not drill), ms. */
export const CLICK_DELAY_MS = 250;
/** A live variable is read again this often while shown (ms). */
export const LIVE_REFRESH_MS = 15_000;
/** Children asked a page. */
export const PAGE_LIMIT = 200;

const SOURCE_LABELS = {
  service: msg('TABLES'),
  fallback: msg('SAMPLE'),
};

/** A stable hue from a key (FNV-1a). */
export function hueOf(key) {
  let hash = 0x811c9dc5;
  const text = String(key);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/**
 * Cuts drawn in their keys' order, not by size: time (history periods, any
 * `time.*` grouping), so empires rise and shrink left to right.
 */
export const isOrderedGrouping = (id) =>
  typeof id === 'string' && (id === 'history.period' || id.startsWith('time.'));

/** A time strip's hue: early blue to late amber. */
export const orderHue = (order) => 215 - order * 180;

/**
 * The colours a view's cuts carry: a drawn tile's own when its cut has
 * them (FIXED_COLOURS), and inside a member of such a first cut its hue as
 * the family's.
 */
export function paletteFor(cuts, path) {
  const depth = path.length;
  return {
    fixedColour: (tile) =>
      FIXED_COLOURS[cuts[depth + tile.depth - 1]]?.[tile.node.key] || null,
    familyHue:
      depth > 0 ? (FIXED_COLOURS[cuts[0]]?.[path[0]]?.[0] ?? null) : null,
  };
}

/** A key's stable offset in [-range, range] (another hash than the hue's). */
export const spreadOf = (key, range) =>
  (hueOf(`${key}#`) % (2 * range + 1)) - range;

/** How far siblings' hues fan out about their family's, degrees. */
export const SIBLING_HUE_SPREAD = 34;

/**
 * Land cover in colours of its own, near ESA WorldCover's legend, muted for
 * the window: [hue, saturation %, lightness %] by the service's class keys.
 */
export const LANDCOVER_COLOURS = Object.freeze({
  'tree-cover': [128, 48, 30],
  shrubland: [42, 52, 38],
  grassland: [78, 46, 38],
  cropland: [52, 62, 42],
  'built-up': [4, 62, 44],
  bare: [30, 22, 46],
  'snow-and-ice': [200, 30, 70],
  water: [212, 62, 40],
  wetland: [178, 46, 34],
  mangroves: [158, 52, 28],
  'moss-and-lichen': [96, 24, 52],
});

/** The cuts whose members have colours of their own. */
export const FIXED_COLOURS = Object.freeze({
  'landcover.class': LANDCOVER_COLOURS,
});
const GOLDEN = 0.618033988749895;

/**
 * A sibling's place in its family's fan: its rank among its siblings
 * (largest first) stepped by the golden ratio, so neighbours in size, which
 * squarify sets side by side, land far apart in hue and lightness; by its
 * key when it has no rank. In [0, 1) for the hue and one of four steps for
 * the lightness.
 */
function fanOf(tile) {
  if (Number.isFinite(tile.rank))
    return { at: (tile.rank * GOLDEN) % 1, step: tile.rank % 4 };
  const hash = hueOf(`${tile.node.key}#`);
  return { at: (hash % 1000) / 1000, step: hash % 4 };
}

/**
 * A tile's fill. The hue family is the first cut's member: the path's first
 * key inside it, else the tile's own key (or its parent's) at the root, so
 * a member keeps its colour as the cut changes. Below the root the tiles of
 * the drawn level fan out in neighbouring hues of that family with their
 * own lightness, so siblings part at a glance; a child stays near its
 * parent's hue. The same node draws the same colours every time.
 */
export function tileColour(
  tile,
  path,
  { fixedColour = () => null, familyHue = null } = {},
) {
  if (tile.more) return 'hsl(210 10% 34%)';
  const top = tile.depth === 2 ? tile.parent : tile;
  const wrap = (hue) => ((Math.round(hue) % 360) + 360) % 360;
  const own = fanOf(tile);
  // A cut with colours of its own (land cover): each member in its colour.
  const fixed = fixedColour(tile);
  if (fixed) {
    const [h, sat, light] = fixed;
    return `hsl(${wrap(h)} ${sat}% ${light + (tile.depth === 2 ? 4 : 0)}%)`;
  }
  const topFixed = tile.depth === 2 ? fixedColour(top) : null;
  // A time strip's family is its place in time; a member with its own
  // colour gives it; else the member's key.
  const family = Number.isFinite(familyHue)
    ? familyHue
    : topFixed
      ? topFixed[0]
      : path.length === 0 && Number.isFinite(top.order)
        ? orderHue(top.order)
        : hueOf(path.length > 0 ? path[0] : top.node.key);
  if (path.length === 0) {
    // The root: each first-cut member its own hue; children shaded in it.
    if (tile.depth === 1) return `hsl(${wrap(family)} 48% 34%)`;
    return `hsl(${wrap(family + (own.at - 0.5) * 24)} 46% ${36 + own.step * 4}%)`;
  }
  const topFan = fanOf(top);
  const topHue = family + (topFan.at - 0.5) * 2 * SIBLING_HUE_SPREAD;
  if (tile.depth === 1)
    return `hsl(${wrap(topHue)} 52% ${28 + topFan.step * 5}%)`;
  return `hsl(${wrap(topHue + (own.at - 0.5) * 16)} 48% ${38 + own.step * 4}%)`;
}

/**
 * A product tile's intensive value: its own `mean` when the answer gives
 * it, else total ÷ `base`; null when it carries neither.
 */
export function productMean(tileNode) {
  if (Number.isFinite(tileNode?.mean)) return tileNode.mean;
  if (Number.isFinite(tileNode?.value) && tileNode?.base > 0)
    return tileNode.value / tileNode.base;
  return null;
}

/**
 * An intensive value as read: an elevation in whole metres (1,046 m, not
 * 1 km), anything else as formatValue writes it.
 */
export function formatMean(mean, unit) {
  if (unit === 'm' && Number.isFinite(mean))
    return `${formatNumber(Math.round(mean))} m`;
  return formatValue(mean, unit);
}

/** The intensive value's unit: the variable's over its base's (m³/m² = m). */
export function productUnit(unit, product) {
  const base = String(product?.base || '').split('/')[0];
  if (unit === 'm3' && base === 'm2') return 'm';
  return '';
}

/**
 * How many a parent drawn whole holds, in the words of the cut below it
 * ("75 districts"); a cut without its own words, "75 parts".
 */
export function countLine(count, groupingId) {
  const values = { count: formatNumber(count) };
  switch (groupingId) {
    case 'admin.continent':
      return tn(count, '{count} continent', '{count} continents', values);
    case 'admin.country':
      return tn(count, '{count} country', '{count} countries', values);
    case 'admin.region':
      return tn(count, '{count} region', '{count} regions', values);
    case 'admin.district':
      return tn(count, '{count} district', '{count} districts', values);
    case 'locality.place':
      return tn(count, '{count} place', '{count} places', values);
    case 'locality.kind':
      return tn(
        count,
        '{count} kind of place',
        '{count} kinds of place',
        values,
      );
    case 'place.category':
      return tn(count, '{count} category', '{count} categories', values);
    case 'landcover.class':
      return tn(count, '{count} land cover', '{count} land covers', values);
    case 'wikipedia.language':
      return tn(count, '{count} language', '{count} languages', values);
    case 'history.polity':
      return tn(count, '{count} polity', '{count} polities', values);
    case 'history.period':
      return tn(count, '{count} period', '{count} periods', values);
    case 'aircraft.class':
    case 'aircraft.type':
    case 'vessel.type':
      return tn(count, '{count} type', '{count} types', values);
    case 'vessel.family':
      return tn(count, '{count} family', '{count} families', values);
    default:
      return tn(count, '{count} part', '{count} parts', values);
  }
}

const PREFIXES = [
  [1e12, msg('{n} trillion')],
  [1e9, msg('{n} billion')],
  [1e6, msg('{n} million')],
];

/**
 * A value with its unit scaled for reading: km² from m², km³ from m³,
 * kB…TB from bytes, millions and billions for counts. `unit` is the
 * address's (`m2`, `m3`, `byte`, `count`, `m`).
 */
export function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const number = (n, digits = 1) =>
    formatNumber(n, { maximumFractionDigits: n >= 100 ? 0 : digits });
  const big = (n, symbol) => {
    for (const [scale, pattern] of PREFIXES)
      if (Math.abs(n) >= scale) {
        const text = t(pattern, { n: number(n / scale) });
        return symbol ? `${text} ${symbol}` : text;
      }
    return symbol ? `${number(n)} ${symbol}` : number(n, 2);
  };
  switch (unit) {
    case 'm2':
      return Math.abs(value) >= 1e6
        ? big(value / 1e6, 'km²')
        : `${number(value)} m²`;
    case 'm3':
      return Math.abs(value) >= 1e9
        ? big(value / 1e9, 'km³')
        : `${number(value)} m³`;
    case 'm':
      return Math.abs(value) >= 1e3
        ? big(value / 1e3, 'km')
        : `${number(value)} m`;
    case 'byte': {
      const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
      let n = value;
      let k = 0;
      while (Math.abs(n) >= 1000 && k < units.length - 1) {
        n /= 1000;
        k++;
      }
      return `${number(n)} ${units[k]}`;
    }
    default:
      return big(value, '');
  }
}

/** A share as a percentage ('<0.1%' under a thousandth). */
export function formatShare(share) {
  if (!Number.isFinite(share)) return '—';
  if (share > 0 && share < 0.001) return '<0.1%';
  return `${formatNumber(share * 100, { maximumFractionDigits: share < 0.1 ? 1 : 0 })}%`;
}

/** A grouping's name in the window. */
export { groupingName };

function el(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{container: Element, source: object, store: object,
 *   globe?: {outline: (ref: string|null) => void, flyTo: (ref: string) =>
 *   void}|null, sourceLabel?: Element|null, documentRef?: Document,
 *   windowRef?: Window}} options
 */
export function createTreemapPanel({
  container,
  source,
  store,
  globe = null,
  sourceLabel = null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  const root = el(documentRef, 'div', 'treemap');
  const bar = el(documentRef, 'div', 'treemap-bar');
  const crumbs = el(documentRef, 'nav', 'treemap-crumbs');
  crumbs.setAttribute('aria-label', t('Treemap path'));
  const stage = el(documentRef, 'div', 'treemap-stage');
  const canvas = el(documentRef, 'canvas', 'treemap-canvas');
  canvas.setAttribute('role', 'img');
  const card = el(documentRef, 'div', 'treemap-card');
  card.hidden = true;
  const status = el(documentRef, 'div', 'treemap-status');
  const foot = el(documentRef, 'div', 'treemap-foot');
  stage.append(canvas, card, status);
  root.append(bar, crumbs, stage, foot);
  container.replaceChildren(root);

  let catalog = null;
  let node = null;
  let layout = null;
  let hovered = null;
  let offset = 0;
  // The state the drawn tiles answer (address, path, page): a click acts
  // only on tiles of the level the store is at, never on the last level's
  // while the next one loads.
  let shownFor = null;
  const stateKey = () => {
    const state = store.get();
    return JSON.stringify([state.address, state.path, offset]);
  };
  // Crumb labels by address and path, from every answer and every tile
  // clicked into, so a level that fails keeps the names of those above it.
  const crumbLabels = new Map();
  const crumbKey = (address, keys) =>
    JSON.stringify([address, ...keys.map(String)]);
  let pendingClick = null;
  let token = 0;
  let controller = null;
  let destroyed = false;
  let error = null;
  /** Each address's root total (the whole), for the hover card. */
  const wholes = new Map();
  const removers = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    removers.push(() => target?.removeEventListener?.(type, handler, options));
  };

  const addressBar = createAddressBar({
    container: bar,
    documentRef,
    store,
    catalog: () => catalog,
  });

  function rect() {
    const width = Math.max(40, Math.floor(stage.clientWidth || 300));
    const height = Math.max(
      60,
      Math.floor(stage.clientHeight || RAIL_STAGE_PX),
    );
    return { width, height };
  }

  /** The canvas drawn: frames, tiles, labels; the hovered tile outlined. */
  function draw() {
    const { width, height } = rect();
    const ratio = Math.min(2, windowRef?.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio))
      canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio))
      canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext?.('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!node || error) return;
    const cuts = parseAddress(store.get().address)?.groupings || [];
    const depth = store.get().path.length;
    layout = layoutNode(
      node,
      { x: 0, y: 0, w: width, h: height },
      {
        ordered: isOrderedGrouping(node.level?.grouping ?? cuts[depth]),
        orderedInner: isOrderedGrouping(cuts[depth + 1]),
      },
    );
    const path = store.get().path;
    const palette = paletteFor(cuts, path);
    context.textBaseline = 'top';
    for (const tile of layout.tiles) {
      context.fillStyle = tileColour(tile, path, palette);
      context.fillRect(tile.x, tile.y, tile.w, tile.h);
      context.strokeStyle =
        tile.depth === 1 ? 'rgba(4, 10, 16, 0.95)' : 'rgba(4, 10, 16, 0.55)';
      context.lineWidth = tile.depth === 1 ? 1.5 : 0.75;
      context.strokeRect(
        tile.x + 0.5,
        tile.y + 0.5,
        Math.max(0, tile.w - 1),
        Math.max(0, tile.h - 1),
      );
    }
    // Labels: a parent's in its strip (or its corner), a leaf's where it fits.
    const parents = new Set();
    for (const tile of layout.tiles) if (tile.parent) parents.add(tile.parent);
    for (const tile of layout.tiles) {
      const hasKids = parents.has(tile);
      if (tile.depth === 2 && (tile.w < 34 || tile.h < 13)) continue;
      // A parent too short for its strip keeps its own label on top of its
      // children: theirs would print over it.
      if (tile.depth === 2 && !tile.parent?.labelStrip) continue;
      if (tile.depth === 1 && (tile.w < 26 || tile.h < 12)) continue;
      const size = tile.depth === 1 ? 10 : 9;
      context.font = `${tile.depth === 1 ? 600 : 400} ${size}px ui-monospace, Menlo, Consolas, monospace`;
      context.fillStyle =
        tile.depth === 1
          ? 'rgba(236, 248, 255, 0.95)'
          : 'rgba(225, 240, 250, 0.82)';
      const label = tile.more
        ? tn(tile.node.count, '{count} more', '{count} more', {
            count: formatNumber(tile.node.count),
          })
        : translateKnown(String(tile.node.label ?? tile.node.key));
      const room = tile.w - 6;
      let text = label;
      while (text.length > 1 && context.measureText(text).width > room)
        text = `${text.slice(0, -2)}…`;
      if (context.measureText(text).width > room) continue;
      const y = tile.depth === 1 && hasKids ? tile.y + 2 : tile.y + 3;
      context.fillText(text, tile.x + 3, y);
      // A parent drawn whole says how many it holds, under its name.
      if (tile.folded && tile.h >= 30) {
        const line = countLine(tile.folded.count, cuts[depth + 1]);
        context.font = `400 9px ui-monospace, Menlo, Consolas, monospace`;
        context.fillStyle = 'rgba(225, 240, 250, 0.72)';
        if (context.measureText(line).width <= room)
          context.fillText(line, tile.x + 3, y + 13);
      }
    }
    if (hovered) {
      const tile = layout.tiles.find(
        (candidate) =>
          candidate.node === hovered.node && candidate.depth === hovered.depth,
      );
      if (tile) {
        context.strokeStyle = 'rgba(0, 212, 255, 0.95)';
        context.lineWidth = 2;
        context.strokeRect(
          tile.x + 1,
          tile.y + 1,
          Math.max(0, tile.w - 2),
          Math.max(0, tile.h - 2),
        );
      }
    }
  }

  function renderCrumbs() {
    const state = store.get();
    const parsed = parseAddress(state.address);
    crumbs.replaceChildren();
    const rootButton = el(documentRef, 'button', 'treemap-crumb', t('All'));
    rootButton.type = 'button';
    rootButton.addEventListener('click', () => {
      offset = 0;
      store.up(0);
    });
    crumbs.append(rootButton);
    const labels = node?.path || [];
    state.path.forEach((key, index) => {
      crumbs.append(el(documentRef, 'span', 'treemap-crumb-sep', '›'));
      const label = translateKnown(
        labels[index]?.label ??
          crumbLabels.get(
            crumbKey(state.address, state.path.slice(0, index + 1)),
          ) ??
          key,
      );
      const button = el(documentRef, 'button', 'treemap-crumb', String(label));
      button.type = 'button';
      button.title = groupingName(parsed?.groupings[index] ?? '');
      if (index === state.path.length - 1 && !offset)
        button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => {
        offset = 0;
        if (!store.up(index + 1)) load();
      });
      crumbs.append(button);
    });
    if (offset > 0) {
      crumbs.append(el(documentRef, 'span', 'treemap-crumb-sep', '›'));
      crumbs.append(
        el(
          documentRef,
          'span',
          'treemap-crumb treemap-crumb-page',
          t('from #{n}', { n: formatNumber(offset + 1) }),
        ),
      );
    }
  }

  function renderFoot() {
    foot.replaceChildren();
    if (!node) return;
    const parts = [];
    const level = node.level?.grouping
      ? groupingName(node.level.grouping)
      : null;
    parts.push(
      t('Total {value}', { value: formatValue(node.total?.value, node.unit) }),
    );
    if (level) parts.push(t('by {grouping}', { grouping: level }));
    foot.append(el(documentRef, 'span', 'treemap-total', parts.join(' · ')));
    if (node.mode === 'relative')
      foot.append(
        el(
          documentRef,
          'span',
          'treemap-note',
          t('Not a sum: siblings compare, a parent is not their total'),
        ),
      );
    if (node.stops)
      foot.append(
        el(
          documentRef,
          'span',
          'treemap-note',
          t('This source stops before {grouping}', {
            grouping: groupingName(node.stops),
          }),
        ),
      );
    if (node.note)
      foot.append(
        el(documentRef, 'span', 'treemap-note', translateKnown(node.note)),
      );
    if (node.attribution)
      foot.append(
        el(
          documentRef,
          'span',
          'treemap-attribution',
          translateKnown(node.attribution),
        ),
      );
  }

  function showStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  /** `quiet`: a live refresh, drawn over what is shown without a notice. */
  async function load({ quiet = false } = {}) {
    const state = store.get();
    const mine = ++token;
    controller?.abort?.();
    controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    if (!quiet) {
      hovered = null;
      card.hidden = true;
      globe?.outline?.(null);
      showStatus(t('Loading…'));
    }
    try {
      // Asked every load: the service's part is kept by the source, the live
      // layers' part is read again (a layer turned on since counts now).
      const first = !catalog;
      catalog = await source.catalog({ signal: controller?.signal });
      if (mine !== token || destroyed) return;
      if (first) {
        if (sourceLabel) {
          const kind = source.kind?.();
          sourceLabel.textContent = SOURCE_LABELS[kind]
            ? t(SOURCE_LABELS[kind])
            : '';
          sourceLabel.title =
            kind === 'fallback'
              ? t(
                  'The treemap service does not answer here: a rounded sample is shown',
                )
              : '';
        }
      }
      // A variable the catalogue does not have, or has switched off, says so
      // instead of asking for a node.
      const variableId = parseAddress(state.address)?.variable;
      const entry = catalog?.variables?.find((v) => v.id === variableId);
      if (variableId && (!entry || entry.available === false)) {
        const name = variableName(variableId);
        const unavailable = new Error(
          entry
            ? t('{variable} is not available: {why}', {
                variable: name,
                why: translateKnown(entry.why || '') || t('no reason given'),
              })
            : t('{variable} is not built yet: pick another quantity', {
                variable: name,
              }),
        );
        unavailable.code = 'unavailable';
        throw unavailable;
      }
      const answer = await source.node(
        {
          address: state.address,
          path: state.path,
          depth: 2,
          limit: PAGE_LIMIT,
          offset,
        },
        { signal: controller?.signal },
      );
      if (mine !== token || destroyed) return;
      node = answer;
      error = null;
      shownFor = JSON.stringify([state.address, state.path, offset]);
      (answer.path || []).forEach((step, index) => {
        if (step?.label)
          crumbLabels.set(
            crumbKey(state.address, state.path.slice(0, index + 1)),
            step.label,
          );
      });
      if (!state.path.length) wholes.set(state.address, answer.total?.value);
      else if (!wholes.has(state.address))
        // A link opened below the root: the whole, asked once.
        source
          .node({ address: state.address, path: [], depth: 1, limit: 1 })
          .then((top) => wholes.set(state.address, top.total?.value))
          .catch(() => wholes.set(state.address, null));
      showStatus(node.children?.length ? '' : t('Nothing here to cut'));
    } catch (failure) {
      if (failure?.name === 'AbortError' || mine !== token || destroyed) return;
      node = null;
      error = failure;
      showStatus(
        failure?.code === 'unavailable'
          ? failure.message
          : failure?.code === 'refused'
            ? t('This cut cannot be drawn: {reason}', {
                reason: failure.message,
              })
            : t('The treemap did not load: {reason}', {
                reason: failure?.message || failure,
              }),
      );
    }
    renderCrumbs();
    renderFoot();
    addressBar.render();
    canvas.setAttribute(
      'aria-label',
      node
        ? t('Treemap of {count} parts', {
            count: formatNumber(node.children?.length || 0),
          })
        : t('Treemap'),
    );
    draw();
  }

  function cardFor(tile) {
    const parsed = parseAddress(store.get().address);
    const unit = node?.unit || parsed?.unit;
    const whole = wholes.get(store.get().address) ?? null;
    const parentValue =
      tile.depth === 2 ? tile.parent.node.value : node?.total?.value;
    const lines = [];
    const title = tile.more
      ? tn(tile.node.count, '{count} more', '{count} more', {
          count: formatNumber(tile.node.count),
        })
      : translateKnown(String(tile.node.label ?? tile.node.key));
    lines.push(['treemap-card-title', title]);
    if (tile.folded)
      lines.push([
        'treemap-card-count',
        countLine(
          tile.folded.count,
          parsed?.groupings?.[store.get().path.length + 1],
        ),
      ]);
    lines.push(['treemap-card-value', formatValue(tile.node.value, unit)]);
    // A product (volume = elevation × area): its intensive value, total ÷
    // base, when the answer carries the base (or the mean itself).
    const mean = productMean(tile.node);
    if (node?.mode === 'product' && mean !== null) {
      const product = treemapVariable(parsed?.variable)?.product;
      lines.push([
        'treemap-card-value',
        t('{what}: {value}', {
          what: product?.intensive ? t(product.intensive) : t('mean'),
          value: formatMean(mean, productUnit(unit, product)),
        }),
      ]);
    }
    if (node?.mode !== 'relative') {
      lines.push([
        'treemap-card-share',
        t('{share} of {parent}', {
          share: formatShare(tile.node.value / parentValue),
          parent:
            tile.depth === 2
              ? translateKnown(String(tile.parent.node.label))
              : translateKnown(
                  String(node?.path?.at(-1)?.label ?? t('the whole')),
                ),
        }),
      ]);
      if ((node?.path?.length || tile.depth === 2) && whole > 0)
        lines.push([
          'treemap-card-share',
          t('{share} of the whole', {
            share: formatShare(tile.node.value / whole),
          }),
        ]);
    }
    // One record is the tile itself: the count says nothing then.
    if (Number.isFinite(tile.node.count) && tile.node.count > 1)
      lines.push([
        'treemap-card-count',
        tn(tile.node.count, '{count} record', '{count} records', {
          count: formatNumber(tile.node.count),
        }),
      ]);
    if (tile.more)
      lines.push(['treemap-card-hint', t('Click to page in more')]);
    else if (tile.node.hasChildren || tile.depth === 2)
      lines.push([
        'treemap-card-hint',
        t('Click to go in; double-click to fly there'),
      ]);
    card.replaceChildren(
      ...lines.map(([className, text]) =>
        el(documentRef, 'div', className, text),
      ),
    );
  }

  function placeCard(px, py) {
    const { width, height } = rect();
    card.hidden = false;
    const w = card.offsetWidth || 160;
    const h = card.offsetHeight || 60;
    const left = px + 14 + w > width ? Math.max(0, px - 14 - w) : px + 14;
    const top = py + 14 + h > height ? Math.max(0, py - 14 - h) : py + 14;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  const pointer = (event) => {
    const box = canvas.getBoundingClientRect();
    return { px: event.clientX - box.left, py: event.clientY - box.top };
  };

  listen(canvas, 'pointermove', (event) => {
    if (!layout) return;
    const { px, py } = pointer(event);
    const tile = hitTest(layout.tiles, px, py);
    const same =
      tile &&
      hovered &&
      tile.node === hovered.node &&
      tile.depth === hovered.depth;
    if (!same) {
      hovered = tile ? { node: tile.node, depth: tile.depth } : null;
      if (tile) cardFor(tile);
      else card.hidden = true;
      globe?.outline?.(tile && !tile.more ? tile.node.geo || null : null);
      draw();
    }
    if (tile) placeCard(px, py);
  });
  listen(canvas, 'pointerleave', () => {
    hovered = null;
    card.hidden = true;
    globe?.outline?.(null);
    draw();
  });
  /** Into a tile (its label kept for the crumb). */
  const enter = (tileNode) => {
    const state = store.get();
    if (tileNode.label)
      crumbLabels.set(
        crumbKey(state.address, [...state.path, tileNode.key]),
        tileNode.label,
      );
    store.enter(tileNode.key);
  };
  const act = (tile) => {
    if (tile.more) {
      // The "…" of this level pages on; a parent's goes into the parent.
      if (tile.depth === 1) {
        offset += tile.node.from;
        load();
      } else {
        offset = tile.node.from;
        enter(tile.parent.node);
      }
      return;
    }
    const top = tile.depth === 2 ? tile.parent : tile;
    if (!top.node.hasChildren) return;
    offset = 0;
    enter(top.node);
  };
  const cancelClick = () => {
    if (pendingClick) windowRef?.clearTimeout?.(pendingClick);
    pendingClick = null;
  };
  listen(canvas, 'click', (event) => {
    // The second click of a double-click is the double-click's.
    if (event.detail >= 2) return cancelClick();
    if (!layout || shownFor !== stateKey()) return;
    const { px, py } = pointer(event);
    const tile = hitTest(layout.tiles, px, py);
    if (!tile) return;
    cancelClick();
    const at = stateKey();
    const run = () => {
      pendingClick = null;
      // Still the level it was clicked on.
      if (destroyed || shownFor !== at || stateKey() !== at) return;
      act(tile);
    };
    if (windowRef?.setTimeout)
      pendingClick = windowRef.setTimeout(run, CLICK_DELAY_MS);
    else run();
  });
  removers.push(cancelClick);
  listen(canvas, 'dblclick', (event) => {
    cancelClick();
    if (!layout) return;
    const { px, py } = pointer(event);
    const tile = hitTest(layout.tiles, px, py);
    const ref =
      tile?.node?.geo || (tile?.depth === 2 ? tile.parent.node.geo : null);
    if (ref) globe?.flyTo?.(ref);
  });

  removers.push(
    store.subscribe(() => {
      load();
    }),
  );
  // A live variable (aircraft, vessels) is read again every
  // LIVE_REFRESH_MS while the window is open and nothing is hovered.
  const liveTimer = windowRef?.setInterval?.(() => {
    if (destroyed || hovered || !root.isConnected) return;
    if (root.offsetParent === null) return;
    const variable = parseAddress(store.get().address)?.variable;
    if (treemapVariable(variable)?.source !== 'live') return;
    load({ quiet: true });
  }, LIVE_REFRESH_MS);
  if (liveTimer) removers.push(() => windowRef.clearInterval(liveTimer));
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => draw());
    observer.observe(stage);
    removers.push(() => observer.disconnect());
  }

  load();

  return {
    root,
    reload: () => load(),
    redraw: () => draw(),
    /** For the harness and tests: the node and the tiles as drawn. */
    state: () => ({ node, tiles: layout?.tiles || [], offset, error, catalog }),
    destroy() {
      destroyed = true;
      token++;
      controller?.abort?.();
      globe?.outline?.(null);
      addressBar.destroy();
      for (const remove of removers.splice(0)) remove();
      root.remove();
    },
  };
}
