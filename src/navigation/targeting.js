/**
 * Personal fork: the targeted block, live (target.js). While Blocks is
 * drawn (blocksSource.js), at most every TARGET_MS after a frame: in Walk
 * or Fly the block under the crosshair (the camera's own direction), in
 * Spectator the block under the mouse pointer (Cesium's pick ray there).
 * The ray is walked through the store's occupancy (worlds.js raycast) in
 * the Blocks region's frame; where that finds nothing (the ray leaves the
 * loaded chunks, or starts outside them), the depth pick at the same
 * place, snapped to the block it lies on. `onTarget` hears the facts when
 * the block changes, and null when nothing is targeted.
 */
import { reliefOf, trueHeightM } from '../layers/blocks/relief.js';
import * as Cesium from 'cesium';
import { CHUNK_COLUMNS } from '../layers/blocks/grid.js';
import { blocksWorldNow } from './blocksSource.js';
import { createBlockWorld } from './worlds.js';
import { blockFacts, sameBlock, snapToBlock } from './target.js';

/** The targeted block is looked for at most this often. */
export const TARGET_MS = 100;
/** How far a ray is walked through the blocks: 2048 blocks, at most 20 km. */
export const targetReachM = (blockM) => Math.min(20_000, 2048 * blockM);

/**
 * The Blocks region's frame, as the renderer places it: east-north-up at
 * the region's origin lifted by `geoidM`, each chunk lowered by its drop
 * below the tangent plane (grid.js chunkOrigin). Under the Relief
 * (`world.relief`, relief.js) the blocks are drawn exaggerated: a world
 * point's height is taken back to the true one, and a direction's up part
 * shrinks by the factor (the mapping is affine in height).
 */
export function regionFrame(world, cesium = Cesium) {
  const { region } = world;
  const geoidM = Number(world.geoidM) || 0;
  const relief = reliefOf(world.relief);
  const frame = cesium.Transforms.eastNorthUpToFixedFrame(
    cesium.Cartesian3.fromDegrees(region.lon0, region.lat0, 0),
  );
  const inverse = cesium.Matrix4.inverseTransformation(
    frame,
    new cesium.Matrix4(),
  );
  const chunkM = CHUNK_COLUMNS * region.blockM;
  const dropAt = (x, y) =>
    region.chunkOrigin(Math.floor(x / chunkM), Math.floor(y / chunkM)).z;
  return {
    /** A world point in region metres, z above mean sea level. */
    toLocal(position) {
      const p = cesium.Matrix4.multiplyByPoint(
        inverse,
        position,
        new cesium.Cartesian3(),
      );
      const drop = dropAt(p.x, p.y);
      return {
        x: p.x,
        y: p.y,
        z: trueHeightM(p.z - drop, relief) - geoidM,
      };
    },
    /** A world direction in the region's axes. */
    toLocalDirection(direction) {
      const d = cesium.Matrix4.multiplyByPointAsVector(
        inverse,
        direction,
        new cesium.Cartesian3(),
      );
      return { x: d.x, y: d.y, z: d.z / relief.factor };
    },
  };
}

/**
 * The block a world ray targets in a Blocks world, or null: walked through
 * occupancy, else `pickPosition()` (a world point, or undefined) snapped.
 */
export function targetAlongRay(
  world,
  ray,
  { pickPosition = () => undefined, cesium = Cesium } = {},
) {
  const frame = regionFrame(world, cesium);
  const origin = frame.toLocal(ray.origin);
  const direction = frame.toLocalDirection(ray.direction);
  const blocks = createBlockWorld({
    region: world.region,
    chunkAt: world.chunkAt,
  });
  const blockM = world.region.blockM;
  const hit = blocks.raycast(origin, direction, targetReachM(blockM));
  const sourceName = world.sourceName || '';
  if (hit) return blockFacts(world, hit, sourceName);
  let picked;
  try {
    picked = pickPosition();
  } catch {
    picked = undefined;
  }
  if (!picked) return null;
  return blockFacts(
    world,
    snapToBlock(
      frame.toLocal(picked),
      direction,
      blockM,
      world.region.levelM > 0 ? world.region.levelM : blockM,
    ),
    sourceName,
  );
}

/**
 * Track the targeted block for the HUD (and the outline): `store` is the
 * navigation mode's (store.js), `blocks` the Blocks world getter.
 */
export function createBlockTargeting({
  viewer,
  store,
  blocks = blocksWorldNow,
  onTarget = null,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  cesium = Cesium,
}) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const canvas = scene.canvas;
  let pointer = null;
  let current = null;
  let lastAt = -Infinity;

  const tell = (facts) => {
    if (sameBlock(facts, current)) return;
    current = facts;
    try {
      onTarget?.(facts);
    } catch {
      /* observer only */
    }
  };

  /** The ray targeting goes along now, and where its depth pick is. */
  const rayNow = () => {
    const mode = store?.get?.() ?? 'spectator';
    if (mode === 'walk' || mode === 'fly') {
      const centre = new cesium.Cartesian2(
        (canvas.clientWidth || canvas.width) / 2,
        (canvas.clientHeight || canvas.height) / 2,
      );
      return {
        ray: new cesium.Ray(
          cesium.Cartesian3.clone(camera.positionWC),
          cesium.Cartesian3.clone(camera.directionWC),
        ),
        at: centre,
      };
    }
    if (!pointer) return null;
    const at = new cesium.Cartesian2(pointer.x, pointer.y);
    const ray = camera.getPickRay(at);
    return ray ? { ray, at } : null;
  };

  const update = () => {
    const t = now();
    if (t - lastAt < TARGET_MS) return;
    lastAt = t;
    const world = blocks();
    if (!world) return tell(null);
    const aim = rayNow();
    if (!aim) return tell(null);
    let facts = null;
    try {
      facts = targetAlongRay(world, aim.ray, {
        cesium,
        pickPosition: () =>
          scene.pickPositionSupported ? scene.pickPosition(aim.at) : undefined,
      });
    } catch {
      facts = null;
    }
    tell(facts);
  };

  const onPointerMove = (event) => {
    const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // A still scene does not render: look now, as a frame would.
    lastAt = -Infinity;
    update();
  };
  const onPointerLeave = () => {
    pointer = null;
    if (store?.get?.() === 'spectator' || !store) tell(null);
  };

  canvas.addEventListener?.('pointermove', onPointerMove);
  canvas.addEventListener?.('pointerleave', onPointerLeave);
  const removePostRender = scene.postRender.addEventListener(update);
  const unsubscribe = store?.subscribe?.(() => {
    lastAt = -Infinity;
    update();
  });

  return {
    /** The targeted block's facts now, or null. */
    get target() {
      return current;
    },
    /** Look again now (tests, a mode change). */
    update() {
      lastAt = -Infinity;
      update();
    },
    destroy() {
      canvas.removeEventListener?.('pointermove', onPointerMove);
      canvas.removeEventListener?.('pointerleave', onPointerLeave);
      removePostRender?.();
      unsubscribe?.();
      tell(null);
    },
  };
}
