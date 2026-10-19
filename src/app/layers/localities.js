import {
  LOCALITIES_LAYER_ID,
  createLocalitiesLayer,
} from '../../layers/localities/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Localities layer (REFERENCE in the DATA LAYERS panel):
 * populated places named at every height, Natural Earth from orbit and
 * OpenStreetMap close in.
 */
export function createApplicationLocalities() {
  return createLocalitiesLayer({
    overlayHost,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    hitTest: hitTestWorldOverlay,
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const LOCALITIES_ID = LOCALITIES_LAYER_ID;
