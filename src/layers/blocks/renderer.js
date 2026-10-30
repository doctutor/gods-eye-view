// Personal fork: draws the Blocks render mode's chunk meshes
// (docs/BLOCKS-PLAN.md). Chunks draw as Cesium Models from in-memory GLBs
// (gltf.js, the encoder the precomputed tileset shares), a batch of 4 × 4
// chunks a Model, its opaque faces one primitive and its translucent water
// another, the look a CustomShader (BLOCKS_SHADER_*). Positions stay float,
// in metres east, north and up of the batch's origin, and the Model's
// matrix puts them on the globe: the region's east-north-up frame at its origin,
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
// the shader adds the block edges, the dither and distance fog toward the
// sky colour (Cesium's own atmosphere fog is kept off the Models). Opaque faces
// write depth, so scene.pickPosition and the HUD's AGL and centre distance
// land on the blocks; water does not, so they land on the ground under it.

import * as Cesium from 'cesium';
import { solarParameters, sunPosition } from '../../data/solarDaylight.js';
import { CHUNK_COLUMNS, CURVED_BLOCK_M, parseChunkKey } from './grid.js';
import { createGlbService } from './glbService.js';
import { encodeBatchGlb, packPart } from './gltf.js';
import { packMesh, packedMeshHasFaces } from './packMesh.js';
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

// The look as a Cesium CustomShader on each batch's Model (gltf.js's
// layout), shared by every batch of a level. The vertex stage draws each
// vertex DEPTH_BIAS of its distance nearer the eye: the model coordinates'
// eye is czm_inverseModelView's origin, and a step toward it is the eye
// coordinates scaled by 1 − DEPTH_BIAS. It also hands the fragment the
// stored normal back in the region's frame (glTF's Y-up undone).
export const BLOCKS_SHADER_VERTEX = `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  vec3 eyeMC = (czm_inverseModelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vsOutput.positionMC += (eyeMC - vsOutput.positionMC) * ${DEPTH_BIAS.toExponential()};
  vec3 n = vsInput.attributes.normalMC;
  v_localNormal = vec3(n.x, -n.z, n.y);
}
`;

// The fragment stage: a ring's ground the rings inside it already draw is
// not drawn twice (blocks_inHole); every land block gets an edge, a line
// about 1.5 px wide where the face's block point (gltf.js _BLOCKCOORD,
// interpolated) crosses a whole number on its two in-plane axes, fading
// out with distance and before the blocks are too small on the screen for
// a line (no moiré); top faces get a per-block tone from a hash of the
// block's column (folded, so it runs on across chunks), faded out as a
// block nears a pixel; then the distance fog toward u_fogColor. Water
// (the only colour below full alpha) gets neither edge nor dither. The
// colours are the mesher's display values, so they go to the lighting
// stage as linear (it turns linear back into the frame buffer's sRGB).
export const BLOCKS_SHADER_FRAGMENT = `
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

// Within u_holeRadiusM of the inner rings' centre, measured across the
// ground (along the local up removed), the rings inside draw the ground;
// 0 is no hole.
bool blocks_inHole(vec3 positionEC) {
  if (u_holeRadiusM <= 0.0) return false;
  vec3 d = positionEC - u_holeCentreEC;
  vec3 across = d - dot(d, u_holeUpEC) * u_holeUpEC;
  return dot(across, across) < u_holeRadiusM * u_holeRadiusM;
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 positionEC = fsInput.attributes.positionEC;
  if (blocks_inHole(positionEC)) discard;
  vec4 color = fsInput.attributes.color_0;
  // gltf.js stores the block point in half blocks (SHORT).
  vec3 f = fsInput.attributes.blockcoord * 0.5;
  // Derivatives first, outside any branch.
  float lx = blocks_line(f.x);
  float ly = blocks_line(f.y);
  float lz = blocks_line(f.z);
  // A block under about a pixel gets no dither: it would sparkle as grain.
  float footprint = max(fwidth(f.x), fwidth(f.y));
  float ditherFade = 1.0 - smoothstep(0.5, 1.0, footprint);
  float land = step(0.999, color.a);
  vec3 a = abs(v_localNormal);
  float line = a.z > 0.5 ? max(lx, ly) : a.x > 0.5 ? max(ly, lz) : max(lx, lz);
  float distanceM = length(positionEC);
  float fade = 1.0 - smoothstep(u_edgeFadeStart, u_edgeFadeEnd, distanceM / u_blockM);
  float tone = 1.0 - u_edgeStrength * land * line * fade;
  if (v_localNormal.z > 0.5)
    tone *= 1.0 + u_ditherAmount * land * ditherFade * (2.0 * blocks_hash(floor(f.xy)) - 1.0);
  float t = clamp((distanceM - u_fogStartM) / max(u_fogEndM - u_fogStartM, 1.0), 0.0, 1.0);
  float fog = t * t * (3.0 - 2.0 * t) * u_fogColor.a;
  vec3 rgb = mix(color.rgb * tone, u_fogColor.rgb, fog);
#ifndef HDR
  rgb = czm_srgbToLinear(rgb);
#endif
  material.diffuse = rgb;
  material.alpha = color.a;
}
`;

