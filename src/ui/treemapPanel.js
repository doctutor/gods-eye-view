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
import { parseAddress } from '../data/treemapWindowAddress.js';
import {
  TREEMAP_CATALOG_PLAN,
  TREEMAP_GROUPING_NAMES,
} from '../data/treemapCatalogPlan.js';
import { createAddressBar } from './treemapAddressBar.js';

/** The canvas's height in the rail, CSS px (a floating window fills). */
export const RAIL_STAGE_PX = 240;
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
 * A tile's fill: the hue of its first-grouping member (the path's first
 * key below the root, else its own or its parent's key at the root), its
 * lightness varied by its own key so siblings part.
 */
export function tileColour(tile, path) {
  const firstKey =
    path.length > 0
      ? path[0]
      : tile.depth === 2
        ? tile.parent.node.key
        : tile.node.key;
  if (tile.more) return 'hsl(210 10% 34%)';
  const hue = hueOf(firstKey);
  const own = hueOf(`${tile.node.key}~`) % 14;
  const light = tile.depth === 1 ? 30 + own : 38 + own;
  return `hsl(${hue} 46% ${light}%)`;
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
export const groupingName = (id) =>
  TREEMAP_GROUPING_NAMES[id] ? t(TREEMAP_GROUPING_NAMES[id]) : id;

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
 *   windowRef?: Window, catalogPlan?: object[]}} options
 */
export function createTreemapPanel({
  container,
  source,
  store,
  globe = null,
  sourceLabel = null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  catalogPlan = TREEMAP_CATALOG_PLAN,
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
    catalogPlan,
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
    layout = layoutNode(node, { x: 0, y: 0, w: width, h: height });
    const path = store.get().path;
    context.textBaseline = 'top';
    for (const tile of layout.tiles) {
      context.fillStyle = tileColour(tile, path);
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
      const label = translateKnown(labels[index]?.label ?? key);
      const button = el(documentRef, 'button', 'treemap-crumb', String(label));
      button.type = 'button';
      button.title = groupingName(parsed?.groupings[index]?.id ?? '');
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

  async function load() {
    const state = store.get();
    const mine = ++token;
    controller?.abort?.();
    controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    hovered = null;
    card.hidden = true;
    globe?.outline?.(null);
    showStatus(t('Loading…'));
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
        const planned = catalogPlan.find((row) => row.id === variableId);
        const name = planned ? t(planned.name) : variableId;
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
    lines.push(['treemap-card-value', formatValue(tile.node.value, unit)]);
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
  listen(canvas, 'click', (event) => {
    if (!layout) return;
    const { px, py } = pointer(event);
    const tile = hitTest(layout.tiles, px, py);
    if (!tile) return;
    if (tile.more) {
      // The "…" of this level pages on; a parent's goes into the parent.
      if (tile.depth === 1) {
        offset += tile.node.from;
        load();
      } else {
        offset = tile.node.from;
        store.enter(tile.parent.node.key);
      }
      return;
    }
    const top = tile.depth === 2 ? tile.parent : tile;
    if (!top.node.hasChildren) return;
    offset = 0;
    store.enter(top.node.key);
  });
  listen(canvas, 'dblclick', (event) => {
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
