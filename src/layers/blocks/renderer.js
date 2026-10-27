// Personal fork: draws the Blocks render mode's chunk meshes
// (docs/BLOCKS-PLAN.md). One Cesium.Primitive per chunk from mesh.js's
// typed arrays, plus a second, translucent one for the chunk's water faces
// (translucency is per appearance). Positions stay float, in metres east,
// north and up of the chunk's origin, and the primitive's model matrix puts
// them on the globe: the region's east-north-up frame at its origin,
// raised by the controller's datum offset, and moved to the chunk's origin.
// The offset is where mean sea level, the heights' datum, sits on the
// ellipsoid: 0 on the flat basemaps, whose globe surface is the ellipsoid
// (as Lego's columns are), and the geoid's undulation N on World Terrain
// and the photoreal tiles. Cesium composes the
// model-view matrix in double precision, so a 1 m block does not shimmer
// 6,400 km from the Earth's centre, and the geometry is never projected to
// 2D or moved to world coordinates on the CPU.
//
// The colours are baked by mesh.js (face shade, ambient occlusion, sun);
// the fragment shader adds distance fog toward the sky colour, since
// Cesium's fog is the globe's and does not touch primitives. Opaque faces
// write depth, so scene.pickPosition and the HUD's AGL and centre distance
// land on the blocks; water does not, so they land on the ground under it.

import * as Cesium from 'cesium';
import { solarParameters, sunPosition } from '../../data/solarDaylight.js';
import { CHUNK_COLUMNS, parseChunkKey } from './grid.js';
import { STUDY_SUN, STUDY_SUN_DIR, sunDirection } from './lighting.js';

/** The real sun lights the blocks above this elevation, else the study sun. */
export const REAL_SUN_MIN_ELEVATION_DEG = 15;
/** The fog colour when the scene has no background colour: a clear sky near the horizon. */
export const DEFAULT_FOG_COLOR = Object.freeze([0.71, 0.8, 0.9, 1]);
/** Cesium's sky atmosphere near the horizon by day, and at dusk. */
export const HORIZON_SKY_DAY = Object.freeze([0.55, 0.7, 0.9]);
export const HORIZON_SKY_DUSK = Object.freeze([0.12, 0.14, 0.22]);
/** The sun's elevations (degrees) the horizon goes from dusk to day over. */
export const SKY_DUSK_ELEVATION_DEG = -6;
export const SKY_DAY_ELEVATION_DEG = 10;
/** Below this camera height the sky atmosphere is what lies behind the far blocks. */
export const SKY_FOG_MAX_HEIGHT_M = 20_000;

/**
 * The horizon sky's colour for a sun elevation: day blue above 10°, a dark
 * dusk blue below −6° (civil twilight's end), between them a smooth blend;
 * the atmosphere's brightnessShift brightens or darkens it as it does the
 * sky.
 */
export function horizonSkyColor(sunElevationDeg, brightnessShift = 0) {
  const t = Math.min(
    1,
    Math.max(
      0,
      (sunElevationDeg - SKY_DUSK_ELEVATION_DEG) /
        (SKY_DAY_ELEVATION_DEG - SKY_DUSK_ELEVATION_DEG),
    ),
  );
  const blend = t * t * (3 - 2 * t);
  const gain = Math.max(0, 1 + (brightnessShift || 0));
  return HORIZON_SKY_DUSK.map((dusk, k) =>
    Math.min(1, (dusk + (HORIZON_SKY_DAY[k] - dusk) * blend) * gain),
  );
}

/**
 * The colour the fog fades the far blocks into: what is drawn behind
 * them. Near the ground with the sky atmosphere shown that is the horizon
 * sky (so the far ring melts into it, Minecraft's sky-coloured fog);
 * otherwise the scene's background colour (the hidden globe's black).
 * @returns {{color: number[], source: 'sky'|'background'}} color [r, g, b, 1]
 */