/** The shader's uniforms as they start: no fog, no edges, no hole. */
const SHADER_UNIFORMS = () => ({
  u_fogStartM: { type: 'FLOAT', value: 1e9 },
  u_fogEndM: { type: 'FLOAT', value: 2e9 },
  u_fogColor: {
    type: 'VEC4',
    value: new Cesium.Cartesian4(...DEFAULT_FOG_COLOR),
  },
  u_blockM: { type: 'FLOAT', value: 1 },
  u_edgeStrength: { type: 'FLOAT', value: 0 },
  u_edgeFadeStart: { type: 'FLOAT', value: EDGE_DEFAULTS.fadeStartBlocks },
  u_edgeFadeEnd: { type: 'FLOAT', value: EDGE_DEFAULTS.fadeEndBlocks },
  u_ditherAmount: { type: 'FLOAT', value: 0 },
  u_holeRadiusM: { type: 'FLOAT', value: 0 },
  u_holeCentreEC: { type: 'VEC3', value: new Cesium.Cartesian3(0, 0, 0) },
  u_holeUpEC: { type: 'VEC3', value: new Cesium.Cartesian3(0, 0, 1) },
});

/**
 * A level's shader: the Blocks look over the baked colours, unlit, the
 * water's translucency from its glTF material (BLEND). It modifies the
 * material rather than replacing it: with a replacing fragment shader
 * Cesium skips the material stage, and with it the alpha mode, so the
 * water drew opaque and wrote depth (the fragment sets every colour and
 * alpha the material stage gave anyway).
 */
export function blocksShader() {
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: Cesium.LightingModel.UNLIT,
    translucencyMode: Cesium.CustomShaderTranslucencyMode.INHERIT,
    uniforms: Object.fromEntries(
      Object.entries(SHADER_UNIFORMS()).map(([name, { type, value }]) => [
        name,
        { type: Cesium.UniformType[type], value },
      ]),
    ),
    varyings: { v_localNormal: Cesium.VaryingType.VEC3 },
    vertexShaderText: BLOCKS_SHADER_VERTEX,
    fragmentShaderText: BLOCKS_SHADER_FRAGMENT,
  });
}

/** An edges or dither option (true, false, or settings) as settings; null when off. */
function styleOption(value, defaults) {
  if (value === false || value === null) return null;
  return { ...defaults, ...(typeof value === 'object' ? value : {}) };
}

// The mesh split into opaque and water (packMesh.js), as before.
export { splitMesh } from './packMesh.js';

/**
 * A Cesium.Model that updates as if the scene were 3D only and fogless:
 * Blocks draws in 3D only, so the other scene modes draw nothing, and the
 * fog is the shader's own (toward the sky behind the blocks), so Cesium's
 * atmosphere fog stage stays out of the model's shader. Each update sees a
 * view of the frame state with fog.renderable false (not a change to it).
 */
export function model3D(model) {
  const update = model.update;
  let state = null;
  let view = null;
  model.update = function (frameState) {
    if (frameState.mode !== Cesium.SceneMode.SCENE3D) return;
    if (frameState !== state) {
      state = frameState;
      view = frameState.fog
        ? Object.create(frameState, {
            fog: {
              value: Object.create(frameState.fog, {
                renderable: { value: false },
              }),
            },
          })
        : frameState;
    }
    update.call(this, view);
  };
  return model;
}

/** No image-based lighting: the blocks' light is baked (one, shared). */
let noImageLighting = null;
const imageLightingOff = () =>
  (noImageLighting ||= new Cesium.ImageBasedLighting({
    imageBasedLightingFactor: new Cesium.Cartesian2(0, 0),
  }));

/**
 * Every Blocks Model's clipping planes: this many, the same for the live
 * chunks and the tiles. Cesium compiles a Model's programs with its
 * clipping planes' count and state as defines, so the tiles' planes
 * turning on when the live hole opened linked four new programs mid-flight
 * (Lake Tahoe, 2026-10-30: 0.8 s waiting on them); with the same planes
 * always on, parked where they clip nothing, every Blocks Model shares one
 * set of four programs, linked at the first Blocks draw.
 */
export const CLIPPING_SIDES = 8;

/** Planes that clip nothing: every point lies on their kept side. */
export const parkedPlanes = (sides = CLIPPING_SIDES) =>
  Array.from(
    { length: sides },
    () => new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_Z, 1e10),
  );

/**
 * A Blocks Model's (or tileset's) clipping planes: CLIPPING_SIDES of them,
 * not uniting their regions (a point is clipped only outside every plane),
 * always on, parked unless given.
 */
export const blocksClippingPlanes = (planes = parkedPlanes()) =>
  new Cesium.ClippingPlaneCollection({
    planes,
    unionClippingRegions: false,
    enabled: true,
    edgeWidth: 0,
  });

/**
 * The pre-warm's GLB (blocksTiles.js prewarmPrograms): one ground quad and
 * one water quad, a centimetre across, enough for a Blocks Model's opaque
 * and translucent programs to be linked when it is drawn, with the feature
 * table of a live batch (glbStore.js: ci, cj, water) or of a tile (the
 * build's: ci, cj, blockM). Cesium compiles a Model's metadata into its
 * programs (metadata picking), so the two tables make two sets.
 */
