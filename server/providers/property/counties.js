import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Census Bureau's counties (src/data/local_data/us_census_counties,
 * public domain) as bounding boxes, by GEOID and by state: what the
 * property build checks a record's coordinates against (a record outside
 * its county's box, or its state's when the county is not known, is
 * dropped), and the names the server puts on a card.
 *
 * Personal fork; not part of upstream God's Eye View.
 */

export const COUNTIES_FILE = fileURLToPath(
  new URL(
    '../../../src/data/local_data/us_census_counties/counties.json',
    import.meta.url,
  ),
);
/** Degrees a box is widened by (a parcel on the county line, rounding). */
export const BOX_MARGIN_DEGREES = 0.02;

/** A ring's bounding box: its first vertex absolute, then deltas, in 10^-d degrees. */
function ringBox(encoded, scale, box) {
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    lon += encoded[i];
    lat += encoded[i + 1];
    const x = lon / scale;
    const y = lat / scale;
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
}

/**
 * {byGeoid: Map geoid → {name, st, box}, byState: Map st → box}, boxes as
 * [west, south, east, north] widened by the margin.
 */
export function loadCounties(file = COUNTIES_FILE) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byGeoid = new Map();
  const byState = new Map();
  for (const feature of json.features) {
    const scale = 10 ** (feature.d ?? json.meta.decimals);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of feature.polygons) ringBox(polygon[0], scale, box);
    const wide = [
      box[0] - BOX_MARGIN_DEGREES,
      box[1] - BOX_MARGIN_DEGREES,
      box[2] + BOX_MARGIN_DEGREES,
      box[3] + BOX_MARGIN_DEGREES,
    ];
    byGeoid.set(feature.geoid, {
      name: feature.full || feature.name,
      st: feature.st,
      box: wide,
    });
    const state = byState.get(feature.st);
    if (!state) byState.set(feature.st, [...wide]);
    else {
      state[0] = Math.min(state[0], wide[0]);
      state[1] = Math.min(state[1], wide[1]);
      state[2] = Math.max(state[2], wide[2]);
      state[3] = Math.max(state[3], wide[3]);
    }
  }
  return { byGeoid, byState };
}

const inBox = (box, lat, lon) =>
  lat >= box[1] && lat <= box[3] && lon >= box[0] && lon <= box[2];

/**
 * Where a record's coordinates fall: 'county' in its county's box; else
 * 'state' in its state's (the county's, or the record's own when the
 * county is not known); 'us' in some state's when it names neither; null
 * outside, and the record is dropped.
 */
export function placeCheck(counties, { lat, lon, county, state }) {
  const known = county ? counties.byGeoid.get(county) : null;
  if (known && inBox(known.box, lat, lon)) return 'county';
  const st = known?.st || state;
  const stateBox = st ? counties.byState.get(st) : null;
  if (stateBox) return inBox(stateBox, lat, lon) ? 'state' : null;
  for (const box of counties.byState.values())
    if (inBox(box, lat, lon)) return 'us';
  return null;
}
