import { t, tn } from '../i18n/index.js';
import { cctvSourceLabelText, cctvSourceMessageText } from './cctvFrames.js';

import { createCctvVideoSurface } from './cctvVideo.js';
import { embedMetaText, operatorLinkFor, syncCctvEmbed } from './cctvEmbed.js';
import { rankCameras, renderCameraList } from './cctvCameraList.js';
// Personal fork: panel parts and wording by camera kind.
import { syncCctvPanelKind } from './cctvPanelKind.js';
import { audioMetaLabel } from '../layers/cctv/audio.js';
import { panelFrameHidden, syncHideWindy } from './cctvScreenshotSafe.js';

/**
 * Personal fork: rebuild the camera list from the current state, the
 * search text and the centre captured when the search box was last focused.
 */
export function _renderCameraList() {
  if (this.destroyed || !this._cctvCameraList) return;
  const state = this._cctvState;
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const cameras = state?.cameras || [];
  const query = this._cctvCameraSearch?.value || '';
  const center = this._cameraListCenter ?? state?.viewCenter ?? null;
  const entries = enabled ? rankCameras(cameras, center, query) : [];
  this._cameraListIds = entries.map((entry) => entry.camera.id);
  if (
    this._cameraListHighlightId &&
    !this._cameraListIds.includes(this._cameraListHighlightId)
  )
    this._cameraListHighlightId = null;
  renderCameraList(this._cctvCameraList, entries, {
    activeId: state?.activeCameraId || null,
    highlightId: this._cameraListHighlightId,
    total: cameras.length,
    query,
  });
  if (this._cctvCameraSearch) this._cctvCameraSearch.disabled = !enabled;
}
export function _calBadgeLabel(badge) {
  switch (badge) {
    case 'calibrated':
      return t('CALIBRATED');
    case 'curated':
      return t('CURATED');
    case 'raw-prior':
      return t('RAW PRIOR');
    default:
      return '--';
  }
}

