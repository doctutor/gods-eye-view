// Personal fork: the Lego mode's bricks as one mesh and one draw call.
// `buildBrickMesh` (pure) turns columns into an interleaved vertex buffer
// in a local frame at the window's centre: every column a box on its
// cell's lat/lon corners (so neighbours abut exactly and the Earth's
// curvature is kept), its top face and only the parts of its sides a taller
// neighbour does not hide. `LegoBrickPrimitive` uploads it once and draws
// it with a shader that makes the box a stack of bricks: a seam at every
// brick height, four studs on the top face, bevelled edges, matte plastic.
// Each vertex also carries its longitude and latitude (from the window's
// centre; a side's, its column's centre), so the tops can be textured with
// satellite imagery in Web Mercator (setTopTexture, topTexture.js), the
// sides either kept in colour or tinted from their top.

import * as Cesium from 'cesium';
import { brickHeightM } from './model.js';
import { SIDE_TINT } from './topTexture.js';

/** Bytes per vertex: position (3 float), normal (3 byte + pad), colour (4 ubyte), face (4 ubyte), brick height (float). */
export const VERTEX_STRIDE = 28;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const RAD = Math.PI / 180;

/** Geodetic → ECEF (m), WGS84, into `out` [x, y, z]. */
export function ecef(lonDeg, latDeg, height, out = [0, 0, 0]) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  out[0] = (n + height) * cosLat * Math.cos(lon);
  out[1] = (n + height) * cosLat * Math.sin(lon);
  out[2] = (n * (1 - E2) + height) * sinLat;
  return out;
}

/** The east, north and up unit vectors at a lon/lat (ECEF). */
export function enuAxes(lonDeg, latDeg) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const [sLat, cLat, sLon, cLon] = [
    Math.sin(lat),
    Math.cos(lat),
    Math.sin(lon),
    Math.cos(lon),
  ];
  return {
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
    up: [cLat * cLon, cLat * sLon, sLat],
  };
}

/**
 * The mesh for a window's columns.
 * @param {Array<object>} columns gridColumns(): west/south/east/north,
 *   bricks, baseM, color.hex, col, row.
 * @param {{cols: number, rows: number, cellSizeM: number,
 *   centerLon: number, centerLat: number}} frame
 * @returns {{vertices: ArrayBuffer, indices: Uint32Array, vertexCount: number,
 *   radius: number, center: number[], axes: object, boxes: Float64Array}}
 *   `boxes`: per column [baseM, topM] (picking); `lonLat`: per vertex
 *   its longitude and latitude less the centre's (degrees; a side's, its
 *   column's centre), for the textured tops.
 */
