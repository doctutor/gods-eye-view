// Personal fork: a dependency-free hex tessellation on equal-area
// projections, for the Countries basemap's "hex" style. A pointy-top hex
// lattice is laid out in the projected plane (kilometres) and each vertex is
// inverse-projected to the sphere, so every cell covers the same ground
// area. Two projections:
//
// - cylindrical equal-area (Lambert), for the planet-wide coarse grid: one
//   lattice, stable across views, stretched towards the poles;
// - azimuthal equal-area (Lambert), centred under the view, for the finer
//   grids: near-regular hexes around the centre, rebuilt when the view moves.
//
// H3 would give one consistent hierarchy of cells over the whole globe (and
// parent/child relations between resolutions); this grid trades that for
// having no dependency and no 1.5 MB of index tables.

export const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Cylindrical equal-area: x = R·λ, y = R·sin φ (km). */
export function cylindricalEqualArea() {
  const R = EARTH_RADIUS_KM;
  return {
    kind: 'cylindrical',
    forward(lon, lat) {
      return [R * lon * DEG, R * Math.sin(lat * DEG)];
    },
    inverse(x, y) {
      return [
        clamp(x / R / DEG, -180, 180),
        Math.asin(clamp(y / R, -1, 1)) / DEG,
      ];
    },
  };
}

/** Lambert azimuthal equal-area centred at (lon0, lat0), km in the plane. */
export function azimuthalEqualArea(lon0, lat0) {
  const R = EARTH_RADIUS_KM;
  const l0 = lon0 * DEG;
  const p0 = lat0 * DEG;
  const sinP0 = Math.sin(p0);
  const cosP0 = Math.cos(p0);
  return {
    kind: 'azimuthal',
    centre: [lon0, lat0],
    forward(lon, lat) {
      const l = lon * DEG - l0;
      const p = lat * DEG;
      const denominator =
        1 + sinP0 * Math.sin(p) + cosP0 * Math.cos(p) * Math.cos(l);
      const k = R * Math.sqrt(2 / Math.max(denominator, 1e-12));
      return [
        k * Math.cos(p) * Math.sin(l),
        k * (cosP0 * Math.sin(p) - sinP0 * Math.cos(p) * Math.cos(l)),
      ];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      if (rho === 0) return [lon0, lat0];
      const c = 2 * Math.asin(clamp(rho / (2 * R), -1, 1));
      const sinC = Math.sin(c);
      const cosC = Math.cos(c);
      const lat = Math.asin(
        clamp(cosC * sinP0 + (y * sinC * cosP0) / rho, -1, 1),
      );
      const lon =
        l0 + Math.atan2(x * sinC, rho * cosP0 * cosC - y * sinP0 * sinC);
      let degrees = lon / DEG;
      degrees = ((((degrees + 180) % 360) + 360) % 360) - 180;
      return [degrees, lat / DEG];
    },
  };
}

/** Area of one cell for a centre-to-vertex size, km². */
export function hexAreaKm2(sizeKm) {
  return ((3 * Math.sqrt(3)) / 2) * sizeKm * sizeKm;
}

/**
 * The lattice cells covering a plane rectangle, each with its centre and
 * ring on the sphere.
 * @param {{ projection: object, bounds: {xmin: number, xmax: number, ymin: number, ymax: number}, sizeKm: number, maxCells?: number }} options
 * @returns {Array<{key: string, centre: [number, number], ring: Array<[number, number]>}>}
 */
export function hexCells({ projection, bounds, sizeKm, maxCells = Infinity }) {
  const s = sizeKm;
  const w = Math.sqrt(3) * s;
  const rowStep = 1.5 * s;
  const j0 = Math.floor(bounds.ymin / rowStep) - 1;
  const j1 = Math.ceil(bounds.ymax / rowStep) + 1;
  const i0 = Math.floor(bounds.xmin / w) - 1;
  const i1 = Math.ceil(bounds.xmax / w) + 1;
  const cells = [];
  const corners = [];
  for (let k = 0; k < 6; k++) {
    const angle = DEG * (30 + 60 * k);
    corners.push([s * Math.cos(angle), s * Math.sin(angle)]);
  }
  for (let j = j0; j <= j1; j++) {
    const y = j * rowStep;
    const offset = j % 2 === 0 ? 0 : w / 2;
    for (let i = i0; i <= i1; i++) {
      const x = i * w + offset;
      if (
        x < bounds.xmin ||
        x > bounds.xmax ||
        y < bounds.ymin ||
        y > bounds.ymax
      )
        continue;
      if (cells.length >= maxCells) return cells;
      cells.push({
        key: `${i},${j}`,
        centre: projection.inverse(x, y),
        ring: corners.map(([dx, dy]) => projection.inverse(x + dx, y + dy)),
      });
    }
  }
  return cells;
}

