/**
 * Personal fork: where Google Open Buildings 2.5D Temporal v1 has images,
 * one box per S2 cell it covers (its images' s2cell_token) ([west, south, east, north], °),
 * the union of the 2023 images' footprints in that cell (listed with the
 * Earth Engine API, 2026-10-19: 46 cells, 151 images that year, 1,173 in
 * 2016–2023). The data is Africa, South and Southeast Asia, Latin America
 * and the Caribbean; the boxes are coarse (a cell's box takes in sea and
 * land without buildings data), so they only say where there is surely
 * none: the Buildings row says so there rather than drawing nothing.
 */
export const OPEN_BUILDINGS_BOXES = Object.freeze([
  Object.freeze([-45.02, -24.98, -27.83, -16.36]), // 01
  Object.freeze([-14.33, -38.2, -7.61, -32.9]), // 03
  Object.freeze([-15.81, -20.14, -4.89, -6.74]), // 05
  Object.freeze([-45.02, -18.18, -32.3, -0.41]), // 07
  Object.freeze([-29.54, 0.5, -22.55, 17.85]), // 09
  Object.freeze([-20.34, 21.59, 0.56, 36.71]), // 0d
  Object.freeze([-22.64, 3.69, 0.31, 22.77]), // 0f
  Object.freeze([-0.25, -0.03, 22.86, 22.77]), // 11
  Object.freeze([-0.49, 21.31, 22.64, 37.93]), // 13
  Object.freeze([22.57, 17.84, 39.35, 33.16]), // 15
  Object.freeze([22.5, -0.03, 45.08, 20.77]), // 17
  Object.freeze([22.5, -21.06, 45.08, 0.12]), // 19
  Object.freeze([5.05, -22.15, 22.86, 0.12]), // 1b
  Object.freeze([13.34, -35.59, 22.92, -20.94]), // 1d
  Object.freeze([22.39, -35.11, 45.11, -16.37]), // 1f
  Object.freeze([44.98, -26.5, 59.72, -16.36]), // 21
  Object.freeze([44.98, -20.48, 64.41, -3.49]), // 23
  Object.freeze([70.42, -8.12, 74.99, 0.09]), // 25
  Object.freeze([112.58, -11.62, 135.07, 0.12]), // 2d
  Object.freeze([96.43, -9.2, 112.76, 0.12]), // 2f
  Object.freeze([89.96, -0.03, 112.86, 22.77]), // 31
  Object.freeze([112.61, -0.03, 135.07, 20.05]), // 33
  Object.freeze([120.1, 19.06, 123.91, 21.8]), // 35
  Object.freeze([89.81, 21.58, 108.17, 30.17]), // 37
  Object.freeze([67.12, 21.17, 90.28, 37.32]), // 39
  Object.freeze([68.89, -0.03, 90.13, 22.77]), // 3b
  Object.freeze([44.98, 1.28, 52.15, 12.63]), // 3d
  Object.freeze([61.21, 23.05, 67.61, 31.21]), // 3f
  Object.freeze([134.98, -0.03, 135.32, 0.09]), // 67
  Object.freeze([134.98, -9.48, 141.47, 0.11]), // 69
  Object.freeze([-118.78, 23.81, -112.37, 33.53]), // 81
  Object.freeze([-115.69, 17.44, -112.49, 20.09]), // 83
  Object.freeze([-112.64, -0.03, -89.69, 22.74]), // 85
  Object.freeze([-112.76, 21.5, -96.23, 32.69]), // 87
  Object.freeze([-90.03, 21.39, -70.37, 27.57]), // 89
  Object.freeze([-67.48, -0.03, -46.17, 19.35]), // 8d
  Object.freeze([-90.25, -0.03, -67.14, 22.77]), // 8f
  Object.freeze([-90, -21.65, -67.14, 0.12]), // 91
  Object.freeze([-67.5, -21.06, -44.92, 0.12]), // 93
  Object.freeze([-67.75, -42.73, -44.88, -16.36]), // 95
  Object.freeze([-81.53, -44.12, -66.84, -20.94]), // 97
  Object.freeze([-110.35, -27.91, -104.17, -25.46]), // 99
  Object.freeze([-92.47, -2.48, -89.94, 0.06]), // 9b
  Object.freeze([36.44, -47.46, 39.65, -46.21]), // b5
  Object.freeze([-77.77, -56.75, -57.26, -42.56]), // bd
  Object.freeze([-67.43, -52.3, -56.28, -41.7]), // bf
]);

/** Whether a point (°) lies in any Open Buildings box. */
export function inOpenBuildings(lat, lon, boxes = OPEN_BUILDINGS_BOXES) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  return boxes.some(
    ([west, south, east, north]) =>
      lat >= south && lat <= north && lon >= west && lon <= east,
  );
}
