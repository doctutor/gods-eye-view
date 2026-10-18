/**
 * Degrees, minutes and seconds as the HUD writes a coordinate
 * (`38°53'23.10"N`), shared by the HUD's readout (src/hud.js) and the Grid
 * layer's labels (src/layers/grid/). Coordinates are notation, not prose:
 * the hemisphere letters stay N/S/E/W in every language, as on the HUD.
 */

/**
 * @param {number} decimal - Decimal degrees.
 * @param {'lat'|'lon'} axis - Picks the hemisphere letters and the padding
 *   (2 digits of degrees for latitude, 3 for longitude).
 * @param {{precision?: 'seconds'|'minutes'|'degrees', pad?: boolean}} [options]
 *   `seconds` (the HUD's: `38°53'23.10"N`), `minutes` (`38°53'N`) or
 *   `degrees` (`38°N`); `pad: false` drops the leading zeros.
 */
export function formatDms(
  decimal,
  axis,
  { precision = 'seconds', pad = true } = {},
) {
  const value = Number(decimal);
  const letter =
    axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  const width = pad ? (axis === 'lon' ? 3 : 2) : 1;
  const degrees = (deg) => String(deg).padStart(width, '0');
  if (precision === 'degrees') return `${degrees(Math.round(abs))}°${letter}`;
  if (precision === 'minutes') {
    // Rounded as whole minutes, so 38.99999° is 39°00', never 38°60'.
    const total = Math.round(abs * 60);
    const deg = Math.floor(total / 60);
    return `${degrees(deg)}°${String(total - deg * 60).padStart(2, '0')}'${letter}`;
  }
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60).toFixed(2);
  return `${degrees(deg)}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${letter}`;
}
