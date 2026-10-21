// Personal fork: the Census tracts layer's colour scales for the modes the
// local server draws (income, surface temperature): the token their tile
// URL carries, and the row's Scale controls. The scale itself is
// src/data/censusScale.js; the store src/maps/colourScaleStore.js.

import { colourScales } from '../../maps/colourScaleStore.js';
import {
  censusScaleBounds,
  censusScaleDefaults,
  censusScaleKey,
  censusScaleToken,
} from '../../data/censusScale.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';

/**
 * A mode's tile scale token: '' for the default (or another mode), else
 * its scale's hash fields; for censusImageryOptions(status, mode,
 * { scaleToken }).
 */
export function censusTileScaleToken(mode, scales = colourScales()) {
  const defaults = censusScaleDefaults(mode);
  if (!defaults) return '';
  return censusScaleToken(scales.get(censusScaleKey(mode), defaults), mode);
}

/**
 * The row's Scale controls for a locally drawn mode, or null for another
 * mode: the window over the classes' range, the slider over the tracts'
 * values. The Census tracts row returns it as `scale`, and its legend from
 * scaleRowLegend when the scale is not the default.
 */
export function censusScaleControl(mode, scales = colourScales()) {
  const defaults = censusScaleDefaults(mode);
  if (!defaults) return null;
  return scaleRowControl({
    store: scales,
    key: censusScaleKey(mode),
    defaults,
    auto: defaults.range,
    range: censusScaleBounds(mode),
  });
}
