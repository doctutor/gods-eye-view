// Personal fork: the treemap window's own squarify (treemapLayout.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  squarify,
  layoutLevel,
  layoutNode,
  hitTest,
  MIN_TILE_AREA_PX,
  LABEL_STRIP_PX,
} from './treemapLayout.js';

const area = (box) => box.w * box.h;
const aspect = (box) => Math.max(box.w / box.h, box.h / box.w);

test('squarify: each tile’s area is its share of the rectangle', () => {
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rect = { x: 0, y: 0, w: 600, h: 400 };
  const boxes = squarify(
    values.map((value) => ({ value })),
    rect,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  assert.equal(boxes.length, values.length);
  for (const box of boxes)
    assert.ok(
      Math.abs(area(box) - (box.item.value / total) * area(rect)) < 1e-6,
      `${box.item.value}: ${area(box)}`,
    );
  // Inside the rectangle and not overlapping.
  for (const box of boxes) {
    assert.ok(box.x >= -1e-9 && box.y >= -1e-9);
    assert.ok(box.x + box.w <= rect.w + 1e-6 && box.y + box.h <= rect.h + 1e-6);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap =
        Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-6, `${i} overlaps ${j}`);
    }
});

test('squarify: the canonical example (6,6,4,3,2,2,1 in 6×4) keeps every aspect under 3', () => {
  const boxes = squarify(
    [6, 6, 4, 3, 2, 2, 1].map((value) => ({ value })),
    { x: 0, y: 0, w: 6, h: 4 },
  );
  for (const box of boxes) assert.ok(aspect(box) < 3, `${aspect(box)}`);
});

test('squarify: aspect stays bounded on long-tailed values (no slivers among comparable tiles)', () => {
  const values = Array.from({ length: 60 }, (_, i) => 1000 / (i + 1));
  const boxes = squarify(
    values.map((value) => ({ value })),
    { x: 0, y: 0, w: 800, h: 500 },
  );
  // Squarified rows: the median tile is close to square, and no tile is
  // worse than a strip would be.
  const ratios = boxes.map(aspect).sort((a, b) => a - b);
  assert.ok(ratios[Math.floor(ratios.length / 2)] < 2.5, `${ratios}`);
  assert.ok(ratios.at(-1) < 12, `${ratios.at(-1)}`);
});

test('layoutLevel: children too small to read fold into one "…" tile, which holds their sum', () => {
  const children = [
    { key: 'a', value: 1000 },
    { key: 'b', value: 500 },
    ...Array.from({ length: 300 }, (_, i) => ({ key: `t${i}`, value: 1 })),
  ];
  const { tiles, rest } = layoutLevel(children, null, {
    x: 0,
    y: 0,
    w: 300,
    h: 200,
  });
  assert.ok(rest, 'a rest tile');
  const more = tiles.find((tile) => tile.item.more);
  assert.ok(more);
  assert.equal(more.item.label, '…');
  const shown = tiles.filter((tile) => !tile.item.more);
  assert.equal(more.item.count + shown.length, children.length);
  const shownSum = shown.reduce((sum, tile) => sum + tile.item.value, 0);
  assert.equal(more.item.value + shownSum, 1800);
  // `from`: the first folded child, for paging.
  assert.equal(more.item.from, shown.length);
  for (const tile of shown)
    assert.ok(area(tile) >= MIN_TILE_AREA_PX * 0.999, `${area(tile)}`);
});

test('layoutLevel: the contract’s own rest (children past the limit) joins the "…" tile', () => {
  const { tiles } = layoutLevel(
    [
      { key: 'a', value: 50 },
      { key: 'b', value: 30 },
    ],
    { count: 40, value: 20 },
    { x: 0, y: 0, w: 400, h: 300 },
  );
  const more = tiles.find((tile) => tile.item.more);
  assert.equal(more.item.count, 40);
  assert.equal(more.item.value, 20);
  assert.equal(more.item.from, 2);
});

test('layoutNode: two levels, a label strip on parents with room, hitTest finds the deepest tile', () => {
  const node = {
    children: [
      {
        key: 'asia',
        label: 'Asia',
        value: 60,
        children: [
          { key: 'cn', label: 'China', value: 30 },
          { key: 'in', label: 'India', value: 30 },
        ],
      },
      { key: 'eu', label: 'Europe', value: 40 },
    ],
    rest: null,
  };
  const { tiles } = layoutNode(node, { x: 0, y: 0, w: 500, h: 300 });
  const asia = tiles.find((tile) => tile.node.key === 'asia');
  assert.equal(asia.depth, 1);
  assert.equal(asia.labelStrip, true);
  const kids = tiles.filter((tile) => tile.parent === asia);
  assert.equal(kids.length, 2);
  for (const kid of kids) {
    assert.equal(kid.depth, 2);
    assert.ok(kid.y >= asia.y + LABEL_STRIP_PX - 1e-6, 'below the strip');
    assert.ok(kid.x >= asia.x && kid.x + kid.w <= asia.x + asia.w + 1e-6);
  }
  const china = kids.find((tile) => tile.node.key === 'cn');
  assert.equal(
    hitTest(tiles, china.x + china.w / 2, china.y + china.h / 2),
    china,
  );
  // The strip itself hits the parent.
  assert.equal(hitTest(tiles, asia.x + 4, asia.y + 3), asia);
  assert.equal(hitTest(tiles, -5, -5), null);
});

