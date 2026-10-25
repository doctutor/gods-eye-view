// Personal fork: elevation and the Google photoreal tiles seen together,
// two ways (both off by default, both in the URL as `lp`):
//
// - Relief ×N (prototype A): Cesium's own vertical exaggeration
//   (scene.verticalExaggeration, which 3D Tiles follow since Cesium 1.116),
//   about the ground under the view's centre so the view does not jump.
// - Photoreal on bricks (prototype B): while Lego mode draws its bricks over
//   Google 3D, a CustomShader on the tileset lifts each Lego cell's patch of
//   the photoreal mesh by that cell's lift, the brick's top less the ground
//   the tiles draw there, so the photoreal surface stands on its brick. The
//   lifts go in as a small RGBA texture (a cell a texel), the window as
//   uniforms; a vertex finds its cell from the window's local east-north-up
//   frame by a short series, without per-vertex trig.
//
// The pure parts (the URL value, the lifts and their packing, the frame
// and the vertex-to-cell mapping the shader mirrors) are exported for
// tests; createPhotorealController applies both to the scene.

import * as Cesium from 'cesium';
import { brickHeightM } from './model.js';
import { ecef, enuAxes } from './bricks.js';

export const LEGO_PHOTOREAL_PARAM = 'lp';
/** Relief ×N choices (1 is off). */
export const RELIEF_FACTORS = Object.freeze([1, 2, 3, 5]);
/** The relief re-centres when the view settles this many camera heights from its anchor. */
export const RELIEF_REANCHOR_HEIGHTS = 1;
/** Lifts are packed as decimetres from LIFT_OFFSET_M, in 24 bits. */
export const LIFT_OFFSET_M = 1000;
export const LIFT_STEP_M = 0.1;
const LIFT_MAX_CODE = 2 ** 24 - 1;
/** The fraction of a cell over which the lift fades to 0 at its edges (0: hard edges). */
export const DEFAULT_EDGE_BAND = 0;

// WGS84.
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const RAD = Math.PI / 180;

// ── The URL ─────────────────────────────────────────────────────────────

/** {relief: 1|2|3|5, bricks: boolean}, both off. */
export const defaultPhotorealState = () => ({ relief: 1, bricks: false });

/**
 * The state as `lp`'s value: the relief factor, and `.b` when Photoreal on
 * bricks is on (`3`, `3.b`, `1.b`); '' when both are off.
 */
export function encodePhotorealParam({ relief = 1, bricks = false } = {}) {
  const factor = RELIEF_FACTORS.includes(relief) ? relief : 1;
  if (factor === 1 && !bricks) return '';
  return bricks ? `${factor}.b` : String(factor);
}

/** `lp`'s value back; anything unknown is off. */
export function decodePhotorealParam(value) {
  const match = /^([1235])(\.b)?$/.exec(String(value ?? '').trim());
  if (!match) return defaultPhotorealState();
  return { relief: Number(match[1]), bricks: Boolean(match[2]) };
}

function hashStateNow() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    return decodePhotorealParam(
      new URLSearchParams(hash).get(LEGO_PHOTOREAL_PARAM),
    );
  } catch {
    return defaultPhotorealState();
  }
}

/**
 * The two switches, shared by the Lego heading control, the controller and
 * the share link (read once from the page's hash, as `cc` and `wh` are).
 */
export function createPhotorealStore({ initial = hashStateNow() } = {}) {
  let state = { ...defaultPhotorealState(), ...initial };
  /** Whether the page's link asked for the bricks (Lego is turned on for it). */
  const fromLink = state.bricks;
  const listeners = new Set();
  const set = (patch) => {
    const next = { ...state, ...patch };
    if (next.relief === state.relief && next.bricks === state.bricks) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[Lego] photoreal listener failed:', error);
      }
    }
  };
  return {
    get: () => state,
    linkAskedForBricks: () => fromLink,
    setRelief: (relief) =>
      RELIEF_FACTORS.includes(Number(relief)) &&
      set({ relief: Number(relief) }),
    setBricks: (bricks) => set({ bricks: bricks === true }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    param: () => encodePhotorealParam(state),
  };
}

let shared = null;
/** The page's store, made from its hash the first time it is asked for. */
export function photorealStore() {
  shared ||= createPhotorealStore();
  return shared;
}

// ── The relief ──────────────────────────────────────────────────────────

