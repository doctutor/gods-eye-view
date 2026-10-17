import { createRecordedVideoLayer } from '../../layers/recordedVideo/index.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';

/** Personal-fork Recorded Video layer, wired to app services. */
export function createApplicationRecordedVideo(options = {}) {
  return createRecordedVideoLayer({
    overlayHost,
    credits: { register: registerDynamicCredit },
    ...options,
  });
}
