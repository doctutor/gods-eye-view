import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineLayer } from '../../layers/earthEngine/index.js';
import { createEarthEngineSource } from '../../layers/earthEngine/source.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';

/**
 * Personal-fork Earth Engine overlays (ANALYSIS in the DATA LAYERS panel):
 * one layer per record of src/data/earthEngineLayers.js, sharing one catalog
 * source.
 */
export function createApplicationEarthEngineLayers({
  source = createEarthEngineSource(),
} = {}) {
  return EARTH_ENGINE_LAYERS.map((record) =>
    createEarthEngineLayer({
      record,
      source,
      requestRender: governorRequestRender,
      credits: { register: registerDynamicCredit },
    }),
  );
}

/** The layer ids, for the panel and the catalog's local-only list. */
export const EARTH_ENGINE_LAYER_IDS = Object.freeze(
  EARTH_ENGINE_LAYERS.map((record) => record.id),
);
