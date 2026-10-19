import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineLayer } from '../../layers/earthEngine/index.js';
import { createRiverNames } from '../../layers/earthEngine/riverNames.js';
import { createEarthEngineSource } from '../../layers/earthEngine/source.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Earth Engine overlays (ANALYSIS in the DATA LAYERS panel):
 * one layer per record of src/data/earthEngineLayers.js, sharing one catalog
 * source. The Rivers record's names go through the world-overlay host.
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
      names:
        record.names === 'natural-earth-rivers'
          ? createRiverNames({ overlayHost })
          : null,
    }),
  );
}

/** The layer ids, for the panel and the catalog's local-only list. */
export const EARTH_ENGINE_LAYER_IDS = Object.freeze(
  EARTH_ENGINE_LAYERS.map((record) => record.id),
);
