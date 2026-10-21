import {
  LAYER_ID,
  createWikipediaCoverageLayer,
} from '../../layers/wikipediaCoverage/index.js';
import { createWikipediaCoverageSource } from '../../layers/wikipediaCoverage/source.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Wikipedia layer (REFERENCE in the DATA LAYERS panel): one
 * dot per geotagged article, and the coverage rasters, from the local
 * server's points index and grid.
 */
export function createApplicationWikipediaCoverage({
  source = createWikipediaCoverageSource(),
} = {}) {
  return createWikipediaCoverageLayer({
    source,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    overlayHost,
    hitTest: hitTestWorldOverlay,
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const WIKIPEDIA_COVERAGE_LAYER_ID = LAYER_ID;
