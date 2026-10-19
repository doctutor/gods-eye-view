import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineLayer } from '../../layers/earthEngine/index.js';
import { createRiverClicks } from '../../layers/earthEngine/riverClicks.js';
import { createRiverNames } from '../../layers/earthEngine/riverNames.js';
import { createEarthEngineSource } from '../../layers/earthEngine/source.js';
import { createRiversV2Source } from '../../layers/riversV2/source.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  HYDROSHEDS_V2_CREDIT,
  RIVER_REACH_CREDIT,
  demSourceCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Earth Engine overlays (ANALYSIS in the DATA LAYERS panel):
 * one layer per record of src/data/earthEngineLayers.js, sharing one catalog
 * source. The Rivers record also gets its names (world-overlay labels), its
 * clicks (a reach traced to the sea) and HydroSHEDS v2 over the Americas;
 * the terrain layers credit their DEM stack's sources (demSourceCredit).
 */
export function createApplicationEarthEngineLayers({
  source = createEarthEngineSource(),
  riversV2 = createRiversV2Source(),
} = {}) {
  const credits = { register: registerDynamicCredit };
  return EARTH_ENGINE_LAYERS.map((record) =>
    createEarthEngineLayer({
      record,
      source,
      requestRender: governorRequestRender,
      credits,
      names:
        record.names === 'natural-earth-rivers'
          ? createRiverNames({ overlayHost })
          : null,
      clicks:
        record.names === 'natural-earth-rivers'
          ? createRiverClicks({
              overlayHost,
              picking,
              isPointerFree,
              requestRender: governorRequestRender,
              credits,
              credit: RIVER_REACH_CREDIT,
            })
          : null,
      v2Source: record.americasV2 ? riversV2 : null,
      v2Credit: record.americasV2 ? HYDROSHEDS_V2_CREDIT : null,
      // The terrain layers credit each elevation source as it first draws.
      demCredit: record.demStack ? demSourceCredit : null,
    }),
  );
}

/** The layer ids, for the panel and the catalog's local-only list. */
export const EARTH_ENGINE_LAYER_IDS = Object.freeze(
  EARTH_ENGINE_LAYERS.map((record) => record.id),
);
