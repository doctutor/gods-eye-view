/**
 * Personal fork: the treemap navigator's layout (docs/TREEMAP-PLAN.md),
 * pure. Squarified rectangles (Bruls, Huizing and van Wijk, 2000): the
 * children, largest first, are laid in rows along the rectangle's shorter
 * side, a row growing while its worst aspect ratio improves. No d3: this
 * code base is plain JavaScript.
 *
 * layoutNode draws two levels at once: a node's children, and inside each
 * child that carries its own children (depth 2) those, below a strip for
 * the child's label. A tile too small to read joins one "…" tile per
 * parent with the rest the service left out past its limit (`rest`).
 */

/** Below this many px² a tile joins its parent's "…" tile. */
export const MIN_TILE_AREA_PX = 18 * 14;
/** Below this many px on its shorter side a tile joins the "…" tile. */
export const MIN_TILE_SIDE_PX = 6;
/** A parent's label strip, px, when it is tall enough to carry one. */
export const LABEL_STRIP_PX = 15;
/** Inner padding of a parent frame, px. */
export const FRAME_PAD_PX = 2;

/**
 * The worst aspect ratio of a row of areas laid along a side of `side`:
 * its largest `max` and smallest `min` area (the row is sorted, largest
 * first, so they are its first and last), their sum `sum`.
 */
function worst(max, min, sum, side) {
  if (!(sum > 0) || !(side > 0) || !(min > 0)) return Infinity;
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Squarify `items` (already sorted by value, largest first, values > 0)
 * into `rect` ({x, y, w, h}); `valueOf(item)` its value.
 * @returns {{item: object, x: number, y: number, w: number, h: number}[]}
 *   in the order given
 */
export function squarify(items, rect, valueOf = (item) => item.value) {
  const out = [];
  const total = items.reduce((sum, item) => sum + (valueOf(item) || 0), 0);
  if (!(total > 0) || !(rect.w > 0) || !(rect.h > 0)) return out;
  const scale = (rect.w * rect.h) / total;
  const areas = items.map((item) => Math.max(0, valueOf(item) || 0) * scale);
  let { x, y, w, h } = rect;
  let start = 0;
  while (start < items.length) {
    const side = Math.min(w, h);
    let end = start;
    let sum = 0;
    let best = Infinity;
    // Grow the row while its worst aspect improves.
    while (end < items.length) {
      const next = sum + areas[end];
      const ratio = worst(areas[start], areas[end], next, side);
      if (end > start && ratio > best) break;
      best = ratio;
      sum = next;
      end++;
    }
    // Lay the row along the shorter side.
    if (w >= h) {
      // A column at the left, `side` tall.
      const columnW = sum > 0 ? sum / h : 0;
      let cy = y;
      for (let k = start; k < end; k++) {
        const tileH = columnW > 0 ? areas[k] / columnW : 0;
        out.push({ item: items[k], x, y: cy, w: columnW, h: tileH });
        cy += tileH;
      }
      x += columnW;
      w -= columnW;
    } else {
      const rowH = sum > 0 ? sum / w : 0;
      let cx = x;
      for (let k = start; k < end; k++) {
        const tileW = rowH > 0 ? areas[k] / rowH : 0;
        out.push({ item: items[k], x: cx, y, w: tileW, h: rowH });
        cx += tileW;
      }
      y += rowH;
      h -= rowH;
    }
    start = end;
  }
  return out;
}

const readable = (box, minArea, minSide) =>
  box.w * box.h >= minArea && Math.min(box.w, box.h) >= minSide;

/**
 * One level: `children` and the `rest` past the service's limit ({count,
 * value} or null) in `rect`. Children whose tile would be too small to
 * read join the rest, which draws as one "…" tile (`more: true`, its
 * `count` and `value`, `from` the index of the first child it holds, in
 * value order), laid among the others by its size. The fold is found in a
 * few passes: lay, fold from the first unreadable child on, lay again.
 * @returns {{tiles: object[], rest: object|null}}
 */
export function layoutLevel(
  children,
  rest,
  rect,
  { minArea = MIN_TILE_AREA_PX, minSide = MIN_TILE_SIDE_PX } = {},
) {
  const items = (children || [])
    .filter((child) => child.value > 0)
    .sort((a, b) => b.value - a.value);
  const restOf = (from) => {
    let value = rest?.value > 0 ? rest.value : 0;
    for (let k = from; k < items.length; k++) value += items[k].value;
    const count = items.length - from + (rest?.count > 0 ? rest.count : 0);
    return value > 0 && count > 0
      ? { more: true, key: '…', label: '…', value, count, from }
      : null;
  };
  const lay = (kept) => {
    const tail = restOf(kept);
    const list = items.slice(0, kept);
    if (tail) list.push(tail);
    list.sort((a, b) => b.value - a.value);
    const boxes = squarify(list, rect);
    return { tail, boxes };
  };
  let kept = items.length;
  let laid = lay(kept);
  for (let pass = 0; pass < 6; pass++) {
    const boxOf = new Map(laid.boxes.map((box) => [box.item, box]));
    let firstSmall = -1;
    for (let k = 0; k < kept; k++) {
      const box = boxOf.get(items[k]);
      if (!box || !readable(box, minArea, minSide)) {
        firstSmall = k;
        break;
      }
    }
    if (firstSmall < 0) break;
    // At least one tile stays, so a parent is never only "…".
    const next = Math.max(1, firstSmall);
    if (next === kept) break;
    kept = next;
    laid = lay(kept);
  }
  return {
    tiles: laid.boxes.map((box) => ({ ...box, node: box.item })),
    rest: laid.tail,
  };
}

/**
 * A node's two levels in `rect`: its children's tiles (`depth` 1), and in
 * each child with children of its own and room for them, its children
 * (`depth` 2) below a label strip. Each tile: {x, y, w, h, node, depth,
 * parent (the depth-1 tile, for depth 2), labelStrip (depth 1: whether a
 * strip is reserved), more (the "…" tile)}. A child's own `rest` (its
 * children past the limit, the contract's) joins its "…" tile.
 * @returns {{tiles: object[], rest: object|null}}
 */
export function layoutNode(node, rect, options = {}) {
  const top = layoutLevel(node?.children, node?.rest, rect, options);
  const tiles = [];
  for (const tile of top.tiles) {
    const outer = { ...tile, depth: 1, more: tile.node.more === true };
    tiles.push(outer);
    const kids = tile.node.children;
    if (outer.more || !Array.isArray(kids) || !kids.length) continue;
    const strip = tile.h >= LABEL_STRIP_PX * 2.4 ? LABEL_STRIP_PX : 0;
    const inner = {
      x: tile.x + FRAME_PAD_PX,
      y: tile.y + strip + FRAME_PAD_PX,
      w: tile.w - 2 * FRAME_PAD_PX,
      h: tile.h - strip - 2 * FRAME_PAD_PX,
    };
    if (!(inner.w > 4 && inner.h > 4)) continue;
    outer.labelStrip = strip > 0;
    const level = layoutLevel(kids, tile.node.rest || null, inner, options);
    for (const child of level.tiles)
      tiles.push({
        ...child,
        depth: 2,
        parent: outer,
        more: child.node.more === true,
      });
  }
  return { tiles, rest: top.rest };
}

/** The tile under (px, py), deepest first; null when none. */
export function hitTest(tiles, px, py) {
  let hit = null;
  for (const tile of tiles) {
    if (
      px < tile.x ||
      py < tile.y ||
      px >= tile.x + tile.w ||
      py >= tile.y + tile.h
    )
      continue;
    if (!hit || tile.depth > hit.depth) hit = tile;
  }
  return hit;
}