/**
 * A height Cesium drew exaggerated by `factor` about `relativeM`, back to
 * the true one (a pick under the relief reads the drawn height).
 */
export const unexaggerate = (heightM, factor, relativeM) =>
  factor > 1 ? (heightM - relativeM) / factor + relativeM : heightM;

/** The height the tiles draw a true height at, under the relief. */
export const exaggerate = (heightM, factor, relativeM) =>
  factor > 1 ? (heightM - relativeM) * factor + relativeM : heightM;

// ── The lifts ───────────────────────────────────────────────────────────

/**
 * Each cell's lift (m), row-major from the north-west cell, for a built
 * Lego window ({header, columns, exaggeration}):
 *
 * - a column's top: its base (the cell's ground on photoreal, the
 *   ellipsoid for elevation's own columns) plus its bricks;
 * - the ground the tiles draw there: the DEM height (the column's base, or
 *   elevation's own value) plus the geoid's height (`geoidM`: Lego stands
 *   on DEM heights read as ellipsoidal, Google's mesh is ellipsoidal), and,
 *   under the relief, exaggerated as Cesium does it (the exaggeration runs
 *   before the custom shader);
 * - the lift is the top less that ground. A cell without a column, or
 *   without a known ground, is not lifted (NaN).
 */
export function cellLifts(
  built,
  { geoidM = 0, relief = 1, reliefHeightM = 0 } = {},
) {
  const { header, columns } = built;
  const lifts = new Float32Array(header.cols * header.rows).fill(NaN);
  const brick = brickHeightM(header.cellSizeM);
  const elevation = built.layer === 'ee-elevation';
  for (const column of columns) {
    const top = column.baseM + column.bricks * brick;
    const ground = elevation ? Number(column.value) : column.baseM;
    // Off elevation, a column without its cell's ground (baseM 0 from no
    // elevation grid) has no ground to measure from.
    if (!Number.isFinite(ground) || (!elevation && !column.baseM)) continue;
    const drawn = exaggerate(ground + geoidM, relief, reliefHeightM);
    lifts[column.row * header.cols + column.col] = top - drawn;
  }
  return lifts;
}

/**
 * Lifts as an RGBA byte texture, a texel a cell (north row first): RGB the
 * lift in LIFT_STEP_M from -LIFT_OFFSET_M (24 bits: -1 km to +1,677 km), A
 * 255 where the cell is lifted, 0 where not.
 */
