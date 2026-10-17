import { t } from '../i18n/index.js';
import { stepHighlight } from './cctvCameraList.js';
import { initPendingCams } from './cctvPending.js';
import { initSourcesBlock } from './cctvSources.js';
import { bindHideWindy } from './cctvScreenshotSafe.js';

export function _initCctvPanel() {
  if (!this._cctvPanel) return;

  // Personal fork: the featured-cam review queue (cctvPending.js).
  const pendingCams = this._cctvPanel.querySelector?.('[data-cctv-pending]');
  if (pendingCams && typeof fetch === 'function')
    this._pendingCams = initPendingCams(pendingCams, {
      signal: this.listeners.signal,
      showToast: (message) => this.actions.showToast?.(message),
    });
  // Personal fork: the SOURCES readout (cctvSources.js).
  const sourcesBlock = this._cctvPanel.querySelector?.('[data-cctv-sources]');
  if (sourcesBlock && typeof fetch === 'function')
    this._sourcesBlock = initSourcesBlock(sourcesBlock, {
      signal: this.listeners.signal,
    });

  // Personal fork: the HIDE WINDY toggle (cctvScreenshotSafe.js).
  bindHideWindy(this);

  this.listen(this._cctvEnableBtn, 'click', async () => {
    this._actionGeneration++;
    await this.actions.toggleEnabled();
  });

  this.listen(this._cctvNearestBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.focusNearest({ focus: false }),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.8),
    );
  });

  this.listen(this._cctvPrevBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(-1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  this.listen(this._cctvNextBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  // Personal fork: the search box and list drive the hidden select.
  if (this._cctvCameraSearch && this._cctvCameraList) {
    const pick = (cameraId) => {
      if (!cameraId || !this._cctvSelect) return;
      this._cctvSelect.value = cameraId;
      this._cctvSelect.dispatchEvent(new Event('change', { bubbles: true }));
    };
    this.listen(this._cctvCameraSearch, 'input', () => {
      this._cameraListHighlightId = null;
      this._renderCameraList();
    });
    this.listen(this._cctvCameraSearch, 'focus', () => {
      // Re-rank from wherever the view is now, once per visit to the box.
      this._cameraListCenter = this._cctvState?.viewCenter ?? null;
      this._renderCameraList();
    });
    this.listen(this._cctvCameraSearch, 'keydown', (event) => {
      const ids = this._cameraListIds || [];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this._cameraListHighlightId = stepHighlight(
          ids,
          this._cameraListHighlightId,
          event.key === 'ArrowDown' ? 1 : -1,
        );
        this._renderCameraList();
        this._cctvCameraList
          .querySelector('.cctv-camera-row.highlight')
          ?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(this._cameraListHighlightId || ids[0]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this._cctvCameraSearch.value = '';
        this._cameraListHighlightId = null;
        this._renderCameraList();
      }
    });
    this.listen(this._cctvCameraList, 'click', (event) => {
      const row = event.target.closest('[data-camera-id]');
      if (row) pick(row.dataset.cameraId);
    });
  }

  this.listen(this._cctvSelect, 'change', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const cameraId = this._cctvSelect.value;
    if (!cameraId) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    // Picking a camera from the dropdown flies to it. The catalog spans
    // three metros, so a bare selection used to leave the view in the old
    // city with a camera active thousands of km away.
    this.actions.runExplicitFocus(
      () => (this.cctv.selectCamera(cameraId) ? cameraId : null),
      (selectedId) => this.cctv.focusCamera(selectedId, 2.2),
    );
    this.actions.setParams({ selectedCameraId: cameraId }, { origin: 'user' });
  });

  this.listen(this._cctvFocusBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const selected = this._cctvState?.activeCameraId || this._cctvSelect?.value;
    if (!selected) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => selected,
      (cameraId) => this.cctv.focusCamera(cameraId, 1.9),
    );
    this.actions.setParams({ selectedCameraId: selected }, { origin: 'user' });
  });

  this.listen(this._cctvCoverageBtn, 'click', () => {
    const current =
      this._cctvState?.coverageMode ||
      (this._cctvState?.showCoverage ? 'on' : 'off');
    const next =
      current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
    this.actions.setParams({ coverageMode: next }, { origin: 'user' });
  });

  this.listen(this._cctvAutoHopBtn, 'click', () => {
    const current = !!this._cctvState?.autoHop;
    this.actions.setParams({ autoHop: !current }, { origin: 'user' });
  });

  this.listen(this._cctvProjectionBtn, 'click', () => {
    const current = this._cctvState?.showProjection !== false;
    this.actions.setParams({ showProjection: !current }, { origin: 'user' });
  });

  this.listen(this._cctvAdjustBtn, 'click', () => {
    const current = !!this._cctvState?.calibrationMode;
    this.actions.setParams({ calibrationMode: !current }, { origin: 'user' });
  });

  // Click-to-edit pose readout: each chip swaps to a number input; Enter or
  // blur commits (converted to a calibration offset against basePose),
  // Escape cancels. Delegated so re-renders never re-bind.
  this.listen(this._cctvCalReadout, 'click', (event) => {
    const chip = event.target.closest?.('.cctv-cal-value');
    if (!chip || chip.disabled || chip.querySelector('input')) return;
    this._beginCctvCalValueEdit(chip);
  });

  this.listen(this._cctvCalibSaveBtn, 'click', () => {
    const cameraId = this._activeCctvCameraId();
    if (!cameraId || !this.actions.setParams) return;
    this.actions.setParams(
      {
        selectedCameraId: cameraId,
        calibration: { cameraId, save: true },
      },
      { origin: 'user' },
    );
    this.actions.showToast(t('CCTV calibration saved'));
  });

  this.listen(this._cctvCalibResetBtn, 'click', () => {
    this._resetCctvCalibration();
  });

  this._renderCctvState(null);
  this.actions.syncViewport();
}
