import { createGridLayer } from '../../layers/grid/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { overlayHost } from './overlayHost.js';

/** Personal-fork Grid layer (REFERENCE in the DATA LAYERS panel). */
export function createApplicationGrid() {
  return createGridLayer({ requestRender: governorRequestRender, overlayHost });
}
