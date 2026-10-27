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
// land on the blocks; water's depth is picked too while blocks are drawn
// (scene.pickTranslucentDepth).

import * as Cesium from 'cesium';
import { solarParameters, sunPosition } from '../../data/solarDaylight.js';

/** The real sun lights the blocks above this elevation, else the study sun. */
export const REAL_SUN_MIN_ELEVATION_DEG = 15;
/** The study sun: 60° up from the south-west. */
export const STUDY_SUN = Object.freeze({ elevationDeg: 60, azimuthDeg: 225 });
/** The fog colour until setFog names one: a clear sky near the horizon. */
export const DEFAULT_FOG_COLOR = Object.freeze([0.71, 0.8, 0.9, 1]);

const RAD = Math.PI / 180;

/** A unit vector toward the sun in east-north-up from elevation and azimuth (from north, clockwise). */
export function sunVector(elevationDeg, azimuthDeg) {
  const el = elevationDeg * RAD;
  const az = azimuthDeg * RAD;
  return {
    east: Math.sin(az) * Math.cos(el),
    north: Math.cos(az) * Math.cos(el),
    up: Math.sin(el),
  };
}

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
    dir: sunVector(elevationDeg, azimuthDeg),
    fixed,
    elevationDeg,
    azimuthDeg,
    realElevationDeg: elevation,
  };
}

const VERTEX_SHADER = `
in vec3 position;
in vec3 normal;
in vec4 color;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;

void main() {
  vec4 p = vec4(position, 1.0);
  v_positionEC = (czm_modelView * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  gl_Position = czm_modelViewProjection * p;
}
`;

const FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;

void main() {
  czm_materialInput materialInput;
  materialInput.positionToEyeEC = -v_positionEC;
  materialInput.normalEC = normalize(v_normalEC);
  czm_material fog = czm_getMaterial(materialInput);
  out_FragColor = vec4(mix(v_color.rgb, fog.diffuse, fog.alpha), v_color.a);
}
`;

// The fog lives in a material because a material's uniforms are the only
// ones an Appearance can carry: diffuse is the fog colour, alpha how much
// of it a fragment at that distance takes.
const FOG_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float d = length(materialInput.positionToEyeEC);
  float t = clamp((d - fogStartM) / max(fogEndM - fogStartM, 1.0), 0.0, 1.0);
  material.diffuse = fogColor.rgb;
  material.alpha = t * t * (3.0 - 2.0 * t) * fogColor.a;
  return material;
}
`;

function fogMaterial(translucent) {
  return new Cesium.Material({
    translucent,
    fabric: {
      type: translucent ? 'BlocksFogWater' : 'BlocksFog',
      uniforms: {
        fogStartM: 1e9,
        fogEndM: 2e9,
        fogColor: new Cesium.Color(...DEFAULT_FOG_COLOR),
      },
      source: FOG_SOURCE,
    },
  });
}

function blocksAppearance(translucent) {
  return new Cesium.Appearance({
    material: fogMaterial(translucent),
    translucent,
    closed: false,
    vertexShaderSource: VERTEX_SHADER,
    fragmentShaderSource: FRAGMENT_SHADER,
    renderState: Cesium.Appearance.getDefaultRenderState(translucent, false),
  });
}

/**
 * A mesh's faces split into opaque and water (alpha below 255) triangles,
 * each with only the vertices it uses.
 * @returns {{opaque: object|null, water: object|null}}
 */
export function splitMesh({ positions, normals, colors, indices }) {
  const parts = { opaque: [], water: [] };
  for (let t = 0; t < indices.length; t += 3)
    parts[colors[indices[t] * 4 + 3] < 255 ? 'water' : 'opaque'].push(t);
  const build = (triangles) => {
    if (!triangles.length) return null;
    const remap = new Map();
    const out = new Uint32Array(triangles.length * 3);
    let k = 0;
    for (const t of triangles)
      for (let c = 0; c < 3; c++) {
        const v = indices[t + c];
        if (!remap.has(v)) remap.set(v, remap.size);
        out[k++] = remap.get(v);
      }
    const n = remap.size;
    const p = new Float32Array(n * 3);
    const nn = new Float32Array(n * 3);
    const cc = new Uint8Array(n * 4);
    for (const [from, to] of remap) {
      p.set(positions.subarray(from * 3, from * 3 + 3), to * 3);
      nn.set(normals.subarray(from * 3, from * 3 + 3), to * 3);
      cc.set(colors.subarray(from * 4, from * 4 + 4), to * 4);
    }
    return { positions: p, normals: nn, colors: cc, indices: out };
  };
  if (!parts.water.length)
    return {
      opaque: indices.length ? { positions, normals, colors, indices } : null,
      water: null,
    };
  return { opaque: build(parts.opaque), water: build(parts.water) };
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

/** A chunk key 'ci:cj' to its numbers. */
export function parseChunkKey(key) {
  const [ci, cj] = String(key).split(':').map(Number);
  return { ci, cj };
}

/** @param {{viewer: object}} options */
export function createBlocksRenderer({ viewer } = {}) {
  const scene = viewer.scene;
  const collection = scene.primitives.add(
    new Cesium.PrimitiveCollection({ destroyPrimitives: true }),
  );
  const appearances = {
    opaque: blocksAppearance(false),
    water: blocksAppearance(true),
  };
  const pickTranslucentDepthBefore = scene.pickTranslucentDepth;
  scene.pickTranslucentDepth = true;
  const chunks = new Map(); // key → {origin, primitives: Primitive[]}
  let region = null;
  let datumOffsetM = 0;
  let frame = null;
  let sun = {
    dir: sunVector(STUDY_SUN.elevationDeg, STUDY_SUN.azimuthDeg),
    fixed: true,
  };
  let fog = { startM: 1e9, endM: 2e9, color: [...DEFAULT_FOG_COLOR] };
  let destroyed = false;

  const requestRender = () => scene.requestRender?.();

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
      const { ci, cj } = parseChunkKey(key);
      const origin = mesh.origin || region.chunkOrigin(ci, cj);
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

    /** Fog from startM to endM from the eye, toward `color` (CSS, Cesium.Color or [r, g, b, a]). */
    setFog({ startM, endM, color } = {}) {
      if (Number.isFinite(startM)) fog.startM = startM;
      if (Number.isFinite(endM)) fog.endM = endM;
      if (color !== undefined) {
        const c =
          typeof color === 'string'
            ? Cesium.Color.fromCssColorString(color)
            : Array.isArray(color)
              ? new Cesium.Color(...color)
              : color;
        fog.color = [c.red, c.green, c.blue, c.alpha ?? 1];
      }
      for (const appearance of Object.values(appearances)) {
        const uniforms = appearance.material.uniforms;
        uniforms.fogStartM = fog.startM;
        uniforms.fogEndM = fog.endM;
        uniforms.fogColor = new Cesium.Color(...fog.color);
      }
      requestRender();
      return { ...fog, color: [...fog.color] };
    },

    keys: () => [...chunks.keys()],

    getState: () => ({
      region,
      datumOffsetM,
      chunks: chunks.size,
      primitives: collection.length,
      sun,
      fog: { ...fog, color: [...fog.color] },
    }),

    /** The collection the primitives are in (for tests and the harness). */
    getCollection: () => collection,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      chunks.clear();
      scene.pickTranslucentDepth = pickTranslucentDepthBefore;
      scene.primitives.remove(collection);
      requestRender();
    },
  };
  return api;
}
