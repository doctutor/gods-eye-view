import { createBaltimoreCameraLayers } from '../../layers/baltimoreCameras/index.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';

/** Personal-fork Baltimore camera-location layers, wired to app services. */
export function createApplicationBaltimoreCameras(options = {}) {
  return createBaltimoreCameraLayers({
    overlayHost,
    credits: { register: registerDynamicCredit },
    ...options,
  });
}
