/**
 * Personal fork: embodied navigation's Cesium binding (docs/BLOCKS-PLAN.md,
 * milestone 2). While the store's mode is Walk or Fly it owns the camera:
 * Cesium's own camera inputs are off, WASD and the mouse under Pointer Lock
 * drive the movement model (movement.js) each frame, the camera has no roll
 * and a 70° vertical field of view, a crosshair marks the screen's centre,
 * and the looked-at block (or a ring at the looked-at point) is outlined.
 * Spectator changes nothing: no listener stays attached but the store's.
 *
 * The world: under Blocks (blocksSource.js) the store's occupancy, in the
 * Blocks region's frame and its heights above mean sea level; elsewhere
 * the trusted surface (src/surfaceTrust.js) under a local frame anchored at
 * the camera, in ellipsoidal heights. Nothing known under the body: hover.
 */
import * as Cesium from 'cesium';
import {
  EYE_HEIGHT_M,
  VERTICAL_FOV_DEG,
  cesiumFovRad,
  createNavState,
  look,
  step,
} from './movement.js';
import { createBlockWorld, createHeightfieldWorld } from './worlds.js';
import { EXIT_FLIGHT_S, MODE_HINTS, entryPose, exitView } from './entry.js';
import {
  DEFAULT_KEYS,
  createKeyboardSource,
  inputFromIntents,
  inputRegistry,
} from './inputs.js';
// The double-tap moved to inputs.js; still exported from here.
export { DOUBLE_TAP_MS, createDoubleTap } from './inputs.js';
import { t } from '../i18n/index.js';
import { blocksWorldNow } from './blocksSource.js';
import { createRegion } from '../layers/blocks/grid.js';
import { CHUNK_COLUMNS } from '../layers/blocks/grid.js';
import { surfaceAt } from '../surfaceTrust.js';
import {
  applyCameraView,
  globeHeightM,
  plausibleSurfaceM,
  readCameraView,
} from '../hud/cameraState.js';

/** A walker this far above a known surface is put down on it. */
export const LAND_ABOVE_M = 50;
/** The surface frame is anchored again when the camera is this far out. */
const REANCHOR_M = 2000;
/** How long the keys hint stays over the crosshair on entering a mode. */
export const HINT_MS = 4000;
/** The outline is looked for at most this often. */
const OUTLINE_MS = 100;
/** The camera moved by someone else when it is this far from where it was put. */
const MOVED_ELSEWHERE_M = 0.05;
const OUTLINE_COLOR = '#ffffff';

/**
 * The model's input from the old held-key names (tests and callers from
 * before inputs.js): 'space', 'shift', 'sprint' and the four directions.
 */
export function inputFromKeys(held, mode) {
  return inputFromIntents(
    {
      forward: held.has('forward'),
      back: held.has('back'),
      left: held.has('left'),
      right: held.has('right'),
      jump: held.has('space'),
      sneak: held.has('shift'),
      sprint: held.has('sprint'),
    },
    mode,
  );
}

const isFormTarget = (target) =>
  Boolean(
    target?.closest?.('input, textarea, select, [contenteditable="true"]') ||
    target?.isContentEditable,
  );

/**
 * Bind the store's mode to a viewer. `holdRender`/`releaseRender` keep the
 * scene drawing while a mode is on (src/renderGovernor.js); `onStatus`
 * hears {mode, surface: 'blocks'|'surface'|'none', blockM, locked}.
 */
