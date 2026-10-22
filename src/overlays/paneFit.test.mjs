// Personal fork: paneFitPlacement (src/overlays/worldOverlayDraw.js), the
// placement for a click card its four sides would lose: on a fake 720 × 507
// viewport with the app's chrome, every anchor gets a card inside the pane,
// clear of the chrome, off the anchor and inside the keyhole, its corner
// flipped to where it landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getKeyholeGeometry,
  keyholeLabelAlphaFromGeometry,
} from '../celestialRing.js';
import { keyholeVisibility, paneFitPlacement } from './worldOverlayDraw.js';

const W = 720;
const H = 507;
const keyhole = getKeyholeGeometry(W, H);
const alphaAt = (x, y) => keyholeLabelAlphaFromGeometry(x, y, keyhole);
// The chrome at this size, inflated as the host does (6 px).
const exclusions = [
  { x: -6, y: -6, w: 732, h: 56 }, // title bar
  { x: 2, y: 46, w: 372, h: 452 }, // left panel stack
  { x: 670, y: 46, w: 52, h: 412 }, // right context rail
  { x: 194, y: 449, w: 332, h: 60 }, // command dock
];
const card = { width: 240, height: 96 };
const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const fit = (anchorX, anchorY, extra = {}) =>
  paneFitPlacement({
    anchorX,
    anchorY,
    ...card,
    viewportWidth: W,
    viewportHeight: H,
    gap: 12,
    exclusions,
    keyhole,
    ...extra,
  });

test('every anchor in the pane gets a card inside it, clear, uncovered and visible', () => {
  let checked = 0;
  for (let x = 20; x < W; x += 50)
    for (let y = 20; y < H; y += 40) {
      const placement = fit(x, y);
      assert.ok(placement, `a card for (${x}, ${y})`);
      const { rect } = placement;
      assert.ok(
        rect.x >= 4 && rect.y >= 4 && rect.x + rect.w <= W - 4,
        `inside the pane: ${JSON.stringify(rect)}`,
      );
      assert.ok(rect.y + rect.h <= H - 4);
      for (const zone of exclusions)
        assert.equal(overlaps(rect, zone), false, `clear of the chrome`);
      assert.ok(alphaAt(placement.centerX, placement.centerY) >= 0.5);
      assert.equal(
        x > rect.x - 12 &&
          x < rect.x + rect.w + 12 &&
          y > rect.y - 12 &&
          y < rect.y + rect.h + 12,
        false,
        `(${x}, ${y}) uncovered`,
      );
      checked++;
    }
  assert.ok(checked > 100);
});

test('the corner follows where the card landed, so the leader meets it', () => {
  // In the clear middle with room above: above the anchor, centred.
  const above = fit(520, 300);
  assert.equal(above.corner, 'above');
  assert.equal(above.rect.y + above.rect.h, 300 - 12);
  assert.equal(above.leadToX, 520);
  // Near the top, no room above under the title bar: flipped below.
  const below = fit(520, 70);
  assert.equal(below.corner, 'below');
  assert.ok(below.rect.y >= 70 + 12);
  // Under the left panel: beside it to the right, the leader running
  // across to the card's near edge.
  const beside = fit(200, 250);
  assert.equal(beside.corner, 'right');
  assert.ok(beside.rect.x >= 374);
  assert.equal(beside.leadToX, beside.rect.x);
  assert.ok(
    beside.leadToY >= beside.rect.y &&
      beside.leadToY <= beside.rect.y + beside.rect.h,
  );
});

test('keyhole visibility: whole inside, none past the feather, the paint fade agreeing', () => {
  const { centerX, centerY, radius, featherPx } = keyhole;
  assert.equal(keyholeVisibility(centerX, centerY, keyhole), 1);
  assert.equal(keyholeVisibility(centerX + radius, centerY, keyhole), 1);
  assert.equal(
    keyholeVisibility(centerX + radius + featherPx + 1, centerY, keyhole),
    0,
  );
  const mid = keyholeVisibility(
    centerX + radius + featherPx / 2,
    centerY,
    keyhole,
  );
  assert.ok(Math.abs(mid - 0.5) < 1e-9);
  // Where it says visible, the paint's own fade does too.
  for (let x = 0; x < W; x += 30)
    for (let y = 0; y < H; y += 30)
      if (keyholeVisibility(x, y, keyhole) >= 0.5)
        assert.ok(alphaAt(x, y) >= 0.5);
  assert.equal(keyholeVisibility(5, 5, null), 1);
});

test('without chrome or a keyhole it is just the nearest clear side; it gives up when the card cannot fit', () => {
  const plain = paneFitPlacement({
    anchorX: 360,
    anchorY: 250,
    ...card,
    viewportWidth: W,
    viewportHeight: H,
  });
  assert.equal(plain.corner, 'above');
  assert.deepEqual(plain.rect, { x: 240, y: 142, w: 240, h: 96 });
  // A card larger than the pane, or chrome everywhere: none.
  assert.equal(fit(360, 250, { width: 800 }), null);
  assert.equal(
    fit(360, 250, { exclusions: [{ x: 0, y: 0, w: W, h: H }] }),
    null,
  );
  assert.equal(fit(NaN, 250), null);
});
