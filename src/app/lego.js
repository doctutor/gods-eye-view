import { createLegoController } from '../layers/lego/index.js';
import { createLegoHeadingControl } from '../layers/lego/presentation.js';
import { governorRequestRender } from '../renderGovernor.js';
import { layerNameForId } from '../ui/layerNames.js';
import { overlayHost } from './layers/overlayHost.js';

/**
 * Personal fork: the Lego rendering mode for raster layers
 * (src/layers/lego/), and the drop-down beside the ANALYSIS heading that
 * turns it on.
 * @param {{viewer: object, dataManager: object, mapStackController?: object}} scene
 */
export function createApplicationLego({
  viewer,
  dataManager,
  mapStackController,
}) {
  const lego = createLegoController({
    viewer,
    layers: {
      getAll: () => dataManager.getAll(),
      isEnabled: (id) => dataManager.isEnabled(id),
      subscribeActivity: (listener) => dataManager.subscribeActivity(listener),
    },
    overlayHost,
    mapStackController,
    requestRender: governorRequestRender,
    layerName: (id) => layerNameForId(id) || id,
  });
  return {
    lego,
    /** Group heading controls for the layer panel (LayerPresentation). */
    headingControls: {
      Analysis: (doc) => createLegoHeadingControl(doc, lego),
    },
    destroy: () => lego.destroy(),
  };
}
