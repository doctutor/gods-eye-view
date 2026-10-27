import { createLegoController } from '../layers/lego/index.js';
import { isLegoLayer, ELEVATION_LAYER_ID } from '../layers/lego/layerSpecs.js';
import {
  createPhotorealController,
  photorealStore,
} from '../layers/lego/photoreal.js';
import { createLegoHeadingControl } from '../layers/lego/presentation.js';
import { renderModeStore } from '../layers/lego/renderMode.js';
import { createApplicationBlocks } from './blocks.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { governorRequestRender } from '../renderGovernor.js';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { layerNameForId } from '../ui/layerNames.js';
import { overlayHost } from './layers/overlayHost.js';

/**
 * Personal fork: the Lego rendering mode for raster layers
 * (src/layers/lego/), and the drop-down beside the ANALYSIS heading that
 * turns it on; with it, Relief ×N and Photoreal on bricks (photoreal.js),
 * the two ways of seeing elevation with the Google 3D tiles, and Render:
 * Blocks (src/app/blocks.js), which shares the drop-down's store.
 * @param {{viewer: object, dataManager: object, mapStackController?: object}} scene
 */
export function createApplicationLego({
  viewer,
  dataManager,
  mapStackController,
}) {
  // One render mode for the drop-down, Lego, Blocks and the share link (`bk`).
  const renderMode = renderModeStore();
  const lego = createLegoController({
    viewer,
    store: renderMode,
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
  const store = photorealStore();
  const photoreal = createPhotorealController({
    viewer,
    lego,
    mapStackController,
    store,
    geoid: { ready: ensureGeoidReady, height: geoidHeight },
    // The textured tops' imagery credit, in the data popover too.
    registerCredit: (credit) => registerDynamicCredit(viewer, credit),
    requestRender: governorRequestRender,
  });
  const blocks = createApplicationBlocks({
    viewer,
    dataManager,
    store: renderMode,
  });
  // A link asking for the bricks turns Lego on, and the elevation layer
  // when no Lego layer is on, once the layers are restored.
  if (store.linkAskedForBricks()) {
    lego.setMode('lego');
    setTimeout(() => {
      const on = (dataManager.getAll?.() || []).some(
        (layer) => isLegoLayer(layer.id) && dataManager.isEnabled(layer.id),
      );
      if (!on)
        dataManager.setEnabled?.(ELEVATION_LAYER_ID, true, {
          origin: 'programmatic',
        });
    }, 0);
  }
  return {
    lego,
    photoreal,
    blocks,
    /** Group heading controls for the layer panel (LayerPresentation). */
    headingControls: {
      Analysis: (doc) => createLegoHeadingControl(doc, lego, photoreal, blocks),
    },
    destroy: () => {
      blocks.destroy();
      photoreal.destroy();
      lego.destroy();
    },
  };
}