export function prewarmBlocksGlb(schema = 'live') {
  const properties =
    schema === 'tile'
      ? {
          ci: new Int32Array(2),
          cj: new Int32Array(2),
          blockM: Float32Array.from([480, 480]),
        }
      : {
          ci: new Int32Array(2),
          cj: new Int32Array(2),
          water: Uint8Array.from([0, 1]),
        };
  const quad = (z, rgba) => ({
    positions: Float32Array.from([
      0,
      0,
      z,
      0.01,
      0,
      z,
      0.01,
      0.01,
      z,
      0,
      0.01,
      z,
    ]),
    normals: Int8Array.from([0, 0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127]),
    colors: Uint8Array.from([...rgba, ...rgba, ...rgba, ...rgba]),
    blockCoords: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  });
  return encodeBatchGlb({
    chunks: [
      {
        opaque: packPart(quad(0, [200, 194, 176, 255])),
        water: packPart(quad(0.005, [70, 120, 200, 160])),
        offset: { x: 0, y: 0, z: 0 },
        features: { opaque: 0, water: 1 },
      },
    ],
    features: { count: 2, properties },
  });
}

/** Each Blocks Model's own base path (createBlocksModel). */
let glbSerial = 0;

/**
 * A Blocks Model from a GLB (gltf.js), as the renderer draws it: no
 * vertical exaggeration (the controller bakes the relief into the mesh),
 * no environment map or image lighting, no shadows, picked by feature;
 * its axes a 3D Tiles tile's.
 * @returns {Promise<Cesium.Model>}
 */
export function createBlocksModel(
  glb,
  { modelMatrix, customShader, clipped = true },
) {
  return Cesium.Model.fromGltfAsync({
    gltf: glb,
    // Cesium caches a glTF's JSON and buffers by its address; an in-memory
    // GLB's is the base path, the same for all of them, so Models loading
    // at once took the first one's geometry. A path of its own each (the
    // buffers are in the GLB: nothing is fetched).
    basePath: `blocks-glb/${++glbSerial}/`,
    // glTF's Y-up turned to Z-up and nothing more, as a 3D Tiles tile is
    // (Cesium3DTileset's modelForwardAxis X): a lone Model's default Z
    // forward adds a quarter turn about up, which turned every batch about
    // its own corner.
    upAxis: Cesium.Axis.Y,
    forwardAxis: Cesium.Axis.X,
    modelMatrix,
    customShader,
    // The tiles' planes, parked: the same programs as every Blocks Model.
    ...(clipped ? { clippingPlanes: blocksClippingPlanes() } : {}),
    asynchronous: false,
    releaseGltfJson: true,
    enableVerticalExaggeration: false,
    environmentMapOptions: { enabled: false },
    imageBasedLighting: imageLightingOff(),
    shadows: Cesium.ShadowMode.DISABLED,
    allowPicking: true,
  });
}

/** The region's frame: east-north-up at its origin, `datumOffsetM` above the ellipsoid. */
export function regionFrame(region, datumOffsetM = 0) {
  return Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(region.lon0, region.lat0, datumOffsetM || 0),
  );
}

/**
 * A chunk of a ring's level (milestone 5, K rings): 'L<blockM>:ci:cj', its
 * chunk (ci, cj) of the region setRegions gave for that block size.
 */
export const levelChunkKey = (blockM, ci, cj) => `L${blockM}:${ci}:${cj}`;

/** A level chunk key's {blockM, ci, cj}, or null. */
export function parseLevelChunkKey(key) {
  const match = /^L(\d+(?:\.\d+)?):(-?\d+):(-?\d+)$/.exec(String(key));
  return match
    ? { blockM: Number(match[1]), ci: Number(match[2]), cj: Number(match[3]) }
    : null;
}

/** The share of the outermost ring's reach the fog starts at. */
export const RING_FOG_START = 0.7;

/**
 * The fog for K rings: from RING_FOG_START of the outermost ring's reach
 * (`reachBlocks` of its blocks) to that reach.
 */
export function ringsFog(regions, reachBlocks, start = RING_FOG_START) {
  const outer = Math.max(0, ...regions.map((region) => region?.blockM || 0));
  const reach = reachBlocks * outer;
  return { startM: start * reach, endM: reach };
}

/** Chunks a batch side: 4 × 4 chunks (a source.js group) draw as one primitive per kind. */
export const BATCH_CHUNKS = 4;
/**
 * A flat mesh's block points from its positions when the mesher gave none
 * (mesh.js gives them; an older mesh, a test's): positions over (blockM,
 * blockM, levelM). A curved mesh's positions are off that lattice: null.
 */
export function derivedBlockCoords(mesh, blockM, levelM = blockM) {
  if (mesh?.blockCoords) return mesh.blockCoords;
  const { positions } = mesh || {};
  if (!positions || !(blockM > 0)) return null;
  const out = new Float32Array(positions.length);
  for (let k = 0; k < positions.length; k += 3) {
    out[k] = positions[k] / blockM;
    out[k + 1] = positions[k + 1] / blockM;
    out[k + 2] = positions[k + 2] / (levelM > 0 ? levelM : blockM);
  }
  return out;
}

/**
 * Whether a chunk stands on the ellipsoid (the curved grid, CURVED_BLOCK_M
 * and up), so its local positions are off the block lattice: by its mesh's
 * own `curved`, else by its block size (a ring's level, the primary
 * region's, or four times that for a 'c:' coarse chunk).
 */
export function chunkIsCurved(key, mesh, primaryBlockM) {
  if (typeof mesh?.curved === 'boolean') return mesh.curved;
  const level = parseLevelChunkKey(key);
  if (level) return level.blockM >= CURVED_BLOCK_M;
  const coarse = /^c:/.test(String(key));
  return (primaryBlockM || 0) * (coarse ? BATCH_CHUNKS : 1) >= CURVED_BLOCK_M;
}

