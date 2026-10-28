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
  LOOK_RAD_PER_PX,
  cesiumFovRad,
  createNavState,
  look,
  step,
} from './movement.js';
import {
  createBobber,
  createFovEaser,
  createSneakToggle,
  flySpeedAfterSteps,
  flySpeedAfterWheel,
  navSettings,
} from './settings.js';
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
import { formatNumber, t } from '../i18n/index.js';
import { blocksWorldNow } from './blocksSource.js';
// Personal fork: third person (view.js) and the walker's marker.
import { thirdPersonPose } from './view.js';
import { createPlayerMarker } from './playerMarker.js';
import { createRegion } from '../layers/blocks/grid.js';
import { CHUNK_COLUMNS } from '../layers/blocks/grid.js';
import { surfaceAt } from '../surfaceTrust.js';
import { applySpectatorPad } from './gamepad.js';
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
/** How long the fly speed stays in the hint after a wheel turn. */
export const FLY_SPEED_HINT_MS = 2000;
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
    target?.closest?.(
      'input, textarea, select, [contenteditable="true"], .nav-controls-card',
    ) || target?.isContentEditable,
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
  settings = navSettings(),
  keys = () => settings?.keyMap?.() ?? DEFAULT_KEYS,
  // Third person: the view store (view.js) and the marker; none: first person.
  view: viewChoice = null,
  marker = viewChoice ? createPlayerMarker({ viewer }) : null,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
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
        view: viewChoice?.get?.() ?? 'first',
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
  const showHintText = (text, ms = HINT_MS) => {
    if (!hint) return;
    clearTimeout(hintTimer);
    hint.textContent = text || '';
    hint.hidden = !text;
    hintTimer = text ? setTimeout(() => (hint.hidden = true), ms) : null;
  };
  const showHint = (forMode) =>
    showHintText(MODE_HINTS[forMode] ? t(MODE_HINTS[forMode]) : '');

  // ── The Controls settings (settings.js) ──────────────────────────────

  const controls = () => settings?.get?.() ?? {};
  /** Fly speed now: the setting on entering, the wheel's after. */
  let flySpeed = controls().fly;
  /** Minecraft's dynamic FOV: wider while sprinting. */
  const fovEaser = createFovEaser();
  /** Sneak as a toggle (in Walk, when the Controls say so). */
  const sneakToggle = createSneakToggle();
  /** View bobbing (off by default). */
  const bobber = createBobber();
  const codesFor = (action) => settings?.codesFor?.(action) ?? [];

  /** Fly's speed set (the wheel, a gamepad's steps), said in the hint. */
  const setFlySpeed = (next) => {
    flySpeed = next;
    showHintText(
      t('Fly speed {speed} m/s', {
        speed: formatNumber(Math.round(flySpeed * 10) / 10),
      }),
      FLY_SPEED_HINT_MS,
    );
  };
  /** In Fly, the wheel sets the speed (Minecraft's spectator). */
  const onWheel = (event) => {
    if (!active || mode !== 'fly') return;
    event.preventDefault();
    setFlySpeed(
      flySpeedAfterWheel(
        flySpeed ?? controls().fly,
        event.deltaY,
        event.deltaMode,
      ),
    );
  };
  // Other sources (a gamepad) say things in the same overlay.
  const offHinter = inputs.setHinter?.((text, ms) =>
    showHintText(String(text ?? ''), Number(ms) > 0 ? Number(ms) : HINT_MS),
  );

  // ── Input ───────────────────────────────────────────────────────────

  // The keyboard and mouse: input source one (inputs.js).
  const keyboard = createKeyboardSource({ keys, now });
  const removeKeyboard = inputs.add(keyboard);
  const onKey = (event) => {
    if (!active || isFormTarget(event.target)) return;
    // The release key (Esc by default) lets the pointer go.
    if (
      event.type === 'keydown' &&
      codesFor('release').includes(event.code) &&
      documentRef?.pointerLockElement === canvas
    ) {
      documentRef.exitPointerLock?.();
      return;
    }
    if (!keyboard.key(event)) return;
    // The app's own shortcuts (D cycles detection) wait while walking.
    event.stopPropagation();
    if (event.code === 'Space' || event.code.startsWith('Arrow'))
      event.preventDefault();
  };
  const onBlur = () => inputs.reset();
  // Cesium's pointerdown calls setPointerCapture, which throws while the
  // pointer is locked (an uncaught InvalidStateError on every click while
  // walking); its inputs are off then anyway, so it is not told.
  const onLockedPointerDown = (event) => {
    if (active && documentRef?.pointerLockElement === canvas)
      event.stopPropagation();
  };
  const onMouseMove = (event) => {
    if (!active || documentRef.pointerLockElement !== canvas) return;
    // The mouse's own sensitivity and invert Y: other sources (a gamepad)
    // scale and invert their looks themselves.
    const set = controls();
    const scale = set.sensitivity ?? 1;
    keyboard.look(
      event.movementX * scale,
      event.movementY * scale * (set.invertY ? -1 : 1),
    );
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

  /** A frame's metres as a Cartesian3 (for the marker). */
  const worldPoint = (frame, x, y, z) => {
    if (frame.toWorld) return frame.toWorld(x, y, z);
    const place = frame.toCartographic(x, y, z);
    return Cesium.Cartesian3.fromDegrees(place.lon, place.lat, place.heightM);
  };

  const placeCamera = () => {
    const { frame, state } = active;
    // First person the camera is the eye; in third person (view.js) it
    // stands behind or in front, pulled in short of what is between.
    const viewMode = viewChoice?.get?.() ?? 'first';
    const pose = thirdPersonPose(state, viewMode, { world: frame.world });
    const place = frame.toCartographic(pose.x, pose.y, pose.z);
    if (viewMode === 'first') marker?.hide();
    else
      try {
        marker?.update(state, (x, y, z) => worldPoint(frame, x, y, z));
      } catch {
        marker?.hide();
      }
    applyCameraView(viewer, {
      lon: place.lon,
      lat: place.lat,
      // The eye bobs in first person only.
      heightM: place.heightM + (viewMode === 'first' ? bobber.offset : 0),
      headingDeg: Cesium.Math.toDegrees(pose.yaw),
      pitchDeg: Cesium.Math.toDegrees(pose.pitch),
      rollDeg: 0,
      fovDeg: Cesium.Math.toDegrees(
        cesiumFovRad(
          (controls().fovDeg ?? VERTICAL_FOV_DEG) + fovEaser.boost,
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
      const thirdPerson = (viewChoice?.get?.() ?? 'first') !== 'first';
      if (thirdPerson && !active.resync && !moved && active.state) {
        // The camera stands off the walker: carry the walker into the new
        // frame instead of reading it back from the camera.
        const at = active.frame.toCartographic(
          active.state.x,
          active.state.y,
          active.state.z,
        );
        const local = frame.toLocal(
          Cesium.Cartographic.fromDegrees(at.lon, at.lat, at.heightM),
        );
        active.state = { ...active.state, ...local };
      } else active.state = stateFromCamera(frame);
      active.frame = frame;
      active.resync = false;
    }
    let state = active.state;
    // Every source's intents this frame (the keys, the mouse, a gamepad).
    let intents = inputs.read(Math.min(0.1, Math.max(0, dt)));
    const set = controls();
    // Sneak toggled in Walk: a press flips it (in Fly the key is down, held).
    if (mode === 'walk' && set.sneakMode === 'toggle')
      intents = { ...intents, sneak: sneakToggle.update(intents.sneak) };
    else sneakToggle.reset();
    // Every source's looks, in pointer-lock pixels (each already at its
    // own sensitivity: the mouse's in onMouseMove).
    if (intents.lookDx || intents.lookDy)
      state = look(state, intents.lookDx, intents.lookDy, LOOK_RAD_PER_PX);
    // A source's one-shots: leave the mode, Walk ⇄ Fly, Fly's speed.
    if (intents.release) {
      if (documentRef?.pointerLockElement === canvas)
        documentRef.exitPointerLock?.();
      store.set('spectator');
      return;
    }
    if (intents.toggleMode) {
      store.set(mode === 'walk' ? 'fly' : 'walk');
      return;
    }
    if (intents.flySpeedStep && mode === 'fly')
      setFlySpeed(
        flySpeedAfterSteps(flySpeed ?? set.fly, intents.flySpeedStep),
      );
    const wasHovering = state.hovering;
    const input = inputFromIntents(intents, mode);
    state = step(state, input, dt, frame.world, mode, {
      walk: set.walk,
      sprint: set.sprint,
      fly: flySpeed ?? set.fly,
    });
    // Sprinting forward widens the view (off when the setting says fixed).
    fovEaser.update(
      set.sprintFov !== false &&
        input.sprint &&
        (input.forward || input.analog?.forward > 0) &&
        !state.sneaking,
      Math.min(0.1, Math.max(0, dt)),
    );
    if (mode === 'walk' && wasHovering && !state.hovering)
      state = land(state, frame.world);
    // The eye bobs at the step's cadence while walking on the ground.
    const before = active.state;
    bobber.update(
      Math.hypot(state.x - before.x, state.y - before.y),
      set.bobbing === true &&
        mode === 'walk' &&
        state.onGround &&
        !state.inWater &&
        (input.forward ||
          input.back ||
          input.left ||
          input.right ||
          Boolean(input.analog)),
      Math.min(0.1, Math.max(0, dt)),
    );
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
    target.addEventListener?.('pointerdown', onLockedPointerDown, true);
    documentRef?.addEventListener?.('mousemove', onMouseMove);
    documentRef?.addEventListener?.('pointerlockchange', onLockChange);
    canvas.addEventListener?.('click', onCanvasClick);
    canvas.addEventListener?.('wheel', onWheel, { passive: false });
    flySpeed = controls().fly;
    fovEaser.reset();
    sneakToggle.reset();
    bobber.reset();
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
    target.removeEventListener?.('pointerdown', onLockedPointerDown, true);
    documentRef?.removeEventListener?.('mousemove', onMouseMove);
    documentRef?.removeEventListener?.('pointerlockchange', onLockChange);
    canvas.removeEventListener?.('click', onCanvasClick);
    canvas.removeEventListener?.('wheel', onWheel);
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
    marker?.hide();
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
  const enterHere = (next, pose = null) => {
    // A place to go (Home, a waypoint): from any mode, the walker put there.
    if (pose && Number.isFinite(pose.lon) && Number.isFinite(pose.lat)) {
      goToPose(next, pose);
      return;
    }
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
   * In Spectator, another source's (a gamepad's) walkHere / flyHere and
   * its camera block (gamepad.js applySpectatorPad), read each animation
   * frame only while such a source is registered — not on the scene's
   * frames, which stop while the render is idle. The keyboard's G keys
   * come through onEntryKey instead.
   */
  let spectatorFrame = null;
  let spectatorAt = 0;
  const onSpectatorFrame = () => {
    spectatorFrame = requestFrame(onSpectatorFrame);
    if (mode !== 'spectator' || !inputs.hasOther(keyboard)) return;
    const at = now();
    const dt = Math.min(0.1, Math.max(0, (at - spectatorAt) / 1000));
    spectatorAt = at;
    const intents = inputs.read(dt);
    if (intents.walkHere) enterHere('walk');
    else if (intents.flyHere) enterHere('fly');
    else applySpectatorPad(viewer, intents.spectator, dt);
  };
  let spectatorPolling = false;
  const syncSpectatorPolling = () => {
    const want =
      mode === 'spectator' &&
      inputs.hasOther(keyboard) &&
      Boolean(requestFrame);
    if (want === spectatorPolling) return;
    spectatorPolling = want;
    if (want) {
      spectatorAt = now();
      spectatorFrame = requestFrame(onSpectatorFrame);
    } else {
      cancelFrame?.(spectatorFrame);
      spectatorFrame = null;
    }
  };
  const offInputs = inputs.subscribe?.(syncSpectatorPolling);

  /**
   * The walker put at a pose ({lon, lat, heightM: the eye, headingDeg,
   * pitchDeg}): Home and waypoints (waypoints.js). From Spectator the
   * camera is put at the eye and the mode set (entering it); then, in any
   * mode, the walker's state is made at the pose in the frame there (put
   * down on the ground in Walk) and the camera placed the way the frame
   * loop places it (placeCamera: third person, the field of view, the
   * marker).
   */
  const goToPose = (next, pose) => {
    let heightM = Number(pose.heightM);
    if (!Number.isFinite(heightM)) {
      const ground = globeHeightM(viewer, pose.lat, pose.lon);
      heightM = (plausibleSurfaceM(ground) ? ground : 0) + EYE_HEIGHT_M;
    }
    const headingDeg = Number(pose.headingDeg) || 0;
    const pitchDeg = Number(pose.pitchDeg) || 0;
    if (mode === 'spectator') {
      const current = readCameraView(viewer);
      applyCameraView(viewer, {
        lon: pose.lon,
        lat: pose.lat,
        heightM,
        headingDeg,
        pitchDeg,
        rollDeg: 0,
        fovDeg: current?.fovDeg ?? 60,
      });
      store.set(next);
    }
    if (!active) return;
    const frame = frameFor({ lon: pose.lon, lat: pose.lat }, active.frame);
    const local = frame.toLocal(
      Cesium.Cartographic.fromDegrees(pose.lon, pose.lat, heightM),
    );
    let state = createNavState({
      x: local.x,
      y: local.y,
      z: local.z,
      yaw: Cesium.Math.toRadians(headingDeg),
      pitch: Cesium.Math.toRadians(pitchDeg),
    });
    if (mode === 'walk') state = land(state, frame.world);
    active.frame = frame;
    active.state = state;
    active.resync = false;
    placeCamera();
    status(statusOf(frame, state));
  };

  // G walks here, Shift+G flies here (in Spectator, outside form fields).
  const onEntryKey = (event) => {
    if (mode !== 'spectator') return;
    const walkHere = codesFor('walkHere').includes(event.code);
    const flyHere = codesFor('flyHere').includes(event.code);
    if (!walkHere && !flyHere) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isFormTarget(event.target)) return;
    event.preventDefault();
    store.requestEntry?.(flyHere || event.shiftKey ? 'fly' : 'walk');
  };
  documentRef?.addEventListener?.('keydown', onEntryKey);
  const offEntry = store.onEntry?.(enterHere);

  const unsubscribe = store.subscribe((next) => {
    apply(next);
    syncSpectatorPolling();
  });
  // A new view: the MODE line says it, the next frame places the camera.
  const offView = viewChoice?.subscribe?.(() => {
    if (!active) return;
    status(statusOf(active.frame, active.state ?? {}));
    scene.requestRender();
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
    /**
     * Where the walker stands, for wayfinding (waypoints.js): {lon, lat,
     * heightM (the eye), level (the block underfoot, under Blocks),
     * blockM, headingDeg}; null in Spectator.
     */
    get place() {
      if (!active?.state) return null;
      const { frame, state } = active;
      const at = frame.toCartographic(state.x, state.y, state.z);
      const blockM = frame.kind === 'blocks' ? frame.region.blockM : null;
      return {
        lon: at.lon,
        lat: at.lat,
        heightM: at.heightM,
        level: blockM
          ? Math.round((state.z - EYE_HEIGHT_M) / blockM) - 1
          : null,
        blockM,
        headingDeg: ((Cesium.Math.toDegrees(state.yaw) % 360) + 360) % 360,
      };
    },
    destroy() {
      unsubscribe();
      offView?.();
      marker?.destroy?.();
      offInputs?.();
      offHinter?.();
      if (spectatorPolling) cancelFrame?.(spectatorFrame);
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
    /** A line in the keys-hint overlay over the crosshair for `ms`. */
    hint: (text, ms = HINT_MS) => showHintText(String(text ?? ''), ms),
    /**
     * Add an input source (inputs.js: {read(dt) → partial intents,
     * reset?()}); returns its removal.
     */
    addSource: (source) => inputs.add(source),
  };
}
