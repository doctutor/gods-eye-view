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
