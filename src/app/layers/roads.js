import { ROADS_LAYER_ID, createRoadsLayer } from '../../layers/roads/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Roads layer (ANALYSIS in the DATA LAYERS panel): Overture
 * Maps' road segments as self-hosted tiles, with a card for a clicked road.
 */
export function createApplicationRoads() {
  return createRoadsLayer({
    overlayHost,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    picking,
    isPointerFree,
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const ROADS_ID = ROADS_LAYER_ID;