export function createNavigationBinding({
  viewer,
  store,
  blocks = blocksWorldNow,
  sampleSurface = null,
  holdRender = null,
  releaseRender = null,
  onStatus = null,
  documentRef = globalThis.document,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  inputs = inputRegistry(),
  keys = () => DEFAULT_KEYS,
}) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const canvas = scene.canvas;
  const controller = scene.screenSpaceCameraController;
  let mode = 'spectator';
  let active = null;
  /** The targeted block fed in by targeting.js, or null. */
  let target = null;

  const status = (patch = {}) => {
    try {
      onStatus?.({
        mode,
        surface: 'none',
        blockM: null,
        locked: documentRef?.pointerLockElement === canvas,
        ...patch,
      });
    } catch {
      /* observer only */
    }
  };

  /** The surface world, anchored at the camera. */
  const surfaceFrame = (view) => {
    const region = createRegion({ lon0: view.lon, lat0: view.lat, blockM: 1 });
    const sample =
      sampleSurface ||
      ((lat, lon) => {
        // A trusted hit from above, else the shown globe's terrain (a ray
        // pick need not meet the globe), as the HUD's AGL finds it.
        const reading = surfaceAt(viewer, lat, lon);
        if (plausibleSurfaceM(reading.heightM)) return reading.heightM;
        const globe = globeHeightM(viewer, lat, lon);
        return plausibleSurfaceM(globe) ? globe : Number.NaN;
      });
    const world = createHeightfieldWorld({
      sample: (x, y) => {
        const place = region.toLonLat(x, y);
        return sample(place.lat, place.lon);
      },
    });
    return {
      kind: 'surface',
      region,
      world,
      toLocal(cartographic) {
        const local = region.toLocal(
          Cesium.Math.toDegrees(cartographic.longitude),
          Cesium.Math.toDegrees(cartographic.latitude),
        );
        return { ...local, z: cartographic.height };
      },
      toCartographic(x, y, z) {
        const place = region.toLonLat(x, y);
        return { lon: place.lon, lat: place.lat, heightM: z };
      },
    };
  };

  /**
   * The Blocks world in its region's frame: a block's top at level y is
   * (y + 1)·blockM above mean sea level, drawn at that plus the geoid and
   * its chunk's drop below the tangent plane (src/layers/blocks/grid.js
   * chunkOrigin), as the renderer places it.
   */
  const blocksFrame = (first) => {
    let source = first;
    const { region } = source;
    const geoidM = Number(source.geoidM) || 0;
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(region.lon0, region.lat0, 0),
    );
    const inverse = Cesium.Matrix4.inverseTransformation(
      frame,
      new Cesium.Matrix4(),
    );
    const chunkM = CHUNK_COLUMNS * region.blockM;
    const dropAt = (x, y) =>
      region.chunkOrigin(Math.floor(x / chunkM), Math.floor(y / chunkM)).z;
    const world = createBlockWorld({
      region,
      chunkAt: (ci, cj) => source.chunkAt(ci, cj),
    });
    const toWorld = (x, y, z) =>
      Cesium.Matrix4.multiplyByPoint(
        frame,
        new Cesium.Cartesian3(x, y, z + geoidM + dropAt(x, y)),
        new Cesium.Cartesian3(),
      );
    return {
      kind: 'blocks',
      region,
      world,
      toWorld,
      /** The provider's latest answer for the same region. */
      update(next) {
        source = next;
      },
      toLocal(cartographic) {
        const local = Cesium.Matrix4.multiplyByPoint(
          inverse,
          Cesium.Cartographic.toCartesian(cartographic),
          new Cesium.Cartesian3(),
        );
        return {
          x: local.x,
          y: local.y,
          z: local.z - geoidM - dropAt(local.x, local.y),
        };
      },
      toCartographic(x, y, z) {
        const carto = Cesium.Cartographic.fromCartesian(toWorld(x, y, z));
        return {
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          heightM: carto.height,
        };
      },
    };
  };

  /** The frame for now: the Blocks world when drawn, else the surface. */
  const frameFor = (view, current) => {
    const source = blocks();
    if (source) {
      if (current?.kind === 'blocks' && current.region === source.region) {
        current.update(source);
        return current;
      }
      return blocksFrame(source);
    }
    if (current?.kind === 'surface') {
      const { x, y } = current.region.toLocal(view.lon, view.lat);
      if (Math.hypot(x, y) < REANCHOR_M) return current;
    }
    return surfaceFrame(view);
  };

  /** The model's state from the camera as it is. */
  const stateFromCamera = (frame) => {
    const carto = camera.positionCartographic;
    const local = frame.toLocal(carto);
    const state = createNavState({
      x: local.x,
      y: local.y,
      z: local.z,
      yaw: camera.heading,
      pitch: camera.pitch,
    });
    return mode === 'walk' ? land(state, frame.world) : state;
  };

  /** A walker high above a known surface is put down on it. */
  const land = (state, world) => {
    const ground = world.surfaceBelow(state.x, state.y, state.z);
    if (!Number.isFinite(ground)) return state;
    if (state.z - EYE_HEIGHT_M - ground <= LAND_ABOVE_M) return state;
    return { ...state, z: ground + EYE_HEIGHT_M, vz: 0, onGround: true };
  };

  const statusOf = (frame, state) => ({
    surface: state.hovering ? 'none' : frame.kind,
    blockM: frame.kind === 'blocks' ? frame.region.blockM : null,
  });

  // ── The outline of what is looked at ─────────────────────────────────

  /** The outline's lines, made on entering a mode (the scene destroys them on leaving). */
  let outlines = null;
  const outlineMaterial = Cesium.Material.fromType('Color', {
    color: Cesium.Color.fromCssColorString(OUTLINE_COLOR).withAlpha(0.9),
  });
  /**
   * The outline's lines; `data` (the targeted block's facts, target.js)
   * rides on each line as its id, for a later click on the block.
   */
  const setOutline = (paths, data = null) => {
    if (!outlines) return;
    while (outlines.length < paths.length)
      outlines.add({ positions: [], width: 2, material: outlineMaterial });
    for (let k = 0; k < outlines.length; k += 1) {
      const line = outlines.get(k);
      line.show = k < paths.length;
      if (line.show) line.positions = paths[k];
      line.id = line.show ? data : null;
    }
    outlines.show = paths.length > 0;
  };

  /** The 12 edges of a block (region column i, j, level y). */
  const blockEdges = (frame, hit) => {
    const b = frame.region.blockM;
    const corner = (u, v, w) =>
      frame.toWorld((hit.i + u) * b, (hit.j + v) * b, (hit.y + w) * b);
    const edges = [];
    for (const [a, c] of [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, 1, 0],
        [1, 1, 0],
      ],
      [
        [0, 0, 1],
        [1, 0, 1],
      ],
      [
        [0, 1, 1],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 1, 0],
      ],
      [
        [0, 0, 1],
        [0, 1, 1],
      ],
      [
        [1, 0, 1],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
      ],
      [
        [1, 0, 0],
        [1, 0, 1],
      ],
      [
        [0, 1, 0],
        [0, 1, 1],
      ],
      [
        [1, 1, 0],
        [1, 1, 1],
      ],
    ])
      edges.push([corner(...a), corner(...c)]);
    return edges;
  };

  /** A ring of `radiusM` on the ground at a point. */
  const ringAt = (position, radiusM) => {
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const points = [];
    for (let k = 0; k <= 24; k += 1) {
      const angle = (k / 24) * 2 * Math.PI;
      points.push(
        Cesium.Matrix4.multiplyByPoint(
          enu,
          new Cesium.Cartesian3(
            radiusM * Math.cos(angle),
            radiusM * Math.sin(angle),
            0.05,
          ),
          new Cesium.Cartesian3(),
        ),
      );
    }
    return [points];
  };

  const updateOutline = () => {
    if (!active) return;
    const t = now();
    if (t - active.outlineAt < OUTLINE_MS) return;
    active.outlineAt = t;
    const { frame, state } = active;
    try {
      if (frame.kind === 'blocks') {
        const direction = {
          x: Math.sin(state.yaw) * Math.cos(state.pitch),
          y: Math.cos(state.yaw) * Math.cos(state.pitch),
          z: Math.sin(state.pitch),
        };
        // The targeted block (targeting.js) when it is fed in; else the
        // crosshair's own ray through occupancy.
        const hit = target ?? frame.world.raycast(state, direction);
        setOutline(hit ? blockEdges(frame, hit) : [], target);
        return;
      }
      const centre = new Cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const position = scene.pickPositionSupported
        ? scene.pickPosition(centre)
        : undefined;
      const distanceM = position
        ? Cesium.Cartesian3.distance(position, camera.positionWC)
        : Infinity;
      setOutline(
        position && distanceM < 500
          ? ringAt(position, Math.max(0.15, distanceM * 0.01))
          : [],
      );
    } catch {
      setOutline([]);
    }
  };

  // ── The crosshair ────────────────────────────────────────────────────

  const crosshair = documentRef?.createElement?.('div') ?? null;
  if (crosshair) {
    crosshair.className = 'gev-nav-crosshair';
    crosshair.setAttribute('aria-hidden', 'true');
    crosshair.hidden = true;
    (viewer.container ?? canvas.parentElement)?.appendChild?.(crosshair);
  }

  // The keys hint over the crosshair, for HINT_MS on entering a mode.
  const hint = documentRef?.createElement?.('div') ?? null;
  let hintTimer = null;
  if (hint) {
    hint.className = 'gev-nav-hint';
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    (viewer.container ?? canvas.parentElement)?.appendChild?.(hint);
  }
  const showHint = (forMode) => {
    if (!hint) return;
    clearTimeout(hintTimer);
    const text = MODE_HINTS[forMode];
    hint.textContent = text ? t(text) : '';
    hint.hidden = !text;
    hintTimer = text ? setTimeout(() => (hint.hidden = true), HINT_MS) : null;
  };

  // ── Input ───────────────────────────────────────────────────────────

  // The keyboard and mouse: input source one (inputs.js).
  const keyboard = createKeyboardSource({ keys, now });
  const removeKeyboard = inputs.add(keyboard);
  const onKey = (event) => {
    if (!active || isFormTarget(event.target)) return;
    if (!keyboard.key(event)) return;
    // The app's own shortcuts (D cycles detection) wait while walking.
    event.stopPropagation();
    if (event.code === 'Space' || event.code.startsWith('Arrow'))
      event.preventDefault();
  };
  const onBlur = () => inputs.reset();
  const onMouseMove = (event) => {
    if (!active || documentRef.pointerLockElement !== canvas) return;
    keyboard.look(event.movementX, event.movementY);
  };
  const onCanvasClick = () => {
    if (!active || documentRef.pointerLockElement === canvas) return;
    try {
      const request = canvas.requestPointerLock?.();
      request?.catch?.(() => {});
    } catch {
      /* no pointer lock here */
    }
  };
  const onLockChange = () => {
    if (!active) return;
    // Movement from before the lock changed is not a look.
    keyboard.read();
    status(statusOf(active.frame, active.state));
  };

  // ── The frame loop ──────────────────────────────────────────────────

  const placeCamera = () => {
    const { frame, state } = active;
    const place = frame.toCartographic(state.x, state.y, state.z);
    applyCameraView(viewer, {
      lon: place.lon,
      lat: place.lat,
      heightM: place.heightM,
      headingDeg: Cesium.Math.toDegrees(state.yaw),
      pitchDeg: Cesium.Math.toDegrees(state.pitch),
      rollDeg: 0,
      fovDeg: Cesium.Math.toDegrees(
        cesiumFovRad(
          VERTICAL_FOV_DEG,
          canvas.clientWidth || canvas.width,
          canvas.clientHeight || canvas.height,
        ),
      ),
    });
    active.placed = Cesium.Cartesian3.clone(camera.positionWC);
  };

  const onFrame = () => {
    if (!active) return;
    const t = now();
    const dt = (t - active.at) / 1000;
    active.at = t;
    // A flight in progress (a search, a link) owns the camera until it lands.
    if (camera._currentFlight) {
      active.resync = true;
      return;
    }
    const view = readCameraView(viewer);
    if (!view) return;
    const moved =
      active.placed &&
      Cesium.Cartesian3.distance(active.placed, camera.positionWC) >
        MOVED_ELSEWHERE_M;
    const frame = frameFor(view, active.frame);
    if (active.resync || moved || frame !== active.frame) {
      active.frame = frame;
      active.state = stateFromCamera(frame);
      active.resync = false;
    }
    let state = active.state;
    // Every source's intents this frame (the keys, the mouse, a gamepad).
    const intents = inputs.read(Math.min(0.1, Math.max(0, dt)));
    if (intents.lookDx || intents.lookDy)
      state = look(state, intents.lookDx, intents.lookDy);
    const wasHovering = state.hovering;
    state = step(state, inputFromIntents(intents, mode), dt, frame.world, mode);
    if (mode === 'walk' && wasHovering && !state.hovering)
      state = land(state, frame.world);
    active.state = state;
    placeCamera();
    updateOutline();
    const next = statusOf(frame, state);
    if (
      next.surface !== active.status.surface ||
      next.blockM !== active.status.blockM
    ) {
      active.status = next;
      status(next);
    }
    if (!holdRender) scene.requestRender();
  };

  // ── Modes ───────────────────────────────────────────────────────────

  const enter = () => {
    const view = readCameraView(viewer);
    const frame = frameFor(view ?? { lon: 0, lat: 0 }, null);
    active = {
      frame,
      state: null,
      at: now(),
      outlineAt: -Infinity,
      placed: null,
      resync: true,
      status: { surface: null, blockM: null },
      restore: {
        enableInputs: controller.enableInputs,
        enableCollisionDetection: controller.enableCollisionDetection,
        fov: camera.frustum?.fov,
      },
    };
    // The model collides: Cesium's own collision would lift the eye off the
    // blocks (onto the Google tiles above them) even with its inputs off.
    controller.enableInputs = false;
    controller.enableCollisionDetection = false;
    outlines = scene.primitives.add(new Cesium.PolylineCollection());
    // Keyboard first refusal: the capture phase, before the app's shortcuts.
    const target = documentRef?.defaultView ?? globalThis;
    target.addEventListener?.('keydown', onKey, true);
    target.addEventListener?.('keyup', onKey, true);
    target.addEventListener?.('blur', onBlur);
    documentRef?.addEventListener?.('mousemove', onMouseMove);
    documentRef?.addEventListener?.('pointerlockchange', onLockChange);
    canvas.addEventListener?.('click', onCanvasClick);
    scene.preUpdate.addEventListener(onFrame);
    holdRender?.();
    if (crosshair) crosshair.hidden = false;
  };

  const leave = () => {
    if (!active) return;
    inputs.reset();
    const { restore } = active;
    active = null;
    scene.preUpdate.removeEventListener(onFrame);
    const target = documentRef?.defaultView ?? globalThis;
    target.removeEventListener?.('keydown', onKey, true);
    target.removeEventListener?.('keyup', onKey, true);
    target.removeEventListener?.('blur', onBlur);
    documentRef?.removeEventListener?.('mousemove', onMouseMove);
    documentRef?.removeEventListener?.('pointerlockchange', onLockChange);
    canvas.removeEventListener?.('click', onCanvasClick);
    if (documentRef?.pointerLockElement === canvas)
      documentRef.exitPointerLock?.();
    controller.enableInputs = restore.enableInputs;
    controller.enableCollisionDetection = restore.enableCollisionDetection;
    if (
      Number.isFinite(restore.fov) &&
      camera.frustum &&
      'fov' in camera.frustum
    )
      camera.frustum.fov = restore.fov;
    if (outlines && scene.primitives.contains(outlines))
      scene.primitives.remove(outlines);
    outlines = null;
    releaseRender?.();
    if (crosshair) crosshair.hidden = true;
    scene.requestRender();
  };

  /**
   * Leaving for Spectator: a short flight up and back to a view of where
   * the walker stood (entry.js exitView), so the user keeps their place.
   */
  const liftFrom = (frame, state) => {
    if (!frame || !state) return;
    try {
      const place = frame.toCartographic(state.x, state.y, state.z);
      const eye = Cesium.Cartesian3.fromDegrees(
        place.lon,
        place.lat,
        place.heightM,
      );
      const view = exitView({ yaw: state.yaw });
      const destination = Cesium.Matrix4.multiplyByPoint(
        Cesium.Transforms.eastNorthUpToFixedFrame(eye),
        new Cesium.Cartesian3(view.east, view.north, view.up),
        new Cesium.Cartesian3(),
      );
      camera.flyTo({
        destination,
        orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
        duration: EXIT_FLIGHT_S,
      });
    } catch {
      /* no lift: the camera stays where the walker was */
    }
  };

  const apply = (next) => {
    const previous = mode;
    mode = next;
    if (next === 'spectator') {
      const left = active && { frame: active.frame, state: active.state };
      leave();
      showHint(null);
      if (left && previous !== 'spectator') liftFrom(left.frame, left.state);
    } else if (previous === 'spectator') {
      enter();
      showHint(next);
    } else {
      // Walk ⇄ Fly: the same place, the vertical speed dropped.
      if (active) {
        active.state = { ...active.state, vz: 0 };
        if (next === 'walk') active.resync = true;
      }
      showHint(next);
    }
    status(active ? statusOf(active.frame, active.state ?? {}) : {});
  };

  /**
   * "Walk here" / "Fly here" from Spectator: the walker on the targeted
   * block (the block under the pointer: entry.js entryPose), facing the
   * camera's heading with its pitch kept; with nothing targeted, on the
   * surface under the view's centre; with nothing there, from the camera.
   */
  const enterHere = (next) => {
    if (mode !== 'spectator') return;
    const view = readCameraView(viewer);
    let place = null;
    const source = blocks();
    if (target && source) {
      try {
        const frame = blocksFrame(source);
        const pose = entryPose({
          facts: target,
          occupancy: frame.world.occupancy,
          headingRad: camera.heading,
          pitchRad: camera.pitch,
        });
        place = frame.toCartographic(pose.x, pose.y, pose.z);
        place.pitchDeg = Cesium.Math.toDegrees(pose.pitch);
      } catch {
        place = null;
      }
    }
    if (!place) {
      const centre = new Cesium.Cartesian2(
        (canvas.clientWidth || canvas.width) / 2,
        (canvas.clientHeight || canvas.height) / 2,
      );
      let picked;
      try {
        picked = scene.pickPositionSupported
          ? scene.pickPosition(centre)
          : undefined;
      } catch {
        picked = undefined;
      }
      const carto = picked && Cesium.Cartographic.fromCartesian(picked);
      if (carto && plausibleSurfaceM(carto.height))
        place = {
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          heightM: carto.height + EYE_HEIGHT_M,
        };
    }
    if (place && view)
      applyCameraView(viewer, {
        lon: place.lon,
        lat: place.lat,
        heightM: place.heightM,
        headingDeg: view.headingDeg,
        pitchDeg: place.pitchDeg ?? Math.max(-89.5, view.pitchDeg),
        rollDeg: 0,
        fovDeg: view.fovDeg,
      });
    store.set(next);
  };

  /**
   * In Spectator, another source's (a gamepad's) walkHere / flyHere, read
   * each frame only while such a source is registered: the keyboard's G
   * keys come through onEntryKey instead.
   */
  const onSpectatorFrame = () => {
    if (mode !== 'spectator' || !inputs.hasOther(keyboard)) return;
    const intents = inputs.read(0);
    if (intents.walkHere) enterHere('walk');
    else if (intents.flyHere) enterHere('fly');
  };
  let spectatorPolling = false;
  const syncSpectatorPolling = () => {
    const want = mode === 'spectator' && inputs.hasOther(keyboard);
    if (want === spectatorPolling) return;
    spectatorPolling = want;
    if (want) scene.preUpdate.addEventListener(onSpectatorFrame);
    else scene.preUpdate.removeEventListener(onSpectatorFrame);
  };
  const offInputs = inputs.subscribe?.(syncSpectatorPolling);

  // G walks here, Shift+G flies here (in Spectator, outside form fields).
  const onEntryKey = (event) => {
    if (event.code !== 'KeyG' || mode !== 'spectator') return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isFormTarget(event.target)) return;
    event.preventDefault();
    store.requestEntry?.(event.shiftKey ? 'fly' : 'walk');
  };
  documentRef?.addEventListener?.('keydown', onEntryKey);
  const offEntry = store.onEntry?.(enterHere);

  const unsubscribe = store.subscribe((next) => {
    apply(next);
    syncSpectatorPolling();
  });
  apply(store.get());
  syncSpectatorPolling();

  return {
    /**
     * The targeted block's facts (targeting.js), outlined while Walk or
     * Fly is on; null for none.
     */
    setTarget(facts) {
      target = facts || null;
      if (active) active.outlineAt = -Infinity;
    },
    /** The mode now and, while one is on, the model's state. */
    get mode() {
      return mode;
    },
    get state() {
      return active?.state ?? null;
    },
    destroy() {
      unsubscribe();
      offInputs?.();
      if (spectatorPolling)
        scene.preUpdate.removeEventListener(onSpectatorFrame);
      spectatorPolling = false;
      removeKeyboard();
      offEntry?.();
      documentRef?.removeEventListener?.('keydown', onEntryKey);
      mode = 'spectator';
      leave();
      clearTimeout(hintTimer);
      crosshair?.remove?.();
      hint?.remove?.();
    },
    /** Walk or Fly here (as G and Shift+G do). */
    enterHere,
    /**
     * Add an input source (inputs.js: {read(dt) → partial intents,
     * reset?()}); returns its removal.
     */
    addSource: (source) => inputs.add(source),
  };
}
