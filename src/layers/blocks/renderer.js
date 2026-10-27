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
import { parseChunkKey } from './grid.js';
import { STUDY_SUN, STUDY_SUN_DIR, sunDirection } from './lighting.js';

/** The real sun lights the blocks above this elevation, else the study sun. */
export const REAL_SUN_MIN_ELEVATION_DEG = 15;
/** The fog colour when the scene has no background colour: a clear sky near the horizon. */
export const DEFAULT_FOG_COLOR = Object.freeze([0.71, 0.8, 0.9, 1]);
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

const VERTEX_SHADER = `
const float DEPTH_BIAS = ${DEPTH_BIAS.toExponential()};
in vec3 position;
in vec3 normal;
in vec4 color;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;

void main() {
  vec4 p = vec4(position, 1.0);
  vec4 positionEC = czm_modelView * p;
  v_positionEC = positionEC.xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  gl_Position = czm_projection * vec4(positionEC.xyz * (1.0 - DEPTH_BIAS), 1.0);
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
  const chunks = new Map(); // key → {origin, primitives: Primitive[]}
  let region = null;
  let datumOffsetM = 0;
  let frame = null;
  let sun = {
    dir: { ...STUDY_SUN_DIR },
    fixed: true,
  };
  // The fog colour follows the scene's background unless setFog names one:
  // with the globe hidden that is what the fogged edge meets.
  let fog = { startM: 1e9, endM: 2e9, color: [...DEFAULT_FOG_COLOR] };
  let fogFollowsBackground = true;
  let destroyed = false;

  const requestRender = () => scene.requestRender?.();

  function applyFog() {
    for (const appearance of Object.values(appearances)) {
      const uniforms = appearance.material.uniforms;
      uniforms.fogStartM = fog.startM;
      uniforms.fogEndM = fog.endM;
      uniforms.fogColor = new Cesium.Color(...fog.color);
    }
  }

  /** Take the scene's background colour as the fog's; true if it changed. */
  function followBackground() {
    const background = scene.backgroundColor;
    if (!fogFollowsBackground || !background) return false;
    const next = [background.red, background.green, background.blue, 1];
    if (next.every((value, k) => value === fog.color[k])) return false;
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

    keys: () => [...chunks.keys()],

    getState: () => ({
      region,
      datumOffsetM,
      chunks: chunks.size,
      primitives: collection.length,
      sun,
      fog: {
        ...fog,
        color: [...fog.color],
        followsBackground: fogFollowsBackground,
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