export function buildBrickMesh(columns, frame) {
  const brick = brickHeightM(frame.cellSizeM);
  const { cols, rows } = frame;
  // Which column stands on each cell (to hide sides behind neighbours).
  const at = new Int32Array(cols * rows).fill(-1);
  columns.forEach((column, i) => {
    at[column.row * cols + column.col] = i;
  });
  const tops = columns.map((c) => c.baseM + c.bricks * brick);
  // Counting first: top + the exposed sides.
  const neighbour = (column, dc, dr) => {
    const c = column.col + dc;
    const r = column.row + dr;
    if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
    return at[r * cols + c];
  };
  const SIDES = [
    [0, 1], // south (row + 1)
    [1, 0], // east
    [0, -1], // north
    [-1, 0], // west
  ];
  const exposedFrom = (i, side) => {
    const column = columns[i];
    const j = neighbour(column, side[0], side[1]);
    if (j < 0) return column.baseM;
    const other = columns[j];
    // The neighbour hides this side from its own base to its top.
    if (other.baseM > column.baseM + 1e-6) return column.baseM;
    return Math.max(column.baseM, tops[j]);
  };
  let faces = 0;
  const sideFrom = new Float64Array(columns.length * 4);
  columns.forEach((column, i) => {
    faces++;
    SIDES.forEach((side, s) => {
      const from = exposedFrom(i, side);
      sideFrom[i * 4 + s] = from;
      if (from < tops[i] - 1e-6) faces++;
    });
  });

  const centerLon = frame.centerLon;
  const centerLat = frame.centerLat;
  const center = ecef(centerLon, centerLat, 0);
  const axes = enuAxes(centerLon, centerLat);
  const vertices = new ArrayBuffer(faces * 4 * VERTEX_STRIDE);
  const f32 = new Float32Array(vertices);
  const i8 = new Int8Array(vertices);
  const u8 = new Uint8Array(vertices);
  const indices = new Uint32Array(faces * 6);
  const lonLat = new Float32Array(faces * 4 * 2);
  let v = 0;
  let k = 0;
  let radius = 0;
  const p = [0, 0, 0];
  // ECEF → the local east-north-up frame at the centre.
  const toLocal = (x, y, z, out) => {
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    out[0] = dx * axes.east[0] + dy * axes.east[1] + dz * axes.east[2];
    out[1] = dx * axes.north[0] + dy * axes.north[1] + dz * axes.north[2];
    out[2] = dx * axes.up[0] + dy * axes.up[1] + dz * axes.up[2];
    return out;
  };
  const dirLocal = (d, out) => {
    out[0] = d[0] * axes.east[0] + d[1] * axes.east[1] + d[2] * axes.east[2];
    out[1] = d[0] * axes.north[0] + d[1] * axes.north[1] + d[2] * axes.north[2];
    out[2] = d[0] * axes.up[0] + d[1] * axes.up[1] + d[2] * axes.up[2];
    return out;
  };
  const q = [0, 0, 0];
  const n = [0, 0, 0];
  function vertex(lon, lat, height, normal, rgb, u, w, face, bricks, at) {
    lonLat[v * 2] = (at ? at[0] : lon) - centerLon;
    lonLat[v * 2 + 1] = (at ? at[1] : lat) - centerLat;
    ecef(lon, lat, height, p);
    toLocal(p[0], p[1], p[2], q);
    const o = v * (VERTEX_STRIDE / 4);
    f32[o] = q[0];
    f32[o + 1] = q[1];
    f32[o + 2] = q[2];
    const b = v * VERTEX_STRIDE;
    i8[b + 12] = Math.round(normal[0] * 127);
    i8[b + 13] = Math.round(normal[1] * 127);
    i8[b + 14] = Math.round(normal[2] * 127);
    u8[b + 16] = rgb[0];
    u8[b + 17] = rgb[1];
    u8[b + 18] = rgb[2];
    u8[b + 19] = 255;
    u8[b + 20] = u;
    u8[b + 21] = w;
    u8[b + 22] = face;
    f32[o + 6] = bricks;
    const r = Math.hypot(q[0], q[1], q[2]);
    if (r > radius) radius = r;
    return v++;
  }
  // Two triangles a quad, wound counter-clockwise seen from outside.
  const quad = (a, b, c, d) => {
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = c;
    indices[k++] = a;
    indices[k++] = c;
    indices[k++] = d;
  };
  const boxes = new Float64Array(columns.length * 2);
  columns.forEach((column, i) => {
    const rgb = column.color.rgb || hexRgb(column.color.hex);
    const { west, south, east, north, baseM } = column;
    const top = tops[i];
    boxes[i * 2] = baseM;
    boxes[i * 2 + 1] = top;
    const midLon = (west + east) / 2;
    const midLat = (south + north) / 2;
    const at2 = enuAxes(midLon, midLat);
    dirLocal(at2.up, n);
    const up = [n[0], n[1], n[2]];
    // Top face: u east, w north.
    quad(
      vertex(west, south, top, up, rgb, 0, 0, 255, column.bricks),
      vertex(east, south, top, up, rgb, 255, 0, 255, column.bricks),
      vertex(east, north, top, up, rgb, 255, 255, 255, column.bricks),
      vertex(west, north, top, up, rgb, 0, 255, 255, column.bricks),
    );
    const sideCorners = [
      // south: west → east, facing south
      [[west, south], [east, south], at2.north, -1],
      // east: south → north, facing east
      [[east, south], [east, north], at2.east, 1],
      // north: east → west, facing north
      [[east, north], [west, north], at2.north, 1],
      // west: north → south, facing west
      [[west, north], [west, south], at2.east, -1],
    ];
    sideCorners.forEach(([a, b, axis, sign], s) => {
      const from = sideFrom[i * 4 + s];
      if (!(from < top - 1e-6)) return;
      dirLocal(axis, n);
      const normal = [n[0] * sign, n[1] * sign, n[2] * sign];
      const h0 = (from - baseM) / brick;
      const mid = [midLon, midLat];
      quad(
        vertex(a[0], a[1], from, normal, rgb, 0, 0, 0, h0, mid),
        vertex(b[0], b[1], from, normal, rgb, 255, 0, 0, h0, mid),
        vertex(b[0], b[1], top, normal, rgb, 255, 0, 0, column.bricks, mid),
        vertex(a[0], a[1], top, normal, rgb, 0, 0, 0, column.bricks, mid),
      );
    });
  });
  return {
    vertices,
    indices,
    vertexCount: v,
    faces,
    radius,
    center,
    axes,
    boxes,
    lonLat,
    centerLon,
    centerLat,
  };
}

