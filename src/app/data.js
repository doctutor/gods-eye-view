import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { createCyberSonarScene } from '../cyberSonarScene.js';
// Personal fork: the Lego rendering mode for raster layers (src/layers/lego/).
import { createApplicationLego } from './lego.js';
// Personal fork: the DATA LAYERS panel's Titles toggle.
import { titlesPreference } from '../ui/titles.js';
import { setOverlayTitlesVisible } from '../overlays/worldOverlay.js';
// Personal fork: Walk and Fly (src/navigation/), beside the Render control.
import {
  combineHeadingControls,
  createNavigationHeadingControl,
} from '../navigation/presentation.js';
import { navigationStore } from '../navigation/store.js';
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, mapStackController },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  onData,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new LayerLifecycle(viewer, {
    allowQaRegistration,
    getSourceAvailability: catalog?.getSourceAvailability,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  // Personal fork: Lego mode, its drop-down beside the ANALYSIS heading.
  const lego = createApplicationLego({
    viewer,
    dataManager,
    mapStackController,
  });
  defer(() => lego.destroy());
  const titles = titlesPreference();
  titles.attachHost({ set: setOverlayTitlesVisible });
  const presentation = new LayerPresentation(dataManager, {
    weatherClock: catalog?.weatherClock,
    groupHeadingControls: {
      ...lego.headingControls,
      Analysis: (doc) =>
        combineHeadingControls(
          doc,
          lego.headingControls?.Analysis?.(doc),
          createNavigationHeadingControl(doc, navigationStore()),
        ),
    },
    // Personal fork: names on markers on or off, for every layer.
    titles,
  });
  defer(() => presentation.destroy());
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  for (const layer of catalog.layers) dataManager.register(layer);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);
  // Restoration starts only after the caller's complete registry is sealed.
  dataManager.finalizeRegistrations(catalog.metadata);
  if (allowQaRegistration) {
    window.__gevQaRegisterLayer = (targetManager, layerModule) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.registerForQa(layerModule);
    };
    window.__gevQaUnregisterLayer = (targetManager, layerId) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.unregisterForQa(layerId);
    };
    const register = window.__gevQaRegisterLayer;
    const unregister = window.__gevQaUnregisterLayer;
    defer(() => {
      if (window.__gevQaRegisterLayer === register)
        delete window.__gevQaRegisterLayer;
      if (window.__gevQaUnregisterLayer === unregister)
        delete window.__gevQaUnregisterLayer;
    });
  }
  presentation.mount(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);
  defer(createCyberSonarScene(viewer, dataManager));

  return { dataManager, catalog, presentation };
}