export function fogColorFor(scene, { heightM, sunElevationDeg }) {
  const sky = scene.skyAtmosphere;
  if (sky?.show && Number.isFinite(heightM) && heightM < SKY_FOG_MAX_HEIGHT_M)
    return {
      color: [...horizonSkyColor(sunElevationDeg, sky.brightnessShift), 1],
      source: 'sky',
    };
  const background = scene.backgroundColor;
  return {
    color: background
      ? [background.red, background.green, background.blue, 1]
      : [...DEFAULT_FOG_COLOR],
    source: 'background',
  };
}
/**
 * Each fragment is drawn this fraction of its distance nearer the eye, so
 * a block top level with the globe's surface (World Terrain, the photoreal
 * tiles) wins the depth test instead of flickering: 2 cm at 200 m, 1.5 m
 * at 15 km. A polygon offset would not do it: with Cesium's logarithmic
 * depth the fragment shader writes the depth.
 */
export const DEPTH_BIAS = 1e-4;

const RAD = Math.PI / 180;

/**
 * The sun the blocks are lit by at an instant (ms or a Date) and place: the real one when
 * it is more than 15° up, else the fixed study sun. `fixed` says which,
 * for the HUD.
 * @returns {{dir: {east: number, north: number, up: number}, fixed: boolean,
 *   elevationDeg: number, azimuthDeg: number, realElevationDeg: number}}
 */
export function blocksSun(now, lat, lon) {
  const ms = +now;
  const { elevation, hourAngle } = sunPosition(ms, lat, lon);
  const { declination } = solarParameters(ms);
  // Azimuth from north, clockwise, from the hour angle and declination.
  const h = hourAngle * RAD;
  const azimuth =
    (Math.atan2(
      Math.sin(h),
      Math.cos(h) * Math.sin(lat * RAD) -
        Math.tan(declination * RAD) * Math.cos(lat * RAD),
    ) /
      RAD +
      180 +
      360) %
    360;
  const fixed = !(elevation > REAL_SUN_MIN_ELEVATION_DEG);
  const elevationDeg = fixed ? STUDY_SUN.elevationDeg : elevation;
  const azimuthDeg = fixed ? STUDY_SUN.azimuthDeg : azimuth;
  return {
    dir: sunDirection(azimuthDeg, elevationDeg),
    fixed,
    elevationDeg,
    azimuthDeg,
    realElevationDeg: elevation,
  };
}

/** Block edges: how much a line darkens, and the distance (blocks) it fades out over. */
export const EDGE_DEFAULTS = Object.freeze({
  strength: 0.12,
  fadeStartBlocks: 200,
  fadeEndBlocks: 300,
});
/** Top-face tone dither: ± this share of the colour, per block. */
export const DITHER_DEFAULTS = Object.freeze({ amount: 0.03 });

const VERTEX_SHADER = `
const float DEPTH_BIAS = ${DEPTH_BIAS.toExponential()};
in vec3 position;
in vec3 normal;
in vec4 color;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
out vec3 v_localPosition;
out vec3 v_localNormal;
out vec2 v_chunk;

void main() {
  vec4 p = vec4(position, 1.0);
  vec4 positionEC = czm_modelView * p;
  v_positionEC = positionEC.xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  // A chunk in a batch is offset to the batch's origin: its own place again.
  v_localPosition = position - czm_batchTable_blockOffset(batchId);
  v_localNormal = normal;
  v_chunk = czm_batchTable_blockChunk(batchId);
  gl_Position = czm_projection * vec4(positionEC.xyz * (1.0 - DEPTH_BIAS), 1.0);
}
`;

const FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
in vec3 v_localPosition;
in vec3 v_localNormal;
in vec2 v_chunk;

void main() {
  czm_materialInput materialInput;
  materialInput.positionToEyeEC = -v_positionEC;
  materialInput.normalEC = normalize(v_normalEC);
  czm_material fog = czm_getMaterial(materialInput);
  float tone = blocks_tone(v_localPosition, v_localNormal, v_chunk, length(v_positionEC));
  out_FragColor = vec4(mix(v_color.rgb * tone, fog.diffuse, fog.alpha), v_color.a);
}
`;

// The fog and the block tone live in a material because a material's
// uniforms are the only ones an Appearance can carry. czm_getMaterial is
// the fog: diffuse its colour, alpha how much of it a fragment at that
// distance takes. blocks_tone is the shade that gives every block an edge:
// a line about 1.5 px wide where the face crosses a multiple of blockM on
// its two in-plane axes, fading out with distance and before the blocks
// are too small on the screen for a line (no moiré), and on top faces a
// per-block tone from a hash of the block's column, so a flat field is
// not one colour (faded out as a block nears a pixel).
const MATERIAL_SOURCE = `
float blocks_hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float blocks_line(float f) {
  float w = fwidth(f);
  float d = abs(f - floor(f + 0.5));
  float line = 1.0 - smoothstep(0.5 * w, w, d);
  return line * (1.0 - smoothstep(0.15, 0.35, w));
}