function hexRgb(hex) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const VS = `
in vec3 position;
in vec3 normal;
in vec4 color;
in vec4 face;
in float brick;
in vec2 lonLat;
uniform float u_texMode;
uniform vec4 u_merc;
uniform vec3 u_origin;
out vec3 v_normalEC;
out vec3 v_positionEC;
out vec4 v_color;
out vec4 v_face;
out float v_brick;
out vec2 v_uv;
void main() {
  vec4 p = vec4(position, 1.0);
  v_uv = vec2(0.0);
  if (u_texMode > 0.5) {
    // Web Mercator, as the tiles are: x east from 180 W, y down from the north.
    float lon = u_origin.x + lonLat.x;
    if (lon < u_origin.z) lon += 360.0;
    float lat = clamp(u_origin.y + lonLat.y, -85.0511, 85.0511);
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(czm_piOverFour + radians(lat) * 0.5)) / czm_twoPi;
    v_uv = vec2((x - u_merc.x) / u_merc.z, (y - u_merc.y) / u_merc.w);
  }
  v_positionEC = (czm_modelView * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  v_face = face;
  v_brick = brick;
  gl_Position = czm_modelViewProjection * p;
  czm_vertexLogDepth();
}
`;

const FS = `
in vec3 v_normalEC;
in vec3 v_positionEC;
in vec4 v_color;
in vec4 v_face;
in float v_brick;
in vec2 v_uv;
uniform float u_studRadius;
uniform float u_texMode;
uniform float u_tint;
uniform sampler2D u_topTexture;
void main() {
  vec3 n = normalize(v_normalEC);
  vec3 L = normalize(czm_lightDirectionEC);
  vec3 V = normalize(-v_positionEC);
  vec3 base = v_color.rgb;
  // Textured: the top its cell's patch of imagery; the sides tinted from
  // their column's centre (mode 2), or left in colour (mode 1).
  if (u_texMode > 0.5 && (v_face.z > 0.5 || u_texMode > 1.5)) {
    vec3 photo = texture(u_topTexture, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
    base = v_face.z > 0.5 ? photo : photo * u_tint;
  }
  float diffuse = max(dot(n, L), 0.0);
  // Matte ABS: a soft key light, a sky fill and a faint, broad highlight.
  float fill = 0.5 + 0.5 * n.z;
  vec3 col = base * (0.36 + 0.62 * diffuse + 0.14 * fill);
  col += vec3(0.08) * pow(max(dot(n, normalize(L + V)), 0.0), 18.0);
  if (v_face.z > 0.5) {
    // The top: a 2 × 2 grid of studs, each lit on its sunward rim and
    // casting a little shadow on the far side.
    vec2 uv = v_face.xy;
    vec2 cell = fract(uv * 2.0) - 0.5;
    float r = length(cell);
    float aa = max(fwidth(r), 1e-3);
    float stud = 1.0 - smoothstep(u_studRadius - aa, u_studRadius + aa, r);
    vec2 sun = normalize(vec2(-0.55, 0.85));
    vec2 dir = cell / max(r, 1e-4);
    float lit = dot(dir, sun);
    float rim = smoothstep(u_studRadius - 0.07, u_studRadius - aa, r) * stud;
    col = mix(col, col * 1.12, stud);
    col *= 1.0 + 0.22 * rim * lit;
    float shadow = (1.0 - smoothstep(u_studRadius, u_studRadius + 0.14, r)) * (1.0 - stud);
    col *= 1.0 - 0.32 * shadow * max(-lit, 0.0);
    // Bevelled rim of the top face.
    float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    col *= mix(0.72, 1.0, smoothstep(0.0, 0.035, edge));
  } else {
    // The sides: a seam at every brick, bevelled vertical edges.
    float f = fract(v_brick);
    float aa = max(fwidth(v_brick), 1e-3);
    float seam = 1.0 - smoothstep(0.0, aa * 1.5 + 0.015, min(f, 1.0 - f));
    col *= 1.0 - 0.5 * seam;
    float edge = min(v_face.x, 1.0 - v_face.x);
    col *= mix(0.74, 1.0, smoothstep(0.0, 0.03, edge));
  }
  out_FragColor = vec4(col, 1.0);
  czm_writeLogDepth();
}
`;

