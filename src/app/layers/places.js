import {
  PLACES_LAYER_ID,
  createPlacesLayer,
} from '../../layers/places/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Places layer (ANALYSIS in the DATA LAYERS panel): Overture
 * Maps' points of interest from the local index, pins close in and H3
 * counts above.
 */
export function createApplicationPlaces() {
  return createPlacesLayer({
    overlayHost,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    picking,
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const PLACES_ID = PLACES_LAYER_ID;