export function _renderCctvState(state) {
  if (this.destroyed) return;
  if (
    !state?.enabled ||
    !this.actions.isEnabled() ||
    state?.activeCameraId !== this._cctvState?.activeCameraId
  ) {
    this._calibrationEdit?.(false);
  }
  this._cctvState = state || null;
  const cameras = state?.cameras || [];
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = state?.activeCameraId || '';
  const activeCamera = state?.activeCamera || null;

  // Auto-expand the panel when the active camera CHANGES to a new non-null
  // id while the layer is enabled. Covers click-on-globe, panel controls,
  // and voice (selectCamera/cycleCamera/focusNearest all notify through
  // this subscription). The last-seen guard keeps routine notifications
  // from re-expanding a panel the user deliberately collapsed, and timed
  // auto-hop transitions only expand on the first activation so the panel
  // does not pop open on every hop.
  const effectiveActiveId = enabled ? activeId || null : null;
  const isFirstActivation = this._lastSeenCctvActiveId === null;
  if (
    effectiveActiveId &&
    effectiveActiveId !== this._lastSeenCctvActiveId &&
    (!state?.autoHop || isFirstActivation)
  ) {
    this.actions.setPanelCollapsed('cctv-panel', false, {
      explicit: Boolean(state?.explicitSelection),
    });
  }
  this._lastSeenCctvActiveId = effectiveActiveId;

  this._updateCctvSyncChip(state?.loading, enabled);

  if (this._cctvEnableBtn) {
    this._cctvEnableBtn.classList.toggle('active', enabled);
    this._cctvEnableBtn.textContent = enabled ? t('CCTV ON') : t('CCTV OFF');
  }

  if (this._cctvSelect) {
    const shouldRebuild =
      this._cctvSelect.options.length !== cameras.length ||
      cameras.some(
        (cam, idx) => this._cctvSelect.options[idx]?.value !== cam.id,
      );
    if (shouldRebuild) {
      this._cctvSelect.innerHTML = '';
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.id;
        option.textContent = `${camera.city} · ${camera.name}`;
        this._cctvSelect.appendChild(option);
      }
    }
    this._cctvSelect.disabled = !enabled || cameras.length === 0;
    // Personal fork: the visible picker follows the same state.
    const listKey = `${enabled}|${cameras.length}|${activeId}`;
    if (shouldRebuild || listKey !== this._cameraListKey) {
      this._cameraListKey = listKey;
      this._renderCameraList();
    }
    if (
      activeId &&
      Array.from(this._cctvSelect.options).some((opt) => opt.value === activeId)
    ) {
      this._cctvSelect.value = activeId;
    } else if (!activeId) {
      this._cctvSelect.selectedIndex = -1;
    }
  }

  for (const btn of [
    this._cctvNearestBtn,
    this._cctvPrevBtn,
    this._cctvNextBtn,
  ]) {
    if (!btn) continue;
    btn.disabled = !enabled || cameras.length === 0;
  }
  if (this._cctvFocusBtn) {
    this._cctvFocusBtn.disabled = !enabled || cameras.length === 0 || !activeId;
  }

  if (this._cctvCoverageBtn) {
    // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
    // (color-coded volumes). The click handler cycles; this renders.
    const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
    this._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
    this._cctvCoverageBtn.textContent =
      mode === 'viewshed'
        ? t('VIEWSHED ON')
        : mode === 'on'
          ? t('COVERAGE ON')
          : t('COVERAGE OFF');
    this._cctvCoverageBtn.disabled = !enabled;
  }

  if (this._cctvAutoHopBtn) {
    const autoHop = !!state?.autoHop;
    this._cctvAutoHopBtn.classList.toggle('active', autoHop);
    this._cctvAutoHopBtn.textContent = autoHop
      ? t('AUTO HOP ON')
      : t('AUTO HOP OFF');
    this._cctvAutoHopBtn.disabled = !enabled;
  }

  if (this._cctvProjectionBtn) {
    const showProjection = state?.showProjection !== false;
    this._cctvProjectionBtn.classList.toggle('active', showProjection);
    this._cctvProjectionBtn.textContent = showProjection
      ? t('PROJECTION ON')
      : t('PROJECTION OFF');
    this._cctvProjectionBtn.disabled = !enabled;
  }

  if (this._cctvQualityChip) {
    // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
    // no in-world tint): three states driven by cctv.js's deriveCalBadge,
    // no client-side scoring math. Casing is unified via _calBadgeLabel so
    // the chip and the meta line never drift onto different conventions.
    // Save-gated persistence (viewshed design §3e): unsaved live edits show
    // EDITED on top of whatever the persisted badge state is — SAVE CAL
    // promotes to CALIBRATED, RESET CAL clears.
    const badge = activeCamera?.calBadge || null;
    const dirty = !!activeCamera?.calDirty;
    this._cctvQualityChip.textContent = dirty
      ? t('CAL · EDITED (UNSAVED)')
      : t('CAL · {badge}', {
          badge: this._calBadgeLabel(badge),
        });
    this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
  }

  this._syncCctvCalReadout(enabled, activeCamera);

  if (this._cctvMeta) {
    if (activeCamera?.embed) {
      // Personal fork: an embedded stream's own meta line (cctvEmbed.js).
      this._cctvMeta.textContent = embedMetaText(activeCamera);
    } else if (activeCamera) {
      const provider = cctvSourceLabelText(
        activeCamera.sourceLabel ||
          activeCamera.provider ||
          'Configured Source',
      );
      const statusMsg = activeCamera.sourceMessage
        ? ` · ${cctvSourceMessageText(activeCamera.sourceMessage)}`
        : '';
      // A partner-supplied feed inside a pack names its owner here.
      const credit = activeCamera.credit ? ` · ${activeCamera.credit}` : '';
      const calBadge = activeCamera.calBadge
        ? this._calBadgeLabel(activeCamera.calBadge)
        : '';
      const projLabel =
        state?.showProjection !== false ? t('MONITOR') : t('OFF');
      // Personal fork: " · sound" / " · silent" once the stream was probed.
      const sound = audioMetaLabel(activeCamera);
      this._cctvMeta.textContent = t(
        '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
        {
          city: activeCamera.city,
          heading: `${Math.round(activeCamera.headingDeg)}°`,
          fov: `${Math.round(activeCamera.fovDeg)}°`,
          range: Math.round(activeCamera.rangeM),
          projection: projLabel,
          calBadge: calBadge ? ` · ${calBadge}` : '',
          provider,
          status: `${credit}${sound ? ` · ${sound}` : ''}${statusMsg}`,
        },
      );
    } else if (cameras.length > 0) {
      this._cctvMeta.textContent = enabled
        ? tn(
            cameras.length,
            '{count} camera loaded · click a camera to activate',
            '{count} cameras loaded · click a camera to activate',
          )
        : tn(
            cameras.length,
            '{count} camera loaded · enable CCTV to activate',
            '{count} cameras loaded · enable CCTV to activate',
          );
    } else {
      this._cctvMeta.textContent = t(
        'Enable CCTV to load camera intersections',
      );
    }
  }

  // Personal fork: the operator's own page for a linked or display-only
  // webcam (Windy requires every image to link to its page).
  if (this._cctvOperatorLink) {
    const link = enabled ? operatorLinkFor(activeCamera) : null;
    this._cctvOperatorLink.hidden = !link;
    if (link) {
      this._cctvOperatorLink.href = link.href;
      this._cctvOperatorLink.textContent = link.text;
    } else {
      this._cctvOperatorLink.removeAttribute('href');
      this._cctvOperatorLink.textContent = '';
    }
  }

  const liveIntent = enabled && !!activeCamera?.isVideo;
  if (this._cctvVideo) {
    this._cctvVideo.hidden = !liveIntent;
    if (this._cctvFrame) this._cctvFrame.hidden = liveIntent;
    const visible =
      liveIntent &&
      !document.hidden &&
      !this._cctvPanel?.classList.contains('collapsed');
    if (!visible || this._cctvVideoCameraId !== activeId) {
      this._cctvVideoSurface?.stop();
      this._cctvVideoSurface = null;
    }
    this._cctvVideoCameraId = activeId;
    if (visible && !this._cctvVideoSurface) {
      this._cctvVideoSurface = createCctvVideoSurface(this._cctvVideo, () =>
        this.cctv.getActiveVideoElement?.(),
      );
    }
  }

  // Personal fork: an operator's YouTube stream plays in its own player.
  const embedActive = syncCctvEmbed(this, { enabled, activeCamera });
  if (this._cctvFrame && embedActive) this._cctvFrame.hidden = true;

  if (this._cctvFrame && !liveIntent && !embedActive) {
    // Personal fork: no still for a camera screenshot-safe mode hides.
    const nextSrc =
      enabled && !panelFrameHidden(activeCamera)
        ? activeCamera?.frameUrl
        : null;
    const nextCameraId = enabled ? activeCamera?.id || '' : '';
    const cameraChanged = this._cctvFrame.dataset.cameraId !== nextCameraId;
    const frameLoading = this._cctvFrame.dataset.loading === 'true';
    // A same-camera refresh waits for the current image to settle. Replacing
    // src every 10 seconds can cancel a slow but healthy decode forever and
    // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
    // immediate so navigation never waits on the prior camera's request.
    if (
      nextSrc &&
      (cameraChanged ||
        (!frameLoading && this._cctvFrame.dataset.currentSrc !== nextSrc))
    ) {
      this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged);
    }
    if (!nextSrc) {
      this._clearCctvFrame();
    }
  } else if (liveIntent || embedActive) {
    this._clearCctvFrame();
  }

  // Personal fork: embed, still and link cameras have no pose: hide the
  // pose-only controls (CSS on data-camera-kind) and use plain wording.
  const kindSummary = syncCctvPanelKind(this, { enabled, activeCamera });
  syncHideWindy(this, state);

  this._syncCctvSourceBadge(activeCamera, enabled);
  this._typeCctvSummary(
    kindSummary ||
      state?.summary ||
      t('Enable CCTV to start camera-linked intelligence summaries.'),
  );
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || t('No summary available.');
  if (nextText === this._lastCctvSummaryText) return;
  this._lastCctvSummaryText = nextText;

  clearInterval(this._cctvSummaryTypingTimer);
  this._cctvSummary.textContent = '';
  let idx = 0;
  this._cctvSummaryTypingTimer = setInterval(() => {
    if (this.destroyed) return;
    idx += 3;
    if (idx >= nextText.length) {
      this._cctvSummary.textContent = nextText;
      clearInterval(this._cctvSummaryTypingTimer);
      this._cctvSummaryTypingTimer = null;
      return;
    }
    this._cctvSummary.textContent = nextText.slice(0, idx);
  }, 20);
}

export function _updateCctvSyncChip(loading, enabled) {
  if (this.destroyed) return;
  if (!this._cctvSyncChip || !this._cctvSyncLabel || !this._cctvSyncProgress)
    return;
  const total = Number(loading?.total) || 0;
  const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
  const busy = !!enabled && !!loading?.active && total > 0;

  if (busy) {
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = true;
    this.actions.setSplitFlapText(this._cctvSyncLabel, t('loading frames'));
    // The counter is left plain on purpose: it ticks every few frames
    // during a grid load, and flapping it would read as a slot machine.
    this._cctvSyncProgress.textContent = `${loaded}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    return;
  }

  if (this._cctvChipWasBusy && enabled && total > 0) {
    // Load just completed — flash the final count, then auto-hide.
    this._cctvChipWasBusy = false;
    this.actions.setSplitFlapText(this._cctvSyncLabel, t('camera grid ready'));
    this._cctvSyncProgress.textContent = `${total}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      this._cctvChipHideTimer = null;
      this._cctvSyncChip.classList.remove('visible');
    }, 1500);
    return;
  }

  if (!this._cctvChipHideTimer) {
    this._cctvChipWasBusy = false;
    this._cctvSyncChip.classList.remove('visible');
  }
}