const ATTRIBUTES = Object.freeze({
  position: 0,
  normal: 1,
  color: 2,
  face: 3,
  brick: 4,
  lonLat: 5,
});

/**
 * One window's bricks as a Cesium primitive (one draw call). Add it to
 * scene.primitives; destroy it to free its buffers.
 */
export class LegoBrickPrimitive {
  constructor({ mesh, cesium = Cesium }) {
    this.show = true;
    this._cesium = cesium;
    this._mesh = mesh;
    this._command = null;
    this._logDepth = null;
    this._destroyed = false;
    const C = cesium;
    const center = new C.Cartesian3(...mesh.center);
    this._modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
    this._boundingSphere = new C.BoundingSphere(center, mesh.radius + 1);
    this.vertexCount = mesh.vertexCount;
    this.faceCount = mesh.faces;
    // The textured tops (setTopTexture): the canvas waiting to upload, the
    // texture, and how it is mapped.
    this._topSource = null;
    this._topTexture = null;
    this._topMode = 0;
    this._topMerc = [0, 0, 1, 1];
    this._topWest = -180;
    this.topTextureBytes = 0;
  }

  /**
   * Texture the tops with a stitched canvas (topTexture.js: `plan` its
   * mercator extent), the sides 'tint' (darkened from the top) or
   * 'colour'; null takes it off. Uploaded on the next update.
   */
  setTopTexture(canvas, plan = null, { sides = 'tint', west = -180 } = {}) {
    this._topSource = canvas || null;
    this._topPending = true;
    this._topMode = canvas ? (sides === 'colour' ? 1 : 2) : 0;
    if (plan)
      this._topMerc = [plan.merc.x0, plan.merc.y0, plan.merc.w, plan.merc.h];
    this._topWest = west;
  }

  /** Whether the tops are textured now. */
  get textured() {
    return Boolean(this._topTexture) && this._topMode > 0;
  }

  _uploadTop(frameState) {
    if (!this._topPending) return;
    this._topPending = false;
    const C = this._cesium;
    this._topTexture?.destroy?.();
    this._topTexture = null;
    this.topTextureBytes = 0;
    const source = this._topSource;
    this._topSource = null;
    if (!source) return;
    const context = frameState.context;
    const mipmaps = Boolean(context.webgl2);
    this._topTexture = new C.Texture({
      context,
      source,
      sampler: new C.Sampler({
        wrapS: C.TextureWrap.CLAMP_TO_EDGE,
        wrapT: C.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: mipmaps
          ? C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR
          : C.TextureMinificationFilter.LINEAR,
        magnificationFilter: C.TextureMagnificationFilter.LINEAR,
      }),
    });
    if (mipmaps) this._topTexture.generateMipmap();
    const w = source.width;
    const h = source.height;
    this.topTextureBytes = Math.round(w * h * 4 * (mipmaps ? 4 / 3 : 1));
  }

