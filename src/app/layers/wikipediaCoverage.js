import {
  LAYER_ID,
  createWikipediaCoverageLayer,
} from '../../layers/wikipediaCoverage/index.js';
import { createWikipediaCoverageSource } from '../../layers/wikipediaCoverage/source.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';

/**
 * Personal-fork Wikipedia coverage layer (ANALYSIS in the DATA LAYERS
 * panel): where English Wikipedia has written about the Earth, from the
 * local server's grid.
 */
export function createApplicationWikipediaCoverage({
  source = createWikipediaCoverageSource(),
} = {}) {
  return createWikipediaCoverageLayer({
    source,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const WIKIPEDIA_COVERAGE_LAYER_ID = LAYER_ID;
