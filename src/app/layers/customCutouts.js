import {
  CUSTOM_CUTOUTS_LAYER_ID,
  createCustomCutoutsLayer,
} from '../../layers/customCutouts/index.js';
import { createCutoutSource } from '../../layers/customCutouts/source.js';
import { pickWorldFromScreen } from '../../annotations/annotationResolver.js';
import { cutoutStore } from '../../layers/customCutouts/store.js';
import { applicationServices } from '../../services/application.js';
import { findAdminArea } from '../../data/adminBoundaries.js';
import { defaultGeospatial } from '../../search/defaults.js';
import {
  hideOsmCredit,
  registerDynamicCredit,
  showOsmCredit,
} from '../../data/dataCredits.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { createCustomCutoutsPanel } from '../../ui/customCutoutsPanel.js';

export { CUSTOM_CUTOUTS_LAYER_ID };

/**
 * Personal-fork Custom cutouts layer (REFERENCE in the DATA LAYERS panel):
 * the Google 3D tiles clipped to boundaries from the local Overpass (the
 * bundled boundary packs by name when it does not answer). Its right-rail
 * panel (context.html, `#custom-cutouts-panel`) is bound the first time
 * the layer turns on.
 */
export function createApplicationCustomCutouts() {
  const layer = createCustomCutoutsLayer({
    store: cutoutStore(),
    source: createCutoutSource({
      boundaries: applicationServices.boundaries,
      findAdminArea,
    }),
    placeSearch: defaultGeospatial,
    // Corners drawn on the map land on Google's ground or roofs.
    pickWorld: pickWorldFromScreen,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
    osmCredit: {
      show: (viewer) => showOsmCredit(viewer, CUSTOM_CUTOUTS_LAYER_ID),
      hide: (viewer) => hideOsmCredit(viewer, CUSTOM_CUTOUTS_LAYER_ID),
    },
  });
  let panel = null;
  const enable = layer.enable.bind(layer);
  layer.enable = (viewer) => {
    enable(viewer);
    if (panel || typeof document === 'undefined') return;
    const body = document.getElementById('custom-cutouts-panel-body');
    if (body) panel = createCustomCutoutsPanel(body, { layer });
  };
  return layer;
}