export function packLifts(lifts) {
  const out = new Uint8Array(lifts.length * 4);
  for (let i = 0; i < lifts.length; i++) {
    const lift = lifts[i];
    if (!Number.isFinite(lift)) continue;
    const code = Math.min(
      LIFT_MAX_CODE,
      Math.max(0, Math.round((lift + LIFT_OFFSET_M) / LIFT_STEP_M)),
    );
    out[i * 4] = (code >> 16) & 255;
    out[i * 4 + 1] = (code >> 8) & 255;
    out[i * 4 + 2] = code & 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A packed texel back to its lift (NaN when not lifted): the shader's decode. */
export function unpackLift(bytes, index) {
  if (bytes[index * 4 + 3] < 128) return NaN;
  const code =
    bytes[index * 4] * 65536 +
    bytes[index * 4 + 1] * 256 +
    bytes[index * 4 + 2];
  return code * LIFT_STEP_M - LIFT_OFFSET_M;
}

// ── The frame ───────────────────────────────────────────────────────────

/**
 * The window's frame for the shader: its centre (lat, lon in radians,
 * their cos, sin and tan), the radii of curvature there (prime vertical
 * Rn, meridian Rm), its box in radians, its cells, and the centre's ECEF
 * and east-north-up axes.
 */
export function liftFrame(header) {
  const latDeg = (header.south + header.north) / 2;
  const lonDeg = (header.west + header.east) / 2;
  const lat = latDeg * RAD;
  const sin = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * sin * sin);
  return {
    lat,
    lon: lonDeg * RAD,
    cos: Math.cos(lat),
    sin,
    tan: Math.tan(lat),
    rn: A / w,
    rm: (A * (1 - E2)) / (w * w * w),
    box: [header.west, header.south, header.east, header.north].map(
      (d) => d * RAD,
    ),
    cols: header.cols,
    rows: header.rows,
    center: ecef(lonDeg, latDeg, 0),
    axes: enuAxes(lonDeg, latDeg),
  };
}

/**
 * A point in the window's east-north-up frame (m, `z` up) to its latitude
 * and longitude (radians), as the shader does it:
 * - down to the ground under it first: a point h above the ellipsoid lies
 *   1 + h/R farther out in the tangent plane (h from z and the plane's
 *   drop, (x² + y²) / 2R), 31 m for a 4,000 m peak 50 km out;
 * - the north offset less the parallel's rise in the tangent plane
 *   (x² tan φ / 2Rn), over Rm;
 * - the east offset over Rn cos φ, with cos φ by its first-order series
 *   about the centre.
 * No trig per vertex.
 */
export function enuToLatLon(x0, y0, frame, z = 0) {
  const h = z + (x0 * x0 + y0 * y0) / (2 * frame.rn);
  const scale = 1 + h / frame.rn;
  const x = x0 / scale;
  const y = y0 / scale;
  const lat = frame.lat + (y - (x * x * frame.tan) / (2 * frame.rn)) / frame.rm;
  const cosLat = frame.cos - frame.sin * (lat - frame.lat);
  return { lat, lon: frame.lon + x / (frame.rn * cosLat) };
}

/** That point's cell (col, row) and the window's uv, or null outside. */
export function enuToCell(x, y, frame, z = 0) {
  const { lat, lon } = enuToLatLon(x, y, frame, z);
  const [west, south, east, north] = frame.box;
  const u = (lon - west) / (east - west);
  const v = (north - lat) / (north - south);
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return null;
  return {
    u,
    v,
    col: Math.floor(u * frame.cols),
    row: Math.floor(v * frame.rows),
  };
}

/** ECEF (m) to the window's east-north-up frame (m). */
export function toWindowEnu([x, y, z], frame) {
  const d = [x - frame.center[0], y - frame.center[1], z - frame.center[2]];
  const dot = (a) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  return [dot(frame.axes.east), dot(frame.axes.north), dot(frame.axes.up)];
}

/**
 * The window frame's ECEF-to-ENU transform as a column-major 4×4 (the
 * shader's u_ecToWindow is this times the camera's inverse view).
 */
export function worldToWindowMatrix(frame) {
  const { east, north, up } = frame.axes;
  const c = frame.center;
  const t = (axis) => -(axis[0] * c[0] + axis[1] * c[1] + axis[2] * c[2]);
  // Column-major: columns are the images of x, y, z and the translation.
  return [
    east[0],
    north[0],
    up[0],
    0,
    east[1],
    north[1],
    up[1],
    0,
    east[2],
    north[2],
    up[2],
    0,
    t(east),
    t(north),
    t(up),
    1,
  ];
}

// ── The shader ──────────────────────────────────────────────────────────

/**
 * The vertex stage: the vertex in eye coordinates (Cesium's precise
 * model-view), into the window's ENU frame by u_ecToWindow (updated each
 * frame), to its cell as enuToLatLon does; the cell's lift from u_lift,
 * faded to 0 over u_edgeBand of a cell at its edges, added along the
 * window's up vector in model coordinates. The fragment stage only paints
 * when u_debug is set: a triangle whose corners were lifted differently (a
 * "curtain") red, the rest blue, for measuring.
 */
export const LIFT_VERTEX_SHADER = `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  vec3 ec = (czm_modelView * vec4(vsOutput.positionMC, 1.0)).xyz;
  vec3 enu = (u_ecToWindow * vec4(ec, 1.0)).xyz;
  float h = enu.z + dot(enu.xy, enu.xy) / (2.0 * u_radii.x);
  vec2 g = enu.xy / (1.0 + h / u_radii.x);
  float lat = u_origin.x + (g.y - g.x * g.x * u_radii.z / (2.0 * u_radii.x)) / u_radii.y;
  float cosLat = u_origin.z - u_origin.w * (lat - u_origin.x);
  float lon = u_origin.y + g.x / (u_radii.x * cosLat);
  vec2 uv = vec2((lon - u_box.x) / (u_box.z - u_box.x), (u_box.w - lat) / (u_box.w - u_box.y));
  float lift = 0.0;
  if (uv.x >= 0.0 && uv.x < 1.0 && uv.y >= 0.0 && uv.y < 1.0) {
    vec2 cell = floor(uv * u_cells);
    vec4 texel = texture(u_lift, (cell + 0.5) / u_cells);
    if (texel.a > 0.5) {
      vec3 bytes = floor(texel.rgb * 255.0 + 0.5);
      lift = (bytes.r * 65536.0 + bytes.g * 256.0 + bytes.b) * ${LIFT_STEP_M.toFixed(1)} - ${LIFT_OFFSET_M.toFixed(1)};
      if (u_edgeBand > 0.0) {
        vec2 f = fract(uv * u_cells);
        float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
        lift *= smoothstep(0.0, u_edgeBand, edge);
      }
    }
  }
  v_lift = lift;
  vsOutput.positionMC += mat3(czm_inverseModel) * (u_upWorld * lift);
}
`;

export const LIFT_FRAGMENT_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  if (u_debug > 0.5) {
    bool curtain = fwidth(v_lift) > 0.05;
    material.diffuse = curtain ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  }
}
`;

/** The uniforms' values for a frame and an edge band (u_lift and u_ecToWindow apart). */
export function frameUniforms(frame, { edgeBand = DEFAULT_EDGE_BAND } = {}) {
  return {
    u_origin: [frame.lat, frame.lon, frame.cos, frame.sin],
    u_radii: [frame.rn, frame.rm, frame.tan],
    u_box: [...frame.box],
    u_cells: [frame.cols, frame.rows],
    u_upWorld: [...frame.axes.up],
    u_edgeBand: edgeBand,
  };
}

// ── On the scene ────────────────────────────────────────────────────────

/**
 * Both prototypes on the scene, following the store, the Lego controller
 * and the map:
 * - Relief: scene.verticalExaggeration = the factor, its relative height
 *   the true ground under the view's centre when turned on, again when the
 *   view settles RELIEF_REANCHOR_HEIGHTS away; 1 restores both.
 * - Bricks: while the store says so, Lego is drawn over a shown 3D tileset
 *   (not a flat map) and the geoid is known, the tileset carries the lift
 *   shader with the window's lifts; anything else takes it off (and gives
 *   back a custom shader the tileset had).
 * @param {{viewer: object, lego: object, mapStackController: object,
 *   store?: object, cesium?: object, geoid?: {ready: () => Promise<void>,
 *   height: (lat: number, lon: number) => number}, edgeBand?: number,
 *   requestRender?: Function, debug?: boolean}} options
 */
export function createPhotorealController({
  viewer,
  lego,
  mapStackController,
  store = photorealStore(),
  cesium = Cesium,
  geoid = null,
  edgeBand = DEFAULT_EDGE_BAND,
  requestRender = () => {},
  debug = false,
}) {
  const scene = viewer?.scene;
  const removers = [];
  let anchor = null; // {lat, lon, heightM, cameraM}
  let shader = null;
  let shaderTileset = null;
  let previousShader;
  let liftedFor = null; // the built window the texture holds
  let liftKey = ''; // the relief it was lifted for
  let frame = null;
  let lifts = null;
  let geoidReady = false;
  let destroyed = false;
  let preRenderOff = null;
  const status = { relief: 1, bricks: 'off', reason: '' };

  const tileset = () => mapStackController?.getImageryHostTileset?.() || null;

  // The true ground under the middle of the view (a pick reads the drawn one).
  function groundAtCentre() {
    const canvas = scene?.canvas;
    if (!canvas) return null;
    const middle = new cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    let place = null;
    try {
      const world = scene.pickPositionSupported
        ? scene.pickPosition(middle)
        : null;
      if (world) place = cesium.Cartographic.fromCartesian(world);
    } catch {
      place = null;
    }
    if (!place) {
      const hit = viewer.camera?.pickEllipsoid?.(middle);
      if (hit) place = cesium.Cartographic.fromCartesian(hit);
    }
    if (!place) return null;
    const factor = scene.verticalExaggeration || 1;
    const relative = scene.verticalExaggerationRelativeHeight || 0;
    return {
      lat: cesium.Math.toDegrees(place.latitude),
      lon: cesium.Math.toDegrees(place.longitude),
      heightM: unexaggerate(place.height || 0, factor, relative),
      cameraM: viewer.camera?.positionCartographic?.height || 0,
    };
  }

  function applyRelief({ reanchor = false } = {}) {
    if (!scene) return;
    const { relief } = store.get();
    if (relief <= 1) {
      scene.verticalExaggeration = 1;
      scene.verticalExaggerationRelativeHeight = 0;
      anchor = null;
      status.relief = 1;
      return;
    }
    const here = groundAtCentre();
    if (here && (reanchor || !anchor)) anchor = here;
    scene.verticalExaggeration = relief;
    scene.verticalExaggerationRelativeHeight = anchor?.heightM || 0;
    status.relief = relief;
  }

  function onSettled() {
    const { relief } = store.get();
    if (relief > 1) {
      const here = groundAtCentre();
      if (here && anchor) {
        const toRad = Math.PI / 180;
        const dy = (here.lat - anchor.lat) * toRad * A;
        const dx =
          (here.lon - anchor.lon) * toRad * A * Math.cos(anchor.lat * toRad);
        const far =
          Math.hypot(dx, dy) >
          RELIEF_REANCHOR_HEIGHTS * Math.max(1, here.cameraM);
        if (far) applyRelief({ reanchor: true });
      }
    }
    syncBricks();
  }

  function removeShader() {
    if (preRenderOff) {
      preRenderOff();
      preRenderOff = null;
    }
    if (shaderTileset && !shaderTileset.isDestroyed?.()) {
      if (shaderTileset.customShader === shader)
        shaderTileset.customShader = previousShader;
    }
    const old = shader;
    shader = null;
    shaderTileset = null;
    previousShader = undefined;
    liftedFor = null;
    liftKey = '';
    frame = null;
    lifts = null;
    // The tiles rebuild their commands on the next update: free it after.
    if (old) {
      const free = scene?.postRender?.addEventListener?.(() => {
        free?.();
        try {
          old.destroy();
        } catch {
          /* already freed */
        }
      });
      if (!free) old.destroy?.();
    }
  }

  function liftTexture(packed, cols, rows) {
    return new cesium.TextureUniform({
      typedArray: packed,
      width: cols,
      height: rows,
      repeat: false,
      minificationFilter: cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: cesium.TextureMagnificationFilter.NEAREST,
    });
  }

  function updateEyeTransform() {
    if (!shader || !frame) return;
    const world = worldToWindowMatrix(frame);
    const m = cesium.Matrix4.fromColumnMajorArray(world);
    const out = cesium.Matrix4.multiply(
      m,
      viewer.camera.inverseViewMatrix,
      new cesium.Matrix4(),
    );
    shader.setUniform('u_ecToWindow', out);
  }

  function makeShader(packed, built) {
    const values = frameUniforms(frame, { edgeBand });
    const U = cesium.UniformType;
    const vec = (n, v) =>
      n === 4
        ? new cesium.Cartesian4(...v)
        : n === 3
          ? new cesium.Cartesian3(...v)
          : new cesium.Cartesian2(...v);
    return new cesium.CustomShader({
      uniforms: {
        u_lift: {
          type: U.SAMPLER_2D,
          value: liftTexture(packed, built.header.cols, built.header.rows),
        },
        u_origin: { type: U.VEC4, value: vec(4, values.u_origin) },
        u_radii: { type: U.VEC3, value: vec(3, values.u_radii) },
        u_box: { type: U.VEC4, value: vec(4, values.u_box) },
        u_cells: { type: U.VEC2, value: vec(2, values.u_cells) },
        u_upWorld: { type: U.VEC3, value: vec(3, values.u_upWorld) },
        u_edgeBand: { type: U.FLOAT, value: values.u_edgeBand },
        u_ecToWindow: { type: U.MAT4, value: new cesium.Matrix4() },
        u_debug: { type: U.FLOAT, value: debug ? 1 : 0 },
      },
      varyings: { v_lift: cesium.VaryingType.FLOAT },
      // The debug colours unlit, so they can be counted.
      ...(debug ? { lightingModel: cesium.LightingModel.UNLIT } : {}),
      vertexShaderText: LIFT_VERTEX_SHADER,
      fragmentShaderText: LIFT_FRAGMENT_SHADER,
    });
  }

  /** Why the bricks are not lifting the tiles now ('' when they are). */
  function bricksReason() {
    if (!store.get().bricks) return 'off';
    if (lego?.getMode?.() !== 'lego') return 'no-lego';
    if (!tileset()) return 'no-photoreal';
    const built = lego?.getBuilt?.();
    if (!built || built.flat) return 'no-bricks';
    if (!built.columns?.length) return 'no-bricks';
    if (!geoidReady) return 'geoid';
    return '';
  }

  function syncBricks() {
    if (destroyed) return;
    const reason = bricksReason();
    status.reason = reason;
    if (reason) {
      status.bricks = reason === 'off' ? 'off' : 'waiting';
      if (shader) removeShader();
      requestRender('lego-photoreal');
      return;
    }
    const built = lego.getBuilt();
    const target = tileset();
    const relief = scene?.verticalExaggeration || 1;
    const reliefHeightM = scene?.verticalExaggerationRelativeHeight || 0;
    const key = `${relief}|${reliefHeightM}`;
    if (
      shader &&
      shaderTileset === target &&
      liftedFor === built &&
      liftKey === key
    ) {
      status.bricks = 'on';
      return;
    }
    const nextFrame = liftFrame(built.header);
    const lat = (built.header.south + built.header.north) / 2;
    const lon = (built.header.west + built.header.east) / 2;
    let geoidM = 0;
    try {
      geoidM = geoid?.height?.(lat, lon) ?? 0;
    } catch {
      geoidM = 0;
    }
    lifts = cellLifts(built, { geoidM, relief, reliefHeightM });
    const packed = packLifts(lifts);
    if (shader && shaderTileset === target) {
      // A new window or relief: the same shader, new uniforms.
      frame = nextFrame;
      const values = frameUniforms(frame, { edgeBand });
      shader.setUniform(
        'u_lift',
        liftTexture(packed, built.header.cols, built.header.rows),
      );
      shader.setUniform('u_origin', new cesium.Cartesian4(...values.u_origin));
      shader.setUniform('u_radii', new cesium.Cartesian3(...values.u_radii));
      shader.setUniform('u_box', new cesium.Cartesian4(...values.u_box));
      shader.setUniform('u_cells', new cesium.Cartesian2(...values.u_cells));
      shader.setUniform(
        'u_upWorld',
        new cesium.Cartesian3(...values.u_upWorld),
      );
    } else {
      if (shader) removeShader();
      frame = nextFrame;
      shader = makeShader(packed, built);
      previousShader = target.customShader;
      target.customShader = shader;
      shaderTileset = target;
      preRenderOff =
        scene?.preRender?.addEventListener?.(updateEyeTransform) || null;
    }
    liftKey = key;
    liftedFor = built;
    updateEyeTransform();
    status.bricks = 'on';
    requestRender('lego-photoreal');
  }

  function sync() {
    applyRelief();
    syncBricks();
    requestRender('lego-photoreal');
  }

  removers.push(store.subscribe(sync));
  if (lego?.subscribe) removers.push(lego.subscribe(() => syncBricks()));
  const offMap = mapStackController?.subscribe?.(() => sync());
  if (typeof offMap === 'function') removers.push(offMap);
  const offMove = viewer?.camera?.moveEnd?.addEventListener?.(onSettled);
  if (typeof offMove === 'function') removers.push(offMove);

  if (geoid?.ready)
    geoid
      .ready()
      .then(() => {
        geoidReady = true;
        syncBricks();
      })
      .catch(() => {
        geoidReady = false;
      });
  else geoidReady = true;
  sync();

  return {
    sync,
    getStatus: () => ({ ...status }),
    getState: () => store.get(),
    setRelief: (relief) => store.setRelief(relief),
    setBricks: (bricks) => store.setBricks(bricks),
    subscribe: (listener) => store.subscribe(listener),
    /**
     * A picked height under the bricks' lift back to the tiles' own (a
     * depth pick reads the lifted surface); NaN outside the window.
     */
    unliftHeight(lonDeg, latDeg, heightM) {
      if (!frame || !lifts) return heightM;
      const enu = toWindowEnu(ecef(lonDeg, latDeg, heightM), frame);
      const cell = enuToCell(enu[0], enu[1], frame, enu[2]);
      if (!cell) return heightM;
      const lift = lifts[cell.row * frame.cols + cell.col];
      return Number.isFinite(lift) ? heightM - lift : heightM;
    },
    /** For tests and the harness. */
    _state: () => ({ shader, shaderTileset, frame, lifts, anchor, liftedFor }),
    destroy() {
      destroyed = true;
      for (const remove of removers.splice(0)) {
        try {
          remove?.();
        } catch {
          /* already gone */
        }
      }
      removeShader();
      if (scene && store.get().relief > 1) {
        scene.verticalExaggeration = 1;
        scene.verticalExaggerationRelativeHeight = 0;
      }
    },
  };
}
