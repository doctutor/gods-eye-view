import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineLayer } from '../../layers/earthEngine/index.js';
import { createRiverClicks } from '../../layers/earthEngine/riverClicks.js';
import { createRiverNames } from '../../layers/earthEngine/riverNames.js';
import { createEarthEngineSource } from '../../layers/earthEngine/source.js';
import { createRiversV2Source } from '../../layers/riversV2/source.js';
import { createCensusSource } from '../../layers/census/source.js';
import { createOvertureBuildingsSource } from '../../layers/earthEngine/overtureBuildings.js';
import { createOvertureBoundariesSource } from '../../layers/earthEngine/overtureBoundaries.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { colourScales as sharedColourScales } from '../../maps/colourScaleStore.js';
import {
  HYDROSHEDS_V2_CREDIT,
  OVERTURE_BOUNDARIES_CREDIT,
  OVERTURE_BUILDINGS_CREDIT,
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
 * the terrain layers credit their DEM stack's sources (demSourceCredit);
 * the Administrative boundaries draw Overture's country lines when built.
 * Every windowable layer draws the shared colour-scale store's choice.
 */
export function createApplicationEarthEngineLayers({
  source = createEarthEngineSource(),
  riversV2 = createRiversV2Source(),
  census = createCensusSource(),
  overtureBuildings = createOvertureBuildingsSource(),
  overtureBoundaries = createOvertureBoundariesSource(),
  colourScales = sharedColourScales(),
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
      // Census tracts: HOUSEHOLD INCOME from the local server.
      localSource: record.modes?.some((mode) => mode.local === 'census')
        ? census
        : null,
      v2Credit: record.americasV2 ? HYDROSHEDS_V2_CREDIT : null,
      // The terrain layers credit each elevation source as it first draws.
      demCredit: record.demStack ? demSourceCredit : null,
      // Buildings: Overture's outside Open Buildings, when built.
      overtureSource: record.overture ? overtureBuildings : null,
      overtureCredit: record.overture ? OVERTURE_BUILDINGS_CREDIT : null,
      // Administrative boundaries: COUNTRIES from the local country lines,
      // REGIONS and DISTRICTS from the local region and county lines.
      countriesSource: hasCountryLines(record) ? overtureBoundaries : null,
      countriesCredit: hasCountryLines(record)
        ? OVERTURE_BOUNDARIES_CREDIT
        : null,
      colourScales,
    }),
  );
}

/** Whether a record has a variant drawn from the Overture country lines. */
const hasCountryLines = (record) =>
  (record.variants || []).some(
    (variant) => variant.local === 'overture-boundaries',
  );

/** The layer ids, for the panel and the catalog's local-only list. */
export const EARTH_ENGINE_LAYER_IDS = Object.freeze(
  EARTH_ENGINE_LAYERS.map((record) => record.id),
);
