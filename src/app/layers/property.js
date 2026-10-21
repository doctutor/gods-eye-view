import {
  PROPERTY_LAYER_ID,
  createPropertyLayer,
} from '../../layers/property/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Property sales layer (ANALYSIS in the DATA LAYERS panel):
 * US property records' public-record fields from the local index, hexagons
 * from afar and buildings close in.
 */
export function createApplicationProperty() {
  return createPropertyLayer({
    overlayHost,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
  });
}

/** The layer id, for the panel and the catalog's local-only list. */
export const PROPERTY_ID = PROPERTY_LAYER_ID;
