import {
  WORLD_HISTORY_LAYER_ID,
  createWorldHistoryLayer,
} from '../../layers/worldHistory/index.js';
import { createWorldHistorySource } from '../../layers/worldHistory/source.js';
import { worldHistoryStore } from '../../layers/worldHistory/store.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { createWorldHistoryPanel } from '../../ui/worldHistoryPanel.js';
import { overlayHost } from './overlayHost.js';

export { WORLD_HISTORY_LAYER_ID };

/**
 * Personal-fork World history layer (REFERENCE in the DATA LAYERS panel):
 * any year from 2500 BC to 2025 as Cottereau's video shows it, from
 * Cliopatria's polity shapes, and a list of polities to compare. Its
 * right-rail panel (context.html, `#world-history-panel`) is bound the
 * first time the layer turns on.
 */
export function createApplicationWorldHistory() {
  const layer = createWorldHistoryLayer({
    store: worldHistoryStore(),
    source: createWorldHistorySource(),
    overlayHost,
    hitTest: hitTestWorldOverlay,
    requestRender: governorRequestRender,
    credits: { register: registerDynamicCredit },
  });
  let panel = null;
  const enable = layer.enable.bind(layer);
  layer.enable = (viewer) => {
    enable(viewer);
    if (panel || typeof document === 'undefined') return;
    const body = document.getElementById('world-history-panel-body');
    if (body) panel = createWorldHistoryPanel(body, { layer });
  };
  return layer;
}
