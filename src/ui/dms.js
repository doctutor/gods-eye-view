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
 * @param {{precision?: 'seconds'|'minutes'|'degrees', pad?: boolean,
 *   secondDecimals?: number}} [options]
 *   `seconds` (the HUD's: `38°53'23.10"N`), `minutes` (`38°53'N`) or
 *   `degrees` (`38°N`); `pad: false` drops the leading zeros;
 *   `secondDecimals`, the seconds' decimals (2 by default; the HUD's camera
 *   readout follows the view's precision).
 */
export function formatDms(
  decimal,
  axis,
  { precision = 'seconds', pad = true, secondDecimals = 2 } = {},
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
  // Rounded as whole units of the last decimal, so a second never reads 60.
  const places = Math.max(0, Math.min(6, Math.round(secondDecimals)));
  const unit = 10 ** places;
  const total = Math.round(abs * 3600 * unit);
  const deg = Math.floor(total / (3600 * unit));
  const min = Math.floor((total - deg * 3600 * unit) / (60 * unit));
  const sec = (total - deg * 3600 * unit - min * 60 * unit) / unit;
  const secWidth = places ? 3 + places : 2;
  return `${degrees(deg)}°${String(min).padStart(2, '0')}'${sec.toFixed(places).padStart(secWidth, '0')}"${letter}`;
}