/** The planet-wide lattice bounds (cylindrical), to ±85° latitude. */
export function globalBounds() {
  const R = EARTH_RADIUS_KM;
  const y = R * Math.sin(85 * DEG);
  return { xmin: -Math.PI * R, xmax: Math.PI * R, ymin: -y, ymax: y };
}

/** Resolution tiers by camera height: the cell size and the grid's scope. */
export const HEX_TIERS = Object.freeze([
  Object.freeze({ minHeightM: 6_000_000, sizeKm: 150, scope: 'global' }),
  Object.freeze({ minHeightM: 1_500_000, sizeKm: 60, scope: 'local' }),
  Object.freeze({ minHeightM: 0, sizeKm: 25, scope: 'local' }),
]);

/** The tier for a camera height (metres). */
export function hexTierForHeight(heightM) {
  const height = Number.isFinite(heightM) ? heightM : Infinity;
  return (
    HEX_TIERS.find((tier) => height >= tier.minHeightM) || HEX_TIERS.at(-1)
  );
}

/**
 * The square of the plane a local grid covers for a view: six times the
 * camera height across, at least 300 km and at most 10,000 km (the Earth
 * Engine overlays use the same rule for their tile rectangle).
 */
export function localHalfSideKm(heightM) {
  return Math.min(5000, Math.max(150, (3 * heightM) / 1000));
}

/**
 * Whether a local grid made for one view still serves another: it is kept
 * until the view moves half way to the square's edge or the tier changes.
 */
export function localGridStale(made, now) {
  if (!made) return true;
  if (hexTierForHeight(made.heightM) !== hexTierForHeight(now.heightM))
    return true;
  const projection = azimuthalEqualArea(made.lon, made.lat);
  const [x, y] = projection.forward(now.lon, now.lat);
  return Math.max(Math.abs(x), Math.abs(y)) > made.halfSideKm / 2;
}

/**
 * The hex cells for a view: the planet-wide lattice far out, else a local
 * lattice around the view. Cells whose centre is not on land are dropped,
 * and each kept cell carries the feature under its centre.
 * @param {{ lon: number, lat: number, heightM: number }} view
 * @param {(lon: number, lat: number) => object | null} landAt
 * @param {{ maxCells?: number }} [options]
 */
export function hexCellsForView(view, landAt, { maxCells = 20_000 } = {}) {
  const tier = hexTierForHeight(view.heightM);
  let projection;
  let bounds;
  let halfSideKm = null;
  if (tier.scope === 'global') {
    projection = cylindricalEqualArea();
    bounds = globalBounds();
  } else {
    projection = azimuthalEqualArea(view.lon, view.lat);
    halfSideKm = localHalfSideKm(view.heightM);
    bounds = {
      xmin: -halfSideKm,
      xmax: halfSideKm,
      ymin: -halfSideKm,
      ymax: halfSideKm,
    };
  }
  // A lattice too dense for the budget is coarsened, never truncated.
  let sizeKm = tier.sizeKm;
  const area = (bounds.xmax - bounds.xmin) * (bounds.ymax - bounds.ymin);
  while (area / hexAreaKm2(sizeKm) > maxCells) sizeKm *= 1.5;
  const cells = [];
  for (const cell of hexCells({ projection, bounds, sizeKm })) {
    const feature = landAt(cell.centre[0], cell.centre[1]);
    if (feature) cells.push({ ...cell, feature });
  }
  return {
    tier,
    sizeKm,
    scope: tier.scope,
    made: { lon: view.lon, lat: view.lat, heightM: view.heightM, halfSideKm },
    cells,
  };
}
