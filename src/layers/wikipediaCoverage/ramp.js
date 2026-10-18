/**
 * Personal fork: the Wikipedia coverage layer's colour ramp. Values are
 * drawn on a logarithmic scale between a variant's domain floor and
 * ceiling (the server's 5th and 99.5th percentiles of non-empty cells):
 * zero is transparent, the floor is a dark, half-transparent plum, the
 * ceiling a pale yellow, inferno-like in between. Pure: no DOM, no Cesium.
 */

/** Inferno-like stops, RGB, from dark to light. */
export const RAMP_STOPS = Object.freeze([
  Object.freeze([20, 11, 52]),
  Object.freeze([66, 10, 104]),
  Object.freeze([120, 28, 109]),
  Object.freeze([170, 51, 87]),
  Object.freeze([215, 83, 54]),
  Object.freeze([243, 134, 22]),
  Object.freeze([252, 196, 42]),
  Object.freeze([252, 255, 164]),
]);
/** The faintest cell's alpha; the ramp is opaque from this far up. */
export const MIN_ALPHA = 0.45;
export const OPAQUE_FROM = 0.35;

/** Where a value sits on the ramp, 0 to 1; NaN for zero or less. */
export function rampPosition(value, { min, max }) {
  if (!(value > 0) || !(min > 0) || !(max > min)) return NaN;
  const t = (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return Math.min(1, Math.max(0, t));
}

/** The ramp's colour at a position, as [r, g, b, a] in 0–255. */
export function rampColor(t) {
  if (!Number.isFinite(t)) return [0, 0, 0, 0];
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (RAMP_STOPS.length - 1);
  const index = Math.min(RAMP_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const a = RAMP_STOPS[index];
  const b = RAMP_STOPS[index + 1];
  const alpha =
    clamped >= OPAQUE_FROM
      ? 1
      : MIN_ALPHA + (1 - MIN_ALPHA) * (clamped / OPAQUE_FROM);
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
    Math.round(alpha * 255),
  ];
}

/** `#rrggbb` for a ramp position (legend swatches). */
export function rampHex(t) {
  const [r, g, b] = rampColor(t);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Paint tile values into RGBA bytes (an ImageData's data), one pixel per
 * value, transparent where there is nothing.
 * @param {Float32Array} values
 * @param {{min: number, max: number}} domain
 * @param {Uint8ClampedArray|Uint8Array} out length 4 × values.length
 * @returns {number} how many pixels were painted (not transparent)
 */
export function paintTile(values, domain, out) {
  if (out.length < values.length * 4) throw new RangeError('out is too small');
  // 256 colours, looked up by quantised position: fast, and smooth enough.
  const steps = 256;
  const lut = new Array(steps);
  for (let i = 0; i < steps; i++) lut[i] = rampColor(i / (steps - 1));
  let painted = 0;
  for (let i = 0; i < values.length; i++) {
    const t = rampPosition(values[i], domain);
    const at = i * 4;
    if (!Number.isFinite(t)) {
      out[at] = out[at + 1] = out[at + 2] = out[at + 3] = 0;
      continue;
    }
    const [r, g, b, a] = lut[Math.round(t * (steps - 1))];
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
    out[at + 3] = a;
    painted += 1;
  }
  return painted;
}

/** A value for the legend: 2 significant figures, no noise. */
export function formatValue(value, { bytes = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  if (bytes) {
    // Round before choosing the unit, so 999.99 reads 1 kB, not 1000 B.
    const rounded = value === 0 ? 0 : Number(value.toPrecision(3));
    if (rounded >= 1e9) return `${trim(rounded / 1e9)} GB`;
    if (rounded >= 1e6) return `${trim(rounded / 1e6)} MB`;
    if (rounded >= 1e3) return `${trim(rounded / 1e3)} kB`;
    return `${trim(rounded)} B`;
  }
  return trim(value);
}

function trim(value) {
  if (value === 0) return '0';
  if (value >= 100) return String(Math.round(value));
  return String(Number(value.toPrecision(2)));
}

/**
 * Legend stops for a domain: five swatches from the floor to the ceiling
 * at equal steps on the log scale, the last marked as "and above".
 * @param {{min: number, max: number}} domain
 * @param {{bytes?: boolean}} [options]
 * @returns {Array<{label: string, color: string}>}
 */
export function legendStops(domain, { bytes = false } = {}) {
  if (!(domain?.min > 0) || !(domain?.max > domain.min)) return [];
  const stops = [];
  const count = 5;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const value = Math.exp(
      Math.log(domain.min) + t * (Math.log(domain.max) - Math.log(domain.min)),
    );
    stops.push({
      label: `${formatValue(value, { bytes })}${i === count - 1 ? '+' : ''}`,
      color: rampHex(t),
    });
  }
  return stops;
}
