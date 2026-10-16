// Personal fork: the HIDE WINDY toggle for screenshot-safe mode.

/** Button and note text for the mode's state. */
export function hideWindyLabels(on) {
  return {
    button: on ? 'WINDY HIDDEN' : 'HIDE WINDY',
    note: on ? 'Windy cams hidden for screenshots' : '',
  };
}

function elements(controls) {
  const panel = controls?._cctvPanel;
  return {
    button: panel?.querySelector?.('#cctv-hide-windy-btn') || null,
    note: panel?.querySelector?.('#cctv-windy-note') || null,
  };
}

/** Wire the toggle: it flips the layer's mode (saved by the layer). */
export function bindHideWindy(controls) {
  const { button } = elements(controls);
  if (!button) return;
  controls.listen(button, 'click', () => {
    controls.cctv?.setHideWindy?.(!controls._cctvState?.hideWindy);
  });
}

/** Reflect the mode in the button and the one-line note. */
export function syncHideWindy(controls, state) {
  const { button, note } = elements(controls);
  const on = state?.hideWindy === true;
  const labels = hideWindyLabels(on);
  if (button) {
    button.textContent = labels.button;
    button.classList?.toggle('active', on);
    button.setAttribute?.('aria-pressed', on ? 'true' : 'false');
  }
  if (note) {
    note.hidden = !on;
    note.textContent = labels.note;
  }
}

/** The panel shows no still for a camera the mode hides. */
export function panelFrameHidden(activeCamera) {
  return activeCamera?.screenshotHidden === true;
}