/**
 * A batch covering the view's centre is rebuilt after this much quiet, not
 * BATCH_QUIET_MS: soon, but not every frame while its chunks stream in.
 */
export const CENTRE_QUIET_MS = 250;

/**
 * How long a batch's chunks are left alone before it is rebuilt with them,
 * ms. Each rebuild encodes all 16 chunks again and makes a new Model of
 * them (it was Cesium's synchronous geometry pipeline: at 1.5 s a batch
 * rebuilt about 2.3 times as its chunks streamed in, each chunk about 2.65
 * passes, alone and in rebuilds: QA, 2026-10-29). Meanwhile its new chunks
 * draw alone, a draw call each.
 */
export const BATCH_QUIET_MS = 3000;

/**
 * The batch a chunk key draws in: fine chunks 'ci:cj' by their 4 × 4
 * group, coarse ones 'c:gi:gj' by 4 × 4 coarse chunks; any other key alone.
 */
export function batchKeyOf(key) {
  const level = parseLevelChunkKey(key);
  if (level)
    return `L${level.blockM}:g:${Math.floor(level.ci / BATCH_CHUNKS)}:${Math.floor(level.cj / BATCH_CHUNKS)}`;
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
 *   now?: () => number, createModel?: Function}} options edges: a line on
 *   every block edge (EDGE_DEFAULTS, on by default); dither: a per-block
 *   tone on top faces (DITHER_DEFAULTS, on by default). Water faces get
 *   neither. now: the wall clock the sky fog's sun is read on (Date.now).
 *   createModel: (glb, {modelMatrix, customShader}) → a Promise of a
 *   Model (createBlocksModel; a test's fake). glbService: where the
 *   chunks' parts are kept and the GLBs made (createGlbService: a worker).
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
  viewCentre = null,
  createModel = createBlocksModel,
  glbService = null,
} = {}) {
  // The chunks' geometry and the GLBs made of it, in a worker (glbService.js).
  const glbs = glbService || createGlbService();
  const scene = viewer.scene;
  const collection = scene.primitives.add(
    new Cesium.PrimitiveCollection({ destroyPrimitives: true }),
  );
  const shader = blocksShader();
  // The rings past the primary region (setRegions), by block size: each
  // its region, frame and shader (its blockM for the edges, its hole).
  /** blockM → {region, frame, shader} */
  const rings = new Map();
  // Chunks draw in batches of 4 × 4 (batchKeyOf): one Model a batch, its
  // opaque and water primitives (gltf.js), a feature a chunk and kind, so
  // hundreds of chunks are tens of draw calls. A chunk that arrives or
  // changes draws alone at once, as a Model of its own; once that is ready
  // its old features in the batch are hidden, and the batch is rebuilt with
  // it after `quietMs` of quiet, one batch a frame. A Model is ready a frame
  // or more after it is made, so what it replaces stays drawn until then.
  /** key → {batch, origin, parts: {opaque, water}, chunk: [ci, cj], level, plain, version, alone: entry[]} */
  const chunks = new Map();
  /**
   * batch key → {origin, level, plain, blockM, members: Set, current, next,
   * changedAt}; current (drawn) and next (being made) are builds:
   * {entry, keys, versions: Map<key, version>, hidden: Set}, feature s the
   * opaque faces of keys[s] and keys.length + s its water.
   */
  const batches = new Map();
  const pending = new Set(); // batches with chunks drawn alone, or hidden
  /** A drawn Model → whose it is: {key} alone, or {build} a batch's. */
  const owners = new WeakMap();
  let versions = 0;
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

  /** A region's metres a level (worker1's levelM), else its block size. */
  const levelMOf = (entry) =>
    entry?.levelM > 0 ? entry.levelM : entry?.blockM || 1;

  // A curved chunk (chunkIsCurved) without block points (mesh.js gives
  // them; an older mesh does not) draws without block edges or dither: its
  // positions are off the block lattice, so nothing could find its edges.
  const plainShader = blocksShader();

  /** Every shader, with the block size its edges are drawn at. */
  const shaderSets = () => [
    { blockM: region?.blockM || 1, shader },
    ...[...rings].map(([blockM, ring]) => ({ blockM, shader: ring.shader })),
    { blockM: 1, shader: plainShader, plain: true },
  ];

  /** The block size and the land's edge and dither uniforms. */
  function applyStyle() {
    for (const { blockM, shader: set, plain } of shaderSets())
      styleShader(set, blockM, { plain });
  }

  function styleShader(set, blockM, { plain } = {}) {
    set.setUniform('u_blockM', blockM);
    set.setUniform(
      'u_edgeStrength',
      !plain && style.edges ? style.edges.strength : 0,
    );
    set.setUniform(
      'u_edgeFadeStart',
      style.edges?.fadeStartBlocks ?? EDGE_DEFAULTS.fadeStartBlocks,
    );
    set.setUniform(
      'u_edgeFadeEnd',
      style.edges?.fadeEndBlocks ?? EDGE_DEFAULTS.fadeEndBlocks,
    );
    set.setUniform(
      'u_ditherAmount',
      !plain && style.dither ? style.dither.amount : 0,
    );
  }
  applyStyle();

  function applyFog() {
    const color = new Cesium.Cartesian4(...fog.color);
    for (const { shader: set } of shaderSets()) {
      set.setUniform('u_fogStartM', fog.startM);
      set.setUniform('u_fogEndM', fog.endM);
      set.setUniform('u_fogColor', color);
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

  // The rings' holes (setRingHoles): a centre on the ground and, by ring
  // level, the inner rings' reach; their uniforms follow the view each frame.
  let holes = null;
  function applyHoles() {
    const view = scene.camera?.viewMatrix;
    const radiusOf = (level) =>
      holes && view ? Number(holes.reachM?.[level]) || 0 : 0;
    let centreEC = null;
    let upEC = null;
    if (holes && view) {
      const world = Cesium.Cartesian3.fromDegrees(
        holes.lon,
        holes.lat,
        datumOffsetM || 0,
      );
      centreEC = Cesium.Matrix4.multiplyByPoint(
        view,
        world,
        new Cesium.Cartesian3(),
      );
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        world,
        new Cesium.Cartesian3(),
      );
      upEC = Cesium.Cartesian3.normalize(
        Cesium.Matrix4.multiplyByPointAsVector(view, up, up),
        up,
      );
    }
    for (const [level, ring] of rings) {
      const radius = radiusOf(level);
      ring.shader.setUniform('u_holeRadiusM', radius);
      if (radius > 0) {
        ring.shader.setUniform('u_holeCentreEC', centreEC);
        ring.shader.setUniform('u_holeUpEC', upEC);
      }
    }
  }

  const removePreRender = scene.preRender?.addEventListener(() => {
    if (followBackground()) applyFog();
    applyHoles();
    flush();
  });
  followBackground();
  applyFog();

  /** A level's frame and shader: a ring's, else the primary region's. */
  const levelOf = (level) => {
    const ring = level ? rings.get(level) : null;
    return ring
      ? { frame: ring.frame, shader: ring.shader }
      : { frame, shader };
  };

  /** Where a chunk or batch ({origin, level}) draws: its level's frame at its origin. */
  const matrixOf = (place) =>
    chunkMatrix(levelOf(place.level).frame, place.origin);

  /**
   * How often geometry was made: chunks drawn alone, batch rebuilds, the
   * chunks those combined, Models made, those rejected, and the main
   * thread's ms spent packing meshes meshed in this thread (a mesh
   * worker's come packed; the GLBs are made in the GLB worker).
   */
  const stats = {
    alone: 0,
    rebuilds: 0,
    rebuiltChunks: 0,
    models: 0,
    failed: 0,
    packMs: 0,
  };
  /** Models being made or loaded: not drawn yet, not taken away. */
  const loading = new Set();

  const clock = () => globalThis.performance?.now?.() ?? Date.now();

  /** Take a drawn (or still being made) Model away. */
  function removeEntry(entry) {
    if (!entry || entry.removed) return;
    entry.removed = true;
    loading.delete(entry);
    if (entry.model) collection.remove(entry.model);
    entry.model = null;
  }

  /**
   * A Model of a GLB (a promise of one, from the GLB worker) at a place
   * ({origin, level, plain}), made asynchronously: the entry {model, ready,
   * removed}; `onReady(entry)` once it draws (at once for a GLB of no
   * faces), `onFailed(entry)` if the GLB or the Model is rejected (what it
   * was to replace stays drawn). Taken away before then, it is never added.
   */
  function drawModel(source, place, owner, onReady, onFailed = () => {}) {
    const entry = { model: null, ready: false, removed: false };
    const done = () => {
      if (entry.removed || entry.ready) return;
      loading.delete(entry);
      entry.ready = true;
      onReady(entry);
      requestRender();
    };
    loading.add(entry);
    const customShader = place.plain
      ? plainShader
      : levelOf(place.level).shader;
    Promise.resolve(source)
      .then((glb) => {
        if (entry.removed || destroyed) return null;
        if (!glb) {
          done();
          return null;
        }
        stats.models++;
        return createModel(glb, { modelMatrix: matrixOf(place), customShader });
      })
      .then((model) => {
        if (!model) return;
        if (entry.removed || destroyed || !levelOf(place.level).frame) {
          model.destroy?.();
          return;
        }
        // The frame may have moved while it was made (placeAll).
        model.modelMatrix = matrixOf(place);
        entry.model = model3D(model);
        owners.set(model, owner);
        // Whose it is, on the Model too (the QA harness isolates levels).
        model.blocksOwner = owner;
        collection.add(model);
        if (model.ready) done();
        else model.readyEvent?.addEventListener(done);
        requestRender();
      })
      .catch((error) => {
        if (entry.removed) return;
        loading.delete(entry);
        entry.failed = true;
        stats.failed++;
        console.warn('[blocks] a chunk Model failed:', error?.message || error);
        onFailed(entry);
      });
    return entry;
  }

  /**
   * A chunk drawn alone, at its own origin, from its own GLB (`source`, a
   * promise from the GLB worker). Once it draws, the chunk's earlier Models
   * go and its old features in the batch are hidden.
   */
  function drawAlone(key, held, source) {
    stats.alone++;
    const entry = drawModel(source, held, { key }, () => {
      // Replaced (the newer one takes this away) or dropped: nothing.
      if (chunks.get(key) !== held) return;
      for (const other of held.alone) if (other !== entry) removeEntry(other);
      held.alone = [entry];
      const batch = batches.get(held.batch);
      if (batch) hideInBatch(batch, key);
    });
    return entry;
  }

  /**
   * Rebuild a batch from its chunks, each offset to the batch's origin.
   * Once the new Model draws, the old one goes, and with it the lone Models
   * of the chunks it holds as they are now; a chunk changed or dropped
   * meanwhile is hidden in it.
   */
  function rebuild(batchKey) {
    const batch = batches.get(batchKey);
    pending.delete(batchKey);
    if (!batch) return;
    if (!batch.members.size) {
      dropBatch(batchKey);
      return;
    }
    stats.rebuilds++;
    stats.rebuiltChunks += batch.members.size;
    const keys = [...batch.members];
    const members = keys.map((key) => {
      const held = chunks.get(key);
      return {
        key,
        offset: {
          x: held.origin.x - batch.origin.x,
          y: held.origin.y - batch.origin.y,
          z: (held.origin.z || 0) - (batch.origin.z || 0),
        },
      };
    });
    // The versions are the GLB worker's: what it held when it made the GLB.
    const build = { entry: null, keys, versions: new Map(), hidden: new Set() };
    removeEntry(batch.next?.entry);
    batch.next = build;
    const source = glbs.batch(members).then(({ glb, versions }) => {
      keys.forEach((key, s) => build.versions.set(key, versions[s]));
      return glb;
    });
    build.entry = drawModel(
      source,
      batch,
      { build },
      () => batchReady(batchKey, build),
      // Rejected: its chunks stay drawn alone, and it is tried again after
      // the next quiet.
      () => {
        const now = batches.get(batchKey);
        if (now?.next !== build) return;
        now.next = null;
        changed(batchKey, now);
      },
    );
  }

  function batchReady(batchKey, build) {
    const batch = batches.get(batchKey);
    if (!batch || batch.next !== build) return;
    batch.next = null;
    removeEntry(batch.current?.entry);
    batch.current = build;
    for (const key of build.keys) {
      const held = chunks.get(key);
      if (
        held &&
        held.batch === batchKey &&
        held.version === build.versions.get(key)
      ) {
        for (const entry of held.alone) removeEntry(entry);
        held.alone = [];
      } else hideInBatch(batch, key);
    }
  }

  /** Hide a chunk's features in its batch's drawn Model (it is drawn alone, or gone). */
  function hideInBatch(batch, key) {
    const build = batch.current;
    const s = build ? build.keys.indexOf(key) : -1;
    if (s < 0 || build.hidden.has(key)) return;
    build.hidden.add(key);
    const model = build.entry?.model;
    const table = model?.featureTables?.[model.featureTableId];
    if (table) {
      table.setShow(s, false);
      table.setShow(build.keys.length + s, false);
    }
    requestRender();
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

  /** The point on the ground the view looks at: the screen's centre on the ellipsoid, else under the camera. */
  function centreNow() {
    if (viewCentre) return viewCentre();
    const camera = scene.camera;
    const canvas = scene.canvas;
    try {
      const picked =
        canvas &&
        camera?.pickEllipsoid?.(
          new Cesium.Cartesian2(
            (canvas.clientWidth || canvas.width || 0) / 2,
            (canvas.clientHeight || canvas.height || 0) / 2,
          ),
        );
      if (picked) return picked;
      return camera?.positionWC
        ? Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(camera.positionWC)
        : null;
    } catch {
      return null;
    }
  }

  /** A batch's middle in world coordinates, and the radius it covers, m. */
  function batchPlace(batch) {
    const side = BATCH_CHUNKS * CHUNK_COLUMNS * (batch.blockM || 1);
    const middle = Cesium.Matrix4.multiplyByPoint(
      matrixOf(batch),
      new Cesium.Cartesian3(side / 2, side / 2, 0),
      new Cesium.Cartesian3(),
    );
    return { middle, radius: (side / 2) * Math.SQRT2 };
  }

  /**
   * Pending batches, nearest the view's centre first (with no centre, as
   * they came), each with whether it covers the centre.
   */
  function pendingByCentre() {
    const keys = [...pending];
    const centre = frame ? centreNow() : null;
    if (!centre) return keys.map((batchKey) => ({ batchKey, covers: false }));
    return keys
      .map((batchKey) => {
        const batch = batches.get(batchKey);
        if (!batch) return { batchKey, distance: -1, covers: false };
        const { middle, radius } = batchPlace(batch);
        const distance = Cesium.Cartesian3.distance(middle, centre);
        return { batchKey, distance, covers: distance <= radius };
      })
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Rebuild pending batches that have been quiet for `quietMs`: one a frame
   * (each frame calls it), nearest the view's centre first, a batch that
   * covers the centre after only CENTRE_QUIET_MS; or every pending one
   * with `{all: true}`.
   * @returns {number} batches rebuilt
   */
  function flush({ all = false } = {}) {
    if (!pending.size || !frame) return 0;
    const time = now();
    let rebuilt = 0;
    for (const { batchKey, covers } of pendingByCentre()) {
      const batch = batches.get(batchKey);
      if (
        !all &&
        batch &&
        time - batch.changedAt <
          (covers ? Math.min(quietMs, CENTRE_QUIET_MS) : quietMs)
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
    glbs.forget(key);
    for (const entry of held.alone) removeEntry(entry);
    const batch = batches.get(held.batch);
    if (batch) {
      batch.members.delete(key);
      hideInBatch(batch, key);
      changed(held.batch, batch);
    }
    return true;
  }

  function dropBatch(batchKey) {
    const batch = batches.get(batchKey);
    if (!batch) return;
    removeEntry(batch.current?.entry);
    removeEntry(batch.next?.entry);
    batches.delete(batchKey);
    pending.delete(batchKey);
  }

  function dropAll() {
    for (const batchKey of [...batches.keys()]) dropBatch(batchKey);
    for (const held of chunks.values())
      for (const entry of held.alone) removeEntry(entry);
    chunks.clear();
    pending.clear();
    glbs.forgetAll();
  }

  function placeAll() {
    for (const batch of batches.values())
      for (const build of [batch.current, batch.next])
        if (build?.entry?.model)
          build.entry.model.modelMatrix = matrixOf(batch);
    for (const held of chunks.values())
      for (const entry of held.alone)
        if (entry.model) entry.model.modelMatrix = matrixOf(held);
  }

  /** Drop the chunks of one ring's level (its region changed or went). */
  function dropLevel(level) {
    for (const [key, held] of [...chunks])
      if (held.level === level) dropChunk(key);
  }

  const sameRegion = (a, b) =>
    Boolean(a && b) &&
    a.lon0 === b.lon0 &&
    a.lat0 === b.lat0 &&
    a.blockM === b.blockM &&
    levelMOf(a) === levelMOf(b);

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
      const same = sameRegion(region, next);
      if (same && offsetM === datumOffsetM) return api.getState();
      if (!same) {
        dropAll();
        rings.clear();
      }
      region = next || null;
      datumOffsetM = offsetM;
      frame = region ? regionFrame(region, datumOffsetM) : null;
      for (const ring of rings.values())
        ring.frame = regionFrame(ring.region, datumOffsetM);
      applyStyle();
      if (same) placeAll();
      requestRender();
      return api.getState();
    },

    /**
     * K rings (milestone 5): a region a level, the finest the primary one
     * (setRegion's: its chunks keyed 'ci:cj' and 'c:gi:gj' as before),
     * each coarser one keyed levelChunkKey(blockM, ci, cj) and drawn in
     * its own frame with its own block edges. `regions` is an array or a
     * Map of them. A level whose region changed loses its chunks, one no
     * longer given loses them and its frame; the primary changing drops
     * everything (as setRegion). One datumOffsetM for every level.
     * `fogReachBlocks`: the fog set from the outermost ring's reach
     * (ringsFog), else left as it is.
     */
    /**
     * The rings' holes: the ground about {lon, lat} (the inner rings'
     * centre, the camera's ground when they were chosen) within
     * `reachM[level]` metres is the rings inside a ring's, so that ring
     * does not draw it, whatever its chunks cover (a ring chunk is 64 of
     * its blocks, the hole may be fewer). null: no holes.
     */
    setRingHoles(next) {
      holes =
        next && Number.isFinite(next.lon) && Number.isFinite(next.lat)
          ? { lon: next.lon, lat: next.lat, reachM: { ...next.reachM } }
          : null;
      applyHoles();
      requestRender();
      return holes && { ...holes, reachM: { ...holes.reachM } };
    },

    setRegions(
      regions,
      { datumOffsetM: offset = 0, fogReachBlocks = null } = {},
    ) {
      const list = [...(regions instanceof Map ? regions.values() : regions)]
        .filter(Boolean)
        .sort((a, b) => a.blockM - b.blockM);
      const [primary = null, ...outer] = list;
      api.setRegion(primary, { datumOffsetM: offset });
      const wanted = new Map(outer.map((next) => [next.blockM, next]));
      for (const level of [...rings.keys()])
        if (!wanted.has(level)) {
          dropLevel(level);
          rings.delete(level);
        }
      for (const [level, next] of wanted) {
        const ring = rings.get(level);
        if (ring && sameRegion(ring.region, next)) continue;
        if (ring) dropLevel(level);
        const set = ring?.shader || blocksShader();
        rings.set(level, {
          region: next,
          frame: regionFrame(next, datumOffsetM),
          shader: set,
        });
        styleShader(set, level);
      }
      if (Number.isFinite(fogReachBlocks) && list.length) {
        const ringFog = ringsFog(list, fogReachBlocks);
        fog.startM = ringFog.startM;
        fog.endM = ringFog.endM;
      }
      applyFog();
      requestRender();
      return api.getState();
    },

    /**
     * Draw or replace a chunk's mesh: mesh.js's buildChunkMesh, or one a
     * mesh worker packed (packMesh.js). It draws alone as soon as its Model
     * is ready, its old self in its batch hidden then; the batch takes it
     * in when it has been quiet for `quietMs`. Its packed parts go to the
     * GLB worker (a packed mesh's buffers are transferred: given again, as
     * a coarse chunk's is when it comes back, the worker's are used).
     */
    upsert(key, mesh) {
      if (!region) throw new Error('Blocks renderer: setRegion first');
      const faces = mesh?.packedParts
        ? packedMeshHasFaces(mesh)
        : Boolean(mesh?.indices?.length);
      if (!faces) {
        if (!dropChunk(key)) requestRender();
        return;
      }
      const leveled = parseLevelChunkKey(key);
      const ring = leveled ? rings.get(leveled.blockM) : null;
      if (leveled && !ring)
        throw new Error(`Blocks renderer: no ring of ${leveled.blockM} m`);
      const parsed = leveled || parseChunkKey(key);
      const origin =
        mesh.origin ||
        (parsed && (ring?.region || region).chunkOrigin(parsed.ci, parsed.cj));
      if (!origin) throw new Error(`Blocks renderer: no origin for ${key}`);
      const batchKey = batchKeyOf(key);
      const before = chunks.get(key);
      if (before && before.batch !== batchKey) dropChunk(key);
      // Its earlier Models stay drawn until the new one is ready.
      const earlier = before && before.batch === batchKey ? before.alone : [];
      // The chunk whose columns fold into its block points: its own, a
      // coarse chunk's group (as the mesh worker folds them).
      const coarse = /^c:(-?\d+):(-?\d+)$/.exec(key);
      const chunk = parsed
        ? [parsed.ci, parsed.cj]
        : coarse
          ? [Number(coarse[1]), Number(coarse[2])]
          : [0, 0];
      let packed = mesh.packedParts ? mesh : null;
      if (!packed) {
        // Meshed in this thread: packed here. Its block points: the
        // mesher's, else from a flat mesh's positions; a curved one without
        // them draws plain (no edges, no dither).
        const start = clock();
        const scaleM =
          leveled?.blockM ??
          region.blockM * (/^c:/.test(key) ? BATCH_CHUNKS : 1);
        const blockCoords = chunkIsCurved(key, mesh, region.blockM)
          ? mesh.blockCoords || null
          : derivedBlockCoords(
              mesh,
              scaleM,
              // Fine and coarse chunks are meshed on the region's levels.
              levelMOf(ring?.region || region),
            );
        packed = packMesh(mesh, { chunk, blockCoords });
        stats.packMs += clock() - start;
      }
      const plain = packed.plain;
      let batch = batches.get(batchKey);
      if (!batch) {
        batch = {
          origin,
          level: leveled?.blockM ?? null,
          plain,
          // Its blocks' size and a side in blocks: where its middle is.
          blockM:
            leveled?.blockM ??
            region.blockM * (/^c:/.test(key) ? BATCH_CHUNKS : 1),
          members: new Set(),
          current: null,
          next: null,
          changedAt: 0,
        };
        batches.set(batchKey, batch);
      }
      batch.members.add(key);
      const held = {
        batch: batchKey,
        origin,
        chunk,
        level: leveled?.blockM ?? null,
        plain,
        version: ++versions,
        alone: earlier,
      };
      chunks.set(key, held);
      // A packed mesh given before has its buffers in the GLB worker.
      const source = packed.given
        ? glbs.revive(key, held.version)
        : glbs.put(key, held.version, packed.packedParts, chunk);
      if (packed === mesh) mesh.given = true;
      held.alone = [...earlier, drawAlone(key, held, source)];
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

    /** Show or hide every chunk at once (Blocks left for a while: kept, hidden). */
    setVisible(on) {
      collection.show = Boolean(on);
      requestRender();
    },

    getState: () => ({
      holes: holes && { ...holes, reachM: { ...holes.reachM } },
      region,
      // Every level drawn, finest first: {blockM, lon0, lat0, chunks}.
      regions: [region, ...[...rings.values()].map((ring) => ring.region)]
        .filter(Boolean)
        .map((entry, k) => ({
          blockM: entry.blockM,
          lon0: entry.lon0,
          lat0: entry.lat0,
          chunks: [...chunks.values()].filter((held) =>
            k === 0 ? held.level === null : held.level === entry.blockM,
          ).length,
        })),
      datumOffsetM,
      style: {
        edges: style.edges && { ...style.edges },
        dither: style.dither && { ...style.dither },
      },
      chunks: chunks.size,
      batches: batches.size,
      stats: { ...stats },
      // Models made and not drawn yet (one that never loads stays here).
      loadingModels: loading.size,
      // What the GLB worker keeps to rebuild batches from, MB.
      retainedMB: glbs.stats().bytes / 1e6,
      glbInWorker: glbs.inWorker(),
      // The GLB worker's count of chunks kept and kept aside (its last answer).
      glbStore: glbs.stats(),
      // The Models drawn or being added (each batch's, each lone chunk's).
      primitives: collection.length,
      sun,
      fog: {
        ...fog,
        color: [...fog.color],
        followsBackground: fogFollowsBackground,
        source: fogFollowsBackground ? fogSource : 'set',
      },
    }),

    /**
     * A pick's chunk: {key, water} when `picked` (scene.pick's result, a
     * feature of a Blocks Model) is one of the chunks drawn, else null.
     */
    pickedChunk(picked) {
      const owner = picked?.primitive ? owners.get(picked.primitive) : null;
      const id = picked?.featureId;
      if (!owner || !Number.isInteger(id)) return null;
      if (owner.key) return { key: owner.key, water: id === 1 };
      const n = owner.build.keys.length;
      const key = owner.build.keys[id % n];
      return key === undefined ? null : { key, water: id >= n };
    },

    /** The collection the Models are in (for tests and the harness). */
    getCollection: () => collection,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      removePreRender?.();
      if (wake !== null) clearTimeoutImpl(wake);
      wake = null;
      dropAll();
      glbs.destroy();
      rings.clear();
      scene.primitives.remove(collection);
      requestRender();
    },
  };
  return api;
}
