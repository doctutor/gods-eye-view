import { createRecordedVideoLayer } from '../../layers/recordedVideo/index.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { initRecordedVideoPanel } from '../../ui/recordedVideoPanel.js';
import { overlayHost } from './overlayHost.js';

/**
 * Personal-fork Recorded Video layer, wired to app services. Its panel
 * block (layer-panels.html) is bound the first time the layer turns on,
 * once the panel markup is in the page.
 */
export function createApplicationRecordedVideo(options = {}) {
  const layer = createRecordedVideoLayer({
    overlayHost,
    credits: { register: registerDynamicCredit },
    ...options,
  });
  let panelBound = false;
  const enable = layer.enable.bind(layer);
  layer.enable = (viewer) => {
    enable(viewer);
    if (panelBound || typeof document === 'undefined') return;
    const root = document.querySelector('[data-recorded-video-panel]');
    if (!root) return;
    panelBound = true;
    initRecordedVideoPanel(root, { layer });
  };
  return layer;
}
