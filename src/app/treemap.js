/**
 * Personal fork: the TREEMAP window installed (docs/TREEMAP-PLAN.md). The
 * panel (context.html, `#treemap-panel`) is mounted the first time it is
 * opened (nothing is asked of the service before), on one source: the
 * service's tables while /api/treemap answers, else a page-local sample,
 * and the live layers' records for their variables. Its pop-out button
 * lifts it out as a larger window (the shell's popOutPanel) and docks it
 * back. Hovering a tile outlines it on the globe; double-click flies there.
 */
import { t, msg } from '../i18n/index.js';
import {
  createServiceSource,
  createWindowSource,
} from '../data/treemapSources.js';
import { createSampleSource } from '../data/treemapSample.js';
import { createLiveTreemapSource } from './treemapLive.js';
import { treemapStore } from '../data/treemapStore.js';
import { createTreemapPanel } from '../ui/treemapPanel.js';
import { createTreemapGlobeLink } from '../ui/treemapGlobe.js';

/** The pop-out window's size: most of the viewport, at most this. */
export const POP_OUT_MAX = Object.freeze({ width: 1180, height: 820 });
const POP_OUT_TITLE = msg('Open the treemap in a larger window');
const DOCK_TITLE = msg('Put the treemap back in the panel column');

/**
 * @param {{viewer: object, shell?: {popOutPanel?: Function, dockPanel?:
 *   Function}|null, dataManager?: {layers?: Map}|null, liveSource?:
 *   object|null, documentRef?: Document, windowRef?: Window}} options
 *   `liveSource` defaults to the live layers of `dataManager`
 * @returns {{destroy: () => void, panel: () => object|null}}
 */
export function installTreemapPanel({
  viewer,
  shell = null,
  dataManager = null,
  liveSource = dataManager
    ? createLiveTreemapSource({ layers: () => dataManager.layers })
    : null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  const panelEl = documentRef?.getElementById('treemap-panel');
  const body = documentRef?.getElementById('treemap-panel-body');
  if (!panelEl || !body) return { destroy() {}, panel: () => null };
  const sourceLabel = documentRef.getElementById('treemap-panel-source');
  const popOut = documentRef.getElementById('treemap-popout-btn');
  const store = treemapStore();
  const source = createWindowSource({
    service: createServiceSource(),
    fallback: createSampleSource(),
    local: liveSource,
  });
  const globe = viewer ? createTreemapGlobeLink({ viewer, source }) : null;
  let panel = null;

  const mount = () => {
    if (panel || panelEl.classList.contains('collapsed')) return;
    panel = createTreemapPanel({
      container: body,
      source,
      store,
      globe,
      sourceLabel,
      documentRef,
      windowRef,
    });
  };
  const syncPopOut = () => {
    if (!popOut) return;
    const floating = panelEl.classList.contains('panel-floating');
    popOut.setAttribute('aria-pressed', String(floating));
    const title = t(floating ? DOCK_TITLE : POP_OUT_TITLE);
    popOut.title = title;
    popOut.setAttribute('aria-label', title);
    const icon = popOut.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = floating ? 'close_fullscreen' : 'open_in_full';
    popOut.hidden = panelEl.classList.contains('collapsed');
  };
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          mount();
          syncPopOut();
          panel?.redraw();
        })
      : null;
  observer?.observe(panelEl, { attributes: true, attributeFilter: ['class'] });
  const onPopOut = (event) => {
    event.stopPropagation();
    if (panelEl.classList.contains('panel-floating'))
      shell?.dockPanel?.('treemap-panel');
    else
      shell?.popOutPanel?.('treemap-panel', {
        width: Math.min(
          POP_OUT_MAX.width,
          Math.round((windowRef?.innerWidth || 1200) * 0.72),
        ),
        height: Math.min(
          POP_OUT_MAX.height,
          Math.round((windowRef?.innerHeight || 800) * 0.78),
        ),
      });
    syncPopOut();
    panel?.redraw();
  };
  popOut?.addEventListener('click', onPopOut);
  mount();
  syncPopOut();
  // The harness's handle.
  const handle = { panel: () => panel, store, source };
  if (windowRef) windowRef.__gevTreemap = handle;
  return {
    panel: () => panel,
    destroy() {
      observer?.disconnect();
      popOut?.removeEventListener('click', onPopOut);
      panel?.destroy();
      panel = null;
      globe?.destroy();
      if (windowRef?.__gevTreemap === handle) delete windowRef.__gevTreemap;
    },
  };
}
