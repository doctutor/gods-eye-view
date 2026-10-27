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
  v_localPosition = position;
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

function meshGeometry({ positions, normals, colors, indices }) {
  const vertexCount = positions.length / 3;
  return new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: positions,
      }),
      normal: new Cesium.GeometryAttribute({
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
        ? Uint16Array.from(indices)
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
} = {}) {
  const scene = viewer.scene;
  const collection = scene.primitives.add(
    new Cesium.PrimitiveCollection({ destroyPrimitives: true }),
  );
  const appearances = {
    opaque: blocksAppearance(false),
    water: blocksAppearance(true),
  };
  const chunks = new Map(); // key → {origin, primitives: Primitive[]}
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
  });
  followBackground();
  applyFog();

  function dropChunk(key) {
    const held = chunks.get(key);
    if (!held) return false;
    for (const primitive of held.primitives) collection.remove(primitive);
    chunks.delete(key);
    return true;
  }

  function placeAll() {
    for (const held of chunks.values())
      for (const primitive of held.primitives)
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
      if (!same) for (const key of [...chunks.keys()]) dropChunk(key);
      region = next || null;
      datumOffsetM = offsetM;
      frame = region ? regionFrame(region, datumOffsetM) : null;
      applyStyle();
      if (same) placeAll();
      requestRender();
      return api.getState();
    },

    /** Draw or replace a chunk's mesh (mesh.js's buildChunkMesh). */
    upsert(key, mesh) {
      if (!region) throw new Error('Blocks renderer: setRegion first');
      dropChunk(key);
      if (!mesh || !mesh.indices?.length) {
        requestRender();
        return;
      }
      const parsed = parseChunkKey(key);
      const origin =
        mesh.origin || (parsed && region.chunkOrigin(parsed.ci, parsed.cj));
      if (!origin) throw new Error(`Blocks renderer: no origin for ${key}`);
      const parts = splitMesh(mesh);
      const primitives = [];
      for (const kind of ['opaque', 'water']) {
        if (!parts[kind]) continue;
        primitives.push(
          collection.add(
            primitive3D({
              geometryInstances: new Cesium.GeometryInstance({
                geometry: meshGeometry(parts[kind]),
                id: { blocks: true, key, water: kind === 'water' },
                attributes: {
                  // The chunk's place, so the dither's columns are global.
                  blockChunk: new Cesium.GeometryInstanceAttribute({
                    componentDatatype: Cesium.ComponentDatatype.FLOAT,
                    componentsPerAttribute: 2,
                    value: [parsed?.ci ?? 0, parsed?.cj ?? 0],
                  }),
                },
              }),
              appearance: appearances[kind],
              modelMatrix: chunkMatrix(frame, origin),
              asynchronous: false,
              compressVertices: false,
              allowPicking: true,
              shadows: Cesium.ShadowMode.DISABLED,
            }),
          ),
        );
      }
      chunks.set(key, { origin, primitives });
      requestRender();
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

    getState: () => ({
      region,
      datumOffsetM,
      style: {
        edges: style.edges && { ...style.edges },
        dither: style.dither && { ...style.dither },
      },
      chunks: chunks.size,
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
      chunks.clear();
      scene.primitives.remove(collection);
      requestRender();
    },
  };
  return api;
}