  _create(frameState) {
    const C = this._cesium;
    const context = frameState.context;
    const mesh = this._mesh;
    const vertexBuffer = C.Buffer.createVertexBuffer({
      context,
      typedArray: new Uint8Array(mesh.vertices),
      usage: C.BufferUsage.STATIC_DRAW,
    });
    const lonLatBuffer = C.Buffer.createVertexBuffer({
      context,
      typedArray:
        mesh.lonLat || new Float32Array(Math.max(1, mesh.vertexCount) * 2),
      usage: C.BufferUsage.STATIC_DRAW,
    });
    const indexBuffer = C.Buffer.createIndexBuffer({
      context,
      typedArray: mesh.indices,
      usage: C.BufferUsage.STATIC_DRAW,
      indexDatatype: C.IndexDatatype.UNSIGNED_INT,
    });
    const attribute = (index, components, datatype, normalize, offset) => ({
      index,
      vertexBuffer,
      componentsPerAttribute: components,
      componentDatatype: datatype,
      normalize,
      offsetInBytes: offset,
      strideInBytes: VERTEX_STRIDE,
    });
    const vertexArray = new C.VertexArray({
      context,
      attributes: [
        attribute(ATTRIBUTES.position, 3, C.ComponentDatatype.FLOAT, false, 0),
        attribute(ATTRIBUTES.normal, 3, C.ComponentDatatype.BYTE, true, 12),
        attribute(
          ATTRIBUTES.color,
          4,
          C.ComponentDatatype.UNSIGNED_BYTE,
          true,
          16,
        ),
        attribute(
          ATTRIBUTES.face,
          4,
          C.ComponentDatatype.UNSIGNED_BYTE,
          true,
          20,
        ),
        attribute(ATTRIBUTES.brick, 1, C.ComponentDatatype.FLOAT, false, 24),
        {
          index: ATTRIBUTES.lonLat,
          vertexBuffer: lonLatBuffer,
          componentsPerAttribute: 2,
          componentDatatype: C.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 8,
        },
      ],
      indexBuffer,
    });
    // The arrays live on the GPU now.
    this._mesh = { ...mesh, vertices: null, indices: null, lonLat: null };
    this._vertexArray = vertexArray;
    this._renderState = C.RenderState.fromCache({
      depthTest: { enabled: true },
      depthMask: true,
      cull: { enabled: true, face: C.CullFace.BACK },
    });
    this._buildShader(frameState);
    this._command = new C.DrawCommand({
      vertexArray,
      shaderProgram: this._shaderProgram,
      renderState: this._renderState,
      modelMatrix: this._modelMatrix,
      boundingVolume: this._boundingSphere,
      pass: C.Pass.OPAQUE,
      primitiveType: C.PrimitiveType.TRIANGLES,
      uniformMap: {
        u_studRadius: () => 0.3,
        u_texMode: () => (this._topTexture ? this._topMode : 0),
        u_tint: () => SIDE_TINT,
        u_merc: () => new C.Cartesian4(...this._topMerc),
        u_origin: () =>
          new C.Cartesian3(
            mesh.centerLon || 0,
            mesh.centerLat || 0,
            this._topWest,
          ),
        u_topTexture: () =>
          this._topTexture || frameState.context.defaultTexture,
      },
      owner: this,
    });
  }

  _buildShader(frameState) {
    const C = this._cesium;
    const logDepth = Boolean(frameState.useLogDepth);
    if (this._shaderProgram && this._logDepth === logDepth) return;
    this._shaderProgram?.destroy?.();
    const defines = logDepth ? ['LOG_DEPTH'] : [];
    this._shaderProgram = C.ShaderProgram.fromCache({
      context: frameState.context,
      vertexShaderSource: new C.ShaderSource({ sources: [VS], defines }),
      fragmentShaderSource: new C.ShaderSource({ sources: [FS], defines }),
      attributeLocations: ATTRIBUTES,
    });
    this._logDepth = logDepth;
    if (this._command) this._command.shaderProgram = this._shaderProgram;
  }

  update(frameState) {
    if (!this.show || this._destroyed) return;
    if (!this._command) this._create(frameState);
    else this._buildShader(frameState);
    this._uploadTop(frameState);
    frameState.commandList.push(this._command);
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    if (this._destroyed) return undefined;
    this._destroyed = true;
    this._vertexArray?.destroy?.();
    this._shaderProgram?.destroy?.();
    this._topTexture?.destroy?.();
    this._topTexture = null;
    this.topTextureBytes = 0;
    this._command = null;
    return undefined;
  }
}