float blocks_tone(vec3 localPosition, vec3 localNormal, vec2 chunk, float distanceM) {
  vec3 f = localPosition / blockM;
  // Derivatives first, outside any branch.
  float lx = blocks_line(f.x);
  float ly = blocks_line(f.y);
  float lz = blocks_line(f.z);
  // A block under about a pixel gets no dither: it would sparkle as grain.
  float footprint = max(fwidth(f.x), fwidth(f.y));
  float ditherFade = 1.0 - smoothstep(0.5, 1.0, footprint);
  vec3 a = abs(localNormal);
  float line = a.z > 0.5 ? max(lx, ly) : a.x > 0.5 ? max(ly, lz) : max(lx, lz);
  float fade = 1.0 - smoothstep(edgeFadeStart, edgeFadeEnd, distanceM / blockM);
  float tone = 1.0 - edgeStrength * line * fade;
  if (localNormal.z > 0.5) {
    // The chunk is interpolated like any varying, so a hair off its whole
    // number; rounded, or the hash bands across the block.
    vec2 column = floor(chunk + 0.5) * ${CHUNK_COLUMNS.toFixed(1)} + floor(f.xy);
    tone *= 1.0 + ditherAmount * ditherFade * (2.0 * blocks_hash(column) - 1.0);
  }
  return tone;
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float d = length(materialInput.positionToEyeEC);
  float t = clamp((d - fogStartM) / max(fogEndM - fogStartM, 1.0), 0.0, 1.0);
  material.diffuse = fogColor.rgb;
  material.alpha = t * t * (3.0 - 2.0 * t) * fogColor.a;
  return material;
}
`;

function blocksMaterial(translucent) {
  return new Cesium.Material({
    translucent,
    fabric: {
      type: translucent ? 'BlocksFogWater' : 'BlocksFog',
      uniforms: {
        fogStartM: 1e9,
        fogEndM: 2e9,
        fogColor: new Cesium.Color(...DEFAULT_FOG_COLOR),
        blockM: 1,
        edgeStrength: 0,
        edgeFadeStart: EDGE_DEFAULTS.fadeStartBlocks,
        edgeFadeEnd: EDGE_DEFAULTS.fadeEndBlocks,
        ditherAmount: 0,
      },
      source: MATERIAL_SOURCE,
    },
  });
}

/** An edges or dither option (true, false, or settings) as settings; null when off. */
function styleOption(value, defaults) {
  if (value === false || value === null) return null;
  return { ...defaults, ...(typeof value === 'object' ? value : {}) };
}

function blocksAppearance(translucent) {
  return new Cesium.Appearance({
    material: blocksMaterial(translucent),
    translucent,
    closed: false,
    vertexShaderSource: VERTEX_SHADER,
    fragmentShaderSource: FRAGMENT_SHADER,
    renderState: Cesium.Appearance.getDefaultRenderState(translucent, false),
  });
}

/**
 * A mesh's faces split into opaque and water: mesh.js puts the opaque
 * faces first, [0, opaqueIndexCount) of the indices, and water after.
 * A part that uses only some of the vertices gets just those, renumbered;
 * a mesh without water is drawn from its own arrays.
 * @returns {{opaque: object|null, water: object|null}}
 */
export function splitMesh({
  positions,
  normals,
  colors,
  indices,
  opaqueIndexCount,
}) {
  const cut = Number.isInteger(opaqueIndexCount)
    ? opaqueIndexCount
    : indices.length;
  const vertexCount = positions.length / 3;
  const remap = new Int32Array(vertexCount);
  const part = (from, to) => {
    if (from >= to) return null;
    if (from === 0 && to === indices.length)
      return { positions, normals, colors, indices };
    remap.fill(-1);
    const out = new Uint32Array(to - from);
    let used = 0;
    for (let k = from; k < to; k++) {
      const v = indices[k];
      if (remap[v] < 0) remap[v] = used++;
      out[k - from] = remap[v];
    }
    const p = new Float32Array(used * 3);
    const n = new Float32Array(used * 3);
    const c = new Uint8Array(used * 4);
    for (let v = 0; v < vertexCount; v++) {
      const at = remap[v];
      if (at < 0) continue;
      p[at * 3] = positions[v * 3];
      p[at * 3 + 1] = positions[v * 3 + 1];
      p[at * 3 + 2] = positions[v * 3 + 2];
      n[at * 3] = normals[v * 3];
      n[at * 3 + 1] = normals[v * 3 + 1];
      n[at * 3 + 2] = normals[v * 3 + 2];
      c[at * 4] = colors[v * 4];
      c[at * 4 + 1] = colors[v * 4 + 1];
      c[at * 4 + 2] = colors[v * 4 + 2];
      c[at * 4 + 3] = colors[v * 4 + 3];
    }
    return { positions: p, normals: n, colors: c, indices: out };
  };
  return { opaque: part(0, cut), water: part(cut, indices.length) };
}

/**
 * A mesh part as the renderer keeps it to rebuild batches from: normals as
 * normalized bytes (they are axis unit vectors, so exact) and indices as
 * 16 bits where they fit; positions and colours as given.
 */
export function compactPart(part) {
  if (!part) return null;
  const { positions, normals, colors, indices } = part;
  let bytes = normals;
  if (!(normals instanceof Int8Array)) {
    bytes = new Int8Array(normals.length);
    for (let k = 0; k < normals.length; k++)
      bytes[k] = Math.round(normals[k] * 127);
  }
  const short =
    positions.length / 3 < 65536 && !(indices instanceof Uint16Array)
      ? new Uint16Array(indices)
      : indices;
  return { positions, normals: bytes, colors, indices: short };
}

/** A kept part's bytes. */
const partBytes = (part) =>
  part
    ? part.positions.byteLength +
      part.normals.byteLength +
      part.colors.byteLength +
      part.indices.byteLength
    : 0;

function meshGeometry({ positions, normals, colors, indices }, offset = null) {
  const vertexCount = positions.length / 3;
  if (offset && (offset.x || offset.y || offset.z)) {
    const moved = new Float32Array(positions.length);
    for (let k = 0; k < positions.length; k += 3) {
      moved[k] = positions[k] + offset.x;
      moved[k + 1] = positions[k + 1] + offset.y;
      moved[k + 2] = positions[k + 2] + offset.z;
    }
    positions = moved;
  }
  return new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: positions,
      }),
      normal:
        normals instanceof Int8Array
          ? new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.BYTE,
              componentsPerAttribute: 3,
              normalize: true,
              values: normals,
            })
          : new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.FLOAT,
              componentsPerAttribute: 3,
              values: normals,
            }),
      color: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
        componentsPerAttribute: 4,
        normalize: true,
        values: colors,
      }),
    },
    indices:
      vertexCount < 65536
        ? indices instanceof Uint16Array
          ? indices
          : Uint16Array.from(indices)
        : indices instanceof Uint32Array
          ? indices
          : Uint32Array.from(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });
}

/**
 * A Cesium.Primitive that updates as if the scene were 3D only. Unless it
 * is, Primitive projects DOUBLE positions to 2D and needs a Columbus-view
 * bounding sphere that float local positions never get; Blocks draws in 3D
 * only, so each update sees the frame state with scene3DOnly set (a view
 * of it, not a change to it) and the other scene modes draw nothing.
 */
export function primitive3D(options) {
  const primitive = new Cesium.Primitive(options);
  const update = primitive.update;
  primitive.update = function (frameState) {
    if (frameState.mode !== Cesium.SceneMode.SCENE3D) return;
    update.call(
      this,
      frameState.scene3DOnly
        ? frameState
        : Object.create(frameState, { scene3DOnly: { value: true } }),
    );
  };
  return primitive;
}

/** The region's frame: east-north-up at its origin, `datumOffsetM` above the ellipsoid. */
export function regionFrame(region, datumOffsetM = 0) {
  return Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(region.lon0, region.lat0, datumOffsetM || 0),
  );
}

/** Chunks a batch side: 4 × 4 chunks (a source.js group) draw as one primitive per kind. */
export const BATCH_CHUNKS = 4;
/** How long a batch's chunks are left alone before it is rebuilt with them, ms. */
export const BATCH_QUIET_MS = 1500;

/**
 * The batch a chunk key draws in: fine chunks 'ci:cj' by their 4 × 4
 * group, coarse ones 'c:gi:gj' by 4 × 4 coarse chunks; any other key alone.
 */
export function batchKeyOf(key) {
  const fine = parseChunkKey(key);
  if (fine)
    return `g:${Math.floor(fine.ci / BATCH_CHUNKS)}:${Math.floor(fine.cj / BATCH_CHUNKS)}`;
  const coarse = /^c:(-?\d+):(-?\d+)$/.exec(String(key));
  if (coarse)
    return `s:${Math.floor(Number(coarse[1]) / BATCH_CHUNKS)}:${Math.floor(Number(coarse[2]) / BATCH_CHUNKS)}`;
  return `k:${key}`;
}

/** A chunk's model matrix: the region's frame moved to the chunk's origin. */
export function chunkMatrix(frame, origin, result = new Cesium.Matrix4()) {
  return Cesium.Matrix4.multiplyByTranslation(
    frame,
    new Cesium.Cartesian3(origin.x, origin.y, origin.z || 0),
    result,
  );
}

/**
 * @param {{viewer: object, edges?: boolean|object, dither?: boolean|object,
 *   now?: () => number}} options edges: a line on every block edge
 *   (EDGE_DEFAULTS, on by default); dither: a per-block tone on top faces
 *   (DITHER_DEFAULTS, on by default). Water faces get neither. now: the
 *   wall clock the sky fog's sun is read on (Date.now).
 */
export function createBlocksRenderer({
  viewer,
  edges = true,
  dither = true,
  now = () => Date.now(),
  quietMs = BATCH_QUIET_MS,
  setTimeoutImpl = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle?.unref?.();
    return handle;
  },
  clearTimeoutImpl = (handle) => clearTimeout(handle),
} = {}) {
  const scene = viewer.scene;
  const collection = scene.primitives.add(
    new Cesium.PrimitiveCollection({ destroyPrimitives: true }),
  );
  const appearances = {
    opaque: blocksAppearance(false),
    water: blocksAppearance(true),
  };
  // Chunks draw in batches of 4 × 4 (batchKeyOf): one opaque and one water
  // primitive a batch, one geometry instance a chunk, so hundreds of chunks
  // are tens of draw calls. A chunk that arrives or changes draws alone at
  // once (its old instance in the batch hidden), and the batch is rebuilt
  // with it once it has been quiet for `quietMs`, one batch a frame, so
  // neither streaming nor an edit waits on rebuilding sixteen chunks.
  /** key → {batch, origin, parts: {opaque, water}, chunk: [ci, cj], alone: Primitive[], ids} */
  const chunks = new Map();
  /** batch key → {origin, members: Set, built: Map<key, ids>, primitives, changedAt} */
  const batches = new Map();
  const pending = new Set(); // batches with chunks drawn alone, or hidden
  let wake = null;
  let region = null;
  let datumOffsetM = 0;
  let frame = null;
  let sun = {
    dir: { ...STUDY_SUN_DIR },
    fixed: true,
  };
  // The fog colour follows what is drawn behind the blocks (fogColorFor:
  // the horizon sky near the ground, else the background) unless setFog
  // names one.
  let fog = { startM: 1e9, endM: 2e9, color: [...DEFAULT_FOG_COLOR] };
  let fogFollowsBackground = true;
  let fogSource = 'background';
  let destroyed = false;
  let style = {
    edges: styleOption(edges, EDGE_DEFAULTS),
    dither: styleOption(dither, DITHER_DEFAULTS),
  };

  const requestRender = () => scene.requestRender?.();

  /** The block size and the land's edge and dither uniforms. */
  function applyStyle() {
    const blockM = region?.blockM || 1;
    for (const [kind, appearance] of Object.entries(appearances)) {
      const uniforms = appearance.material.uniforms;
      const land = kind === 'opaque';
      uniforms.blockM = blockM;
      uniforms.edgeStrength = land && style.edges ? style.edges.strength : 0;
      uniforms.edgeFadeStart =
        style.edges?.fadeStartBlocks ?? EDGE_DEFAULTS.fadeStartBlocks;
      uniforms.edgeFadeEnd =
        style.edges?.fadeEndBlocks ?? EDGE_DEFAULTS.fadeEndBlocks;
      uniforms.ditherAmount = land && style.dither ? style.dither.amount : 0;
    }
  }
  applyStyle();

  function applyFog() {
    for (const appearance of Object.values(appearances)) {
      const uniforms = appearance.material.uniforms;
      uniforms.fogStartM = fog.startM;
      uniforms.fogEndM = fog.endM;
      uniforms.fogColor = new Cesium.Color(...fog.color);
    }
  }

  /**
   * The camera's height and the sun's elevation over it, on the wall clock
   * (`now`), the one the HUD's SUN and the Blocks sun read.
   */
  function viewNow() {
    const place = scene.camera?.positionCartographic;
    if (!place) return { heightM: NaN, sunElevationDeg: 90 };
    const ms = now();
    const lat = Cesium.Math.toDegrees(place.latitude);
    const lon = Cesium.Math.toDegrees(place.longitude);
    return {
      heightM: place.height,
      sunElevationDeg: sunPosition(ms, lat, lon).elevation,
    };
  }

  /** Take the colour behind the blocks as the fog's; true if it changed. */
  function followBackground() {
    if (!fogFollowsBackground) return false;
    const { color: next, source } = fogColorFor(scene, viewNow());
    fogSource = source;
    if (next.every((value, k) => Math.abs(value - fog.color[k]) < 1e-4))
      return false;
    fog.color = next;
    return true;
  }

  const removePreRender = scene.preRender?.addEventListener(() => {
    if (followBackground()) applyFog();
    flush();
  });
  followBackground();
  applyFog();

  /** A chunk's geometry instance: its place (the dither's global columns) and its offset in a batch (its own coordinates for the block edges). */
  function chunkInstance(key, held, kind, offset, id) {
    return new Cesium.GeometryInstance({
      geometry: meshGeometry(held.parts[kind], offset),
      id,
      attributes: {
        blockChunk: new Cesium.GeometryInstanceAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          value: held.chunk,
        }),
        blockOffset: new Cesium.GeometryInstanceAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          value: [offset.x, offset.y, offset.z],
        }),
        show: new Cesium.ShowGeometryInstanceAttribute(true),
      },
    });
  }

  function drawn(instances, kind, origin) {
    return collection.add(
      primitive3D({
        geometryInstances: instances,
        appearance: appearances[kind],
        modelMatrix: chunkMatrix(frame, origin),
        asynchronous: false,
        compressVertices: false,
        allowPicking: true,
        shadows: Cesium.ShadowMode.DISABLED,
      }),
    );
  }

  /** A chunk drawn alone, at its own origin. */
  function drawAlone(key, held) {
    const zero = { x: 0, y: 0, z: 0 };
    return ['opaque', 'water']
      .filter((kind) => held.parts[kind])
      .map((kind) =>
        drawn(
          [
            chunkInstance(key, held, kind, zero, {
              blocks: true,
              key,
              water: kind === 'water',
            }),
          ],
          kind,
          held.origin,
        ),
      );
  }

  /** Rebuild a batch from its chunks, each offset to the batch's origin; their lone primitives go. */
  function rebuild(batchKey) {
    const batch = batches.get(batchKey);
    pending.delete(batchKey);
    if (!batch) return;
    batch.rebuildNow = false;
    const instances = { opaque: [], water: [] };
    const built = new Map();
    for (const key of batch.members) {
      const held = chunks.get(key);
      const offset = {
        x: held.origin.x - batch.origin.x,
        y: held.origin.y - batch.origin.y,
        z: (held.origin.z || 0) - (batch.origin.z || 0),
      };
      const ids = {};
      for (const kind of ['opaque', 'water']) {
        if (!held.parts[kind]) continue;
        ids[kind] = { blocks: true, key, water: kind === 'water' };
        instances[kind].push(chunkInstance(key, held, kind, offset, ids[kind]));
      }
      built.set(key, ids);
    }
    const before = batch.primitives;
    batch.primitives = ['opaque', 'water']
      .filter((kind) => instances[kind].length)
      .map((kind) => drawn(instances[kind], kind, batch.origin));
    batch.built = built;
    for (const primitive of before) collection.remove(primitive);
    for (const key of batch.members) {
      const held = chunks.get(key);
      for (const primitive of held.alone) collection.remove(primitive);
      held.alone = [];
    }
    if (!batch.members.size) batches.delete(batchKey);
  }

  /**
   * Hide a chunk's instance in its batch (it is drawn alone, or gone); a
   * batch not drawn yet is rebuilt instead.
   */
  function hideInBatch(batch, key) {
    const ids = batch.built.get(key);
    if (!ids) return;
    batch.built.delete(key);
    for (const primitive of batch.primitives) {
      const id =
        primitive.appearance === appearances.water ? ids.water : ids.opaque;
      if (!id) continue;
      if (!primitive.ready) {
        batch.rebuildNow = true; // not drawn yet: rebuilt on the next frame
        continue;
      }
      const attributes = primitive.getGeometryInstanceAttributes(id);
      if (attributes)
        attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(false);
    }
  }

  /** Wake a frame when a pending batch has been quiet long enough (requestRenderMode draws only on request). */
  function scheduleWake() {
    if (wake !== null || !pending.size || destroyed) return;
    wake = setTimeoutImpl(() => {
      wake = null;
      requestRender();
      scheduleWake();
    }, quietMs);
  }

  function changed(batchKey, batch) {
    batch.changedAt = now();
    pending.add(batchKey);
    scheduleWake();
    requestRender();
  }

  /**
   * Rebuild pending batches that have been quiet for `quietMs`: one a frame
   * (each frame calls it), or every pending one with `{all: true}`.
   * @returns {number} batches rebuilt
   */
  function flush({ all = false } = {}) {
    if (!pending.size || !frame) return 0;
    const time = now();
    let rebuilt = 0;
    for (const batchKey of [...pending]) {
      const batch = batches.get(batchKey);
      if (
        !all &&
        batch &&
        !batch.rebuildNow &&
        time - batch.changedAt < quietMs
      )
        continue;
      rebuild(batchKey);
      rebuilt++;
      if (!all) break;
    }
    if (pending.size) requestRender();
    return rebuilt;
  }

  function dropChunk(key) {
    const held = chunks.get(key);
    if (!held) return false;
    chunks.delete(key);
    for (const primitive of held.alone) collection.remove(primitive);
    const batch = batches.get(held.batch);
    if (batch) {
      batch.members.delete(key);
      hideInBatch(batch, key);
      changed(held.batch, batch);
    }
    return true;
  }

  function dropAll() {
    for (const batch of batches.values())
      for (const primitive of batch.primitives) collection.remove(primitive);
    for (const held of chunks.values())
      for (const primitive of held.alone) collection.remove(primitive);
    batches.clear();
    chunks.clear();
    pending.clear();
  }

  function placeAll() {
    for (const batch of batches.values())
      for (const primitive of batch.primitives)
        primitive.modelMatrix = chunkMatrix(frame, batch.origin);
    for (const held of chunks.values())
      for (const primitive of held.alone)
        primitive.modelMatrix = chunkMatrix(frame, held.origin);
  }

  const api = {
    /**
     * Anchor the chunks to a region (grid.js), its level 0 base
     * `datumOffsetM` above the ellipsoid (the controller's call: 0 on a
     * flat basemap, the geoid's N on terrain). A different region drops
     * every chunk, since chunk keys are the region's; the same region at
     * another offset keeps them and moves them. Takes effect at once.
     */
    setRegion(next, { datumOffsetM: offset = 0 } = {}) {
      const offsetM = Number.isFinite(offset) ? offset : 0;
      const same =
        region &&
        next &&
        region.lon0 === next.lon0 &&
        region.lat0 === next.lat0 &&
        region.blockM === next.blockM;
      if (same && offsetM === datumOffsetM) return api.getState();
      if (!same) dropAll();
      region = next || null;
      datumOffsetM = offsetM;
      frame = region ? regionFrame(region, datumOffsetM) : null;
      applyStyle();
      if (same) placeAll();
      requestRender();
      return api.getState();
    },

    /**
     * Draw or replace a chunk's mesh (mesh.js's buildChunkMesh). It draws
     * alone at once, its old self in its batch hidden; the batch takes it
     * in when it has been quiet for `quietMs`. The mesh's arrays are kept
     * (as given: the mesher does not change them after) to rebuild from.
     */
    upsert(key, mesh) {
      if (!region) throw new Error('Blocks renderer: setRegion first');
      if (!mesh || !mesh.indices?.length) {
        if (!dropChunk(key)) requestRender();
        return;
      }
      const parsed = parseChunkKey(key);
      const origin =
        mesh.origin || (parsed && region.chunkOrigin(parsed.ci, parsed.cj));
      if (!origin) throw new Error(`Blocks renderer: no origin for ${key}`);
      const batchKey = batchKeyOf(key);
      const before = chunks.get(key);
      if (before) {
        for (const primitive of before.alone) collection.remove(primitive);
        if (before.batch !== batchKey) dropChunk(key);
      }
      let batch = batches.get(batchKey);
      if (!batch) {
        batch = {
          origin,
          members: new Set(),
          built: new Map(),
          primitives: [],
          changedAt: 0,
        };
        batches.set(batchKey, batch);
      }
      batch.members.add(key);
      hideInBatch(batch, key);
      const held = {
        batch: batchKey,
        origin,
        parts: Object.fromEntries(
          Object.entries(splitMesh(mesh)).map(([kind, part]) => [
            kind,
            compactPart(part),
          ]),
        ),
        chunk: [parsed?.ci ?? 0, parsed?.cj ?? 0],
        alone: [],
      };
      chunks.set(key, held);
      held.alone = drawAlone(key, held);
      changed(batchKey, batch);
    },

    remove(key) {
      if (dropChunk(key)) requestRender();
    },

    /**
     * The sun the meshes are lit by, ENU toward the sun; `fixed` when it is
     * the study sun. mesh.js bakes it, so a change is the controller's cue
     * to re-mesh; the renderer keeps it for the HUD.
     */
    setSun(dir, { fixed = false } = {}) {
      const length = Math.hypot(dir.east, dir.north, dir.up) || 1;
      sun = {
        dir: {
          east: dir.east / length,
          north: dir.north / length,
          up: dir.up / length,
        },
        fixed: Boolean(fixed),
      };
      return sun;
    },

    getSun: () => sun,

    /**
     * Fog from startM to endM from the eye, toward `color` (CSS, a
     * Cesium.Color or [r, g, b, a]); 'background' (or null) follows what
     * is behind the blocks again: the horizon sky near the ground, else
     * the background.
     */
    setFog({ startM, endM, color } = {}) {
      if (Number.isFinite(startM)) fog.startM = startM;
      if (Number.isFinite(endM)) fog.endM = endM;
      if (color === 'background' || color === null) fogFollowsBackground = true;
      else if (color !== undefined) {
        fogFollowsBackground = false;
        const c =
          typeof color === 'string'
            ? Cesium.Color.fromCssColorString(color)
            : Array.isArray(color)
              ? new Cesium.Color(...color)
              : color;
        fog.color = [c.red, c.green, c.blue, c.alpha ?? 1];
      }
      followBackground();
      applyFog();
      requestRender();
      return api.getState().fog;
    },

    /** Turn the edges or the dither on, off, or to other settings (as the options). */
    setStyle({ edges: nextEdges, dither: nextDither } = {}) {
      if (nextEdges !== undefined)
        style.edges = styleOption(nextEdges, EDGE_DEFAULTS);
      if (nextDither !== undefined)
        style.dither = styleOption(nextDither, DITHER_DEFAULTS);
      applyStyle();
      requestRender();
      return api.getState().style;
    },

    keys: () => [...chunks.keys()],

    /**
     * Rebuild the quiet pending batches (each frame does it, one a frame);
     * `{all: true}` rebuilds every pending one now. The number rebuilt.
     */
    flush,

    getState: () => ({
      region,
      datumOffsetM,
      style: {
        edges: style.edges && { ...style.edges },
        dither: style.dither && { ...style.dither },
      },
      chunks: chunks.size,
      batches: batches.size,
      // What is kept to rebuild batches from, MB.
      retainedMB:
        [...chunks.values()].reduce(
          (sum, held) =>
            sum + partBytes(held.parts.opaque) + partBytes(held.parts.water),
          0,
        ) / 1e6,
      primitives: collection.length,
      sun,
      fog: {
        ...fog,
        color: [...fog.color],
        followsBackground: fogFollowsBackground,
        source: fogFollowsBackground ? fogSource : 'set',
      },
    }),

    /** The collection the primitives are in (for tests and the harness). */
    getCollection: () => collection,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      removePreRender?.();
      if (wake !== null) clearTimeoutImpl(wake);
      wake = null;
      dropAll();
      scene.primitives.remove(collection);
      requestRender();
    },
  };
  return api;
}
