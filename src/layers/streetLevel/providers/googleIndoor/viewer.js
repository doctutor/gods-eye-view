// Personal fork: Maps Embed API Street View viewer for indoor panoramas.
import {
  GSV_INDOOR_PROVIDER_ID,
  embedUrl,
  isPanoId,
  panoDateMs,
  panoExternalUrl,
} from './policy.js';

/** Give up waiting for the frame's load event after this long; the pose still goes out. */
const FRAME_LOAD_TIMEOUT_MS = 8000;

/**
 * Viewer adapter: one iframe in the core's host, pointed only at the Maps
 * Embed Street View URL for a validated panorama id. The embed reports no
 * view changes, so the single pose comes from the database hit (`lookup`).
 * @param {{source: {embedKey: () => string}, lookup: (panoId: string) => object|null}} options
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createGoogleIndoorViewer({ source, lookup = () => null }) {
  let host = null;
  let wrapper = null;
  let frame = null;
  let restorePosition = null;
  let openSeq = 0;
  const listeners = new Set();

  function emit(pose) {
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
  }

  function build(element) {
    const doc = element.ownerDocument || globalThis.document;
    wrapper = doc.createElement('div');
    wrapper.className = 'gsv-indoor-viewer';
    Object.assign(wrapper.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '2',
      background: '#000',
    });
    frame = doc.createElement('iframe');
    // i18n-ignore: personal fork, English-only UI
    frame.title = 'Google Street View';
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('loading', 'eager');
    // The browser key is referrer-restricted: send the page's origin.
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    Object.assign(frame.style, {
      border: '0',
      width: '100%',
      height: '100%',
      display: 'block',
    });
    wrapper.appendChild(frame);
    // The wrapper fills the host; a static host would let it escape.
    const view = doc.defaultView;
    const position = view?.getComputedStyle?.(element)?.position;
    if (!position || position === 'static') {
      const previous = element.style.position;
      element.style.position = 'relative';
      restorePosition = () => {
        element.style.position = previous;
      };
    }
    element.appendChild(wrapper);
    host = element;
  }

  function waitForLoad(target, seq) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        target.removeEventListener?.('load', done);
        resolve(seq === openSeq);
      };
      target.addEventListener?.('load', done);
      timer = setTimeout(done, FRAME_LOAD_TIMEOUT_MS);
    });
  }

  return {
    async mount(element) {
      if (!element) throw new Error('Street Level viewer has no host element');
      if (host === element && wrapper?.isConnected !== false) return;
      this.unmount();
      build(element);
    },

    /** Resolves once the frame loaded (or the wait timed out) and the pose went out. */
    async open(imageId) {
      const panoId = String(imageId);
      if (!frame) throw new Error('Google viewer is not mounted');
      if (!isPanoId(panoId)) throw new Error('Not a Google panorama id');
      const url = embedUrl(source.embedKey(), panoId);
      if (!url)
        throw new Error(
          'Set GOOGLE_MAPS_API_KEY to view Google indoor imagery',
        );
      const seq = ++openSeq;
      const loaded = waitForLoad(frame, seq);
      frame.src = url;
      if (!(await loaded)) return;
      const hit = lookup(panoId);
      emit({
        providerId: GSV_INDOOR_PROVIDER_ID,
        imageId: panoId,
        position:
          Number.isFinite(hit?.lon) && Number.isFinite(hit?.lat)
            ? { lon: hit.lon, lat: hit.lat }
            : null,
        bearing: null,
        tilt: 0,
        altitude: null,
        isPano: true,
        capturedAt: panoDateMs(hit?.panoDate),
        creator: hit?.copyright
          ? String(hit.copyright).replace(/^©\s*/, '')
          : null,
        sequenceId: null,
        externalUrl: panoExternalUrl(panoId),
      });
    },

    close() {
      openSeq++;
      if (frame) frame.src = 'about:blank';
    },

    unmount() {
      openSeq++;
      wrapper?.remove?.();
      restorePosition?.();
      restorePosition = null;
      wrapper = null;
      frame = null;
      host = null;
    },

    resize() {},

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
