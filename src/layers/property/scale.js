// Personal fork: the Property sales layer's colour scales
// (src/maps/colourScale.js), one per metric: the shared inferno-like ramp
// on the metric's own mapping (log for prices and counts, linear for
// years) as the default, so an untouched layer paints as before.

import {
  createScalePainter,
  defineScaleDefaults,
  isDefaultScale,
  scaleKey,
} from '../../maps/colourScale.js';
import { RAMP_STOPS, rampColor } from '../wikipediaCoverage/ramp.js';
import { propertyMetric } from '../../data/propertySales.js';
import { metricColor } from './property.js';
import { shortValue } from './presentation.js';

export const PROPERTY_SCALE_LAYER = 'property';

const cache = new Map();
/** A metric's scale defaults (made once). */
export function propertyScaleDefaults(metric) {
  if (!cache.has(metric)) {
    const record = propertyMetric(metric);
    cache.set(
      metric,
      defineScaleDefaults({
        scale: record?.scale === 'linear' ? 'linear' : 'log',
        units: record?.units === 'USD' ? '' : record?.units || '',
        colourAt: rampColor,
        stops: RAMP_STOPS,
        format: (value) => shortValue(metric, value),
      }),
    );
  }
  return cache.get(metric);
}

export const propertyScaleKey = (metric) =>
  scaleKey(PROPERTY_SCALE_LAYER, metric);

/**
 * How a metric's values are coloured now: {isDefault, colourOf(value) →
 * [r, g, b, a]} (alpha 0 for none). The default is property.js's own.
 */
export function propertyColouring(store, metric, domain) {
  const defaults = propertyScaleDefaults(metric);
  const model = store.get(propertyScaleKey(metric), defaults);
  if (isDefaultScale(model, defaults))
    return {
      model,
      isDefault: true,
      colourOf: (value) => metricColor(metric, value, domain),
    };
  const painter = createScalePainter(model, defaults, domain);
  return { model, isDefault: false, colourOf: painter.colourOf };
}