test('layoutNode stays responsive with 200 children × 200 grandchildren', () => {
  const node = {
    children: Array.from({ length: 200 }, (_, i) => ({
      key: `c${i}`,
      value: 1e6 / (i + 1),
      children: Array.from({ length: 200 }, (_, j) => ({
        key: `c${i}g${j}`,
        value: 1e4 / (j + 1),
      })),
    })),
    rest: null,
  };
  const rect = { x: 0, y: 0, w: 1150, h: 640 };
  layoutNode(node, rect); // warm
  const started = performance.now();
  const { tiles } = layoutNode(node, rect);
  const ms = performance.now() - started;
  assert.ok(tiles.length > 50);
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`);
  // The area is all used: the depth-1 tiles fill the rectangle.
  const top = tiles
    .filter((tile) => tile.depth === 1)
    .reduce((sum, tile) => sum + area(tile), 0);
  assert.ok(Math.abs(top - area(rect)) / area(rect) < 1e-6);
});

test('a time cut lays out in its keys’ order (years, before Christ first), strips as wide as their share', async () => {
  const { sliceLevel, compareKeys } = await import('./treemapLayout.js');
  // As the service sends them: largest first.
  const periods = [
    { key: '1950', label: '1950–1999', value: 40 },
    { key: '-500', label: '500–451 BCE', value: 10 },
    { key: '1000', label: '1000–1049', value: 30 },
    { key: '-3000', label: '3000–2951 BCE', value: 0 },
    { key: '0', label: '0–49', value: 20 },
  ];
  const { tiles, rest } = sliceLevel(
    periods,
    { count: 2, value: 10 },
    {
      x: 10,
      y: 5,
      w: 220,
      h: 100,
    },
  );
  assert.deepEqual(
    tiles.map((tile) => tile.node.key),
    ['-500', '0', '1000', '1950', '…'],
  );
  assert.equal(rest.from, 4);
  // Left to right, edge to edge, widths in proportion, full height.
  let x = 10;
  for (const tile of tiles) {
    assert.ok(Math.abs(tile.x - x) < 1e-9);
    assert.equal(tile.h, 100);
    assert.ok(Math.abs(tile.w - (220 * tile.node.value) / 110) < 1e-9);
    x += tile.w;
  }
  assert.ok(Math.abs(x - 230) < 1e-9);
  assert.deepEqual(
    tiles.map((tile) => tile.order),
    [0, 0.25, 0.5, 0.75, 1],
  );
  assert.ok(compareKeys('-500', '0') < 0 && compareKeys('a2', 'a10') < 0);
  // layoutNode: the ordered level as strips, its children still squarified.
  const node = {
    children: periods.map((period) => ({
      ...period,
      children: [
        { key: `${period.key}-a`, value: period.value * 0.7 },
        { key: `${period.key}-b`, value: period.value * 0.3 },
      ],
    })),
    rest: null,
  };
  const laid = layoutNode(
    node,
    { x: 0, y: 0, w: 800, h: 400 },
    { ordered: true },
  );
  const strips = laid.tiles.filter((tile) => tile.depth === 1);
  assert.deepEqual(
    strips.map((tile) => tile.node.key),
    ['-500', '0', '1000', '1950'],
  );
  for (let k = 1; k < strips.length; k++)
    assert.ok(strips[k].x > strips[k - 1].x);
  assert.ok(laid.tiles.some((tile) => tile.depth === 2));
});

test('a parent whose "…" would fill most of it is drawn whole, with its count; one its children fill keeps its level', async () => {
  const { INNER_MORE_MAX_SHARE } = await import('./treemapLayout.js');
  // India at rail size: 38 regions, a few large and many small, the rest
  // past the service's 50 a parent.
  const regions = Array.from({ length: 38 }, (_, k) => ({
    key: `IN-${k}`,
    value: k < 2 ? 40 : 0.5,
  }));
  const node = {
    children: [
      {
        key: 'IN',
        value: 300,
        children: regions,
        rest: { count: 36, value: 150 },
      },
      {
        key: 'JP',
        value: 200,
        children: [
          { key: 'JP-1', value: 120 },
          { key: 'JP-2', value: 80 },
        ],
      },
    ],
    rest: null,
  };
  const { tiles } = layoutNode(node, { x: 0, y: 0, w: 300, h: 220 });
  const india = tiles.find((tile) => tile.node.key === 'IN');
  const japan = tiles.find((tile) => tile.node.key === 'JP');
  assert.deepEqual(india.folded, { count: 74 });
  assert.equal(tiles.filter((tile) => tile.parent === india).length, 0);
  assert.equal(india.labelStrip, undefined, 'no strip: drawn whole');
  assert.equal(japan.folded, undefined);
  assert.equal(tiles.filter((tile) => tile.parent === japan).length, 2);
  assert.equal(INNER_MORE_MAX_SHARE, 0.5);
  // The service's own tail is most of India: drawn whole at any size.
  const tall = layoutNode(node, { x: 0, y: 0, w: 2400, h: 1600 });
  assert.ok(tall.tiles.find((tile) => tile.node.key === 'IN').folded);
  // With a small tail and room enough, its own level reads again.
  node.children[0].rest = { count: 36, value: 20 };
  const wide = layoutNode(node, { x: 0, y: 0, w: 2400, h: 1600 });
  const big = wide.tiles.find((tile) => tile.node.key === 'IN');
  assert.equal(big.folded, undefined);
  const tail = wide.tiles.find((tile) => tile.parent === big && tile.node.more);
  if (tail)
    assert.ok(
      tail.w * tail.h <= INNER_MORE_MAX_SHARE * big.w * big.h,
      'the tail stays a minority',
    );
});
