import {
  STREET_ASSETS_LAYER_ID,
  createStreetAssetsLayer,
} from '../../layers/streetAssets/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Street assets layer (ANALYSIS in the DATA LAYERS panel):
 * EV charging, bike lanes, hydrants, street lights and traffic signals from
 * OpenStreetMap, pins close in and H3 counts above.
 */
export function createApplicationStreetAssets() {
  return createStreetAssetsLayer({
    overlayHost,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    picking,
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const STREET_ASSETS_ID = STREET_ASSETS_LAYER_ID;
